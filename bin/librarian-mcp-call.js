#!/usr/bin/env node

// ../the-librarian/integrations/shared/librarian-lifecycle/dist/mcp-client.js
var DEFAULT_TIMEOUT_MS = 15e3;
var DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
var MAX_RPC_MESSAGE_CHARS = 200;
var McpClientError = class extends Error {
  name = "McpClientError";
  kind;
  status;
  constructor(kind, message, extra = {}) {
    super(message);
    this.kind = kind;
    this.status = extra.status;
  }
};
function createMcpClient(config, transport) {
  let url;
  try {
    url = new URL(config.endpoint);
  } catch {
    throw new McpClientError("config", "Librarian endpoint is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new McpClientError("config", `Librarian endpoint must be http(s), got ${url.protocol.replace(/:$/, "") || "(none)"}`);
  }
  if (url.username || url.password) {
    throw new McpClientError("config", "Librarian endpoint must not embed credentials; authenticate with the token instead");
  }
  const endpoint = config.endpoint;
  const safeEndpoint = `${url.protocol}//${url.host}${url.pathname}`;
  const token = config.token;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const send = transport ?? defaultTransport(maxResponseBytes);
  return {
    async callTool(name, args) {
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args }
      });
      const headers = {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`
      };
      let response;
      try {
        response = await send({ url: endpoint, body, headers, timeoutMs });
      } catch (err) {
        if (err instanceof McpClientError)
          throw err;
        if (isTimeoutError(err)) {
          throw new McpClientError("timeout", `${name} timed out after ${timeoutMs}ms`);
        }
        throw new McpClientError("network", `${name} could not reach the Librarian at ${safeEndpoint}`);
      }
      if (response.status !== 200) {
        throw new McpClientError("http", `${name} returned HTTP ${response.status}`, {
          status: response.status
        });
      }
      let payload;
      try {
        payload = JSON.parse(response.body);
      } catch {
        throw new McpClientError("malformed", `${name} returned non-JSON`);
      }
      if (isRecord(payload) && payload.error != null) {
        const rpc = payload.error;
        const code = isRecord(rpc) ? rpc.code : void 0;
        const msg = isRecord(rpc) ? String(rpc.message ?? "").slice(0, MAX_RPC_MESSAGE_CHARS) : "";
        throw new McpClientError("rpc", `${name} failed: ${msg} (code ${String(code)})`);
      }
      const text = extractText(payload);
      if (text === null) {
        throw new McpClientError("malformed", `${name} response had no text content`);
      }
      return text;
    }
  };
}
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function isTimeoutError(err) {
  const name = err?.name;
  const code = err?.code;
  return name === "AbortError" || name === "TimeoutError" || code === "ETIMEDOUT";
}
function extractText(payload) {
  if (!isRecord(payload))
    return null;
  const result = payload.result;
  if (!isRecord(result))
    return null;
  const content = result.content;
  if (!Array.isArray(content) || content.length === 0)
    return null;
  const first = content[0];
  if (!isRecord(first))
    return null;
  return typeof first.text === "string" ? first.text : null;
}
function defaultTransport(maxResponseBytes) {
  return async ({ url, body, headers, timeoutMs }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        body,
        headers,
        // A 3xx must NEVER be followed: fetch would carry the Authorization
        // header to the redirect target and leak the bearer token cross-origin.
        // The Librarian /mcp is a single stateless POST with no legitimate 3xx.
        redirect: "error",
        signal: controller.signal
      });
      return { status: response.status, body: await readCapped(response, maxResponseBytes) };
    } finally {
      clearTimeout(timer);
    }
  };
}
async function readCapped(response, cap) {
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > cap) {
      throw new McpClientError("malformed", "Librarian response exceeded the size cap");
    }
    return buffer.toString("utf8");
  }
  const chunks = [];
  let total = 0;
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done)
      break;
    if (!value)
      continue;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      throw new McpClientError("malformed", "Librarian response exceeded the size cap");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
function firstMatch(text, re) {
  const m = text.match(re);
  return m?.[1] ? m[1].trim() : null;
}
function projectOrNull(value) {
  return value === null || value === "(none)" || value === "no project" ? null : value;
}
function parseSessionFromProse(text) {
  const id = firstMatch(text, /^ID:\s*(.+)$/m);
  const status = firstMatch(text, /^Status:\s*(.+)$/m);
  if (!id || !status)
    return null;
  const title = firstMatch(text, /^Title:\s*(.+)$/m) ?? firstMatch(text, /^Session:\s*(.+)$/m);
  return {
    id,
    status,
    title,
    project_key: projectOrNull(firstMatch(text, /^Project:\s*(.+)$/m)),
    source_ref: firstMatch(text, /^Source:\s*(.+)$/m),
    cwd: firstMatch(text, /^Cwd:\s*(.+)$/m)
  };
}
function parseSessionListFromProse(text) {
  const sessions = [];
  let status = null;
  let title = null;
  let project = null;
  for (const line of text.split("\n")) {
    const head = line.match(/^\d+\.\s*\[([^\]]+)\]\s*(.*)$/);
    if (head) {
      status = head[1].trim();
      const segments = (head[2] ?? "").split(" \u2014 ");
      if (segments.length >= 4) {
        project = projectOrNull(segments[segments.length - 3].trim());
        title = segments.slice(0, segments.length - 3).join(" \u2014 ").trim() || null;
      } else {
        title = segments[0]?.trim() || null;
        project = projectOrNull(segments[1]?.trim() ?? null);
      }
      continue;
    }
    const idLine = line.match(/^\s*id:\s*(\S+)/);
    if (idLine && status) {
      sessions.push({
        id: idLine[1],
        status,
        title,
        project_key: project,
        source_ref: null,
        cwd: null
      });
      status = null;
      title = null;
      project = null;
    }
  }
  return sessions;
}

// ../the-librarian/integrations/shared/librarian-lifecycle/dist/bin/mcp-call.js
function fail(message) {
  process.stderr.write(`${message}
`);
  process.exit(1);
}
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin)
    chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
function firstLine(text) {
  return text.split("\n", 1)[0] ?? text;
}
function ensureFound(text, verb) {
  if (/^No session found/.test(text.trim()))
    fail(`${verb}: ${firstLine(text)}`);
}
function compact(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== void 0)
      out[key] = value;
  }
  return out;
}
async function dispatch(client, verb, args) {
  switch (verb) {
    case "start": {
      const text = await client.callTool("start_session", compact({
        harness: args.harness,
        source_ref: args.sourceRef,
        cwd: args.cwd,
        project_key: args.projectKey,
        start_summary: args.summary,
        title: args.title
      }));
      const session = parseSessionFromProse(text);
      if (!session)
        fail(`start: ${firstLine(text)}`);
      return { session };
    }
    case "list": {
      const text = await client.callTool("list_sessions", compact({
        harness: args.harness,
        source_ref: args.sourceRef,
        cwd: args.cwd,
        project_key: args.projectKey,
        status: args.statuses
      }));
      return { sessions: parseSessionListFromProse(text) };
    }
    case "continue": {
      const text = await client.callTool("continue_session", compact({
        session_id: args.sessionId,
        target_harness: args.harness,
        target_cwd: args.cwd,
        target_source_ref: args.sourceRef,
        attach: true
      }));
      ensureFound(text, "continue");
      return {
        session: {
          id: String(args.sessionId),
          status: "active",
          title: null,
          project_key: null,
          source_ref: null,
          cwd: null
        }
      };
    }
    case "checkpoint": {
      const text = await client.callTool("checkpoint_session", compact({ session_id: args.sessionId, summary: args.summary }));
      ensureFound(text, "checkpoint");
      return { ok: true };
    }
    case "pause": {
      const text = await client.callTool("pause_session", compact({ session_id: args.sessionId, summary: args.summary }));
      ensureFound(text, "pause");
      return { ok: true };
    }
    case "end": {
      const text = await client.callTool("end_session", compact({ session_id: args.sessionId, summary: args.reason }));
      ensureFound(text, "end");
      return { ok: true };
    }
    default:
      fail(`unknown verb: ${verb}`);
  }
}
async function main() {
  const verb = process.argv[2];
  if (!verb)
    fail("usage: mcp-call <verb> (args on stdin)");
  const endpoint = process.env.LIBRARIAN_MCP_URL;
  const token = process.env.LIBRARIAN_AGENT_TOKEN;
  if (!endpoint || !token) {
    fail("LIBRARIAN_MCP_URL and LIBRARIAN_AGENT_TOKEN must be set");
  }
  const timeoutEnv = Number(process.env.LIBRARIAN_TIMEOUT_MS);
  let raw;
  try {
    raw = (await readStdin()).trim();
  } catch {
    fail("could not read stdin");
  }
  let args = {};
  try {
    if (raw)
      args = JSON.parse(raw);
  } catch {
    fail("invalid JSON on stdin");
  }
  let client;
  try {
    client = createMcpClient({
      endpoint,
      token,
      ...Number.isFinite(timeoutEnv) && timeoutEnv > 0 ? { timeoutMs: timeoutEnv } : {}
    });
  } catch (err) {
    fail(err.message);
  }
  try {
    const out = await dispatch(client, verb, args);
    process.stdout.write(JSON.stringify(out));
    process.exit(0);
  } catch (err) {
    fail(err.message);
  }
}
void main().catch((err) => fail(err.message));
