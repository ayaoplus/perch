# Perch — 设计规范(v2)

> 多 Topic 个人信息漏斗 · 互联网数据处理框架

---

## 1. 项目定位

**一句话**:多 Topic 的个人信息漏斗。每个 Topic = 一组数据源 + 一套信息加工流水线(采集 → 归纳 → 概览 → 归档),本地 Markdown 落地,可扩展。

**核心价值**:

1. **X 能抓**(登录态真实 Chrome + CDP 瘦核,不靠官方 API)
2. **结构化的 LLM 工作流**(时段分析 / 日概览 / 主题蒸馏)

**明确不做**:

- 不做 RSS(已有 miniflux/NetNewsWire)
- 不做长期归档知识库(perch 是"信息漏斗",不是 wiki 本身)
- 不做通用平台抓取(只做 X,专注登录态 + 时段报告这对组合)

---

## 2. 架构总览

### 2.1 设计哲学:Topic 一等公民 + 信息生命周期

v2 的核心抽象是把 **Topic 升为一等对象**,所有领域操作都是 Topic 的方法。CLI 退化成"读 args → 取 Topic → 调 method"的薄 dispatcher,**不含业务语义**。

按"信息生命周期"切角色,而不是按动词切。任何信息漏斗系统的稳定骨架都是:

```
Ingest  →  Analyze  →  (Digest / Archive)
                ↑
            Enrich
                ↑
              Admin
```

| 角色 | 输入 | 产出 | LLM 介入 | Topic method |
|---|---|---|---|---|
| **Ingest** | sources | 当日 raw | 否 | `topic.ingest()` |
| **Analyze** | raw + slot 窗口 | 当日 wiki 的 slot section | **是** | `topic.analyze(slot, opts?)` |
| **Digest** | 当日 wiki | summaries.md 的 `## DATE` 条目 | **是** | `topic.digest(opts?)` |
| **Enrich** | tweet status URL | article 缓存 | 否 | `topic.enrich(url, opts?)` |
| **Archive** | 月度 | archive/YYYY-MM/ | 否 | `topic.archive(opts?)` |
| **Admin** | spec | config + templates | 否 | `Topic.create(rootDir, spec)` / `Topic.list(rootDir)` |

新增能力(比如周报、跨 topic 查询)只是给 Topic 加一个 method,不必新增"命令" — 角色清单是收敛的。

### 2.2 运行时分层:Adapter / Domain / Tool

正交于角色切分的**实现层**(各角色复用):

| 层 | 位置 | 做什么 | **不**做什么 |
|---|---|---|---|
| **Adapter** | `lib/x-fetcher.mjs` · `lib/x-adapter.mjs` · `lib/llm.mjs`(后续) | 和外部世界打交道:从 X redux store 读 timeline · 调 LLM API · CDP 控制浏览器 | 不掺业务语义 |
| **Domain** | `lib/topic.mjs`(Topic class)· `lib/ingest.mjs` · `lib/analyze.mjs` · `lib/digest.mjs` · `lib/enrich.mjs` · `lib/archive.mjs` · `lib/admin.mjs` | 角色实现:每个角色一份模块,接收 Topic 实例,完成生命周期一步 | 不直接碰 CDP / 不知道 CLI 形态 |
| **Tool** | `lib/normalize.mjs` · `lib/wiki.mjs` · `lib/article-cache.mjs` | 可组合原子:格式化、路径辅助、idempotent 读写 | 不做编排 |

CLI(`scripts/perch.mjs`)在 Domain 之上 30 行,只做 subcommand 路由。Agent tools(`scripts/wiki-write.mjs` · `scripts/summary-write.mjs` · `scripts/fetch-article.mjs`)是 LLM 在 analyze/digest 阶段 Bash 调用的"持久化副作用"工具,等同于 Topic method 的对外接口子集。

### 2.3 LLM 调用模式(Skill / Direct)

LLM 介入只发生在两个角色:**Analyze** 和 **Digest**。两种调用模式:

- **Skill 模式(v1 + v2 默认)**:`topic.analyze(slot)` 渲染完 prompt 后输出到 stdout,**当前 Claude 会话**接棒读 prompt → 读 raw → 生成 markdown → 用 `wiki-write.mjs` heredoc pipe 落盘。Digest 同理 + `summary-write.mjs`。
- **Direct 模式(v2.x 留位)**:`lib/llm.mjs` 提供 `complete(prompt) → completion` 抽象,后续可接 Anthropic API 让 cron / openclaw / 任何 runner 直接驱动。当前未实现,接口已预留。

二者共享同一份 prompt 模板和同一份 Topic method 实现。模式只决定"谁来跑 LLM 那一步",其他不变。

### 2.4 真实业务管线(以 ingest 为例)

```
fetchXList/Profile (generous limit)
  → 读 X redux store(长推全文 + repost + metrics 自带)
  → normalize.dedupTweets         (跨 source 合并 + 聚合 __via / repostedBy)
  → readExistingIds 跨次去重
  → formatTweet 渲染每条 → block 字符串
  → splitRawBlocks + mergeBlocksByTimeDesc(全局时间倒序重排)
  → 整体重写 raw 文件
```

**关键不变量**:raw 文件全局时间倒序。每次 ingest **整体重排**而非前插 — 当某 source 这一轮才抓到旧 tweet(pinned 挤占、source 晚一轮、DOM 抖动),全局重排能放到正确位置。

**为什么读 redux store 而不是 DOM**:X SPA 进入 list/profile 页时通过内部 GraphQL 一次性拿 80+ 条塞进 redux,虚拟列表只 mount 7-10 条到 DOM。读 DOM 等于跟 IntersectionObserver / tab throttle / React unmount 斗,既不完整也不稳定。读 redux 直接拿 X 自己解出的 API response,含长推全文、repost 链、精确 metrics、views,全 idempotent。

---

## 3. Topic 一等公民

### 3.1 Topic class

`lib/topic.mjs` 暴露一个 Topic class:

```js
export class Topic {
  // —— 静态:加载 / 列举 / 创建 ——
  static async load(slug, rootDir)         // 替代 v1 loadTopic;返回 Topic 实例
  static async list(rootDir)               // 列出 config.json 里所有 topic
  static async create(rootDir, spec)       // 替代 v1 scaffoldTopic
  
  // —— 实例字段(运行时配置) ——
  slug · description · timezone · dataPath · templatesDir · sources · slots
  
  // —— 实例方法(领域操作) ——
  async ingest(opts)                       // opts: { dry, limit }
  async analyze(slotArg, opts)             // slotArg: name | 'now'; opts: { date, llm }
  async digest(opts)                       // opts: { date, llm }
  async enrich(statusUrl, opts)            // opts: { date }
  async archive(opts)                      // opts: { dryRun }
}
```

调用者(CLI / agent / cron / runner)只和 Topic 对象打交道,不知道目录结构、不懂窗口语义、不解析 schedule。**这些是 Topic 内部的细节**。

### 3.2 SCHEMA.md(随 perch 仓库版本化)

```jsonc
{
  "topic": "ai-radar",
  "description": "AI 博主每日选题漏斗",
  "sources": [
    { "slug": "ai-kol", "type": "list", "target": "https://x.com/i/lists/...", "fetch_limit": 80 }
  ],
  "slots": [
    { "name": "morning", "start_hour": 5,  "window": "since_prev" },
    { "name": "noon",    "start_hour": 12, "window": "since_prev" },
    { "name": "evening", "start_hour": 18, "window": "today" }
  ]
  // schedule 字段在 v2.x 引入,声明 ingest / analyze / digest / archive 的触发节奏,
  // 让 orchestrator 退化成"读 schedule 调 method"的通用 runner。v2 第一版不引入。
}
```

`slots` 缺省时 fallback 到 DEFAULT_SLOTS(`morning@5 / noon@12 / evening@18 / window=today`)。

### 3.3 Slot + 归属日(沿用 v1 语义)

`topic.analyze(slotArg, opts)` 内部把 slotArg 解析成 `{ slot, date }`:

| slotArg | 触发时刻条件(hour 在 topic.timezone) | 映射 slot | 归属 date |
|---|---|---|---|
| `now` | hour ≥ slots[0].start_hour | pickSlot(hour) | 今天 |
| `now` | hour < slots[0].start_hour | 最后一个 slot(凌晨 wrap) | 昨天 |
| `<显式>` | hour ≥ slotDef.start_hour | 显式 slot | 今天 |
| `<显式>` | hour < slotDef.start_hour | 显式 slot | 昨天 |

window 计算同 v1:

| 归属日 | endLabel |
|---|---|
| 昨天 | canonical end(下一 slot 的 start_hour:00,末 slot 用归属日 23:59) |
| 今天 | min(now, canonical end) |

两个杜绝的 bug(反向窗口 / 未来窗口)沿用 v1 解。

### 3.4 Daily Wiki / Topic Wiki / Summaries

| 类型 | 路径 | 由谁写 | 特征 |
|---|---|---|---|
| **Daily Wiki** | `wiki/daily/YYYY-MM-DD.md` | `topic.analyze` | 当日单份,按 `## slot: <name>` 分段;同 slot 重跑幂等替换 |
| **Topic Wiki** | `wiki/topic/<slug>.md` | (v2 不实现) | 跨日累积,带 frontmatter 可 stale → rebuild |
| **Summaries** | `summaries.md` | `topic.digest` | `## YYYY-MM-DD` 条目,时间倒序 prepend,日级幂等 upsert |

**重要变化(v1 → v2)**:在 v1 里 summaries 条目是 evening prompt 的"附加任务"附带产出。v2 把它**独立成 digest method + 独立 prompt 模板**。Analyze 只生成 wiki section,不再附带 summaries。用户日终 → 跑 `perch analyze evening` 后再跑 `perch digest`(或将来由 schedule 自动 chain)。

### 3.5 月度切分

- 活跃库 = 只当月
- 每月 1 号 `topic.archive()` 上月 `raw/daily` + `wiki/daily` + `cache/articles/上月/` 到 `archive/YYYY-MM/`
- Topic Wiki 不归档(长期资产,跨月保留)
- summaries.md 当前不归档(留 v2.x)
- 跨月查询:归档视为只读库

---

## 4. 目录结构

### 4.1 perch 仓库

```
perch/
├── README.md · SKILL.md · CLAUDE.md · AGENTS.md
├── config.example.json
├── config.json                 # gitignore;default_topic / timezone / topics 注册表
├── lib/
│   ├── topic.mjs               # Topic class(static load/list/create + 实例方法分发)
│   ├── ingest.mjs              # Ingest 实现
│   ├── analyze.mjs             # Analyze 实现(prompt 渲染 + slot/window 解析)
│   ├── digest.mjs              # Digest 实现
│   ├── enrich.mjs              # Enrich 实现(article 深抓的 thin wrapper)
│   ├── archive.mjs             # Archive 实现(月度归档,合并自 v1 lib/rotate.mjs)
│   ├── admin.mjs               # Admin 实现(scaffoldTopic + 校验)
│   ├── llm.mjs                 # LLM 调用抽象(v2 第一版只有 'skill' 模式;direct 模式留位)
│   ├── normalize.mjs           # Tool: tweet → block / dedup / sort / 时间重排
│   ├── wiki.mjs                # Tool: 路径辅助 + slot section / summary 条目 idempotent upsert
│   ├── article-cache.mjs       # Tool: 按月 article 缓存
│   ├── x-fetcher.mjs · x-adapter.mjs    # Adapter: X 数据
│   ├── browser-provider.mjs · cdp-proxy.mjs · proxy-client.mjs · _utils.mjs
├── scripts/
│   ├── perch.mjs               # 主 CLI(单入口,subcommand 路由)
│   ├── wiki-write.mjs          # Agent tool: slot section pipe upsert
│   ├── summary-write.mjs       # Agent tool: summary 条目 pipe upsert(v2 新增)
│   ├── fetch-article.mjs       # Agent tool: 按需深抓 Twitter Article
│   ├── spike-list.mjs · spike-profile.mjs   # 调试 gate
├── templates/topics/<slug>/
│   ├── SCHEMA.md               # JSON frontmatter:sources + slots + (v2.x) schedule
│   ├── <slot>.md               # 每个 slot 的 analyze prompt(纯报告,不再附带 digest)
│   └── digest.md               # (可选)digest prompt;缺省走通用默认 prompt
└── docs/
    ├── DESIGN.md (本文件)
    └── TOPIC_AUTHORING.md
```

### 4.2 Topic 数据目录

```
<topic-path>/
├── raw/daily/YYYY-MM-DD.md       # 当月原始采集
├── summaries.md                  # 当月日概览(digest 维护)
├── wiki/
│   ├── daily/YYYY-MM-DD.md       # 当日所有 slot 合并,按 ## slot: <name> 分段
│   └── topic/                    # 主题 wiki(v2 不实现)
├── cache/articles/YYYY-MM/       # 按月累积的 article 深抓缓存
└── archive/YYYY-MM/              # 上月归档:raw + wiki + cache
```

数据目录由 config.json 的 `topics.<slug>.path` 指定,通常放 iCloud / Obsidian 同步盘。**只装运行时产物,不入 git**。

---

## 5. CLI 形态

单入口 `scripts/perch.mjs`,subcommand 一一对应 Topic method:

```bash
# Ingest:抓 X
node scripts/perch.mjs ingest --topic ai-radar [--dry] [--limit N]

# Analyze:出某 slot 的报告
node scripts/perch.mjs analyze --topic ai-radar [--slot <name>|now] [--date YYYY-MM-DD]

# Digest:出当日概览(prepend 到 summaries.md)
node scripts/perch.mjs digest --topic ai-radar [--date YYYY-MM-DD]

# Enrich:深抓 article
node scripts/perch.mjs enrich --topic ai-radar --url <status_url> [--date YYYY-MM-DD]

# Archive:月度归档
node scripts/perch.mjs archive --topic ai-radar [--dry-run]

# Admin
node scripts/perch.mjs admin list
node scripts/perch.mjs admin create --from-json <spec.json>
node scripts/perch.mjs admin create     # 交互向导
```

`--topic` 缺省 = `config.json` 的 `default_topic`。

**v1 命令对照**:

| v1 | v2 | 备注 |
|---|---|---|
| `node scripts/collect.mjs` | `perch ingest` | 行为等价 |
| `node scripts/report.mjs <slot>` | `perch analyze --slot <slot>` | prompt 不再附带 digest |
| `node scripts/rotate.mjs` | `perch archive` | 行为等价 |
| `node scripts/fetch-article.mjs <url>` | `perch enrich --url <url>` | (脚本仍存在,作为 prompt 内 agent tool) |
| `node scripts/new-topic.mjs --from-json` | `perch admin create --from-json` | 行为等价 |
| (无 — evening prompt 附带) | `perch digest` | 独立 method |
| `node scripts/wiki-write.mjs` | (保留)agent tool | prompt 内调用 |

### 5.1 Skill 模式下的 analyze / digest 流程

```
用户跑 `perch analyze --topic ai-radar --slot evening`
  ↓
perch.mjs → Topic.load → topic.analyze('evening', {})
  ↓
lib/analyze.mjs 解析 slot+date+window → 渲染 prompt → process.stdout.write(prompt)
  ↓
当前 Claude 会话接棒(skill 模式约定)
  ↓
Claude:Read raw → 生成 wiki markdown
  ↓
Claude: Bash heredoc pipe 给 scripts/wiki-write.mjs --topic ... --slot evening
  ↓
wiki-write.mjs 调用 lib/wiki.mjs::upsertWikiSlotSection,幂等写盘
```

Digest 同构,只是模板不同 + 写到 summaries.md(`scripts/summary-write.mjs` + `lib/wiki.mjs::prependSummaryEntry`)。

---

## 6. Raw 格式

每个 Topic 的 `raw/daily/YYYY-MM-DD.md` 是当日所有 source 合并的事实原始库。

- **一天一个文件**,**全局时间倒序**(最新在上,不变量)
- **每次 ingest 整体重排**,不是"新 block 前插"
- **多 source 合并**:同 Topic 下多个 source 写进同一天文件,block 内 `via: slug1, slug2` 标注
- **去重粒度 = tweet ID**,只扫每个 block 标题行 `/status/(\d+)`
- **长推完整性**:redux store 已合并 `note_tweet`,raw 的 `type:` 行带 `hydrated`
- **转发信号聚合**:纯 RT 合一个 block + `🔁 reposted by: @A, @B`;quote 保留多 block,通过 quote URL 关联
- **外链不抓**;**Twitter Article 不预抓**(只存 `🖼️ article: "title"` 预览,analyze 阶段按需 enrich)
- **block 格式**:
  ```
  ## @handle (Name) · MM-DD HH:MM · [source](url)
  type: tweet · hydrated
  via: slug1, slug2
  🔁 reposted by: @A, @B
  
  推文完整正文
  
  📊 N RT · N 💬 · N ❤️ · Nx views
  🖼️ images · video · article: "title"
  🔗 quote: @handle — 完整 quote 正文 [url]
  🔗 link: <external-url>
  
  ---
  ```

---

## 7. Prompt 占位符

Analyze prompt 模板可用占位符:

| 占位符 | 含义 |
|---|---|
| `{TOPIC_SLUG}` | topic slug |
| `{DATE}` | 归属日 YYYY-MM-DD |
| `{SLOT}` | slot name |
| `{RAW_PATH}` | 当日 raw 文件绝对路径 |
| `{WIKI_PATH}` | 当日 wiki 文件绝对路径 |
| `{WIKI_WRITE_CMD}` | 写当前 slot section 的命令前缀 |
| `{SOURCES}` | 人读的 source 描述 |
| `{WINDOW_TYPE}` | today / since_prev |
| `{WINDOW_START_LABEL}` · `{WINDOW_END_LABEL}` | YYYY-MM-DD HH:MM |
| `{ARTICLE_CACHE_DIR}` | 当月 article 缓存目录绝对路径 |
| `{FETCH_ARTICLE_CMD}` | 按需深抓 article 的命令行前缀 |

Digest prompt 模板可用占位符:

| 占位符 | 含义 |
|---|---|
| `{TOPIC_SLUG}` | topic slug |
| `{DATE}` | 归属日 |
| `{WIKI_PATH}` | 当日 wiki 文件绝对路径(digest 的输入) |
| `{SUMMARIES_PATH}` | summaries.md 绝对路径(写入目标) |
| `{SUMMARY_WRITE_CMD}` | prepend summary 条目的命令前缀 |

---

## 8. 风险

### R1. X 内部状态结构漂移
Timeline 走 redux store(`state.urt.*` + `state.entities.*`),改版会断。status 详情页 + Article 走 DOM,DOM 改版会断。
**缓解**:多路径 fallback;timeline key 前缀匹配 + listId includes 兜底;`spike-list.mjs` / `spike-profile.mjs` 作为 review gate。

### R2. 零配置是幻觉
新 topic 至少要配 4 样:数据源 / 清洗规则 / 报告模板 / 摘要 prompt。**接受 2-3 小时配置成本**,SCHEMA + 模板降低门槛。

### R3. Skill 模式的不健壮
analyze / digest 依赖"当前 Claude 会话会读 stdout 的 prompt 并接棒"。脱离 Claude Code 会话静默失败(脚本 exit 0,无 LLM 工作发生)。
**缓解**:v2.x 引入 `lib/llm.mjs::complete()`(direct API 模式),同一份 method、同一份 prompt,仅 LLM 调用一步换实现。

### R4. 月度归档的数据完整性
cron 失败 / 重入错乱 / 漏文件 = 丢数据。
**缓解**:`topic.archive()` 必须幂等 + 支持 `--dry-run`;手动跑若干次再考虑 cron。

---

## 9. v2 实现状态

| 步 | 任务 | 状态 |
|---|---|---|
| 1 | Topic class 一等公民 | ✅ |
| 2 | Ingest method(等价 v1 collect) | ✅ |
| 3 | Analyze method(等价 v1 report,prompt 不再附带 digest) | ✅ |
| 4 | Digest method(独立 method + 通用 prompt + summary-write agent tool) | ✅ |
| 5 | Enrich method(等价 v1 fetch-article 的 method 形态) | ✅ |
| 6 | Archive method(等价 v1 rotate) | ✅ |
| 7 | Admin static methods(等价 v1 new-topic) | ✅ |
| 8 | 统一 CLI scripts/perch.mjs | ✅ |
| 9 | LLM Direct 模式(`lib/llm.mjs::complete()`) | ⏸ 留 v2.x |
| 10 | Schedule 字段 + 通用 runner(读 schedule 自动 chain analyze→digest) | ⏸ 留 v2.x |
| 11 | Topic Wiki rebuild / stale | ⏸ 不实现 |
| 12 | 跨 topic 查询 | ⏸ 不实现 |

### v2 明确不做

- LLM Direct 模式(留接口,不实现)
- Schedule 自动驱动(留 SCHEMA 字段,不实现 runner)
- Topic Wiki 的 rebuild / stale 机制
- 跨 topic 查询
- summaries 月度切分归档
- per-topic timezone

---

## 10. 术语表

| 术语 | 含义 |
|---|---|
| **Topic** | 一等对象,封装一个信息漏斗的全部配置 + 行为(method) |
| **Source** | Topic 的数据输入端,目前支持 `x-list` / `x-user` |
| **Daily Wiki** | 归属日 1 份文件,按 `## slot: <name>` 分段;analyze 维护 |
| **Topic Wiki** | 跨日累积,带 frontmatter;v2 不实现 |
| **Raw** | 归一化后的原始推文 markdown,一天一个文件 |
| **Summaries** | 当月日概览,digest 维护(`## YYYY-MM-DD` 条目时间倒序) |
| **Slot** | Topic 级时段配置(`SCHEMA.slots`),每条对应一个 analyze prompt 模板 |
| **Window** | slot 的报告覆盖窗口(`today` / `since_prev`) |
| **Skill 模式** | LLM 介入步由当前 Claude 会话接棒;脚本只渲染 prompt |
| **Direct 模式** | LLM 介入步由脚本直接调 Anthropic API;v2.x 实现 |
| **Agent tool** | prompt 内被 Claude Bash 调用的辅助脚本(wiki-write / summary-write / fetch-article) |
