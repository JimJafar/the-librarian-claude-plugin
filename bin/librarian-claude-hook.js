#!/usr/bin/env node

// src/cli.ts
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
var LibrarianCliError = class extends Error {
  name = "LibrarianCliError";
  kind;
  exitCode;
  stderr;
  constructor(kind, message, extra = {}) {
    super(message);
    this.kind = kind;
    this.exitCode = extra.exitCode ?? void 0;
    this.stderr = extra.stderr;
  }
};
var DEFAULT_TIMEOUT_MS = 15e3;
var MAX_BUFFER = 10 * 1024 * 1024;
function defaultRunner(config) {
  const bin = config.bin ?? process.env.LIBRARIAN_CLI_BIN ?? "the-librarian";
  return (args) => {
    const res = spawnSync(bin, args, {
      encoding: "utf8",
      timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      // Full env passthrough is deliberate: the CLI needs LIBRARIAN_SECRET_KEY
      // and the DB path from the environment. No failure path surfaces env
      // contents — LibrarianCliError carries only stderr/exitCode/verb.
      env: config.env ?? process.env,
      cwd: config.cwd,
      maxBuffer: MAX_BUFFER
    });
    const result = {
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      status: res.status
    };
    if (res.error) result.error = res.error;
    return result;
  };
}
function pushFlag(args, flag, value) {
  if (value !== void 0 && value !== "") args.push(flag, value);
}
function asString(value) {
  return typeof value === "string" ? value : null;
}
function toCliSession(raw, context) {
  if (typeof raw !== "object" || raw === null) {
    throw new LibrarianCliError("parse", `${context}: response had no session`);
  }
  const s = raw;
  if (typeof s.id !== "string" || typeof s.status !== "string") {
    throw new LibrarianCliError("parse", `${context}: session is missing id/status`);
  }
  return {
    id: s.id,
    status: s.status,
    title: asString(s.title),
    project_key: asString(s.project_key),
    source_ref: asString(s.source_ref),
    cwd: asString(s.cwd)
  };
}
function createLibrarianCli(config, deps = {}) {
  const run = deps.run ?? defaultRunner(config);
  const tmpDir = deps.tmpDir ?? os.tmpdir();
  const agentFlags = ["--agent", config.agent];
  function runJson(verb, args) {
    const res = run([...args, "--json"]);
    if (res.error) {
      const code = res.error.code;
      const kind = code === "ETIMEDOUT" ? "timeout" : "spawn";
      const what = kind === "timeout" ? "timed out" : `failed to spawn: ${res.error.message}`;
      throw new LibrarianCliError(kind, `the-librarian ${verb} ${what}`, { stderr: res.stderr });
    }
    if (res.status === null) {
      throw new LibrarianCliError("timeout", `the-librarian ${verb} was killed (signal)`, {
        stderr: res.stderr
      });
    }
    if (res.status !== 0) {
      throw new LibrarianCliError("exit", `the-librarian ${verb} exited ${res.status}`, {
        exitCode: res.status,
        stderr: res.stderr
      });
    }
    try {
      return JSON.parse(res.stdout);
    } catch (err) {
      throw new LibrarianCliError(
        "parse",
        `the-librarian ${verb} returned invalid JSON: ${err.message}`
      );
    }
  }
  function withSummaryFile(summary, fn) {
    const file = path.join(tmpDir, `librarian-summary-${process.pid}-${crypto.randomUUID()}.txt`);
    fs.writeFileSync(file, summary, { mode: 384 });
    fs.chmodSync(file, 384);
    try {
      return fn(file);
    } finally {
      fs.rmSync(file, { force: true });
    }
  }
  return {
    startSession(args) {
      const argv = ["sessions", "start", ...agentFlags, "--harness", args.harness];
      pushFlag(argv, "--source-ref", args.sourceRef);
      pushFlag(argv, "--cwd", args.cwd);
      pushFlag(argv, "--project", args.projectKey);
      pushFlag(argv, "--start-summary", args.summary);
      pushFlag(argv, "--title", args.title);
      const parsed = runJson("start", argv);
      return toCliSession(parsed.session, "start");
    },
    listSessions(args) {
      const argv = ["sessions", "list", ...agentFlags];
      pushFlag(argv, "--harness", args.harness);
      pushFlag(argv, "--source-ref", args.sourceRef);
      pushFlag(argv, "--cwd", args.cwd);
      pushFlag(argv, "--project", args.projectKey);
      for (const status of args.statuses ?? ["active", "paused"]) {
        argv.push("--status", status);
      }
      const parsed = runJson("list", argv);
      const sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
      return sessions.map((s) => toCliSession(s, "list"));
    },
    // The continue payload also carries handover/text/format, but the
    // lifecycle helper only needs the attached session here; callers that
    // want the handover prose use MCP continue_session / the slash command.
    continueSession(sessionId) {
      const parsed = runJson("continue", ["sessions", "continue", sessionId, ...agentFlags]);
      return toCliSession(parsed.session, "continue");
    },
    checkpointSession(sessionId, summary) {
      withSummaryFile(summary, (file) => {
        runJson("checkpoint", [
          "sessions",
          "checkpoint",
          sessionId,
          ...agentFlags,
          "--summary-file",
          file
        ]);
      });
    },
    pauseSession(sessionId, summary) {
      withSummaryFile(summary, (file) => {
        runJson("pause", ["sessions", "pause", sessionId, ...agentFlags, "--summary-file", file]);
      });
    },
    endSession(sessionId, reason) {
      runJson("end", ["sessions", "end", sessionId, ...agentFlags, "--summary", reason]);
    }
  };
}

// src/privacy.ts
var DEFAULT_PRIVATE_MARKERS = [
  "this is a private session",
  "don't remember this",
  "do not remember this",
  "don't save this",
  "do not save this",
  "don't store this",
  "off the record",
  "keep this between us",
  "private from here"
];
var DEFAULT_PUBLIC_MARKERS = [
  "you can remember again",
  "end private mode",
  "back on the record",
  "this can be remembered"
];
var TOGGLE_COMMANDS = ["/lib-toggle-private", "/lib:toggle-private"];
function normalise(text) {
  return text.normalize("NFKC").replace(/[‘’]/g, "'").toLowerCase();
}
var SUBSTANTIVE_MIN_CHARS = 3;
function hasSubstantiveRemainder(normalisedPrompt, normalisedMarker) {
  const idx = normalisedPrompt.indexOf(normalisedMarker);
  const without = idx === -1 ? normalisedPrompt : `${normalisedPrompt.slice(0, idx)} ${normalisedPrompt.slice(idx + normalisedMarker.length)}`;
  const alnum = without.replace(/[^a-z0-9]+/g, "");
  return alnum.length >= SUBSTANTIVE_MIN_CHARS;
}
function firstMatch(normalisedPrompt, markers) {
  return markers.find((marker) => normalisedPrompt.includes(normalise(marker)));
}
function detectPrivacySignal(prompt, markers = {}) {
  const normalised = normalise(prompt);
  const trimmed = normalised.trim();
  if (TOGGLE_COMMANDS.includes(trimmed)) {
    return { signal: "toggle", matched: trimmed, hasSubstantiveContent: false };
  }
  const privateMarkers = markers.privateMarkers ?? DEFAULT_PRIVATE_MARKERS;
  const enter = firstMatch(normalised, privateMarkers);
  if (enter !== void 0) {
    return {
      signal: "enter-private",
      matched: enter,
      hasSubstantiveContent: hasSubstantiveRemainder(normalised, normalise(enter))
    };
  }
  const publicMarkers = markers.publicMarkers ?? DEFAULT_PUBLIC_MARKERS;
  const exit = firstMatch(normalised, publicMarkers);
  if (exit !== void 0) {
    return {
      signal: "exit-private",
      matched: exit,
      hasSubstantiveContent: hasSubstantiveRemainder(normalised, normalise(exit))
    };
  }
  return { signal: "none", hasSubstantiveContent: false };
}

// src/state.ts
import crypto2 from "node:crypto";
import fs2 from "node:fs";
import os2 from "node:os";
import path2 from "node:path";
var HARNESSES = ["claude-code", "codex", "hermes", "opencode", "pi"];
var STATE_VERSION = 1;
var StateIoError = class extends Error {
  name = "StateIoError";
};
var StateLockError = class extends Error {
  name = "StateLockError";
};
var DIR_MODE = 448;
var FILE_MODE = 384;
var DEFAULT_LOCK_TIMEOUT_MS = 5e3;
var DEFAULT_LOCK_STALE_MS = 3e4;
var LOCK_RETRY_MS = 50;
function defaultStateBaseDir() {
  return path2.join(os2.homedir(), ".librarian", "harness-state");
}
function baseDirOf(opts) {
  return opts.baseDir ?? defaultStateBaseDir();
}
function locationHash(loc) {
  const parts = [loc.harnessSessionKey, loc.cwd ?? "", loc.sourceRef ?? "", loc.projectKey ?? ""];
  return crypto2.createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 40);
}
function stateFilePath(loc, opts = {}) {
  return path2.join(baseDirOf(opts), loc.harness, `${locationHash(loc)}.json`);
}
function locationOf(state) {
  const loc = {
    harness: state.harness,
    harnessSessionKey: state.harness_session_key
  };
  if (state.source_ref !== void 0) loc.sourceRef = state.source_ref;
  if (state.cwd !== void 0) loc.cwd = state.cwd;
  if (state.project_key !== void 0) loc.projectKey = state.project_key;
  return loc;
}
function ensureDir(dir) {
  fs2.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  fs2.chmodSync(dir, DIR_MODE);
}
function optionalString(v) {
  return v === void 0 || typeof v === "string";
}
function isState(value) {
  if (typeof value !== "object" || value === null) return false;
  const v = value;
  return v.version === STATE_VERSION && typeof v.harness === "string" && HARNESSES.includes(v.harness) && typeof v.harness_session_key === "string" && (v.privacy === "public" || v.privacy === "private") && // Optional fields, when present, must be strings — a malformed one
  // fails closed rather than loading partially-typed state.
  optionalString(v.source_ref) && optionalString(v.cwd) && optionalString(v.project_key) && optionalString(v.librarian_session_id) && optionalString(v.entered_private_at) && optionalString(v.last_activity_at) && optionalString(v.last_checkpoint_at);
}
function loadState(loc, opts = {}) {
  const file = stateFilePath(loc, opts);
  let raw;
  try {
    raw = fs2.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw new StateIoError(`cannot read harness state at ${file}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new StateIoError(`harness state at ${file} is not valid JSON: ${err.message}`);
  }
  if (!isState(parsed)) {
    throw new StateIoError(`harness state at ${file} is structurally invalid`);
  }
  return parsed;
}
function saveState(state, opts = {}) {
  const file = stateFilePath(locationOf(state), opts);
  const dir = path2.dirname(file);
  const tmp = path2.join(dir, `.${path2.basename(file)}.${process.pid}.${crypto2.randomUUID()}.tmp`);
  try {
    ensureDir(dir);
    const fd = fs2.openSync(tmp, "wx", FILE_MODE);
    try {
      fs2.writeFileSync(fd, JSON.stringify(state, null, 2));
    } finally {
      fs2.closeSync(fd);
    }
    fs2.chmodSync(tmp, FILE_MODE);
    fs2.renameSync(tmp, file);
  } catch (err) {
    try {
      fs2.rmSync(tmp, { force: true });
    } catch {
    }
    throw new StateIoError(`cannot write harness state at ${file}: ${err.message}`);
  }
}
function sleepMs(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function lockAge(lockPath) {
  try {
    return Date.now() - fs2.statSync(lockPath).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
function reclaimStaleLock(lockPath) {
  const claim = `${lockPath}.reclaim.${process.pid}.${crypto2.randomUUID()}`;
  try {
    fs2.renameSync(lockPath, claim);
    fs2.rmSync(claim, { force: true });
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw new StateIoError(`cannot reclaim stale lock ${lockPath}: ${err.message}`);
  }
}
function acquireLock(lockPath, opts) {
  const timeoutMs = opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = opts.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
  const deadline = Date.now() + timeoutMs;
  const token = `${process.pid}:${crypto2.randomUUID()}`;
  ensureDir(path2.dirname(lockPath));
  for (; ; ) {
    try {
      const fd = fs2.openSync(lockPath, "wx", FILE_MODE);
      fs2.writeSync(fd, token);
      fs2.closeSync(fd);
      return token;
    } catch (err) {
      if (err.code !== "EEXIST") {
        throw new StateIoError(`cannot acquire lock ${lockPath}: ${err.message}`);
      }
      if (lockAge(lockPath) > staleMs) {
        reclaimStaleLock(lockPath);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new StateLockError(`lock ${lockPath} is held; gave up after ${timeoutMs}ms`);
      }
      sleepMs(Math.min(LOCK_RETRY_MS, Math.max(0, deadline - Date.now())));
    }
  }
}
function releaseLock(lockPath, token) {
  let current;
  try {
    current = fs2.readFileSync(lockPath, "utf8");
  } catch {
    return;
  }
  if (current === token) {
    fs2.rmSync(lockPath, { force: true });
  }
}
function withStateLock(loc, fn, opts = {}) {
  const lockPath = `${stateFilePath(loc, opts)}.lock`;
  const token = acquireLock(lockPath, opts);
  try {
    return fn();
  } finally {
    releaseLock(lockPath, token);
  }
}
function updateState(loc, mutate, opts = {}) {
  return withStateLock(
    loc,
    () => {
      const next = mutate(loadState(loc, opts));
      saveState(next, opts);
      return next;
    },
    opts
  );
}

// src/session.ts
var PRIVATE_END_REASON = "switching to private mode";
var DEFAULT_PAUSE_SUMMARY = "Session paused (harness exit or idle).";
var DEFAULT_START_SUMMARY = "Session started by the harness lifecycle helper.";
var DEFAULT_LIFECYCLE_CONFIG = {
  enabled: true,
  privacyDetection: true,
  autoStart: true,
  autoResume: true,
  autoPause: true,
  checkpoint: {
    minIntervalMinutes: 30,
    minFilesTouched: 2,
    minToolCalls: 5,
    onCompaction: true,
    onTaskCompleted: true
  },
  idlePauseAfterHours: 6
};
function createLibrarianLifecycle(deps) {
  const { cli, location } = deps;
  const config = {
    ...DEFAULT_LIFECYCLE_CONFIG,
    ...deps.config,
    checkpoint: { ...DEFAULT_LIFECYCLE_CONFIG.checkpoint, ...deps.config?.checkpoint }
  };
  const stateOptions = deps.stateOptions ?? {};
  const now = deps.now ?? Date.now;
  const log = deps.logger ?? (() => {
  });
  const markers = {};
  if (config.privateMarkers) markers.privateMarkers = config.privateMarkers;
  if (config.publicMarkers) markers.publicMarkers = config.publicMarkers;
  function nowIso() {
    return new Date(now()).toISOString();
  }
  function composeState(privacy, fields) {
    const state = {
      version: STATE_VERSION,
      harness: location.harness,
      harness_session_key: location.harnessSessionKey,
      privacy
    };
    if (location.sourceRef !== void 0) state.source_ref = location.sourceRef;
    if (location.cwd !== void 0) state.cwd = location.cwd;
    if (location.projectKey !== void 0) state.project_key = location.projectKey;
    if (fields.librarianSessionId !== void 0)
      state.librarian_session_id = fields.librarianSessionId;
    if (fields.enteredPrivateAt !== void 0) state.entered_private_at = fields.enteredPrivateAt;
    if (fields.lastActivityAt !== void 0) state.last_activity_at = fields.lastActivityAt;
    if (fields.lastCheckpointAt !== void 0) state.last_checkpoint_at = fields.lastCheckpointAt;
    return state;
  }
  function guard(failClosed, cliFallback, body) {
    try {
      return body();
    } catch (err) {
      if (err instanceof StateIoError || err instanceof StateLockError) {
        log({
          level: "error",
          message: "librarian lifecycle: state unavailable, failing closed",
          error: err
        });
        return failClosed;
      }
      if (err instanceof LibrarianCliError) {
        log({ level: "warn", message: `librarian lifecycle: CLI ${err.kind} error`, error: err });
        return cliFallback;
      }
      throw err;
    }
  }
  function resolveSession() {
    if (config.autoResume) {
      const statuses = ["active", "paused"];
      const listArgs = {
        harness: location.harness,
        statuses
      };
      if (location.sourceRef !== void 0) listArgs.sourceRef = location.sourceRef;
      if (location.cwd !== void 0) listArgs.cwd = location.cwd;
      if (location.projectKey !== void 0) listArgs.projectKey = location.projectKey;
      const matches = cli.listSessions(listArgs);
      if (matches.length === 1) {
        return { session: cli.continueSession(matches[0].id), action: "resumed" };
      }
    }
    if (!config.autoStart) return null;
    const startArgs = {
      harness: location.harness,
      summary: DEFAULT_START_SUMMARY
    };
    if (location.sourceRef !== void 0) startArgs.sourceRef = location.sourceRef;
    if (location.cwd !== void 0) startArgs.cwd = location.cwd;
    if (location.projectKey !== void 0) startArgs.projectKey = location.projectKey;
    return { session: cli.startSession(startArgs), action: "started" };
  }
  function ensureSession() {
    let action = "active";
    const next = updateState(
      location,
      (current) => {
        if (current && current.privacy === "private") {
          action = "suppressed-private";
          return current;
        }
        if (current?.librarian_session_id) {
          action = "active";
          return composeState("public", {
            librarianSessionId: current.librarian_session_id,
            lastActivityAt: nowIso(),
            lastCheckpointAt: current.last_checkpoint_at
          });
        }
        const resolved = resolveSession();
        if (!resolved) {
          action = "active";
          return composeState("public", { lastActivityAt: nowIso() });
        }
        action = resolved.action;
        return composeState("public", {
          librarianSessionId: resolved.session.id,
          lastActivityAt: nowIso()
        });
      },
      stateOptions
    );
    const outcome = { action, privacy: next.privacy };
    if (next.librarian_session_id !== void 0) outcome.sessionId = next.librarian_session_id;
    return outcome;
  }
  function endAttached(attachedId) {
    if (!attachedId) return;
    try {
      cli.endSession(attachedId, PRIVATE_END_REASON);
    } catch (err) {
      log({
        level: "error",
        message: `librarian lifecycle: failed to end session ${attachedId} on private transition; it may linger active`,
        error: err
      });
    }
  }
  function enterPrivate(attachedId) {
    let written = false;
    try {
      updateState(
        location,
        () => composeState("private", { enteredPrivateAt: nowIso() }),
        stateOptions
      );
      written = true;
    } catch (err) {
      log({
        level: "error",
        message: "librarian lifecycle: could not persist private mode; attempting end and failing closed",
        error: err
      });
    }
    endAttached(attachedId);
    if (!written) throw new StateIoError("could not persist private mode");
    return { action: "entered-private", privacy: "private" };
  }
  function handleToggle() {
    return guard(
      { action: "suppressed-error", privacy: "private" },
      { action: "error", privacy: "private" },
      () => {
        let goingPrivate = false;
        let attachedId;
        updateState(
          location,
          (current) => {
            if (current && current.privacy === "private") {
              return composeState("public", { lastCheckpointAt: current.last_checkpoint_at });
            }
            goingPrivate = true;
            attachedId = current?.librarian_session_id;
            return composeState("private", { enteredPrivateAt: nowIso() });
          },
          stateOptions
        );
        if (!goingPrivate) return { action: "toggled-public", privacy: "public" };
        endAttached(attachedId);
        return { action: "entered-private", privacy: "private" };
      }
    );
  }
  return {
    handlePrompt(prompt) {
      if (!config.enabled) return { action: "disabled", privacy: "public" };
      return guard(
        { action: "suppressed-error", privacy: "private" },
        { action: "error", privacy: "public" },
        () => {
          const state = loadState(location, stateOptions);
          const isPrivate = state?.privacy === "private";
          if (config.privacyDetection) {
            const { signal } = detectPrivacySignal(prompt, markers);
            if (signal === "toggle") return handleToggle();
            if (signal === "enter-private") return enterPrivate(state?.librarian_session_id);
            if (signal === "exit-private") {
              updateState(location, () => composeState("public", {}), stateOptions);
              return { action: "exited-private", privacy: "public" };
            }
          }
          if (isPrivate) return { action: "suppressed-private", privacy: "private" };
          return ensureSession();
        }
      );
    },
    handleCheckpoint(input = {}) {
      if (!config.enabled) return { action: "disabled" };
      return guard({ action: "suppressed-error" }, { action: "error" }, () => {
        const state = loadState(location, stateOptions);
        if (state?.privacy === "private") return { action: "suppressed-private" };
        const sessionId = state?.librarian_session_id;
        if (!sessionId) return { action: "no-session" };
        if (!shouldCheckpoint(input, state, now(), config.checkpoint)) {
          return { action: "skipped-gate", sessionId };
        }
        cli.checkpointSession(sessionId, input.summary ?? DEFAULT_START_SUMMARY);
        updateState(
          location,
          (current) => composeState("public", {
            librarianSessionId: sessionId,
            lastActivityAt: nowIso(),
            lastCheckpointAt: nowIso(),
            enteredPrivateAt: current?.entered_private_at
          }),
          stateOptions
        );
        return { action: "checkpointed", sessionId };
      });
    },
    handlePause(input = {}) {
      if (!config.enabled || !config.autoPause) return { action: "disabled" };
      return guard({ action: "suppressed-error" }, { action: "error" }, () => {
        const state = loadState(location, stateOptions);
        if (state?.privacy === "private") return { action: "suppressed-private" };
        const sessionId = state?.librarian_session_id;
        if (!sessionId) return { action: "no-session" };
        cli.pauseSession(sessionId, input.summary ?? DEFAULT_PAUSE_SUMMARY);
        updateState(
          location,
          (current) => composeState("public", {
            lastActivityAt: nowIso(),
            lastCheckpointAt: current?.last_checkpoint_at
          }),
          stateOptions
        );
        return { action: "paused" };
      });
    },
    handleToggle
  };
}
function shouldCheckpoint(input, state, nowMs, cfg) {
  if (input.trigger === "compaction" && cfg.onCompaction) return true;
  if (input.trigger === "task-completed" && cfg.onTaskCompleted) return true;
  const files = input.filesTouched ?? 0;
  const tools = input.toolCalls ?? 0;
  const hasSummary = typeof input.summary === "string" && input.summary.trim().length > 0;
  const newWork = files > 0 || tools > 0 || hasSummary;
  if (!newWork) return false;
  const countGate = files >= cfg.minFilesTouched || tools >= cfg.minToolCalls;
  const lastMs = state?.last_checkpoint_at ? Date.parse(state.last_checkpoint_at) : NaN;
  const hasPriorCheckpoint = !Number.isNaN(lastMs);
  if (!hasPriorCheckpoint) return countGate || hasSummary;
  const elapsedMin = (nowMs - lastMs) / 6e4;
  const timeGate = elapsedMin >= cfg.minIntervalMinutes;
  return countGate || timeGate || hasSummary && timeGate;
}

// src/remote-cli.ts
import { spawnSync as spawnSync2 } from "node:child_process";
import { fileURLToPath } from "node:url";
var DEFAULT_TIMEOUT_MS2 = 15e3;
var MAX_BUFFER2 = 10 * 1024 * 1024;
var SPAWN_GRACE_MS = 2e3;
function resolveHelperBin(config) {
  return config.mcpCallBin ?? process.env.LIBRARIAN_MCP_CALL_BIN ?? fileURLToPath(new URL("./bin/mcp-call.js", import.meta.url));
}
function defaultRunner2(config) {
  const nodeBin = config.nodeBin ?? process.execPath;
  const helperBin = resolveHelperBin(config);
  const childTimeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS2;
  const baseEnv = config.env ?? process.env;
  const env = baseEnv.LIBRARIAN_TIMEOUT_MS ? baseEnv : { ...baseEnv, LIBRARIAN_TIMEOUT_MS: String(childTimeoutMs) };
  return (verb, input) => {
    const res = spawnSync2(nodeBin, [helperBin, verb], {
      input,
      encoding: "utf8",
      timeout: childTimeoutMs + SPAWN_GRACE_MS,
      // The helper reads LIBRARIAN_MCP_URL / LIBRARIAN_AGENT_TOKEN from this env.
      // No failure path surfaces env contents — LibrarianCliError carries only
      // stderr/exitCode/verb.
      env,
      cwd: config.spawnCwd,
      maxBuffer: MAX_BUFFER2
    });
    const result = {
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      status: res.status
    };
    if (res.error) result.error = res.error;
    return result;
  };
}
function compact(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== void 0) out[key] = value;
  }
  return out;
}
function createRemoteLibrarianCli(config = {}, deps = {}) {
  const run = deps.run ?? defaultRunner2(config);
  function runJson(verb, args) {
    const res = run(verb, JSON.stringify(compact(args)));
    if (res.error) {
      const code = res.error.code;
      const kind = code === "ETIMEDOUT" ? "timeout" : "spawn";
      const what = kind === "timeout" ? "timed out" : `failed to spawn: ${res.error.message}`;
      throw new LibrarianCliError(kind, `librarian-mcp-call ${verb} ${what}`, {
        stderr: res.stderr
      });
    }
    if (res.status === null) {
      throw new LibrarianCliError("timeout", `librarian-mcp-call ${verb} was killed (signal)`, {
        stderr: res.stderr
      });
    }
    if (res.status !== 0) {
      throw new LibrarianCliError("exit", `librarian-mcp-call ${verb} exited ${res.status}`, {
        exitCode: res.status,
        stderr: res.stderr
      });
    }
    try {
      return JSON.parse(res.stdout);
    } catch (err) {
      throw new LibrarianCliError(
        "parse",
        `librarian-mcp-call ${verb} returned invalid JSON: ${err.message}`
      );
    }
  }
  return {
    startSession(args) {
      const parsed = runJson("start", {
        harness: args.harness,
        sourceRef: args.sourceRef,
        cwd: args.cwd,
        projectKey: args.projectKey,
        summary: args.summary,
        title: args.title
      });
      return toCliSession(parsed.session, "start");
    },
    listSessions(args) {
      const statuses = args.statuses ?? ["active", "paused"];
      const parsed = runJson("list", {
        harness: args.harness,
        sourceRef: args.sourceRef,
        cwd: args.cwd,
        projectKey: args.projectKey,
        statuses
      });
      const sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
      return sessions.map((s) => toCliSession(s, "list"));
    },
    continueSession(sessionId) {
      const parsed = runJson("continue", {
        sessionId,
        harness: config.harness,
        cwd: config.cwd,
        sourceRef: config.sourceRef
      });
      return toCliSession(parsed.session, "continue");
    },
    checkpointSession(sessionId, summary) {
      runJson("checkpoint", { sessionId, summary });
    },
    pauseSession(sessionId, summary) {
      runJson("pause", { sessionId, summary });
    },
    endSession(sessionId, reason) {
      runJson("end", { sessionId, reason });
    }
  };
}

// src/transport.ts
function shouldUseRemote(env) {
  return Boolean(env.LIBRARIAN_MCP_URL && env.LIBRARIAN_MCP_URL.trim());
}
function createLibrarianCliForEnv(options) {
  if (shouldUseRemote(options.env)) {
    const config = {
      harness: options.harness,
      env: options.env
    };
    if (options.cwd) config.cwd = options.cwd;
    if (options.sourceRef) config.sourceRef = options.sourceRef;
    return createRemoteLibrarianCli(config);
  }
  return createLibrarianCli({
    agent: options.agent,
    ...options.cwd ? { cwd: options.cwd } : {}
  });
}

// src/harness/claude-code.ts
function claudeLocationFromEvent(event, env) {
  const location = {
    harness: "claude-code",
    // session_id is present on every event that drives a CLI call
    // (UserPromptSubmit/PostCompact/TaskCompleted/SessionEnd); cwd and the
    // final literal are should-never-happen sentinels for degenerate events
    // that never reach the Librarian anyway.
    harnessSessionKey: event.session_id ?? event.cwd ?? "claude-code"
  };
  if (event.cwd) location.cwd = event.cwd;
  if (env.LIBRARIAN_PROJECT_KEY) location.projectKey = env.LIBRARIAN_PROJECT_KEY;
  return location;
}
function dispatchClaudeHook(event, lifecycle) {
  switch (event.hook_event_name) {
    case "UserPromptSubmit":
      return lifecycle.handlePrompt(event.prompt ?? "");
    case "PostCompact":
      return lifecycle.handleCheckpoint({ trigger: "compaction" });
    case "TaskCompleted":
      return lifecycle.handleCheckpoint({ trigger: "task-completed" });
    case "SessionEnd":
      return lifecycle.handlePause();
    default:
      return { action: "ignored" };
  }
}
function createClaudeCodeLifecycle(event, options = {}) {
  const env = options.env ?? process.env;
  const location = claudeLocationFromEvent(event, env);
  const agent = env.LIBRARIAN_AGENT_ID || "claude-code";
  const cli = options.cli ?? createLibrarianCliForEnv({
    harness: "claude-code",
    agent,
    env,
    ...event.cwd ? { cwd: event.cwd } : {}
  });
  const deps = { cli, location };
  if (options.config) deps.config = options.config;
  if (options.logger) deps.logger = options.logger;
  if (options.now) deps.now = options.now;
  return createLibrarianLifecycle(deps);
}

// src/bin/claude-code-hook.ts
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
async function main() {
  let event = {};
  try {
    const raw = (await readStdin()).trim();
    if (raw) event = JSON.parse(raw);
  } catch {
    process.exit(0);
  }
  try {
    const lifecycle = createClaudeCodeLifecycle(event);
    dispatchClaudeHook(event, lifecycle);
  } catch (err) {
    process.stderr.write(`librarian lifecycle hook error: ${err.message}
`);
  }
  process.exit(0);
}
void main();
