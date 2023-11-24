import escodegen from "escodegen"
import type { Node } from "estree"
import fs from "fs"
import path from "path"
import type { ModuleInfo, Plugin, PluginContext } from "rollup"
import { astSymbolTracker } from "./astSymbolTracker"
import { applyWhitelist } from "./whitelist"

const DEFAULT = Symbol("default")
type DEFAULT = typeof DEFAULT

export default function descriptorTreeShake(codegenFolder: string): Plugin {
  let codegenFiles: string[] = []
  let papiClient: string = ""

  const entryPoints: string[] = []
  let detectedPaths: Paths = {}

  return {
    name: "descriptorTreeShake",
    async buildStart() {
      const files = await new Promise<string[]>((resolve, reject) => {
        fs.readdir(codegenFolder, (err, files) => {
          if (err) return reject(err)
          resolve(
            files
              .filter((file) => !file.endsWith(".d.ts") && file.endsWith(".ts"))
              .map((name) => path.join(codegenFolder, name)),
          )
        })
      })
      const resolved = await Promise.all(
        files.map((file) => this.resolve(file)),
      )
      codegenFiles = resolved.filter(Boolean).map((result) => result!.id)

      const papiClientResolution = await this.resolve("@polkadot-api/client")
      if (!papiClientResolution) {
        throw new Error("Can't find module @polkadot-api/client")
      }
      papiClient = papiClientResolution.id
    },
    moduleParsed(moduleInfo: ModuleInfo) {
      if (
        codegenFiles.some((id) => moduleInfo.importedIds.includes(id)) ||
        moduleInfo.importedIds.includes(papiClient)
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
      const traverse = (
        id: string,
      ): {
        paths: Paths
        importers: readonly string[]
      } => {
        const root = this.getModuleInfo(id)
        if (!root) {
          throw new Error(`Module "${id}" not found`)
        }
        if (!root.ast) {
          return {
            paths: {},
            importers: [],
          }
        }

        // const visited = new Set<string>();
        const result = readAst(
          root.ast as Node,
          root.importedIdResolutions.map(
            (resolution): ImportMetadata | null => {
              if (resolution.id === papiClient) {
                return {
                  type: "client",
                }
              }
              if (codegenFiles.some((id) => id === resolution.id)) {
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

        resolvedExports[id] = {
          ...(resolvedExports[id] ?? {}),
          ...result.exports,
        }

        return {
          paths: result.paths,
          importers: Object.keys(result.exports).length ? root.importers : [],
        }
      }

      const readAst = (
        rootAst: Node,
        importMetadata: Array<ImportMetadata | null>,
      ) => {
        const paths: Paths = {}
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
            return null
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

      const filesToTraverse = new Set(entryPoints)
      const paths: Paths[] = []
      while (filesToTraverse.size) {
        const id = shiftSet(filesToTraverse)!
        const result = traverse(id)
        paths.push(result.paths)
        result.importers.forEach((id) => filesToTraverse.add(id))
      }
      detectedPaths = mergePaths(paths)
    },
    renderChunk(code, chunk) {
      Object.entries(detectedPaths).forEach(([id, whitelist]) => {
        const targetModule = chunk.modules[id]
        if (targetModule?.code) {
          const ast = this.parse(targetModule.code)
          applyWhitelist(ast as Node, whitelist)

          const newCode = escodegen.generate(ast)

          const idx = code.indexOf(targetModule.code)
          if (idx < 0) throw new Error("Module code can't be found in source")
          code = [
            code.slice(0, idx),
            newCode,
            code.slice(idx + targetModule.renderedLength),
          ].join("")
          // TODO chunk is mutable and changes applied in this hook will propagate to other plugins and to the generated bundle. That means if you add or remove imports or exports in this hook, you should update imports, importedBindings and/or exports.
        }
      })

      return {
        code,
      }
    },
  }
}

type Paths = Record<string, Set<string>>
function mergePaths(paths: Array<Paths>) {
  return paths.reduce((acc, paths) => {
    Object.entries(paths).forEach(([id, pathSet]) => {
      acc[id] = acc[id] ? new Set([...acc[id], ...pathSet]) : pathSet
    })
    return acc
  }, {} as Paths)
}

function shiftSet<T>(set: Set<T>) {
  for (const value of set) {
    set.delete(value)
    return value
  }
  return
}
