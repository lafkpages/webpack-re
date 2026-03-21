import type { CLI } from "..";

import { rm } from "node:fs/promises";
import { resolve } from "node:path";

import consola from "consola";

export default function registerScrapeCommand<T extends CLI>(program: T) {
  return program
    .command("scrape")
    .argument("<url>", "URL to scrape")
    .argument("<outdir>", "Output directory")
    .option("--rm", "Remove the output directory before writing")
    .option(
      "--matching <pattern>",
      "Only scrape URLs matching the given RegExp pattern",
    )

    .action(async (urlString, outdir, options) => {
      const url = new URL(urlString);
      const regexp = options.matching
        ? new RegExp(options.matching, "i")
        : null;

      outdir = resolve(outdir);

      if (options.rm) {
        await rm(outdir, { recursive: true, force: true });
      }

      const parser = new HTMLRewriter();

      parser.on("script", {
        element(element) {
          const src = element.getAttribute("src");
          if (!src) return;

          const type = element.getAttribute("type");
          if (type && type !== "text/javascript") return;

          const srcUrl = new URL(src, url);
          const matches = regexp ? regexp.test(srcUrl.href) : true;

          consola.debug("Found script:", srcUrl.href, matches);

          if (!matches) return;

          fetch(srcUrl.href).then(async (resp) => {
            const path = resolve(
              outdir,
              srcUrl.hostname,
              srcUrl.pathname.slice(1),
            );

            consola.debug("Saving to:", path);

            await Bun.write(path, resp);
          });
        },
      });

      parser.transform(await fetch(url));
    });
}
