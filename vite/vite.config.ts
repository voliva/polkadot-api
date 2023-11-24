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
        type SymbolMetadata =
          | { type: "clientNamespace" | "createClientSymbol" }
          | { type: "generatedSymbol" | "clientSymbol"; file: string }
          | { type: "path"; file: string; path: string[] }

        astSymbolTracker<SymbolMetadata>(rootAst, {
          importSymbol(file, imported) {
            if (file === "@polkadot-api/client") {
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
            }
            if (file === "./codegen/test" && imported.type === "default") {
              return {
                type: "generatedSymbol",
                file,
              }
            }
          },
          memberAccess(symbol, property) {
            console.log(symbol, property)
            switch (symbol.type) {
              case "clientNamespace":
                return property === "createClient"
                  ? { type: "createClientSymbol" }
                  : null
              case "clientSymbol":
                return { type: "path", file: symbol.file, path: [property] }
              case "path":
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
        })
      }
      entryPoints.forEach(traverse)
    },
  }
}
