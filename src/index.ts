import type { File } from "@babel/types";

import { join } from "node:path";

import generate from "@babel/generator";
import { parse } from "@babel/parser";
import traverse from "@babel/traverse";
import {
  assignmentExpression,
  exportDefaultDeclaration,
  exportNamedDeclaration,
  exportSpecifier,
  file,
  identifier,
  importDeclaration,
  importNamespaceSpecifier,
  importSpecifier,
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
  memberExpression,
  program,
  stringLiteral,
  variableDeclaration,
  variableDeclarator,
} from "@babel/types";
import { format } from "prettier";
import reserved from "reserved";

import prettierConfig from "../.prettierrc.json";
import { getDefaultExport, parseImportCall } from "./ast";

export interface FusionChunk {
  chunkId: number;
  chunkModules: Record<number, FusionChunkModule>;
}

export interface FusionChunkModule {
  id: number;

  file: File;
  source: string;

  isCommonJS: boolean;
  importedModules: number[];
}

export async function splitFusionChunk(
  fusionChunkSrc: string,
  {
    esmDefaultExports = true,
    write,
  }: {
    esmDefaultExports?: boolean;
    write: false | string;
  },
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

    let moduleIsCommonJS = false;
    let moduleHasDefaultExport = false;

    traverse(moduleFile, {
      AssignmentExpression(path) {
        const defaultExport = getDefaultExport(path, chunkModuleParams);

        if (!defaultExport) {
          return;
        }

        if (moduleHasDefaultExport) {
          console.log("Multiple default exports found, assuming CommonJS");
          moduleIsCommonJS = true;
          path.stop();
        } else if (isObjectExpression(defaultExport)) {
          console.log("Default export is an object, assuming CommonJS");
          moduleIsCommonJS = true;
          path.stop();
        }

        moduleHasDefaultExport = true;
      },
    });

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

                      console.log(
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
          const importModuleId = parseImportCall(
            path.node.init,
            path.scope,
            chunkModuleParams,
          );

          if (importModuleId === null) {
            return;
          }

          importedModules.push(importModuleId);

          if (!isIdentifier(path.node.id)) {
            console.warn(
              "Non-identifier imports are not implemented, got:",
              path.node.id.type,
            );
            return;
          }

          // TODO: use statementParent

          path.parentPath.insertBefore(
            importDeclaration(
              [importNamespaceSpecifier(identifier(path.node.id.name))],
              stringLiteral(`./${importModuleId}`),
            ),
          );
          path.remove();
        } else if (isMemberExpression(path.node.init)) {
          if (isCallExpression(path.node.init.object)) {
            const importModuleId = parseImportCall(
              path.node.init.object,
              path.scope,
              chunkModuleParams,
            );

            if (importModuleId === null) {
              return;
            }

            importedModules.push(importModuleId);

            if (!isIdentifier(path.node.id)) {
              console.warn(
                "Non-identifier imports are not implemented, got:",
                path.node.id.type,
              );
              return;
            }

            if (!isIdentifier(path.node.init.property)) {
              console.warn(
                "Non-identifier import accessors are not implemented, got:",
                path.node.init.property.type,
              );
              return;
            }

            // TODO: use statementParent

            path.parentPath.insertBefore(
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
        const defaultExport = getDefaultExport(path, chunkModuleParams);

        if (!defaultExport) {
          return;
        }

        const statementParent = path.getStatementParent();

        if (!statementParent) {
          console.warn("No statement parent for default exports found");
          return;
        }

        if (moduleIsCommonJS || !esmDefaultExports) {
          console.log("Rewriting default exports as CommonJS");

          path.replaceWith(
            assignmentExpression(
              "=",
              memberExpression(identifier("module"), identifier("exports")),
              defaultExport,
            ),
          );

          return;
        }

        console.log("Rewriting default exports");

        const exportsId = path.scope.generateUidIdentifier("exports");
        statementParent.insertBefore(
          variableDeclaration("const", [
            variableDeclarator(exportsId, defaultExport),
          ]),
        );
        statementParent.insertBefore(exportDefaultDeclaration(exportsId));

        path.replaceWith(exportsId);
      },
      ExportSpecifier(path) {
        if (!isIdentifier(path.node.exported)) {
          console.warn(
            "Non-identifier exports should be unreachable, got:",
            path.node.exported.type,
          );
          return;
        }

        if (path.node.local.name === path.node.exported.name) {
          return;
        }

        let renameTo = path.node.exported.name;

        if (reserved.includes(renameTo)) {
          renameTo = `_${renameTo}`;
        }

        if (path.scope.hasBinding(renameTo)) {
          console.warn(
            "Cannot rename local to match export,",
            renameTo,
            "is already bound",
          );
          return;
        }

        path.scope.rename(path.node.local.name, renameTo);

        console.log(
          "Renamed local",
          path.node.local.name,
          "to match export:",
          renameTo,
        );
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
      id: moduleId,

      file: moduleFile,
      source: formattedModuleCode,

      isCommonJS: moduleIsCommonJS,
      importedModules,
    };

    if (write) {
      await Bun.write(
        filename!,
        `\
/*
 * Fusion chunk ${chunkId}, ${moduleIsCommonJS ? "CJS" : "ESM"} module ${moduleId}
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
    const chunk = await splitFusionChunk(await Bun.file(arg).text(), {
      write: "re/modules",
    });

    if (!chunk) {
      console.warn("Invalid chunk:", arg);
      continue;
    }

    for (const moduleId in chunk.chunkModules) {
      const module = chunk.chunkModules[moduleId];

      for (const importedModule of module.importedModules) {
        importedModules.add(importedModule);
      }

      declaredModules.add(module.id);
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
