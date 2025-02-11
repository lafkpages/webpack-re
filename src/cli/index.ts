import type { GraphData } from "./graph";

import { MultiDirectedGraph } from "graphology";

import { splitFusionChunk } from "..";
import { buildGraphPage, buildGraphSvg } from "./graph";

if (!import.meta.main) {
  throw new Error("CLI should not be imported as a module");
}

const importedModules = new Set<number>();
const declaredModules = new Set<number>();

const graph = new MultiDirectedGraph();

let chunkCount = 0;

for (const arg of process.argv.slice(2)) {
  const chunk = await splitFusionChunk(await Bun.file(arg).text(), {
    graph,
    write: "re/modules",
  });

  if (!chunk) {
    console.warn("Invalid chunk:", arg);
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
  console.warn(
    "Some modules were imported but not declared, across all input files:",
    undeclaredModules,
  );
}

const graphData = JSON.stringify({
  graphData: graph.export(),
  chunkCount,
} satisfies GraphData);
await Bun.write("re/modules/graph/data.json", graphData);

await buildGraphPage(graph, chunkCount);
await buildGraphSvg(graph);
