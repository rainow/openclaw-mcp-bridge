#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  loadConfig,
  OpenClawClient,
  normalizeAgents,
  normalizeWait,
  extractReply,
  buildVoice,
  resolveAgent,
  AuditLog,
  RateLimiter,
  SessionRegistry,
  BridgeError,
  isLostSubmitResponse,
} from "./lib/openclaw.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load config
const config = loadConfig(join(__dirname, "config.json"));

// Initialize components
const client = new OpenClawClient(config);
const audit = new AuditLog(config);
const rateLimiter = new RateLimiter(config);
const sessionRegistry = new SessionRegistry(config, client);

// Agent cache
let agentCache = null;
let agentCacheTs = 0;
const AGENT_CACHE_TTL = 60000;

async function getAgents(refresh = false) {
  const now = Date.now();
  if (!refresh && agentCache && now - agentCacheTs < AGENT_CACHE_TTL) {
    return { agents: agentCache, cached: true };
  }

  const raw = await client.listAgents();
  agentCache = normalizeAgents(raw);
  agentCacheTs = now;
  return { agents: agentCache, cached: false };
}

// Create MCP server.
// `instructions` is the MCP-standard place to tell any client how this server
// is meant to be used, so a fresh install is usable from the first message
// without the model having to probe the tool list. Keep it client-neutral and
// free of machine-specific facts: agent names live in config.json, so the
// protocol says "call oc_agents first" instead of hardcoding any lineup.
const SERVER_INSTRUCTIONS = `本服务器把任务下发给本机 OpenClaw 的 agent，用于语音 / 远程控制场景。

使用顺序：
1. 第一次使用、或不确定可以点名谁时，先调 oc_agents 获取本机 agent 的 id、名字、别名和 defaultAgent。agent 名单每台机器都不同，不要凭空猜名字。
2. 派活用 oc_run(agent, message, wait_seconds)。agent 填 oc_agents 返回的名字或别名；用户没有点名时使用 defaultAgent。
3. status=done 时，reply 是完整结果，voice.speak 是适合直接朗读的一句话；语音场景只播报 voice.speak。voice.needsSummary 或 replyTruncated 为 true 表示内容偏长 / 已被截断，需要时再展开或总结。
4. status=running 表示任务还在跑：用返回的 runId 调 oc_wait 继续等，不要重复 oc_run（同一会话已有任务时 oc_run 会返回 SESSION_BUSY，并带上当前 runId）。
5. 回看本轮对话用 oc_last；中止任务用 oc_cancel(runId)。

约束：写操作会被 agent 在本机真实执行，删除、重启、对外发送这类破坏性动作先跟用户确认。replyUnavailable 只表示没取到回复，不代表任务失败。用户点名的 agent 不在 oc_agents 名单里时，不要挑一个相近的顶上，把可用名单告诉用户。`;

const server = new Server(
  {
    name: "openclaw-mcp-bridge",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
    instructions: SERVER_INSTRUCTIONS,
  }
);

// Tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "oc_agents",
        description:
          "列出本机 OpenClaw 可用的 agent：id、名字、别名、是否默认、execRisk（allow=可落地动作，deny=只读或纯回复）。agent 名单来自本机的 config.json，每台机器都不同——用户提到某个名字、或你不确定能点名谁时，先调本工具确认，不要凭猜测点名。" +
          "返回的 name 或 aliases 可以直接当作其他工具的 agent 参数。结果缓存 60 秒，refresh=true 强制刷新。Gateway 不在时返回 GATEWAY_UNAVAILABLE。语音场景只报名字和默认 agent，不要把 JSON 读出来。",
        inputSchema: {
          type: "object",
          properties: {
            refresh: {
              type: "boolean",
              description: "强制刷新缓存，重新从 Gateway 获取 agent 列表。",
            },
          },
        },
      },
      {
        name: "oc_run",
        description:
          "向指定 agent 下发任务，并同步等待最多 wait_seconds（默认 20，最大 120）。\n" +
          "参数：agent 填 oc_agents 返回的名字或别名，留空则使用 config.json 里的 defaultAgent；用户点名的 agent 不在 oc_agents 列表里时不要调用本工具，直接告诉用户没有这个 agent。message 只放任务本身，不要带“让某某做”的转述。\n" +
          "安全：任务会被 agent 在本机真实执行，不是模拟。删除、格式化、重启、对外发送消息等破坏性动作先跟用户确认；下发时尽量限定范围。\n" +
          "返回判读：status=done 时 reply 是完整结果，voice.speak 是适合朗读的短句——语音场景只播报 voice.speak，reply 只用于屏幕查看或回答追问，不要整段朗读；voice.needsSummary 或 replyTruncated=true 表示内容偏长或被截断，此时用 1–3 句话总结 reply，不要朗读代码、日志、diff、JSON、URL 或长列表；voice 提示可能含敏感信息时不要复述具体值。status=running 表示仍在跑，请用返回的 runId 调 oc_wait 继续等，不要重复调用本工具；同一会话已有任务时会返回 SESSION_BUSY 并带上当前 runId；submitReconciled=true 表示提交响应丢失但已确认任务在跑，按 running 处理。\n" +
          "限流默认 6 次/分钟，超限返回 RATE_LIMITED 与重试时间，不要立刻重发。",
        inputSchema: {
          type: "object",
          properties: {
            agent: {
              type: "string",
              description: "Agent 名字或 ID（先用 oc_agents 获取本机可用值）。留空使用默认 agent。",
            },
            message: {
              type: "string",
              description: "要下发的任务消息。",
            },
            wait_seconds: {
              type: "number",
              description: "同步等待秒数，默认 20，最大 120。设为 0 立即返回。",
              default: 20,
            },
            idempotency_key: {
              type: "string",
              description: "幂等键，透传给 Gateway；5 秒内相同 agent+message 会自动去重。",
            },
          },
          required: ["message"],
        },
      },
      {
        name: "oc_wait",
        description:
          "按 runId 继续等待或查询已下发的任务，最多 timeout_seconds（0=只查状态不等待，默认 0）。刚下发还没结果、或用户问“怎么样了”时用。" +
          "done 时返回本轮 reply 与 voice 元数据，按 voice.speak 播报或做 1–3 句总结；running 表示还在跑，只播报状态和已用时间，不要翻历史、不要猜进度，可以再调本工具；aborted/error 看 stopReason 和 error，并说清结果与下一步。" +
          "任务已经结束后再调仍然能取到本轮回复。replyUnavailable=true 只是没读到回复，可改用 oc_last 查看。任何时候都不要因为本工具重复下发任务。",
        inputSchema: {
          type: "object",
          properties: {
            runId: {
              type: "string",
              description: "任务 runId（来自 oc_run 或 oc_wait 的返回）。",
            },
            timeout_seconds: {
              type: "number",
              description: "等待秒数，0 表示立即返回。",
              default: 0,
            },
          },
          required: ["runId"],
        },
      },
      {
        name: "oc_last",
        description:
          "读取指定 agent 的 glasses 会话最近 limit 条消息（默认 10，最大 50），返回最后一条 assistant 回复和 voice 播报元数据。" +
          "用于 runId 丢失、桥接进程重启、或需要确认“刚才那个任务”说了什么。只播报最后一条 assistant 的内容概要，不要把历史逐条读出来。" +
          "它只反映历史，不代表任务当前是否在运行——查状态请用 oc_wait；手上没有 runId 时也不要据此断言“还在跑”或“已完成”。",
        inputSchema: {
          type: "object",
          properties: {
            agent: {
              type: "string",
              description: "Agent 名字或 ID（先用 oc_agents 获取本机可用值）。留空使用默认 agent。",
            },
            limit: {
              type: "number",
              description: "返回消息条数，默认 10，最大 50。",
              default: 10,
            },
          },
        },
      },
      {
        name: "oc_cancel",
        description:
          "取消 runId 对应的任务，成功返回 status=aborted。只有用户明确说要停掉/取消时才调用，成功后用一句话确认，不要念底层字段。" +
          "Gateway 上已无活动任务时视为幂等成功（no-active-run），并释放本桥接的会话锁——因此任务长时间悬挂在 running、或 SESSION_BUSY 挡住新任务时，取消它是最可靠的恢复手段。",
        inputSchema: {
          type: "object",
          properties: {
            runId: {
              type: "string",
              description: "任务 runId。",
            },
          },
          required: ["runId"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const startTime = Date.now();

  try {
    let result;

    switch (name) {
      case "oc_agents":
        result = await handleAgents(args);
        break;
      case "oc_run":
        result = await handleRun(args, requestId, startTime);
        break;
      case "oc_wait":
        result = await handleWait(args, requestId);
        break;
      case "oc_last":
        result = await handleLast(args, requestId);
        break;
      case "oc_cancel":
        result = await handleCancel(args, requestId);
        break;
      default:
        throw new BridgeError("UNKNOWN_TOOL", `Unknown tool: ${name}`);
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    const code = error.code || "UNKNOWN_ERROR";
    const message = error.message || "Unknown error";
    const details = error.details ?? null;

    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({ code, message, details }, null, 2),
        },
      ],
    };
  }
});

// Tool handlers
async function handleAgents(args) {
  const { agents, cached } = await getAgents(args.refresh);
  const healthOk = await client.health();

  return {
    openclawVersion: client.version || "unknown",
    gatewayOk: healthOk,
    agents: agents.map((a) => ({
      id: a.id,
      name: a.name,
      identityName: a.identityName,
      isDefault: a.id === config.defaultAgent,
      execRisk: config.execRisk[a.id] || "unknown",
    })),
    defaultAgent: config.defaultAgent,
    cached,
  };
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

async function handleRun(args, requestId, startTime) {
  const { message, agent: agentInput, idempotency_key } = args;

  if (!message || typeof message !== "string") {
    throw new BridgeError("INVALID_ARGUMENT", "message is required and must be a string");
  }

  const waitSeconds = clampNumber(
    args.wait_seconds ?? config.run.defaultWaitSeconds,
    config.run.defaultWaitSeconds,
    0,
    config.run.maxWaitSeconds
  );

  // Resolve agent
  const { agents } = await getAgents();
  const agentId = resolveAgent(agentInput, agents, config);

  // Check rate limit
  const rateCheck = rateLimiter.check(agentId);
  if (!rateCheck.allowed) {
    throw new BridgeError("RATE_LIMITED", `Rate limit exceeded for ${agentId}`, {
      retryAfter: rateCheck.retryAfter,
    });
  }

  // Build session key
  const sessionKey = sessionRegistry.buildSessionKey(agentId);
  sessionRegistry.validateSessionKey(sessionKey);

  const agentInfo = agents.find((a) => a.id === agentId);
  const auditBase = {
    ts: new Date().toISOString(),
    requestId,
    agent: agentId,
    agentName: agentInfo?.name || "unknown",
    sessionKey,
    waitSeconds,
    message: message.slice(0, 200),
  };

  // Check lock
  const lockCheck = await sessionRegistry.checkLock(sessionKey);
  if (lockCheck.locked) {
    audit.write({
      ...auditBase,
      runId: lockCheck.runId,
      status: "busy",
      durationMs: Date.now() - startTime,
      voiceKind: "status",
      voiceNeedsSummary: false,
      voiceFailed: false,
    });
    throw new BridgeError(
      "SESSION_BUSY",
      "这个会话已经有任务在跑，这是它的 runId，不用重复下发。",
      {
        runId: lockCheck.runId,
        sessionKey,
        voice: {
          speak: "这个会话已经有任务在跑，这是它的 runId，不用重复下发。",
          kind: "status",
          needsSummary: false,
          textLength: 0,
        },
      }
    );
  }

  // Check dedupe (agent|session|message within 5s window, independent of idempotency_key)
  const dedupedRunId = sessionRegistry.checkDedupe(agentId, sessionKey, message);
  if (dedupedRunId) {
    audit.write({
      ...auditBase,
      runId: dedupedRunId,
      status: "deduped",
      durationMs: Date.now() - startTime,
      voiceKind: "status",
      voiceNeedsSummary: false,
      voiceFailed: false,
    });
    return {
      status: "deduped",
      runId: dedupedRunId,
      deduped: true,
      sessionKey,
      reply: null,
      voice: {
        speak: "刚下发过，这是同一个任务，可以用 oc_wait 查。",
        kind: "status",
        needsSummary: false,
        textLength: 0,
      },
    };
  }

  // Submit task. The Gateway requires idempotencyKey and adopts it as the
  // runId (`const runId = idem`), so the run identity is known before the
  // response arrives: send the caller's key if given, else a fresh requestId.
  const submittedAt = Date.now();
  let runId = idempotency_key || requestId;
  let submitReconciled = false;

  try {
    const submitResult = await client.runAgent(agentId, sessionKey, message, runId);
    if (submitResult?.runId) runId = submitResult.runId;
  } catch (submitError) {
    // Lost response, not necessarily a lost task: the Gateway may already have
    // accepted the run under our key. Confirm it answers for that runId, then
    // fall through to the normal wait path instead of orphaning a live run.
    // Explicit rejections are rethrown so they cannot become phantom runs.
    if (!isLostSubmitResponse(submitError)) throw submitError;
    if (!(await client.probeRun(runId))) throw submitError;
    submitReconciled = true;
  }

  // Record rate limit, lock, dedupe
  rateLimiter.record(agentId);
  sessionRegistry.acquireLock(sessionKey, runId, submittedAt);
  sessionRegistry.recordDedupe(agentId, sessionKey, message, runId);

  // Wait if requested
  let status = "running";
  let reply = null;
  let voice = null;
  let replyTruncated = false;
  let replyUnavailable = false;

  if (waitSeconds > 0) {
    const waitResult = await client.waitRun(runId, waitSeconds * 1000);
    const normalized = normalizeWait(waitResult);
    status = normalized.status;

    // Current-run boundary: agent.wait.startedAt, falling back to submit time
    const boundary = normalized.startedAt ?? submittedAt;

    if (status === "done") {
      try {
        const history = await client.history(sessionKey, 10, 4000);
        const extracted = extractReply(history, boundary);
        reply = extracted.reply;
        replyTruncated = extracted.replyTruncated;
        voice = buildVoice(reply, status, config, { replyTruncated });
      } catch (error) {
        // History failed - distinguish from empty reply
        replyUnavailable = true;
        voice = buildVoice(null, status, config, { replyUnavailable: true });
      }
      sessionRegistry.releaseLock(sessionKey);
    } else if (status === "error" || status === "aborted") {
      voice = buildVoice(null, status, config);
      sessionRegistry.releaseLock(sessionKey);
    } else {
      // Still running - never surface a stale reply
      voice = buildVoice(null, "running", config);
    }
  } else {
    voice = buildVoice(null, "running", config);
  }

  audit.write({
    ...auditBase,
    runId,
    status,
    submitReconciled,
    durationMs: Date.now() - startTime,
    replyUnavailable,
    voiceKind: voice?.kind || null,
    voiceNeedsSummary: voice?.needsSummary || false,
    voiceFailed: voice === null,
  });

  return {
    status,
    runId,
    agentId,
    sessionKey,
    reply,
    voice,
    replyTruncated,
    replyUnavailable,
    submitReconciled,
  };
}

async function handleWait(args, requestId) {
  const { runId } = args;

  if (!runId) {
    throw new BridgeError("INVALID_ARGUMENT", "runId is required");
  }

  const timeoutSeconds = clampNumber(args.timeout_seconds ?? 0, 0, 0, config.run.maxWaitSeconds);

  const waitResult = await client.waitRun(runId, timeoutSeconds * 1000);
  const normalized = normalizeWait(waitResult);

  let reply = null;
  let voice = null;
  let replyTruncated = false;
  let replyUnavailable = false;

  if (normalized.status === "done") {
    const runInfo = sessionRegistry.getRun(runId);
    if (runInfo) {
      // Current-run boundary: startedAt with submit-time fallback
      const boundary = normalized.startedAt ?? runInfo.submittedAt;
      try {
        const history = await client.history(runInfo.sessionKey, 10, 4000);
        const extracted = extractReply(history, boundary);
        reply = extracted.reply;
        replyTruncated = extracted.replyTruncated;
        voice = buildVoice(reply, "done", config, { replyTruncated });
      } catch (error) {
        replyUnavailable = true;
        voice = buildVoice(null, "done", config, { replyUnavailable: true });
      }
    } else {
      // Unknown run (e.g. bridge restarted) - we don't know the session
      replyUnavailable = true;
      voice = buildVoice(null, "done", config, { replyUnavailable: true });
    }

    sessionRegistry.releaseRun(runId);
  } else if (normalized.status === "error" || normalized.status === "aborted") {
    voice = buildVoice(null, normalized.status, config);
    sessionRegistry.releaseRun(runId);
  } else {
    voice = buildVoice(null, "running", config);
  }

  return {
    status: normalized.status,
    runId: normalized.runId || runId,
    stopReason: normalized.stopReason || null,
    startedAt: normalized.startedAt || null,
    endedAt: normalized.endedAt || null,
    error: normalized.error || null,
    reply,
    replyTruncated,
    replyUnavailable,
    voice,
  };
}

async function handleLast(args, requestId) {
  const { agent: agentInput } = args;
  const limit = clampNumber(args.limit ?? 10, 10, 1, 50);

  const { agents } = await getAgents();
  const agentId = resolveAgent(agentInput, agents, config);
  const sessionKey = sessionRegistry.buildSessionKey(agentId);

  const history = await client.history(sessionKey, limit, 4000);
  const messages = history.messages || [];

  // Extract last assistant reply (reuse the same extraction rules)
  const extracted = extractReply({ messages }, null);
  const reply = extracted.reply;
  const replyTruncated = extracted.replyTruncated;

  const voice = buildVoice(reply, "done", config, { replyTruncated });

  return {
    agentId,
    sessionKey,
    messages: messages.slice(-limit).map((m) => ({
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
    })),
    reply,
    voice,
    replyTruncated,
  };
}

async function handleCancel(args, requestId) {
  const { runId } = args;

  if (!runId) {
    throw new BridgeError("INVALID_ARGUMENT", "runId is required");
  }

  const runInfo = sessionRegistry.getRun(runId);

  let result;
  try {
    result = await client.abort(runId);
  } catch (error) {
    // Fallback: chat.abort with the known sessionKey
    if (runInfo) {
      try {
        const chatResult = await client.chatAbort(runInfo.sessionKey, runId);
        sessionRegistry.releaseRun(runId);
        return {
          ok: chatResult.ok !== false,
          status: "aborted",
          abortedRunId: runId,
          fallback: "chat.abort",
        };
      } catch (fallbackError) {
        throw new BridgeError("CANCEL_FAILED", "Failed to cancel task", {
          sessionsAbort: error.message,
          chatAbort: fallbackError.message,
        });
      }
    }
    throw new BridgeError("CANCEL_FAILED", "Failed to cancel task", error.message);
  }

  if (result.status === "no-active-run") {
    // Idempotent success - clean up any stale local lock
    sessionRegistry.releaseRun(runId);
    return {
      ok: true,
      status: "no-active-run",
      abortedRunId: result.abortedRunId || runId,
      idempotent: true,
    };
  }

  if (result.ok) {
    sessionRegistry.releaseRun(runId);
  }

  return {
    ok: result.ok !== false,
    status: result.status || "aborted",
    abortedRunId: result.abortedRunId || runId,
  };
}

// Start server
async function main() {
  await client.detectVersion();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[openclaw-mcp-bridge] Server started (OpenClaw ${client.version || "unknown"})\n`);
}

main().catch((error) => {
  process.stderr.write(`[openclaw-mcp-bridge] Fatal error: ${error.message}\n`);
  process.exit(1);
});
