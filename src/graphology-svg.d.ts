declare module "graphology-svg" {
  import type { NoParamCallback } from "fs";
  import type Graph from "graphology";

  // TODO: settings types
  type Settings = any;

  export default function render(
    graph: Graph,
    outputPath: string,
    callback: NoParamCallback,
  ): void;
  export default function render(
    graph: Graph,
    outputPath: string,
    settings: Settings,
    callback: NoParamCallback,
  ): void;
}
