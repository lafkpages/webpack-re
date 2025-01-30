import type { NodePath, Scope } from "@babel/traverse";
import type { AssignmentExpression, CallExpression } from "@babel/types";

import {
  isIdentifier,
  isMemberExpression,
  isNumericLiteral,
} from "@babel/types";

export function getDefaultExport(
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
      console.warn("Invalid default exports operator:", path.node.operator);
      return null;
    }

    return path.node.right;
  }

  return null;
}

export function parseImportCall(
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
        console.warn(
          "Invalid number of import arguments:",
          callExpression.arguments.length,
        );
        return null;
      }

      if (!isNumericLiteral(callExpression.arguments[0])) {
        console.warn(
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
