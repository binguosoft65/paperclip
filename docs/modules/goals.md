# Goals 模块 —— 目标管理与目标树

## 模块概述

Goals 模块提供目标（OKR 风格）的定义、层级管理和与项目的关联能力。目标是 Paperclip 中**上承战略、下接执行**的核心实体：公司级目标分解为团队/Agent 级目标，最终关联到项目（Project）和 Issue 来落地执行。

### 核心能力

- **目标生命周期管理**：创建、编辑、删除目标，跟踪状态流转（planned -> active -> achieved / cancelled）
- **树形层级结构**：通过 `parentId` 自引用实现多级目标分解（company -> team -> agent -> task）
- **目标-项目关联**：一个项目可关联多个目标（多对多），在目标详情页聚合展示关联项目
- **责任人指派**：每个目标可指定一个 Agent 作为 owner（负责人）
- **活动日志**：所有目标操作（创建/更新/删除）自动记录活动日志，支持审计追踪

---

## 数据模型

### goals 表

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | uuid (PK) | 主键，自动生成 |
| `company_id` | uuid (FK -> companies) | 所属公司，数据隔离边界 |
| `title` | text | 目标标题 |
| `description` | text? | 目标描述，支持富文本（含图片） |
| `level` | text | 目标层级：`company` / `team` / `agent` / `task` |
| `status` | text | 生命周期状态：`planned` / `active` / `achieved` / `cancelled` |
| `parent_id` | uuid (FK -> goals) | 父目标 ID，自引用构建树形结构 |
| `owner_agent_id` | uuid (FK -> agents) | 责任人 Agent |
| `created_at` | timestamptz | 创建时间 |
| `updated_at` | timestamptz | 更新时间，每次 update 手动刷新 |

### project_goals 关联表

项目与目标的多对多关联，通过复合主键 `(project_id, goal_id)` 保证不重复关联。

| 字段 | 类型 | 说明 |
|------|------|------|
| `project_id` | uuid (FK -> projects, CASCADE) | 项目 ID |
| `goal_id` | uuid (FK -> goals, CASCADE) | 目标 ID |
| `company_id` | uuid (FK -> companies) | 所属公司，冗余列便于按公司查询 |
| `created_at` / `updated_at` | timestamptz | 时间戳 |

### Goal TypeScript 类型

```typescript
interface Goal {
  id: string;
  companyId: string;
  title: string;
  description: string | null;
  level: GoalLevel;        // "company" | "team" | "agent" | "task"
  status: GoalStatus;      // "planned" | "active" | "achieved" | "cancelled"
  parentId: string | null;
  ownerAgentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
```

---

## 核心流程

### 1. 目标创建

```
用户/Agent 发起创建请求
    │
    ▼
validate 中间件校验请求体（createGoalSchema）
    │
    ▼
goalService.create() 写入 goals 表，自动注入 companyId
    │
    ├── logActivity() 记录操作日志 (action: "goal.created")
    └── trackGoalCreated() 上报遥测事件（附带 goalLevel）
```

**关键约束**：
- 标题为必填（`title: z.string().min(1)`）
- `level` 默认值为 `task`，`status` 默认值为 `planned`
- `parentId` 可选 —— 创建根目标时留空即可
- 创建时不会校验 `parentId` 指向的目标是否存在（允许异步创建场景）

### 2. 树形层级管理

目标通过 `parentId` 自引用构建无限级树。层级约束由业务逻辑而非数据库强制：

- **level 语义**（不强制校验，但推荐遵循）：
  - `company`：公司级战略目标，一般是根节点（parentId 为空）
  - `team`：团队级目标，父级应为公司级
  - `agent`：Agent 级目标，进一步细化
  - `task`：任务级目标，最细粒度
- **根节点判断**：`parentId IS NULL` 或 `parentId` 指向集合外的目标（前端 GoalTree 容忍悬挂引用）
- **前端树构建**：接收扁平列表 -> 用 `Set<goalId>` 识别根节点 -> 递归 `GoalNode` 渲染，每层缩进 16px
- **默认展开**：所有节点默认展开（`expanded=true`），用户可折叠

### 3. 目标状态转换

```
planned ──→ active ──→ achieved
                │
                └──→ cancelled
```

- **planned**（计划中）：初始状态，目标已创建但尚未开始推进
- **active**（进行中）：目标开始执行，可关联项目和子目标
- **achieved**（已达成）：目标已完成，终点状态
- **cancelled**（已取消）：目标被放弃，终点状态

状态变更通过 PATCH `/goals/:id` 接口执行，支持部分更新。系统不强制状态流转方向 —— 可以通过 API 从任意状态切换到任意其他状态，UI 展示状态选项时也未做流转限制。

### 4. 目标与项目的关联机制

项目和目标的关联通过两种方式实现（为了向后兼容）：

1. **推荐方式**：`project.goalIds: string[]` 数组，一个项目可关联多个目标
2. **已废弃方式**：`project.goalId: string | null` 单值字段，仅支持一个目标
3. **渲染方式**：`project.goals: ProjectGoalRef[]` 含 `{id, title}` 的对象数组

前端目标详情页中的"关联项目"Tab 会同时检查三种方式：

```typescript
const linkedProjects = allProjects.filter((p) => {
  if (p.goalIds.includes(goalId)) return true;     // 方式 1
  if (p.goals.some((ref) => ref.id === goalId)) return true; // 方式 3
  return p.goalId === goalId;                       // 方式 2（废弃）
});
```

### 5. 获取默认公司级目标

`getDefaultCompanyGoal()` 实现三级降级逻辑，确保始终能返回一个有效的公司级入口目标：

1. active 状态 + 根节点（parentId IS NULL）的公司级目标
2. 任意状态 + 根节点的公司级目标
3. 任意公司级目标（即使不是根节点）

---

## 关键文件及职责

### 服务端

| 文件 | 职责 |
|------|------|
| `server/src/routes/goals.ts` | RESTful 路由定义：CRUD + 活动日志 + 遥测 |
| `server/src/services/goals.ts` | 业务逻辑层：CRUD 封装 + `getDefaultCompanyGoal` 降级查询 |

### 共享层

| 文件 | 职责 |
|------|------|
| `packages/shared/src/types/goal.ts` | Goal TypeScript 接口定义 |
| `packages/shared/src/constants.ts` | `GOAL_LEVELS` 和 `GOAL_STATUSES` 枚举常量 |
| `packages/shared/src/validators/goal.ts` | Zod 校验 schema（创建/更新） |
| `packages/shared/src/api.ts` | API 路由路径常量 |
| `packages/shared/src/telemetry/events.ts` | `trackGoalCreated` 遥测事件 |

### 数据库

| 文件 | 职责 |
|------|------|
| `packages/db/src/schema/goals.ts` | goals 表的 Drizzle schema 定义 |
| `packages/db/src/schema/project_goals.ts` | 项目-目标多对多关联表 schema |

### UI 端

| 文件 | 职责 |
|------|------|
| `ui/src/pages/Goals.tsx` | 目标列表页：空状态 + GoalTree 渲染 |
| `ui/src/pages/GoalDetail.tsx` | 目标详情页：子目标树 + 关联项目 + 属性面板 |
| `ui/src/components/GoalTree.tsx` | 递归树组件：根识别 + 展开/折叠 + 层级缩进 |
| `ui/src/components/GoalProperties.tsx` | 属性面板组件：状态/层级/责任人/父目标 |
| `ui/src/api/goals.ts` | 前端 API 调用封装 |

---

## 上下游依赖

### 上游依赖（Goals 模块依赖的模块）

| 模块 | 依赖内容 |
|------|----------|
| `companies` | 租户隔离，每个目标属于一个公司 |
| `agents` | 目标 owner 指向 agents 表 |
| `projects` | 目标关联到项目（多对多） |
| `assets` | 目标描述中的图片上传 |

### 下游依赖（依赖 Goals 模块的模块）

| 模块 | 依赖内容 |
|------|----------|
| `projects` | 项目中引用 goalIds/goals 字段 |
| `plugin` | 插件系统可读/写 goals（通过 goals.read / goals.create / goals.update 能力） |
| `telemetry` | 上报 goal.created 事件 |

---

## API 路由

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/companies/:companyId/goals` | 列出公司下全部目标 |
| GET | `/api/goals/:id` | 获取单条目标 |
| POST | `/api/companies/:companyId/goals` | 创建目标 |
| PATCH | `/api/goals/:id` | 更新目标（部分更新） |
| DELETE | `/api/goals/:id` | 删除目标（硬删除，级联清理关联表） |

所有写操作均记录活动日志（`goal.created` / `goal.updated` / `goal.deleted`），创建操作额外上报遥测事件。
