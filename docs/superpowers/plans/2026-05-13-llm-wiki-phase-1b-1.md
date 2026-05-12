# LLM-Wiki Phase 1b-1 — 被动事件流（Path A + Path B 3 个事件）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Phase 1a（Draft 服务 + 审查 API + Draft 落地）之上，落地 PRD §6 FR4 的两路被动写入：**Path A**（Issue 状态变 done 时触发 Agent 自评）+ **Path B**（issue.reopened / approval.rejected / agent.run.cancelled 3 个失败信号事件）。每条触发都跑 LLM 提取 0-N 条 knowledge draft，进现有审查队列。**砍掉 commit.reverted**（Paperclip 无 git 集成，延后到 Phase 5 webhook 基建）。**Path C（Agent tool plugin）单独 Phase 1b-2 做。**

**Architecture:** 不引入新的事件总线消费机制 —— 4 个触发点（1 个 Path A + 3 个 Path B）直接 inline 调用同一个 `knowledgeDrafterService.run(trigger)`，fire-and-forget 不阻塞主流程。Drafter 内部组装 prompt → 调 `llmWikiService.completeChat()` → 解析 JSON → 调 `knowledgeDraftService.create()` 落库。沿用 Phase 1a 的 service 风格（factory + Db 注入）。

**Tech Stack:** 复用 Phase 1a 的 OpenAI SDK / DashScope 兼容 endpoint + 现有 issueService / approvalService / heartbeatService / knowledgeDraftService。Vitest mock-only 单测（不依赖真 LLM/DB）。

---

## Context（执行者须读）

### 调研已确认（3 个 Explore 报告 + 本对话补充）

**Path A 现状：**
- ❌ `afterTaskComplete` hook 不存在
- ✅ 但插桩点清晰：`server/src/routes/issues.ts:2698-2702`（`issueService.update()` 返回后、`logActivity` 前后均可）
- 关键判定条件：`existing.status !== 'done' && updated.status === 'done'`

**Path B 现状：**
- ✅ `plugin-event-bus` 已存在，但 `issue.reopened` **不在 `PLUGIN_EVENT_TYPES` 里**（`packages/shared/src/constants.ts:1027-1060`），需要补
- ✅ `agent.run.cancelled` 已存在；触发在 `services/heartbeat.ts:3727 → publishRunLifecyclePluginEvent`
- ✅ `approval.rejected` 在 activity-log 映射为 `approval.decided`；触发在 `services/approvals.ts:183-201 reject()`

**关键决策：不订阅事件总线，改 inline 直调。**
- 原因：事件总线是为 plugin fan-out 设计（带 namespace + filter）。本期唯一消费者就是 drafter，加 subscribe 反而引入 listener 生命周期 / 启动顺序 / 命名空间复杂度
- Karpathy 第 2 条：不写未必要的抽象
- 直接在 4 个 trigger 站点写 `void drafter.run(trigger).catch(logError)`，2-3 行代码

**LLM client 现状：**
- 复用 `server/src/services/llm-wiki.ts` 的 `llmWikiService(db).embed()` 模式
- 加一个 `completeChat({ system, user, jsonMode?, model? }): Promise<string>` 方法
- 环境变量：`OPENAI_API_KEY` / `OPENAI_BASE_URL` / 新 `OPENAI_CHAT_MODEL`（默认 `gpt-4o-mini`）
- 已验证：DashScope `compatible-mode/v1` 同样支持 `qwen-plus` / `qwen-turbo` 这类 chat model

### Phase 1a 遗留 TODO（顺手解决）

按 Phase 1a final-review 报告：

- ✅ 本期：扩 `KNOWLEDGE_DRAFT_SOURCES_PHASE_1A` (`["manual"]`) 为 `KNOWLEDGE_DRAFT_SOURCES` (`["manual", "agent_self_review", "failure_signal"]`)；`knowledgeDraftService.create()` 接受所有 3 个
- ❌ 不做：`requestRevision` 接 issueService 真开 issue（仍占位 `issueId: null`），需要 issueService.create 上下文整合，留到下一波
- ❌ 不做：embedding 重试 / quota 分流（Phase 3 议题）

### 范围边界（明确不做的）

- ❌ Path C：Agent tool plugin（Phase 1b-2）
- ❌ Path B 第 4 个事件 `commit.reverted`（无 git webhook 基建，延后到 Phase 5）
- ❌ `plugin-event-bus` 改造 / 加 `subscribeCore` API（不需要，inline 直调即可）
- ❌ `PLUGIN_EVENT_TYPES` 加 `issue.reopened`（不再走总线，无需）
- ❌ 自动开 issue 通知写入者 draft 需修改（Phase 1a TODO，单独跟进）
- ❌ Drafter 调用失败重试 / 持久化 retry queue（Phase 3）
- ❌ 业务域智能推断（项目 → domain），drafter 暂时全部丢 `general`（issue 可能没有显式 domain 标签）
- ❌ Reviewer Agent pre_verdict 自动填充（Phase 3）

### File Structure（一表锁定）

| 文件 | 责任 | 状态 |
|---|---|---|
| `packages/shared/src/validators/knowledge.ts` | 扩 sources enum（Phase 1a 遗留），加 trigger kind 枚举 | 修改 |
| `packages/shared/src/validators/index.ts` | 同步 export | 修改 |
| `packages/shared/src/index.ts` | 同步 re-export | 修改 |
| `server/src/services/llm-wiki.ts` | 加 `completeChat()` 方法（chat completion + 可选 JSON mode）+ 加 `OPENAI_CHAT_MODEL` env | 修改 |
| `server/src/services/llm-wiki.test.ts` | 新增：`completeChat()` 单测（mock OpenAI client） | **新建** |
| `server/src/services/knowledge-drafter.ts` | `knowledgeDrafterService(db, llm)`：核心方法 `run(trigger)` —— 组装 prompt → call LLM → parse → 写 N 条 draft | **新建** |
| `server/src/services/knowledge-drafter.test.ts` | drafter 单测（mock llm + mock draftService） | **新建** |
| `server/src/services/index.ts` | export `knowledgeDrafterService` + type | 修改 |
| `server/src/routes/issues.ts` | Path A + Path B-1 触发点：status 变化 done / reopened 时 fire-and-forget 调 drafter | 修改 |
| `server/src/services/approvals.ts` | Path B-2 触发点：`reject()` 内 fire-and-forget 调 drafter | 修改 |
| `server/src/services/heartbeat.ts` | Path B-3 触发点：run cancel 时 fire-and-forget 调 drafter | 修改 |
| `server/src/app.ts` | 在 service wire-up 时构造 drafter 实例，传给上述 3 个 service / routes | 修改 |
| `docs/superpowers/plans/2026-05-13-llm-wiki-phase-1b-1-smoke.md` | 手动 smoke checklist | **新建** |

### Drafter 接口设计（早锁定，避免后写步骤走样）

```typescript
export interface KnowledgeDrafterTrigger {
  /** 触发种类，决定走哪个 prompt 模板 */
  kind: "task_complete" | "issue_reopened" | "approval_rejected" | "run_cancelled";
  companyId: string;
  /** 关联实体 ID（issue / approval / run）—— 用于 source_*_id 字段 */
  issueId?: string | null;
  runId?: string | null;
  approvalId?: string | null;
  agentId?: string | null;
  userId?: string | null;
  /** Drafter 用于组 prompt 的上下文，结构因 kind 不同 */
  context: {
    title?: string;
    description?: string;
    status?: string;
    previousStatus?: string;
    comments?: Array<{ author: string; body: string }>;
    runLogs?: string;
    error?: string | null;
    decisionNote?: string | null;
    [key: string]: unknown;
  };
}

export interface KnowledgeDrafterResult {
  /** 实际创建的 draft id 列表（可能为空数组：LLM 返回 [] 或 parse 失败） */
  draftIds: string[];
  /** 失败原因（LLM 报错、JSON parse 失败、所有 draft 校验失败等） */
  error?: string;
}

knowledgeDrafterService(db, llm).run(trigger): Promise<KnowledgeDrafterResult>
```

### Drafter 内部流程（伪代码，供测试参考）

```
1. 根据 trigger.kind 选 prompt 模板（4 个：task_complete / issue_reopened / approval_rejected / run_cancelled）
2. 把 trigger.context 渲染进 prompt（截断超长 comments / runLogs）
3. 调 llm.completeChat({ system, user, jsonMode: true })
4. 截 ```json ... ``` 围栏（若有）→ JSON.parse → 校验是数组
5. 对每个元素：
   - 用 Zod schema 校验形状（type / title / content / confidence / volatility / used_for? / business_domain_name?）
   - 拒绝 type/level 不在枚举里的
   - 用默认值兜底缺失字段：business_domain_name='general'，level='project'，volatility='slow'
6. 对每个有效 draft 调 draftService.create() — actor 类型 system（用 trigger.agentId 或 trigger.userId）
7. 返回 draftIds[]；任何 step 失败 → 返回 error 字符串
```

### Fire-and-forget 调用模板（4 个触发点都用这个）

```typescript
// 在主业务流程返回后追加：
void drafter.run({
  kind: "task_complete",
  companyId,
  issueId,
  agentId,
  context: { title, description, status, ... },
}).catch((err) => {
  logger.warn({ err, trigger: "task_complete", issueId }, "knowledge drafter failed");
});
```

不 await，不影响主响应延迟；失败仅记录 warn。

---

## Task 0: Sources 扩枚举（Phase 1a 遗留）

**Files:**
- Modify: `D:\aiprojects\paperclip\packages\shared\src\validators\knowledge.ts`
- Modify: `D:\aiprojects\paperclip\packages\shared\src\validators\index.ts`
- Modify: `D:\aiprojects\paperclip\packages\shared\src\index.ts`

把 `KNOWLEDGE_DRAFT_SOURCES_PHASE_1A` 改为 `KNOWLEDGE_DRAFT_SOURCES`，含 3 个值。保留旧 const 作 deprecated 别名 1 个 release，避免外部断链（但本仓库没人引）。

- [ ] **Step 1: 替换 const 定义**

打开 `packages/shared/src/validators/knowledge.ts`，找到：

```typescript
/** Draft 来源；Phase 1a 仅允许 manual，Phase 1b 放开 agent_self_review / failure_signal */
export const KNOWLEDGE_DRAFT_SOURCES_PHASE_1A = ["manual"] as const;
```

替换为：

```typescript
/** Draft 来源；Phase 1b-1 起 3 路都开放 */
export const KNOWLEDGE_DRAFT_SOURCES = [
  "manual",
  "agent_self_review",
  "failure_signal",
] as const;
/** @deprecated 用 KNOWLEDGE_DRAFT_SOURCES，下个 phase 移除 */
export const KNOWLEDGE_DRAFT_SOURCES_PHASE_1A = KNOWLEDGE_DRAFT_SOURCES;
```

同时在同文件找到 `createKnowledgeDraftSchema` 内的 `source: z.enum(KNOWLEDGE_DRAFT_SOURCES_PHASE_1A)...`，改为 `source: z.enum(KNOWLEDGE_DRAFT_SOURCES)...`。

- [ ] **Step 2: 更新 validators barrel**

在 `packages/shared/src/validators/index.ts` 找到 Phase 1a 加的那段，把 `KNOWLEDGE_DRAFT_SOURCES_PHASE_1A` 一行**保留**，**新增**一行 `KNOWLEDGE_DRAFT_SOURCES`：

```typescript
export {
  KNOWLEDGE_NODE_TYPES,
  KNOWLEDGE_LEVELS,
  KNOWLEDGE_VOLATILITIES,
  KNOWLEDGE_DRAFT_SOURCES,
  KNOWLEDGE_DRAFT_SOURCES_PHASE_1A,
  KNOWLEDGE_DRAFT_STATUSES,
  ...
} from "./knowledge.js";
```

- [ ] **Step 3: 更新顶层 shared barrel**

在 `packages/shared/src/index.ts` 找到 Phase 1a 加的那段，同样在 value-export 列表加 `KNOWLEDGE_DRAFT_SOURCES`。

- [ ] **Step 4: 构建 shared**

Run: `pnpm --filter @paperclipai/shared build`
Expected: 无 TS 错误。

- [ ] **Step 5: 跑 Phase 1a 单测（确保 source enum 变更没破现有用例）**

Run: `cd D:\aiprojects\paperclip\server && npx vitest run knowledge`
Expected: 26/26 全过。

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/validators/knowledge.ts packages/shared/src/validators/index.ts packages/shared/src/index.ts
git commit -m "feat(llm-wiki): widen KNOWLEDGE_DRAFT_SOURCES to include agent_self_review + failure_signal (Phase 1b-1 prep)"
```

---

## Task 1: `llmWikiService.completeChat()` + 单测

**Files:**
- Modify: `D:\aiprojects\paperclip\server\src\services\llm-wiki.ts`
- Create: `D:\aiprojects\paperclip\server\src\services\llm-wiki.test.ts`

新增 chat completion 能力。复用 Phase 1a 的 OpenAI SDK 实例 + base url + key。新增 `OPENAI_CHAT_MODEL` 环境变量（默认 `gpt-4o-mini`）。

### Step 1: 写失败测试

新建 `server/src/services/llm-wiki.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// 把 OpenAI SDK 整个 mock 掉
const mockCreateEmbedding = vi.fn();
const mockCreateChat = vi.fn();

vi.mock("openai", () => ({
  default: class MockOpenAI {
    embeddings = { create: mockCreateEmbedding };
    chat = { completions: { create: mockCreateChat } };
    constructor() {}
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  // 清缓存：llm-wiki 内部 cachedClient 是 module-level
  vi.resetModules();
  process.env.OPENAI_API_KEY = "sk-test";
  delete process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_CHAT_MODEL;
});

describe("llmWikiService.completeChat", () => {
  it("调 chat.completions.create 并返回 message.content", async () => {
    const { llmWikiService } = await import("./llm-wiki.js");
    mockCreateChat.mockResolvedValueOnce({
      choices: [{ message: { content: "hello world", role: "assistant" } }],
    });
    const svc = llmWikiService({} as any);
    const out = await svc.completeChat({
      system: "you are helpful",
      user: "say hi",
    });
    expect(out).toBe("hello world");
    expect(mockCreateChat).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "you are helpful" },
          { role: "user", content: "say hi" },
        ],
      }),
    );
  });

  it("jsonMode=true 时传 response_format json_object", async () => {
    const { llmWikiService } = await import("./llm-wiki.js");
    mockCreateChat.mockResolvedValueOnce({
      choices: [{ message: { content: "{}" } }],
    });
    const svc = llmWikiService({} as any);
    await svc.completeChat({ system: "s", user: "u", jsonMode: true });
    expect(mockCreateChat).toHaveBeenCalledWith(
      expect.objectContaining({
        response_format: { type: "json_object" },
      }),
    );
  });

  it("OPENAI_CHAT_MODEL env 覆盖默认 model", async () => {
    process.env.OPENAI_CHAT_MODEL = "qwen-plus";
    const { llmWikiService } = await import("./llm-wiki.js");
    mockCreateChat.mockResolvedValueOnce({
      choices: [{ message: { content: "ok" } }],
    });
    const svc = llmWikiService({} as any);
    await svc.completeChat({ system: "s", user: "u" });
    expect(mockCreateChat).toHaveBeenCalledWith(
      expect.objectContaining({ model: "qwen-plus" }),
    );
  });

  it("缺 OPENAI_API_KEY 时抛清晰错误", async () => {
    delete process.env.OPENAI_API_KEY;
    const { llmWikiService } = await import("./llm-wiki.js");
    const svc = llmWikiService({} as any);
    await expect(svc.completeChat({ system: "s", user: "u" })).rejects.toThrow(
      /OPENAI_API_KEY/,
    );
  });

  it("响应没有 choices[0].message.content 时抛错", async () => {
    const { llmWikiService } = await import("./llm-wiki.js");
    mockCreateChat.mockResolvedValueOnce({ choices: [] });
    const svc = llmWikiService({} as any);
    await expect(svc.completeChat({ system: "s", user: "u" })).rejects.toThrow(
      /empty completion/,
    );
  });
});
```

### Step 2: 跑测试验证 fail

Run: `cd D:\aiprojects\paperclip\server && npx vitest run llm-wiki`
Expected: 5 个用例 FAIL —— `completeChat is not a function`。

### Step 3: 实现 completeChat

打开 `server/src/services/llm-wiki.ts`，在 `getEmbeddingModel()` 下方加：

```typescript
const DEFAULT_CHAT_MODEL = "gpt-4o-mini";

function getChatModel(): string {
  return process.env.OPENAI_CHAT_MODEL?.trim() || DEFAULT_CHAT_MODEL;
}
```

然后在 `return {` 的 `embed` 方法后追加：

```typescript
    /**
     * Chat completion 单轮调用。复用 embedding 同一份 OpenAI 兼容 client +
     * base URL + API key。本期只用于 knowledge-drafter；后续 Phase 可能扩
     * Reviewer Agent / 演化引擎复用。
     *
     * jsonMode=true 时传 OpenAI 的 response_format=json_object（DashScope
     * 兼容模式 v1 也支持）。返回纯文本 content；JSON 解析由调用方做。
     */
    async completeChat(opts: {
      system: string;
      user: string;
      model?: string;
      temperature?: number;
      jsonMode?: boolean;
    }): Promise<string> {
      const client = getClient();
      const model = opts.model ?? getChatModel();
      const resp = await client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.user },
        ],
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts.jsonMode ? { response_format: { type: "json_object" as const } } : {}),
      });
      const content = resp.choices[0]?.message?.content;
      if (!content) {
        throw new Error(
          `empty completion from ${model} (no choices[0].message.content)`,
        );
      }
      return content;
    },
```

### Step 4: 跑测试 verify pass

Run: `cd D:\aiprojects\paperclip\server && npx vitest run llm-wiki`
Expected: 5/5 PASS。

### Step 5: 更新 .env.example（可选 doc）

打开 `D:\aiprojects\paperclip\.env.example`，在 OPENAI 段加：

```bash
# Optional: chat completion model for knowledge-drafter (default gpt-4o-mini)
# OPENAI_CHAT_MODEL=qwen-plus
```

### Step 6: Commit

```bash
git add server/src/services/llm-wiki.ts server/src/services/llm-wiki.test.ts .env.example
git commit -m "feat(llm-wiki): add completeChat() to llmWikiService (Phase 1b-1)"
```

---

## Task 2: `knowledgeDrafterService` 核心 + 单测

**Files:**
- Create: `D:\aiprojects\paperclip\server\src\services\knowledge-drafter.ts`
- Create: `D:\aiprojects\paperclip\server\src\services\knowledge-drafter.test.ts`
- Modify: `D:\aiprojects\paperclip\server\src\services\index.ts`

最核心的一块。Drafter 输入 trigger，输出 0-N 条 draft 写入。Service 工厂接收 `db` + 一个 `embedClient`-like 的 LLM client（构造时注入便于测试 mock）。

### Step 1: 写失败测试

新建 `server/src/services/knowledge-drafter.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { knowledgeDrafterService } from "./knowledge-drafter.js";

// Mock knowledge-drafts service (drafter 复用它写入)
const mockDraftCreate = vi.fn();
vi.mock("./knowledge-drafts.js", () => ({
  knowledgeDraftService: () => ({ create: mockDraftCreate }),
}));

function makeLlmStub(response: string) {
  return { completeChat: vi.fn().mockResolvedValue(response) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("knowledgeDrafterService.run", () => {
  it("LLM 返回空数组 → draftIds 为空，未调 create", async () => {
    const llm = makeLlmStub(JSON.stringify({ drafts: [] }));
    mockDraftCreate.mockResolvedValue({ id: "should-not-be-called" });
    const svc = knowledgeDrafterService({} as any, llm as any);
    const res = await svc.run({
      kind: "task_complete",
      companyId: "c-1",
      issueId: "i-1",
      context: { title: "t", description: "d" },
    });
    expect(res.draftIds).toEqual([]);
    expect(mockDraftCreate).not.toHaveBeenCalled();
  });

  it("LLM 返回 1 条 valid draft → 调 create 1 次，draftIds 含返回 id", async () => {
    const llm = makeLlmStub(
      JSON.stringify({
        drafts: [
          {
            type: "lesson",
            title: "学到的",
            content: "事务里不要调外部 API",
            confidence: 0.7,
            volatility: "slow",
            used_for: ["bug-fix"],
          },
        ],
      }),
    );
    mockDraftCreate.mockResolvedValueOnce({ id: "d-new-1", status: "pending" });
    const svc = knowledgeDrafterService({} as any, llm as any);
    const res = await svc.run({
      kind: "task_complete",
      companyId: "c-1",
      issueId: "i-1",
      agentId: "a-1",
      context: { title: "t", description: "d" },
    });
    expect(res.draftIds).toEqual(["d-new-1"]);
    expect(mockDraftCreate).toHaveBeenCalledTimes(1);
    expect(mockDraftCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "c-1",
        payload: expect.objectContaining({
          type: "lesson",
          title: "学到的",
          source: "agent_self_review",
          business_domain_name: "general",
        }),
      }),
    );
  });

  it("LLM 返回 3 条 draft 但其中 1 条 type 非法 → 跳过非法，写入 2 条", async () => {
    const llm = makeLlmStub(
      JSON.stringify({
        drafts: [
          { type: "lesson", title: "ok1", content: "x", confidence: 0.5 },
          { type: "BANANA", title: "bad", content: "x", confidence: 0.5 },
          { type: "rule", title: "ok2", content: "y", confidence: 0.6 },
        ],
      }),
    );
    mockDraftCreate
      .mockResolvedValueOnce({ id: "d-1" })
      .mockResolvedValueOnce({ id: "d-2" });
    const svc = knowledgeDrafterService({} as any, llm as any);
    const res = await svc.run({
      kind: "task_complete",
      companyId: "c-1",
      context: {},
    });
    expect(res.draftIds).toEqual(["d-1", "d-2"]);
    expect(mockDraftCreate).toHaveBeenCalledTimes(2);
  });

  it("LLM 抛错 → draftIds 空 + error 字段含原因", async () => {
    const llm = { completeChat: vi.fn().mockRejectedValue(new Error("rate limit")) };
    const svc = knowledgeDrafterService({} as any, llm as any);
    const res = await svc.run({
      kind: "task_complete",
      companyId: "c-1",
      context: {},
    });
    expect(res.draftIds).toEqual([]);
    expect(res.error).toMatch(/rate limit/);
  });

  it("LLM 返回非 JSON → 返回 error，无 create 调用", async () => {
    const llm = makeLlmStub("this is not json at all");
    const svc = knowledgeDrafterService({} as any, llm as any);
    const res = await svc.run({
      kind: "task_complete",
      companyId: "c-1",
      context: {},
    });
    expect(res.draftIds).toEqual([]);
    expect(res.error).toMatch(/json/i);
    expect(mockDraftCreate).not.toHaveBeenCalled();
  });

  it("issue_reopened trigger → source=failure_signal", async () => {
    const llm = makeLlmStub(
      JSON.stringify({
        drafts: [{ type: "lesson", title: "t", content: "c", confidence: 0.5 }],
      }),
    );
    mockDraftCreate.mockResolvedValueOnce({ id: "d-1" });
    const svc = knowledgeDrafterService({} as any, llm as any);
    await svc.run({
      kind: "issue_reopened",
      companyId: "c-1",
      issueId: "i-1",
      context: { previousStatus: "done", status: "in_progress" },
    });
    expect(mockDraftCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ source: "failure_signal" }),
      }),
    );
  });

  it("approval_rejected trigger → 调用 prompt 不同于 task_complete", async () => {
    const llm = makeLlmStub(JSON.stringify({ drafts: [] }));
    const svc = knowledgeDrafterService({} as any, llm as any);
    await svc.run({
      kind: "approval_rejected",
      companyId: "c-1",
      approvalId: "ap-1",
      context: { decisionNote: "scope too big" },
    });
    // 验证 user prompt 提到了 approval / rejected 关键词
    const callArg = (llm.completeChat as any).mock.calls[0][0];
    expect(callArg.user).toMatch(/approval|reject|驳回|审批/i);
  });
});
```

### Step 2: 跑测试 verify fail

Run: `cd D:\aiprojects\paperclip\server && npx vitest run knowledge-drafter`
Expected: FAIL —— "Cannot find module ./knowledge-drafter.js"。

### Step 3: 实现 drafter

新建 `server/src/services/knowledge-drafter.ts`：

```typescript
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import {
  KNOWLEDGE_NODE_TYPES,
  KNOWLEDGE_LEVELS,
  KNOWLEDGE_VOLATILITIES,
} from "@paperclipai/shared";
import { knowledgeDraftService, type KnowledgeDraftActor } from "./knowledge-drafts.js";

/**
 * Drafter 触发种类。决定走哪个 prompt 模板。
 * - task_complete：Path A 任务收尾自评（issue 状态 → done）
 * - issue_reopened / approval_rejected / run_cancelled：Path B 3 个失败信号
 */
export type KnowledgeDrafterTriggerKind =
  | "task_complete"
  | "issue_reopened"
  | "approval_rejected"
  | "run_cancelled";

export interface KnowledgeDrafterTrigger {
  kind: KnowledgeDrafterTriggerKind;
  companyId: string;
  issueId?: string | null;
  runId?: string | null;
  approvalId?: string | null;
  agentId?: string | null;
  userId?: string | null;
  /** 因 kind 不同携带不同字段；drafter 内部按 kind 渲染 prompt */
  context: Record<string, unknown>;
}

export interface KnowledgeDrafterResult {
  /** 成功落库的 draft ID 列表（按返回顺序） */
  draftIds: string[];
  /** 任意阶段失败的简短原因；成功路径为 undefined */
  error?: string;
}

/** Drafter 注入的 LLM 客户端接口（生产注入 llmWikiService） */
export interface DrafterChatClient {
  completeChat(opts: {
    system: string;
    user: string;
    jsonMode?: boolean;
    model?: string;
    temperature?: number;
  }): Promise<string>;
}

/** LLM 输出的单条 draft 的最小校验形状 */
const llmDraftSchema = z.object({
  type: z.enum(KNOWLEDGE_NODE_TYPES),
  title: z.string().min(1).max(500),
  content: z.string().min(1).max(8000),
  confidence: z.number().min(0).max(1).default(0.5),
  volatility: z.enum(KNOWLEDGE_VOLATILITIES).optional(),
  level: z.enum(KNOWLEDGE_LEVELS).optional(),
  used_for: z.array(z.string()).optional(),
  business_domain_name: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const llmEnvelopeSchema = z.object({
  drafts: z.array(z.unknown()),
});

/** 系统级 prompt 头，所有 kind 共用 */
const SYSTEM_PROMPT = `你是一个知识库 curator，专门把 Paperclip 平台 Agent 的工作产出提炼成可复用的知识条目。

**任务**：基于给定的触发场景与上下文，输出 0 到 N 条 knowledge draft（条目候选）。如果场景中没有值得沉淀的内容，直接输出空数组。

**质量要求**：
- 教训（lesson）要带"症状/根因/下次怎么做"
- 规则（rule）要明确"什么场景适用"
- 决策（decision）要有"备选方案 + 选择理由"
- 事实（fact）要客观可验证
- 内容用 Markdown；可在 content 里写 [[<uuid>]] 引用已有节点（如果上下文中有 ID）

**输出格式**（严格 JSON object，外层 envelope）：

\`\`\`json
{
  "drafts": [
    {
      "type": "lesson|rule|decision|fact|concept",
      "title": "<= 100 字简洁标题",
      "content": "Markdown 正文，<= 8000 字",
      "confidence": 0.5,
      "volatility": "stable|slow|fast",
      "used_for": ["bug-fix", "architecture", ...],
      "metadata": { ... }
    }
  ]
}
\`\`\`

如果场景里没值得记录的，输出 \`{"drafts": []}\`。不要解释、不要 chain of thought、直接输出 JSON。`;

/** kind → user prompt 模板。渲染时把 context 字段插值进去。 */
function renderUserPrompt(trigger: KnowledgeDrafterTrigger): string {
  const ctx = trigger.context as Record<string, unknown>;
  const safeJson = (v: unknown) => JSON.stringify(v, null, 2);
  switch (trigger.kind) {
    case "task_complete":
      return `场景：Agent 完成了一个任务（issue 标记为 done）。

Issue 信息：
${safeJson({ title: ctx.title, description: ctx.description, status: ctx.status })}

最近评论（最多 10 条）：
${safeJson(ctx.comments ?? [])}

Run 输出（如果有）：
${(ctx.runLogs as string | undefined)?.slice(0, 4000) ?? "(无)"}

问：本次任务中有什么值得沉淀到知识库的教训 / 规则 / 决策 / 事实？`;
    case "issue_reopened":
      return `场景：一个本已 done 的 issue 被重新打开了（从 ${ctx.previousStatus ?? "?"} → ${ctx.status ?? "?"}）。这通常意味着上次"完成"是错的。

Issue 信息：
${safeJson({ title: ctx.title, description: ctx.description })}

最近评论：
${safeJson(ctx.comments ?? [])}

问：reopen 暴露了什么应该记下的教训或规则？（避免下次"假完成"）`;
    case "approval_rejected":
      return `场景：一个 approval 被驳回。

Approval 上下文：
${safeJson(ctx)}

问：驳回理由揭示了什么需要沉淀的规则 / 教训 / 决策？`;
    case "run_cancelled":
      return `场景：Agent run 被取消或超时。

Run 上下文：
${safeJson(ctx)}

问：取消 / 超时 暴露了什么应该记下的教训或规则？（避免再次卡住）`;
  }
}

/** kind → source 字符串映射（写入 knowledge_drafts.source） */
function sourceForKind(kind: KnowledgeDrafterTriggerKind): "agent_self_review" | "failure_signal" {
  return kind === "task_complete" ? "agent_self_review" : "failure_signal";
}

/**
 * 知识 Drafter 服务（Phase 1b-1）。
 *
 * 触发方（issues route / approval service / heartbeat）以 fire-and-forget
 * 方式调用 run(trigger)；失败被 catch 后仅记录 warning，不影响主流程。
 *
 * 内部串行：
 *   1. 选 prompt 模板（kind）→ 渲染 context 进 user prompt
 *   2. 调 LLM completeChat({ jsonMode: true })
 *   3. 截 ```json 围栏 + JSON.parse；envelope schema 校验
 *   4. 对每个 element 用 llmDraftSchema 校验；非法的跳过
 *   5. 对每个有效 draft 调 knowledgeDraftService.create()
 *   6. 返回 draftIds + 可能的 error
 *
 * 任何 step 失败 → draftIds 空 + error 字符串。**不抛**，交给调用方 catch。
 */
export function knowledgeDrafterService(db: Db, llm: DrafterChatClient) {
  const drafts = knowledgeDraftService(db);

  return {
    async run(trigger: KnowledgeDrafterTrigger): Promise<KnowledgeDrafterResult> {
      let completion: string;
      try {
        completion = await llm.completeChat({
          system: SYSTEM_PROMPT,
          user: renderUserPrompt(trigger),
          jsonMode: true,
          temperature: 0.2,
        });
      } catch (err) {
        return { draftIds: [], error: err instanceof Error ? err.message : String(err) };
      }

      // 剥 ```json ... ``` 围栏（DashScope 等 endpoint 即使 jsonMode 也偶尔加）
      const stripped = completion.replace(/^```(?:json)?\s*\n?/i, "").replace(/```\s*$/, "").trim();

      let envelope: unknown;
      try {
        envelope = JSON.parse(stripped);
      } catch (err) {
        return { draftIds: [], error: `json parse failed: ${(err as Error).message}` };
      }

      const parsed = llmEnvelopeSchema.safeParse(envelope);
      if (!parsed.success) {
        return { draftIds: [], error: `envelope schema mismatch: ${parsed.error.message}` };
      }

      // 准备 actor —— drafter 的写入身份。trigger.agentId / userId 二选一。
      // 当两者都缺时（理论不该发生），用 system user 兜底。
      const actor: KnowledgeDraftActor =
        trigger.userId != null
          ? { type: "user", userId: trigger.userId, isAdmin: false }
          : trigger.agentId != null
            ? { type: "agent", agentId: trigger.agentId, runId: trigger.runId ?? null }
            : { type: "user", userId: "system", isAdmin: false };

      const draftIds: string[] = [];
      for (const rawDraft of parsed.data.drafts) {
        const draftParsed = llmDraftSchema.safeParse(rawDraft);
        if (!draftParsed.success) continue; // 静默跳过非法条目

        const d = draftParsed.data;
        try {
          const created = await drafts.create({
            companyId: trigger.companyId,
            actor,
            payload: {
              title: d.title,
              content: d.content,
              type: d.type,
              level: d.level ?? "project",
              business_domain_name: d.business_domain_name ?? "general",
              metadata: d.metadata ?? {},
              volatility: d.volatility,
              confidence: d.confidence,
              source: sourceForKind(trigger.kind),
              source_issue_id: trigger.issueId ?? null,
              source_run_id: trigger.runId ?? null,
              skip_review: false,
              valid_until: null,
              target_node_id: null,
            },
          });
          draftIds.push(created.id);
        } catch {
          // 单条失败不阻塞其余（如业务域不存在等）；继续下一条
          continue;
        }
      }

      return { draftIds };
    },
  };
}

export type KnowledgeDrafterService = ReturnType<typeof knowledgeDrafterService>;
```

### Step 4: 跑测试 verify pass

Run: `cd D:\aiprojects\paperclip\server && npx vitest run knowledge-drafter`
Expected: 7/7 PASS。

### Step 5: 加 service barrel

在 `server/src/services/index.ts` 已有 `export { knowledgeNodeWriterService...` 之后追加：

```typescript
export {
  knowledgeDrafterService,
  type KnowledgeDrafterService,
  type KnowledgeDrafterTrigger,
  type KnowledgeDrafterTriggerKind,
  type DrafterChatClient,
} from "./knowledge-drafter.js";
```

### Step 6: 跑全部 knowledge 测试

Run: `cd D:\aiprojects\paperclip\server && npx vitest run knowledge`
Expected: 全过（26 个旧 + 5 个 llm-wiki + 7 个 drafter = 38）。

### Step 7: Commit

```bash
git add server/src/services/knowledge-drafter.ts server/src/services/knowledge-drafter.test.ts server/src/services/index.ts
git commit -m "feat(llm-wiki): add knowledgeDrafterService — LLM extracts drafts from triggers (Phase 1b-1)"
```

---

## Task 3: Path A wiring —— `routes/issues.ts` 在 status → done 时触发

**Files:**
- Modify: `D:\aiprojects\paperclip\server\src\routes\issues.ts`
- Modify: `D:\aiprojects\paperclip\server\src\app.ts`（构造 drafter 实例并传给 issueRoutes）

注：issueRoutes 已经接收 `(db, storage, opts)` 的工厂签名。本 Task 在 opts 加一个可选 `knowledgeDrafter` 字段，注入 drafter 实例。**Path B-1（issue.reopened）的代码顺手在同一处加，因为是同一个 status 变更点。**

### Step 1: 在 `issueRoutes` 工厂签名加 opts 字段

在 `D:\aiprojects\paperclip\server\src\routes\issues.ts` 顶部找到 `export function issueRoutes(...)`，定位它的 opts 参数 type（应该是个 inline object 或单独 interface）：

```bash
grep -n "export function issueRoutes" server/src/routes/issues.ts | head
```

打开那一行，假设签名是：

```typescript
export function issueRoutes(
  db: Db,
  storage: StorageService | undefined,
  opts: { feedbackExportService?: ...; pluginWorkerManager?: ... } = {},
) {
```

把 opts 类型加一个字段 `knowledgeDrafter?: KnowledgeDrafterService`：

```typescript
import { type KnowledgeDrafterService } from "../services/knowledge-drafter.js";

export function issueRoutes(
  db: Db,
  storage: StorageService | undefined,
  opts: {
    feedbackExportService?: ...;
    pluginWorkerManager?: ...;
    knowledgeDrafter?: KnowledgeDrafterService;
  } = {},
) {
  const drafter = opts.knowledgeDrafter;
  ...
}
```

如果 issueRoutes 已经从 `services/index.js` 引入了一堆 service，把 KnowledgeDrafterService 加进去更整洁；以上是最小变更示意。

### Step 2: 在 PATCH /issues/:id 处理完后追加触发逻辑

在 `routes/issues.ts:2698-2730` 之间，定位到 `issue = await svc.update(id, {...})` 之后、`if (!issue) { ... 404 }` 之后、`let cancelledStatusRunId` 之前。**新增一段 fire-and-forget 调用**：

```typescript
    // Phase 1b-1: 知识 drafter 异步触发（task_complete + issue_reopened）
    // - status 从非 done 变 done → Path A
    // - status 从 done/cancelled 变 in_progress/open → Path B issue_reopened
    if (drafter) {
      const prev = existing.status;
      const next = issue.status;
      const becameDone = prev !== "done" && next === "done";
      const wasReopened =
        (prev === "done" || prev === "cancelled") &&
        (next === "in_progress" || next === "open");

      if (becameDone || wasReopened) {
        const trigger: import("../services/knowledge-drafter.js").KnowledgeDrafterTrigger = {
          kind: becameDone ? "task_complete" : "issue_reopened",
          companyId: issue.companyId,
          issueId: issue.id,
          agentId: issue.assigneeAgentId ?? actor.agentId ?? null,
          userId: actor.actorType === "user" ? actor.actorId : null,
          context: {
            title: issue.title,
            description: issue.description,
            status: next,
            previousStatus: prev,
            // 注：评论 / runLogs 留给 Phase 1b 后续优化获取；本期 context 简单
          },
        };
        void drafter.run(trigger).catch((err) => {
          logger.warn(
            { err, trigger: trigger.kind, issueId: issue.id },
            "knowledge drafter failed",
          );
        });
      }
    }
```

> **检查变量名**：上面的 `existing.status` 假定该 endpoint 已经在更新前读了一份旧 issue（变量名 `existing`）。打开文件 grep `const existing = ` 在 PATCH handler 内确认；如果变量叫别的（如 `currentIssue` / `issueBefore`），改为实际名字。**这一步必须根据文件实际改名。** 如果该 handler 没有先读旧值，跳过此实现并 report BLOCKED —— 告诉协调员需要先读 existing 才能判定 status 变化。

> **logger 引入**：handler 文件顶部应已 `import { logger } from "../middleware/logger.js"`。若没有，加上。

### Step 3: 修 typecheck

Run: `cd D:\aiprojects\paperclip && pnpm --filter @paperclipai/server typecheck`
Expected: 无 issues.ts / app.ts 相关新错（pre-existing aws-secrets-manager 错忽略）。

### Step 4: 在 app.ts 构造 drafter 并传入

在 `server/src/app.ts` 找到现有 `api.use(issueRoutes(db, opts.storageService, { ... }));`（约 line 195-198）。在该行**前**新增构造 drafter：

```typescript
  // Phase 1b-1: 知识 drafter（LLM 自评 / 失败信号抽取）。复用 llmWikiService 做 LLM 调用。
  const llmWikiClient = llmWikiService(db);
  const knowledgeDrafter = knowledgeDrafterService(db, llmWikiClient);
```

`llmWikiService` 和 `knowledgeDrafterService` 都需要从 `./services/index.js` 引入；如果还没在文件顶部 import，加上。

然后改 `issueRoutes(...)` 调用：

```typescript
  api.use(issueRoutes(db, opts.storageService, {
    feedbackExportService: opts.feedbackExportService,
    pluginWorkerManager: workerManager,
    knowledgeDrafter,  // ← 加这一行
  }));
```

### Step 5: 验证现有 issue 单测仍过

Run: `cd D:\aiprojects\paperclip\server && npx vitest run issues`
Expected: 无 regression（drafter 是可选注入，未设置时 wiring 走旧路径）。

### Step 6: Commit

```bash
git add server/src/routes/issues.ts server/src/app.ts
git commit -m "feat(llm-wiki): wire knowledgeDrafter into PATCH /issues — Path A + Path B issue_reopened (Phase 1b-1)"
```

---

## Task 4: Path B-2 wiring —— `services/approvals.ts` 在 reject 时触发

**Files:**
- Modify: `D:\aiprojects\paperclip\server\src\services\approvals.ts`
- Modify: `D:\aiprojects\paperclip\server\src\routes\approvals.ts`（透传 drafter）
- Modify: `D:\aiprojects\paperclip\server\src\app.ts`（传给 approvalService 或 approvalRoutes）

approval reject 的最简插桩点是 service 层（`reject()` 内 DB 写完 → fire drafter）。需要给 `approvalService` 加 drafter 注入参数。

### Step 1: 修改 approvalService 工厂签名

打开 `server/src/services/approvals.ts`，找到 `export function approvalService(db: Db)`，把签名改为可选注入 drafter：

```typescript
import { type KnowledgeDrafterService } from "./knowledge-drafter.js";
import { logger } from "../middleware/logger.js";

export function approvalService(db: Db, opts: { knowledgeDrafter?: KnowledgeDrafterService } = {}) {
  const drafter = opts.knowledgeDrafter;
  // ... 现有实现
}
```

### Step 2: 在 reject() DB 写完之后调 drafter

找到 `reject: async (id, decidedByUserId, decisionNote)` 方法（约 line 183-201），在 `return { approval: updated, applied };` 之前插：

```typescript
      // Phase 1b-1: 失败信号 — 异步抽教训
      if (drafter && applied) {
        const trigger: import("./knowledge-drafter.js").KnowledgeDrafterTrigger = {
          kind: "approval_rejected",
          companyId: updated.companyId,
          approvalId: updated.id,
          userId: decidedByUserId,
          context: {
            type: updated.type,
            decisionNote: decisionNote ?? null,
            payload: updated.payload,
          },
        };
        void drafter.run(trigger).catch((err) => {
          logger.warn(
            { err, approvalId: updated.id },
            "knowledge drafter (approval_rejected) failed",
          );
        });
      }
```

### Step 3: 找 approvalService 的调用方并传 drafter

`approvalService` 在 server 里通常在 `routes/approvals.ts` 构造。打开文件：

```bash
grep -rn "approvalService(db" server/src/routes/approvals.ts server/src/app.ts 2>/dev/null
```

如果 service 在 routes 里构造（典型）：

```typescript
// 旧：
const svc = approvalService(db);
// 新：
const svc = approvalService(db, { knowledgeDrafter: opts.knowledgeDrafter });
```

并在 `approvalRoutes(...)` 工厂签名上加 opts.knowledgeDrafter（参照 Task 3 同样模式）。

### Step 4: app.ts 改 approvalRoutes 调用

把构造好的 `knowledgeDrafter` 传给 `approvalRoutes(...)`：

```typescript
api.use(approvalRoutes(db, { pluginWorkerManager: workerManager, knowledgeDrafter }));
```

### Step 5: 跑现有 approval 测试

Run: `cd D:\aiprojects\paperclip\server && npx vitest run approval`
Expected: 无 regression。

### Step 6: Commit

```bash
git add server/src/services/approvals.ts server/src/routes/approvals.ts server/src/app.ts
git commit -m "feat(llm-wiki): wire knowledgeDrafter into approvalService.reject() — Path B approval_rejected (Phase 1b-1)"
```

---

## Task 5: Path B-3 wiring —— `services/heartbeat.ts` 在 run cancel 时触发

**Files:**
- Modify: `D:\aiprojects\paperclip\server\src\services\heartbeat.ts`
- Modify: `D:\aiprojects\paperclip\server\src\app.ts`（如有需要，传 drafter）

heartbeat.ts 在 `publishRunLifecyclePluginEvent(run)`（line 3733-3769）已经处理 cancel 分支的事件发布。直接在 `cancelled` 分支后追加 drafter 调用。

### Step 1: heartbeatService 工厂签名加 opts.knowledgeDrafter

打开 `server/src/services/heartbeat.ts`。找到 `export function heartbeatService(db: Db, ...)` — 这是个大型 service，签名复杂，注入可能要走更内部的对象。先 grep 工厂签名：

```bash
grep -n "export function heartbeatService" server/src/services/heartbeat.ts
```

把 drafter 加进 service 工厂的 opts 参数（沿用 approvalService 同模式）。**如果 heartbeatService 现有签名实在改不动**（如已有 5+ 个依赖、deep service chain），可考虑做**最小侵入方案**：把 drafter 存到一个模块级变量，提供 `setKnowledgeDrafterForHeartbeat(drafter)` 函数在 app.ts 启动时设置。这是次优但可接受的 fallback。

### Step 2: 在 cancelled 分支后追加 drafter 调用

定位 `publishRunLifecyclePluginEvent` 函数（line 3733）。在 `publishPluginDomainEvent({ ... })` 调用之后、函数结尾 `}` 之前，追加：

```typescript
    // Phase 1b-1: run cancelled / timed_out 时 fire-and-forget 知识 drafter
    if (drafter && (run.status === "cancelled" || run.status === "timed_out")) {
      const trigger: import("./knowledge-drafter.js").KnowledgeDrafterTrigger = {
        kind: "run_cancelled",
        companyId: run.companyId,
        runId: run.id,
        agentId: run.agentId,
        issueId:
          typeof run.contextSnapshot === "object" && run.contextSnapshot !== null
            ? ((run.contextSnapshot as Record<string, unknown>).issueId as string | null | undefined) ?? null
            : null,
        context: {
          status: run.status,
          invocationSource: run.invocationSource,
          triggerDetail: run.triggerDetail,
          error: run.error ?? null,
          errorCode: run.errorCode ?? null,
        },
      };
      void drafter.run(trigger).catch((err) => {
        logger.warn(
          { err, runId: run.id },
          "knowledge drafter (run_cancelled) failed",
        );
      });
    }
```

`drafter` 变量来源：Step 1 注入的 opts 字段（或模块变量 fallback）。`logger` 已在 heartbeat.ts 引入。

### Step 3: app.ts 改 heartbeatService 构造

定位 `heartbeatService(db, ...)` 在 app.ts 中的调用（搜一下，可能在 `routes/issues.ts` 或在 `app.ts` 直接构造再传入 routes）。把 drafter 加进 opts。

### Step 4: 跑现有 heartbeat 测试

Run: `cd D:\aiprojects\paperclip\server && npx vitest run heartbeat`
Expected: 无 regression。

### Step 5: Commit

```bash
git add server/src/services/heartbeat.ts server/src/app.ts
git commit -m "feat(llm-wiki): wire knowledgeDrafter into heartbeat cancel — Path B run_cancelled (Phase 1b-1)"
```

---

## Task 6: 端到端 smoke checklist + CHANGELOG

**Files:**
- Create: `D:\aiprojects\paperclip\docs\superpowers\plans\2026-05-13-llm-wiki-phase-1b-1-smoke.md`

手动 smoke 验证 3 个触发路径。不写 CI 集成测，因为 drafter 真跑要消耗 LLM 配额。

### Step 1: 写 smoke checklist 文档

写入 `docs/superpowers/plans/2026-05-13-llm-wiki-phase-1b-1-smoke.md`：

```markdown
# LLM-Wiki Phase 1b-1 — End-to-End Smoke Checklist

需 docker（pgvector）+ 有效 OPENAI_API_KEY + Phase 1a smoke 已通过（库里有 company + business_domains.general）。

## 前置

```bash
docker compose up -d db
pnpm db:migrate
OPENAI_API_KEY=sk-... OPENAI_BASE_URL=... OPENAI_CHAT_MODEL=qwen-plus pnpm dev
```

## 4 个 trigger case

### Path A: issue → done

```bash
COMPANY_ID=<existing-company-uuid>

# 1. 建 issue
ISSUE_ID=$(curl -s -X POST "http://localhost:3100/api/issues?companyId=$COMPANY_ID" \
  -H "Content-Type: application/json" \
  -d '{"title":"Smoke 1b-1 issue","description":"测试 task_complete 触发"}' \
  | jq -r .id)

# 2. 标 done
curl -X PATCH "http://localhost:3100/api/issues/$ISSUE_ID?companyId=$COMPANY_ID" \
  -H "Content-Type: application/json" -d '{"status":"done"}'

# 3. 等 2 秒（异步 LLM）后查 drafts
sleep 3
curl "http://localhost:3100/api/knowledge/drafts?companyId=$COMPANY_ID&source=agent_self_review"
```

期望：drafts 列表至少 1 条，`source=agent_self_review`，`source_issue_id=$ISSUE_ID`。

### Path B-1: issue 被 reopen

```bash
# 续上面：把刚才 done 的 issue 改回 in_progress
curl -X PATCH "http://localhost:3100/api/issues/$ISSUE_ID?companyId=$COMPANY_ID" \
  -H "Content-Type: application/json" -d '{"status":"in_progress"}'

sleep 3
curl "http://localhost:3100/api/knowledge/drafts?companyId=$COMPANY_ID&source=failure_signal"
```

期望：drafts 列表至少 1 条，`source=failure_signal`。

### Path B-2: approval rejected

```bash
# 假设已有一个 pending approval（手动建一个）
APPROVAL_ID=$(curl -s -X POST "http://localhost:3100/api/approvals?companyId=$COMPANY_ID" \
  -H "Content-Type: application/json" \
  -d '{"type":"deploy","payload":{"scope":"test"}}' | jq -r .id)

curl -X POST "http://localhost:3100/api/approvals/$APPROVAL_ID/reject?companyId=$COMPANY_ID" \
  -H "Content-Type: application/json" -d '{"decisionNote":"too risky"}'

sleep 3
curl "http://localhost:3100/api/knowledge/drafts?companyId=$COMPANY_ID&source=failure_signal" | jq '.data[] | select(.proposed_content | contains("risky"))'
```

期望：找到一条相关 draft。

### Path B-3: run cancel

```bash
# 找一个 running 的 run，cancel 它
RUN_ID=<pick-from-/api/heartbeat>
curl -X POST "http://localhost:3100/api/heartbeat/runs/$RUN_ID/cancel?companyId=$COMPANY_ID"

sleep 3
curl "http://localhost:3100/api/knowledge/drafts?companyId=$COMPANY_ID&source=failure_signal" | jq '.data[] | select(.source_run_id == "'$RUN_ID'")'
```

期望：找到 0-N 条（drafter 觉得没什么可记的会输出空数组，那也是正常）。

## 反向验证

- LLM 不可达（key 错或 base url 错）：dev.log 出现 `knowledge drafter failed` warning，主业务流程不受阻
- 配 invalid model：同上
- 缺 OPENAI_API_KEY：drafter 报 warning，主流程不阻塞

3/3 主路径触发 + drafter 失败不影响主流程 → Phase 1b-1 完成。
```

### Step 2: Commit

```bash
git add docs/superpowers/plans/2026-05-13-llm-wiki-phase-1b-1-smoke.md
git commit -m "docs(llm-wiki): Phase 1b-1 smoke checklist"
```

---

## End-to-end Verification

```bash
# 1. 全部单测过
cd D:/aiprojects/paperclip/server && npx vitest run knowledge
#   预期：38 个全过（26 旧 + 5 llm-wiki + 7 drafter）

# 2. typecheck 干净（除 pre-existing aws-secrets-manager 外）
pnpm --filter @paperclipai/server typecheck

# 3. dev 起立
pnpm dev &
curl -sf http://127.0.0.1:3100/api/health

# 4. 4 个 trigger 路径手测（Task 6 smoke checklist）
```

≥ 4/4 通过 → Phase 1b-1 完成，可开 Phase 1b-2（Path C plugin）。

---

## 顺序依赖

```
Task 0 (sources widening)
  ↓
Task 1 (completeChat) ──┐
                        ↓
                    Task 2 (drafter service)
                        ↓
            ┌───────────┼────────────┐
            ↓           ↓            ↓
        Task 3       Task 4       Task 5
        (Path A+B-1) (Path B-2)   (Path B-3)
            ↓           ↓            ↓
            └───────────┼────────────┘
                        ↓
                    Task 6 (smoke + docs)
```

Task 3 / 4 / 5 互相独立可并行（subagent-driven 模式可同时分派，但需小心 app.ts 的 merge 冲突 —— 串行更稳妥）。

---

## 不在本次范围（明确划线）

- ❌ Path C：Agent tool plugin `propose_knowledge_node`（Phase 1b-2 单独 plan）
- ❌ `commit.reverted` 第 4 个事件（无 git webhook 基建，Phase 5）
- ❌ Drafter 失败重试 / 持久化 retry queue（Phase 3）
- ❌ Reviewer Agent pre_verdict 填充（Phase 3）
- ❌ 业务域智能推断（issue 标签 / 项目元数据 → domain）；本期全丢 `general`
- ❌ requestRevision 自动开 issue（Phase 1a TODO 单独跟进）
- ❌ Drafter 真集成测（hit 真 LLM 太贵）—— mock-only 单测 + 手动 smoke
- ❌ Run logs / Issue comments 拉取（context 简化为可拿到的最小字段；下一波再加）

---

## 风险与备注

1. **LLM 配额成本**：4 个触发点 × N 次/天 ≈ 几百次 chat completion。用 DashScope `qwen-turbo` 成本极低（< ¥1/天）；OpenAI 官方 `gpt-4o-mini` 也不贵。要监控 budget。
2. **drafter 输出质量**：jsonMode + 严格 schema + 静默跳过非法条目能挡住绝大多数烂输出。LLM 偶尔返回空 envelope 是正常的（这次触发没什么可记的）。
3. **fire-and-forget 丢失**：dev server 重启时正在跑的 drafter 会丢失。Phase 3 retry queue 处理。本期不打补丁。
4. **status 变化判定竞态**：PATCH /issues 当前是事务内 update + 事务外触发 drafter。如果两个并发 PATCH 都把 status 从 in_progress 改 done，可能两次触发 drafter。drafter 内部对 issue 字段重复并不致命（会产生重复 draft），人工审查时去重即可。Phase 3 演化引擎合并提案可处理。
5. **heartbeat.ts 改动风险**：那个文件很大很复杂。Task 5 实施时要仔细——如果 service 工厂签名实在改不动就用模块变量 fallback，但要在 commit message 标 TODO。
6. **app.ts 顺序敏感**：drafter 必须在 issueRoutes / approvalRoutes / heartbeatService 构造之前 instantiate。Task 3 / 4 / 5 各自的 Step "在 app.ts" 都要确保 drafter 已存在；并行实施时容易出现 import 顺序冲突，串行实施更稳。
7. **Phase 1a 测试可能因 source enum 变化轻微调整**：Task 0 测试要先跑一遍确保 26 个 Phase 1a 单测不挂。
