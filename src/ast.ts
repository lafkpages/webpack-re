import type { NodePath, Scope } from "@babel/traverse";
import type {
  AssignmentExpression,
  CallExpression,
  File,
  Identifier,
} from "@babel/types";
import type { ConsolaInstance } from "consola";
import type { ChunkGraph, ChunkModules, ModuleTransformations } from ".";

import traverse from "@babel/traverse";
import {
  assignmentExpression,
  awaitExpression,
  callExpression,
  exportDefaultDeclaration,
  exportNamedDeclaration,
  exportSpecifier,
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
  isStringLiteral,
  memberExpression,
  stringLiteral,
  variableDeclaration,
  variableDeclarator,
} from "@babel/types";
import reserved from "reserved";

export function getChunkRootObject(ast: File) {
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

  return rootObjectExpression;
}

export function getDefaultExport(
  moduleLogger: ConsolaInstance,
  path: NodePath<AssignmentExpression>,
  chunkModuleParams: string[],
) {
  if (
    isMemberExpression(path.node.left) &&
    isIdentifier(path.node.left.object) &&
    path.node.left.object.name === chunkModuleParams[0] &&
    !path.scope.hasBinding(path.node.left.object.name) &&
    isIdentifier(path.node.left.property) &&
    path.node.left.property.name === "exports"
  ) {
    if (path.node.operator !== "=") {
      moduleLogger.warn(
        "Invalid default exports operator:",
        path.node.operator,
      );
      return null;
    }

    return path.node.right;
  }

  return null;
}

export function parseImportCall(
  moduleLogger: ConsolaInstance,
  callExpression: CallExpression,
  scope: Scope,
  chunkModuleParams: string[],
) {
  if (
    isIdentifier(callExpression.callee) &&
    callExpression.callee.name === chunkModuleParams[2]
  ) {
    // If there is no binding to the import function, it will
    // be the chunk module function param, since this is out
    // of scope of moduleFile

    if (!scope.hasBinding(callExpression.callee.name)) {
      if (callExpression.arguments.length !== 1) {
        moduleLogger.warn(
          "Invalid number of import arguments:",
          callExpression.arguments.length,
        );
        return null;
      }

      const importArgument = callExpression.arguments[0];

      if (
        !isNumericLiteral(importArgument) &&
        !isStringLiteral(importArgument)
      ) {
        moduleLogger.warn("Invalid import argument:", importArgument.type);
        return null;
      }

      const importModuleId = importArgument.value.toString();

      return importModuleId;
    }
  }

  return null;
}

export function rename(
  moduleLogger: ConsolaInstance,
  scope: Scope,
  originalName: string,
  renameTo: string | null | undefined,
  reason?: string,
): string | null {
  if (!renameTo) {
    return null;
  }

  if (reserved.includes(renameTo)) {
    renameTo = `_${renameTo}`;
  }

  if (originalName === renameTo) {
    return null;
  }

  if (scope.hasBinding(renameTo)) {
    moduleLogger.warn(
      "Cannot rename",
      originalName,
      "to",
      renameTo,
      "as it is already bound",
      reason ? `(${reason})` : "",
    );
    return null;
  }

  scope.rename(originalName, renameTo);

  let msg = `Renamed variable ${originalName} to ${renameTo}`;
  if (reason) {
    msg += `, ${reason}`;
  }
  moduleLogger.info(msg);

  return renameTo;
}

export function resolveModule(
  moduleId: string | number,
  moduleTransformations?: ModuleTransformations | null,
) {
  if (moduleTransformations?.renameModule) {
    return [
      moduleTransformations.renameModule,
      moduleTransformations.importAsAbsolute
        ? moduleTransformations.renameModule
        : `./${moduleTransformations.renameModule}`,
    ];
  }

  return [moduleId.toString(), `./${moduleId}`];
}

export function moduleScanTraversal(
  logger: ConsolaInstance,
  file: File,
  id: string,
  moduleTransformations: ModuleTransformations | null | undefined,
  graph: ChunkGraph | null | undefined,
  chunkModuleParams: string[],
) {
  logger.debug("Running initial import and export scan traversal");

  let isCommonJS = false;
  let hasDefaultExport = false;

  traverse(file, {
    CallExpression(path) {
      const importRawModuleId = parseImportCall(
        logger,
        path.node,
        path.scope,
        chunkModuleParams,
      );

      if (importRawModuleId === null) {
        return;
      }

      const [importModuleId] = resolveModule(
        importRawModuleId,
        moduleTransformations,
      );

      graph?.mergeEdge(id, importModuleId);
    },
    VariableDeclarator(path) {
      if (isCallExpression(path.node.init)) {
        const importRawModuleId = parseImportCall(
          logger,
          path.node.init,
          path.scope,
          chunkModuleParams,
        );

        if (importRawModuleId === null) {
          return;
        }

        const [importModuleId] = resolveModule(
          importRawModuleId,
          moduleTransformations,
        );

        graph?.mergeEdge(id, importModuleId);
      } else if (isMemberExpression(path.node.init)) {
        if (isCallExpression(path.node.init.object)) {
          const importRawModuleId = parseImportCall(
            logger,
            path.node.init.object,
            path.scope,
            chunkModuleParams,
          );

          if (importRawModuleId === null) {
            return;
          }

          const [importModuleId] = resolveModule(
            importRawModuleId,
            moduleTransformations,
          );

          graph?.mergeEdge(id, importModuleId);
        }
      }
    },
    AssignmentExpression(path) {
      const defaultExport = getDefaultExport(logger, path, chunkModuleParams);

      if (!defaultExport) {
        return;
      }

      if (hasDefaultExport) {
        logger.info("Multiple default exports found, assuming CommonJS");
        isCommonJS = true;
      } else if (isObjectExpression(defaultExport)) {
        logger.info("Default export is an object, assuming CommonJS");
        isCommonJS = true;
      }

      hasDefaultExport = true;
    },
  });

  return { isCommonJS, hasDefaultExport };
}

export function traverseModule(
  logger: ConsolaInstance,
  file: File,
  transformations: ModuleTransformations | null | undefined,
  isCommonJS: boolean,
  chunkModules: ChunkModules,
  chunkModuleParams: string[],
  esmDefaultExports = true,
) {
  logger.debug("Running module split traversal");

  const importsToRename = new Map<string, string>();

  traverse(file, {
    CallExpression(path) {
      if (isMemberExpression(path.node.callee)) {
        if (isIdentifier(path.node.callee.object)) {
          if (path.node.callee.object.name === chunkModuleParams[2]) {
            if (isIdentifier(path.node.callee.property)) {
              if (path.node.callee.property.name === "d") {
                if (path.node.arguments.length !== 2) {
                  logger.warn(
                    "Invalid export arguments:",
                    path.node.arguments.length,
                  );
                  return;
                }

                if (
                  !isIdentifier(path.node.arguments[0]) ||
                  path.node.arguments[0].name !== chunkModuleParams[1]
                ) {
                  logger.warn(
                    "Invalid export first argument:",
                    path.node.arguments[0].type,
                  );
                  return;
                }

                if (!isObjectExpression(path.node.arguments[1])) {
                  logger.warn("Invalid exports:", path.node.arguments[1].type);
                  return;
                }

                for (const property of path.node.arguments[1].properties) {
                  if (!isObjectProperty(property)) {
                    logger.warn("Invalid export:", property.type);
                    continue;
                  }

                  if (!isIdentifier(property.key)) {
                    logger.warn(
                      "Invalid export property key:",
                      property.key.type,
                    );
                    continue;
                  }

                  if (
                    !isFunctionExpression(property.value) &&
                    !isArrowFunctionExpression(property.value)
                  ) {
                    logger.warn(
                      "Invalid export property value:",
                      property.value.type,
                    );
                    continue;
                  }

                  if (property.value.params.length) {
                    logger.warn(
                      "Invalid export property value params:",
                      property.value.params.length,
                    );
                    continue;
                  }

                  let exportedVar: string | null = null;

                  if (isBlockStatement(property.value.body)) {
                    if (property.value.body.body.length === 1) {
                      if (!isReturnStatement(property.value.body.body[0])) {
                        logger.warn(
                          "Invalid export property value body:",
                          property.value.body.body[0].type,
                        );
                        continue;
                      }

                      if (!property.value.body.body[0].argument) {
                        // TODO: void export
                        logger.warn("Void exports not implemented");
                        continue;
                      }

                      if (!isIdentifier(property.value.body.body[0].argument)) {
                        logger.warn(
                          "Invalid export property value body argument:",
                          property.value.body.body[0].argument.type,
                        );
                        continue;
                      }

                      exportedVar = property.value.body.body[0].argument.name;
                    } else if (property.value.body.body.length) {
                      logger.warn(
                        "Invalid export property value body length:",
                        property.value.body.body.length,
                      );
                      continue;
                    }

                    // TODO: void export
                    logger.warn("Void exports not implemented");
                  } else if (isIdentifier(property.value.body)) {
                    exportedVar = property.value.body.name;
                  } else {
                    const statementParent = path.getStatementParent()!;

                    logger.info("Rewriting export", property.key.name);

                    statementParent.insertBefore(
                      exportNamedDeclaration(
                        variableDeclaration("const", [
                          variableDeclarator(property.key, property.value.body),
                        ]),
                      ),
                    );
                  }

                  if (exportedVar) {
                    const statementParent = path.getStatementParent()!;

                    const exportAs = property.key.name;

                    logger.info(
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
          logger,
          path.node,
          path.scope,
          chunkModuleParams,
        );

        if (importRawModuleId === null) {
          return;
        }

        const [, importModulePath] = resolveModule(
          importRawModuleId,
          transformations,
        );

        let useRequire = isCommonJS;

        if (!isCommonJS) {
          const functionParent = path.getFunctionParent();

          if (functionParent?.node.async === false) {
            // If the parent function is not async, we cannot use await
            useRequire = true;
          }
        }

        if (useRequire) {
          logger.info("Rewriting import call as require");

          path.replaceWith(
            callExpression(identifier("require"), [
              stringLiteral(importModulePath),
            ]),
          );

          return;
        }

        logger.info("Rewriting import call");

        path.replaceWith(
          awaitExpression(importExpression(stringLiteral(importModulePath))),
        );
      }
    },
    VariableDeclarator(path) {
      if (isCallExpression(path.node.init)) {
        const importRawModuleId = parseImportCall(
          logger,
          path.node.init,
          path.scope,
          chunkModuleParams,
        );

        if (importRawModuleId === null) {
          return;
        }

        const [importModuleId, importModulePath] = resolveModule(
          importRawModuleId,
          transformations,
        );

        if (isCommonJS) {
          logger.info("Rewriting import call as require");

          path.replaceWith(
            variableDeclarator(
              path.node.id,
              callExpression(identifier("require"), [
                stringLiteral(importModulePath),
              ]),
            ),
          );

          return;
        }

        if (!isIdentifier(path.node.id)) {
          logger.warn(
            "Non-identifier imports are not implemented, got:",
            path.node.id.type,
          );
          return;
        }

        const statementParent = path.getStatementParent();

        if (!statementParent) {
          logger.warn("No statement parent for import found");
          return;
        }

        if (chunkModules[importModuleId]?.hasDefaultExport) {
          statementParent.insertBefore(
            importDeclaration(
              [importDefaultSpecifier(identifier(path.node.id.name))],
              stringLiteral(importModulePath),
            ),
          );
        } else {
          statementParent.insertBefore(
            importDeclaration(
              [importNamespaceSpecifier(identifier(path.node.id.name))],
              stringLiteral(importModulePath),
            ),
          );
        }

        path.remove();
      } else if (isMemberExpression(path.node.init)) {
        if (isCallExpression(path.node.init.object)) {
          const importRawModuleId = parseImportCall(
            logger,
            path.node.init.object,
            path.scope,
            chunkModuleParams,
          );

          if (importRawModuleId === null) {
            return;
          }

          const [, importModulePath] = resolveModule(
            importRawModuleId,
            transformations,
          );

          if (!isIdentifier(path.node.id)) {
            logger.warn(
              "Non-identifier imports are not implemented, got:",
              path.node.id.type,
            );
            return;
          }

          if (!isIdentifier(path.node.init.property)) {
            logger.warn(
              "Non-identifier import accessors are not implemented, got:",
              path.node.init.property.type,
            );
            return;
          }

          const statementParent = path.getStatementParent();

          if (!statementParent) {
            logger.warn("No statement parent for import found");
            return;
          }

          let local = path.node.id.name;
          const imported = path.node.init.property.name;

          if (
            !reserved.includes(imported) &&
            !path.scope.hasBinding(imported)
          ) {
            logger.info(
              "Renamed local",
              local,
              "to match imported name",
              imported,
            );

            importsToRename.set(local, imported);
            local = imported;
          }

          statementParent.insertBefore(
            importDeclaration(
              [importSpecifier(identifier(local), identifier(imported))],
              stringLiteral(importModulePath),
            ),
          );
          path.remove();
        }
      }
    },
    AssignmentExpression(path) {
      const defaultExport = getDefaultExport(logger, path, chunkModuleParams);

      if (defaultExport) {
        if (isCommonJS || !esmDefaultExports) {
          logger.info("Rewriting default exports as CommonJS");

          path.replaceWith(
            assignmentExpression(
              "=",
              memberExpression(identifier("module"), identifier("exports")),
              defaultExport,
            ),
          );

          return;
        }

        logger.info("Rewriting default exports");

        if (isExpressionStatement(path.parent)) {
          path.parentPath.replaceWith(exportDefaultDeclaration(defaultExport));
        } else {
          const statementParent = path.getStatementParent();

          if (!statementParent) {
            logger.warn("No statement parent for default exports found");
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

        return;
      }

      if (
        !isCommonJS &&
        isMemberExpression(path.node.left) &&
        isIdentifier(path.node.left.object) &&
        isIdentifier(path.node.left.property) &&
        path.node.left.object.name === chunkModuleParams[1] &&
        !path.scope.hasBinding(path.node.left.object.name)
      ) {
        if (!isIdentifier(path.node.right)) {
          logger.warn(
            "Non-identifier exports not supported, got:",
            path.node.right.type,
          );
          return;
        }

        const local = path.node.right.name;
        const exported = path.node.left.property.name;

        logger.info("Rewriting export of", local);

        const statementParent = path.getStatementParent();

        if (!statementParent) {
          logger.warn("No statement parent for export found");
          return;
        }

        statementParent.insertBefore(
          exportNamedDeclaration(null, [
            exportSpecifier(identifier(local), identifier(exported)),
          ]),
        );

        // TODO: check if return value is used
        path.remove();
      }
    },
    Identifier(path) {
      const renameImportTo = importsToRename.get(path.node.name);

      if (!path.scope.hasBinding(path.node.name)) {
        if (renameImportTo) {
          // For some reason, Scope.rename() doesn't work for imports,
          // so this is a workaround to rename locals to match imports
          path.node.name = renameImportTo;
        } else if (path.node.name === chunkModuleParams[1]) {
          path.node.name = "exports";
        }

        // else {
        //   const chunkModuleParam = chunkModuleParams.indexOf(path.node.name);

        //   if (chunkModuleParam !== -1) {
        //     path.node.name = chunkModuleParamsNames[chunkModuleParam];
        //   }
        // }
      }
    },
    ExportSpecifier(path) {
      if (!isIdentifier(path.node.exported)) {
        logger.warn(
          "Non-identifier exports should be unreachable, got:",
          path.node.exported.type,
        );
        return;
      }

      rename(
        logger,
        path.scope,
        path.node.local.name,
        path.node.exported.name,
        "to match export",
      );
    },
  });
}

export function applyModuleTransformations(
  logger: ConsolaInstance,
  file: File,
  includeVariableDeclarationComments: boolean | null | undefined,
  includeVariableReferenceComments: boolean | null | undefined,
  moduleTransformations: ModuleTransformations | null | undefined,
) {
  if (
    includeVariableDeclarationComments ||
    includeVariableReferenceComments ||
    (moduleTransformations?.renameVariables &&
      Object.getOwnPropertyNames(moduleTransformations?.renameVariables).length)
    // getOwnPropertyNames is the fastest way to check if an object is empty in Bun:
    // https://discord.com/channels/876711213126520882/1111136889743888455/1260408373086785608
  ) {
    logger.debug("Running module transformation traversal");

    const moduleVariables = new WeakMap<Identifier, number>();
    let moduleVariableCount = 0;

    traverse(file, {
      Identifier(path) {
        const binding = path.scope.getBinding(path.node.name);

        if (!binding) {
          return;
        }

        if (binding.identifier === path.node) {
          // This is the declaration

          const variableId = moduleVariableCount;

          if (includeVariableDeclarationComments) {
            path.addComment("leading", `vd ${variableId}`);
          }

          moduleVariables.set(path.node, variableId);

          rename(
            logger,
            path.scope,
            path.node.name,
            moduleTransformations?.renameVariables?.[variableId],
            "due to module transformation",
          );

          moduleVariableCount++;
        } else if (includeVariableReferenceComments) {
          // This is a reference
          const variableId = moduleVariables.get(binding.identifier);
          path.addComment("leading", `vr ${variableId}`);
        }
      },
    });

    return moduleVariableCount;
  }

  return null;
}
