# 中文注释与业务文档化 实施计划

> **For agentic workers:** 每个智能体负责 1 个模块，并行执行。每完成一个模块后 commit，review agent 检查遗漏。

**Goal:** 为核心业务模块添加中文注释，产出业务说明文档

**Architecture:** 多智能体并行模式。每个模块分配一个 agent 独立执行（读代码 → 加注释 → 写文档），review agent 在每个 wave 完成后检查质量。

**Tech Stack:** TypeScript, React, Express — 纯代码注释 + Markdown 文档，不涉及代码逻辑变更

---

## 执行策略

### 多智能体并行

每个 wave 内所有模块互不依赖，可同时分派 agent：
- Wave 1: shared + db（基础设施，2 agent 并行）
- Wave 2: Auth + Companies + Agents + Issues + Goals（5 agent 并行）
- Wave 3: Projects + Routines + Approvals + Secrets（4 agent 并行）
- Wave 4: Environments + Plugins + Dashboard + Instance Settings（4 agent 并行）

### Review Agent

每个 wave 完成后，review agent 检查：
1. 是否所有关键函数/类都有注释
2. 文档是否包含必需的 5 个部分
3. 注释是否遵循"为什么"原则
4. 是否有遗漏的文件

---

## 注释标准速查

**注释什么：** 业务规则、隐性约束、边界条件、设计权衡
**不注释什么：** getter/setter、标准 CRUD、React 模板、可读命名自解释的代码
**格式：** 函数级用 `//` 或 `/** */`，类级用块注释

## 文档模板

每个模块输出 `docs/modules/<module-name>.md`：
1. 模块概述（一句话目的）
2. 核心流程（主要业务路径）
3. 关键文件（文件列表 + 职责）
4. 数据模型（核心表/类型）
5. 上下游依赖

---

### Task 1: shared 模块注释与文档

**Files:** `packages/shared/src/` 下 82 个非测试 .ts 文件

- [ ] 通读所有源文件，理解模块结构
- [ ] 给关键类型定义、校验器、常量添加中文注释
- [ ] 写 `docs/modules/shared.md`

### Task 2: db 模块注释与文档

**Files:** `packages/db/src/` 下 90 个非测试 .ts 文件

- [ ] 通读所有源文件，理解数据库 schema 和迁移
- [ ] 给 schema 定义、迁移文件、查询函数添加中文注释
- [ ] 写 `docs/modules/db.md`

### Task 3: Auth 模块注释与文档

**Files:** `server/src/routes/auth.ts`, `server/src/middleware/auth.ts`, `server/src/services/board-auth.ts` 等

- [ ] 通读认证授权相关文件
- [ ] 给认证流程、授权检查、中间件添加中文注释
- [ ] 写 `docs/modules/auth.md`

### Task 4: Companies 模块注释与文档

**Files:** `server/src/routes/companies.ts`, `server/src/services/companies.ts`, `ui/src/pages/Companies.tsx` 等

- [ ] 通读多租户相关文件
- [ ] 给公司 CRUD、成员管理、邀请流程添加中文注释
- [ ] 写 `docs/modules/companies.md`

### Task 5: Agents 模块注释与文档

**Files:** `server/src/routes/agents.ts`, `server/src/services/agents.ts`, `ui/src/pages/AgentDetail.tsx` 等

- [ ] 通读 Agent 管理相关文件
- [ ] 给 Agent 创建/配置/指令/权限添加中文注释
- [ ] 写 `docs/modules/agents.md`

### Task 6: Issues 模块注释与文档

**Files:** `server/src/routes/issues.ts`, `server/src/services/issues.ts`, `ui/src/pages/IssueDetail.tsx` 等

- [ ] 通读问题追踪相关文件
- [ ] 给问题生命周期、执行流程、continuation 添加中文注释
- [ ] 写 `docs/modules/issues.md`

### Task 7: Goals 模块注释与文档

**Files:** `server/src/routes/goals.ts`, `server/src/services/goals.ts`, `ui/src/pages/Goals.tsx` 等

- [ ] 通读目标管理相关文件
- [ ] 给目标 CRUD、目标树添加中文注释
- [ ] 写 `docs/modules/goals.md`

### Task 8: Projects 模块注释与文档

**Files:** `server/src/routes/projects.ts`, `server/src/services/projects.ts`, `ui/src/pages/Projects.tsx` 等

- [ ] 通读项目管理相关文件
- [ ] 给项目/工作空间管理添加中文注释
- [ ] 写 `docs/modules/projects.md`

### Task 9: Routines 模块注释与文档

**Files:** `server/src/routes/routines.ts`, `server/src/services/routines.ts`, `ui/src/pages/Routines.tsx` 等

- [ ] 通读定时任务相关文件
- [ ] 给 Routine CRUD、调度管理添加中文注释
- [ ] 写 `docs/modules/routines.md`

### Task 10: Approvals 模块注释与文档

**Files:** `server/src/routes/approvals.ts`, `server/src/services/approvals.ts`, `ui/src/pages/Approvals.tsx` 等

- [ ] 通读审批流程相关文件
- [ ] 给审批创建、状态流转添加中文注释
- [ ] 写 `docs/modules/approvals.md`

### Task 11: Secrets 模块注释与文档

**Files:** `server/src/routes/secrets.ts`, `server/src/services/secrets.ts`, `server/src/secrets/*.ts`, `ui/src/pages/Secrets.tsx` 等

- [ ] 通读密钥管理相关文件
- [ ] 给密钥 CRUD、provider 机制添加中文注释
- [ ] 写 `docs/modules/secrets.md`

### Task 12: Environments 模块注释与文档

**Files:** `server/src/routes/environments.ts`, `server/src/services/environments.ts` 等

- [ ] 通读执行环境相关文件
- [ ] 给环境配置、运行时管理添加中文注释
- [ ] 写 `docs/modules/environments.md`

### Task 13: Plugins 模块注释与文档

**Files:** `server/src/routes/plugins.ts`, `server/src/services/plugin-*.ts`, `ui/src/pages/PluginManager.tsx` 等

- [ ] 通读插件系统相关文件
- [ ] 给插件生命周期、工具调度、worker 管理添加中文注释
- [ ] 写 `docs/modules/plugins.md`

### Task 14: Dashboard 模块注释与文档

**Files:** `server/src/routes/dashboard.ts`, `server/src/services/dashboard.ts`, `server/src/services/heartbeat.ts`, `ui/src/pages/Dashboard.tsx` 等

- [ ] 通读仪表盘相关文件
- [ ] 给聚合数据、心跳监控添加中文注释
- [ ] 写 `docs/modules/dashboard.md`

### Task 15: Instance Settings 模块注释与文档

**Files:** `server/src/routes/instance-settings.ts`, `server/src/services/instance-settings.ts`, `ui/src/pages/InstanceSettings.tsx` 等

- [ ] 通读实例配置相关文件
- [ ] 给实例级设置管理添加中文注释
- [ ] 写 `docs/modules/instance-settings.md`

### Task 16: Review 检查每个 Wave

**每个 Wave 完成后执行**

- [ ] 检查该 wave 所有模块的关键函数是否有注释
- [ ] 检查文档是否包含必需的 5 个部分
- [ ] 检查有无遗漏文件
- [ ] 报告发现的问题
