import { MultiDirectedGraph } from "graphology";

import { splitFusionChunk } from ".";

if (!import.meta.main) {
  throw new Error("CLI should not be imported as a module");
}

const importedModules = new Set<number>();
const declaredModules = new Set<number>();

const graph = new MultiDirectedGraph();

for (const arg of process.argv.slice(2)) {
  const chunk = await splitFusionChunk(await Bun.file(arg).text(), {
    graph,
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

await Bun.write("re/modules/graph.json", JSON.stringify(graph.export()));
