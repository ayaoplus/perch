# Perch

> 多 Topic 个人信息漏斗 · 互联网数据处理框架(v2)

每个 Topic 是一等对象,封装 **sources + 时段配置 + 报告模板** 的完整配置包。所有领域操作都是 `topic.<method>()`,按"信息生命周期"切六个角色:Ingest / Analyze / Digest / Enrich / Archive / Admin。换领域 = 换一份 Topic 配置,框架代码不动。

完整设计见 [`docs/DESIGN.md`](docs/DESIGN.md)。创建 topic 的详细指南见 [`docs/TOPIC_AUTHORING.md`](docs/TOPIC_AUTHORING.md)。

---

## 核心能力

| 角色 | 命令 | 说明 |
|---|---|---|
| **Ingest** | `perch ingest` | 真实登录态 Chrome + CDP 读 X redux store → 跨源去重 → 全局时间倒序写当日 raw |
| **Analyze** | `perch analyze` | 渲染 slot prompt → Claude 会话接棒生成当日 wiki 的 slot section |
| **Digest** | `perch digest` | 渲染 digest prompt → Claude 接棒蒸馏 5-7 句日概览 → prepend 到 summaries.md |
| **Enrich** | `perch enrich` | CDP 深抓 Twitter Article → 按月缓存(可由 analyze 阶段 Claude 按需触发) |
| **Archive** | `perch archive` | 月末把上月 raw / wiki / cache 搬到 `archive/YYYY-MM/`,幂等,支持 `--dry-run` |
| **Admin** | `perch admin list / create` | Topic 配置 CRUD;`create --from-json` 非交互,`create` 走交互向导 |

---

## 架构速览

两个正交维度,详见 DESIGN §2:

### 角色维度(信息生命周期)

```
Ingest  →  Analyze  →  (Digest / Archive)
              ↑
            Enrich
              ↑
            Admin
```

新需求是给 Topic 加 method,不是新增"命令"。

### 实现层维度

```
Adapter (lib/x-fetcher · x-adapter · CDP 栈)
   ↓  和外部世界打交道:读 X redux store / LLM API
Domain  (lib/topic.mjs Topic class + 6 个角色模块)
   ↓  领域逻辑:接收 Topic 实例完成生命周期一步
Tool    (lib/normalize · wiki · article-cache)
        可组合原子:format / dedup / 路径 / idempotent upsert
```

`scripts/perch.mjs` 在 Domain 之上,30 行的 subcommand router,**不含业务语义**。

---

## 目录结构

```
perch/
├── config.example.json         # 提交到 git 的占位模板
├── config.json                 # 本地运行时配置(已 gitignore)
├── lib/
│   ├── topic.mjs               # Topic class(static load/list/create + 实例方法)
│   ├── ingest.mjs / analyze.mjs / digest.mjs / enrich.mjs / archive.mjs / admin.mjs
│   ├── normalize.mjs / wiki.mjs / article-cache.mjs       # Tool 层
│   └── x-fetcher.mjs / x-adapter.mjs / *cdp-proxy*        # Adapter 层
├── scripts/
│   ├── perch.mjs               # 主 CLI(单入口,subcommand 路由)
│   ├── wiki-write.mjs          # Agent tool: slot section pipe upsert
│   ├── summary-write.mjs       # Agent tool: summary 条目 pipe upsert(v2 新增)
│   ├── fetch-article.mjs       # Agent tool: prompt 内按需深抓
│   └── spike-list.mjs / spike-profile.mjs   # 调试 gate
├── templates/topics/<slug>/    # 每个 topic 的 SCHEMA.md + 时段 prompt + (可选)digest.md
└── docs/DESIGN.md              # 完整设计规范
```

Topic **数据**(raw / wiki / summaries / archive)住在 `config.json` 指定的 `path` 下(例如 iCloud 同步盘),不入 git;Topic **逻辑配置**(SCHEMA + prompt)住在 `templates/topics/<slug>/`,入 git。

---

## 运行前提

- Node.js ≥ 22(原生 fetch + WebSocket)
- 用户日常 Chrome 已开 `--remote-debugging-port=9222`(或 9229 / 9333),并登录 X
- 首次 clone 后:`cp config.example.json config.json`,改里面的数据目录 `path`
- 对应的 `templates/topics/<slug>/SCHEMA.md` 存在且 frontmatter 合法(示例 topic `ai-radar` 的 X list ID 是占位符,记得替换)

没起 CDP Proxy 子进程时,`lib/browser-provider.mjs` 会自动 fork 一个,日志在 `/tmp/perch-proxy.log`。

---

## 常用命令

```bash
# Ingest:抓 X
node scripts/perch.mjs ingest --topic ai-radar
node scripts/perch.mjs ingest --topic ai-radar --dry
node scripts/perch.mjs ingest --topic ai-radar --limit 20

# Analyze:出某个 slot 的报告(skill 模式:打印 prompt,Claude 接棒生成 + pipe wiki-write)
node scripts/perch.mjs analyze --topic ai-radar              # slot 默认 'now',时区 / wrap / window 自动算
node scripts/perch.mjs analyze --topic ai-radar --slot evening
node scripts/perch.mjs analyze --topic ai-radar --slot evening --date 2026-04-23  # 显式归属日

# Digest:出当日概览(独立 method,v2 新增)
node scripts/perch.mjs digest --topic ai-radar
node scripts/perch.mjs digest --topic ai-radar --date 2026-04-23

# Enrich:深抓 Twitter Article(CLI 形式;analyze prompt 里也会让 Claude 按需 Bash 调 fetch-article.mjs)
node scripts/perch.mjs enrich --topic ai-radar --url https://x.com/author/status/NNN

# Archive:月末归档
node scripts/perch.mjs archive --topic ai-radar --dry-run
node scripts/perch.mjs archive --topic ai-radar

# Admin
node scripts/perch.mjs admin list
node scripts/perch.mjs admin create                          # 交互向导
node scripts/perch.mjs admin create --from-json spec.json    # 非交互,agent 友好
```

**`analyze --slot now` 的关键行为**(agent 必读):凌晨(hour < `slots[0].start_hour`)触发时,slot 自动映射到**昨天的最后一个 slot**,`{DATE}` / `{RAW_PATH}` / `{WIKI_PATH}` 同步指向昨天;`{WINDOW_END_LABEL}` 用归属日 `23:59`(看昨天整天)。详见 [`docs/TOPIC_AUTHORING.md`](docs/TOPIC_AUTHORING.md)。

---

## v1 → v2 命令对照

| v1 | v2 |
|---|---|
| `node scripts/collect.mjs` | `node scripts/perch.mjs ingest` |
| `node scripts/report.mjs <slot>` | `node scripts/perch.mjs analyze --slot <slot>` |
| `node scripts/rotate.mjs` | `node scripts/perch.mjs archive` |
| `node scripts/fetch-article.mjs <url>` | `node scripts/perch.mjs enrich --url <url>` (脚本仍存在作为 prompt 内 agent tool) |
| `node scripts/new-topic.mjs` | `node scripts/perch.mjs admin create` |
| (evening prompt 附带产出) | `node scripts/perch.mjs digest`(**独立 method**) |

---

## 状态

v2 主链路全部实现:Topic class + 6 个角色 method + 统一 CLI:

- Adapter 层读 X redux store(长推全文、repost 链、metrics 自带)+ dedup 聚合
- Slot 数量 / 边界 / 覆盖窗口全部 topic 级可配(`SCHEMA.slots`);analyze `now` 自带日期回退 + wrap;显式 slot 用 canonical end
- Raw 每次写盘**全局时间重排**(非前插),吸收 pinned / source 晚到的旧推
- **Wiki 当日 1 份文件**,slot 粒度走 `## slot: <name>` section 幂等 upsert
- **Digest 独立 method**(v2 新增):当日概览不再绑在 evening prompt 里,改由 `perch digest` 显式触发,prompt 复用通用模板(可选 `templates/topics/<slug>/digest.md` 覆盖)
- Twitter Article 按需深抓 + 按月缓存 + 随 archive 归档
- Topic 脚手架(交互 / `--from-json`,都有 spec 校验;`slots` 可省略自动 fallback `DEFAULT_SLOTS`)

未来会加的能力(详见 DESIGN §9):

- LLM Direct 模式(脚本直连 Anthropic API,接口已留)
- Schedule 自动驱动(SCHEMA `schedule` 字段位置已留)
- Topic Wiki 的 stale / rebuild
- 跨 topic 查询
- per-topic timezone、summaries 月度切分归档
