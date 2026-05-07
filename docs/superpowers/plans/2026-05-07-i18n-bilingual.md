# UI 中/英文双语切换 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Paperclip UI 添加中/英文双语支持，通过 react-i18next 实现所有 UI 文本国际化，语言切换器集成到 General Settings 页面。

**Architecture:** 基于 `react-i18next` + `i18next` 构建 i18n 层。翻译文件按命名空间分文件（common, status, activity, time, auth, settings, issues, keyboard），全量加载。LocaleContext（参考 ThemeContext 模式）管理语言检测和 localStorage 持久化。组件中使用 `useTranslation()` hook 获取 `t` 函数替换硬编码文本。

**Tech Stack:** react-i18next, i18next, i18next-browser-languagedetector, React 19, TypeScript 5.7

---

### Task 1: 安装 i18n 依赖

**Files:**
- Modify: `ui/package.json`

- [ ] **Step 1: 安装依赖**

Run:
```bash
cd /home/longwu/paperclip && pnpm --filter @paperclipai/ui add i18next react-i18next i18next-browser-languagedetector
```

Expected: 添加三个包到 `ui/package.json` 的 dependencies。

- [ ] **Step 2: 验证安装**

Run:
```bash
ls /home/longwu/paperclip/ui/node_modules/i18next/dist/esm/i18next.js
ls /home/longwu/paperclip/ui/node_modules/react-i18next/dist/es/index.js
ls /home/longwu/paperclip/ui/node_modules/i18next-browser-languagedetector/dist/esm/i18nextBrowserLanguageDetector.js
```

Expected: 三个文件都存在。

- [ ] **Step 3: 提交**

```bash
git add ui/package.json pnpm-lock.yaml
git commit -m "chore: add i18next, react-i18next, i18next-browser-languagedetector dependencies
Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 2: 创建 i18n 初始化模块

**Files:**
- Create: `ui/src/i18n/resources/en/common.json`
- Create: `ui/src/i18n/resources/en/status.json`
- Create: `ui/src/i18n/resources/en/activity.json`
- Create: `ui/src/i18n/resources/en/time.json`
- Create: `ui/src/i18n/resources/en/auth.json`
- Create: `ui/src/i18n/resources/en/settings.json`
- Create: `ui/src/i18n/resources/en/issues.json`
- Create: `ui/src/i18n/resources/en/keyboard.json`
- Create: `ui/src/i18n/resources/zh-CN/common.json`
- Create: `ui/src/i18n/resources/zh-CN/status.json`
- Create: `ui/src/i18n/resources/zh-CN/activity.json`
- Create: `ui/src/i18n/resources/zh-CN/time.json`
- Create: `ui/src/i18n/resources/zh-CN/auth.json`
- Create: `ui/src/i18n/resources/zh-CN/settings.json`
- Create: `ui/src/i18n/resources/zh-CN/issues.json`
- Create: `ui/src/i18n/resources/zh-CN/keyboard.json`
- Create: `ui/src/i18n/index.ts`

- [ ] **Step 1: 创建英文翻译文件 (common.json)**

Write `ui/src/i18n/resources/en/common.json`:

```json
{
  "loading": "Loading...",
  "error": {
    "generic": "Something went wrong",
    "authFailed": "Authentication failed",
    "signOutFailed": "Failed to sign out.",
    "loadSettings": "Failed to load general settings.",
    "updateSettings": "Failed to update general settings."
  },
  "sidebar": {
    "newIssue": "New Issue",
    "openSidebar": "Open sidebar"
  },
  "accountMenu": {
    "openMenu": "Open account menu",
    "viewProfile": "View profile",
    "editProfile": "Edit profile",
    "signOut": "Sign out",
    "documentation": "Documentation",
    "switchToDark": "Switch to dark mode",
    "switchToLight": "Switch to light mode"
  },
  "filter": {
    "clearAll": "Clear all"
  },
  "notFound": {
    "title": "Not Found",
    "companyNotFound": "Company not found",
    "pageNotFound": "Page not found",
    "openDashboard": "Open dashboard",
    "goHome": "Go home"
  },
  "signOut": {
    "label": "Sign out",
    "signingOut": "Signing out...",
    "description": "Sign out of this Paperclip instance. You will be redirected to the login page."
  },
  "language": {
    "label": "Language",
    "description": "Choose your preferred language for the interface.",
    "english": "English",
    "chinese": "中文"
  }
}
```

- [ ] **Step 2: 创建英文翻译文件 (status.json)**

Write `ui/src/i18n/resources/en/status.json`:

```json
{
  "issueStatus": {
    "backlog": "Backlog",
    "todo": "Todo",
    "in_progress": "In Progress",
    "in_review": "In Review",
    "done": "Done",
    "cancelled": "Cancelled",
    "blocked": "Blocked"
  },
  "priority": {
    "urgent": "Urgent",
    "high": "High",
    "medium": "Medium",
    "low": "Low"
  },
  "effort": {
    "none": "None",
    "tiny": "Tiny",
    "small": "Small",
    "medium": "Medium",
    "large": "Large",
    "xlarge": "X-Large"
  },
  "workMode": {
    "autonomous": "Autonomous",
    "manual": "Manual"
  },
  "blocked": {
    "label": "Blocked",
    "waitingOnActiveSubIssue_one": "Blocked · waiting on active sub-issue {{identifier}}",
    "waitingOnActiveSubIssues_one": "Blocked · waiting on 1 active sub-issue",
    "waitingOnActiveSubIssues_other": "Blocked · waiting on {{count}} active sub-issues",
    "coveredByActiveDependency_one": "Blocked · covered by active dependency {{identifier}}",
    "coveredByActiveDependencies_one": "Blocked · covered by 1 active dependency",
    "coveredByActiveDependencies_other": "Blocked · covered by {{count}} active dependencies",
    "reviewStalledOn": "Blocked · review stalled on {{identifier}}",
    "reviewStalledNoNextStep": "Blocked · review stalled with no clear next step",
    "reviewsStalledNoNextStep": "Blocked · {{count}} reviews stalled with no clear next step",
    "blockerNeedsAttention": "{{count}} blocker needs attention",
    "blockersNeedAttention": "{{count}} blockers need attention",
    "coveredByActiveWork": "{{covered}} covered by active work"
  }
}
```

- [ ] **Step 3: 创建英文翻译文件 (activity.json)**

Write `ui/src/i18n/resources/en/activity.json`:

```json
{
  "verbs": {
    "issue.created": "created",
    "issue.updated": "updated",
    "issue.checked_out": "checked out",
    "issue.released": "released",
    "issue.comment_added": "commented on",
    "issue.comment_cancelled": "cancelled a queued comment on",
    "issue.attachment_added": "attached file to",
    "issue.attachment_removed": "removed attachment from",
    "issue.document_created": "created document for",
    "issue.document_updated": "updated document on",
    "issue.document_deleted": "deleted document from",
    "issue.monitor_scheduled": "scheduled monitor on",
    "issue.monitor_triggered": "triggered monitor for",
    "issue.monitor_cleared": "cleared monitor on",
    "issue.monitor_skipped": "skipped monitor for",
    "issue.monitor_exhausted": "exhausted monitor on",
    "issue.monitor_recovery_wake_queued": "queued monitor recovery for",
    "issue.monitor_recovery_issue_created": "created monitor recovery for",
    "issue.monitor_escalated_to_board": "escalated monitor for",
    "issue.commented": "commented on",
    "issue.deleted": "deleted",
    "issue.successful_run_handoff_required": "flagged missing next step on",
    "issue.successful_run_handoff_resolved": "recorded next step chosen on",
    "issue.successful_run_handoff_escalated": "escalated missing next step on",
    "agent.created": "created",
    "agent.updated": "updated",
    "agent.paused": "paused",
    "agent.resumed": "resumed",
    "agent.terminated": "terminated",
    "agent.key_created": "created API key for",
    "agent.budget_updated": "updated budget for",
    "agent.runtime_session_reset": "reset session for",
    "heartbeat.invoked": "invoked heartbeat for",
    "heartbeat.cancelled": "cancelled heartbeat for",
    "approval.created": "requested approval",
    "approval.approved": "approved",
    "approval.rejected": "rejected",
    "project.created": "created",
    "project.updated": "updated",
    "project.deleted": "deleted",
    "goal.created": "created",
    "goal.updated": "updated",
    "goal.deleted": "deleted",
    "cost.reported": "reported cost for",
    "cost.recorded": "recorded cost for",
    "company.created": "created company",
    "company.updated": "updated company",
    "company.archived": "archived",
    "company.budget_updated": "updated budget for"
  },
  "issueLabels": {
    "issue.created": "created the issue",
    "issue.updated": "updated the issue",
    "issue.checked_out": "checked out the issue",
    "issue.released": "released the issue",
    "issue.comment_added": "added a comment",
    "issue.comment_cancelled": "cancelled a queued comment",
    "issue.feedback_vote_saved": "saved feedback on an AI output",
    "issue.attachment_added": "added an attachment",
    "issue.attachment_removed": "removed an attachment",
    "issue.document_created": "created a document",
    "issue.document_updated": "updated a document",
    "issue.document_deleted": "deleted a document",
    "issue.monitor_scheduled": "scheduled a monitor",
    "issue.monitor_triggered": "triggered a monitor",
    "issue.monitor_cleared": "cleared a monitor",
    "issue.monitor_skipped": "skipped a monitor",
    "issue.monitor_exhausted": "exhausted a monitor",
    "issue.monitor_recovery_wake_queued": "queued a monitor recovery wake",
    "issue.monitor_recovery_issue_created": "created a monitor recovery issue",
    "issue.monitor_escalated_to_board": "escalated a monitor to the board",
    "issue.deleted": "deleted the issue",
    "issue.successful_run_handoff_required": "Run finished without a clear next step",
    "issue.successful_run_handoff_resolved": "Next step chosen",
    "issue.successful_run_handoff_escalated": "Run finished without a next step - recovery escalated",
    "agent.created": "created an agent",
    "agent.updated": "updated the agent",
    "agent.paused": "paused the agent",
    "agent.resumed": "resumed the agent",
    "agent.terminated": "terminated the agent",
    "heartbeat.invoked": "invoked a heartbeat",
    "heartbeat.cancelled": "cancelled a heartbeat",
    "approval.created": "requested approval",
    "approval.approved": "approved",
    "approval.rejected": "rejected"
  },
  "changedStatusFrom": "changed status from {{from}} to {{to}} on",
  "changedStatusTo": "changed status to {{to}} on",
  "changedPriorityFrom": "changed priority from {{from}} to {{to}} on",
  "changedPriorityTo": "changed priority to {{to}} on",
  "changedStatusFromIssue": "changed the status from {{from}} to {{to}}",
  "changedStatusToIssue": "changed the status to {{to}}",
  "changedPriorityFromIssue": "changed the priority from {{from}} to {{to}}",
  "changedPriorityToIssue": "changed the priority to {{to}}",
  "assignedIssueTo": "assigned the issue to {{name}}",
  "unassignedIssue": "unassigned the issue",
  "updatedTitle": "updated the title",
  "updatedDescription": "updated the description",
  "added": "added {{changed}}",
  "addedTo": "added {{changed}} to",
  "removed": "removed {{changed}}",
  "removedFrom": "removed {{changed}} from",
  "updatedBlockers": "updated blockers",
  "updatedBlockersOn": "updated blockers on",
  "updatedReviewers": "updated reviewers",
  "updatedReviewersOn": "updated reviewers on",
  "updatedApprovers": "updated approvers",
  "updatedApproversOn": "updated approvers on",
  "board": "Board",
  "you": "You",
  "user": "user {{id}}",
  "issue": "issue",
  "forService": "{{base}} for {{serviceName}}",
  "blocker_singular": "blocker",
  "blockers_plural": "blockers",
  "reviewer_singular": "reviewer",
  "reviewers_plural": "reviewers",
  "approver_singular": "approver",
  "approvers_plural": "approvers",
  "categories": {
    "issue": "Issue",
    "agent": "Agent",
    "approval": "Approval",
    "project": "Project",
    "goal": "Goal",
    "cost": "Cost",
    "company": "Company",
    "heartbeat": "Heartbeat",
    "system": "System",
    "unknown": "Unknown"
  }
}
```

- [ ] **Step 4: 创建英文翻译文件 (time.json)**

Write `ui/src/i18n/resources/en/time.json`:

```json
{
  "justNow": "just now",
  "mAgo": "{{n}}m ago",
  "hAgo": "{{n}}h ago",
  "dAgo": "{{n}}d ago",
  "wAgo": "{{n}}w ago",
  "moAgo": "{{n}}mo ago"
}
```

- [ ] **Step 5: 创建英文翻译文件 (auth.json)**

Write `ui/src/i18n/resources/en/auth.json`:

```json
{
  "loading": "Loading...",
  "authFailed": "Authentication failed",
  "signIn": "Sign in",
  "signUp": "Sign up",
  "or": "or",
  "signInDescription": "Sign in to your account",
  "signUpDescription": "Create a new account",
  "swapToSignUp": "Don't have an account? Sign up",
  "swapToSignIn": "Already have an account? Sign in"
}
```

- [ ] **Step 6: 创建英文翻译文件 (settings.json)**

Write `ui/src/i18n/resources/en/settings.json`:

```json
{
  "instanceSettings": "Instance Settings",
  "general": "General",
  "loading": "Loading general settings...",
  "description": "Configure instance-wide preferences including log display, keyboard shortcuts, backup retention, and data sharing.",
  "deploymentAndAuth": "Deployment and auth",
  "localTrustedDescription": "Local trusted mode is optimized for a local operator. Browser requests run as local board context and no sign-in is required.",
  "publicModeDescription": "Authenticated public mode requires sign-in for board access and is intended for public URLs.",
  "privateModeDescription": "Authenticated private mode requires sign-in and is intended for LAN, VPN, or other private-network deployments.",
  "authReadiness": "Auth readiness",
  "bootstrapStatus": "Bootstrap status",
  "bootstrapInvite": "Bootstrap invite",
  "ready": "Ready",
  "notReady": "Not ready",
  "setupRequired": "Setup required",
  "active": "Active",
  "none": "None",
  "censorUsername": "Censor username in logs",
  "censorUsernameDesc": "Hide the username segment in home-directory paths and similar operator-visible log output. Standalone username mentions outside of paths are not yet masked in the live transcript view. This is off by default.",
  "keyboardShortcuts": "Keyboard shortcuts",
  "keyboardShortcutsDesc": "Enable app keyboard shortcuts, including inbox navigation and global shortcuts like creating issues or toggling panels. This is off by default.",
  "backupRetention": "Backup retention",
  "backupRetentionDesc": "Configure how long automatic database backups are retained. Backups run roughly every hour and are compressed with gzip. Within the daily window all backups are kept; beyond that, one backup per week and one per month are preserved.",
  "daily": "Daily",
  "weekly": "Weekly",
  "monthly": "Monthly",
  "days": "{{n}} days",
  "oneWeek": "1 week",
  "weeks": "{{n}} weeks",
  "oneMonth": "1 month",
  "months": "{{n}} months",
  "aiFeedbackSharing": "AI feedback sharing",
  "aiFeedbackSharingDesc": "Control whether thumbs up and thumbs down votes can send the voted AI output to Paperclip Labs. Votes are always saved locally.",
  "readTermsOfService": "Read our terms of service",
  "noDefaultSaved": "No default is saved yet. The next thumbs up or thumbs down choice will ask once and then save the answer here.",
  "alwaysAllow": "Always allow",
  "alwaysAllowDesc": "Share voted AI outputs automatically.",
  "dontAllow": "Don't allow",
  "dontAllowDesc": "Keep voted AI outputs local only.",
  "feedbackResetNote": "To retest the first-use prompt in local dev, remove the <code>feedbackDataSharingPreference</code> key from the <code>instance_settings.general</code> JSON row for this instance, or set it back to <code>\"prompt\"</code>. Unset and <code>\"prompt\"</code> both mean no default has been chosen yet.",
  "signOutSection": "Sign out",
  "signOutSectionDesc": "Sign out of this Paperclip instance. You will be redirected to the login page.",
  "signOutButton": "Sign out",
  "signingOut": "Signing out...",
  "toggleCensorUsername": "Toggle username log censoring",
  "toggleKeyboardShortcuts": "Toggle keyboard shortcuts",
  "experimental": "Experimental",
  "confirmAutoRecovery": "Confirm auto-recovery",
  "confirmDescription": "Are you sure you want to trigger auto-recovery? This will attempt to recover stalled runs.",
  "recoveryTasks_one": "{{count}} recovery task matches the provided criteria.",
  "recoveryTasks_other": "{{count}} recovery tasks match the provided criteria.",
  "cancel": "Cancel",
  "confirm": "Confirm"
}
```

- [ ] **Step 7: 创建英文翻译文件 (issues.json)**

Write `ui/src/i18n/resources/en/issues.json`:

```json
{
  "newIssue": "New Issue",
  "createIssue": "Create Issue",
  "editIssue": "Edit Issue",
  "title": "Title",
  "titlePlaceholder": "Enter issue title",
  "description": "Description",
  "descriptionPlaceholder": "Describe the issue...",
  "status": "Status",
  "priority": "Priority",
  "effort": "Effort",
  "assignee": "Assignee",
  "workMode": "Work Mode",
  "cancel": "Cancel",
  "save": "Save",
  "create": "Create",
  "saving": "Saving...",
  "creating": "Creating...",
  "noAgent": "No agent",
  "noAssignee": "Unassigned"
}
```

- [ ] **Step 8: 创建英文翻译文件 (keyboard.json)**

Write `ui/src/i18n/resources/en/keyboard.json`:

```json
{
  "title": "Keyboard shortcuts",
  "close": "Close",
  "general": "General",
  "inbox": "Inbox",
  "panels": "Panels",
  "navigation": "Navigation",
  "global": "Global",
  "createIssue": "Create new issue",
  "toggleInbox": "Open / close inbox",
  "openInbox": "Open inbox",
  "closeInbox": "Close inbox",
  "dismissSelected": "Dismiss selected item",
  "archiveSelected": "Archive selected item",
  "prevItem": "Previous item",
  "nextItem": "Next item",
  "selectItem": "Select / open item",
  "prevPage": "Previous page",
  "nextPage": "Next page",
  "toggleSidebar": "Toggle sidebar",
  "togglePanel": "Toggle panel",
  "toggleAppStatus": "Toggle app status panel",
  "searchIssues": "Search / browse issues",
  "goToDashboard": "Go to dashboard",
  "goToIssues": "Go to issues",
  "goToAgents": "Go to agents",
  "goToGoals": "Go to goals",
  "goToProjects": "Go to projects",
  "goToMonitoring": "Go to monitoring",
  "goToAuditLogs": "Go to audit logs",
  "goToSettings": "Go to settings",
  "toggleTheme": "Toggle dark / light theme",
  "requiresInboxOpen": "Requires inbox to be open",
  "canRebind": "Shortcuts can be customized in settings"
}
```

- [ ] **Step 9: 创建中文翻译文件 (common.json)**

Write `ui/src/i18n/resources/zh-CN/common.json`:

```json
{
  "loading": "加载中...",
  "error": {
    "generic": "出了点问题",
    "authFailed": "认证失败",
    "signOutFailed": "退出登录失败。",
    "loadSettings": "加载通用设置失败。",
    "updateSettings": "更新通用设置失败。"
  },
  "sidebar": {
    "newIssue": "新建 Issue",
    "openSidebar": "打开侧边栏"
  },
  "accountMenu": {
    "openMenu": "打开账号菜单",
    "viewProfile": "查看个人资料",
    "editProfile": "编辑个人资料",
    "signOut": "退出登录",
    "documentation": "文档",
    "switchToDark": "切换到深色模式",
    "switchToLight": "切换到浅色模式"
  },
  "filter": {
    "clearAll": "清除全部"
  },
  "notFound": {
    "title": "未找到",
    "companyNotFound": "公司未找到",
    "pageNotFound": "页面未找到",
    "openDashboard": "打开仪表盘",
    "goHome": "回到首页"
  },
  "signOut": {
    "label": "退出登录",
    "signingOut": "正在退出...",
    "description": "退出此 Paperclip 实例，你将被重定向到登录页面。"
  },
  "language": {
    "label": "语言",
    "description": "选择你偏好的界面语言。",
    "english": "English",
    "chinese": "中文"
  }
}
```

- [ ] **Step 10: 创建中文翻译文件 (status.json)**

Write `ui/src/i18n/resources/zh-CN/status.json`:

```json
{
  "issueStatus": {
    "backlog": "待规划",
    "todo": "待办",
    "in_progress": "进行中",
    "in_review": "评审中",
    "done": "已完成",
    "cancelled": "已取消",
    "blocked": "已阻塞"
  },
  "priority": {
    "urgent": "紧急",
    "high": "高",
    "medium": "中",
    "low": "低"
  },
  "effort": {
    "none": "无",
    "tiny": "极小",
    "small": "小",
    "medium": "中",
    "large": "大",
    "xlarge": "特大"
  },
  "workMode": {
    "autonomous": "自动",
    "manual": "手动"
  },
  "blocked": {
    "label": "已阻塞",
    "waitingOnActiveSubIssue_one": "已阻塞 · 等待活跃子 Issue {{identifier}}",
    "waitingOnActiveSubIssues_one": "已阻塞 · 等待 1 个活跃子 Issue",
    "waitingOnActiveSubIssues_other": "已阻塞 · 等待 {{count}} 个活跃子 Issue",
    "coveredByActiveDependency_one": "已阻塞 · 被活跃依赖覆盖 {{identifier}}",
    "coveredByActiveDependencies_one": "已阻塞 · 被 1 个活跃依赖覆盖",
    "coveredByActiveDependencies_other": "已阻塞 · 被 {{count}} 个活跃依赖覆盖",
    "reviewStalledOn": "已阻塞 · 评审停滞于 {{identifier}}",
    "reviewStalledNoNextStep": "已阻塞 · 评审停滞无下一步",
    "reviewsStalledNoNextStep": "已阻塞 · {{count}} 个评审停滞无下一步",
    "blockerNeedsAttention": "{{count}} 个阻塞项需要关注",
    "blockersNeedAttention": "{{count}} 个阻塞项需要关注",
    "coveredByActiveWork": "{{covered}} 个被活跃工作覆盖"
  }
}
```

- [ ] **Step 11: 创建中文翻译文件 (activity.json)**

Write `ui/src/i18n/resources/zh-CN/activity.json`:

```json
{
  "verbs": {
    "issue.created": "创建了",
    "issue.updated": "更新了",
    "issue.checked_out": "签出了",
    "issue.released": "释放了",
    "issue.comment_added": "评论了",
    "issue.comment_cancelled": "取消了对",
    "issue.attachment_added": "向",
    "issue.attachment_removed": "从",
    "issue.document_created": "创建了文档于",
    "issue.document_updated": "更新了文档于",
    "issue.document_deleted": "删除了文档于",
    "issue.monitor_scheduled": "安排了监控于",
    "issue.monitor_triggered": "触发了监控于",
    "issue.monitor_cleared": "清除了监控于",
    "issue.monitor_skipped": "跳过了监控于",
    "issue.monitor_exhausted": "耗尽了监控于",
    "issue.monitor_recovery_wake_queued": "排队恢复监控于",
    "issue.monitor_recovery_issue_created": "创建恢复监控于",
    "issue.monitor_escalated_to_board": "升级监控于",
    "issue.commented": "评论了",
    "issue.deleted": "删除了",
    "issue.successful_run_handoff_required": "标记了缺少下一步于",
    "issue.successful_run_handoff_resolved": "记录了已选下一步于",
    "issue.successful_run_handoff_escalated": "升级缺少下一步于",
    "agent.created": "创建了",
    "agent.updated": "更新了",
    "agent.paused": "暂停了",
    "agent.resumed": "恢复了",
    "agent.terminated": "终止了",
    "agent.key_created": "创建了 API 密钥于",
    "agent.budget_updated": "更新了预算于",
    "agent.runtime_session_reset": "重置了会话于",
    "heartbeat.invoked": "调用了心跳于",
    "heartbeat.cancelled": "取消了心跳于",
    "approval.created": "请求了审批",
    "approval.approved": "批准了",
    "approval.rejected": "拒绝了",
    "project.created": "创建了",
    "project.updated": "更新了",
    "project.deleted": "删除了",
    "goal.created": "创建了",
    "goal.updated": "更新了",
    "goal.deleted": "删除了",
    "cost.reported": "报告了费用于",
    "cost.recorded": "记录了费用于",
    "company.created": "创建了公司",
    "company.updated": "更新了公司",
    "company.archived": "归档了",
    "company.budget_updated": "更新了预算于"
  },
  "issueLabels": {
    "issue.created": "创建了此 Issue",
    "issue.updated": "更新了此 Issue",
    "issue.checked_out": "签出了此 Issue",
    "issue.released": "释放了此 Issue",
    "issue.comment_added": "添加了一条评论",
    "issue.comment_cancelled": "取消了一条排队评论",
    "issue.feedback_vote_saved": "保存了对 AI 输出的反馈",
    "issue.attachment_added": "添加了一个附件",
    "issue.attachment_removed": "移除了一个附件",
    "issue.document_created": "创建了一个文档",
    "issue.document_updated": "更新了一个文档",
    "issue.document_deleted": "删除了一个文档",
    "issue.monitor_scheduled": "安排了一个监控",
    "issue.monitor_triggered": "触发了一个监控",
    "issue.monitor_cleared": "清除了一个监控",
    "issue.monitor_skipped": "跳过一个监控",
    "issue.monitor_exhausted": "耗尽了一个监控",
    "issue.monitor_recovery_wake_queued": "排队了一个监控恢复唤醒",
    "issue.monitor_recovery_issue_created": "创建了一个监控恢复 Issue",
    "issue.monitor_escalated_to_board": "升级了一个监控到看板",
    "issue.deleted": "删除了此 Issue",
    "issue.successful_run_handoff_required": "运行完成但缺少明确的下一步",
    "issue.successful_run_handoff_resolved": "已选择下一步",
    "issue.successful_run_handoff_escalated": "运行完成无下一步 - 恢复已升级",
    "agent.created": "创建了一个 Agent",
    "agent.updated": "更新了此 Agent",
    "agent.paused": "暂停了此 Agent",
    "agent.resumed": "恢复了此 Agent",
    "agent.terminated": "终止了此 Agent",
    "heartbeat.invoked": "调用了一个心跳",
    "heartbeat.cancelled": "取消了一个心跳",
    "approval.created": "请求了审批",
    "approval.approved": "已批准",
    "approval.rejected": "已拒绝"
  },
  "changedStatusFrom": "将状态从 {{from}} 改为 {{to}} 于",
  "changedStatusTo": "将状态改为 {{to}} 于",
  "changedPriorityFrom": "将优先级从 {{from}} 改为 {{to}} 于",
  "changedPriorityTo": "将优先级改为 {{to}} 于",
  "changedStatusFromIssue": "将状态从 {{from}} 改为 {{to}}",
  "changedStatusToIssue": "将状态改为 {{to}}",
  "changedPriorityFromIssue": "将优先级从 {{from}} 改为 {{to}}",
  "changedPriorityToIssue": "将优先级改为 {{to}}",
  "assignedIssueTo": "将 Issue 分配给 {{name}}",
  "unassignedIssue": "取消了 Issue 分配",
  "updatedTitle": "更新了标题",
  "updatedDescription": "更新了描述",
  "added": "添加了 {{changed}}",
  "addedTo": "向",
  "removed": "移除了 {{changed}}",
  "removedFrom": "从",
  "updatedBlockers": "更新了阻塞项",
  "updatedBlockersOn": "更新了阻塞项于",
  "updatedReviewers": "更新了评审人",
  "updatedReviewersOn": "更新了评审人于",
  "updatedApprovers": "更新了审批人",
  "updatedApproversOn": "更新了审批人于",
  "board": "看板",
  "you": "你",
  "user": "用户 {{id}}",
  "issue": "issue",
  "forService": "{{base}}（{{serviceName}}）",
  "blocker_singular": "个阻塞项",
  "blockers_plural": "个阻塞项",
  "reviewer_singular": "个评审人",
  "reviewers_plural": "个评审人",
  "approver_singular": "个审批人",
  "approvers_plural": "个审批人",
  "categories": {
    "issue": "Issue",
    "agent": "Agent",
    "approval": "审批",
    "project": "项目",
    "goal": "目标",
    "cost": "费用",
    "company": "公司",
    "heartbeat": "心跳",
    "system": "系统",
    "unknown": "未知"
  }
}
```

- [ ] **Step 12: 创建中文翻译文件 (time.json)**

Write `ui/src/i18n/resources/zh-CN/time.json`:

```json
{
  "justNow": "刚刚",
  "mAgo": "{{n}} 分钟前",
  "hAgo": "{{n}} 小时前",
  "dAgo": "{{n}} 天前",
  "wAgo": "{{n}} 周前",
  "moAgo": "{{n}} 个月前"
}
```

- [ ] **Step 13: 创建中文翻译文件 (auth.json)**

Write `ui/src/i18n/resources/zh-CN/auth.json`:

```json
{
  "loading": "加载中...",
  "authFailed": "认证失败",
  "signIn": "登录",
  "signUp": "注册",
  "or": "或",
  "signInDescription": "登录你的账号",
  "signUpDescription": "创建一个新账号",
  "swapToSignUp": "没有账号？注册",
  "swapToSignIn": "已有账号？登录"
}
```

- [ ] **Step 14: 创建中文翻译文件 (settings.json)**

Write `ui/src/i18n/resources/zh-CN/settings.json`:

```json
{
  "instanceSettings": "实例设置",
  "general": "通用",
  "loading": "正在加载通用设置...",
  "description": "配置实例级别的偏好设置，包括日志显示、键盘快捷键、备份保留和数据共享。",
  "deploymentAndAuth": "部署与认证",
  "localTrustedDescription": "本地可信模式针对本地操作员优化。浏览器请求以本地看板上下文运行，无需登录。",
  "publicModeDescription": "认证公开模式需要登录才能访问看板，适用于公开 URL。",
  "privateModeDescription": "认证私有模式需要登录，适用于 LAN、VPN 或其他私有网络部署。",
  "authReadiness": "认证就绪状态",
  "bootstrapStatus": "初始化状态",
  "bootstrapInvite": "初始化邀请",
  "ready": "就绪",
  "notReady": "未就绪",
  "setupRequired": "需要设置",
  "active": "活跃",
  "none": "无",
  "censorUsername": "在日志中隐藏用户名",
  "censorUsernameDesc": "在主目录路径和类似的操作员可见日志输出中隐藏用户名字段。路径之外的独立用户名提及目前尚未在实时记录视图中屏蔽。默认关闭。",
  "keyboardShortcuts": "键盘快捷键",
  "keyboardShortcutsDesc": "启用在应用范围内的键盘快捷键，包括收件箱导航和全局快捷键（如创建 Issue 或切换面板）。默认关闭。",
  "backupRetention": "备份保留",
  "backupRetentionDesc": "配置自动数据库备份的保留时间。备份大约每小时运行一次，使用 gzip 压缩。在每日窗口中所有备份均保留；超出后每周保留一次，每月保留一次。",
  "daily": "每日",
  "weekly": "每周",
  "monthly": "每月",
  "days": "{{n}} 天",
  "oneWeek": "1 周",
  "weeks": "{{n}} 周",
  "oneMonth": "1 个月",
  "months": "{{n}} 个月",
  "aiFeedbackSharing": "AI 反馈分享",
  "aiFeedbackSharingDesc": "控制点赞和点踩是否可以发送已投票的 AI 输出到 Paperclip Labs。投票始终保存在本地。",
  "readTermsOfService": "阅读我们的服务条款",
  "noDefaultSaved": "尚未保存默认值。下一次点赞或点踩将询问一次，然后将答案保存在此。",
  "alwaysAllow": "始终允许",
  "alwaysAllowDesc": "自动分享已投票的 AI 输出。",
  "dontAllow": "不允许",
  "dontAllowDesc": "将已投票的 AI 输出仅保留在本地。",
  "feedbackResetNote": "要在本地开发中重新测试首次使用提示，请从此实例的 <code>instance_settings.general</code> JSON 行中删除 <code>feedbackDataSharingPreference</code> 键，或将其设置回 <code>\"prompt\"</code>。未设置和 <code>\"prompt\"</code> 均表示尚未选择默认值。",
  "signOutSection": "退出登录",
  "signOutSectionDesc": "退出此 Paperclip 实例，你将被重定向到登录页面。",
  "signOutButton": "退出登录",
  "signingOut": "正在退出...",
  "toggleCensorUsername": "切换用户名日志隐藏",
  "toggleKeyboardShortcuts": "切换键盘快捷键",
  "experimental": "实验性",
  "confirmAutoRecovery": "确认自动恢复",
  "confirmDescription": "你确定要触发自动恢复吗？这将尝试恢复停滞的运行。",
  "recoveryTasks_one": "{{count}} 个恢复任务符合提供的条件。",
  "recoveryTasks_other": "{{count}} 个恢复任务符合提供的条件。",
  "cancel": "取消",
  "confirm": "确认"
}
```

- [ ] **Step 15: 创建中文翻译文件 (issues.json)**

Write `ui/src/i18n/resources/zh-CN/issues.json`:

```json
{
  "newIssue": "新建 Issue",
  "createIssue": "创建 Issue",
  "editIssue": "编辑 Issue",
  "title": "标题",
  "titlePlaceholder": "输入 Issue 标题",
  "description": "描述",
  "descriptionPlaceholder": "描述此 Issue...",
  "status": "状态",
  "priority": "优先级",
  "effort": "工作量",
  "assignee": "负责人",
  "workMode": "工作模式",
  "cancel": "取消",
  "save": "保存",
  "create": "创建",
  "saving": "保存中...",
  "creating": "创建中...",
  "noAgent": "无 Agent",
  "noAssignee": "未分配"
}
```

- [ ] **Step 16: 创建中文翻译文件 (keyboard.json)**

Write `ui/src/i18n/resources/zh-CN/keyboard.json`:

```json
{
  "title": "键盘快捷键",
  "close": "关闭",
  "general": "通用",
  "inbox": "收件箱",
  "panels": "面板",
  "navigation": "导航",
  "global": "全局",
  "createIssue": "创建新 Issue",
  "toggleInbox": "打开 / 关闭收件箱",
  "openInbox": "打开收件箱",
  "closeInbox": "关闭收件箱",
  "dismissSelected": "忽略选中项",
  "archiveSelected": "归档选中项",
  "prevItem": "上一个项目",
  "nextItem": "下一个项目",
  "selectItem": "选择 / 打开项目",
  "prevPage": "上一页",
  "nextPage": "下一页",
  "toggleSidebar": "切换侧边栏",
  "togglePanel": "切换面板",
  "toggleAppStatus": "切换应用状态面板",
  "searchIssues": "搜索 / 浏览 Issue",
  "goToDashboard": "前往仪表盘",
  "goToIssues": "前往 Issue",
  "goToAgents": "前往 Agent",
  "goToGoals": "前往目标",
  "goToProjects": "前往项目",
  "goToMonitoring": "前往监控",
  "goToAuditLogs": "前往审计日志",
  "goToSettings": "前往设置",
  "toggleTheme": "切换深色 / 浅色主题",
  "requiresInboxOpen": "需要收件箱处于打开状态",
  "canRebind": "快捷键可在设置中自定义"
}
```

- [ ] **Step 17: 创建 i18next 初始化模块**

Write `ui/src/i18n/index.ts`:

```typescript
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import common from "./resources/en/common.json";
import status from "./resources/en/status.json";
import activity from "./resources/en/activity.json";
import time from "./resources/en/time.json";
import auth from "./resources/en/auth.json";
import settings from "./resources/en/settings.json";
import issues from "./resources/en/issues.json";
import keyboard from "./resources/en/keyboard.json";
import commonZh from "./resources/zh-CN/common.json";
import statusZh from "./resources/zh-CN/status.json";
import activityZh from "./resources/zh-CN/activity.json";
import timeZh from "./resources/zh-CN/time.json";
import authZh from "./resources/zh-CN/auth.json";
import settingsZh from "./resources/zh-CN/settings.json";
import issuesZh from "./resources/zh-CN/issues.json";
import keyboardZh from "./resources/zh-CN/keyboard.json";

export const LOCALE_STORAGE_KEY = "paperclip.locale";

export type SupportedLocale = "en" | "zh-CN";

export function isSupportedLocale(value: string | null): value is SupportedLocale {
  return value === "en" || value === "zh-CN";
}

export function detectLocale(): SupportedLocale {
  if (typeof navigator === "undefined") return "en";
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (isSupportedLocale(stored)) return stored;
  } catch {
    // localStorage not available
  }
  const lang = navigator.language.toLowerCase();
  if (lang.startsWith("zh")) return "zh-CN";
  return "en";
}

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { common, status, activity, time, auth, settings, issues, keyboard },
      "zh-CN": {
        common: commonZh,
        status: statusZh,
        activity: activityZh,
        time: timeZh,
        auth: authZh,
        settings: settingsZh,
        issues: issuesZh,
        keyboard: keyboardZh,
      },
    },
    lng: detectLocale(),
    fallbackLng: "en",
    defaultNS: "common",
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ["localStorage"],
      lookupLocalStorage: LOCALE_STORAGE_KEY,
      caches: [],
    },
  });

i18n.on("languageChanged", (lng) => {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, lng);
  } catch {
    // ignore
  }
  if (typeof document !== "undefined") {
    document.documentElement.lang = lng;
  }
});

export default i18n;
```

- [ ] **Step 18: 验证 TypeScript 编译**

Run:
```bash
cd /home/longwu/paperclip && pnpm --filter @paperclipai/ui exec tsc -b --noEmit 2>&1 | head -30
```

Expected: 无编译错误（可能会有已存在的错误，但不应该有与 i18n 相关的错误）。

- [ ] **Step 19: 提交**

```bash
git add ui/src/i18n/
git commit -m "feat: add i18n initialization module and translation files
Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 3: 创建 LocaleContext

**Files:**
- Create: `ui/src/context/LocaleContext.tsx`
- Modify: `ui/src/main.tsx`

- [ ] **Step 1: 创建 LocaleContext**

Write `ui/src/context/LocaleContext.tsx`:

```typescript
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import type { SupportedLocale } from "@/i18n";
import { isSupportedLocale } from "@/i18n";

interface LocaleContextValue {
  locale: SupportedLocale;
  setLocale: (locale: SupportedLocale) => void;
}

const LocaleContext = createContext<LocaleContextValue | undefined>(undefined);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const { i18n } = useTranslation();

  const locale: SupportedLocale = isSupportedLocale(i18n.language)
    ? i18n.language
    : "en";

  const setLocale = useCallback(
    (next: SupportedLocale) => {
      i18n.changeLanguage(next);
    },
    [i18n],
  );

  const value = useMemo(
    () => ({ locale, setLocale }),
    [locale, setLocale],
  );

  return (
    <LocaleContext.Provider value={value}>
      {children}
    </LocaleContext.Provider>
  );
}

export function useLocale() {
  const context = useContext(LocaleContext);
  if (!context) {
    throw new Error("useLocale must be used within LocaleProvider");
  }
  return context;
}
```

- [ ] **Step 2: 在 main.tsx 中添加 LocaleProvider**

将以下 import 添加到 `ui/src/main.tsx` 顶部（在现有 imports 之后）：

```typescript
import { LocaleProvider } from "./context/LocaleContext";
import "./i18n";
```

然后将 `<LocaleProvider>` 包装在最外层（在 `<ThemeProvider>` 外侧）：

`ui/src/main.tsx` 的 render 部分变为：

```typescript
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <LocaleProvider>
        <ThemeProvider>
          <BrowserRouter>
            <CompanyProvider>
              <EditorAutocompleteProvider>
                <ToastProvider>
                  <LiveUpdatesProvider>
                    <TooltipProvider>
                      <CompanyAwareBreadcrumbProvider>
                        <SidebarProvider>
                          <PanelProvider>
                            <PluginLauncherProvider>
                              <DialogProvider>
                                <App />
                              </DialogProvider>
                            </PluginLauncherProvider>
                          </PanelProvider>
                        </SidebarProvider>
                      </CompanyAwareBreadcrumbProvider>
                    </TooltipProvider>
                  </LiveUpdatesProvider>
                </ToastProvider>
              </EditorAutocompleteProvider>
            </CompanyProvider>
          </BrowserRouter>
        </ThemeProvider>
      </LocaleProvider>
    </QueryClientProvider>
  </StrictMode>
);
```

- [ ] **Step 3: 验证 TypeScript 编译**

Run:
```bash
cd /home/longwu/paperclip && pnpm --filter @paperclipai/ui exec tsc -b --noEmit 2>&1 | head -30
```

Expected: 无新增编译错误。

- [ ] **Step 4: 提交**

```bash
git add ui/src/context/LocaleContext.tsx ui/src/main.tsx
git commit -m "feat: add LocaleContext and wire into app providers
Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 4: 创建 LanguageSwitcher 并接入设置页面

**Files:**
- Create: `ui/src/components/LanguageSwitcher.tsx`
- Modify: `ui/src/pages/InstanceGeneralSettings.tsx`

- [ ] **Step 1: 创建 LanguageSwitcher 组件**

Write `ui/src/components/LanguageSwitcher.tsx`:

```typescript
import { useTranslation } from "react-i18next";
import { useLocale } from "@/context/LocaleContext";

export function LanguageSwitcher() {
  const { locale, setLocale } = useLocale();
  const { t } = useTranslation();

  return (
    <div className="flex items-center border border-border rounded-lg overflow-hidden">
      <button
        type="button"
        className={`px-3 py-1.5 text-sm transition-colors ${
          locale === "en"
            ? "bg-accent text-foreground font-medium"
            : "text-muted-foreground hover:text-foreground"
        }`}
        onClick={() => setLocale("en")}
      >
        {t("language.english", { ns: "common" })}
      </button>
      <button
        type="button"
        className={`px-3 py-1.5 text-sm transition-colors ${
          locale === "zh-CN"
            ? "bg-accent text-foreground font-medium"
            : "text-muted-foreground hover:text-foreground"
        }`}
        onClick={() => setLocale("zh-CN")}
      >
        {t("language.chinese", { ns: "common" })}
      </button>
    </div>
  );
}
```

- [ ] **Step 2: 在 InstanceGeneralSettings 页面中添加 LanguageSwitcher 区域**

在 `ui/src/pages/InstanceGeneralSettings.tsx` 中添加 import：

```typescript
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { useTranslation } from "react-i18next";
```

在组件函数开头添加 `const { t } = useTranslation(["common", "settings"]);`

然后在 Sign out 区域**之前**插入以下 Language 区域（在 Sign out section 之前）：

```tsx
<section className="rounded-xl border border-border bg-card p-5">
  <div className="flex items-start justify-between gap-4">
    <div className="space-y-1.5">
      <h2 className="text-sm font-semibold">{t("language.label", { ns: "common" })}</h2>
      <p className="max-w-2xl text-sm text-muted-foreground">
        {t("language.description", { ns: "common" })}
      </p>
    </div>
    <LanguageSwitcher />
  </div>
</section>
```

完整变更（在函数组件内 `return` 中的 `{actionError && (...)}` 之后，第一个 `<section>` 之前插入，然后在 Sign out `<section>` 之前也插入）：

---

完整的 `InstanceGeneralSettings.tsx` 修改步骤：

Replace in `ui/src/pages/InstanceGeneralSettings.tsx` line 1:

Old: `import { useEffect, useState } from "react";`
New:
```typescript
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
```

Add after line 16 (after `import { ToggleSwitch }...`):

```typescript
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
```

Add before the `return` statement (after the `const backupRetention = ...` line), add:

```typescript
const { t } = useTranslation(["common", "settings"]);
```

Then, before the sign out `<section>` (which starts at approximately line 352), insert the language section:

```tsx
<section className="rounded-xl border border-border bg-card p-5">
  <div className="flex items-start justify-between gap-4">
    <div className="space-y-1.5">
      <h2 className="text-sm font-semibold">{t("language.label", { ns: "common" })}</h2>
      <p className="max-w-2xl text-sm text-muted-foreground">
        {t("language.description", { ns: "common" })}
      </p>
    </div>
    <LanguageSwitcher />
  </div>
</section>
```

- [ ] **Step 3: 验证**

Run:
```bash
cd /home/longwu/paperclip && pnpm --filter @paperclipai/ui exec tsc -b --noEmit 2>&1 | head -30
```

Expected: 无新增编译错误。

- [ ] **Step 4: 启动 dev server 验证**

Run:
```bash
cd /home/longwu/paperclip && pnpm --filter @paperclipai/ui dev &
```

然后打开浏览器访问应用，进入 Settings > General 页面，确认 LanguageSwitcher 可见且可点击。确认切换后页面不报错（虽然大部分文本还未迁移）。

- [ ] **Step 5: 提交**

```bash
git add ui/src/components/LanguageSwitcher.tsx ui/src/pages/InstanceGeneralSettings.tsx
git commit -m "feat: add LanguageSwitcher component to General Settings
Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 5: 迁移 common 命名空间 — Sidebar, AccountMenu, Breadcrumb, FilterBar, NotFound

**Files:**
- Modify: `ui/src/components/Sidebar.tsx`
- Modify: `ui/src/components/SidebarAccountMenu.tsx`
- Modify: `ui/src/components/BreadcrumbBar.tsx`
- Modify: `ui/src/components/FilterBar.tsx`
- Modify: `ui/src/pages/NotFound.tsx`
- Modify: `ui/src/components/EmptyState.tsx`

- [ ] **Step 1: 迁移 Sidebar.tsx**

在 `ui/src/components/Sidebar.tsx` 顶部添加：
```typescript
import { useTranslation } from "react-i18next";
```

在组件函数内添加：
```typescript
const { t } = useTranslation();
```

替换硬编码文本：
- `"New Issue"` → `t("sidebar.newIssue")`

- [ ] **Step 2: 迁移 SidebarAccountMenu.tsx**

在 `ui/src/components/SidebarAccountMenu.tsx` 顶部添加：
```typescript
import { useTranslation } from "react-i18next";
```

在组件函数内添加：
```typescript
const { t } = useTranslation();
```

替换硬编码文本：
- `aria-label="Open account menu"` → `aria-label={t("accountMenu.openMenu")}`
- `"View profile"` → `t("accountMenu.viewProfile")`
- `"Edit profile"` → `t("accountMenu.editProfile")`
- `"Sign out"` → `t("accountMenu.signOut")`
- `"Documentation"` → `t("accountMenu.documentation")`
- `"Switch to dark mode"` → `t("accountMenu.switchToDark")`
- `"Switch to light mode"` → `t("accountMenu.switchToLight")`

- [ ] **Step 3: 迁移 BreadcrumbBar.tsx**

在 `ui/src/components/BreadcrumbBar.tsx` 顶部添加：
```typescript
import { useTranslation } from "react-i18next";
```

在组件函数内添加：
```typescript
const { t } = useTranslation();
```

替换 `aria-label="Open sidebar"` → `aria-label={t("sidebar.openSidebar")}`

- [ ] **Step 4: 迁移 FilterBar.tsx**

在 `ui/src/components/FilterBar.tsx` 顶部添加：
```typescript
import { useTranslation } from "react-i18next";
```

在组件函数内添加：
```typescript
const { t } = useTranslation();
```

替换 `"Clear all"` → `t("filter.clearAll")`

- [ ] **Step 5: 迁移 NotFound.tsx**

在 `ui/src/pages/NotFound.tsx` 顶部添加：
```typescript
import { useTranslation } from "react-i18next";
```

在组件函数内添加：
```typescript
const { t } = useTranslation();
```

替换硬编码文本：
- `"Not Found"` → `t("notFound.title")`
- `"Company not found"` → `t("notFound.companyNotFound")`
- `"Page not found"` → `t("notFound.pageNotFound")`
- `"Open dashboard"` → `t("notFound.openDashboard")`
- `"Go home"` → `t("notFound.goHome")`

- [ ] **Step 6: 验证编译**

Run:
```bash
cd /home/longwu/paperclip && pnpm --filter @paperclipai/ui exec tsc -b --noEmit 2>&1 | head -30
```

Expected: 无新增编译错误。

- [ ] **Step 7: 提交**

```bash
git add ui/src/components/Sidebar.tsx ui/src/components/SidebarAccountMenu.tsx ui/src/components/BreadcrumbBar.tsx ui/src/components/FilterBar.tsx ui/src/pages/NotFound.tsx
git commit -m "feat: migrate common UI strings to i18n
Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 6: 迁移 status 命名空间 — StatusBadge, StatusIcon, NewIssueDialog

**Files:**
- Modify: `ui/src/components/StatusBadge.tsx`
- Modify: `ui/src/components/StatusIcon.tsx`
- Modify: `ui/src/components/NewIssueDialog.tsx`
- Modify: `ui/src/components/IssueSearchDialog.tsx`

- [ ] **Step 1: 迁移 StatusBadge.tsx**

在 `ui/src/components/StatusBadge.tsx` 顶部添加：
```typescript
import { useTranslation } from "react-i18next";
```

在 `StatusBadge` 函数内添加：
```typescript
const { t } = useTranslation("status");
```

将 `status.replace(/_/g, " ")` 替换为：

```typescript
const displayStatus = t(`issueStatus.${status}`, status.replace(/_/g, " "));
return (
  <span className={cn(...)}>
    {displayStatus}
  </span>
);
```

- [ ] **Step 2: 迁移 StatusIcon.tsx**

在 `ui/src/components/StatusIcon.tsx` 顶部添加：
```typescript
import { useTranslation } from "react-i18next";
```

在 `StatusIcon` 函数内添加：
```typescript
const { t } = useTranslation("status");
```

Replace `function statusLabel(status: string)`:
```typescript
function statusLabel(status: string, t: (key: string, fallback?: string) => string): string {
  return t(`issueStatus.${status}`, status.replace(/_/g, " "));
}
```

Replace `function blockedAttentionLabel(...)` — 使用 i18next `t()` 替换硬编码字符串。具体为：

```typescript
function blockedAttentionLabel(
  blockerAttention: IssueBlockerAttention | null | undefined,
  t: (key: string, options?: Record<string, unknown>) => string,
) {
  if (!blockerAttention || blockerAttention.state === "none") return t("blocked.label");

  if (blockerAttention.reason === "active_child") {
    const count = blockerAttention.coveredBlockerCount;
    if (count === 1 && blockerAttention.sampleBlockerIdentifier) {
      return t("blocked.waitingOnActiveSubIssue_one", { identifier: blockerAttention.sampleBlockerIdentifier });
    }
    return t("blocked.waitingOnActiveSubIssues", { count });
  }

  if (blockerAttention.reason === "active_dependency") {
    const count = blockerAttention.coveredBlockerCount;
    if (count === 1 && blockerAttention.sampleBlockerIdentifier) {
      return t("blocked.coveredByActiveDependency_one", { identifier: blockerAttention.sampleBlockerIdentifier });
    }
    return t("blocked.coveredByActiveDependencies", { count });
  }

  if (blockerAttention.reason === "stalled_review") {
    const count = blockerAttention.stalledBlockerCount;
    const leaf = blockerAttention.sampleStalledBlockerIdentifier ?? blockerAttention.sampleBlockerIdentifier;
    if (count === 1 && leaf) return t("blocked.reviewStalledOn", { identifier: leaf });
    if (count === 1) return t("blocked.reviewStalledNoNextStep");
    return t("blocked.reviewsStalledNoNextStep", { count });
  }

  if (blockerAttention.reason === "attention_required") {
    const count = blockerAttention.attentionBlockerCount || blockerAttention.unresolvedBlockerCount;
    const attentionCopy = count === 1
      ? t("blocked.blockerNeedsAttention", { count })
      : t("blocked.blockersNeedAttention", { count });
    const coveredCount = blockerAttention.coveredBlockerCount;
    if (coveredCount > 0) {
      return `Blocked · ${attentionCopy}; ${t("blocked.coveredByActiveWork", { covered: coveredCount })}`;
    }
    return `Blocked · ${attentionCopy}`;
  }

  return t("blocked.label");
}
```

在 `StatusIcon` 函数体内，更新两个调用：
- `statusLabel(status)` → `statusLabel(status, t)`
- `blockedAttentionLabel(blockerAttention)` → `blockedAttentionLabel(blockerAttention, t)`

- [ ] **Step 3: 迁移 NewIssueDialog.tsx 和 IssueSearchDialog.tsx**

在这两个文件中，将下拉选项的 `label` 从硬编码改为 `t()` 调用。

`ui/src/components/NewIssueDialog.tsx`:
- 在顶部添加 `import { useTranslation } from "react-i18next";`
- 在组件函数内添加 `const { t } = useTranslation("status");`
- 将所有状态选项的 `label` (如 `"Backlog"`, `"Todo"`, `"In Progress"`) 替换为 `t("issueStatus.backlog")`, `t("issueStatus.todo")` 等形式
- 将所有优先级选项的 label 替换为 `t("priority.urgent")` 等形式
- 将所有 effort 选项的 label 替换为 `t("effort.none")` 等形式
- 将所有 workMode 选项的 label 替换为 `t("workMode.autonomous")` 等形式

- [ ] **Step 4: 验证编译**

Run:
```bash
cd /home/longwu/paperclip && pnpm --filter @paperclipai/ui exec tsc -b --noEmit 2>&1 | head -30
```

Expected: 无新增编译错误。

- [ ] **Step 5: 提交**

```bash
git add ui/src/components/StatusBadge.tsx ui/src/components/StatusIcon.tsx ui/src/components/NewIssueDialog.tsx ui/src/components/IssueSearchDialog.tsx
git commit -m "feat: migrate status/priority/effort labels to i18n
Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 7: 迁移 activity 命名空间 — activity-format.ts

**Files:**
- Modify: `ui/src/lib/activity-format.ts`

- [ ] **Step 1: 重构 activity-format.ts 使用 i18n**

在 `ui/src/lib/activity-format.ts` 顶部添加：
```typescript
import i18n from "@/i18n";

function t(key: string, options?: Record<string, unknown>): string {
  return i18n.t(key, options);
}
```

删除 `ACTIVITY_ROW_VERBS` 常量（迁移到 activity.json 中）。

将 `formatActivityVerb` 函数中的 `ACTIVITY_ROW_VERBS[action]` 替换为 `t(\`verbs.\${action}\`, { ns: "activity" }) || action.replace(/[._]/g, " ")`。

删除 `ISSUE_ACTIVITY_LABELS` 常量（迁移到 activity.json 中）。

将 `formatIssueActivityAction` 函数中的 `ISSUE_ACTIVITY_LABELS[action]` 替换为 `t(\`issueLabels.\${action}\`, { ns: "activity" })`。

将 `humanizeValue` 函数和其他用户可见的字符串也对应翻译（使用 `t()` 调用）：

- `formatUserLabel`: `"Board"` → `t("board", { ns: "activity" })`, `"You"` → `t("you", { ns: "activity" })`, `` \`user \${userId.slice(0, 5)}\` `` → `t("user", { ns: "activity", id: userId.slice(0, 5) })`
- `formatIssueReferenceLabel`: `"issue"` → `t("issue", { ns: "activity" })`
- `formatIssueUpdatedVerb` 和 `formatIssueUpdatedAction` 中的状态变更字符串也使用 activity.json 中的 key
- `formatStructuredIssueChange` 中的 blocker/reviewer/approver 相关字符串使用 activity.json 中的 key

注：此文件的完整重构代码过长。完整实现时需根据 `en/activity.json` 中定义的 key 逐一替换所有用户可见的硬编码字符串。关键是使用 `i18n.t(key, options)` 替代所有直接拼接的英文文本。

- [ ] **Step 2: 验证编译**

Run:
```bash
cd /home/longwu/paperclip && pnpm --filter @paperclipai/ui exec tsc -b --noEmit 2>&1 | head -30
```

Expected: 无新增编译错误。

- [ ] **Step 3: 提交**

```bash
git add ui/src/lib/activity-format.ts
git commit -m "feat: migrate activity format verbs and labels to i18n
Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 8: 迁移 time 命名空间 — timeAgo.ts

**Files:**
- Modify: `ui/src/lib/timeAgo.ts`

- [ ] **Step 1: 迁移 timeAgo.ts**

Rewrite `ui/src/lib/timeAgo.ts`:

```typescript
import i18n from "@/i18n";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;

export function timeAgo(date: Date | string): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const seconds = Math.round((now - then) / 1000);

  if (seconds < MINUTE) return i18n.t("justNow", { ns: "time" });
  if (seconds < HOUR) {
    const n = Math.floor(seconds / MINUTE);
    return i18n.t("mAgo", { ns: "time", n });
  }
  if (seconds < DAY) {
    const n = Math.floor(seconds / HOUR);
    return i18n.t("hAgo", { ns: "time", n });
  }
  if (seconds < WEEK) {
    const n = Math.floor(seconds / DAY);
    return i18n.t("dAgo", { ns: "time", n });
  }
  if (seconds < MONTH) {
    const n = Math.floor(seconds / WEEK);
    return i18n.t("wAgo", { ns: "time", n });
  }
  const n = Math.floor(seconds / MONTH);
  return i18n.t("moAgo", { ns: "time", n });
}
```

- [ ] **Step 2: 验证编译**

Run:
```bash
cd /home/longwu/paperclip && pnpm --filter @paperclipai/ui exec tsc -b --noEmit 2>&1 | head -30
```

Expected: 无新增编译错误。

- [ ] **Step 3: 提交**

```bash
git add ui/src/lib/timeAgo.ts
git commit -m "feat: migrate timeAgo strings to i18n
Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 9: 迁移 auth 命名空间 — Auth 页面

**Files:**
- Modify: `ui/src/pages/Auth.tsx`

在 `ui/src/pages/Auth.tsx` 顶部添加：
```typescript
import { useTranslation } from "react-i18next";
```

在组件函数内添加：
```typescript
const { t } = useTranslation("auth");
```

替换硬编码文本：
- `"Authentication failed"` → `t("authFailed")`
- `"Loading..."` → `t("loading")`
- 登录/注册相关按钮和描述文本使用 auth.json 中的对应 key

验证编译后提交：
```bash
git add ui/src/pages/Auth.tsx
git commit -m "feat: migrate auth page strings to i18n
Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 10: 迁移 settings 命名空间 — 设置页面

**Files:**
- Modify: `ui/src/pages/InstanceGeneralSettings.tsx`
- Modify: `ui/src/pages/InstanceExperimentalSettings.tsx`

- [ ] **Step 1: 迁移 InstanceGeneralSettings.tsx 剩余文本**

将 `ui/src/pages/InstanceGeneralSettings.tsx` 中所有剩余硬编码文本替换为 `t()` 调用。

替换列表：
- `"Instance Settings"` → `t("instanceSettings", { ns: "settings" })`
- `"General"` → `t("general", { ns: "settings" })`
- `"Loading general settings..."` → `t("loading", { ns: "settings" })`
- `"Failed to load general settings."` → `t("error.loadSettings", { ns: "common" })`
- `"Failed to update general settings."` → `t("error.updateSettings", { ns: "common" })`
- 页面描述文本使用 `t("description", { ns: "settings" })`
- `"Deployment and auth"` → `t("deploymentAndAuth", { ns: "settings" })`
- 部署模式描述使用 settings.json 对应 key
- `"Auth readiness"` / `"Bootstrap status"` / `"Bootstrap invite"` → 对应 key
- `"Ready"` / `"Not ready"` / `"Setup required"` / `"Active"` / `"None"` → 对应 key
- `"Censor username in logs"` + 描述 → 对应 key
- `"Keyboard shortcuts"` + 描述 → 对应 key
- `"Backup retention"` + 描述 → 对应 key
- 每日/每周/每月标签 → 对应 key
- `"AI feedback sharing"` + 描述 → 对应 key
- 反馈选项 → 对应 key
- `"Sign out"` 区域 → 对应 key

- [ ] **Step 2: 迁移 InstanceExperimentalSettings.tsx**

添加 `import { useTranslation } from "react-i18next";` 和 `const { t } = useTranslation(["common", "settings"]);`

替换硬编码文本：`"Experimental"` → `t("experimental", { ns: "settings" })`；`"Confirm auto-recovery"` → `t("confirmAutoRecovery", { ns: "settings" })` 等。

- [ ] **Step 3: 验证并提交**

Run: `cd /home/longwu/paperclip && pnpm --filter @paperclipai/ui exec tsc -b --noEmit 2>&1 | head -30`

```bash
git add ui/src/pages/InstanceGeneralSettings.tsx ui/src/pages/InstanceExperimentalSettings.tsx
git commit -m "feat: migrate settings page strings to i18n
Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 11: 迁移 issues 和 keyboard 命名空间

**Files:**
- Modify: `ui/src/components/KeyboardShortcutsCheatsheet.tsx`
- Modify: `ui/src/components/` (所有 Issue 相关组件)
- Modify: `ui/src/pages/` (所有 Issue 相关页面)

- [ ] **Step 1: 迁移 KeyboardShortcutsCheatsheet.tsx**

添加 `import { useTranslation } from "react-i18next";` 和 `const { t } = useTranslation("keyboard");`

将所有章节标题和快捷键描述替换为 `t()` 调用，使用 `keyboard.json` 中的 key。

- [ ] **Step 2: 迁移 Issue 相关组件**

对于所有包含 Issue 相关文本的组件（如 IssueDialog, IssueDetail, IssueList 等），添加 `useTranslation` hook 并使用 issues 命名空间的翻译。

每个文件的变更模式：
1. 添加 `import { useTranslation } from "react-i18next";`
2. 添加 `const { t } = useTranslation(["issues", "status"]);`
3. 将硬编码文本替换为 `t("key")` 调用

- [ ] **Step 3: 验证并提交**

```bash
git add ui/src/components/KeyboardShortcutsCheatsheet.tsx [其他文件...]
git commit -m "feat: migrate issues and keyboard strings to i18n
Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 12: 全面扫描遗漏文本并修复

**Files:**
- 所有 `ui/src/` 下的 `.tsx` 文件

- [ ] **Step 1: 扫描剩余硬编码英文文本**

Run:
```bash
cd /home/longwu/paperclip && grep -rn '"New ' ui/src/ --include="*.tsx" | grep -v node_modules | grep -v i18n/resources
grep -rn '"Open ' ui/src/ --include="*.tsx" | grep -v node_modules | grep -v i18n/resources
grep -rn '"Create ' ui/src/ --include="*.tsx" | grep -v node_modules | grep -v i18n/resources
grep -rn '"Save' ui/src/ --include="*.tsx" | grep -v node_modules | grep -v i18n/resources
grep -rn '"Cancel' ui/src/ --include="*.tsx" | grep -v node_modules | grep -v i18n/resources
grep -rn '"Loading' ui/src/ --include="*.tsx" | grep -v node_modules | grep -v i18n/resources
grep -rn '"Failed' ui/src/ --include="*.tsx" | grep -v node_modules | grep -v i18n/resources
```

手动检查每个匹配项，判断是否需要迁移。注意：代码中的技术标识符（如 `"issue.created"` 等 action names）不应翻译。

- [ ] **Step 2: 修复所有遗漏的文本**

为每个遗漏的文本添加翻译 key 或使用已有 key。

- [ ] **Step 3: 验证 key 对称性**

Run:
```bash
cd /home/longwu/paperclip
# Check that en and zh-CN JSON files have matching keys
node -e "
const fs = require('fs');
const path = require('path');
const dir = 'ui/src/i18n/resources';
const namespaces = fs.readdirSync(path.join(dir, 'en')).filter(f => f.endsWith('.json'));
let ok = true;
for (const ns of namespaces) {
  const en = JSON.parse(fs.readFileSync(path.join(dir, 'en', ns), 'utf-8'));
  const zh = JSON.parse(fs.readFileSync(path.join(dir, 'zh-CN', ns), 'utf-8'));
  const enKeys = JSON.stringify(en).match(/\"[^\"]+\":/g).length;
  const zhKeys = JSON.stringify(zh).match(/\"[^\"]+\":/g).length;
  if (enKeys !== zhKeys) {
    console.log('MISMATCH in', ns, 'en:', enKeys, 'zh:', zhKeys);
    ok = false;
  }
}
if (ok) console.log('All namespaces have matching key counts');
"
```

- [ ] **Step 4: 验证编译**

```bash
cd /home/longwu/paperclip && pnpm --filter @paperclipai/ui exec tsc -b --noEmit 2>&1 | head -30
```

- [ ] **Step 5: 提交**

```bash
git add ui/src/
git commit -m "feat: scan and fix remaining hardcoded English strings
Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Completion Checklist

在所有任务完成后验证：

1. TypeScript 编译零错误
2. 在浏览器中切换语言后 UI 文本正确变化
3. 中英文 JSON 文件 key 完全对称
4. 首次访问时浏览器语言检测正确（中文浏览器 → 中文，英文浏览器 → 英文）
5. 手动切换后刷新页面保持所选语言
