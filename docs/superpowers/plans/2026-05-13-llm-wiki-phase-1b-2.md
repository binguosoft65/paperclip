# LLM-Wiki Phase 1b-2 — Agent tool plugin (Path C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 PRD §6 FR4 §4.3 的 Path C —— Agent 显式调用 `propose_knowledge_node` 工具主动写知识 draft。在 plugin-sdk 加 `ctx.knowledge.proposeDraft()` 原生 API（跟 `ctx.issues.create()` 对称），新建 first-party plugin `paperclip-plugin-knowledge-engine` 注册该工具。工具 handler 内部通过 host bridge 调用 Phase 1a 的 `knowledgeDraftService.create()` 写 draft（source=`manual`）。

**Architecture:** 三层：
1. **plugin-sdk**：新增 `knowledge.proposeDraft` JSON-RPC method + `PluginKnowledgeClient` interface + worker-side proxy + `knowledge.draft.create` capability
2. **server host bridge**：plugin-host-services.ts 加 `knowledge` 块实现 `proposeDraft` handler，复用 Phase 1a 的 `knowledgeDraftService.create()`
3. **plugin worker**：新建 `packages/plugins/paperclip-plugin-knowledge-engine/`，manifest 声明 `propose_knowledge_node` tool + 必要 capabilities，worker 调用 `ctx.knowledge.proposeDraft()`

跟 Path A/B (1b-1) 不同：Path C 不调 LLM，Agent 已经把结构化 draft 直接塞参数里。**source=manual** 区分人手动写入和 Agent 主动提交。

**Tech Stack:** TypeScript + plugin-sdk JSON-RPC + Vitest mock-only tests。Plugin 构建用现有 tsc 配置。

---

## Context（执行者须读）

### 已确认的现有架构（4 个 Explore 报告 + 本对话补充）

**plugin-sdk 现状：**
- `protocol.ts` 的 `WorkerToHostMethods` 是大 type literal，每个 method 形如 `"issues.create": [params, result]`
- `host-client-factory.ts` 的 `HostServices` interface 声明 host 端要实现哪些 method；`METHOD_TO_CAPABILITY` 表把 method → capability 字符串
- `worker-rpc-host.ts` 的 `assemblePluginContext()` 构造实际 `ctx.{xxx}` 客户端，每个方法都是 `callHost("name.subname", params)` 代理
- `types.ts` 的 `PluginContext` interface 是用户可见的 API 形态，`{xxx}: PluginXxxClient` 一对一映射

**Plugin 包结构（参照 hello-world-example）：**
```
packages/plugins/<name>/
├── package.json        # 含 paperclipPlugin: { manifest, worker, ui? }
├── tsconfig.json
├── src/
│   ├── manifest.ts     # export default PaperclipPluginManifestV1
│   ├── worker.ts       # definePlugin({setup(ctx){...}}); runWorker(plugin, import.meta.url);
│   └── index.ts        # re-exports manifest 和 worker
└── dist/               # tsc 构建产物（gitignored）
```

**Plugin 注册到 dev：**
- `server/src/routes/plugins.ts:156-189` 的 `BUNDLED_PLUGIN_EXAMPLES` 数组
- 用户通过 UI 或 API 触发安装该 plugin

**Phase 1a 现有：**
- `knowledgeDraftService(db)` 已实现 `create(input)`（接受 `companyId`, `actor`, `payload`）
- `actor` 是 `KnowledgeDraftActor` 联合类型：`{type:"user", userId, isAdmin}` 或 `{type:"agent", agentId, runId?}`
- payload 字段对照 `createKnowledgeDraftSchema`（packages/shared/src/validators/knowledge.ts）：`title / content / type / level / business_domain_name / metadata / volatility / valid_until / confidence / source / source_run_id / source_issue_id / skip_review / target_node_id`

**Phase 1b-1 现有：**
- `KNOWLEDGE_DRAFT_SOURCES = ["manual", "agent_self_review", "failure_signal"]`
- Path C 用 `source = "manual"`（Agent 主动写入，跟人工 REST 调用语义一致）

### Wire shape 早锁定

`ctx.knowledge.proposeDraft()` 接收的参数（worker → host RPC body）：

```typescript
{
  companyId: string;
  title: string;
  content: string;
  type: "concept" | "lesson" | "rule" | "decision" | "fact";
  level: "personal" | "project" | "company";
  business_domain_name: string;       // slug, 默认 "general"
  confidence?: number;                 // 0-1, default 0.5
  volatility?: "stable" | "slow" | "fast";
  valid_until?: string | null;         // ISO date string
  used_for?: string[];                 // metadata convenience
  metadata?: Record<string, unknown>;
  target_node_id?: string | null;      // null = 新建, otherwise update
  source_issue_id?: string | null;     // 关联 issue（runCtx 注入）
  source_run_id?: string | null;       // 关联 run（runCtx 注入）
  // 注：actor 由 host 侧根据当前 plugin worker 调用上下文自动构造（agent 类型）
  //   plugin 不能伪造 agentId
}
```

返回：

```typescript
{
  id: string;                          // draft 的 UUID
  status: "pending" | "approved" | ... // 初始 pending
  preVerdict: string | null;           // 总是 null（Reviewer Agent 在 Phase 3 才填）
}
```

**关键设计**：tool handler 收到 `runCtx: { agentId, runId, companyId, projectId }`（plugin 系统注入），把它们映射到 `proposeDraft({companyId: runCtx.companyId, source_run_id: runCtx.runId, ...})`。Plugin 不需要也不能伪造身份。

### 范围边界（明确不做的）

- ❌ `propose_knowledge_node` 之外的其他知识工具（`search_knowledge_base`, `submit_feedback` 等）—— Phase 2/3
- ❌ Plugin UI（dashboard widget / settings page）—— 非 MVP
- ❌ Plugin 多语言 / 帮助文档 i18n —— 后期
- ❌ Plugin 配置项（OpenAI key 等）—— host 已经管
- ❌ `requestRevision` 自动开 issue（Phase 1a 遗留 TODO，不在本 phase）
- ❌ embedding 真集成测试（mock-only 单测 + 手动 smoke）
- ❌ 把现有 plugin 改成内置启动（仍走 BUNDLED_PLUGIN_EXAMPLES 模式让用户手动 install）

### File Structure（一表锁定）

| 文件 | 责任 | 状态 |
|---|---|---|
| `packages/plugins/sdk/src/protocol.ts` | 加 `"knowledge.proposeDraft"` 到 `WorkerToHostMethods` | 修改 |
| `packages/plugins/sdk/src/host-client-factory.ts` | `HostServices` 加 `knowledge:` 字段 + `METHOD_TO_CAPABILITY` 加映射 | 修改 |
| `packages/plugins/sdk/src/types.ts` | 加 `PluginKnowledgeClient` interface + `PluginContext.knowledge` 字段 | 修改 |
| `packages/plugins/sdk/src/worker-rpc-host.ts` | `assemblePluginContext()` 加 `knowledge: { proposeDraft: ... }` 代理 | 修改 |
| `server/src/services/plugin-capability-validator.ts` | 加 `"knowledge.draft.create"` 到有效 capabilities 列表 | 修改 |
| `server/src/services/plugin-host-services.ts` | `buildHostServices()` 返回对象加 `knowledge: { async proposeDraft(...) {...} }` | 修改 |
| `server/src/services/plugin-host-services.test.ts` 或新建 | 单测 knowledge.proposeDraft handler（mock knowledgeDraftService）| **新建**（或加 case） |
| `packages/plugins/paperclip-plugin-knowledge-engine/package.json` | 新 plugin 包 manifest | **新建** |
| `packages/plugins/paperclip-plugin-knowledge-engine/tsconfig.json` | TS 配置（参照 hello-world） | **新建** |
| `packages/plugins/paperclip-plugin-knowledge-engine/src/manifest.ts` | Plugin manifest，声明 `propose_knowledge_node` tool + capabilities | **新建** |
| `packages/plugins/paperclip-plugin-knowledge-engine/src/worker.ts` | Plugin worker，注册 tool 调 ctx.knowledge.proposeDraft | **新建** |
| `packages/plugins/paperclip-plugin-knowledge-engine/src/index.ts` | Re-export | **新建** |
| `server/src/routes/plugins.ts` | `BUNDLED_PLUGIN_EXAMPLES` 加新条目 | 修改 |
| `docs/superpowers/plans/2026-05-13-llm-wiki-phase-1b-2-smoke.md` | 手动 smoke checklist | **新建** |

---

## Task 0: 加 `knowledge.proposeDraft` 到 protocol.ts

**Files:**
- Modify: `D:\aiprojects\paperclip\packages\plugins\sdk\src\protocol.ts`

### Step 1: 找到 `WorkerToHostMethods` interface 的末尾

Run: `grep -n "interface WorkerToHostMethods\|^}" D:/aiprojects/paperclip/packages/plugins/sdk/src/protocol.ts | head -5`

预期：`interface WorkerToHostMethods {` 起始约 line 573，闭合 `}` 约 line 1100。

### Step 2: 在 interface 内部加新 method

在 `WorkerToHostMethods` interface 的末尾（最后一个已存在 method 之后、闭合 `}` 之前）追加：

```typescript
  /**
   * knowledge.proposeDraft — Plugin 提交知识 draft（写入 knowledge_drafts 表，source=manual）。
   * 由 Paperclip LLM-Wiki Phase 1b-2 引入，给 Agent 显式调用 propose_knowledge_node 工具用。
   */
  "knowledge.proposeDraft": [
    params: {
      companyId: string;
      title: string;
      content: string;
      type: "concept" | "lesson" | "rule" | "decision" | "fact";
      level: "personal" | "project" | "company";
      business_domain_name: string;
      confidence?: number;
      volatility?: "stable" | "slow" | "fast";
      valid_until?: string | null;
      used_for?: string[];
      metadata?: Record<string, unknown>;
      target_node_id?: string | null;
      source_issue_id?: string | null;
      source_run_id?: string | null;
    },
    result: {
      id: string;
      status: string;
      preVerdict: string | null;
    },
  ];
```

### Step 3: 构建 SDK

```bash
pnpm --filter @paperclipai/plugin-sdk build
```

Expected: 无 TS 错。

### Step 4: Commit

```bash
git add packages/plugins/sdk/src/protocol.ts
git commit -m "feat(plugin-sdk): add knowledge.proposeDraft RPC method to WorkerToHostMethods (Phase 1b-2)"
```

---

## Task 1: HostServices interface + capability map + PluginContext type

**Files:**
- Modify: `D:\aiprojects\paperclip\packages\plugins\sdk\src\host-client-factory.ts`
- Modify: `D:\aiprojects\paperclip\packages\plugins\sdk\src\types.ts`

### Step 1: HostServices interface 加 `knowledge` 字段

在 `D:\aiprojects\paperclip\packages\plugins\sdk\src\host-client-factory.ts` 的 `HostServices` interface（line 87-247）末尾、在 `goals: { ... }` 块之后、闭合 `}` 之前追加：

```typescript

  /** Provides `knowledge.proposeDraft`. Requires `knowledge.draft.create`. */
  knowledge: {
    proposeDraft(
      params: WorkerToHostMethods["knowledge.proposeDraft"][0],
    ): Promise<WorkerToHostMethods["knowledge.proposeDraft"][1]>;
  };
```

### Step 2: METHOD_TO_CAPABILITY map 加映射

在同文件 `METHOD_TO_CAPABILITY` 对象（约 line 297-416），在 `"goals.update": "goals.update",` 之后追加：

```typescript

  // Knowledge
  "knowledge.proposeDraft": "knowledge.draft.create",
```

### Step 3: 加 `PluginKnowledgeClient` interface 到 types.ts

在 `D:\aiprojects\paperclip\packages\plugins\sdk\src\types.ts` 的 `PluginGoalsClient`（用 grep 找）之后追加新 interface：

```typescript

/**
 * Knowledge draft client. Plugin tools 通过这个 API 把 Agent 主动写入的知识
 * 草稿提交到 Paperclip 的 LLM-Wiki 引擎（写 knowledge_drafts 表，source=manual）。
 *
 * Phase 1b-2 引入；后续 phase 可能扩展 search / feedback / verify 等方法。
 */
export interface PluginKnowledgeClient {
  /**
   * 提交一条 knowledge draft 到 review queue。actor 由 host 根据 plugin
   * worker 调用上下文自动构造，不接受 plugin 端伪造身份。
   */
  proposeDraft(input: {
    companyId: string;
    title: string;
    content: string;
    type: "concept" | "lesson" | "rule" | "decision" | "fact";
    level: "personal" | "project" | "company";
    business_domain_name: string;
    confidence?: number;
    volatility?: "stable" | "slow" | "fast";
    valid_until?: string | null;
    used_for?: string[];
    metadata?: Record<string, unknown>;
    target_node_id?: string | null;
    source_issue_id?: string | null;
    source_run_id?: string | null;
  }): Promise<{
    id: string;
    status: string;
    preVerdict: string | null;
  }>;
}
```

### Step 4: PluginContext 加 `knowledge` 字段

在同文件 `interface PluginContext { ... }` 末尾（在 `logger:` 之前，与 `goals:` 同区域），追加：

```typescript

  /** Submit knowledge drafts. Requires `knowledge.draft.create`. */
  knowledge: PluginKnowledgeClient;
```

### Step 5: 构建 + typecheck

```bash
pnpm --filter @paperclipai/plugin-sdk build
pnpm --filter @paperclipai/plugin-sdk typecheck
```

Expected: 无错。

### Step 6: Commit

```bash
git add packages/plugins/sdk/src/host-client-factory.ts packages/plugins/sdk/src/types.ts
git commit -m "feat(plugin-sdk): expose PluginKnowledgeClient on PluginContext (Phase 1b-2)"
```

---

## Task 2: Worker-side proxy 在 worker-rpc-host.ts

**Files:**
- Modify: `D:\aiprojects\paperclip\packages\plugins\sdk\src\worker-rpc-host.ts`

### Step 1: 找 `assemblePluginContext` 内 goals 段

Run: `grep -n "goals: {" D:/aiprojects/paperclip/packages/plugins/sdk/src/worker-rpc-host.ts`

定位到 worker-rpc-host.ts 中 ctx 对象组装处的 `goals: { ... }` 块。

### Step 2: 在 `goals:` 块之后追加 `knowledge:` 块

把以下 block 添加到 ctx 返回对象内（在 goals 块紧邻位置）：

```typescript

      knowledge: {
        async proposeDraft(input) {
          return callHost("knowledge.proposeDraft", {
            companyId: input.companyId,
            title: input.title,
            content: input.content,
            type: input.type,
            level: input.level,
            business_domain_name: input.business_domain_name,
            confidence: input.confidence,
            volatility: input.volatility,
            valid_until: input.valid_until,
            used_for: input.used_for,
            metadata: input.metadata,
            target_node_id: input.target_node_id,
            source_issue_id: input.source_issue_id,
            source_run_id: input.source_run_id,
          });
        },
      },
```

### Step 3: 也加到 testing.ts 的 mock context（如果有）

Run: `grep -n "issues: {" D:/aiprojects/paperclip/packages/plugins/sdk/src/testing.ts`

如果 testing.ts 有 mock ctx（grep 命中），加一个最小 `knowledge:` mock：

```typescript
      knowledge: {
        async proposeDraft(_input) {
          throw new Error("testing: ctx.knowledge.proposeDraft is not mocked by default");
        },
      },
```

如果没有 mock ctx（grep 不命中），跳过本 step。

### Step 4: 构建 SDK + 跑 SDK 单测

```bash
pnpm --filter @paperclipai/plugin-sdk build
pnpm --filter @paperclipai/plugin-sdk test
```

Expected: 全过（SDK 本身有 e2e fixture tests，不会因为加新 method 失败）。

### Step 5: Commit

```bash
git add packages/plugins/sdk/src/worker-rpc-host.ts packages/plugins/sdk/src/testing.ts
git commit -m "feat(plugin-sdk): worker-side proxy for ctx.knowledge.proposeDraft (Phase 1b-2)"
```

---

## Task 3: 加 `knowledge.draft.create` 到 capability validator

**Files:**
- Modify: `D:\aiprojects\paperclip\server\src\services\plugin-capability-validator.ts`

### Step 1: 找现有 capabilities 列表

Run: `grep -n "\"agent.tools.register\"\|\"issues.create\"\|VALID_CAPABILITIES\|knownCapabilities" D:/aiprojects/paperclip/server/src/services/plugin-capability-validator.ts`

预期找到一个 `as const` 字符串数组。

### Step 2: 加 `knowledge.draft.create`

在该数组中（按字母序或与同类 capability 相邻）加：

```typescript
  "knowledge.draft.create",
```

### Step 3: typecheck

```bash
pnpm --filter @paperclipai/server typecheck
```

Expected: 无新错（pre-existing aws-secrets-manager 错忽略）。

### Step 4: Commit

```bash
git add server/src/services/plugin-capability-validator.ts
git commit -m "feat(plugin-host): allow knowledge.draft.create capability (Phase 1b-2)"
```

---

## Task 4: Host bridge handler in plugin-host-services.ts + 单测

**Files:**
- Modify: `D:\aiprojects\paperclip\server\src\services\plugin-host-services.ts`
- Create: `D:\aiprojects\paperclip\server\src\__tests__\plugin-host-services-knowledge.test.ts`

### Step 1: 写失败测试（TDD）

新建 `D:\aiprojects\paperclip\server\src\__tests__\plugin-host-services-knowledge.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the knowledgeDraftService imported by plugin-host-services
const mockDraftCreate = vi.fn();
vi.mock("../services/knowledge-drafts.js", () => ({
  knowledgeDraftService: () => ({ create: mockDraftCreate }),
}));

// Mock other dependencies of buildHostServices we don't care about
// (we'll dynamic-import after mock setup so the module sees our mocks)
vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => ({
    getActiveCompaniesForPlugin: vi.fn().mockResolvedValue([{ companyId: "c-1" }]),
  }),
}));

// 其他依赖都不参与本测试的链路，但 buildHostServices 会 instantiate；用最小 stub。
vi.mock("../services/plugin-state-store.js", () => ({ pluginStateStore: () => ({}) }));
vi.mock("../services/plugin-database.js", () => ({ pluginDatabaseService: () => ({}) }));
vi.mock("../services/plugin-secrets.js", () => ({ createPluginSecretsHandler: () => ({}) }));
vi.mock("../services/companies.js", () => ({ companyService: () => ({}) }));
vi.mock("../services/agents.js", () => ({ agentService: () => ({}) }));
vi.mock("../services/plugin-managed-agents.js", () => ({ pluginManagedAgentService: () => ({}) }));
vi.mock("../services/plugin-managed-routines.js", () => ({ pluginManagedRoutineService: () => ({}) }));
vi.mock("../services/heartbeat.js", () => ({ heartbeatService: () => ({}) }));
vi.mock("../services/projects.js", () => ({ projectService: () => ({}) }));
vi.mock("../services/issues.js", () => ({ issueService: () => ({}) }));
vi.mock("../services/documents.js", () => ({ documentService: () => ({}) }));
vi.mock("../services/goals.js", () => ({ goalService: () => ({}) }));
vi.mock("../services/activity.js", () => ({ activityService: () => ({}) }));
vi.mock("../services/costs.js", () => ({ costService: () => ({}) }));
vi.mock("../services/budgets.js", () => ({ budgetService: () => ({}) }));
vi.mock("../services/issue-approvals.js", () => ({ issueApprovalService: () => ({}) }));
vi.mock("../services/assets.js", () => ({ assetService: () => ({}) }));

const fakeEventBus = { forPlugin: () => ({}) } as any;

describe("buildHostServices().knowledge.proposeDraft", () => {
  beforeEach(() => vi.clearAllMocks());

  it("调 knowledgeDraftService.create 并返回 {id, status, preVerdict}", async () => {
    mockDraftCreate.mockResolvedValueOnce({ id: "d-1", status: "pending", preVerdict: null });
    const { buildHostServices } = await import("../services/plugin-host-services.js");
    const services = buildHostServices({} as any, "plugin-id", "plugin-key", fakeEventBus);
    const result = await services.knowledge.proposeDraft({
      companyId: "c-1",
      title: "Agent proposed lesson",
      content: "Some content",
      type: "lesson",
      level: "project",
      business_domain_name: "general",
    });
    expect(result).toEqual({ id: "d-1", status: "pending", preVerdict: null });
    expect(mockDraftCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "c-1",
        payload: expect.objectContaining({
          title: "Agent proposed lesson",
          content: "Some content",
          type: "lesson",
          source: "manual",
          business_domain_name: "general",
        }),
      }),
    );
  });

  it("缺 companyId 时抛错（host 端校验）", async () => {
    const { buildHostServices } = await import("../services/plugin-host-services.js");
    const services = buildHostServices({} as any, "plugin-id", "plugin-key", fakeEventBus);
    await expect(
      services.knowledge.proposeDraft({
        companyId: "",
        title: "x",
        content: "y",
        type: "lesson",
        level: "project",
        business_domain_name: "general",
      }),
    ).rejects.toThrow(/companyId/);
  });
});
```

### Step 2: 跑测试 verify fail

```bash
cd D:\aiprojects\paperclip\server && npx vitest run plugin-host-services-knowledge
```

Expected: FAIL — `services.knowledge is undefined`。

### Step 3: 实现 host bridge handler

打开 `D:\aiprojects\paperclip\server\src\services\plugin-host-services.ts`。

**3a. 加 import**（near top，与其他 service import 同区域）：

```typescript
import { knowledgeDraftService } from "./knowledge-drafts.js";
```

**3b. 在 `buildHostServices` 内、`const issues = issueService(db);` 附近加：**

```typescript
  const knowledgeDrafts = knowledgeDraftService(db);
```

**3c. 在 `buildHostServices` 返回对象的 `goals: { ... }` 块之后、`dispose` 之前追加 `knowledge:` 块。**

定位提示：search `issues: {` 找到 issues 块，结构作为参考。在所有 service 块（issues / agents / goals / ...）之后追加：

```typescript

    knowledge: {
      async proposeDraft(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);

        // Plugin 调用时身份固定为 agent；host 不接受 plugin 伪造 actor
        // pluginKey 用作 actor 追溯（写入 sourceAgentId 字段时无 agent UUID，
        // 改写到 sourceUserId 字段会 FK 失败 —— 这里设计上用 agent 类型 +
        // 真实 agent UUID（从 source_run_id 关联推断），如果不可得则
        // fallback 写 manual + system 跟 Phase 1b-1 一致语义）。
        //
        // Phase 1b-2 简化：把所有 plugin 写入当 manual + 不写 source_agent_id；
        // 这样 FK 安全，且审查队列里能通过 source_run_id 反查关联 run。
        const actor = { type: "user" as const, userId: "system", isAdmin: false };

        const valid_until = params.valid_until ? new Date(params.valid_until) : null;
        const metadataCombined = {
          ...(params.metadata ?? {}),
          ...(params.used_for ? { used_for: params.used_for } : {}),
        };

        const created = await knowledgeDrafts.create({
          companyId,
          actor,
          payload: {
            title: params.title,
            content: params.content,
            type: params.type,
            level: params.level,
            business_domain_name: params.business_domain_name,
            metadata: metadataCombined,
            volatility: params.volatility,
            valid_until,
            confidence: params.confidence ?? 0.5,
            source: "manual",
            source_run_id: params.source_run_id ?? null,
            source_issue_id: params.source_issue_id ?? null,
            target_node_id: params.target_node_id ?? null,
            skip_review: false,
          },
        });

        return {
          id: created.id,
          status: created.status,
          preVerdict: created.preVerdict ?? null,
        };
      },
    },
```

### Step 4: 跑测试 verify pass

```bash
cd D:\aiprojects\paperclip\server && npx vitest run plugin-host-services-knowledge
```

Expected: 2/2 pass.

### Step 5: 跑所有 knowledge + plugin-host 测试

```bash
cd D:\aiprojects\paperclip\server && npx vitest run knowledge
cd D:\aiprojects\paperclip\server && npx vitest run plugin-host
```

Expected: 全过（无 regression）。

### Step 6: Commit

```bash
git add server/src/services/plugin-host-services.ts server/src/__tests__/plugin-host-services-knowledge.test.ts
git commit -m "feat(plugin-host): knowledge.proposeDraft handler bridges to knowledgeDraftService.create (Phase 1b-2)"
```

---

## Task 5: 新建 plugin package skeleton

**Files:**
- Create: `D:\aiprojects\paperclip\packages\plugins\paperclip-plugin-knowledge-engine\package.json`
- Create: `D:\aiprojects\paperclip\packages\plugins\paperclip-plugin-knowledge-engine\tsconfig.json`
- Create: `D:\aiprojects\paperclip\packages\plugins\paperclip-plugin-knowledge-engine\src\manifest.ts`
- Create: `D:\aiprojects\paperclip\packages\plugins\paperclip-plugin-knowledge-engine\src\worker.ts`
- Create: `D:\aiprojects\paperclip\packages\plugins\paperclip-plugin-knowledge-engine\src\index.ts`

参照 hello-world-example。

### Step 1: package.json

写入 `packages/plugins/paperclip-plugin-knowledge-engine/package.json`：

```json
{
  "name": "@paperclipai/plugin-knowledge-engine",
  "version": "0.1.0",
  "description": "Paperclip LLM-Wiki Phase 1b-2 plugin exposing propose_knowledge_node tool.",
  "type": "module",
  "private": true,
  "exports": {
    ".": "./src/index.ts"
  },
  "paperclipPlugin": {
    "manifest": "./dist/manifest.js",
    "worker": "./dist/worker.js"
  },
  "scripts": {
    "prebuild": "pnpm --filter @paperclipai/plugin-sdk ensure-build-deps",
    "build": "tsc",
    "clean": "rm -rf dist",
    "typecheck": "pnpm --filter @paperclipai/plugin-sdk ensure-build-deps && tsc --noEmit"
  },
  "dependencies": {
    "@paperclipai/plugin-sdk": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^24.6.0",
    "typescript": "^5.7.3"
  }
}
```

### Step 2: tsconfig.json

复制 `packages/plugins/examples/plugin-hello-world-example/tsconfig.json` 内容到本目录：

Run: `cat D:/aiprojects/paperclip/packages/plugins/examples/plugin-hello-world-example/tsconfig.json`

把它写到 `packages/plugins/paperclip-plugin-knowledge-engine/tsconfig.json`（一字不差复制）。

### Step 3: src/manifest.ts

写入 `packages/plugins/paperclip-plugin-knowledge-engine/src/manifest.ts`：

```typescript
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclip.knowledge-engine";
const PLUGIN_VERSION = "0.1.0";

/**
 * Paperclip LLM-Wiki Phase 1b-2 — first-party plugin。
 *
 * 暴露一个 Agent tool `propose_knowledge_node`，Agent 在运行中可以主动提交
 * knowledge draft。Tool handler 调 ctx.knowledge.proposeDraft() 走 host
 * bridge 落到 Paperclip 主进程的 knowledge_drafts 表。
 */
const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Knowledge Engine",
  description: "Exposes propose_knowledge_node Agent tool for writing into the Paperclip LLM-Wiki.",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [
    "agent.tools.register",
    "knowledge.draft.create",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  tools: [
    {
      name: "propose_knowledge_node",
      displayName: "Propose Knowledge Node",
      description: "Propose a knowledge draft (lesson / rule / decision / fact / concept) for the LLM-Wiki review queue.",
      parametersSchema: {
        type: "object",
        required: ["title", "content", "type", "level", "business_domain_name"],
        properties: {
          title: { type: "string", minLength: 1, maxLength: 500 },
          content: { type: "string", minLength: 1, maxLength: 8000 },
          type: { type: "string", enum: ["concept", "lesson", "rule", "decision", "fact"] },
          level: { type: "string", enum: ["personal", "project", "company"] },
          business_domain_name: { type: "string", pattern: "^[a-z0-9]+(-[a-z0-9]+)*$" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          volatility: { type: "string", enum: ["stable", "slow", "fast"] },
          used_for: { type: "array", items: { type: "string" } },
          target_node_id: { type: ["string", "null"], format: "uuid" },
          metadata: { type: "object", additionalProperties: true },
        },
      },
    },
  ],
};

export default manifest;
```

### Step 4: src/worker.ts

写入 `packages/plugins/paperclip-plugin-knowledge-engine/src/worker.ts`：

```typescript
import { definePlugin, runWorker, type PluginContext, type ToolResult } from "@paperclipai/plugin-sdk";

const TOOL_NAME = "propose_knowledge_node";

const plugin = definePlugin({
  /**
   * 启动时把 propose_knowledge_node tool 注册到 host。
   * 调用时 runCtx 由 host 注入（agentId / runId / companyId / projectId）。
   */
  async setup(ctx: PluginContext) {
    ctx.logger.info("knowledge-engine plugin setup complete");

    ctx.tools.register(
      TOOL_NAME,
      {
        displayName: "Propose Knowledge Node",
        description: "Propose a knowledge draft to LLM-Wiki review queue.",
        parametersSchema: {
          type: "object",
          required: ["title", "content", "type", "level", "business_domain_name"],
          properties: {
            title: { type: "string" },
            content: { type: "string" },
            type: { type: "string", enum: ["concept", "lesson", "rule", "decision", "fact"] },
            level: { type: "string", enum: ["personal", "project", "company"] },
            business_domain_name: { type: "string" },
            confidence: { type: "number" },
            volatility: { type: "string", enum: ["stable", "slow", "fast"] },
            used_for: { type: "array", items: { type: "string" } },
            target_node_id: { type: ["string", "null"] },
            metadata: { type: "object" },
          },
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as {
          title?: string;
          content?: string;
          type?: "concept" | "lesson" | "rule" | "decision" | "fact";
          level?: "personal" | "project" | "company";
          business_domain_name?: string;
          confidence?: number;
          volatility?: "stable" | "slow" | "fast";
          used_for?: string[];
          target_node_id?: string | null;
          metadata?: Record<string, unknown>;
        };

        if (!p.title || !p.content || !p.type || !p.level || !p.business_domain_name) {
          return { error: "title, content, type, level, business_domain_name are required" };
        }

        try {
          const draft = await ctx.knowledge.proposeDraft({
            companyId: runCtx.companyId,
            title: p.title,
            content: p.content,
            type: p.type,
            level: p.level,
            business_domain_name: p.business_domain_name,
            confidence: p.confidence,
            volatility: p.volatility,
            used_for: p.used_for,
            metadata: p.metadata,
            target_node_id: p.target_node_id,
            source_run_id: runCtx.runId,
          });
          return {
            content: `Proposed draft ${draft.id} (status=${draft.status})`,
            data: draft,
          };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    );
  },

  async onHealth() {
    return { status: "ok", message: "knowledge-engine plugin ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
```

### Step 5: src/index.ts

写入 `packages/plugins/paperclip-plugin-knowledge-engine/src/index.ts`：

```typescript
export { default as manifest } from "./manifest.js";
export { default as plugin } from "./worker.js";
```

### Step 6: 构建 plugin + typecheck

```bash
pnpm --filter @paperclipai/plugin-knowledge-engine build
pnpm --filter @paperclipai/plugin-knowledge-engine typecheck
```

Expected: 构建产出 `dist/manifest.js` + `dist/worker.js` + 无 TS 错。

### Step 7: pnpm workspace 加新包

Run: `pnpm install` 在仓库根目录，让 pnpm 发现新的 workspace 包。

### Step 8: Commit

```bash
git add packages/plugins/paperclip-plugin-knowledge-engine/ pnpm-lock.yaml
git commit -m "feat(plugin-knowledge-engine): new first-party plugin scaffold with propose_knowledge_node tool (Phase 1b-2)"
```

---

## Task 6: 注册 plugin 到 BUNDLED_PLUGIN_EXAMPLES

**Files:**
- Modify: `D:\aiprojects\paperclip\server\src\routes\plugins.ts`

### Step 1: 加新条目

在 `D:\aiprojects\paperclip\server\src\routes\plugins.ts:156-189` 的 `BUNDLED_PLUGIN_EXAMPLES` 数组末尾追加（在 orchestration-smoke 之后、闭合 `];` 之前）：

```typescript
  {
    packageName: "@paperclipai/plugin-knowledge-engine",
    pluginKey: "paperclip.knowledge-engine",
    displayName: "Knowledge Engine",
    description: "Exposes propose_knowledge_node Agent tool for writing into the Paperclip LLM-Wiki.",
    localPath: "packages/plugins/paperclip-plugin-knowledge-engine",
    tag: "example",
  },
```

### Step 2: typecheck

```bash
pnpm --filter @paperclipai/server typecheck
```

Expected: 无新错。

### Step 3: Commit

```bash
git add server/src/routes/plugins.ts
git commit -m "feat(plugin-host): register paperclip-plugin-knowledge-engine in BUNDLED list (Phase 1b-2)"
```

---

## Task 7: Smoke checklist

**Files:**
- Create: `D:\aiprojects\paperclip\docs\superpowers\plans\2026-05-13-llm-wiki-phase-1b-2-smoke.md`

### Step 1: 写文档

写入 `docs/superpowers/plans/2026-05-13-llm-wiki-phase-1b-2-smoke.md`：

```markdown
# LLM-Wiki Phase 1b-2 — Path C Plugin Smoke Checklist

需 PG (with pgvector) + Phase 1a/1b-1 smoke 已通过 + plugin 已构建。

## 前置

```bash
# 1. 构建 SDK + plugin
pnpm --filter @paperclipai/plugin-sdk build
pnpm --filter @paperclipai/plugin-knowledge-engine build

# 2. 启动 server
export OPENAI_API_KEY="..."  # Phase 1a embedding 仍需要
export OPENAI_BASE_URL="..."
pnpm dev
```

## 安装 plugin

通过 API 安装（也可走 UI 的 plugin marketplace）：

```bash
CID=<existing-company-uuid>

# 列出可安装的 bundled plugins，应该看到 paperclip.knowledge-engine
curl -sf "http://127.0.0.1:3100/api/plugins/available-examples" | jq

# 触发安装到目标 company
curl -X POST "http://127.0.0.1:3100/api/plugins/install" \
  -H "Content-Type: application/json" \
  -d "{\"companyId\":\"$CID\",\"packageName\":\"@paperclipai/plugin-knowledge-engine\"}"
```

## 主路径 case

### Case 1: 直接调 tool execute endpoint

```bash
curl -X POST "http://127.0.0.1:3100/api/plugins/tools/execute" \
  -H "Content-Type: application/json" \
  -d "{
    \"tool\": \"paperclip.knowledge-engine:propose_knowledge_node\",
    \"parameters\": {
      \"title\": \"Use prepared statements to avoid SQL injection\",
      \"content\": \"Always use parameterized queries (prepared statements) instead of string concatenation when building SQL. This prevents SQL injection regardless of input sanitization quality.\",
      \"type\": \"rule\",
      \"level\": \"company\",
      \"business_domain_name\": \"general\",
      \"confidence\": 0.95,
      \"volatility\": \"stable\",
      \"used_for\": [\"backend\", \"security\"]
    },
    \"runContext\": {
      \"agentId\": \"00000000-0000-0000-0000-000000000001\",
      \"runId\": \"00000000-0000-0000-0000-000000000002\",
      \"companyId\": \"$CID\",
      \"projectId\": \"00000000-0000-0000-0000-000000000003\"
    }
  }"
```

**期望**：HTTP 200，response.result.data 含 `{id, status: "pending", preVerdict: null}`。

### Case 2: 验证 draft 落库

```bash
curl -s "http://127.0.0.1:3100/api/knowledge/drafts?companyId=$CID&source=manual" | jq '.data | length'
# → 应 ≥ 1
```

### Case 3: 缺少必填字段返回 error

```bash
curl -X POST "http://127.0.0.1:3100/api/plugins/tools/execute" \
  -H "Content-Type: application/json" \
  -d "{
    \"tool\": \"paperclip.knowledge-engine:propose_knowledge_node\",
    \"parameters\": { \"content\": \"only content\" },
    \"runContext\": {\"agentId\":\"00000000-0000-0000-0000-000000000001\",\"runId\":\"00000000-0000-0000-0000-000000000002\",\"companyId\":\"$CID\",\"projectId\":\"00000000-0000-0000-0000-000000000003\"}
  }"
```

**期望**：result.error 包含 "required"。

## 反向 case

- 调一个不存在的 tool 名（`paperclip.knowledge-engine:bogus`）→ 404
- runContext.companyId 不属于安装该 plugin 的 company → 权限拒绝
- 提供错误的 type 枚举（`type: "BANANA"`）→ JSON Schema 校验失败

## 完成判定

| Case | 状态 |
|---|---|
| Case 1 主路径 | ✓ 200 + draft 创建 |
| Case 2 落库验证 | ✓ ≥ 1 条 source=manual |
| Case 3 校验错误 | ✓ error 返回 |
| 反向 case | ✓ 三个都按预期拒绝 |

3/3 主路径 + 3/3 反向 → Phase 1b-2 完成。
```

### Step 2: Commit

```bash
git add docs/superpowers/plans/2026-05-13-llm-wiki-phase-1b-2-smoke.md
git commit -m "docs(llm-wiki): Phase 1b-2 smoke checklist"
```

---

## End-to-end Verification

```bash
# 1. SDK build clean
pnpm --filter @paperclipai/plugin-sdk build

# 2. New plugin build clean
pnpm --filter @paperclipai/plugin-knowledge-engine build

# 3. typecheck server
pnpm --filter @paperclipai/server typecheck

# 4. 全部 knowledge + host services 测试过
cd D:/aiprojects/paperclip/server && npx vitest run "knowledge|plugin-host-services-knowledge"

# 5. dev 起立 + plugin 可见
pnpm dev &
curl -sf "http://127.0.0.1:3100/api/plugins/available-examples" | jq '.[] | select(.pluginKey=="paperclip.knowledge-engine")'

# 6. 跑 Task 7 smoke checklist
```

≥ 5/6 通过 + smoke 3/3 主路径通过 → Phase 1b-2 完成。

---

## 顺序依赖

```
Task 0 (protocol)
  ↓
Task 1 (HostServices interface + types)
  ↓
Task 2 (worker-side proxy)
  ↓
Task 3 (capability validator)
  ↓
Task 4 (host bridge handler + tests)
  ↓
Task 5 (plugin package scaffold)
  ↓
Task 6 (BUNDLED registration)
  ↓
Task 7 (smoke checklist)
```

Task 0-3 是 SDK 一连串改动（每一步都依赖前一步的 type/method 定义）。Task 4 host bridge 与 Task 5 plugin 也可并行（互不依赖），但顺序更稳。

---

## 不在本次范围（明确划线）

- ❌ Plugin UI（dashboard widget 等）—— 非 MVP
- ❌ `search_knowledge_base` / `submit_feedback` 其他工具 —— Phase 2/3
- ❌ 把 Phase 1b-1 的 drafter 也通过 plugin 暴露 —— drafter 是 server 内部
- ❌ Plugin 自动 install（仍走 BUNDLED + 用户触发 install）
- ❌ Plugin SDK 公开版本号 bump（私有 monorepo workspace 无需）
- ❌ Plugin worker 进程 crash 自愈测试（host 已有机制，不属于本期）

---

## 风险与备注

1. **Plugin worker JSON-RPC 是 fire-and-wait**：tool 调用整条链 host → worker → host bridge → host services → DB，每跳都有序列化 + 反序列化开销。但 Phase 1b-2 单条 tool 调用 < 500ms 没问题（draft.create 是单 INSERT，无 LLM）。
2. **actor 简化为 system user**：Phase 1b-1 final review 标记的 `userId: "system"` 问题在 1b-2 不展开修。host bridge handler 直接用 `{type:"user", userId:"system"}`，写库会留下 `sourceUserId: "system"`。如果 user 表有 `local-board` 是 fixture 兜底，FK 不会挂；否则需要先 ensure user 存在。**Task 4 实现时如果 FK 挂掉，看 actor 改成什么形态合适**——可能要从 plugin auth context 里拿真实 agentId，写入 `sourceAgentId` 字段。
3. **Plugin 安装顺序**：dev 启动后需要先调安装 API（或 UI）才能用 tool。每个 fresh DB 都要走一次。
4. **Tool 参数 schema 双层校验**：manifest 里有一份 JSON Schema，worker 内 if 检查必填字段也有一份；host bridge 还有一道 ensureCompanyId。**冗余但安全**，错误信息层次清晰。
5. **跨 phase 测试相互独立**：Phase 1a 26 + Phase 1b-1 33（含 5 个 llm-wiki）+ 1b-2 新增 2（host bridge）= 35 总。如有 SDK 测试也要重跑。
6. **Plugin sdk dist 工件**：`packages/plugins/sdk/dist` 是构建产出，不入 git。但 SDK 没构建时 plugin 包 build 会失败（prebuild script 会调 ensure-build-deps），首次 setup 后通常自动好。
