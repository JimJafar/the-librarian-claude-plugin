#!/usr/bin/env node

// src/bin/conv-state-inject.ts
var TIMEOUT_MS = 2500;
main().catch((err) => {
  process.stderr.write(
    `librarian conv-state inject error: ${err instanceof Error ? err.message : String(err)}
`
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
        additionalContext: block
      }
    })
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
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve(null);
      }
    }, TIMEOUT_MS).unref?.();
  });
}
function deriveConvId(event) {
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
    params: { name, arguments: args }
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
        Authorization: `Bearer ${config.token}`
      },
      body,
      signal: controller.signal
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
function renderConvStateBlock(state) {
  const offRecord = state.off_record ? "true" : "false";
  return [
    "<conversation-state>",
    `  conv_id: ${state.conv_id}`,
    `  off_record: ${offRecord}`,
    "</conversation-state>"
  ].join("\n");
}
