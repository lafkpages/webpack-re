export async function buildGraphPage(graphExportData: string) {
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
  const graphExportData = await Bun.file("re/modules/graph/data.json").text();
  await buildGraphPage(graphExportData);
}
