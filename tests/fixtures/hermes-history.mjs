#!/usr/bin/env node

const expected = ["sessions", "export", "--format", "jsonl", "--redact", "-"];
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) process.exit(2);
process.stdout.write(`${JSON.stringify({
  id: "fixture-hermes",
  cwd: process.cwd(),
  started_at: 1_700_000_000,
  messages: [{ id: 1, role: "user", content: "fixture prompt", timestamp: 1_700_000_000 }]
})}\n`);
