import type { File } from "@babel/types";

import { join } from "node:path";

import generate from "@babel/generator";
import { parse } from "@babel/parser";
import {
  file,
  isArrowFunctionExpression,
  isBlockStatement,
  isFunctionExpression,
  isIdentifier,
  isNumericLiteral,
  isObjectProperty,
  isStringLiteral,
  program,
} from "@babel/types";
import consola from "consola";
import { DirectedGraph } from "graphology";
import { format } from "prettier";

import prettierConfig from "../.prettierrc.json";
import {
  applyModuleTransformations,
  getChunkRootObject,
  moduleScanTraversal,
  resolveModule,
  traverseModule,
} from "./ast";

export type ChunkGraph = DirectedGraph<{}, {}, {}>;

export interface ChunkModule {
  file: File;
  source: string;

  rawModuleId: string;

  isCommonJS: boolean;
  hasDefaultExport: boolean;
}

export interface ChunkModules {
  [moduleId: string]: ChunkModule;
}

export interface Chunk {
  id: string;
  ids: (string | number)[];
  modules: ChunkModules;
}

export interface ModuleTransformations {
  renameModule?: string;
  importAsAbsolute?: boolean;

  renameVariables?: Record<number, string>;
}

export interface ChunkModulesTransformations {
  [moduleId: string]: ModuleTransformations;
}

export async function splitWebpackChunk(
  chunkFilename: string,
  chunkSrc: string,
  {
    esmDefaultExports,
    includeVariableDeclarationComments,
    includeVariableReferenceComments,
    modulesTransformations,
    excludeAbsoluteModules = true,
    graph,
    write,
  }: {
    esmDefaultExports?: boolean;

    includeVariableDeclarationComments?: boolean;
    includeVariableReferenceComments?: boolean;

    modulesTransformations?: ChunkModulesTransformations;
    excludeAbsoluteModules?: boolean;

    graph?: ChunkGraph | null;

    write: false | string;
  },
): Promise<Chunk | null> {
  const chunkId = chunkFilename.match(/(?:^|\/)([^\/]+)\.js$/i)?.[1];

  if (!chunkId) {
    throw new Error(
      `Invalid chunk filename: ${chunkFilename}. Expected format: <chunk-id>.js`,
    );
  }

  const m = chunkSrc.match(
    /(\((self\.webpackChunk(\w*))=\2\|\|\[\]\)\.push\()\[(\[[^\]]+\]),(\{.+\})]\);/s,
  );

  if (!m) {
    return null;
  }

  // TODO: improve RegEx to only allow strings and numbers
  // TODO: figure out the naming for this (chunkId vs chunkIds? what do these even represent?)
  const chunkIds = JSON.parse(m[4]) as (string | number)[];
  const chunkModulesSrc = `(${m[5]}, 0)`;

  const chunkLogger = consola.withTag(chunkId.toString());

  const chunkModulesFilename = write
    ? join(write, `chunk-${chunkId}.js`)
    : null;

  if (write) {
    const chunkModulesSrcFormatted = await format(chunkModulesSrc, {
      parser: "babel",
      filepath: chunkModulesFilename!,
    });

    await Bun.write(chunkModulesFilename!, chunkModulesSrcFormatted);

    chunkLogger.success("Chunk pretty printed and written");
  }

  const ast = parse(chunkModulesSrc);

  const rootObjectExpression = getChunkRootObject(ast);

  if (!rootObjectExpression) {
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

    let rawModuleId: string;
    if (isNumericLiteral(property.key) || isStringLiteral(property.key)) {
      rawModuleId = property.key.value.toString();
    } else if (isIdentifier(property.key)) {
      rawModuleId = property.key.name;
    } else {
      chunkLogger.warn("Invalid chunk module key:", property.key.type);
      continue;
    }

    const [moduleId] = resolveModule(
      rawModuleId,
      modulesTransformations?.[rawModuleId],
    );

    const moduleLogger = chunkLogger.withTag(moduleId);

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

    const { isCommonJS, hasDefaultExport } = moduleScanTraversal(
      moduleLogger,
      moduleFile,
      moduleId,
      modulesTransformations,
      graph,
      chunkModuleParams,
    );

    graph?.mergeNode(moduleId);

    chunkModules[moduleId] = {
      file: moduleFile,
      source: "",

      rawModuleId,

      isCommonJS,
      hasDefaultExport,
    };
  }

  for (const [
    moduleId,
    { file: moduleFile, rawModuleId, isCommonJS: moduleIsCommonJS },
  ] of Object.entries(chunkModules)) {
    const moduleLogger = chunkLogger.withTag(moduleId);

    if (
      excludeAbsoluteModules &&
      modulesTransformations?.[rawModuleId]?.importAsAbsolute
    ) {
      moduleLogger.debug("Excluding absolute module");
      continue;
    }

    traverseModule(
      moduleLogger,
      moduleFile,
      modulesTransformations,
      moduleIsCommonJS,
      chunkModules,
      chunkModuleParams,
      esmDefaultExports,
    );

    applyModuleTransformations(
      moduleLogger,
      moduleFile,
      includeVariableDeclarationComments,
      includeVariableReferenceComments,
      modulesTransformations?.[rawModuleId],
    );

    const filename = write ? join(write, `${moduleId}.js`) : undefined;

    const moduleCode = generate(moduleFile, { filename }).code;

    const formattedModuleCode = await format(moduleCode, {
      parser: "babel",
      filepath: filename,

      ...prettierConfig,
    }).catch((error) => {
      moduleLogger.error("Prettier error:", error);
      return moduleCode;
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

  if (excludeAbsoluteModules && modulesTransformations) {
    for (const [moduleId, { rawModuleId }] of Object.entries(chunkModules)) {
      if (modulesTransformations[rawModuleId]?.importAsAbsolute) {
        delete chunkModules[moduleId];
      }
    }
  }

  chunkLogger.success("Chunk split completed");

  return {
    id: chunkId,
    ids: chunkIds,
    modules: chunkModules,
  };
}
