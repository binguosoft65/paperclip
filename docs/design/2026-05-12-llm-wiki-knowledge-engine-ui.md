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

### 2.1 类型徽章（5 种节点类型，固定）

| type | 颜色 | 用途 |
|------|------|------|
| `concept` | 青色 `#06B6D4` | 抽象概念 |
| `lesson` | 橙色 `#F59E0B` | 教训 |
| `rule` | 红色 `#EF4444` | 强制规则 |
| `decision` | 紫色 `#8B5CF6` | 决策记录 |
| `fact` | 蓝色 `#3B82F6` | 事实陈述 |

### 2.2 freshness 标签（4 状态，固定）

| 标签 | 颜色 | 视觉处理 |
|------|------|---------|
| `fresh` | 绿色 `#10B981` | 正常显示 |
| `stale_warning` | 黄色 `#F59E0B` | ⚠ 前缀图标 |
| `outdated` | 灰色 `#6B7280` | 整卡片半透明 + 删除线标题 |
| `valid_expired` | 红色 `#DC2626` | 闪烁红边 |

### 2.3 边类型（6 种，图视图用）

| edge_type | 线条 | 颜色 |
|-----------|------|------|
| `references` | 细实线 | 灰色 `#9CA3AF` |
| `supersedes` | 粗虚线 | 红色 `#EF4444` |
| `merged_from` | 实线带 ⊕ 标记 | 蓝色 `#3B82F6` |
| `derived_from` | 实线带 ↑ 标记 | 紫色 `#8B5CF6` |
| `conflicts_with` | 闪电状 | 橙色 `#F97316` |
| `promoted_to` | 上升箭头 | 绿色 `#10B981` |

### 2.4 业务域配色（用户自配）

每个 `business_domain` 在创建时由用户选 `color`（hex）和 `icon`（lucide 图标 key）。前端：

```typescript
function DomainBadge({ domain }: { domain: Domain }) {
  return (
    <Badge style={{ backgroundColor: domain.color + '20', color: domain.color }}>
      {domain.icon && <Icon name={domain.icon} size={12} />}
      {domain.display_label}
    </Badge>
  );
}
```

颜色透明度 20% 作为背景，原色作前景，保证对比度。缤果初始 seed 时建议配色：

| 业务域 | 推荐 color | 推荐 icon |
|--------|-----------|-----------|
| `general` | `#6B7280` 灰 | `tag` |
| `software` | `#3B82F6` 蓝 | `code` |
| `content` | `#EC4899` 粉 | `pen-tool` |
| `distribution` | `#F97316` 橙 | `shopping-bag` |
| `community` | `#8B5CF6` 紫 | `users` |

### 2.5 字号与间距

复用 Paperclip 现有 design-guide skill 的字号系统，不引入新规则。

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
│ [#8B5CF6][🎨]     │
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

### 5.1 NodeCard

```typescript
interface NodeCardProps {
  node: Node;
  variant?: 'compact' | 'standard' | 'detailed';
  onClick?: () => void;
}
```

**3 种变体**：

- `compact`：仅 title + type 徽章 + freshness（用于详情页双链区）
- `standard`：title + type + domain + freshness + trigger + snippet（用于搜索结果）
- `detailed`：上述 + 完整 metadata（用于审查队列）

### 5.2 FreshnessIndicator

```typescript
interface FreshnessIndicatorProps {
  freshnessLabel: 'fresh' | 'stale_warning' | 'outdated' | 'valid_expired';
  freshnessScore?: number;                // hover 显示精确分数
  verifiedAt?: Date;
  validUntil?: Date;
  volatility?: 'stable' | 'slow' | 'fast';
}
```

显示规则：

| 标签 | 显示 |
|------|------|
| fresh | 不显示（默认状态） |
| stale_warning | `⚠ stale (fast / 110d 未验证)` |
| outdated | `⊘ outdated` 整卡半透明 |
| valid_expired | `🚨 已过期 (2025-12-31)` |

### 5.3 MarkdownEditor

基于 CodeMirror 6，自定义扩展：

```typescript
interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  companyId: string;                      // 用于 [[ ]] 补全的数据源
  placeholder?: string;
  autoFocus?: boolean;
  height?: string;
}
```

**关键扩展**：

1. `wikiLinkCompletion`：输入 `[[` 触发自动补全
2. `wikiLinkRenderer`：把 `[[uuid]]` 渲染为可点 chip
3. `markdownPreview`：右侧实时预览（可关闭）
4. `autosaveLocal`：localStorage 持久化（防丢失）
5. `slashCommand`：输入 `/` 弹出快捷命令（插入模板等）

**`[[ ]]` 补全数据源**：

```typescript
async function searchNodesForCompletion(query: string, companyId: string): Promise<Suggestion[]> {
  const res = await fetch(`/api/knowledge/nodes?title_q=${query}&limit=10&company_id=${companyId}`);
  return (await res.json()).data.map(n => ({
    label: n.title,
    detail: `${n.type} · ${n.domain.display_label}`,
    insertText: `[[${n.id}]]`,
  }));
}
```

### 5.4 DomainPicker

```typescript
interface DomainPickerProps {
  value?: string;                         // 当前选中 name
  onChange: (name: string) => void;
  excludeArchived?: boolean;              // 默认 true
  allowCreate?: boolean;                  // admin 可在下拉里"+ 新建"
}
```

下拉项渲染：徽章预览 + display_label + 节点数（如 `软件与 AI 工具 (42)`）。

### 5.5 HealthMetricCard

```typescript
interface HealthMetricCardProps {
  name: string;                           // 显示名
  value: number;
  status: 'healthy' | 'warning' | 'critical';
  unit?: string;
  trend?: number[];                       // 最近 30 天，用于 hover 折线
  onClick?: () => void;
}
```

### 5.6 GraphCanvas

封装 Cytoscape.js：

```typescript
interface GraphCanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  viewMode: 'relation' | 'timeline' | 'domain-cluster';
  highlight?: string;                     // 搜索高亮关键词
  onNodeClick?: (id: string) => void;
  onNodeDoubleClick?: (id: string) => void;
}
```

按 viewMode 切换 layout 算法和样式。

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

### 9.1 数据请求层

复用 Paperclip 现有的 react-query（TanStack Query）：

```typescript
// ui/src/hooks/knowledge/use-search.ts
export function useKnowledgeSearch(opts: SearchOpts) {
  return useQuery({
    queryKey: ['knowledge', 'search', opts],
    queryFn: () => fetch(`/api/knowledge/search?${toQueryString(opts)}`).then(r => r.json()),
    staleTime: 30_000,                    // 30s 内复用缓存
  });
}
```

### 9.2 关键 hooks

| Hook | 用途 |
|------|------|
| `useKnowledgeSearch(opts)` | 搜索结果 |
| `useNode(id)` | 单节点详情（含 edges） |
| `useNodeRevisions(id)` | 修订历史 |
| `useNodeEvents(id)` | 事件时间线 |
| `useDraftQueue(filters)` | 审查队列 |
| `useApproveDraft()` / `useRejectDraft()` | 审查操作 mutation |
| `useDomains()` / `useCreateDomain()` / `useArchiveDomain()` | 业务域管理 |
| `useHealthMetrics()` | Dashboard 健康指标 |
| `useGraphData(opts)` | 图谱数据 |

### 9.3 实时更新策略

| 数据 | 策略 |
|------|------|
| 搜索结果 | 30s staleTime + 用户主动刷新 |
| 详情页 | 30s staleTime + WebSocket 推送变更（如其他人审通过会推） |
| 审查队列 | 10s 轮询 + WebSocket 推送 |
| Dashboard 健康指标 | 每日 1 次（每日自检 Routine 跑后失效缓存） |
| 图谱 | 一次加载，用户操作触发局部更新 |

WebSocket 通道复用 Paperclip 现有的 `/api/realtime` 端点，订阅频道 `knowledge:<company-id>:*`。

---

## 10. 代码目录

### 10.1 页面

```
ui/src/pages/knowledge/
├── search.tsx                  → /knowledge/search
├── node-detail.tsx             → /knowledge/:id
├── review.tsx                  → /knowledge/review
├── dashboard.tsx               → /knowledge/dashboard
├── editor.tsx                  → /knowledge/editor
├── sources.tsx                 → /knowledge/sources
├── domains.tsx                 → /knowledge/domains
└── graph.tsx                   → /knowledge/graph
```

### 10.2 组件

```
ui/src/components/knowledge/
├── node-card/                  # 3 个 variant
│   ├── node-card-compact.tsx
│   ├── node-card-standard.tsx
│   └── node-card-detailed.tsx
├── freshness-indicator.tsx
├── type-badge.tsx
├── domain-badge.tsx
├── domain-picker.tsx
├── markdown-editor/            # CodeMirror + 自定义扩展
│   ├── editor.tsx
│   ├── wiki-link-completion.ts
│   ├── wiki-link-renderer.ts
│   ├── slash-command.ts
│   └── autosave-local.ts
├── health-metric-card.tsx
├── graph-canvas/               # Cytoscape 封装
│   ├── graph-canvas.tsx
│   ├── layouts.ts
│   └── styles.ts
├── revision-diff.tsx           # revision 时间线 diff 视图
└── review-queue-item.tsx       # 审查队列单项卡片
```

### 10.3 hooks

```
ui/src/hooks/knowledge/
├── use-search.ts
├── use-node.ts
├── use-node-revisions.ts
├── use-node-events.ts
├── use-draft-queue.ts
├── use-draft-mutations.ts      # approve / reject / request-revision
├── use-domains.ts
├── use-domain-mutations.ts
├── use-health-metrics.ts
└── use-graph-data.ts
```

### 10.4 共享类型

```
ui/src/types/knowledge.ts        # 与 API 响应类型一致，从 OpenAPI 自动生成或手维护
```

---

**结束** — UI / 交互设计涵盖 8 个页面 + 6 个共享组件 + 4 个关键流程 + 状态管理 + 完整代码目录。
