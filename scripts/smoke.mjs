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

// --- 3. inject-conv-state.sh emits the canonical block to stdout when the
// Librarian has a conv_state row for the calling session_id, and STAYS SILENT
// otherwise. Unlike dispatch, this hook's stdout is forwarded to Claude Code
// (via hookSpecificOutput.additionalContext) — so silence on the no-state
// branch is what keeps the model's context clean. ---
async function injectConvStateSmoke() {
  const injectScript = path.join(root, "scripts", "inject-conv-state.sh");
  const baseEvent = (sessionId) =>
    JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      cwd: "/smoke",
      prompt: "hello",
    });

  // 3a. Conv-state hit → bin emits the additionalContext envelope.
  {
    const { server, url } = await startServer((name) => {
      if (name !== "conv_state_get") fail(`inject hit unexpected tool ${name}`);
      return JSON.stringify({
        conv_id: "claude:smoke",
        harness: "claude-code",
        domain: "coding",
        session_id: "ses_attached",
        off_record: false,
        created_at: "2026-05-27T00:00:00.000Z",
        updated_at: "2026-05-27T00:00:00.000Z",
      });
    });
    const r = await run("bash", [injectScript], {
      env: {
        CLAUDE_PLUGIN_ROOT: root,
        LIBRARIAN_MCP_URL: url,
        LIBRARIAN_AGENT_TOKEN: "tok_smoke",
      },
      input: baseEvent("smoke"),
    });
    server.close();
    if (r.status !== 0) fail(`inject exited ${r.status} on the hit path\n${r.stderr}`);
    let parsed;
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      fail(`inject stdout was not JSON on the hit path: ${r.stdout}`);
    }
    const ctx = parsed.hookSpecificOutput?.additionalContext;
    if (!ctx || !ctx.includes("<conversation-state>")) {
      fail(`inject did not emit the conversation-state block: ${r.stdout}`);
    }
    if (!ctx.includes("conv_id: claude:smoke")) fail(`block missing conv_id`);
    if (!ctx.includes("domain: coding")) fail(`block missing domain`);
    if (!ctx.includes("session_id: ses_attached")) fail(`block missing session_id`);
    if (!ctx.includes("off_record: false")) fail(`block missing off_record`);
  }

  // 3b. No conv_state row → bin stays silent.
  {
    const { server, url } = await startServer(() => "No conversation state for conv_id claude:smoke.");
    const r = await run("bash", [injectScript], {
      env: {
        CLAUDE_PLUGIN_ROOT: root,
        LIBRARIAN_MCP_URL: url,
        LIBRARIAN_AGENT_TOKEN: "tok_smoke",
      },
      input: baseEvent("smoke"),
    });
    server.close();
    if (r.status !== 0) fail(`inject exited ${r.status} on the no-state path\n${r.stderr}`);
    if (r.stdout !== "") fail(`inject leaked stdout on the no-state path: ${JSON.stringify(r.stdout)}`);
  }

  // 3c. Non-UserPromptSubmit events are no-ops.
  {
    const { server } = await startServer(() => {
      fail("inject called MCP on a non-UserPromptSubmit event");
      return "";
    });
    const r = await run("bash", [injectScript], {
      env: {
        CLAUDE_PLUGIN_ROOT: root,
        LIBRARIAN_MCP_URL: "http://127.0.0.1:1",
        LIBRARIAN_AGENT_TOKEN: "tok_smoke",
      },
      input: JSON.stringify({ hook_event_name: "PostCompact", session_id: "smoke" }),
    });
    server.close();
    if (r.status !== 0) fail(`inject exited ${r.status} on the other-event path\n${r.stderr}`);
    if (r.stdout !== "") fail(`inject leaked stdout on the other-event path: ${JSON.stringify(r.stdout)}`);
  }

  // 3d. Misconfig (no token) is silent — the fail-soft contract.
  {
    const r = await run("bash", [injectScript], {
      env: {
        CLAUDE_PLUGIN_ROOT: root,
        LIBRARIAN_MCP_URL: "http://127.0.0.1:1",
        LIBRARIAN_AGENT_TOKEN: "",
      },
      input: baseEvent("smoke"),
    });
    if (r.status !== 0) fail(`inject exited ${r.status} on the misconfig path`);
    if (r.stdout !== "") fail(`inject leaked stdout on the misconfig path: ${JSON.stringify(r.stdout)}`);
  }

  console.log(
    "smoke: inject-conv-state.sh emits additionalContext on hit, stays silent on no-state / other-event / misconfig ✓",
  );
}

await mcpCallSmoke();
await dispatchSmoke();
await injectConvStateSmoke();
console.log("smoke passed.");
