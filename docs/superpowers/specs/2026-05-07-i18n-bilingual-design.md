# UI 中/英文双语切换 — 设计规格

## 目标

为 Paperclip UI 实现完整的国际化（i18n）支持，将所有硬编码英文 UI 文本迁移为中/英文双语，用户可手动切换语言，浏览器语言自动检测。

## 技术选型

| 项 | 选择 |
|---|------|
| i18n 库 | `react-i18next` + `i18next` |
| 翻译文件格式 | JSON，按命名空间分文件 |
| 语言检测 | `navigator.language` 自动检测 + localStorage 持久化 |
| 语言切换器位置 | General Settings 页面 |
| 日期/数字格式化 | 浏览器内置 `Intl` API |

## 架构

```
ui/src/i18n/
  index.ts                 # i18next 初始化，导出 t, useTranslation
  resources/
    en/
      common.json          # 通用：侧边栏、导航、按钮、错误提示
      issues.json          # Issue 相关：创建、编辑、查看
      settings.json        # 设置页面
      activity.json        # 活动日志动词
      status.json          # 状态/优先级/紧急程度等枚举标签
      auth.json            # 登录注册、会话
      time.json            # 时间相关文本（just now, m ago 等）
      keyboard.json        # 快捷键帮助 / cheatsheet
    zh-CN/
      common.json          # 对应中文翻译
      ... (与 en 完全对称的文件结构)

ui/src/context/
  LocaleContext.tsx         # LocaleContext Provider

ui/src/components/
  LanguageSwitcher.tsx      # 语言切换下拉组件
```

### 关键文件职责

| 文件 | 职责 |
|------|------|
| `i18n/index.ts` | i18next 单例初始化，配置语言检测器、命名空间、切换回调 |
| `i18n/resources/**/*.json` | 翻译数据，en 和 zh-CN 完全对称 |
| `context/LocaleContext.tsx` | React Context，暴露 `locale` 和 `setLocale`，同步 `<html lang>` 和 localStorage |
| `context/LanguageSwitcher.tsx` | 纯 UI 组件，渲染语言切换下拉框 |

### LocaleContext 设计

参考现有 `ThemeContext` 模式：

- 状态：`locale: "en" | "zh-CN"`
- 自动检测：读取 `navigator.language`，匹配 `zh/zh-CN/zh-TW/zh-HK` → `"zh-CN"`，其他 → `"en"`
- 持久化：`localStorage.setItem("paperclip.locale", locale)`
- 副作用：`document.documentElement.lang = locale`，`i18next.changeLanguage(locale)`
- 默认值优先级：localStorage > navigator.language > "en"

## 翻译文件约定

### Key 命名

`namespace.section.key` 风格，扁平层级：

```json
{
  "sidebar": {
    "newIssue": "New Issue",
    "openSidebar": "Open sidebar"
  },
  "accountMenu": {
    "viewProfile": "View profile",
    "editProfile": "Edit profile",
    "signOut": "Sign out"
  },
  "error": {
    "generic": "Something went wrong",
    "authFailed": "Authentication failed"
  }
}
```

### 使用模式

```tsx
// 组件内
import { useTranslation } from 'react-i18next';
const { t } = useTranslation();
<button>{t('sidebar.newIssue')}</button>

// 纯函数 / 工具模块
import { t } from '@/i18n';
const label = t(`status.issueStatus.${status}`);
```

### 特殊文本处理

| 现有模式 | 迁移方式 |
|----------|----------|
| `status.replace(/_/g, " ")` 状态标签 | 查表 `t(\`status.issueStatus.\${status}\`)` |
| `ACTIVITY_ROW_VERBS` 动词注册表 | 迁移到 `activity.json`，通过 `t()` 访问 |
| `timeAgo.ts` 时间文本 | 迁移到 `time.json`，使用插值 `t('time.mAgo', { n })` |
| 下拉选项 `{ value, label }` | `label` 改为 `t('status.xxx.yyy')` |
| 复杂拼接（单复数） | i18next 插值 + context 区分 |

### 命名空间加载策略

全量加载（预估总共 20-30KB），不使用懒加载。所有命名空间在 i18next 初始化时注册完毕。

## 数据流

```
navigator.language (首次)
     │
     ▼
localStorage "paperclip.locale" (覆盖)
     │
     ▼
LocaleContext ──► document.documentElement.lang
     │
     ▼
i18next.changeLanguage(locale)
     │
     ▼
react-i18next re-render ──► 所有 useTranslation() hooks 更新
```

## 实施阶段

### Phase 1：基础设施
- 安装 `i18next` + `react-i18next` + `i18next-browser-languagedetector`
- 创建 `ui/src/i18n/` 目录及初始化模块
- 创建 `LocaleContext.tsx`
- 创建 `LanguageSwitcher.tsx` 并接入 General Settings 页面
- 验证语言切换流程可运行

### Phase 2：迁移文本（按命名空间顺序）
1. `common` — 侧边栏、导航、按钮、错误提示
2. `status` — 状态/优先级/紧急程度枚举标签
3. `activity` — 活动日志动词
4. `time` — 时间相关文本
5. `auth` — 登录注册、会话
6. `settings` — 设置页面
7. `issues` — Issue 创建、编辑、查看
8. `keyboard` — 快捷键帮助

每个命名空间迁移后验证页面正常显示。

### Phase 3：收尾
- 全量扫描检查未迁移的硬编码文本
- 验证中英文 JSON key 完全对称
- 验证插值参数文本正常

## 测试策略

- **单元测试**：LocaleContext 自动检测逻辑、语言检测（zh-CN / zh / en / en-US 等 BCP47 标签）
- **完整性测试**：扫描中英文 JSON 文件，确保所有 key 对称存在
- **UI 验证**：切换语言后页面文本正确变化

## 非范围

- Server 端不涉及（无用户可见文本）
- `docs/` 和 `docs/` 内容不翻译
- `DesignGuide.tsx` 包含在内（全部 UI 文本）
- 不涉及 RTL 排版（中文和英文均为 LTR）
- 不翻译数据库内容或用户生成内容
