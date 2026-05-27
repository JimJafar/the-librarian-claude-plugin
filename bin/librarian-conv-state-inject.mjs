#!/usr/bin/env node
// Conv-state injection hook for memory-domain-isolation §4.9.
//
// Wired as a SECOND UserPromptSubmit hook entry in hooks.json so it runs
// independently of the existing lifecycle bundle (which retains its
// always-silent contract). Reads the hook event JSON from stdin, asks
// the Librarian for the calling conv_state, and — if a row exists —
// emits the canonical `<conversation-state>` block to stdout wrapped in
// Claude Code's `hookSpecificOutput.additionalContext` envelope.
//
// Self-contained: a tiny HTTP MCP client lives in this file. No
// dependency on the @librarian/lifecycle bundle (which was retired
// from the main repo in PR #153 — the existing committed bundle still
// runs but cannot be regenerated). Implementing the injection here
// avoids a hash-validated bundle edit AND keeps the surface honest
// about what this file does.
//
// Fail-soft contract (AGENTS.md §2): a Librarian / network / parse
// failure must never block the user's turn. Every error path exits 0
// with no stdout. The transcript may see a single-line stderr message
// when the MCP server is unreachable for the first time — that's the
// "real misconfiguration" signal the dispatch.sh comment talks about.

const TIMEOUT_MS = 2500;

main().catch((err) => {
  // Final defensive net. Should never fire — every inner path catches —
  // but a top-level throw must never break the user's prompt.
  process.stderr.write(
    `librarian conv-state inject error: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(0);
});

async function main() {
  const event = await readEvent();
  if (!event || event.hook_event_name !== "UserPromptSubmit") {
    process.exit(0);
  }
  const convId = deriveConvId(event);
  if (!convId) process.exit(0);

  const config = readConfig();
  if (!config) process.exit(0);

  const state = await safeGetState(config, convId);
  if (!state) process.exit(0);

  const block = renderConvStateBlock(state);
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: block,
      },
    }),
  );
  process.exit(0);
}

async function readEvent() {
  return new Promise((resolve) => {
    const chunks = [];
    let resolved = false;
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => {
      if (resolved) return;
      resolved = true;
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(null);
      }
    });
    process.stdin.on("error", () => {
      if (!resolved) {
        resolved = true;
        resolve(null);
      }
    });
    // stdin closed before any data is fine — resolve null
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve(null);
      }
    }, TIMEOUT_MS).unref?.();
  });
}

function deriveConvId(event) {
  // Claude Code's UserPromptSubmit event carries `session_id`. Mirror
  // the prefixing convention from spec §4.8: `claude:<id>`.
  const sessionId = typeof event.session_id === "string" ? event.session_id : "";
  if (!sessionId) return null;
  return `claude:${sessionId}`;
}

function readConfig() {
  const endpoint = process.env.LIBRARIAN_MCP_URL;
  const token = process.env.LIBRARIAN_AGENT_TOKEN;
  if (!endpoint || !token) return null;
  return { endpoint, token };
}

async function safeGetState(config, convId) {
  try {
    return await callTool(config, "conv_state_get", { conv_id: convId });
  } catch {
    return null;
  }
}

async function callTool(config, name, args) {
  const url = new URL(config.endpoint);
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response;
  try {
    response = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${config.token}`,
      },
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) return null;
  const json = await response.json();
  if (!json || typeof json !== "object" || json.error) return null;
  const content = json.result?.content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const text = content[0]?.text;
  if (typeof text !== "string") return null;
  // `conv_state_get` returns either "No conversation state for conv_id …"
  // or a JSON-stringified state row. We only inject for the JSON case.
  if (text.startsWith("No conversation state")) return null;
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "object" && parsed && typeof parsed.conv_id === "string") {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

// Mirrors @librarian/core's renderConvStateBlock — kept byte-identical
// to spec §4.9 so the rendered shape is contractually stable across
// every harness. (A change here must land alongside an identical change
// in core's helper and in every other plugin that injects this block.)
function renderConvStateBlock(state) {
  const sessionId = state.session_id ?? "none";
  const offRecord = state.off_record ? "true" : "false";
  return [
    "<conversation-state>",
    `  conv_id: ${state.conv_id}`,
    `  domain: ${state.domain}`,
    `  session_id: ${sessionId}`,
    `  off_record: ${offRecord}`,
    "</conversation-state>",
  ].join("\n");
}
