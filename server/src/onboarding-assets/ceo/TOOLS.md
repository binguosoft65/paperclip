# Tools

工具会随业务推进逐步接入。下面是当前已规划的工具栏目骨架,具体凭据 / 接入状态 / 负责人由 CTO 在对应子任务中填充。

> 新增工具时:在对应分区下补充 — 工具名、用途、登录入口、谁负责维护凭据、安全级别(public / internal / secret)。Secrets 一律不写入此文件,只记录"凭据存放位置"。

## Coordination & Memory

- **Paperclip API** — issue / task tracking, agent coordination (see `HEARTBEAT.md`)
- **para-memory-files skill** — three-layer memory: knowledge graph, daily notes, tacit knowledge
- **paperclip-create-agent skill** — hire new direct reports when capacity is needed

## Code & Build

- (TBD) GitHub / Git hosting — code & version control
- (TBD) CI/CD — build & deploy pipeline
- (TBD) SaaS hosting — Vercel / Cloudflare Workers / 阿里云 / 腾讯云
- (TBD) Domain & DNS registrar
- (TBD) Error monitoring & logs

## Content & Distribution

- (TBD) 小红书 / 知乎 / 公众号 / B站 / 抖音 / 视频号 账号矩阵管理
- (TBD) 内容排程 & 数据分析(蝉妈妈 / 新榜 / 灰豚 等)
- (TBD) 短视频生成与剪辑工具链
- (TBD) 图文素材库(配图、字体、音乐授权)

## Outsourcing & Sales

- (TBD) 接单平台账号:Upwork / Fiverr / 猪八戒 / 闲鱼
- (TBD) 报价 & 合同模板库
- (TBD) 客户关系管理(轻量 CRM 或 Notion 替代)
- (TBD) 收款通道:微信 / 支付宝 / Stripe / PayPal

## Digital Product Storefronts

- (TBD) 提示词 / 模板 / 报告 的销售落地(Gumroad / 小报童 / 知识星球 / 自有页面)
- (TBD) 付费墙与订阅管理

## Data & Analytics

- (TBD) 现金流 & 用户付费看板(`metric:cashflow`、`metric:users`)
- (TBD) 内容平台数据汇总(`metric:content`)
- (TBD) 外包漏斗追踪(`metric:outsourcing`)
- (TBD) Agent leverage 仪表盘(`metric:agent_hours`)

## Security & Compliance

- (TBD) 凭据管理器(1Password / Bitwarden / 云厂商 KMS)
- (TBD) 备份策略
- (TBD) 合同 / 发票 / 税务记录归档
