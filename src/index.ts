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

  chunkModulesLoop: for (const property of rootObjectExpression.properties) {
    if (!isObjectProperty(property)) {
      console.warn(`[chunk-${chunkId}] chunk module is not an object property`);
      continue;
    }

    if (!isNumericLiteral(property.key)) {
      if (isIdentifier(property.key)) {
        const fusionModuleMatch = property.key.name.match(/^__fusion__(\d+)$/);

        if (fusionModuleMatch) {
          const fusionModuleId = parseInt(fusionModuleMatch[1]);

          // TODO
          continue;
        }
      }

      console.warn(`[chunk-${chunkId}] invalid chunk module key`);
      continue;
    }

    const moduleId = property.key.value;

    if (!isArrowFunctionExpression(property.value)) {
      console.warn(
        `[chunk-${chunkId}] [module-${moduleId}] invalid chunk module value`,
      );
      continue;
    }

    const moduleFunction = property.value;

    if (moduleFunction.params.length > 3) {
      console.warn(
        `[chunk-${chunkId}] [module-${moduleId}] too many chunk module function params: ${moduleFunction.params.length}`,
      );
      continue;
    }

    for (let i = 0; i < moduleFunction.params.length; i++) {
      const param = moduleFunction.params[i];

      if (!isIdentifier(param)) {
        console.warn(
          `[chunk-${chunkId}] [module-${moduleId}] invalid chunk module function param`,
        );
        continue chunkModulesLoop;
      }

      if (chunkModuleParams[i]) {
        if (chunkModuleParams[i] !== param.name) {
          console.warn(
            `[chunk-${chunkId}] [module-${moduleId}] invalid chunk module function param: ${param.name}`,
          );
          continue chunkModulesLoop;
        }
      } else {
        chunkModuleParams[i] = param.name;
      }
    }

    if (!isBlockStatement(moduleFunction.body)) {
      console.warn(
        `[chunk-${chunkId}] [module-${moduleId}] invalid chunk module function body`,
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
                      `[chunk-${chunkId}] [module-${moduleId}] invalid export arguments: ${path.node.arguments.length}`,
                    );
                    return;
                  }

                  if (
                    !isIdentifier(path.node.arguments[0]) ||
                    path.node.arguments[0].name !== chunkModuleParams[1]
                  ) {
                    console.warn(
                      `[chunk-${chunkId}] [module-${moduleId}] invalid export first argument`,
                    );
                    return;
                  }

                  if (!isObjectExpression(path.node.arguments[1])) {
                    console.warn(
                      `[chunk-${chunkId}] [module-${moduleId}] invalid exports`,
                    );
                    return;
                  }

                  console.debug(
                    `[chunk-${chunkId}] [module-${moduleId}] rewriting exports`,
                  );

                  for (const property of path.node.arguments[1].properties) {
                    if (!isObjectProperty(property)) {
                      console.warn(
                        `[chunk-${chunkId}] [module-${moduleId}] invalid export`,
                      );
                      continue;
                    }

                    if (!isIdentifier(property.key)) {
                      console.warn(
                        `[chunk-${chunkId}] [module-${moduleId}] invalid export property key`,
                      );
                      continue;
                    }

                    if (!isArrowFunctionExpression(property.value)) {
                      console.warn(
                        `[chunk-${chunkId}] [module-${moduleId}] invalid export property value`,
                      );
                      continue;
                    }

                    if (property.value.params.length) {
                      console.warn(
                        `[chunk-${chunkId}] [module-${moduleId}] invalid export property value params`,
                      );
                      continue;
                    }

                    if (isBlockStatement(property.value.body)) {
                      if (property.value.body.body.length) {
                        console.warn(
                          `[chunk-${chunkId}] [module-${moduleId}] invalid export property value body`,
                        );
                        continue;
                      }

                      // TODO: void export
                    } else if (isIdentifier(property.value.body)) {
                      const statementParent = path.getStatementParent();

                      if (!statementParent) {
                        console.warn(
                          `[chunk-${chunkId}] [module-${moduleId}] invalid export statement parent`,
                        );
                        continue;
                      }

                      const exportedVar = property.value.body.name;
                      const exportAs = property.key.name;

                      console.debug(
                        `[chunk-${chunkId}] [module-${moduleId}] rewriting export ${exportedVar} as ${exportAs}`,
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
                        `[chunk-${chunkId}] [module-${moduleId}] invalid export property value body`,
                      );
                      continue;
                    }
                  }

                  path.addComment(
                    "leading",
                    "Fusion chunk module exports",
                    true,
                  );

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
                  `[chunk-${chunkId}] [module-${moduleId}] invalid number of import arguments: ${path.node.init.arguments.length}`,
                );
                return;
              }

              if (!isNumericLiteral(path.node.init.arguments[0])) {
                console.warn(
                  `[chunk-${chunkId}] [module-${moduleId}] invalid import argument`,
                );
                return;
              }

              const importModuleId = path.node.init.arguments[0].value;

              if (!isIdentifier(path.node.id)) {
                console.warn(
                  `[chunk-${chunkId}] [module-${moduleId}] non-identifier imports are not implemented`,
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

  await chunkModulesSrcFormattedPromise;

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
      console.warn(`[chunk-${arg}] invalid chunk`);
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
      `undeclared modules: ${Array.from(undeclaredModules).join(", ")}`,
    );
  }
}
