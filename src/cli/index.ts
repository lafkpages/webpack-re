import { program } from "@commander-js/extra-typings";
import consola, { LogLevels } from "consola";

import { version } from "../../package.json";
import registerScrapeCommand from "./commands/scrape";
import registerSplitCommand from "./commands/split";

consola.wrapConsole();
consola.options.throttle = 0;

const cli = program
  .name("webpack-re")
  .version(version)
  .configureOutput({
    writeErr(str) {
      str = str.replace(/^ *\[?error\]?:? *|\n$/g, "");

      if (str.includes("\n")) {
        process.stderr.write(str);
      } else {
        consola.error(str);
      }
    },
    writeOut: consola.log,
  })
  .option("-v, --verbose", "Enable verbose logging", false)
  .hook("preAction", (thisCommand) => {
    const globalOpts = thisCommand.opts();

    if (globalOpts.verbose) {
      consola.level = LogLevels.debug;
    }
  });

export type CLI = typeof cli;

registerScrapeCommand(cli);
registerSplitCommand(cli);

await cli.parseAsync();
