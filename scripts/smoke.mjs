#!/usr/bin/env node
// Smoke-test the COMMITTED conv-state injection bin end-to-end against a fake
// /mcp. Proves the distributable artifact actually runs (UserPromptSubmit →
// conv_state_get → stdout JSON) without needing the monorepo — so CI can run it.
//
// The fake server is in-process and the bin is launched with ASYNC spawn, so the
// event loop stays free to answer the bin's request (a sync spawn would deadlock).
//
// sessions-rethink PR 2 — the session hook dispatch was retired with the session
// surface; only the conv-state injection hook survives, and it gets the only
// smoke check here.

import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function rpc(text) {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } });
}

function fail(message) {
  console.error(`smoke FAILED: ${message}`);
  process.exit(1);
}

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

// inject-conv-state.sh emits the canonical blocks to stdout — the
// `<conversation-state>` block when the Librarian has a conv_state row for
// the calling session_id, AND the `<librarian>` awareness-primer block when
// the server returns a non-empty `primer` (spec 041, injected every turn,
// even with no row). It STAYS SILENT when there's nothing to emit. Stdout is
// forwarded to Claude Code (via hookSpecificOutput.additionalContext), so
// silence keeps the model's context clean.
//
// Since spec 041 A2 the `conv_state_get` response is ALWAYS a JSON object:
// `{ ...row, primer }` with a row, or `{ primer }` with no row.
async function injectConvStateSmoke() {
  const injectScript = path.join(root, "scripts", "inject-conv-state.sh");
  const baseEvent = (sessionId) =>
    JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      cwd: "/smoke",
      prompt: "hello",
    });

  // The canonical `<librarian>` block bytes (spec 041, byte-identical across
  // every harness): `<librarian>\n{primer}\n</librarian>`, body NOT indented.
  const PRIMER_TEXT = "You have The Librarian: durable, cross-session memory.";
  const EXPECTED_PRIMER_BLOCK = `<librarian>\n${PRIMER_TEXT}\n</librarian>`;

  // Helper: drive the bin against a fake /mcp that returns `responseText` as
  // the conv_state_get result text, with the standard smoke env + event.
  const drive = async (responseText) => {
    const { server, url } = await startServer((name) => {
      if (name !== "conv_state_get") fail(`inject hit unexpected tool ${name}`);
      return responseText;
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
    return r;
  };

  // 1. Row + primer → BOTH blocks in additionalContext.
  {
    const r = await drive(
      JSON.stringify({
        conv_id: "claude:smoke",
        harness: "claude-code",
        session_id: "ses_attached",
        off_record: false,
        created_at: "2026-05-27T00:00:00.000Z",
        updated_at: "2026-05-27T00:00:00.000Z",
        primer: PRIMER_TEXT,
      }),
    );
    if (r.status !== 0) fail(`inject exited ${r.status} on the row+primer path\n${r.stderr}`);
    let parsed;
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      fail(`inject stdout was not JSON on the row+primer path: ${r.stdout}`);
    }
    const ctx = parsed.hookSpecificOutput?.additionalContext;
    if (!ctx || !ctx.includes("<conversation-state>")) {
      fail(`inject did not emit the conversation-state block: ${r.stdout}`);
    }
    if (!ctx.includes("conv_id: claude:smoke")) fail(`block missing conv_id`);
    if (!ctx.includes("off_record: false")) fail(`block missing off_record`);
    // The conv-state block is trimmed to conv_id + off_record — retired
    // fields must NOT leak even when the wire row still carries them.
    if (ctx.includes("domain:")) fail(`block leaked retired domain line`);
    if (ctx.includes("session_id:")) fail(`block leaked retired session_id line`);
    // The `<librarian>` primer block is present and byte-identical.
    if (!ctx.includes(EXPECTED_PRIMER_BLOCK)) {
      fail(`inject did not emit the byte-identical <librarian> block: ${JSON.stringify(ctx)}`);
    }
  }

  // 2. NO row + primer → the `<librarian>` block is STILL emitted (the
  //    primer is global; a null row must NOT suppress it). No conv-state
  //    block, since there's no row.
  {
    const r = await drive(JSON.stringify({ primer: PRIMER_TEXT }));
    if (r.status !== 0) fail(`inject exited ${r.status} on the no-row+primer path\n${r.stderr}`);
    let parsed;
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      fail(`inject stdout was not JSON on the no-row+primer path: ${r.stdout}`);
    }
    const ctx = parsed.hookSpecificOutput?.additionalContext;
    if (ctx !== EXPECTED_PRIMER_BLOCK) {
      fail(
        `no-row primer: additionalContext must be EXACTLY the byte-identical ` +
          `<librarian> block (no conv-state block); got: ${JSON.stringify(ctx)}`,
      );
    }
  }

  // 3. NO row + empty primer (disabled) → bin stays silent.
  {
    const r = await drive(JSON.stringify({ primer: "" }));
    if (r.status !== 0) fail(`inject exited ${r.status} on the no-row+empty-primer path\n${r.stderr}`);
    if (r.stdout !== "")
      fail(`inject leaked stdout on the no-row+empty-primer path: ${JSON.stringify(r.stdout)}`);
  }

  // 4. Row + empty primer → ONLY the conv-state block (no `<librarian>`).
  {
    const r = await drive(
      JSON.stringify({
        conv_id: "claude:smoke",
        off_record: true,
        primer: "",
      }),
    );
    if (r.status !== 0) fail(`inject exited ${r.status} on the row+empty-primer path\n${r.stderr}`);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput?.additionalContext;
    if (!ctx || !ctx.includes("<conversation-state>"))
      fail(`row+empty-primer: missing conv-state block: ${r.stdout}`);
    if (ctx.includes("<librarian>"))
      fail(`row+empty-primer: leaked a <librarian> block for an empty primer: ${r.stdout}`);
    if (!ctx.includes("off_record: true")) fail(`row+empty-primer: missing off_record: ${r.stdout}`);
  }

  // 5. conv_state_get hard failure (HTTP 500) → no block, turn proceeds
  //    (fail-soft contract unchanged).
  {
    const server = http.createServer((_req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { code: -32000, message: "boom" } }));
    });
    const url = await new Promise((resolve) =>
      server.listen(0, "127.0.0.1", () =>
        resolve(`http://127.0.0.1:${server.address().port}/mcp`),
      ),
    );
    const r = await run("bash", [injectScript], {
      env: {
        CLAUDE_PLUGIN_ROOT: root,
        LIBRARIAN_MCP_URL: url,
        LIBRARIAN_AGENT_TOKEN: "tok_smoke",
      },
      input: baseEvent("smoke"),
    });
    server.close();
    if (r.status !== 0) fail(`inject exited ${r.status} on the server-error path\n${r.stderr}`);
    if (r.stdout !== "")
      fail(`inject leaked stdout on the server-error path: ${JSON.stringify(r.stdout)}`);
  }

  // 6. Non-UserPromptSubmit events are no-ops.
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
    if (r.stdout !== "")
      fail(`inject leaked stdout on the other-event path: ${JSON.stringify(r.stdout)}`);
  }

  // 7. Misconfig (no token) is silent — the fail-soft contract.
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
    if (r.stdout !== "")
      fail(`inject leaked stdout on the misconfig path: ${JSON.stringify(r.stdout)}`);
  }

  console.log(
    "smoke: inject-conv-state.sh emits the conv-state + byte-identical <librarian> primer " +
      "blocks (primer survives a null row), stays silent on empty-primer / server-error / " +
      "other-event / misconfig ✓",
  );
}

await injectConvStateSmoke();
console.log("smoke passed.");
