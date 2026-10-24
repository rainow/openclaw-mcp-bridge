# openclaw-mcp-bridge

**OpenClaw as MCP** — expose OpenClaw agents to any MCP-compatible agent. Example: Qwen glasses → Qoder → OpenClaw.

把本机 OpenClaw 的 agent 暴露成标准 MCP 工具，任何支持 MCP 的客户端都能调用；典型链路是千问眼镜 → Qoder CN → OpenClaw。

## 功能

- 🎤 **语音控制**: 通过千问眼镜语音下发任务到 OpenClaw agent
- 🔀 **多 Agent 支持**: agent 白名单、别名、权限等级全部在 `config.json` 里配置
- 🎯 **智能路由**: 点名即执行；未点名时使用 `defaultAgent`（建议指向权限最小的 agent）
- 📊 **状态查询**: 实时查询任务状态、读取历史、取消任务
- 🔊 **语音优化**: 自动提取首句播报，长回复标记需要总结
- 🔒 **安全隔离**: 会话锁、限流、审计、无 token 泄漏

## 从零到能用

整条链路是这样的：

```
千问眼镜（语音）
  → Qoder CN 远程控制会话（跑在这台 Mac 上）
  → openclaw-mcp-bridge（stdio MCP）
  → openclaw CLI → OpenClaw Gateway → agent
```

### 1. 在 Mac 上装 Qoder CN

装 **Qoder CN 桌面版**，不是 Qoder 国际版——两者是独立产品，配置目录也不同（CN 是 `~/.qoder-cn/`，国际版是 `~/.qoder/`），本项目只在 CN 桌面端验证过。

登录后确认远程控制 / 远程会话可用：眼镜侧正是以这种会话的形式，把任务发到你这台 Mac 上执行。

会话必须在本机执行。如果 Qoder 把任务委派到云端，云端进程访问不到你本机的 stdio MCP，这条链路就断了。

### 2. 千问眼镜绑定 Qoder CN

在千问 App 或眼镜端按官方引导绑定 Qoder CN 账号（通常是扫码登录授权）。绑定后，你对眼镜说的话会变成一个 Qoder CN 远程控制会话。具体入口和按钮名称可能随版本变化，以千问和 Qoder 当前的引导为准。

绑好后先验证一次：对眼镜说一句话，确认 Qoder CN 里出现了对应会话，并且它是在这台 Mac 上执行的。

### 3. 在这台 Mac 上安装本项目

前置条件：

- Node.js ≥ 20（本项目在 v23 上测试）
- 本机已安装并登录 OpenClaw，且 Gateway 正在运行（`openclaw gateway status`）
- 桥接本身不需要任何 token：它复用 `openclaw` CLI 的本机认证

```bash
git clone https://github.com/rainow/openclaw-mcp-bridge.git
cd openclaw-mcp-bridge
npm install
cp config.example.json config.json   # 然后按你的 agent 名单改 config.json
```

`config.json` 至少改这三处：`allowedAgents` 填 `openclaw agents list` 里真实存在的 agent ID；`aliases` 填语音里好念的名字；`defaultAgent` 建议指向权限最小的那个。

装完先手动跑一次，确认配置和 Gateway 都通：

```bash
npm start
```

看到 `[openclaw-mcp-bridge] Server started (OpenClaw …)` 就说明没问题，`Ctrl+C` 退出即可——正常使用时这个进程由 Qoder 拉起，不需要你手动常驻。

`config.json` 写的是你本人的 agent 名单、别名和权限，不要提交到版本库。缺少它时服务器会回退到 `config.example.json` 并在 stderr 提示。

### 4. 在 Qoder CN 里配置 MCP

设置 → 扩展（Extensions）→ 连接器（Connectors）→ 添加自定义 MCP，传输方式选 **stdio**：

- **名称**: `openclaw-mcp-bridge`
- **命令**: `node` 的绝对路径（如 `/opt/homebrew/bin/node`），不要只写 `node`
- **参数**: `/绝对路径/openclaw-mcp-bridge/server.mjs`
- **工作目录**: `/绝对路径/openclaw-mcp-bridge`

参数和工作目录都必须是绝对路径。保存后如果工具里没出现这 5 个工具，对该服务器执行一次 retry，或重开会话。改过 `server.mjs` / `lib/openclaw.mjs` 之后同理，运行中的进程不会热更新。

桥接进程由 Qoder 按需拉起，不需要、也不应该做成系统级自启动任务（stdio 服务器脱离父进程就没有意义）。需要常驻的是 OpenClaw Gateway，是否让它开机自启由你决定。

### 5. 验证

在 Qoder CN 的新会话里说"列出可用的 OpenClaw agent"，或直接在眼镜上说"让助手看一下今天的安排"（把"助手"换成你 `aliases` 里的名字）。第一次调用会先读 MCP 工具目录，这是客户端的懒加载行为，正常现象。

### 为什么不用在每个会话里教它

这个桥接不需要你在每个会话里重复解释自己会什么，用法写在两个地方：

- **服务器级 `instructions`**：`initialize` 时就返回，告诉任意 MCP 客户端"先 `oc_agents` 拿本机 agent 名单，再 `oc_run` 派活，`running` 就 `oc_wait`，别重复下发"。
- **每个工具的 `description`**：把同一段协议拆开写进各自工具里，所以客户端只要列出工具就能读全用法。这两处是用法的主来源，改动时要一起更新，别只改其中一边。

实测差异（Qoder CN 桌面端 0.x，2026-10-22）：服务器 `instructions` 会正常出现在 `initialize` 响应里，但 Qoder **不会把它注入会话上下文**；它注入的是"服务器名 + 工具名"的延迟目录。真正起作用的是工具 `description` —— 一个全新会话在完全没被提示的情况下，自己走 `mcp_list` / `mcp_get` 读到用法，再调 `oc_agents` 定位到本机的 agent，然后完成任务。所以配完就能用，但你依然可以直接说"让某某去做某事"。

## MCP 工具

### oc_agents

列出所有可用的 OpenClaw agent。

**参数**:
- `refresh` (boolean, 可选): 强制刷新缓存

**返回**:
```json
{
  "openclawVersion": "2026.6.11",
  "gatewayOk": true,
  "agents": [...],
  "defaultAgent": "main",
  "cached": false
}
```

### oc_run

向指定 agent 下发任务。

**参数**:
- `message` (string, 必填): 任务消息
- `agent` (string, 可选): Agent 名字或 ID，默认取 `config.json` 的 `defaultAgent`
- `wait_seconds` (number, 可选): 同步等待秒数，默认 20，最大 120
- `idempotency_key` (string, 可选): 幂等键，5 秒内相同 key 不重复下发

**返回**:
```json
{
  "status": "done",
  "runId": "req-xxx",
  "agentId": "main",
  "sessionKey": "agent:main:glasses",
  "reply": "任务回复内容",
  "voice": {
    "speak": "播报文本（≤150 字符）",
    "kind": "text",
    "needsSummary": false,
    "textLength": 100
  },
  "replyTruncated": false
}
```

### oc_wait

查询或等待任务状态。

**参数**:
- `runId` (string, 必填): 任务 runId
- `timeout_seconds` (number, 可选): 等待秒数，0 表示立即返回

**返回**:
```json
{
  "status": "done",
  "runId": "req-xxx",
  "stopReason": "stop",
  "startedAt": 1700000000000,
  "endedAt": 1700000005000,
  "voice": {...}
}
```

### oc_last

读取指定 agent 的 glasses 会话历史。

**参数**:
- `agent` (string, 可选): Agent 名字或 ID，默认取 `config.json` 的 `defaultAgent`
- `limit` (number, 可选): 返回消息条数，默认 10

**返回**:
```json
{
  "agentId": "main",
  "sessionKey": "agent:main:glasses",
  "messages": [...],
  "reply": "最后一条 assistant 回复",
  "voice": {...},
  "replyTruncated": false
}
```

### oc_cancel

取消指定任务。

**参数**:
- `runId` (string, 必填): 任务 runId

**返回**:
```json
{
  "ok": true,
  "status": "aborted",
  "abortedRunId": "req-xxx"
}
```

## 配置

`config.example.json` 是最小可用配置，复制成 `config.json` 后按需修改：

```json
{
  "defaultAgent": "main",
  "allowedAgents": ["main", "coder"],
  "disabledAgents": [],
  "aliases": { "助手": "main", "coder": "coder" },
  "execRisk": { "main": "allow", "coder": "allow" },
  "session": { "suffix": "glasses", "maxKeyLength": 200 },
  "rateLimit": { "perMinute": 6, "perHour": 60 },
  "voice": { "maxSpeakChars": 150, "summaryThreshold": 400 },
  "run": { "defaultWaitSeconds": 20, "maxWaitSeconds": 120, "cliTimeoutMs": 30000, "rpcTimeoutMs": 15000 },
  "dedupe": { "windowSeconds": 5 },
  "audit": { "dir": "~/Library/Application Support/openclaw-mcp-bridge" }
}
```

几个字段的含义：

- `allowedAgents` / `disabledAgents`: 允许、禁止通过桥接下发的 agent ID（ID 来自 `openclaw agents list`）。
- `aliases`: 语音里更好念的名字 → agent ID。前缀匹配也能命中。
- `execRisk`: 仅作提示位，记录该 agent 是否有 exec 权限；桥接不会修改 OpenClaw 的权限策略。
- `run.rpcTimeoutMs` / `maxWaitSeconds`: 每次 `gateway call` 显式带 `--timeout`，等待时长由请求换算（见 DESIGN §超时）。
- `session.suffix`: 会话键后缀，把眼镜侧的会话和其他来源隔离开。

## 环境变量

- `OPENCLAW_BIN`: OpenClaw 可执行文件路径（默认 `/opt/homebrew/bin/openclaw`）
- `OPENCLAW_NODE_BIN`: Node.js 可执行文件路径（默认 `process.execPath`）
- `OPENCLAW_BRIDGE_HOME`: 审计日志目录（默认 `~/Library/Application Support/openclaw-mcp-bridge`）

## 安全

- ✅ 不暴露 Gateway token、exec-approvals token
- ✅ 不修改 OpenClaw agent 权限
- ✅ 审计日志本地存储，权限 0700/0600
- ✅ 无公网入口

## 已知限制

- 会话锁是内存状态：Gateway 重启或桥接进程重启后会丢失，需要重新下发。
- 回复可能被 Gateway 截断（`replyTruncated`）或读取失败（`replyUnavailable`），此时用 `oc_last` 再取一次。
- 语音分类走启发式，极简的无文件头 diff 可能被判成普通文本；`voice.kind` 只作播报提示。
- 真实提交响应丢失时，桥接会用已知的 `runId` 对账并按 `running` 处理——健康的 Gateway 无法区分"从未受理"和"仍在排队"，此时用 `oc_cancel` 是可靠的恢复手段。

## 许可证

MIT
