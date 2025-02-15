import type { NodePath, Scope } from "@babel/traverse";
import type {
  AssignmentExpression,
  CallExpression,
  ExportSpecifier,
  Identifier,
  ImportSpecifier,
} from "@babel/types";
import type { ConsolaInstance } from "consola";

import {
  isIdentifier,
  isMemberExpression,
  isNumericLiteral,
} from "@babel/types";
import reserved from "reserved";

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

      if (!isNumericLiteral(callExpression.arguments[0])) {
        moduleLogger.warn(
          "Invalid import argument:",
          callExpression.arguments[0].type,
        );
        return null;
      }

      const importModuleId = callExpression.arguments[0].value;

      return importModuleId;
    }
  }

  return null;
}

export function rename(
  moduleLogger: ConsolaInstance,
  path: NodePath<Identifier | ImportSpecifier | ExportSpecifier>,
  renameTo: string | null | undefined,
  reason?: string,
) {
  if (!renameTo) {
    return false;
  }

  if (reserved.includes(renameTo)) {
    renameTo = `_${renameTo}`;
  }

  let originalName: string;
  if (isIdentifier(path.node)) {
    originalName = path.node.name;
  } else {
    originalName = path.node.local.name;
  }

  if (originalName === renameTo) {
    return false;
  }

  if (path.scope.hasBinding(renameTo)) {
    moduleLogger.warn(
      "Cannot rename",
      originalName,
      "to",
      renameTo,
      "as it is already bound",
      reason ? `(${reason})` : "",
    );
    return false;
  }

  path.scope.rename(originalName, renameTo);

  let msg = `Renamed variable ${originalName} to ${renameTo}`;
  if (reason) {
    msg += `, ${reason}`;
  }
  moduleLogger.info(msg);

  return true;
}
