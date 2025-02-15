import type { GraphData } from "./graph";

import { rm } from "node:fs/promises";
import { join } from "node:path";

import { program } from "@commander-js/extra-typings";
import consola from "consola";
import { MultiDirectedGraph } from "graphology";

import { splitWebpackChunk } from "..";
import { version } from "../../package.json";
import { buildGraphPage, buildGraphSvg, layoutGraph } from "./graph";

program.name("webpack-re").version(version);

program
  .command("unbundle")
  .argument("<outdir>", "Output directory")
  .argument("<files...>", "Webpack chunk files")
  .option("-g, --graph", "Build graph data")
  .option("--rm", "Remove the output directory before writing")
  .action(async (outdir: string, files: string[], options) => {
    if (options.rm) {
      await rm(outdir, { recursive: true, force: true });
    }

    const graphOutdir = join(outdir, "graph");

    const importedModules = new Set<number>();
    const declaredModules = new Set<number>();

    const graph = options.graph ? new MultiDirectedGraph() : null;

    let chunkCount = 0;

    for (const file of files) {
      const chunk = await splitWebpackChunk(await Bun.file(file).text(), {
        graph,
        write: outdir,
      });

      if (!chunk) {
        consola.warn("Invalid chunk:", file);
        continue;
      }

      chunkCount++;

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
      consola.warn(
        "Some modules were imported but not declared, across all input files:",
        undeclaredModules,
      );
    }

    if (graph) {
      const graphData = JSON.stringify({
        graphData: graph.export(),
        chunkCount,
      } satisfies GraphData);
      await Bun.write(join(graphOutdir, "data.json"), graphData);

      layoutGraph(graph);

      await buildGraphPage(graph, chunkCount, graphOutdir);
      await buildGraphSvg(graph, chunkCount, graphOutdir);
    }
  });

await program.parseAsync();
