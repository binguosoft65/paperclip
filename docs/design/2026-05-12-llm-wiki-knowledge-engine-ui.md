# Paperclip × LLM-Wiki 知识引擎 — UI / 交互设计

**版本**: v2.0
**日期**: 2026-05-12
**关联文档**: [PRD](../prd/2026-05-12-llm-wiki-knowledge-engine-prd.md) · [架构详设](./2026-05-12-llm-wiki-knowledge-engine-architecture.md) · [API 设计](./2026-05-12-llm-wiki-knowledge-engine-api.md)

---

## 目录

1. [设计原则](#1-设计原则)
2. [设计令牌](#2-设计令牌)
3. [信息架构](#3-信息架构)
4. [页面详细规范](#4-页面详细规范)
5. [关键共享组件](#5-关键共享组件)
6. [关键交互流程](#6-关键交互流程)
7. [移动端策略](#7-移动端策略)
8. [无障碍 / i18n](#8-无障碍--i18n)
9. [前端状态管理](#9-前端状态管理)
10. [代码目录](#10-代码目录)

---

## 1. 设计原则

### 1.1 主消费者优先级

| 消费者 | 占比预估 | 优化重点 |
|--------|---------|---------|
| Paperclip Agent（不可见） | 80% 流量 | API 性能、检索精度 |
| **人类（缤果运营者）** | 20% 流量 | Web UI 易用性 |
| 外部 Agent（MCP） | 偶发 | API 稳定性 |

UI 设计**仅服务人类**，但要让"看 Agent 在用什么知识" / "审查 Agent 的写入" / "整理沉淀" 这三件事尽可能高效。

### 1.2 核心原则

1. **数据密度优先于装饰**：缤果是单人运营，UI 不为多人协作场景做设计；列表/详情页信息密度可以拉到接近 admin tool
2. **预判式审查**：所有审查队列必须配 Reviewer Agent 初筛结果可见，让"一键批量"成为主操作
3. **演化轨迹可视**：节点变更历史 / 推翻关系 / 模式涌现等不藏在子页面，主路径就能看到
4. **业务域颜色统一**：每个 domain 自配颜色后，全站徽章、图谱节点、Dashboard 饼图都用同一套色
5. **复用 Paperclip 设计系统**：不重新发明组件，遵循 design-guide skill

---

## 2. 设计令牌

**核心原则**（来自 Paperclip design-guide）：
- 禁止 raw hex / rgb，全部走 CSS 语义 token（`--foreground` / `--muted` 等）或 Tailwind 命名色
- 状态色板复用 `ui/src/lib/status-colors.ts` 已定义的 `statusBadge` map 模式
- 圆角最大 `rounded-xl`（除 `rounded-full` for pills），阴影最重 `shadow-sm`
- 必须暗色模式适配（所有徽章 class 含 `dark:` 变体）

### 2.1 节点类型徽章（NodeTypeBadge，对齐 StatusBadge 风格）

新增 `NodeTypeBadge` composite 组件（仿 `StatusBadge` 实现），不发明颜色——映射到 `status-colors.ts` 既有的语义色系：

| type | 含义 | 复用色板（类比） | Tailwind class |
|------|------|-----------------|---------------|
| `concept` | 抽象概念 | 类似 `running` 的 cyan | `bg-cyan-100 text-cyan-700 dark:bg-cyan-900/50 dark:text-cyan-300` |
| `lesson` | 教训 | 类似 `paused` 的 orange | `bg-orange-100 text-orange-700 dark:bg-orange-900/50 dark:text-orange-300` |
| `rule` | 强制规则 | 类似 `blocked` 的 red | `bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300` |
| `decision` | 决策 | 复用 `in_review` 的 violet | `bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300` |
| `fact` | 事实陈述 | 复用 `todo` 的 blue | `bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300` |

实现：把上述 map 加到 `status-colors.ts` 或新建 `node-type-colors.ts`，`NodeTypeBadge` 内部按 `statusBadge` 同样的 `inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium` 渲染。

### 2.2 freshness 标签（FreshnessBadge，复用 statusBadge 语义）

| 标签 | 类比 status | Tailwind class | 额外视觉 |
|------|------------|---------------|---------|
| `fresh` | 类似 `active` 的 green | `bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300` | 通常隐藏（默认状态） |
| `stale_warning` | 类似 `warning` 的 amber | `bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300` | 前置 `AlertTriangle` lucide 图标 |
| `outdated` | 类似 `archived` | `bg-muted text-muted-foreground` | 整卡 `opacity-60`，标题加 `line-through` |
| `valid_expired` | 类似 `rejected` 的 red | `bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300` | 前置 `AlertCircle` 图标 |

### 2.3 边类型视觉（图视图用，Cytoscape 样式）

边类型不入 `statusBadge` map（不是 badge 是 line style）。用 Tailwind 命名色对应同语义：

| edge_type | 线型 | 颜色（CSS） |
|-----------|------|------------|
| `references` | 细实线 | `var(--muted-foreground)` |
| `supersedes` | 粗虚线 | `var(--destructive)` |
| `merged_from` | 实线 + ⊕ 标记 | Tailwind `blue-500` |
| `derived_from` | 实线 + ↑ 标记 | Tailwind `violet-500` |
| `conflicts_with` | 闪电状 | Tailwind `orange-500` |
| `promoted_to` | 上升箭头 | Tailwind `green-500` |

Cytoscape stylesheet 中通过 `getComputedStyle(document.documentElement).getPropertyValue('--...')` 读取 token，避免硬编码。

### 2.4 业务域配色（DomainBadge，预设色卡）

`business_domains.color` 字段存 Tailwind 颜色名（如 `cyan` / `orange` / `violet`），而非自由 hex。这样徽章渲染走和 `StatusBadge` 同一模板，自动支持暗色。

**预设色卡**（创建业务域时从下拉选，不开放 free-form picker）：

| color | 暗色友好 Tailwind class 模板 |
|-------|---------------------------|
| `cyan` / `blue` / `sky` / `violet` / `indigo` / `green` / `emerald` / `amber` / `orange` / `red` / `pink` / `neutral`（共 12 种） | `bg-{color}-100 text-{color}-700 dark:bg-{color}-900/50 dark:text-{color}-300` |

实现：

```typescript
function DomainBadge({ domain }: { domain: Domain }) {
  return (
    <span className={cn(
      "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium",
      domainColorClass(domain.color)            // 查表得 bg-cyan-100 text-cyan-700 ...
    )}>
      {domain.icon && <Icon name={domain.icon} size={12} />}
      {domain.display_label}
    </span>
  );
}
```

缤果初始 seed 推荐：

| 业务域 | color | icon (lucide) |
|--------|-------|--------------|
| `general` | `neutral` | `tag` |
| `software` | `blue` | `code` |
| `content` | `pink` | `pen-tool` |
| `distribution` | `orange` | `shopping-bag` |
| `community` | `violet` | `users` |

### 2.5 字号与间距（沿用 design-guide 第 4 节）

| Pattern | Classes | 用途 |
|---------|---------|------|
| 页面标题 | `text-xl font-bold` | 页首 |
| 章节标题 | `text-lg font-semibold` | 大节 |
| 区段头 | `text-sm font-semibold text-muted-foreground uppercase tracking-wide` | sidebar / DesignGuide 区段头 |
| 卡片标题 | `text-sm font-medium` 或 `text-sm font-semibold` | 列表项 / 卡片头 |
| 正文 | `text-sm` | 默认 |
| 弱化 | `text-sm text-muted-foreground` | 副标题 / 描述 |
| 标签/元数据 | `text-xs text-muted-foreground` | property label / 时间戳 |
| ID 单字 | `text-xs font-mono text-muted-foreground` | 节点 ID / 短码 |
| 大数值 | `text-2xl font-bold` | Dashboard 指标 |

间距走 Tailwind 默认 spacing scale（4/6/8/12 等），不发明新尺度。

### 2.6 圆角与阴影

- 圆角：`rounded-md`（输入/按钮）/ `rounded-lg`（卡片/对话框）/ `rounded-xl`（大卡片）/ `rounded-full`（pills/badges/avatars）
- 阴影：仅 `shadow-xs`（outline buttons）/ `shadow-sm`（cards）。**禁用 `shadow-md` 及以上**

---

## 3. 信息架构

### 3.1 顶级导航

在 Paperclip 主侧边栏增加一项 "Knowledge"，展开子项：

```
📚 Knowledge
   ├─ 🔍 Search           /knowledge/search
   ├─ ✅ Review (5)        /knowledge/review        ← 数字徽章显示 pending 数
   ├─ 📊 Dashboard         /knowledge/dashboard
   ├─ ✏️ New Node          /knowledge/editor
   ├─ 🌐 Sources           /knowledge/sources
   ├─ 🏷️ Domains           /knowledge/domains
   └─ 🕸️ Graph             /knowledge/graph
```

详情页 `/knowledge/:id` 不在导航中，从 Search / Dashboard / Graph 各处点击进入。

### 3.2 面包屑约定

详情页面包屑：`Knowledge > <domain.display_label> > <node.title>`

---

## 4. 页面详细规范

### 4.1 `/knowledge/search` — 搜索页

**布局**：上中下三段

```
┌─────────────────────────────────────────────────────────┐
│  搜索框：[                        ] [🔍 Search]          │
│  快捷过滤：[type:▾] [domain:▾] [freshness:▾] [outdated] │
└─────────────────────────────────────────────────────────┘
┌──────────────────────┐ ┌──────────────────────────────┐
│ 左侧：结果列表        │ │ 右侧：选中节点预览（双链可点）│
│  [🟧 lesson]          │ │                              │
│  PG 死锁排查...       │ │ # PG 死锁排查清单            │
│  软件域 · fresh       │ │                              │
│  trigger:7 verified ✓ │ │ ## 概述                      │
│                       │ │ ...                          │
│  [🟪 decision]        │ │                              │
│  选 PG 不选 MySQL...  │ │ ## 核心要点                  │
└──────────────────────┘ └──────────────────────────────┘
```

**关键交互**：

- 搜索框支持快捷语法 `type:lesson domain:software`（解析后映射到 query params）
- 列表卡片 hover 显示完整 metadata（confidence, used_for, verified_at）
- 列表项点击 → 加载右侧预览（不跳转页面）
- 列表项双击 → 跳详情页
- 列表底部"加载更多"按 cursor 分页
- Enter 提交搜索；Esc 清空

**结果卡片字段**：

```
[type 徽章][domain 徽章][freshness 标签]
节点标题（粗体）
摘要（content 前 200 字，line-clamp: 2）
trigger_count · last_triggered · confidence · level 徽章
```

**空状态**：搜索无结果时显示 "无匹配节点，是否扩大检索？" + 一键 `include_outdated=true` 按钮。

### 4.2 `/knowledge/:id` — 详情页

**布局**：左右双栏 + 底部时间线

```
┌──────────────────────────────────────────────┬───────────────────┐
│ # PG 死锁排查清单                              │ 元数据面板         │
│ [lesson][software 软件与 AI 工具][fresh]       │                   │
│                                                │ • type: lesson     │
│ ## 概述                                        │ • level: company   │
│ 死锁是 PG 在...                                │ • domain: software │
│                                                │ • status: active   │
│ ## 核心要点                                    │ • volatility: slow │
│ - [[abc...]] 互斥锁顺序                        │ • valid_until: --  │
│ - ...                                          │ • verified: ✓      │
│                                                │ • verified_at: ... │
│                                                │ • confidence: 0.9  │
│                                                │ • trigger_count: 7 │
│                                                │ • last_triggered:  │
│                                                │   2 天前           │
│                                                │ • used_for: [...]  │
│                                                │                   │
│                                                │ 操作:              │
│                                                │ [✏️ 编辑]          │
│                                                │ [✅ 标记已验证]    │
│                                                │ [⬆️ 提升到公司级]  │
│                                                │ [⚠️ 标记过期]      │
└──────────────────────────────────────────────┴───────────────────┘
┌──────────────────────────────────────────────────────────────────┐
│ 双链区                                                            │
│ 引用了 (3): [[node-X]] [[node-Y]] [[node-Z]]                      │
│ 被引用 (7): [[node-A]] [[node-B]] ...                             │
│ 冲突 (1): ⚠ [[node-C]]                                             │
└──────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────┐
│ 时间线（revisions + events 合并）                                  │
│ • 2026-05-10 09:23 — Agent X triggered (Issue #123) [helped]      │
│ • 2026-04-15 10:00 — manually verified by user                    │
│ • 2026-04-10 14:30 — updated by Agent Y (revision #3)             │
│ • 2026-04-01 ... — created by Agent Z                             │
└──────────────────────────────────────────────────────────────────┘
```

**关键交互**：

- `[[node-id]]` 渲染为 inline badge（点击跳目标详情，hover 显示目标 title + snippet 小卡）
- 死链（指向不存在节点）显示为灰色 + 不可点 + tooltip "目标节点已删除"
- 时间线项点击展开详情（revision 显示 diff，event 显示触发上下文）
- 操作按钮根据权限 / 节点状态动态显示（如已是 company 级隐藏"提升"按钮）

**revision diff 视图**：

```
─── 旧版本 (2026-04-10) ──────────  ─── 当前版本 (2026-04-15) ──────
- 互斥锁顺序不一致                     + 互斥锁顺序需保持一致；
                                       + 多事务按字典序加锁可避免
```

### 4.3 `/knowledge/review` — 审查队列

**4 Tab 切换**：Pending / Approved / Rejected / Revision Requested

**Pending Tab 布局**：

```
┌────────────────────────────────────────────────────────────────┐
│ 过滤：[source▾] [pre_verdict▾] [domain▾]  [全选]               │
├────────────────────────────────────────────────────────────────┤
│ □ [needs_human] PG 17 索引优化指南 (lesson, software)            │
│   ⚠ Reviewer: 与 [[rule-001]] 可能冲突，需人工裁决                │
│   来源: Agent X (Issue #234)  可信度: 0.85  等待: 8h            │
│   [查看] [批准] [驳回] [请求修改]                                 │
├────────────────────────────────────────────────────────────────┤
│ □ [recommend_approve] 抖音规则更新 2025-Q2 (fact, content)       │
│   Reviewer: 高质量更新，无冲突                                    │
│   来源: 爬虫 (douyin.com/help)  可信度: 0.9  等待: 5h            │
│   [查看] [批准] [驳回]                                            │
├────────────────────────────────────────────────────────────────┤
│ □ [recommend_reject] ... (空洞内容样例)                           │
│   Reviewer: 内容无实质信息，建议驳回                              │
│   ...                                                            │
└────────────────────────────────────────────────────────────────┘

底部固定操作栏:
[✓ 批准所有 recommend_approve (12)] [✗ 驳回所有 recommend_reject (3)]
[勾选: 0] [批量批准] [批量驳回]
```

**关键交互**：

- pending 项默认按"梯度优先级"排序：needs_human 最上 → 冲突类 → 高 confidence 等久
- pre_verdict 徽章三色（needs_human 黄，recommend_approve 绿，recommend_reject 红）
- 单条卡片 [查看] 弹出 modal 显示完整内容（不跳页）
- 全选支持"同类型同来源"快捷
- 批量操作前弹确认弹窗显示影响节点数

### 4.4 `/knowledge/dashboard` — Dashboard

**布局**：自上而下 6 段

```
┌────────────────────────────────────────────────────────────────┐
│ 健康指标栏（6 卡片一排）                                          │
│ ┌──────┐┌──────┐┌──────┐┌──────┐┌──────┐┌──────┐              │
│ │新增  ││审查  ││命中率 ││引用  ││冲突  ││过期  │              │
│ │ 12   ││ 8.5h ││ 67%  ││ 2.3  ││  2   ││  3   │              │
│ │ 🟢   ││ 🟢   ││ 🟢   ││ 🟢   ││ 🟢   ││ 🟢   │              │
│ └──────┘└──────┘└──────┘└──────┘└──────┘└──────┘              │
└────────────────────────────────────────────────────────────────┘
┌────────────────────────────────────────────────────────────────┐
│ 热度 Top 10（横向条形图）                                         │
│ PG 死锁排查清单 ████████████████ 12                              │
│ 抖音规则 2025  ██████████████ 10                                 │
│ ...                                                              │
└────────────────────────────────────────────────────────────────┘
┌─────────────────────────────┬──────────────────────────────────┐
│ 业务域分布（饼图）            │ 类型分布（条形图）                │
│   software 40 ████             concept ██ 30                   │
│   content 35 ███               lesson ████ 60                   │
│   ...                          rule ██ 25                       │
└─────────────────────────────┴──────────────────────────────────┘
┌────────────────────────────────────────────────────────────────┐
│ 演化轨迹（最近 30 天）                                            │
│ 升规则 2 · 归档 5 · 合并 1 · 冲突未决 2 · 模式涌现 1             │
│ [折线图：每日变化]                                                │
└────────────────────────────────────────────────────────────────┘
┌────────────────────────────────────────────────────────────────┐
│ 待办栏                                                           │
│ • 5 条 draft 待审 [去审查 →]                                     │
│ • 3 条节点需验证 [去看 →]                                        │
│ • alarm Issue: review_backlog 接近阈值 [查看 #456 →]             │
└────────────────────────────────────────────────────────────────┘
```

**健康指标卡交互**：

- 状态点：绿（健康）/ 黄（warning）/ 红（critical）按 §7.5 阈值
- 点击卡片跳详情列表（如 "过期" 跳到 outdated 节点列表）
- hover 显示历史趋势（最近 30 天折线）

### 4.5 `/knowledge/editor` — Markdown 编辑器

**布局**：左编辑右预览

```
┌─────────────────────────────────┬──────────────────────────────┐
│ 元数据栏                          │                              │
│ 标题: [_____________________]    │  实时 Markdown 预览           │
│ 类型: [lesson ▾]                  │                              │
│ 域:   [software ▾]                │  # PG 死锁排查清单            │
│ 层级: [project ▾]                 │                              │
│ 时效: [slow ▾]                    │  ## 概述                      │
│ ────────────────                  │  ...                          │
│ symptom: [_____________]          │                              │
│ root_cause: [_________]           │  ## 相关                      │
│ next_time: [__________]           │  - [[abc...]]                 │
├─────────────────────────────────┤                              │
│ Markdown 编辑器（CodeMirror）     │                              │
│ ```                              │                              │
│ # PG 死锁排查清单                │                              │
│ ## 概述                          │                              │
│ ...                              │                              │
│ ## 相关                          │                              │
│ - [[                             │  ← 此处触发自动补全弹窗       │
│       ┌──────────────────────┐   │                              │
│       │ 🔍 搜索节点...        │   │                              │
│       │  PG 死锁 (lesson)     │   │                              │
│       │  PG 配置 (concept)    │   │                              │
│       └──────────────────────┘   │                              │
│ ```                              │                              │
└─────────────────────────────────┴──────────────────────────────┘

底部: [取消] [保存为草稿] [提交审查] [□ 跳过审查（管理员）]
```

**关键交互**：

- `[[` 触发自动补全弹窗，输入 query 实时搜索同公司节点，回车插入 `[[node-id]]` + `(node-title)` 别名
- metadata 字段按 type 切换显示不同表单（lesson 显示 symptom/root_cause/next_time）
- 实时预览：300ms debounce 渲染
- 自动保存草稿到 localStorage（防丢失）
- "提交审查" 调 POST /api/knowledge/drafts；"跳过审查" 管理员可见，调 POST /api/knowledge/nodes

### 4.6 `/knowledge/sources` — 外部源管理

**布局**：表格 + 顶部新增按钮

```
┌──────────────────────────────────────────────────────────────────┐
│ [+ 新增源] [🔍 搜索...]                                            │
├──────────────────────────────────────────────────────────────────┤
│ ✓ 名称              类型  域      频率   信任度  上次抓  操作      │
├──────────────────────────────────────────────────────────────────┤
│ ☑ Martin Fowler 博客  blog software weekly  0.9   2d前   [⚙ 编辑] │
│                                                          [▶ 立即]  │
│ ☑ 抖音帮助中心 RSS    rss  content daily   1.0   3h前   [⚙][▶]   │
│ ☐ arXiv AI 主题       paper general weekly  0.7   1w前   [⚙][▶]   │
└──────────────────────────────────────────────────────────────────┘
```

**新增/编辑模态框**：

```
┌──── 新增外部源 ────┐
│ 名称: [_________]   │
│ URL:  [_________]   │
│ 类型: [blog ▾]      │
│ 采集器: [WebCrawler]│
│ 业务域: [software ▾]│
│ 频率: [weekly ▾]    │
│ 信任度: [0.9 ──○──] │
│ ────                │
│ CSS 选择器: [______]│
│ Sitemap URL: [_____]│
│ 标签: [_______]     │
│ ────                │
│ 高级配置（JSON）:    │
│ { "concurrency": 1 }│
│                     │
│ [取消] [保存]       │
└────────────────────┘
```

### 4.7 `/knowledge/domains` — 业务域管理（FR10 核心入口）

**布局**：可拖拽排序的表格

```
┌──────────────────────────────────────────────────────────────────┐
│ [+ 新增业务域]              [☐ 显示归档]                          │
├──────────────────────────────────────────────────────────────────┤
│ ⇅  徽章预览  display_label   name        节点数  状态   操作      │
├──────────────────────────────────────────────────────────────────┤
│ ⇅  [💻 软件]  软件与 AI 工具  software     42    active [⚙][📦]   │
│ ⇅  [✒️ 内容]  自媒体内容矩阵  content      35    active [⚙][📦]   │
│ ⇅  [🛍️ 带货]  短视频带货      distribution 12    active [⚙][📦]   │
│ ⇅  [👥 社群]  知识付费与社群  community    8     active [⚙][📦]   │
│ ⇅  [🏷️ 通用]  通用            general      20    active [⚙][🚫]   │
│                                                          ↑       │
│                                              general 不可归档     │
└──────────────────────────────────────────────────────────────────┘
```

**新增/编辑模态框**：

```
┌──── 新增业务域 ────┐
│ name (slug):       │
│ [ai-education___]  │
│ ⚠ 只能小写+连字符  │
│                    │
│ 显示名:            │
│ [AI 教育________]  │
│                    │
│ 描述:              │
│ [______________]   │
│                    │
│ 颜色:              │
│ [violet ▾]         │
│ 12 预设色卡下拉    │
│ [■ 实时预览徽章]    │
│                    │
│ 图标 (lucide):     │
│ [graduation-cap ▾] │
│                    │
│ 排序:              │
│ [5_]               │
│                    │
│ [取消] [保存]      │
└────────────────────┘
```

**关键交互**：

- 拖拽 ⇅ 改 sort_order，立即 PATCH 保存
- 实时预览徽章效果（用户选色时即时看到）
- name 输入框 slug 校验（实时显示错误）
- general 业务域不可编辑 name / 不可归档（特殊保护）
- 归档操作弹确认弹窗显示"X 个节点仍关联此域"

### 4.8 `/knowledge/graph` — 图视图

**布局**：全屏画布 + 浮动控制面板

```
┌──────────────────────────────────────────────────────────────────┐
│ ┌─控制面板─────────┐                                              │
│ │ 视图: [关系图▾]   │                                              │
│ │ 过滤:             │                                              │
│ │  类型: [所有]      │              ⬤────────⬤                      │
│ │  域:   [所有]      │              │        │                     │
│ │  状态: [active]    │            ⬤─┘        └─⬤                  │
│ │ 高亮:             │           /            \                   │
│ │  [_____查询____]  │          ⬤───⬤─────⬤  ⬤                    │
│ │                   │              │                              │
│ │ [📷 截图]         │              ⬤                              │
│ │ [💾 导出 PNG]     │                                              │
│ └───────────────────┘                                              │
│                                                                    │
│ ┌─图例─────────────┐                                              │
│ │ 节点颜色 = 类型   │                                              │
│ │ 边颜色 = 关系类型 │                                              │
│ │ 大小 = trigger    │                                              │
│ └───────────────────┘                                              │
└──────────────────────────────────────────────────────────────────┘
```

**3 种视图模式**：

| 视图 | 算法 | 用途 |
|------|------|------|
| 关系图 | cose（力导向） | 看全局拓扑、找孤岛 |
| 时间线 | DAG 按 created_at 横轴 | 看 supersedes 演化轨迹 |
| 业务域聚类 | 按 domain 着色 + 区域分组 | 看跨域关联 |

**交互**：

- 鼠标拖拽平移 / 滚轮缩放
- 节点 hover：浮动小卡显示 title + type + freshness
- 节点单击：高亮邻居 + 弹出详情侧栏
- 节点双击：跳详情页
- 搜索框：输入关键词，匹配节点高亮，其他变灰

**性能策略**：

| 节点数 | 渲染策略 |
|--------|---------|
| ≤ 500 | 全量渲染 |
| 500-2000 | 默认显示 trigger_count Top 100 + 按需展开邻居 |
| > 2000 | 默认显示 Top 50 + 提示用户加过滤条件 |

---

## 5. 关键共享组件

按 design-guide 三层（shadcn primitives / Custom composites / Page components），优先**复用** `ui/src/components/` 已有 composites，仅在确有 Paperclip 不存在的能力时新增。

### 5.1 直接复用的现有 composite

| 现有组件 | 文件 | 在 LLM-Wiki 哪里用 |
|---------|------|-------------------|
| `EntityRow` | `ui/src/components/EntityRow.tsx` | 搜索结果列表 / 详情页双链区 / 审查队列 / 业务域列表 |
| `StatusBadge` | `ui/src/components/StatusBadge.tsx` | 节点 status 显示（active/archived/outdated/revoked） |
| `MetricCard` | `ui/src/components/MetricCard.tsx` | Dashboard 健康指标栏 6 个卡 |
| `InlineEditor` | `ui/src/components/InlineEditor.tsx` | 详情页元数据面板编辑（标题、verified 等） |
| `Layout` | `ui/src/components/Layout.tsx` | 全部 8 页面包裹 |

### 5.2 直接复用的 shadcn primitives

| 现有 primitive | 在 LLM-Wiki 哪里用 |
|--------------|-------------------|
| `Card` / `CardHeader` / `CardContent` | 详情页正文 / 审查 modal / Dashboard 各卡 |
| `Dialog` | 编辑器提交确认、批量审查确认 |
| `Popover` | 业务域 picker / 类型 picker / 时间筛选 |
| `Tabs` | `/review` 4 Tab、详情页时间线/双链 Tab |
| `Input` / `Textarea` | 搜索框、metadata 表单 |
| `Select` / `Command` | DomainPicker 底层 |
| `Checkbox` | 审查批量勾选 |
| `Skeleton` | 加载占位 |
| `Tooltip` | freshness 详情 hover、`[[id]]` 预览 |
| `Badge` | 类型徽章 / freshness 徽章 / domain 徽章基底 |

### 5.3 新增的 composite（LLM-Wiki 专属）

每个新组件**必须按 design-guide §10 加到 `/design-guide` showcase 页**。

#### 5.3.1 `NodeTypeBadge` — 节点类型徽章

```typescript
// ui/src/components/knowledge/NodeTypeBadge.tsx
import { cn } from "@/lib/utils";
import { nodeTypeBadge, nodeTypeBadgeDefault } from "@/lib/knowledge-colors";

export function NodeTypeBadge({ type }: { type: NodeType }) {
  return (
    <span className={cn(
      "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap shrink-0",
      nodeTypeBadge[type] ?? nodeTypeBadgeDefault
    )}>
      {nodeTypeLabel(type)}
    </span>
  );
}
```

`nodeTypeBadge` map 见 §2.1。模板对齐 `StatusBadge`，便于读者立刻看懂。

#### 5.3.2 `FreshnessBadge` — 时效标签

仿 `StatusBadge`，但只接受 4 个 freshnessLabel 值，并内嵌 `AlertTriangle` / `AlertCircle` lucide 图标。

```typescript
export function FreshnessBadge({ label, score }: { label: FreshnessLabel; score?: number }) {
  if (label === "fresh") return null;     // 默认状态不渲染
  // ...
}
```

#### 5.3.3 `DomainBadge` — 业务域徽章

见 §2.4 示例代码。颜色查表 `domainColorClass(domain.color)`，避免内联 hex。

#### 5.3.4 `KnowledgeNodeRow` — 知识节点列表项

**不新建**——直接用 `EntityRow`，slot 填法约定：

```tsx
<EntityRow
  leading={<NodeTypeBadge type={node.type} />}
  identifier={node.id.slice(0, 8)}            // 短 UUID
  title={node.title}
  subtitle={`trigger: ${node.triggerCount} · ${node.usedFor.join(", ")}`}
  trailing={<><FreshnessBadge label={node.freshnessLabel} /><DomainBadge domain={node.domain} /></>}
  to={`/knowledge/${node.id}`}
/>
```

即"约定"而非"新组件"，符合 design-guide §6 "Do NOT create a component for...thin wrappers that add no semantic value"。

#### 5.3.5 `DraftReviewCard` — 审查队列卡片

包含 Reviewer Agent `pre_verdict` 徽章、`detected_conflicts` 内联展示、批准/驳回按钮组。比 EntityRow 信息量大，单独 composite。

```typescript
export function DraftReviewCard({
  draft,
  onApprove,
  onReject,
  onRequestRevision,
}: {
  draft: Draft;
  onApprove: () => void;
  onReject: () => void;
  onRequestRevision: () => void;
}) { /* ... */ }
```

#### 5.3.6 `MarkdownEditor` — 带 wikilink 补全的编辑器

CodeMirror 6 + 自定义扩展：

| 扩展 | 用途 |
|------|------|
| `wikiLinkCompletion` | 输入 `[[` 弹补全弹窗，从 `/api/knowledge/nodes?title_q=...` 查同公司节点 |
| `wikiLinkRenderer` | `[[uuid]]` 渲染为可点 chip + hover 显示目标节点 Tooltip 预览 |
| `autosaveLocal` | localStorage 持久化，key 形如 `paperclip:knowledge:editor:<draft-id-or-new>` |

接口：

```typescript
interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  companyId: string;
  placeholder?: string;
  height?: string;
}
```

#### 5.3.7 `GraphCanvas` — 图视图

封装 Cytoscape.js。stylesheet 通过读取 CSS 变量（`--muted-foreground` / `--destructive` 等）保持暗色一致：

```typescript
const css = getComputedStyle(document.documentElement);
cytoscape({
  container,
  elements: [...],
  style: [
    { selector: "edge[type='references']", style: { "line-color": css.getPropertyValue("--muted-foreground") } },
    // ... 其他边类型
  ],
  layout: { name: "cose" },                  // 关系图视图
});
```

接口：

```typescript
interface GraphCanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  viewMode: "relation" | "timeline" | "domain-cluster";
  highlight?: string;
  onNodeClick?: (id: string) => void;
  onNodeDoubleClick?: (id: string) => void;
}
```

### 5.4 不新建的（虽然之前列过）

- `HealthMetricCard` — **不新建**，直接用现有 `MetricCard` 并传 `status` prop 控制状态点配色（Dashboard 那行 6 卡）
- `DomainPicker` — **不新建**，用 shadcn `Popover + Command` 组合（参考 Paperclip 现有 IssueAssigneePicker 等模式）
- `TypePicker` / `VolatilityPicker` — 同上，用 `Select` 即可

---

## 6. 关键交互流程

### 6.1 检索 → 点击 → 详情 → 反馈

```
用户在 /search 输入 "PG 死锁"
   ↓
左侧列表显示 Top 5
   ↓
点击第一项 → 右侧预览
   ↓
点击 [[abc...]] 内联引用
   ↓
预览栏切换到目标节点（仍在同页面）
   ↓
双击列表项或预览栏标题 → 跳详情页
   ↓
详情页查阅完整内容
   ↓
（Agent 场景）反馈通过 API；（人类场景）人类没有"反馈"操作
```

### 6.2 写入 → 审查 → 落地

```
用户在 /editor 写新节点
   ↓
填 metadata + content
   ↓
"提交审查" → POST /drafts
   ↓
Toast 提示 "draft 已提交，预计 1 小时内 Reviewer 初筛完成"
   ↓
1 小时后 Reviewer Agent 写 pre_verdict
   ↓
管理员去 /review 看队列
   ↓
看到 pre_verdict + reasoning
   ↓
（按 verdict）批量批准 / 单条审 / 请求修改
   ↓
批准后 NodeWriter 物化 → 节点可被检索
```

### 6.3 业务域新增

```
管理员去 /knowledge/domains
   ↓
点 [+ 新增业务域]
   ↓
填 name (slug 实时校验) + display_label + color + icon
   ↓
"保存" → POST /domains
   ↓
新业务域立即出现在列表中
   ↓
全站下拉里都能选到（搜索 / 编辑器 / 源管理）
   ↓
（可选）拖拽改 sort_order
```

### 6.4 图谱探索冲突

```
用户去 /graph
   ↓
切到"关系图"视图
   ↓
看到橙色闪电状的 conflicts_with 边
   ↓
点击该边 → 浮窗显示两端节点 + 冲突 reasoning
   ↓
双击其中一端 → 跳详情页
   ↓
读详情决定如何裁决
   ↓
"标记过期" 或"提升"等操作
```

---

## 7. 移动端策略

### 7.1 范围

- MVP **不针对移动端做专门优化**
- ≥768px 屏幕（平板 + 笔记本 + 桌面）保证可用
- < 768px 显示降级提示："请在更宽屏幕访问知识库管理"

### 7.2 例外

未来若有需要，优先适配：

- `/knowledge/search` 搜索（最高频，Agent + 人都用）
- `/knowledge/:id` 详情查阅（高频）

`/review` / `/dashboard` / `/graph` / `/editor` 等管理类页面短期不做移动适配。

---

## 8. 无障碍 / i18n

### 8.1 无障碍（WCAG 2.1 AA）

- 颜色对比度 ≥ 4.5:1
- 所有交互元素键盘可达（Tab 顺序合理）
- 图标按钮配 `aria-label`
- 表单字段配 `<label>` 关联
- freshness 等纯色徽章额外加图标（不依赖颜色传达）

### 8.2 国际化

- 当前缤果场景中文为主，但 UI 字符串走 i18n 框架（参考 `2026-05-07-i18n-bilingual-design.md`）
- domain 的 `display_label` 字段由用户自行写（不进 i18n 资源），允许填中英双语
- 节点正文不翻译（用户写啥是啥）

---

## 9. 前端状态管理

### 9.1 数据请求层（沿用 Paperclip 现有 `@tanstack/react-query` 模式）

确认事实（基于 `ui/src/hooks/useInboxBadge.ts`、`useRetryNowMutation.ts` 等已有代码）：

- 使用 `useQuery` / `useMutation` / `useQueryClient`（React Query v5）
- `queryKey` 统一从 `ui/src/lib/queryKeys.ts` 取，**禁止内联字符串数组**
- mutation 优先使用 `onMutate` optimistic update + `onSettled` 重新失效相关 keys
- API 调用从 `ui/src/api/<resource>.ts` 模块封装，hooks 只调 API 不裸 fetch

LLM-Wiki 模块按此模式新增：

```typescript
// ui/src/api/knowledge.ts            （新增 API 模块）
export const knowledgeApi = {
  search: (companyId: string, opts: SearchOpts) => fetchJson(`/api/knowledge/search?...`),
  getNode: (id: string) => fetchJson(`/api/knowledge/nodes/${id}`),
  submitDraft: (input: DraftInput) => postJson(`/api/knowledge/drafts`, input),
  // ...
};

// ui/src/lib/queryKeys.ts            （在现有 file 中追加 knowledge 一段）
queryKeys.knowledge = {
  search: (companyId: string, opts: SearchOpts) => ["knowledge", "search", companyId, opts] as const,
  node: (id: string) => ["knowledge", "node", id] as const,
  drafts: (companyId: string, filters: DraftFilters) => ["knowledge", "drafts", companyId, filters] as const,
  domains: (companyId: string) => ["knowledge", "domains", companyId] as const,
  healthMetrics: (companyId: string) => ["knowledge", "metrics", companyId] as const,
  // ...
};

// ui/src/hooks/useKnowledgeSearch.ts
export function useKnowledgeSearch(companyId: string, opts: SearchOpts) {
  return useQuery({
    queryKey: queryKeys.knowledge.search(companyId, opts),
    queryFn: () => knowledgeApi.search(companyId, opts),
    enabled: !!companyId,
    staleTime: 30_000,
  });
}
```

### 9.2 关键 hooks 清单

文件命名沿用 Paperclip 风格 `useXxx.ts`（不在子目录），单文件单 hook 或几个紧密相关 hook：

| Hook 文件 | 用途 |
|----------|------|
| `useKnowledgeSearch.ts` | 搜索结果 |
| `useKnowledgeNode.ts` | 单节点 + edges + revisions + events |
| `useKnowledgeDrafts.ts` | 审查队列（query + approve/reject/batch mutations） |
| `useKnowledgeDomains.ts` | 业务域 CRUD（query + create/edit/archive mutations） |
| `useKnowledgeHealthMetrics.ts` | Dashboard 健康指标 |
| `useKnowledgeGraph.ts` | 图谱数据 |

mutation 实现遵循 `useInboxBadge.ts` 里 `useInboxDismissals` 同款 optimistic update 模式（`onMutate` 写 query cache，`onError` 回滚，`onSettled` `invalidateQueries`）。

### 9.3 实时更新策略

| 数据 | 策略 |
|------|------|
| 搜索结果 | `staleTime: 30_000` + 用户主动刷新 |
| 详情页 | `staleTime: 30_000` + WebSocket 推送变更触发 `invalidateQueries` |
| 审查队列 | `refetchInterval: 10_000` 轮询 + WebSocket 推送 |
| 健康指标 | `staleTime: Infinity`（每日自检后由 WebSocket 通知失效） |
| 图谱 | `staleTime: 60_000`，用户操作触发局部更新 |

WebSocket 通道沿用 Paperclip 现有 realtime 基础设施（若有），订阅频道 `knowledge:<company-id>:*`。具体频道命名按实施阶段时查 `ui/src/api/realtime.ts`（或对应模块）实际接口决定，**不预设接口名**。

---

## 10. 代码目录

**沿用 Paperclip 现有 file conventions**（design-guide §12）：页面 / 组件 PascalCase 单文件，hooks 平铺单文件，API 模块单文件。**不引入 kebab-case 子目录嵌套**（与现有风格不一致）。

### 10.1 页面（PascalCase，沿用 `ui/src/pages/*.tsx` 风格）

```
ui/src/pages/
├── KnowledgeSearch.tsx           → /knowledge/search
├── KnowledgeNodeDetail.tsx       → /knowledge/:id
├── KnowledgeReview.tsx           → /knowledge/review
├── KnowledgeDashboard.tsx        → /knowledge/dashboard
├── KnowledgeEditor.tsx           → /knowledge/editor
├── KnowledgeSources.tsx          → /knowledge/sources
├── KnowledgeDomains.tsx          → /knowledge/domains
└── KnowledgeGraph.tsx            → /knowledge/graph
```

### 10.2 新增 composite 组件（沿用 `ui/src/components/*.tsx` 风格）

```
ui/src/components/
├── NodeTypeBadge.tsx             # 仿 StatusBadge
├── FreshnessBadge.tsx            # 仿 StatusBadge
├── DomainBadge.tsx               # 仿 StatusBadge
├── DraftReviewCard.tsx           # 审查队列卡片（独立 composite）
├── MarkdownEditor.tsx            # CodeMirror 封装（含子模块见下）
├── MarkdownEditor.wikiLink.ts    # 扩展：[[ ]] 补全 + 渲染
├── MarkdownEditor.autosave.ts    # 扩展：localStorage 自动保存
├── GraphCanvas.tsx               # Cytoscape 封装
└── RevisionDiff.tsx              # 时间线 diff 视图
```

**复用而非新建**：`EntityRow` / `StatusBadge` / `MetricCard` / `InlineEditor` / `Layout` 已存在，按 §5.1 用法引用，不在此目录重复。

### 10.3 数据层（沿用 `ui/src/api/*.ts` 和 `ui/src/hooks/use*.ts` 风格）

```
ui/src/api/
└── knowledge.ts                  # 所有 /api/knowledge/* 请求封装

ui/src/lib/
├── queryKeys.ts                  # 在现有文件中追加 knowledge.* 一段（不新建文件）
├── knowledge-colors.ts           # nodeTypeBadge / domainColorClass map（仿 status-colors.ts）
└── knowledge-types.ts            # API 响应 TS 类型（手维护或 OpenAPI 生成）

ui/src/hooks/
├── useKnowledgeSearch.ts
├── useKnowledgeNode.ts
├── useKnowledgeDrafts.ts
├── useKnowledgeDomains.ts
├── useKnowledgeHealthMetrics.ts
└── useKnowledgeGraph.ts
```

### 10.4 必做：加入 design-guide 展示页

按 design-guide §10 规则，**每个新 composite 必须在 `ui/src/pages/DesignGuide.tsx` 添加展示节**：

- `NodeTypeBadge` — 展示 5 种 type 全变体
- `FreshnessBadge` — 展示 4 种 freshness label
- `DomainBadge` — 展示 12 种 color 预设 + 默认 icon
- `DraftReviewCard` — 展示 3 种 pre_verdict 状态 + 有/无冲突变体
- `MarkdownEditor` — 展示 `[[ ]]` 补全交互
- `GraphCanvas` — 展示 3 种 viewMode 缩略截图（图视图本身性能开销大，showcase 用静态 demo 数据）
- `RevisionDiff` — 展示 diff 渲染示例

这些节用现有 `<Section title="...">` + `<SubSection>` 结构，保持和 DesignGuide.tsx 其他章节一致。

---

**结束** — UI / 交互设计涵盖 8 个页面 + 6 个共享组件 + 4 个关键流程 + 状态管理 + 完整代码目录。
