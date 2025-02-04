import { MultiDirectedGraph } from "graphology";
import { circular } from "graphology-layout";
import forceAtlas2 from "graphology-layout-forceatlas2";
import Sigma from "sigma";

const graph = new MultiDirectedGraph();

graph.import(JSON.parse(document.getElementById("graph-data").textContent));

circular.assign(graph);
forceAtlas2.assign(graph, 50);

const sigma = new Sigma(graph, document.getElementById("container"));
