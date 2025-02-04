// @ts-check

import { MultiDirectedGraph } from "graphology";
import iwanthue from "iwanthue";
import Sigma from "sigma";

const graphDataElm = document.getElementById("graph-data");

/**
 * @type {import('./graph').GraphData}
 */
const { graphData, chunkCount } = JSON.parse(graphDataElm?.textContent || "");

const container = document.getElementById("container");

if (!container) {
  throw new Error("Container not found");
}

const graph = MultiDirectedGraph.from(graphData);

/**
 * @type {Record<number, string>}
 */
const chunks = {};
const chunksPalette = iwanthue(chunkCount);

graph.forEachNode((node, attr) => {
  attr.label = node;

  /**
   * @type {number|null}
   */
  const chunkId = typeof attr.chunkId === "number" ? attr.chunkId : null;

  if (chunkId !== null) {
    if (!chunks[chunkId]) {
      const color = chunksPalette.pop();

      if (!color) {
        throw new Error("Palette exhausted");
      }

      chunks[chunkId] = color;
    }

    attr.color = chunks[chunkId];

    attr.label += ` (${chunkId})`;
  }

  attr.size = Math.sqrt(graph.outDegree(node) + 1);
});

graph.forEachEdge((edge, attr) => {
  attr.type = "arrow";
});

const sigma = new Sigma(graph, container);

// @ts-expect-error
window.graph = graph;
// @ts-expect-error
window.sigma = sigma;
