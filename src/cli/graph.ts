import { MultiDirectedGraph } from "graphology";
import { circular } from "graphology-layout";
import forceAtlas2 from "graphology-layout-forceatlas2";

export interface GraphData {
  graphData: ReturnType<MultiDirectedGraph["export"]>;
  chunkCount: number;
}

export async function buildGraphPage(
  graph: MultiDirectedGraph,
  chunkCount: number,
) {
  circular.assign(graph);
  forceAtlas2.assign(graph, 500);

  const graphData = JSON.stringify({
    graphData: graph.export(),
    chunkCount,
  } satisfies GraphData);

  return await Bun.build({
    entrypoints: ["./src/cli/graph.html"],
    outdir: "re/modules/graph",
    minify: true,
    plugins: [
      {
        name: "inject-graph-data",
        setup({ onLoad }) {
          const rewriter = new HTMLRewriter().on("#graph-data", {
            text(element) {
              if (element.text === "data") {
                element.replace(graphData);
              }
            },
          });

          onLoad({ filter: /graph\.html$/ }, async (args) => {
            const html = await Bun.file(args.path).text();

            return {
              contents: rewriter.transform(html),
              loader: "html",
            };
          });
        },
      },
    ],
  });
}

if (import.meta.main) {
  const { graphData, chunkCount } = (await Bun.file(
    "re/modules/graph/data.json",
  ).json()) as GraphData;

  const graph = MultiDirectedGraph.from(graphData);

  await buildGraphPage(graph, chunkCount);
}
