// Claude Code lifecycle entry — restored in-tree from main-repo SHA
// 50ba5192a1b83bbeadcf89f42e38f034335812e1 (pre-PR-#153, when the shared
// @librarian/lifecycle package was deleted from the main repo).
//
// This plugin only ships the Claude Code harness adapter — the codex
// re-exports from the original shared package are intentionally omitted.

export * from "./cli.js";
export * from "./harness/claude-code.js";
export * from "./mcp-client.js";
export * from "./privacy.js";
export * from "./remote-cli.js";
export * from "./session.js";
export * from "./state.js";
export * from "./transport.js";
