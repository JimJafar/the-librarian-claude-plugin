#!/usr/bin/env node
// Smoke-test the COMMITTED bundled mcp-call bin end-to-end against a fake /mcp.
// Proves the distributable artifact actually runs (verb → tools/call → prose →
// stdout JSON) without needing the monorepo — so CI can run it.
//
// The fake server is in-process and the bin is launched with ASYNC spawn, so the
// event loop stays free to answer the bin's request (a sync spawn would deadlock).

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const mcpCallBin = path.join(root, "bin", "librarian-mcp-call.js");
const dispatch = path.join(root, "scripts", "dispatch.sh");

function rpc(text) {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } });
}

function fail(message) {
  console.error(`smoke FAILED: ${message}`);
  process.exit(1);
}

// A fake /mcp that returns the prose the lifecycle parses. In-process; callers
// are launched with ASYNC spawn so the event loop stays free to answer (a sync
// spawn would deadlock — the bin's own spawnSync of the helper is its problem,
// in its own process).
function startServer(handler) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const name = JSON.parse(body).params?.name;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(rpc(handler(name, req)));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, url: `http://127.0.0.1:${server.address().port}/mcp` }),
    );
  });
}

function run(command, args, { env, input }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.write(input);
    child.stdin.end();
  });
}

// --- 1. The mcp-call bundle reaches the endpoint and returns a parsed session ---
async function mcpCallSmoke() {
  let sawAuth;
  const { server, url } = await startServer((name, req) => {
    sawAuth = req.headers.authorization;
    return "Session started.\nID: ses_smoke\nStatus: active";
  });
  const r = await run(process.execPath, [mcpCallBin, "start"], {
    env: { LIBRARIAN_MCP_URL: url, LIBRARIAN_AGENT_TOKEN: "tok_smoke" },
    input: JSON.stringify({ harness: "claude-code", cwd: "/smoke", summary: "smoke" }),
  });
  server.close();
  if (r.status !== 0) fail(`mcp-call exited ${r.status}\n${r.stderr}`);
  if (sawAuth !== "Bearer tok_smoke") fail(`bearer token not forwarded (got ${sawAuth})`);
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    fail(`mcp-call stdout was not JSON: ${r.stdout}`);
  }
  if (parsed.session?.id !== "ses_smoke") fail(`unexpected session in ${r.stdout}`);
  console.log("smoke: mcp-call bin reached the endpoint and returned the session ✓");
}

// --- 2. dispatch.sh keeps the privacy/correctness contract: exit 0 + EMPTY
// stdout, on the happy path AND the error path (UserPromptSubmit stdout would be
// injected into the model's context). ---
async function dispatchSmoke() {
  const { server, url } = await startServer((name) =>
    name === "list_sessions" ? "No resumable sessions found." : "Session started.\nID: ses_d\nStatus: active",
  );
  const event = JSON.stringify({
    hook_event_name: "UserPromptSubmit",
    session_id: "smoke",
    cwd: "/smoke",
    prompt: "hello",
  });
  const home = mkdtempSync(path.join(os.tmpdir(), "lib-smoke-home-"));
  try {
    const base = { CLAUDE_PLUGIN_ROOT: root, HOME: home };
    const happy = await run("bash", [dispatch], {
      env: { ...base, LIBRARIAN_MCP_URL: url, LIBRARIAN_AGENT_TOKEN: "tok_smoke" },
      input: event,
    });
    if (happy.status !== 0) fail(`dispatch exited ${happy.status} on the happy path`);
    if (happy.stdout !== "") fail(`dispatch leaked stdout on the happy path: ${JSON.stringify(happy.stdout)}`);

    // Error path: no token. The bin fails soft; dispatch must STILL be exit 0 / no stdout.
    const errorPath = await run("bash", [dispatch], {
      env: { ...base, LIBRARIAN_MCP_URL: url, LIBRARIAN_AGENT_TOKEN: "" },
      input: event,
    });
    if (errorPath.status !== 0) fail(`dispatch exited ${errorPath.status} on the error path`);
    if (errorPath.stdout !== "") fail(`dispatch leaked stdout on the error path: ${JSON.stringify(errorPath.stdout)}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
    server.close();
  }
  console.log("smoke: dispatch.sh exits 0 with empty stdout (happy + error paths) ✓");
}

await mcpCallSmoke();
await dispatchSmoke();
console.log("smoke passed.");
