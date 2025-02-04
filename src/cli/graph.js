import { MultiDirectedGraph } from "graphology";
import Sigma from "sigma";

const graph = MultiDirectedGraph.from(
  JSON.parse(document.getElementById("graph-data").textContent),
);

graph.forEachNode((node, attr) => {
  attr.label = node;
  attr.size = Math.sqrt(graph.outDegree(node) + 1);
});

graph.forEachEdge((edge, attr) => {
  attr.type = "arrow";
});

const sigma = new Sigma(graph, document.getElementById("container"));

window.graph = graph;
window.sigma = sigma;
