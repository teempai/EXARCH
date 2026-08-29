import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const assets = [
  "services/daemon/src/providers/claude-permission-mcp.mjs"
];

for (const asset of assets) {
  const destination = join("dist", asset);
  await mkdir(dirname(destination), { recursive: true });
  await cp(asset, destination);
}
