// CLI 版本号直接从 package.json 读取，确保和 npm 包版本一致
import { createRequire } from "node:module";

type PackageJson = {
  version?: string;
};

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as PackageJson;

export const cliVersion = pkg.version ?? "0.0.0";
