import type { File } from "@babel/types";

import { join } from "node:path";

import generate from "@babel/generator";
import { parse } from "@babel/parser";
import traverse from "@babel/traverse";
import {
  exportDefaultDeclaration,
  exportNamedDeclaration,
  exportSpecifier,
  file,
  identifier,
  importDeclaration,
  importNamespaceSpecifier,
  isArrowFunctionExpression,
  isBlockStatement,
  isCallExpression,
  isExpressionStatement,
  isIdentifier,
  isMemberExpression,
  isNumericLiteral,
  isObjectExpression,
  isObjectProperty,
  isSequenceExpression,
  program,
  stringLiteral,
} from "@babel/types";
import { format } from "prettier";

import prettierConfig from "../.prettierrc.json";

export interface FusionChunk {
  chunkId: number;
  chunkModules: Record<number, FusionChunkModule>;
}

export interface FusionChunkModule {
  moduleId: number;
  moduleFile: File;
  moduleSource: string;
  importedModules: number[];
}

export async function splitFusionChunk(
  fusionChunkSrc: string,
  write: false | string,
): Promise<FusionChunk | null> {
  const m = fusionChunkSrc.match(
    /^(\((self\.webpackChunkFusion)=\2\|\|\[\]\)\.push\()\[\[(\d+)\],(\{.+\})]\);\s*$/s,
  );

  if (!m) {
    return null;
  }

  const chunkId = parseInt(m[3]);
  const chunkModulesSrc = `(${m[4]}, 0)`;

  console.group(`Chunk ${chunkId}:`);

  const chunkModulesFilename = write
    ? join(write, `chunk-${chunkId}.js`)
    : null;
  const chunkModulesSrcFormattedPromise = write
    ? format(chunkModulesSrc, {
        parser: "babel",
        filepath: chunkModulesFilename!,
      }).then(async (chunkModulesSrcFormatted) => {
        await Bun.write(chunkModulesFilename!, chunkModulesSrcFormatted);
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

  const chunkModules: Record<number, FusionChunkModule> = {};

  let chunkModuleParams: string[] = [];

  let isInModuleGroup = false;
  chunkModulesLoop: for (const property of rootObjectExpression.properties) {
    if (isInModuleGroup) {
      console.groupEnd();
      isInModuleGroup = false;
    }

    if (!isObjectProperty(property)) {
      console.warn("Chunk module is not an object property:", property.type);
      continue;
    }

    if (!isNumericLiteral(property.key)) {
      if (isIdentifier(property.key)) {
        const fusionModuleMatch = property.key.name.match(/^__fusion__(\d+)$/);

        if (fusionModuleMatch) {
          const fusionModuleId = parseInt(fusionModuleMatch[1]);

          console.group(`Fusion module ${fusionModuleId}:`);
          isInModuleGroup = true;

          // TODO
          console.warn(`Fusion modules not implemented`);
          continue;
        }
      }

      console.warn("Invalid chunk module key:", property.key.type);
      continue;
    }

    const moduleId = property.key.value;

    console.group(`Module ${moduleId}:`);
    isInModuleGroup = true;

    if (!isArrowFunctionExpression(property.value)) {
      console.warn("Invalid chunk module value:", property.value.type);
      continue;
    }

    const moduleFunction = property.value;

    if (moduleFunction.params.length > 3) {
      console.warn(
        "Too many chunk module function params:",
        moduleFunction.params.length,
      );
      continue;
    }

    for (let i = 0; i < moduleFunction.params.length; i++) {
      const param = moduleFunction.params[i];

      if (!isIdentifier(param)) {
        console.warn("Invalid chunk module function param:", param.type);
        continue chunkModulesLoop;
      }

      if (chunkModuleParams[i]) {
        if (chunkModuleParams[i] !== param.name) {
          console.warn("Invalid chunk module function param:", param.name);
          continue chunkModulesLoop;
        }
      } else {
        chunkModuleParams[i] = param.name;
      }
    }

    if (!isBlockStatement(moduleFunction.body)) {
      console.warn(
        "Invalid chunk module function body:",
        moduleFunction.body.type,
      );
      continue;
    }

    const moduleFile = file(program(moduleFunction.body.body));

    const importedModules: number[] = [];

    traverse(moduleFile, {
      CallExpression(path) {
        if (isMemberExpression(path.node.callee)) {
          if (isIdentifier(path.node.callee.object)) {
            if (path.node.callee.object.name === chunkModuleParams[2]) {
              if (isIdentifier(path.node.callee.property)) {
                if (path.node.callee.property.name === "d") {
                  if (path.node.arguments.length !== 2) {
                    console.warn(
                      "Invalid export arguments:",
                      path.node.arguments.length,
                    );
                    return;
                  }

                  if (
                    !isIdentifier(path.node.arguments[0]) ||
                    path.node.arguments[0].name !== chunkModuleParams[1]
                  ) {
                    console.warn(
                      "Invalid export first argument:",
                      path.node.arguments[0].type,
                    );
                    return;
                  }

                  if (!isObjectExpression(path.node.arguments[1])) {
                    console.warn(
                      "Invalid exports:",
                      path.node.arguments[1].type,
                    );
                    return;
                  }

                  console.group(
                    "Rewriting",
                    path.node.arguments[1].properties.length,
                    "exports:",
                  );

                  for (const property of path.node.arguments[1].properties) {
                    if (!isObjectProperty(property)) {
                      console.warn("Invalid export:", property.type);
                      continue;
                    }

                    if (!isIdentifier(property.key)) {
                      console.warn(
                        "Invalid export property key:",
                        property.key.type,
                      );
                      continue;
                    }

                    if (!isArrowFunctionExpression(property.value)) {
                      console.warn(
                        "Invalid export property value:",
                        property.value.type,
                      );
                      continue;
                    }

                    if (property.value.params.length) {
                      console.warn(
                        "Invalid export property value params:",
                        property.value.params.length,
                      );
                      continue;
                    }

                    if (isBlockStatement(property.value.body)) {
                      if (property.value.body.body.length) {
                        console.warn(
                          "Invalid export property value body:",
                          property.value.body.body.length,
                        );
                        continue;
                      }

                      // TODO: void export
                      console.warn("Void exports not implemented");
                    } else if (isIdentifier(property.value.body)) {
                      const statementParent = path.getStatementParent();

                      if (!statementParent) {
                        console.warn("No statement parent for export found");
                        continue;
                      }

                      const exportedVar = property.value.body.name;
                      const exportAs = property.key.name;

                      console.debug(
                        "Rewriting export",
                        exportedVar,
                        "\tas",
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
                    } else {
                      console.warn(
                        "Invalid export property value body:",
                        property.value.body.type,
                      );
                      continue;
                    }
                  }

                  console.groupEnd();

                  path.remove();
                }
              }
            }
          }
        }
      },
      VariableDeclarator(path) {
        if (isCallExpression(path.node.init)) {
          if (
            isIdentifier(path.node.init.callee) &&
            path.node.init.callee.name === chunkModuleParams[2]
          ) {
            // If there is no binding to the import function, it will
            // be the chunk module function param, since this is out
            // of scope of moduleFile

            if (!path.scope.hasBinding(path.node.init.callee.name)) {
              if (path.node.init.arguments.length !== 1) {
                console.warn(
                  "Invalid number of import arguments:",
                  path.node.init.arguments.length,
                );
                return;
              }

              if (!isNumericLiteral(path.node.init.arguments[0])) {
                console.warn(
                  "Invalid import argument:",
                  path.node.init.arguments[0].type,
                );
                return;
              }

              const importModuleId = path.node.init.arguments[0].value;

              if (!isIdentifier(path.node.id)) {
                console.warn(
                  "Non-identifier imports are not implemented, got:",
                  path.node.id.type,
                );
                return;
              }

              path.parentPath.insertBefore(
                importDeclaration(
                  [importNamespaceSpecifier(identifier(path.node.id.name))],
                  stringLiteral(`./${importModuleId}`),
                ),
              );
              path.remove();

              importedModules.push(importModuleId);
            }
          }
        }
      },
    });

    const filename = write ? join(write, `${moduleId}.js`) : undefined;

    const moduleCode = generate(moduleFile, { filename }).code;

    const formattedModuleCode = await format(moduleCode, {
      parser: "babel",
      filepath: filename,

      ...prettierConfig,
    });

    chunkModules[moduleId] = {
      moduleId,
      moduleFile,
      moduleSource: formattedModuleCode,
      importedModules,
    };

    if (write) {
      await Bun.write(
        filename!,
        `\
/*
 * Fusion chunk ${chunkId} module ${moduleId}
 */

${formattedModuleCode}`,
      );
    }
  }

  if (isInModuleGroup) {
    console.groupEnd();
  }

  await chunkModulesSrcFormattedPromise;

  console.groupEnd();

  return { chunkId, chunkModules };
}

if (import.meta.main) {
  const importedModules = new Set<number>();
  const declaredModules = new Set<number>();

  for (const arg of process.argv.slice(2)) {
    const chunk = await splitFusionChunk(
      await Bun.file(arg).text(),
      "re/modules",
    );

    if (!chunk) {
      console.warn("Invalid chunk:", arg);
      continue;
    }

    for (const moduleId in chunk.chunkModules) {
      const module = chunk.chunkModules[moduleId];

      for (const importedModule of module.importedModules) {
        importedModules.add(importedModule);
      }

      declaredModules.add(module.moduleId);
    }
  }

  const undeclaredModules = importedModules.difference(declaredModules);

  if (undeclaredModules.size) {
    console.warn(
      "Some modules were imported but not declared, across all input files:",
      undeclaredModules,
    );
  }
}
