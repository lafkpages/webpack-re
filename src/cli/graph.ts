import type { Attributes } from "graphology-types";

import { join } from "node:path";

import { MultiDirectedGraph } from "graphology";
import { circular } from "graphology-layout";
import forceAtlas2 from "graphology-layout-forceatlas2";
import render from "graphology-svg";
import iwanthue from "iwanthue";

export interface GraphData {
  graphData: ReturnType<MultiDirectedGraph["export"]>;
  chunkCount: number;
}

export function layoutGraph(graph: MultiDirectedGraph) {
  circular.assign(graph);
  forceAtlas2.assign(graph, 500);
}

export async function buildGraphPage(
  graph: MultiDirectedGraph,
  chunkCount: number,
  outdir: string,
) {
  const graphData = JSON.stringify({
    graphData: graph.export(),
    chunkCount,
  } satisfies GraphData);

  return await Bun.build({
    entrypoints: ["./src/cli/graph.html"],
    outdir,
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

export async function buildGraphSvg(
  graph: MultiDirectedGraph,
  chunkCount: number,
  outdir: string,
) {
  const chunks: Record<number, string> = {};
  const chunksPalette = iwanthue(chunkCount);

  await new Promise<void>((resolve, reject) => {
    render(
      graph,
      join(outdir, "graph.svg"),
      {
        nodes: {
          reducer(
            settings: unknown,
            node: string,
            attr: Attributes,
          ): Attributes {
            attr.label = node;
            delete attr.type;

            const chunkId =
              typeof attr.chunkId === "number" ? attr.chunkId : null;

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

            return attr;
          },
        },
      },
      (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      },
    );
  });
}

if (import.meta.main) {
  const outdir = process.argv[2];

  if (!outdir) {
    throw new Error("Missing outdir argument");
  }

  const { graphData, chunkCount } = (await Bun.file(
    join(outdir, "data.json"),
  ).json()) as GraphData;

  const graph = MultiDirectedGraph.from(graphData);

  layoutGraph(graph);

  await buildGraphPage(graph, chunkCount, outdir);
  await buildGraphSvg(graph, chunkCount, outdir);
}
