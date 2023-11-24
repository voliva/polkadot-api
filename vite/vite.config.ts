import { defineConfig } from "vite"
import { ModuleInfo, PluginContext, Plugin } from "rollup"
import { walk } from "estree-walker"
import type {
  Node,
  ImportDeclaration,
  ExportNamedDeclaration,
  VariableDeclaration,
  MemberExpression,
  CallExpression,
} from "estree"

export default defineConfig({
  plugins: [pApiTreeShaker()],
  build: {
    target: "esnext",
    rollupOptions: {
      shimMissingExports: true,
    },
  },
  optimizeDeps: {
    esbuildOptions: { target: "esnext" },
  },
})

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

function pApiTreeShaker(): Plugin {
  const entryPoints: string[] = []

  return {
    name: "pApiTreeShaker",
    moduleParsed(moduleInfo: ModuleInfo) {
      if (
        moduleInfo.importedIds.some((id) => id.includes("/packages/client/"))
      ) {
        entryPoints.push(moduleInfo.id)
      }
    },
    buildEnd(this: PluginContext) {
      const traverse = (id: string) => {
        const root = this.getModuleInfo(id)
        if (!root) {
          throw new Error(`Module "${id}" not found`)
        }
        if (!root.ast) {
          return
        }

        // const visited = new Set<string>();
        readAst(root.ast)
      }
      const readAst = (rootAst: any) => {
        type ScopeVar =
          | { type: "clientNamespace" | "createClientSymbol" }
          | { type: "generatedSymbol" | "clientSymbol"; file: string }
          | { type: "path"; file: string; path: string }

        type Scope = Array<Record<string, ScopeVar>>
        const scope: Scope = [{}]
        const setInScope = (name: string, value: ScopeVar) => {
          scope[scope.length - 1][name] = value
        }
        const replaceInScope = (name: string, value: ScopeVar) => {
          for (let i = scope.length - 1; i > 0; i--) {
            if (name in scope[i]) {
              scope[i][name] = value
              return
            }
          }
          scope[0][name] = value
        }
        const getFromScope = (name: string) => {
          for (let i = scope.length - 1; i >= 0; i--) {
            if (name in scope[i]) {
              return scope[i][name]
            }
          }
          return null
        }

        const readClientImport = (root: Node) => {
          walk(root, {
            enter(node) {
              switch (node.type) {
                case "ImportSpecifier":
                  if (node.imported.name === "createClient") {
                    setInScope(node.local.name, {
                      type: "createClientSymbol",
                    })
                  }
                  break
                case "ImportNamespaceSpecifier":
                  setInScope(node.local.name, {
                    type: "clientNamespace",
                  })
                  break
              }
            },
          })
        }
        const readGeneratedImport = (root: ImportDeclaration) => {
          walk(root, {
            enter(node) {
              if (node.type === "ImportDefaultSpecifier") {
                setInScope(node.local.name, {
                  type: "generatedSymbol",
                  file: String(root.source.value),
                })
              }
            },
          })
        }

        const readMemberExpression = (
          root: MemberExpression,
        ): ScopeVar | null => {
          // TODO createClient(foo).tx.Pallet1
          const property = root.property
          if (property.type !== "Identifier") return null

          const extendScope = (scopeVar: ScopeVar): ScopeVar | null => {
            switch (scopeVar.type) {
              case "clientSymbol":
                return {
                  type: "path",
                  file: scopeVar.file,
                  path: property.name,
                }
              case "path":
                if (scopeVar.path.split(".").length >= 3) return scopeVar
                return {
                  type: "path",
                  file: scopeVar.file,
                  path: scopeVar.path + "." + property.name,
                }
              case "clientNamespace":
                if (property.name === "createClient") {
                  return {
                    type: "createClientSymbol",
                  }
                }
                return null
            }
            return null
          }

          switch (root.object.type) {
            case "MemberExpression":
              const resolved = readMemberExpression(root.object)
              if (!resolved) return null
              return extendScope(resolved)
            case "Identifier":
              const fromScope = getFromScope(root.object.name)
              return fromScope ? extendScope(fromScope) : null
          }
          return null
        }
        const readVariableDeclaration = (root: VariableDeclaration) => {
          const symbols: string[] = []

          walk(root, {
            enter(node, parent) {
              switch (node.type) {
                case "VariableDeclarator":
                  // console.log(node);
                  break
                case "CallExpression":
                  const result = readCallExpression(node)
                  if (result) {
                    if (parent?.type !== "VariableDeclarator") {
                      throw new Error("TODO")
                    }
                    setInScope((parent.id as any).name, result)
                  }
                  this.skip()
                  break
              }
            },
          })
        }
        const readExportDeclaration = (root: ExportNamedDeclaration) => {
          // const symbols = readVariableDeclaration()
          // Symbols are only the ones relevant to the plugin.
          // Will have to return the symbols as a result of the function.
          // Also `readAst` will have to take in the import details from exported
        }

        const readCallExpression = (root: CallExpression): ScopeVar | null => {
          const callee =
            root.callee.type === "Identifier"
              ? getFromScope(root.callee.name)
              : root.callee.type === "MemberExpression"
              ? readMemberExpression(root.callee)
              : null
          if (!callee) return null

          if (callee.type === "createClientSymbol") {
            const descriptorArg = root.arguments[1]
            const gen =
              descriptorArg?.type === "Identifier"
                ? getFromScope(descriptorArg.name)
                : null
            if (!gen || gen.type !== "generatedSymbol") {
              // TODO warn and bail out from tree shaking
              // or do track every possibility... e.g. createClient(foo ? bar : baz) will track both bar and baz
              throw new Error("Can't know which file it's grabbing")
            }

            return {
              type: "clientSymbol",
              file: gen.file,
            }
          }

          return null
        }

        walk(rootAst, {
          enter(node) {
            switch (node.type) {
              case "ImportDeclaration":
                if (node.source.value === "@polkadot-api/client") {
                  readClientImport(node)
                }
                if (node.source.value === "./codegen/test") {
                  readGeneratedImport(node)
                }
                this.skip()
                break
              case "ExportNamedDeclaration":
                readExportDeclaration(node)
                this.skip()
                break
              case "VariableDeclaration":
                readVariableDeclaration(node)
                this.skip()
                break
              case "AssignmentExpression":
                // console.log(node);
                break
              case "MemberExpression":
                console.log(readMemberExpression(node))
                this.skip()
                break
              // case "CallExpression":
              //   readCallExpression(node);
              //   break;
            }
          },
        })

        console.log(scope)
      }
      entryPoints.forEach(traverse)
    },
  }
}
