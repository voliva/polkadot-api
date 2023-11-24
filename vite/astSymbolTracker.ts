import { walk } from "estree-walker"

import type { ImportDeclaration, MemberExpression, Node } from "estree"

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
  memberAccess?: (symbol: T, path: string[]) => T | null | void
  functionCall?: (symbol: T, args: Array<T | null>) => T | null | void
  exportSymbol?: (symbol: T, exported: ExportedSymbol) => void
}

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
  const readMemberExpression = (
    root: MemberExpression,
  ): { symbol: T; path: string[] } | null => {
    const property = root.property
    // property can also be an expression, such as in (1 + 2).foo
    // TODO function().foo if function() is tracked
    if (property.type !== "Identifier") return null

    switch (root.object.type) {
      case "MemberExpression":
        const resolved = readMemberExpression(root.object)
        if (!resolved) return null
        return {
          symbol: resolved.symbol,
          path: [...resolved.path, property.name],
        }
      case "Identifier":
        const fromScope = scope.get(root.object.name)
        return fromScope ? { symbol: fromScope, path: [property.name] } : null
    }
    return null
  }

  walk(rootAst, {
    enter(node) {
      switch (node.type) {
        case "ImportDeclaration":
          readImportDeclaration(node)
          this.skip()
          break
        case "MemberExpression":
          {
            const tracked = readMemberExpression(node)
            if (tracked) {
              hooks.memberAccess?.(tracked.symbol, tracked.path)
            }
            this.skip()
          }
          break
      }
    },
  })
}

class Scope<T> {
  private stack: Array<Record<string, T>> = [{}]

  push() {
    this.stack.push({})
  }
  pop() {
    this.stack.pop()
  }
  set(name: string, value: T) {
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
  replace(name: string, value: T) {
    for (let i = this.stack.length - 1; i > 0; i--) {
      if (name in this.stack[i]) {
        this.stack[i][name] = value
        return
      }
    }
    this.stack[0][name] = value
  }
}
