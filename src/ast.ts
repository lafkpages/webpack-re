import type { NodePath } from "@babel/traverse";
import type { AssignmentExpression } from "@babel/types";

import { isIdentifier, isMemberExpression } from "@babel/types";

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
