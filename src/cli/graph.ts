import { MultiDirectedGraph } from "graphology";
import { circular } from "graphology-layout";
import forceAtlas2 from "graphology-layout-forceatlas2";

export async function buildGraphPage(graph: MultiDirectedGraph) {
  circular.assign(graph);
  forceAtlas2.assign(graph, 500);

  const graphExportData = JSON.stringify(graph.export());

  return await Bun.build({
    entrypoints: ["./src/graph.html"],
    outdir: "re/modules/graph",
    minify: true,
    plugins: [
      {
        name: "inject-graph-data",
        setup({ onLoad }) {
          const rewriter = new HTMLRewriter().on("#graph-data", {
            text(element) {
              if (element.text === "data") {
                element.replace(graphExportData);
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
  const graph = new MultiDirectedGraph();

  graph.import(await Bun.file("re/modules/graph/data.json").json());

  await buildGraphPage(graph);
}
