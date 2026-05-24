#!/usr/bin/env node
// Smoke-test the COMMITTED bundled mcp-call bin end-to-end against a fake /mcp.
// Proves the distributable artifact actually runs (verb → tools/call → prose →
// stdout JSON) without needing the monorepo — so CI can run it.
//
// The fake server is in-process and the bin is launched with ASYNC spawn, so the
// event loop stays free to answer the bin's request (a sync spawn would deadlock).

import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bin = path.join(root, "bin", "librarian-mcp-call.js");

function rpc(text) {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } });
}

function fail(message) {
  console.error(`smoke FAILED: ${message}`);
  process.exit(1);
}

let sawAuth;
const server = http.createServer((req, res) => {
  sawAuth = req.headers.authorization;
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(rpc("Session started.\nID: ses_smoke\nStatus: active"));
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/mcp`;

const result = await new Promise((resolve) => {
  const child = spawn(process.execPath, [bin, "start"], {
    env: { ...process.env, LIBRARIAN_MCP_URL: url, LIBRARIAN_AGENT_TOKEN: "tok_smoke" },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  child.on("close", (status) => resolve({ status, stdout, stderr }));
  child.stdin.write(JSON.stringify({ harness: "claude-code", cwd: "/smoke", summary: "smoke" }));
  child.stdin.end();
});

server.close();

if (result.status !== 0) fail(`bin exited ${result.status}\n${result.stderr}`);
if (sawAuth !== "Bearer tok_smoke") fail(`bearer token not forwarded (got ${sawAuth})`);

let parsed;
try {
  parsed = JSON.parse(result.stdout);
} catch {
  fail(`stdout was not JSON: ${result.stdout}`);
}
if (parsed.session?.id !== "ses_smoke") fail(`unexpected session in ${result.stdout}`);

console.log("smoke passed: bundled mcp-call bin reached the endpoint and returned the session.");
