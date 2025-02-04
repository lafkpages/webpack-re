import { MultiDirectedGraph } from "graphology";
import Sigma from "sigma";

const graph = new MultiDirectedGraph();

graph.import(JSON.parse(document.getElementById("graph-data").textContent));

const sigma = new Sigma(graph, document.getElementById("container"));

window.graph = graph;
window.sigma = sigma;
