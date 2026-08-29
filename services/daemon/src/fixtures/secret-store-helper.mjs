#!/usr/bin/env node
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [command, account] = process.argv.slice(2);
const root = process.env.EXARCH_TEST_SECRET_DIR;
if (!root || !account) process.exit(64);
const path = join(root, account);
if (command === "put") await writeFile(path, await readStdin(), { mode: 0o600 });
else if (command === "get") {
  if (process.env.EXARCH_TEST_SECRET_FAIL_READ === "1") process.exit(1);
  process.stdout.write(await readFile(path));
}
else if (command === "delete") await unlink(path);
else process.exit(64);

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}
