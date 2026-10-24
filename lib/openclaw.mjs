import { readFileSync, mkdirSync, appendFileSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Errors ──────────────────────────────────────────────────────────────────

export class BridgeError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

// A submit whose *response* was lost may still have been accepted by the
// Gateway; an explicit rejection (INVALID_REQUEST, session busy, ...) never
// was. Only the former may be reconciled against the runId we already hold,
// otherwise a rejected task would be reported as a phantom "running" run.
// The wording matched here is the CLI's own: `gateway timeout after <n>ms`
// (dist/call-*.js formatGatewayTimeoutError) plus the transport close kinds.
const LOST_RESPONSE_RE =
  /gateway timeout|timeout after|timed out|ETIMEDOUT|ECONNRESET|EPIPE|socket hang up|gateway closed/i;

export function isLostSubmitResponse(error) {
  if (!(error instanceof BridgeError)) return false;
  // execFile killed the CLI at our own deadline: no response ever arrived.
  if (error.code === "CLI_TIMEOUT") return true;
  const detail = typeof error.details === "string" ? error.details : "";
  return LOST_RESPONSE_RE.test(`${error.code} ${error.message} ${detail}`);
}

// ─── Config ──────────────────────────────────────────────────────────────────

export function loadConfig(configPath = join(__dirname, "..", "config.json")) {
  // `config.json` is per-machine (it names your own agents and aliases) and is
  // git-ignored, so a fresh clone only has `config.example.json`. Fall back to
  // it with a loud stderr note instead of failing: the bridge still starts, and
  // the operator gets a clear signal to copy the example over.
  let resolvedPath = configPath;
  if (!existsSync(resolvedPath)) {
    const examplePath = join(dirname(resolvedPath), "config.example.json");
    if (!existsSync(examplePath)) {
      throw new BridgeError(
        "CONFIG_NOT_FOUND",
        `No config at ${configPath}; copy config.example.json to config.json`,
        null
      );
    }
    resolvedPath = examplePath;
    process.stderr.write(
      "[openclaw-mcp-bridge] config.json not found; using config.example.json (agent names are placeholders)\n"
    );
  }

  const raw = JSON.parse(readFileSync(resolvedPath, "utf8"));

  // Validate defaultAgent in allowedAgents
  if (!raw.allowedAgents?.includes(raw.defaultAgent)) {
    throw new BridgeError(
      "CONFIG_INVALID",
      `defaultAgent "${raw.defaultAgent}" not in allowedAgents`
    );
  }

  // Validate session
  if (!raw.session?.suffix || !/^[a-z0-9_-]+$/i.test(raw.session.suffix)) {
    throw new BridgeError("CONFIG_INVALID", "session.suffix must be alphanumeric");
  }
  if (raw.session.maxKeyLength > 500) {
    throw new BridgeError("CONFIG_INVALID", "session.maxKeyLength too large");
  }

  // Validate rate limit
  if (raw.rateLimit.perMinute > 60 || raw.rateLimit.perHour > 600) {
    throw new BridgeError("CONFIG_INVALID", "rateLimit values too high");
  }

  // Validate voice
  if (raw.voice.maxSpeakChars > 500 || raw.voice.summaryThreshold > 2000) {
    throw new BridgeError("CONFIG_INVALID", "voice values too large");
  }

  return raw;
}

// ─── OpenClaw CLI Client ─────────────────────────────────────────────────────

// `openclaw gateway call --timeout` defaults to 10s (DEFAULT_GATEWAY_RPC_TIMEOUT_MS),
// which is shorter than any wait we ask the Gateway for, so every call passes it
// explicitly. DESIGN.md specifies "agent.wait: 请求秒数 + 5 秒".
const RPC_GRACE_MS = 5000;
// The RPC deadline starts when the CLI sends the request, so the execFile kill
// must also cover Node startup + Gateway handshake (~2.9s measured), otherwise a
// slow call is SIGKILLed and the structured Gateway error is lost with it.
const EXEC_KILL_GRACE_MS = 5000;

export class OpenClawClient {
  constructor(config, options = {}) {
    this.config = config;
    this.nodeBin = process.env.OPENCLAW_NODE_BIN || process.execPath;
    this.bin = process.env.OPENCLAW_BIN || "/opt/homebrew/bin/openclaw";
    this.entry = null; // resolved lazily in exec(): server must start without the CLI
    this.timeoutMs = options.timeoutMs || config.run.cliTimeoutMs;
    this.rpcTimeoutMs = options.rpcTimeoutMs || config.run.rpcTimeoutMs || 15000;
    this.version = null;
    this.versionUnknown = false;
  }

  resolveEntry() {
    try {
      this.entry = realpathSync(this.bin);
    } catch {
      throw new BridgeError("OPENCLAW_NOT_FOUND", `Cannot resolve ${this.bin}`);
    }
    return this.entry;
  }

  async detectVersion() {
    try {
      const result = await this.exec(["--version"]);
      const match = result.match(/OpenClaw\s+(\d{4}\.\d+\.\d+)/);
      if (match) {
        this.version = match[1];
      } else {
        this.versionUnknown = true;
      }
    } catch {
      this.versionUnknown = true;
    }
  }

  exec(args, options = {}) {
    return new Promise((resolve, reject) => {
      let entry;
      try {
        entry = realpathSync(this.bin);
      } catch {
        reject(new BridgeError("OPENCLAW_NOT_FOUND", `Cannot resolve ${this.bin}`));
        return;
      }
      const timeout = options.timeout || this.timeoutMs;
      execFile(
        this.nodeBin,
        [entry, ...args],
        {
          env: process.env,
          timeout,
          maxBuffer: 8 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error) {
            if (error.killed) {
              // Carrying the deadline makes a kill diagnosable; it also means the
              // CLI never got to report a structured Gateway error.
              reject(
                new BridgeError(
                  "CLI_TIMEOUT",
                  `CLI execution timed out after ${timeout}ms`,
                  (stderr || stdout || "").slice(0, 500) || null
                )
              );
            } else if (error.code) {
              // The CLI reports gateway errors as JSON on stdout while stderr
              // stays empty, so fall back to stdout for the diagnostic detail.
              const detail = (stderr || stdout || "").slice(0, 500);
              reject(
                new BridgeError(
                  "CLI_EXIT_NONZERO",
                  `CLI exited with code ${error.code}`,
                  detail
                )
              );
            } else {
              reject(new BridgeError("CLI_ERROR", error.message));
            }
            return;
          }
          resolve(stdout);
        }
      );
    });
  }

  parseJson(stdout) {
    // Find first { or [
    const start = stdout.search(/[\{\[]/);
    if (start === -1) {
      throw new BridgeError("CLI_BAD_OUTPUT", "No JSON found in output", stdout.slice(0, 500));
    }
    try {
      return JSON.parse(stdout.slice(start));
    } catch (error) {
      throw new BridgeError("CLI_BAD_OUTPUT", "Invalid JSON", error.message);
    }
  }

  // RPC deadline for a call that asks the Gateway to wait `serverWaitMs`.
  // Never below the configured floor, so short probes keep the old headroom.
  rpcDeadlineFor(serverWaitMs) {
    return Math.max(this.rpcTimeoutMs, Math.floor(serverWaitMs) + RPC_GRACE_MS);
  }

  async gatewayCall(method, params = {}, options = {}) {
    const rpcTimeoutMs = options.rpcTimeoutMs ?? this.rpcTimeoutMs;
    const args = [
      "gateway",
      "call",
      method,
      "--params",
      JSON.stringify(params),
      "--timeout",
      String(rpcTimeoutMs),
      "--json",
    ];
    const stdout = await this.exec(args, { timeout: rpcTimeoutMs + EXEC_KILL_GRACE_MS });
    const result = this.parseJson(stdout);
    // The Gateway reports request failures as { ok:false, error:{ code,message } }.
    // Surface them as stable BridgeErrors instead of passing the envelope through.
    if (result && result.ok === false && result.error) {
      const e = result.error;
      throw new BridgeError(
        e.code || "GATEWAY_REQUEST_ERROR",
        e.message || "Gateway request failed",
        { type: e.type || null, retryable: e.retryable ?? null }
      );
    }
    return result;
  }

  async health() {
    try {
      const result = await this.gatewayCall("health");
      return result.ok === true;
    } catch {
      return false;
    }
  }

  async listAgents() {
    const stdout = await this.exec(["agents", "list", "--json"]);
    return this.parseJson(stdout);
  }

  async runAgent(agentId, sessionKey, message, idempotencyKey) {
    // The Gateway requires idempotencyKey and adopts it as the runId
    // (dist/agent-*.js: `const runId = idem`), so the caller must supply it.
    if (!idempotencyKey) {
      throw new BridgeError(
        "INVALID_ARGUMENT",
        "idempotencyKey is required by the agent RPC"
      );
    }
    return this.gatewayCall("agent", { agentId, sessionKey, message, idempotencyKey });
  }

  async waitRun(runId, timeoutMs = null) {
    const params = { runId };
    // agent.wait defaults to a 30s server-side wait when timeoutMs is omitted.
    const serverWaitMs = timeoutMs !== null ? timeoutMs : 30000;
    if (timeoutMs !== null) params.timeoutMs = timeoutMs;
    return this.gatewayCall("agent.wait", params, {
      rpcTimeoutMs: this.rpcDeadlineFor(serverWaitMs),
    });
  }

  // Zero-timeout reconcile probe for a run whose submit response was lost,
  // mirroring OpenClaw's own ACP client (agent.wait { runId, timeoutMs: 0 }).
  // True when the Gateway answers for that runId, false when the probe itself
  // fails. Note: agent.wait answers `timeout` for an unknown runId too, so
  // callers must only probe when the submit failure looks like a lost response.
  async probeRun(runId) {
    try {
      const result = await this.waitRun(runId, 0);
      return Boolean(result && (result.runId || result.status));
    } catch {
      return false;
    }
  }

  async history(sessionKey, limit = 10, maxChars = 4000) {
    const result = await this.gatewayCall("chat.history", {
      sessionKey,
      limit,
      maxChars,
    });
    return result;
  }

  async abort(runId) {
    const result = await this.gatewayCall("sessions.abort", { runId });
    return result;
  }

  async chatAbort(sessionKey, runId) {
    const result = await this.gatewayCall("chat.abort", { sessionKey, runId });
    return result;
  }
}

// ─── Agent Normalization ─────────────────────────────────────────────────────

export function normalizeAgents(rawAgents) {
  // Handle different shapes
  let agents = rawAgents;
  if (!Array.isArray(agents)) {
    if (agents.agents && Array.isArray(agents.agents)) {
      agents = agents.agents;
    } else if (agents.agents?.list && Array.isArray(agents.agents.list)) {
      agents = agents.agents.list;
    } else {
      throw new BridgeError("CLI_BAD_OUTPUT", "Unexpected agents shape");
    }
  }

  return agents
    .filter((a) => (a.kind || "agent") !== "system")
    .map((a) => ({
      id: a.id,
      name: a.name,
      identityName: a.identityName ?? a.identity?.name ?? a.name ?? a.id,
      identityEmoji: a.identityEmoji ?? a.identity?.emoji ?? "",
      isDefault: a.isDefault || false,
    }));
}

// ─── Status Normalization ────────────────────────────────────────────────────

export function normalizeWait(waitResult) {
  const { status, stopReason, startedAt, endedAt, error } = waitResult;

  // First check stopReason for cancel class
  const cancelReasons = ["superseded", "aborted", "cancelled", "rpc", "restart"];
  if (stopReason && cancelReasons.includes(stopReason)) {
    return {
      ...waitResult,
      status: "aborted",
      normalized: true,
    };
  }

  // Then check status
  if (["ok", "done", "completed"].includes(status)) {
    return { ...waitResult, status: "done", normalized: true };
  }
  if (status === "pending") {
    return { ...waitResult, status: "running", normalized: true };
  }
  if (status === "timeout") {
    return { ...waitResult, status: "running", timeout: true, normalized: true };
  }
  if (status === "error") {
    return { ...waitResult, status: "error", normalized: true };
  }

  // Unknown
  return { ...waitResult, status: "running", normalized: true };
}

// ─── Reply Extraction ────────────────────────────────────────────────────────

export function extractReply(historyResult, startedAt) {
  const messages = historyResult.messages || [];
  if (messages.length === 0) return { reply: null, replyTruncated: false };

  // Filter to current run only
  const currentMessages = startedAt
    ? messages.filter((m) => (m.timestamp || 0) >= startedAt)
    : messages;

  // Find last assistant with text content
  for (let i = currentMessages.length - 1; i >= 0; i--) {
    const msg = currentMessages[i];
    if (msg.role !== "assistant") continue;

    // Skip toolResult
    if (msg.content?.some((c) => c.type === "toolResult")) continue;

    // Skip if only toolCall
    if (msg.content?.every((c) => c.type === "toolCall")) continue;

    // Extract text
    const textParts = msg.content?.filter((c) => c.type === "text") || [];
    if (textParts.length === 0) continue;

    const text = textParts.map((t) => t.text).join("\n");

    // If text is empty, continue to next message
    if (!text || text.trim().length === 0) continue;

    // Check truncation
    let replyTruncated = false;
    if (text.endsWith("\n...(truncated)...")) {
      replyTruncated = true;
    }
    if (msg.__openclaw?.truncated === true) {
      replyTruncated = true;
    }

    return { reply: text, replyTruncated };
  }

  return { reply: null, replyTruncated: false };
}

// ─── Voice Builder ───────────────────────────────────────────────────────────

export function buildVoice(reply, status, config, options = {}) {
  const { maxSpeakChars = 150, summaryThreshold = 400 } = config.voice || {};
  const { replyTruncated = false, replyUnavailable = false } = options;

  try {
    // Status-based voices
    if (status === "running") {
      return {
        speak: "还在跑，稍等一下。",
        kind: "status",
        needsSummary: false,
        textLength: 0,
      };
    }
    if (status === "aborted") {
      return {
        speak: "任务已取消。",
        kind: "status",
        needsSummary: false,
        textLength: 0,
      };
    }
    if (status === "error") {
      return {
        speak: "出错了，请查看会话详情。",
        kind: "error",
        needsSummary: false,
        textLength: 0,
      };
    }

    // Done with no reply
    if (reply === null || reply === undefined) {
      if (replyUnavailable) {
        return {
          speak: "没取到回复，完整内容在会话里。",
          kind: "status",
          needsSummary: true,
          textLength: 0,
        };
      }
      return {
        speak: "没有文字回复。",
        kind: "empty",
        needsSummary: false,
        textLength: 0,
      };
    }

    // Classify content
    const kind = classifyContent(reply);
    const textLength = reply.length;

    // Extract first sentence for speak
    let speak = extractFirstSentence(reply, maxSpeakChars);

    // Check for sensitive patterns in the FULL reply text, not just speak
    const sensitivePatterns = [/sk-[a-zA-Z0-9]{20,}/, /Bearer\s+[a-zA-Z0-9\-._~+\/]+=*/, /token=[a-zA-Z0-9]{20,}/, /[a-f0-9]{32,}/i];
    const hasSensitive = sensitivePatterns.some((p) => p.test(reply));
    if (hasSensitive) {
      speak = "结果里可能含敏感信息，完整内容在会话里。";
    }

    // Determine needsSummary
    let needsSummary = false;
    if (kind !== "text") needsSummary = true;
    if (textLength > summaryThreshold) needsSummary = true;
    if (replyTruncated) needsSummary = true;
    if (hasSensitive) needsSummary = true;

    // Truncated hint
    if (replyTruncated && !hasSensitive) {
      speak += " 完整内容在会话里。";
      speak = speak.slice(0, maxSpeakChars);
    }

    return {
      speak: speak.slice(0, maxSpeakChars),
      kind,
      needsSummary,
      textLength,
    };
  } catch (error) {
    // Voice generation failed - return null, don't throw
    return null;
  }
}

function classifyContent(text) {
  const lines = text.split("\n").filter((l) => !l.trim().startsWith("```")); // Exclude fence lines
  const totalLines = lines.length;

  if (totalLines === 0) return "text";

  // Count different types
  const codeFenceCount = (text.match(/```/g) || []).length;
  const codeLines = lines.filter((l) => l.trim().match(/^(const|let|var|function|class|import|export|return|if|for|while|{|}|\(|\)|\[|\])/)).length;

  const logLines = lines.filter((l) => l.trim().match(/^\[(\d{4}-\d{2}-\d{2}|INFO|WARN|ERROR|DEBUG)/)).length;
  const listLines = lines.filter((l) => l.trim().match(/^[\-\*]\s+/)).length;

  // Classification priority
  if (codeFenceCount >= 2 && codeLines > totalLines * 0.3) return "code";
  if (codeFenceCount >= 2 && codeLines <= totalLines * 0.3) return "mixed";

  // List BEFORE diff: "- item" is ambiguous between markdown bullets and diff
  // deletions; when bullet-style lines dominate the text, treat it as a list.
  if (listLines >= 3 && listLines > totalLines * 0.5) return "list";

  // Diff requires clear headers (+++/---/@@) and counts only +/- lines that
  // are NOT list-style bullets. No headers -> not a diff (avoid false
  // positives on plain lists and prose starting with "- ").
  const hasDiffHeaders = lines.some((l) => l.trim().match(/^(\+\+\+|---|@@)/));
  const diffLines = lines.filter((l) => {
    const trimmed = l.trim();
    if (/^[\-\*]\s+/.test(trimmed)) return false; // bullet item, not a diff deletion
    return trimmed.match(/^(\+\+\+|---|@@|\+[^+]|-[^-])/);
  }).length;
  if (hasDiffHeaders && diffLines >= 2) return "diff";

  if (logLines >= 3 && logLines > totalLines * 0.5) return "log";
  return "text";
}

function extractFirstSentence(text, maxChars) {
  // Strip markdown, code fences, inline code, URLs, XML tags, file paths, JSON
  let cleaned = text
    .replace(/```[\s\S]*?```/g, "") // code blocks
    .replace(/`[^`]+`/g, "") // inline code
    .replace(/https?:\/\/[^\s)]+/g, "") // URLs
    .replace(/<[^>]+>/g, "") // XML tags
    .replace(/\/[\w\/\-\.]+/g, "") // file paths
    .replace(/\{[^}]+\}/g, "") // JSON-like
    .replace(/^#+\s+/gm, "") // headers
    .replace(/^\s*[\-\*\d+\.]\s+/gm, "") // list markers
    .trim();

  // Find first sentence ending
  const match = cleaned.match(/[^。！？!?]*[。！？!?]/);
  let first = match ? match[0].trim() : cleaned.split(/[。！？!?]/)[0]?.trim();

  if (!first || first.length === 0) {
    return "已完成。";
  }

  if (first.length > maxChars) {
    return first.slice(0, maxChars - 1) + "…";
  }

  return first;
}

// ─── Agent Resolution ────────────────────────────────────────────────────────

export function resolveAgent(input, agents, config) {
  const normalized = normalizeAgentInput(input);

  // Empty input -> default
  if (!normalized) {
    if (config.disabledAgents?.includes(config.defaultAgent)) {
      throw new BridgeError("AGENT_DISABLED", `Default agent "${config.defaultAgent}" is disabled`);
    }
    return config.defaultAgent;
  }

  // Normalize agent fields for comparison (use same logic as normalizeAgentInput)
  const normalizeField = (field) => {
    if (!field) return "";
    return field
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase()
      .replace(/（/g, "(")
      .replace(/）/g, ")")
      .replace(/\s*\(\s*/g, "(")
      .replace(/\s*\)\s*/g, ")");
  };

  // Resolve input to an agentId first (id / name / identityName / prefix / alias)
  let agentId = null;

  const byId = agents.find((a) => normalizeField(a.id) === normalized);
  if (byId) agentId = byId.id;

  if (!agentId) {
    const byName = agents.find((a) => normalizeField(a.name) === normalized);
    if (byName) agentId = byName.id;
  }

  if (!agentId) {
    const byIdentity = agents.find((a) => normalizeField(a.identityName) === normalized);
    if (byIdentity) agentId = byIdentity.id;
  }

  if (!agentId) {
    const byPrefix = agents.filter((a) => normalizeField(a.identityName).startsWith(normalized));
    if (byPrefix.length === 1) agentId = byPrefix[0].id;
    if (byPrefix.length > 1) {
      throw new BridgeError(
        "AMBIGUOUS_AGENT",
        `Multiple agents match "${input}": ${byPrefix.map((a) => a.id).join(", ")}`,
        byPrefix.map((a) => a.id)
      );
    }
  }

  if (!agentId) {
    const alias = config.aliases?.[normalized];
    if (alias) agentId = alias;
  }

  if (!agentId) {
    throw new BridgeError("UNKNOWN_AGENT", `Unknown agent "${input}"`);
  }

  // Post-resolution gating: disabled / not allowed, checked on the resolved ID
  // (not the raw input, so display-name aliases cannot bypass a disabled agent)
  if (config.disabledAgents?.includes(agentId)) {
    throw new BridgeError("AGENT_DISABLED", `Agent "${agentId}" is disabled`);
  }
  if (!config.allowedAgents?.includes(agentId)) {
    throw new BridgeError("AGENT_DISABLED", `Agent "${agentId}" is not in allowedAgents`);
  }

  return agentId;
}

function normalizeAgentInput(input) {
  if (!input) return "";
  return input
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .replace(/\s*\(\s*/g, "(") // Remove space before (
    .replace(/\s*\)\s*/g, ")"); // Remove space after )
}

// ─── Audit Log ───────────────────────────────────────────────────────────────

export class AuditLog {
  constructor(config) {
    this.dir = config.audit.dir.replace(/^~/, homedir());
    this.path = join(this.dir, "audit.jsonl");
    this.ensureDir();
  }

  ensureDir() {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    } catch (error) {
      process.stderr.write(`[audit] Failed to create dir: ${error.message}\n`);
    }
  }

  write(entry) {
    try {
      const line = JSON.stringify(entry) + "\n";
      appendFileSync(this.path, line, { mode: 0o600 });
    } catch (error) {
      // Fail-open: log to stderr but don't throw
      process.stderr.write(`[audit] Failed to write: ${error.message}\n`);
    }
  }
}

// ─── Rate Limiter ────────────────────────────────────────────────────────────

export class RateLimiter {
  constructor(config, now = () => Date.now()) {
    this.perMinute = config.rateLimit.perMinute;
    this.perHour = config.rateLimit.perHour;
    this.now = now;
    this.counts = new Map(); // agentId -> [{ts}]
  }

  check(agentId) {
    const now = this.now();
    const minuteAgo = now - 60000;
    const hourAgo = now - 3600000;

    const entries = this.counts.get(agentId) || [];
    const recentMinute = entries.filter((e) => e.ts > minuteAgo).length;
    const recentHour = entries.filter((e) => e.ts > hourAgo).length;

    if (recentMinute >= this.perMinute) {
      return { allowed: false, retryAfter: "1 minute" };
    }
    if (recentHour >= this.perHour) {
      return { allowed: false, retryAfter: "1 hour" };
    }

    return { allowed: true };
  }

  record(agentId) {
    const now = this.now();
    const entries = this.counts.get(agentId) || [];
    entries.push({ ts: now });
    // Prune old entries
    const hourAgo = now - 3600000;
    const pruned = entries.filter((e) => e.ts > hourAgo);
    this.counts.set(agentId, pruned);
  }
}

// ─── Session Registry ────────────────────────────────────────────────────────

export class SessionRegistry {
  constructor(config, client, now = () => Date.now()) {
    this.config = config;
    this.client = client;
    this.now = now;
    this.locks = new Map(); // sessionKey -> {runId, acquiredAt}
    this.runIndex = new Map(); // runId -> {sessionKey, submittedAt}
    this.dedupe = new Map(); // agentId|sessionKey|message -> {runId, ts}
  }

  async checkLock(sessionKey) {
    const lock = this.locks.get(sessionKey);
    if (!lock) return { locked: false };

    // Probe with agent.wait timeout 1ms
    try {
      const result = await this.client.waitRun(lock.runId, 1);
      const normalized = normalizeWait(result);
      if (normalized.status === "running") {
        return { locked: true, runId: lock.runId };
      }
      // Terminal state - release lock
      this.releaseLock(sessionKey);
      return { locked: false };
    } catch (error) {
      // Probe failed - conservative: keep lock
      return { locked: true, runId: lock.runId };
    }
  }

  acquireLock(sessionKey, runId, submittedAt = this.now()) {
    // Bound the runIndex: drop the oldest entry beyond 1000 so oc_wait
    // lookups keep working after terminal runs without leaking memory.
    if (this.runIndex.size >= 1000) {
      const oldest = this.runIndex.keys().next().value;
      this.runIndex.delete(oldest);
    }
    this.locks.set(sessionKey, { runId, acquiredAt: submittedAt });
    this.runIndex.set(runId, { sessionKey, submittedAt });
  }

  releaseLock(sessionKey) {
    // Only the session lock is dropped; the runIndex entry is kept so
    // oc_wait(runId) can still resolve the session and fetch the reply
    // after oc_run already saw the terminal state itself.
    this.locks.delete(sessionKey);
  }

  // Look up the session a run belongs to (runId -> {sessionKey, submittedAt}).
  // Unknown after a bridge restart; callers must handle undefined.
  getRun(runId) {
    return this.runIndex.get(runId);
  }

  releaseRun(runId) {
    const indexed = this.runIndex.get(runId);
    if (indexed) {
      const lock = this.locks.get(indexed.sessionKey);
      if (lock && lock.runId === runId) {
        this.locks.delete(indexed.sessionKey);
      }
      this.runIndex.delete(runId);
    }
  }

  checkDedupe(agentId, sessionKey, message) {
    const key = `${agentId}|${sessionKey}|${message}`;
    const entry = this.dedupe.get(key);
    if (!entry) return null;

    const now = this.now();
    const windowMs = this.config.dedupe.windowSeconds * 1000;
    if (now - entry.ts > windowMs) {
      this.dedupe.delete(key);
      return null;
    }

    return entry.runId;
  }

  recordDedupe(agentId, sessionKey, message, runId) {
    const key = `${agentId}|${sessionKey}|${message}`;
    this.dedupe.set(key, { runId, ts: this.now() });
  }

  buildSessionKey(agentId) {
    const suffix = this.config.session.suffix;
    return `agent:${agentId}:${suffix}`;
  }

  validateSessionKey(sessionKey) {
    if (sessionKey.length > this.config.session.maxKeyLength) {
      throw new BridgeError("INVALID_SESSION", "Session key too long");
    }
    if (/[\n\r]/.test(sessionKey)) {
      throw new BridgeError("INVALID_SESSION", "Session key contains invalid characters");
    }
  }
}
