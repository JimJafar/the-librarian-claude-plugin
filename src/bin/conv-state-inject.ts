#!/usr/bin/env node
// Conv-state injection hook for memory-domain-isolation §4.9.
//
// Wired as a SECOND UserPromptSubmit hook entry in hooks.json so it runs
// independently of the existing lifecycle dispatch (which retains its
// always-silent contract). Reads the hook event JSON from stdin, asks
// the Librarian for the calling conv_state, and emits — to stdout, wrapped
// in Claude Code's `hookSpecificOutput.additionalContext` envelope:
//   - the canonical `<conversation-state>` block when a row exists, and
//   - the canonical `<librarian>` awareness-primer block when the server
//     returns a non-empty `primer` (spec 041 — injected every turn, even
//     when there is no conv-state row, since the primer is global).
// Both blocks come from the SINGLE `conv_state_get` response (additive
// top-level `primer` field, spec 041 A2); there is no second fetch.
//
// Self-contained: a tiny HTTP MCP client lives in this file. No
// dependency on the shared lifecycle modules — implementing the
// injection here keeps the surface honest about what this file does.
//
// Fail-soft contract (AGENTS.md §2): a Librarian / network / parse
// failure must never block the user's turn. Every error path exits 0
// with no stdout. The transcript may see a single-line stderr message
// when the MCP server is unreachable for the first time — that's the
// "real misconfiguration" signal the dispatch.sh comment talks about.

const TIMEOUT_MS = 2500;

interface InjectConfig {
  endpoint: string;
  token: string;
}

interface ConvStateRow {
  conv_id: string;
  off_record?: boolean;
}

// The shape we extract from a successful `conv_state_get` response. `state`
// is the conv-state row when one exists (null otherwise — the primer is
// still emitted); `primer` is the operator-authored awareness note (""
// when disabled). A hard failure (network / parse / JSON-RPC error) is
// signalled by `safeGetState` returning `null`, never this object.
interface InjectResult {
  state: ConvStateRow | null;
  primer: string;
}

main().catch((err: unknown) => {
  // Final defensive net. Should never fire — every inner path catches —
  // but a top-level throw must never break the user's prompt.
  process.stderr.write(
    `librarian conv-state inject error: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(0);
});

async function main(): Promise<void> {
  const event = await readEvent();
  if (!event || event.hook_event_name !== "UserPromptSubmit") {
    process.exit(0);
  }
  const convId = deriveConvId(event);
  if (!convId) process.exit(0);

  const config = readConfig();
  if (!config) process.exit(0);

  const result = await safeGetState(config, convId);
  if (!result) process.exit(0);

  // Render from the single response: the conv-state block when there's a
  // row, AND the awareness-primer block when the primer is non-empty. The
  // primer is decoupled from the row gate — it survives a null row. Order
  // is conv-state then primer (per-conversation context first, then the
  // global awareness floor). No block on either side → stay silent.
  const blocks: string[] = [];
  if (result.state) blocks.push(renderConvStateBlock(result.state));
  const primerBlock = renderAwarenessPrimer(result.primer);
  if (primerBlock) blocks.push(primerBlock);
  if (blocks.length === 0) process.exit(0);

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: blocks.join("\n"),
      },
    }),
  );
  process.exit(0);
}

async function readEvent(): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let resolved = false;
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => {
      if (resolved) return;
      resolved = true;
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
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

function deriveConvId(event: Record<string, unknown>): string | null {
  // Claude Code's UserPromptSubmit event carries `session_id`. Mirror
  // the prefixing convention from spec §4.8: `claude:<id>`.
  const sessionId = typeof event.session_id === "string" ? event.session_id : "";
  if (!sessionId) return null;
  return `claude:${sessionId}`;
}

function readConfig(): InjectConfig | null {
  const endpoint = process.env.LIBRARIAN_MCP_URL;
  const token = process.env.LIBRARIAN_AGENT_TOKEN;
  if (!endpoint || !token) return null;
  return { endpoint, token };
}

async function safeGetState(config: InjectConfig, convId: string): Promise<InjectResult | null> {
  try {
    return await callTool(config, "conv_state_get", { conv_id: convId });
  } catch {
    return null;
  }
}

async function callTool(
  config: InjectConfig,
  name: string,
  args: Record<string, unknown>,
): Promise<InjectResult | null> {
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
  let response: Response;
  try {
    response = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${config.token}`,
      },
      body,
      // AGENTS.md §2: this request carries the Bearer token in the
      // Authorization header. With fetch's default `redirect: "follow"`, a
      // 3xx from the Librarian host would be followed automatically — re-
      // sending the Authorization header to the redirect target and leaking
      // the token cross-origin. `redirect: "error"` makes a 3xx throw instead;
      // the throw is caught by `safeGetState` and degrades fail-soft (no
      // block, turn proceeds), exactly like any other network error.
      redirect: "error",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) return null;
  const json = (await response.json()) as { error?: unknown; result?: { content?: unknown } };
  if (!json || typeof json !== "object" || json.error) return null;
  const content = json.result?.content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const text = (content[0] as { text?: unknown } | undefined)?.text;
  if (typeof text !== "string") return null;
  // Since spec 041 A2, `conv_state_get` ALWAYS returns a JSON object: with
  // a row it's `{ ...row, primer }` (every row field stays top-level), with
  // no row it's `{ primer }` (the old "No conversation state …" text is
  // gone). Parse it once and split out the two pieces:
  //   - the conv-state row (only when `conv_id` is present), and
  //   - the awareness `primer` ("" when disabled / absent).
  // A malformed / non-object payload is a hard failure → null (no block).
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const state: ConvStateRow | null =
    typeof record.conv_id === "string" ? (record as unknown as ConvStateRow) : null;
  const primer = typeof record.primer === "string" ? record.primer : "";
  return { state, primer };
}

// Mirrors @librarian/core's renderConvStateBlock — kept byte-identical
// to spec §4.9 so the rendered 2-line shape (conv_id + off_record) is
// contractually stable across every harness. (A change here must land
// alongside an identical change in core's helper and in every other
// plugin that injects this block.)
function renderConvStateBlock(state: ConvStateRow): string {
  const offRecord = state.off_record ? "true" : "false";
  return [
    "<conversation-state>",
    `  conv_id: ${state.conv_id}`,
    `  off_record: ${offRecord}`,
    "</conversation-state>",
  ].join("\n");
}

// Mirrors @librarian/core's renderAwarenessPrimer (spec 041) — kept
// byte-identical so the awareness primer the model sees is the same on
// every harness. Empty primer → "" (no block); a non-empty primer →
// exactly `<librarian>\n{primer}\n</librarian>`. Unlike the conv-state
// block, the primer body is NOT indented — it's operator prose, emitted
// verbatim. (A change here must land alongside an identical change in
// core's helper and in every other plugin that injects this block.)
function renderAwarenessPrimer(primer: string): string {
  if (!primer) return "";
  return ["<librarian>", primer, "</librarian>"].join("\n");
}
