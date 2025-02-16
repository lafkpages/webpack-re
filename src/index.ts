import type { File, Identifier } from "@babel/types";

import { join } from "node:path";

import generate from "@babel/generator";
import { parse } from "@babel/parser";
import traverse from "@babel/traverse";
import {
  assignmentExpression,
  awaitExpression,
  callExpression,
  exportDefaultDeclaration,
  exportNamedDeclaration,
  exportSpecifier,
  file,
  identifier,
  importDeclaration,
  importDefaultSpecifier,
  importExpression,
  importNamespaceSpecifier,
  importSpecifier,
  isArrowFunctionExpression,
  isBlockStatement,
  isCallExpression,
  isExpressionStatement,
  isFunctionExpression,
  isIdentifier,
  isMemberExpression,
  isNumericLiteral,
  isObjectExpression,
  isObjectProperty,
  isReturnStatement,
  isSequenceExpression,
  memberExpression,
  program,
  stringLiteral,
  variableDeclaration,
  variableDeclarator,
} from "@babel/types";
import consola from "consola";
import { DirectedGraph } from "graphology";
import { format } from "prettier";

import prettierConfig from "../.prettierrc.json";
import { getDefaultExport, parseImportCall, rename } from "./ast";

export type ChunkGraph = DirectedGraph<{}, {}, {}>;

export interface ChunkModule {
  file: File;
  source: string;

  chunkId: number;
  rawModuleId: string;

  isCommonJS: boolean;
  hasDefaultExport: boolean;
}

export interface ChunkModules {
  [moduleId: string]: ChunkModule;
}

export interface ModuleTransformations {
  renameModule?: string;
  renameVariables?: Record<number, string>;
}

export interface ChunkModulesTransformations {
  [moduleId: string]: ModuleTransformations;
}

function resolveModule(
  moduleId: string | number,
  moduleTransformations?: ChunkModulesTransformations,
) {
  const moduleTransformation = moduleTransformations?.[moduleId];

  if (moduleTransformation?.renameModule) {
    return moduleTransformation.renameModule;
  }

  return moduleId.toString();
}

export async function splitWebpackChunk(
  chunkSrc: string,
  {
    esmDefaultExports = true,
    includeVariableDeclarationComments,
    includeVariableReferenceComments,
    moduleTransformations,
    graph,
    write,
  }: {
    esmDefaultExports?: boolean;

    includeVariableDeclarationComments?: boolean;
    includeVariableReferenceComments?: boolean;

    moduleTransformations?: ChunkModulesTransformations;

    graph?: ChunkGraph | null;

    write: false | string;
  },
): Promise<ChunkModules | null> {
  const m = chunkSrc.match(
    /(\((self\.webpackChunk(\w*))=\2\|\|\[\]\)\.push\()\[\[(\d+)\],(\{.+\})]\);/s,
  );

  if (!m) {
    return null;
  }

  const chunkId = parseInt(m[4]);
  const chunkModulesSrc = `(${m[5]}, 0)`;

  const chunkLogger = consola.withTag(`chunk-${chunkId}`);

  const chunkModulesFilename = write
    ? join(write, `chunk-${chunkId}.js`)
    : null;
  const chunkModulesSrcFormattedPromise = write
    ? format(chunkModulesSrc, {
        parser: "babel",
        filepath: chunkModulesFilename!,
      }).then(async (chunkModulesSrcFormatted) => {
        await Bun.write(chunkModulesFilename!, chunkModulesSrcFormatted);

        consola.success("Chunk pretty printed and written");
      })
    : null;

  const ast = parse(chunkModulesSrc);

  if (ast.program.body.length !== 1) {
    return null;
  }

  const rootExpressionStatement = ast.program.body[0];

  if (!isExpressionStatement(rootExpressionStatement)) {
    return null;
  }

  const rootSequenceExpression = rootExpressionStatement.expression;

  if (!isSequenceExpression(rootSequenceExpression)) {
    return null;
  }

  const rootObjectExpression = rootSequenceExpression.expressions[0];

  if (!isObjectExpression(rootObjectExpression)) {
    return null;
  }

  let chunkModuleParams: string[] = [];

  const chunkModules: ChunkModules = {};

  chunkModulesLoop: for (const property of rootObjectExpression.properties) {
    if (!isObjectProperty(property)) {
      chunkLogger.warn(
        "Chunk module is not an object property:",
        property.type,
      );
      continue;
    }

    if (!isNumericLiteral(property.key)) {
      if (isIdentifier(property.key)) {
        const fusionModuleMatch = property.key.name.match(/^__fusion__(\d+)$/);

        if (fusionModuleMatch) {
          const fusionModuleId = parseInt(fusionModuleMatch[1]);

          const moduleLogger = chunkLogger.withTag(
            `fusion-module-${fusionModuleId}`,
          );

          // TODO
          moduleLogger.warn(`Fusion modules not implemented`);
          continue;
        }
      }

      chunkLogger.warn("Invalid chunk module key:", property.key.type);
      continue;
    }

    const rawModuleId = property.key.value.toString();
    const moduleId = resolveModule(rawModuleId, moduleTransformations);

    const moduleLogger = chunkLogger.withTag(`module-${moduleId}`);

    if (
      !isFunctionExpression(property.value) &&
      !isArrowFunctionExpression(property.value)
    ) {
      moduleLogger.warn("Invalid chunk module value:", property.value.type);
      continue;
    }

    const moduleFunction = property.value;

    if (moduleFunction.params.length > 3) {
      moduleLogger.warn(
        "Too many chunk module function params:",
        moduleFunction.params.length,
      );
      continue;
    }

    for (let i = 0; i < moduleFunction.params.length; i++) {
      const param = moduleFunction.params[i];

      if (!isIdentifier(param)) {
        moduleLogger.warn("Invalid chunk module function param:", param.type);
        continue chunkModulesLoop;
      }

      if (chunkModuleParams[i]) {
        if (chunkModuleParams[i] !== param.name) {
          moduleLogger.warn("Invalid chunk module function param:", param.name);
          continue chunkModulesLoop;
        }
      } else {
        chunkModuleParams[i] = param.name;
      }
    }

    if (!isBlockStatement(moduleFunction.body)) {
      moduleLogger.warn(
        "Invalid chunk module function body:",
        moduleFunction.body.type,
      );
      continue;
    }

    const moduleFile = file(program(moduleFunction.body.body));

    let isCommonJS = false;
    let hasDefaultExport = false;

    moduleLogger.debug("Running initial import and export scan traversal");

    traverse(moduleFile, {
      CallExpression(path) {
        const importRawModuleId = parseImportCall(
          moduleLogger,
          path.node,
          path.scope,
          chunkModuleParams,
        );

        if (importRawModuleId === null) {
          return;
        }

        const importModuleId = resolveModule(
          importRawModuleId,
          moduleTransformations,
        );

        graph?.mergeEdge(moduleId, importModuleId);
      },
      VariableDeclarator(path) {
        if (isCallExpression(path.node.init)) {
          const importRawModuleId = parseImportCall(
            moduleLogger,
            path.node.init,
            path.scope,
            chunkModuleParams,
          );

          if (importRawModuleId === null) {
            return;
          }

          const importModuleId = resolveModule(
            importRawModuleId,
            moduleTransformations,
          );

          graph?.mergeEdge(moduleId, importModuleId);
        } else if (isMemberExpression(path.node.init)) {
          if (isCallExpression(path.node.init.object)) {
            const importRawModuleId = parseImportCall(
              moduleLogger,
              path.node.init.object,
              path.scope,
              chunkModuleParams,
            );

            if (importRawModuleId === null) {
              return;
            }

            const importModuleId = resolveModule(
              importRawModuleId,
              moduleTransformations,
            );

            graph?.mergeEdge(moduleId, importModuleId);
          }
        }
      },
      AssignmentExpression(path) {
        const defaultExport = getDefaultExport(
          moduleLogger,
          path,
          chunkModuleParams,
        );

        if (!defaultExport) {
          return;
        }

        if (hasDefaultExport) {
          moduleLogger.info(
            "Multiple default exports found, assuming CommonJS",
          );
          isCommonJS = true;
        } else if (isObjectExpression(defaultExport)) {
          moduleLogger.info("Default export is an object, assuming CommonJS");
          isCommonJS = true;
        }

        hasDefaultExport = true;
      },
    });

    graph?.mergeNode(moduleId);

    chunkModules[moduleId] = {
      file: moduleFile,
      source: "",

      chunkId,
      rawModuleId,

      isCommonJS,
      hasDefaultExport,
    };
  }

  for (const [
    moduleId,
    { file: moduleFile, rawModuleId, isCommonJS: moduleIsCommonJS },
  ] of Object.entries(chunkModules)) {
    const moduleLogger = chunkLogger.withTag(`module-${moduleId}`);

    consola.debug("Running module split traversal");

    traverse(moduleFile, {
      CallExpression(path) {
        if (isMemberExpression(path.node.callee)) {
          if (isIdentifier(path.node.callee.object)) {
            if (path.node.callee.object.name === chunkModuleParams[2]) {
              if (isIdentifier(path.node.callee.property)) {
                if (path.node.callee.property.name === "d") {
                  if (path.node.arguments.length !== 2) {
                    moduleLogger.warn(
                      "Invalid export arguments:",
                      path.node.arguments.length,
                    );
                    return;
                  }

                  if (
                    !isIdentifier(path.node.arguments[0]) ||
                    path.node.arguments[0].name !== chunkModuleParams[1]
                  ) {
                    moduleLogger.warn(
                      "Invalid export first argument:",
                      path.node.arguments[0].type,
                    );
                    return;
                  }

                  if (!isObjectExpression(path.node.arguments[1])) {
                    moduleLogger.warn(
                      "Invalid exports:",
                      path.node.arguments[1].type,
                    );
                    return;
                  }

                  for (const property of path.node.arguments[1].properties) {
                    if (!isObjectProperty(property)) {
                      moduleLogger.warn("Invalid export:", property.type);
                      continue;
                    }

                    if (!isIdentifier(property.key)) {
                      moduleLogger.warn(
                        "Invalid export property key:",
                        property.key.type,
                      );
                      continue;
                    }

                    if (
                      !isFunctionExpression(property.value) &&
                      !isArrowFunctionExpression(property.value)
                    ) {
                      moduleLogger.warn(
                        "Invalid export property value:",
                        property.value.type,
                      );
                      continue;
                    }

                    if (property.value.params.length) {
                      moduleLogger.warn(
                        "Invalid export property value params:",
                        property.value.params.length,
                      );
                      continue;
                    }

                    let exportedVar: string | null = null;

                    if (isBlockStatement(property.value.body)) {
                      if (property.value.body.body.length === 1) {
                        if (!isReturnStatement(property.value.body.body[0])) {
                          moduleLogger.warn(
                            "Invalid export property value body:",
                            property.value.body.body[0].type,
                          );
                          continue;
                        }

                        if (!property.value.body.body[0].argument) {
                          // TODO: void export
                          moduleLogger.warn("Void exports not implemented");
                          continue;
                        }

                        if (
                          !isIdentifier(property.value.body.body[0].argument)
                        ) {
                          moduleLogger.warn(
                            "Invalid export property value body:",
                            property.value.body.body[0].argument.type,
                          );
                          continue;
                        }

                        exportedVar = property.value.body.body[0].argument.name;
                      } else if (property.value.body.body.length) {
                        moduleLogger.warn(
                          "Invalid export property value body:",
                          property.value.body.body.length,
                        );
                        continue;
                      }

                      // TODO: void export
                      moduleLogger.warn("Void exports not implemented");
                    } else if (isIdentifier(property.value.body)) {
                      exportedVar = property.value.body.name;
                    } else {
                      moduleLogger.warn(
                        "Invalid export property value body:",
                        property.value.body.type,
                      );
                      continue;
                    }

                    if (exportedVar) {
                      const statementParent = path.getStatementParent();

                      if (!statementParent) {
                        moduleLogger.warn(
                          "No statement parent for export found",
                        );
                        continue;
                      }

                      const exportAs = property.key.name;

                      moduleLogger.info(
                        "Rewriting export",
                        exportedVar,
                        "as",
                        exportAs,
                      );

                      if (exportAs === "default") {
                        statementParent.insertBefore(
                          exportDefaultDeclaration(identifier(exportedVar)),
                        );
                      } else {
                        statementParent.insertBefore(
                          exportNamedDeclaration(null, [
                            exportSpecifier(
                              identifier(exportedVar),
                              identifier(exportAs),
                            ),
                          ]),
                        );
                      }
                    }
                  }

                  path.remove();
                }
              }
            }
          }
        } else {
          const importRawModuleId = parseImportCall(
            moduleLogger,
            path.node,
            path.scope,
            chunkModuleParams,
          );

          if (importRawModuleId === null) {
            return;
          }

          const importModuleId = resolveModule(
            importRawModuleId,
            moduleTransformations,
          );

          let useRequire = moduleIsCommonJS;

          if (!moduleIsCommonJS) {
            const functionParent = path.getFunctionParent();

            if (functionParent?.node.async === false) {
              // If the parent function is not async, we cannot use await
              useRequire = true;
            }
          }

          if (useRequire) {
            moduleLogger.info("Rewriting import call as require");

            path.replaceWith(
              callExpression(identifier("require"), [
                stringLiteral(`./${importModuleId}`),
              ]),
            );

            return;
          }

          moduleLogger.info("Rewriting import call");

          path.replaceWith(
            awaitExpression(
              importExpression(stringLiteral(`./${importModuleId}`)),
            ),
          );
        }
      },
      VariableDeclarator(path) {
        if (isCallExpression(path.node.init)) {
          const importRawModuleId = parseImportCall(
            moduleLogger,
            path.node.init,
            path.scope,
            chunkModuleParams,
          );

          if (importRawModuleId === null) {
            return;
          }

          const importModuleId = resolveModule(
            importRawModuleId,
            moduleTransformations,
          );

          if (moduleIsCommonJS) {
            moduleLogger.info("Rewriting import call as require");

            path.replaceWith(
              variableDeclarator(
                path.node.id,
                callExpression(identifier("require"), [
                  stringLiteral(`./${importModuleId}`),
                ]),
              ),
            );

            return;
          }

          if (!isIdentifier(path.node.id)) {
            moduleLogger.warn(
              "Non-identifier imports are not implemented, got:",
              path.node.id.type,
            );
            return;
          }

          const statementParent = path.getStatementParent();

          if (!statementParent) {
            moduleLogger.warn("No statement parent for import found");
            return;
          }

          if (chunkModules[importModuleId]?.hasDefaultExport) {
            statementParent.insertBefore(
              importDeclaration(
                [importDefaultSpecifier(identifier(path.node.id.name))],
                stringLiteral(`./${importModuleId}`),
              ),
            );
          } else {
            statementParent.insertBefore(
              importDeclaration(
                [importNamespaceSpecifier(identifier(path.node.id.name))],
                stringLiteral(`./${importModuleId}`),
              ),
            );
          }

          path.remove();
        } else if (isMemberExpression(path.node.init)) {
          if (isCallExpression(path.node.init.object)) {
            const importRawModuleId = parseImportCall(
              moduleLogger,
              path.node.init.object,
              path.scope,
              chunkModuleParams,
            );

            if (importRawModuleId === null) {
              return;
            }

            const importModuleId = resolveModule(
              importRawModuleId,
              moduleTransformations,
            );

            if (!isIdentifier(path.node.id)) {
              moduleLogger.warn(
                "Non-identifier imports are not implemented, got:",
                path.node.id.type,
              );
              return;
            }

            if (!isIdentifier(path.node.init.property)) {
              moduleLogger.warn(
                "Non-identifier import accessors are not implemented, got:",
                path.node.init.property.type,
              );
              return;
            }

            const statementParent = path.getStatementParent();

            if (!statementParent) {
              moduleLogger.warn("No statement parent for import found");
              return;
            }

            statementParent.insertBefore(
              importDeclaration(
                [importSpecifier(path.node.id, path.node.init.property)],
                stringLiteral(`./${importModuleId}`),
              ),
            );
            path.remove();
          }
        }
      },
      AssignmentExpression(path) {
        const defaultExport = getDefaultExport(
          moduleLogger,
          path,
          chunkModuleParams,
        );

        if (!defaultExport) {
          return;
        }

        if (moduleIsCommonJS || !esmDefaultExports) {
          moduleLogger.info("Rewriting default exports as CommonJS");

          path.replaceWith(
            assignmentExpression(
              "=",
              memberExpression(identifier("module"), identifier("exports")),
              defaultExport,
            ),
          );

          return;
        }

        moduleLogger.info("Rewriting default exports");

        if (isExpressionStatement(path.parent)) {
          path.parentPath.replaceWith(exportDefaultDeclaration(defaultExport));
        } else {
          const statementParent = path.getStatementParent();

          if (!statementParent) {
            moduleLogger.warn("No statement parent for default exports found");
            return;
          }

          const exportsId = path.scope.generateUidIdentifier("exports");
          statementParent.insertBefore(
            variableDeclaration("const", [
              variableDeclarator(exportsId, defaultExport),
            ]),
          );
          statementParent.insertBefore(exportDefaultDeclaration(exportsId));

          path.replaceWith(exportsId);
        }
      },
      ImportSpecifier(path) {
        if (!isIdentifier(path.node.imported)) {
          moduleLogger.warn(
            "Non-identifier imports should be unreachable, got:",
            path.node.imported.type,
          );
          return;
        }

        rename(moduleLogger, path, path.node.imported.name, "to match import");
      },
      ExportSpecifier(path) {
        if (!isIdentifier(path.node.exported)) {
          moduleLogger.warn(
            "Non-identifier exports should be unreachable, got:",
            path.node.exported.type,
          );
          return;
        }

        rename(moduleLogger, path, path.node.exported.name, "to match export");
      },
    });

    const moduleVariables = new WeakMap<Identifier, number>();
    let moduleVariableCount = 0;

    if (
      includeVariableDeclarationComments ||
      includeVariableReferenceComments ||
      moduleTransformations?.[rawModuleId]?.renameVariables // TODO: what if renameVariables is empty?
    ) {
      consola.debug("Running module transformation traversal");

      traverse(moduleFile, {
        Identifier(path) {
          const binding = path.scope.getBinding(path.node.name);

          if (!binding) {
            return;
          }

          if (binding.identifier === path.node) {
            // This is the declaration

            const variableId = moduleVariableCount;

            if (includeVariableDeclarationComments) {
              path.addComment("leading", `Variable dec ${variableId}`);
            }

            moduleVariables.set(path.node, variableId);

            rename(
              moduleLogger,
              path,
              moduleTransformations?.[rawModuleId]?.renameVariables?.[
                variableId
              ],
              "due to module transformation",
            );

            moduleVariableCount++;
          } else if (includeVariableReferenceComments) {
            // This is a reference
            const variableId = moduleVariables.get(binding.identifier);
            path.addComment("leading", `Variable ref ${variableId}`);
          }
        },
      });
    }

    const filename = write ? join(write, `${moduleId}.js`) : undefined;

    const moduleCode = generate(moduleFile, { filename }).code;

    const formattedModuleCode = await format(moduleCode, {
      parser: "babel",
      filepath: filename,

      ...prettierConfig,
    });

    graph?.mergeNodeAttributes(moduleId, {
      file: moduleFile,
      source: formattedModuleCode,
    });

    if (write) {
      await Bun.write(
        filename!,
        `\
/*
 * Webpack chunk ${chunkId}, ${moduleIsCommonJS ? "CJS" : "ESM"} module ${moduleId}${moduleId !== rawModuleId ? ` (originally ${rawModuleId})` : ""}
 */

${formattedModuleCode}`,
      );
    }
  }

  await chunkModulesSrcFormattedPromise;

  return chunkModules;
}
