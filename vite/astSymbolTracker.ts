import { walk } from "estree-walker"

import type {
  Node,
  ImportDeclaration,
  ExportNamedDeclaration,
  VariableDeclaration,
  MemberExpression,
  CallExpression,
  Expression,
} from "estree"

export type ImportedSymbol =
  | {
      type: "named"
      name: string
    }
  | {
      type: "namespace" | "default"
    }
export type ExportedSymbol =
  | { type: "named"; name: string }
  | { type: "default" }

export interface Hooks<T> {
  importSymbol?: (
    file: string,
    imported: ImportedSymbol,
    name: string,
  ) => T | null | void
  memberAccess?: (symbol: T, property: string) => T | null | void
  functionCall?: (symbol: T, args: Array<T | null>) => T | null | void
  exportSymbol?: (symbol: T, exported: ExportedSymbol) => void
}

/**
 * AST symbolTracker
 *
 * -> Given a list of symbols defined in the root scope, lets you track their usage.
 * -> Features
 *  -> Member access: client.qt.Pallet1.baz.methodA() => client.qt.Pallet1.baz.methodA
 *  -> Function calls: client.qt.Pallet1.baz.methodA(), createClient(descriptor)
 *  -> Notify when creating a new variable, lets you keep tracking it: const client = createClient(descriptor);
 *  -> Notify on import, lets you track it.
 *  -> Notify on dynamic import, lets you track it.
 *  -> Which ones are exported
 */

export function astSymbolTracker<T>(rootAst: Node, hooks: Hooks<T>) {
  const scope = new Scope<T>()

  const readImportDeclaration = (root: ImportDeclaration) => {
    const file = String(root.source.value)
    root.specifiers.forEach((specifier) => {
      const name = specifier.local.name
      const importedSymbol = ((): ImportedSymbol => {
        switch (specifier.type) {
          case "ImportDefaultSpecifier":
            return { type: "default" }
          case "ImportNamespaceSpecifier":
            return { type: "namespace" }
          case "ImportSpecifier":
            return { type: "named", name: specifier.imported.name }
        }
      })()
      const metadata = hooks.importSymbol?.(file, importedSymbol, name)
      if (metadata) {
        scope.set(name, metadata)
      }
    })
  }
  const resolveExpression = (expression: Expression | Node) => {
    switch (expression.type) {
      case "MemberExpression":
        return readMemberExpression(expression)
      case "Identifier":
        return scope.get(expression.name)
      case "CallExpression":
        return readCallExpression(expression)
    }
    return null
  }
  const readMemberExpression = (root: MemberExpression): T | null => {
    const property = root.property
    // property can also be an expression, such as in foo[1+2] foo["bar"] foo[something ? "bar" : "baz"]
    // In that case we can't track it
    // TODO bail out from tree shaking
    // TODO give opportunity to keep tracking with metadata
    if (property.type !== "Identifier") return null

    const symbol = resolveExpression(root.object)
    if (!symbol) return null

    return hooks.memberAccess?.(symbol, property.name) ?? null
  }
  const readCallExpression = (root: CallExpression): T | null => {
    const callee = resolveExpression(root.callee)
    if (!callee) return null

    const fnArgs = root.arguments.map((expression) =>
      resolveExpression(expression),
    )

    return hooks.functionCall?.(callee, fnArgs) ?? null
  }
  const readVariableDeclaration = (root: VariableDeclaration) => {
    root.declarations.forEach((declarator) => {
      if (declarator.id.type !== "Identifier") return // TODO
      const value = declarator.init ? resolveExpression(declarator.init) : null
      scope.set(declarator.id.name, value)
    })
  }

  walk(rootAst, {
    enter(node) {
      switch (node.type) {
        case "ImportDeclaration":
          readImportDeclaration(node)
          this.skip()
          break
        case "MemberExpression":
          readMemberExpression(node)
          this.skip()
          break
        case "CallExpression":
          readCallExpression(node)
          this.skip()
          break
        case "VariableDeclaration":
          readVariableDeclaration(node)
          this.skip()
          break
      }
    },
  })
}

class Scope<T> {
  private stack: Array<Record<string, T | null>> = [{}]

  push() {
    this.stack.push({})
  }
  pop() {
    this.stack.pop()
  }
  set(name: string, value: T | null) {
    this.stack[this.stack.length - 1][name] = value
  }
  get(name: string) {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      if (name in this.stack[i]) {
        return this.stack[i][name]
      }
    }
    return null
  }
  replace(name: string, value: T | null) {
    for (let i = this.stack.length - 1; i > 0; i--) {
      if (name in this.stack[i]) {
        this.stack[i][name] = value
        return
      }
    }
    this.stack[0][name] = value
  }
}
