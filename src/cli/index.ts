import type {
  ChunkGraph,
  ChunkModulesTransformations,
  ModuleTransformations,
} from "..";
import type { GraphData } from "./graph";

import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { program } from "@commander-js/extra-typings";
import consola, { LogLevels } from "consola";
import { DirectedGraph } from "graphology";

import { splitWebpackChunk } from "..";
import { version } from "../../package.json";
import { buildGraphPage, buildGraphSvg, layoutGraph } from "./graph";

consola.wrapConsole();
consola.options.throttle = 0;

program
  .name("webpack-re")
  .version(version)
  .configureOutput({
    writeErr(str) {
      str = str.replace(/^ *\[?error\]?:? *|\n$/g, "");

      if (str.includes("\n")) {
        process.stderr.write(str);
      } else {
        consola.error(str);
      }
    },
    writeOut: consola.log,
  })
  .option("-v, --verbose", "Enable verbose logging", false)
  .hook("preAction", (a, b) => {
    if (a.opts().verbose) {
      consola.level = LogLevels.debug;
    }
  });

program
  .command("split")
  .argument("<outdir>", "Output directory")
  .argument("<files...>", "Webpack chunk files")
  .option("-g, --graph <outdir>", "Build graph data")
  .option("--rm", "Remove the output directory before writing")

  // Split options
  .option("--no-esm-default-exports", "Do not use ESM default exports", true)
  .option("--include-variable-declaration-comments")
  .option("--include-variable-reference-comments")

  .option(
    "-t, --module-transformations <dir>",
    "Directory containing module transformations, with each file named after the module ID",
  )
  .option(
    "--no-exclude-absolute-modules",
    "Do not exclude modules that are marked as absolute imports in module transformations",
    true,
  )

  .action(async (outdir: string, files: string[], options) => {
    outdir = resolve(outdir);

    if (options.rm) {
      await rm(outdir, { recursive: true, force: true });
    }

    // const importedModules = new Set<string>();
    // const declaredModules = new Set<string>();

    const graph: ChunkGraph = new DirectedGraph();

    const moduleTransformations: ChunkModulesTransformations = {};
    if (options.moduleTransformations) {
      const glob = new Bun.Glob("*.md");

      for await (const file of glob.scan({
        cwd: options.moduleTransformations,
        absolute: true,
      })) {
        const moduleId = file.match(/(\d+)\.md$/)?.[1];

        if (!moduleId) {
          consola.warn("Invalid module transformation file:", file);
          continue;
        }

        const rawTransformation = await Bun.file(file).text();
        const transformation: ModuleTransformations = {};

        for (const m of rawTransformation.matchAll(
          /^\s*[-*]\s*([`'"])(\d)\1\s*:\s*\1(\w+)\1\s*?$/gm,
        )) {
          const [, , variableId, renameTo] = m;

          transformation.renameVariables ??= {};
          transformation.renameVariables![parseInt(variableId)] = renameTo;
        }

        for (const m of rawTransformation.matchAll(
          /^(#+)\s*([`'"])?(\w+)\2\s*?$/gm,
        )) {
          const [, header, quote, renameTo] = m;

          if (quote !== "`") {
            consola.warn(
              "Module transformation for",
              moduleId,
              "has wrong or missing quote in header",
            );
          }

          if (header === "##") {
            transformation.importAsAbsolute = true;
          } else if (header !== "#") {
            consola.warn(
              "Module transformation for",
              moduleId,
              "has wrong or missing header type",
            );
            break;
          }

          if (transformation.renameModule) {
            consola.warn(
              "Module transformation for",
              moduleId,
              "has multiple module rename headers",
            );
            break;
          }

          transformation.renameModule = renameTo;
        }

        moduleTransformations[moduleId] = transformation;

        consola.info("Loaded module transformation:", moduleId);
      }
    }

    let chunkCount = 0;

    for (const file of files) {
      const chunkModules = await splitWebpackChunk(
        await Bun.file(file).text(),
        {
          esmDefaultExports: options.esmDefaultExports,
          includeVariableDeclarationComments:
            options.includeVariableDeclarationComments,
          includeVariableReferenceComments:
            options.includeVariableReferenceComments,

          moduleTransformations,
          excludeAbsoluteModules: options.excludeAbsoluteModules,

          write: outdir,
        },
      );

      if (!chunkModules) {
        consola.warn("Invalid chunk:", file);
        continue;
      }

      chunkCount++;

      // for (const moduleId in chunkModules) {
      //   const module = chunkModules[moduleId];

      //   for (const importedModule of module.importedModules) {
      //     importedModules.add(importedModule);
      //   }

      //   declaredModules.add(moduleId);
      // }
    }

    consola.success("Split", chunkCount, "chunks to:", outdir);

    // const undeclaredModules = importedModules.difference(declaredModules);

    // if (undeclaredModules.size) {
    //   consola.warn(
    //     "Some modules were imported but not declared, across all input files:",
    //     undeclaredModules,
    //   );
    // }

    if (graph && options.graph) {
      const graphOutdir = resolve(options.graph);

      const graphData = JSON.stringify({
        graphData: graph.export(),
        chunkCount,
      } satisfies GraphData);
      await Bun.write(join(graphOutdir, "data.json"), graphData);

      layoutGraph(graph);

      await buildGraphPage(graph, chunkCount, graphOutdir);
      await buildGraphSvg(graph, chunkCount, graphOutdir);

      consola.success("Graph data written to:", graphOutdir);
    }
  });

await program.parseAsync();
