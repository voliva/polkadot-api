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
import { astSymbolTracker } from "./astSymbolTracker"

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

const DEFAULT = Symbol("default")
type DEFAULT = typeof DEFAULT

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
      type SymbolMetadata =
        | { type: "clientNamespace" | "createClientSymbol" }
        | { type: "generatedSymbol" | "clientSymbol"; file: string }
        | { type: "path"; file: string; path: string[] }
      type Exports = Partial<Record<string | DEFAULT, SymbolMetadata>>
      type ImportMetadata =
        | {
            type: "client"
          }
        | {
            type: "generated"
            file: string
          }
        | {
            type: "external"
            exports: Exports
          }

      const resolvedExports: Record<string, Exports> = {}
      const traverse = (id: string): Record<string, Set<string>> => {
        const root = this.getModuleInfo(id)
        if (!root) {
          throw new Error(`Module "${id}" not found`)
        }
        if (!root.ast) {
          return {}
        }

        // const visited = new Set<string>();
        const result = readAst(
          root.ast as Node,
          root.importedIdResolutions.map(
            (resolution): ImportMetadata | null => {
              if (resolution.id.includes("/packages/client/")) {
                return {
                  type: "client",
                }
              }
              if (resolution.id.includes("codegen/test.ts")) {
                return {
                  type: "generated",
                  file: resolution.id,
                }
              }
              if (resolvedExports[resolution.id]) {
                return {
                  type: "external",
                  exports: resolvedExports[resolution.id],
                }
              }
              return null
            },
          ),
        )

        if (Object.keys(result.exports).length) {
          resolvedExports[id] = {
            ...(resolvedExports[id] ?? {}),
            ...result.exports,
          }
          root.importers.map(traverse).forEach((paths) => {
            Object.entries(paths).forEach(([id, pathSet]) => {
              result.paths[id] = result.paths[id]
                ? new Set([...result.paths[id], ...pathSet])
                : pathSet
            })
          })
        }

        return result.paths
      }

      const readAst = (
        rootAst: Node,
        importMetadata: Array<ImportMetadata | null>,
      ) => {
        const paths: Record<string, Set<string>> = {}
        const exports: Exports = {}
        astSymbolTracker<SymbolMetadata>(rootAst, {
          importSymbol(index, imported) {
            // pluginCtx
            //   .resolve(file, id)
            //   .then((r) => console.log(file, "resolved", r));

            const importMeta = importMetadata[index]
            if (!importMeta) return null

            switch (importMeta.type) {
              case "client":
                if (imported.type === "namespace") {
                  return {
                    type: "clientNamespace",
                  }
                }
                if (
                  imported.type === "named" &&
                  imported.name === "createClient"
                ) {
                  return {
                    type: "createClientSymbol",
                  }
                }
                return null
              case "generated":
                if (imported.type === "default") {
                  return {
                    type: "generatedSymbol",
                    file: importMeta.file,
                  }
                }
                return null
              case "external":
                if (imported.type === "default") {
                  return importMeta.exports[DEFAULT] ?? null
                } else if (imported.type === "named") {
                  return importMeta.exports[imported.name] ?? null
                } else {
                  // TODO namespace
                  // similar case to `const somethingNested = { client }; somethingNested.client.tx.aa`
                  return null
                }
            }
          },
          memberAccess(symbol, property) {
            switch (symbol.type) {
              case "clientNamespace":
                return property === "createClient"
                  ? { type: "createClientSymbol" }
                  : null
              case "clientSymbol":
                return { type: "path", file: symbol.file, path: [property] }
              case "path":
                if (symbol.path.length === 2) {
                  paths[symbol.file] = paths[symbol.file] ?? new Set()
                  paths[symbol.file].add([...symbol.path, property].join("."))
                  return null
                }
                return { ...symbol, path: [...symbol.path, property] }
            }
          },
          functionCall(symbol, args) {
            if (symbol.type !== "createClientSymbol") return null
            const arg = args[1]
            if (!arg || arg.type !== "generatedSymbol") {
              throw new Error("Can't know which generated code it's using")
            }
            return {
              type: "clientSymbol",
              file: arg.file,
            }
          },
          exportSymbol(symbol, exported) {
            exports[exported.type === "default" ? DEFAULT : exported.name] =
              symbol
          },
        })

        return { paths, exports }
      }

      entryPoints.forEach((id) => {
        const result = traverse(id)
        console.log(id, result)
      })
    },
  }
}
