# Perch — 设计规范(v3)

> 多 Topic 个人信息漏斗 · 互联网数据处理框架

---

## 1. 项目定位

**一句话**:多 Topic 的个人信息漏斗。每个 Topic = 一组数据源 + 一组 prompt 模板。**调度由外部决定**(cron / openclaw / agent / 手动),框架只管"采集 → 文件 → LLM 处理 → 文件"这条流水。

**核心价值**:

1. **X 能抓**(登录态真实 Chrome + CDP 瘦核,不靠官方 API)
2. **结构化的 LLM 工作流**(任意时段 / 形态报告,prompt 是数据)
3. **真正的工具集**(Unix 哲学:每个命令做一件事,组合靠外部编排)

**明确不做**:

- 不做 RSS(已有 miniflux/NetNewsWire)
- 不做长期归档知识库(perch 是"信息漏斗",不是 wiki 本身)
- 不做通用平台抓取(只做 X,专注登录态 + 时段报告这对组合)
- **不做调度**(cron / scheduler 是用户 / agent 的事)

---

## 2. 架构总览

### 2.1 v3 的核心抽象

只剩 **Topic + Prompt 模板**。框架退化成纯工具集:

```
调度层(外部 cron / openclaw / agent / 手动)
  │
  ▼
┌─────────────────────────────────────────────┐
│           Topic(配置 + 数据目录)             │
│  load() → 实例 → method 调度                 │
└─────────────────────────────────────────────┘
   │            │           │           │
   ▼            ▼           ▼           ▼
 ingest      report      enrich     archive
   │            │           │           │
[抓 sources][prompt+      [深抓     [月度归档]
            inputs→LLM]    article]
   │            │           │           │
  raw        wiki/         cache/    archive/
 daily       summaries     articles   YYYY-MM/
```

`admin` 是配置 CRUD,不在主链。

**和 v2 的差别**:slot / window / 凌晨 wrap / canonical end / digest 这一整套抽象**全部消失**。v3 只有 4 个核心角色 + 通用 prompt runner。

### 2.2 关键设计决策

#### Topic 是配置容器,不是行为驱动者

Topic 实例字段只有:`slug / description / timezone / dataPath / templatesDir / sources`。**没有 slots、没有 schedule、没有 window**。

调用者通过 method 触发行为:

```js
const topic = await Topic.load('ai-radar', rootDir);
await topic.ingest({ out: '...' });
await topic.report('evening', { inputs: ['...'], date: '...' });
```

method 接受运行时参数(out 路径、inputs、date、section 名),由调用者(CLI / cron 命令 / agent)决定。

#### Prompt 模板是数据,不是配置

`templates/topics/<slug>/<name>.md` 想叫什么名字、放多少份,**完全由用户决定**。`<name>` 是 prompt 的标识,也是默认的 wiki section 名。

新增一种报告(月报、周报、专题分析)= 写一份新 `.md` 文件,**不动框架**。

#### 调度由外部完成

每天三份报告 = 三个 cron + 各自指定 prompt:

```bash
# 早 8:00
perch ingest --topic ai-radar
perch report --topic ai-radar --prompt morning

# 午 13:00
perch ingest --topic ai-radar
perch report --topic ai-radar --prompt noon

# 晚 19:00
perch ingest --topic ai-radar
perch report --topic ai-radar --prompt evening   # 同时输出 wiki + summary
```

凌晨补跑昨天报告?cron 命令自己写时间运算:

```bash
0 3 * * * perch report --topic ai-radar --prompt evening \
    --inputs raw/daily/$(date -d yesterday +%F).md \
    --date $(date -d yesterday +%F)
```

shell 一行,不需要框架抽象。

#### Raw 一日一文件 + 全局倒序(保留)

`raw/daily/YYYY-MM-DD.md` 仍是当日单一文件。每次 `ingest` 把新内容合进去 + 整体重排。理由:

- LLM 拿到的是干净的当日完整快照,不需要跨文件 dedup
- 累积视角天然实现:第一次 ingest 后 raw 有早间内容,第二次 ingest 后追加午间,第三次后是全天
- 路径稳定,wiki 索引 / archive / 月度切分都 anchor 在日期上

### 2.3 运行时分层(Adapter / Domain / Tool)

| 层 | 位置 | 做什么 |
|---|---|---|
| **Adapter** | `lib/x-fetcher.mjs` · `lib/x-adapter.mjs` · `lib/llm.mjs` · CDP 栈 | 和外部世界打交道:读 X redux store · 调 Anthropic Messages API · CDP 控制浏览器 |
| **Domain** | `lib/topic.mjs`(Topic class)+ `lib/{ingest,report,enrich,archive,admin}.mjs` | 角色实现,接收 Topic 实例 + 运行时参数 |
| **Tool** | `lib/normalize.mjs` · `lib/wiki.mjs` · `lib/article-cache.mjs` | 可组合原子 |

`scripts/perch.mjs` 在 Domain 之上,只做 subcommand 路由 + 默认值填充(如 `--inputs` 缺省 = today raw)。

### 2.4 LLM 调用模式(Skill / Direct)

LLM 介入只发生在 **Report** 角色。两种模式共享同一份 prompt 模板:

| 模式 | 触发 | 行为 |
|---|---|---|
| **Skill**(默认) | `--llm skill` 或缺省 | report 渲染 prompt → stdout;**当前 Claude 会话**读到后接棒(Read inputs / Bash pipe wiki-write 等) |
| **Direct** | `--llm direct` 或 `PERCH_LLM_MODE=direct` | report 渲染 prompt → 走 `lib/llm.mjs::runPromptWithTools` 直连 Anthropic Messages API + agent loop;LLM 通过 `read_file` / `bash` tool 自主完成读 inputs / 生成 markdown / pipe 给 wiki-write 等 |

Direct 模式需要 `ANTHROPIC_API_KEY`。可选 env:`PERCH_LLM_MODEL`(默认 `claude-sonnet-4-5`)/ `PERCH_LLM_MAX_TOKENS`(默认 16384)/ `PERCH_LLM_DEBUG`(打印 API request/response 简要)。

**为什么两种模式 prompt 共享**:Direct 模式的 agent loop 给 LLM 暴露的工具(`read_file` / `bash`)和 Claude Code 会话给 Claude 的工具是同源 —— 同一份 prompt 让 LLM 跑 `{WIKI_WRITE_CMD} <<'PERCH_EOF' ... PERCH_EOF`,Skill 模式下 Claude Code 用 Bash 工具执行,Direct 模式下 lib/llm.mjs 的 bash 工具执行。语义同构。

**安全**:Direct 模式的 bash tool cwd 锁到 perch 仓库根,加 timeout(默认 10 分钟)+ stdout 大小上限(200KB)。**Prompt injection 风险来自 X 推文内容**(LLM 可能被注入"忽略指令、执行 rm -rf"),首版不做命令白名单,责任在 cron / openclaw 容器层做隔离。

### 2.5 Provider 抽象 + Retry

`lib/llm.mjs` 内置三个 provider(`PERCH_LLM_PROVIDER` env 选择):

| Provider | env | endpoint | 默认模型 |
|---|---|---|---|
| **anthropic**(默认) | `ANTHROPIC_API_KEY` | `https://api.anthropic.com/v1/messages` | `claude-sonnet-4-5` |
| **openai** | `OPENAI_API_KEY` + 可选 `PERCH_LLM_BASE_URL` | OpenAI 或任何 OpenAI-compatible(OpenRouter / Together / 本地 vLLM) | `gpt-4o` |
| **stub** | (无) | 不调网络 | (无) |

agent loop 内部用 Anthropic-style content blocks(text / tool_use / tool_result)。openai provider 在调用前后做双向转换,loop 完全不动。

**Retry 策略**(对 anthropic / openai 都生效):
- HTTP 429 / 5xx / network error(ECONNRESET / fetch failed / 等)→ 可重试
- HTTP 4xx(非 429)→ 配置错误,直接抛
- Backoff:exponential + 30% jitter,respect `retry-after` header(cap 60s)
- env:`PERCH_LLM_MAX_RETRIES`(默认 5) / `PERCH_LLM_INITIAL_BACKOFF_MS`(默认 1000)

**stub 失败注入**(测试用,不调网络):
- `PERCH_LLM_STUB_FAIL_FIRST=N` — 前 N 次返回 RetryableError(模拟 429)
- `PERCH_LLM_STUB_FATAL_FIRST=N` — 前 N 次返回不可重试错误

### 2.6 Ingest 真实管线

```
对每个 source 调 fetcher → 跨 source dedupTweets(__via / repostedBy 聚合)
  → readExistingIds 跨次去重 → sortTweetsByTime
  → formatTweet → 渲染成 raw block 字符串
  → splitRawBlocks + mergeBlocksByTimeDesc(全局倒序重排)
  → 整体重写 out 文件(默认 raw/daily/{today}.md)
```

**关键不变量**:写盘后 raw 文件全局时间倒序。每次 ingest 整体重排而非前插,所以"晚到的旧推文"(pinned 挤占、source 晚一轮)会被放到正确位置。

**为什么读 redux store 而不是 DOM**:X SPA 进入 list/profile 页时一次性把 80+ 条塞进 redux,虚拟列表只 mount 7-10 条到 DOM。读 redux 直接拿 X 已解出的 API response,含长推全文、repost 链、metrics、views,全 idempotent。

---

## 3. 核心概念

### 3.1 Topic

Topic = `sources + prompts + 数据目录` 的封装。

**实例字段**(`Topic.load` 返回):

| 字段 | 来源 |
|---|---|
| `slug` | config.json 的 key |
| `description` | SCHEMA 或 config.json |
| `timezone` | config.json 全局 |
| `dataPath` | config.json `topics.<slug>.path` |
| `templatesDir` | config.json `topics.<slug>.templates_dir` |
| `sources` | SCHEMA.md 的 `sources[]` |

**实例方法**:

| Method | 职责 |
|---|---|
| `ingest(opts)` | 抓 → dedup → 重排 → 写 raw |
| `report(promptName, opts)` | 渲染 prompt → stdout(skill 模式) |
| `enrich(statusUrl, opts)` | 深抓 article → 月度缓存 |
| `archive(opts)` | 月度归档 |

**静态方法**:`Topic.load / list / create`

### 3.2 SCHEMA.md

```jsonc
{
  "topic": "ai-radar",
  "description": "AI 博主每日选题漏斗",
  "sources": [
    { "slug": "ai-kol", "type": "list", "target": "https://x.com/i/lists/...", "fetch_limit": 80 }
  ]
}
```

**注意**:v3 SCHEMA **没有 slots 字段**。如果 SCHEMA 里残留 `slots`(从 v2 升级),Topic.load 会忽略 + 在 stderr 打 deprecation 警告,不报错。

### 3.3 Prompt 模板

`templates/topics/<slug>/<name>.md` —— 任意数量、任意命名。文件名(不含 `.md`)= prompt 的标识。

可用占位符(`report` 渲染时替换):

| 占位符 | 值 |
|---|---|
| `{TOPIC_SLUG}` | topic slug |
| `{DATE}` | `--date` 或 today(topic.timezone) |
| `{INPUTS}` | comma-separated 路径串(原样) |
| `{INPUTS_LIST}` | 多行列表(`- path1\n- path2\n...`) |
| `{PROMPT_NAME}` | `--prompt` 值 |
| `{SECTION_NAME}` | `--section` 或缺省 = `--prompt` |
| `{WIKI_PATH}` | `wiki/daily/{date}.md` 绝对路径 |
| `{WIKI_WRITE_CMD}` | `node /abs/path/scripts/wiki-write.mjs --topic <slug> --date <date> --section <section>` |
| `{SUMMARIES_PATH}` | `summaries.md` 绝对路径 |
| `{SUMMARY_WRITE_CMD}` | `node /abs/path/scripts/summary-write.mjs --topic <slug> --date <date>` |
| `{SOURCES}` | 人读 source 描述(`X List "AI KOL" + ...`) |
| `{ARTICLE_CACHE_DIR}` | 当月 article 缓存目录绝对路径 |
| `{FETCH_ARTICLE_CMD}` | `node /abs/path/scripts/fetch-article.mjs --topic <slug>` |

**和 v2 的差别**:删除 `{SLOT} / {WINDOW_TYPE} / {WINDOW_START_LABEL} / {WINDOW_END_LABEL}`。时间过滤由 prompt 自己写,通常通过引用 `{DATE}` 加硬编码小时数(例如 noon prompt 写 "只看 {DATE} 12:00 之后的内容")。

### 3.4 Wiki 文件结构

`wiki/daily/YYYY-MM-DD.md` 仍是当日单一文件,按 `## section: <name>` 分段。但 v3 不再有"slot 排序":

- **section 名字**由调用者 `--section` 决定(默认 = `--prompt`)
- **section 顺序**按写入顺序排列(同名替换),框架不强加顺序
- 用户每天按相同 cron 顺序跑,wiki 自然会有相同结构;改 cron 顺序 = 改 wiki 顺序

`scripts/wiki-write.mjs` 的 stdin pipe 接口:

```bash
{WIKI_WRITE_CMD} <<'PERCH_EOF'
(report markdown 内容,不含 ## section: <name> 外层标题)
PERCH_EOF
```

幂等语义:同 section 重跑替换自己那段,其他 section 原样保留。

### 3.5 Summaries

`summaries.md` 是当月日概览,按 `## YYYY-MM-DD` 时间倒序 prepend。由 evening prompt(或其他全天总结类 prompt)在生成详细 wiki 的同时,**Bash 调 `{SUMMARY_WRITE_CMD}` heredoc pipe 写一条 5-7 句概览**。

**和 v2 的差别**:v2 把 digest 拆成独立 method,v3 合并回 evening prompt(Q3 方案 A)。一次 LLM 调用同时输出两件事(详细 wiki + 概览),Claude 在 prompt 流程中分别 pipe 给 wiki-write 和 summary-write。

### 3.6 月度切分

- 活跃库 = 只当月
- 每月 1 号 `topic.archive()` 上月 `raw/daily` + `wiki/daily` + `cache/articles/上月/` 到 `archive/YYYY-MM/`
- summaries.md 不归档(留 v3.x)
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
│   ├── topic.mjs               # Topic class
│   ├── ingest.mjs              # Ingest 实现
│   ├── report.mjs              # 通用 prompt runner(取代 v2 的 analyze + digest)
│   ├── enrich.mjs              # Enrich 实现
│   ├── archive.mjs             # Archive 实现
│   ├── admin.mjs               # Admin 实现
│   ├── normalize.mjs           # Tool: tweet → block / dedup / 时间重排
│   ├── wiki.mjs                # Tool: 路径辅助 + section / summary idempotent upsert
│   ├── article-cache.mjs       # Tool: 按月 article 缓存
│   ├── x-fetcher.mjs · x-adapter.mjs    # Adapter: X 数据
│   └── browser-provider.mjs · cdp-proxy.mjs · proxy-client.mjs · _utils.mjs
├── scripts/
│   ├── perch.mjs               # 主 CLI(单入口,subcommand 路由)
│   ├── wiki-write.mjs          # Agent tool: section pipe upsert
│   ├── summary-write.mjs       # Agent tool: summary 条目 pipe upsert
│   ├── fetch-article.mjs       # Agent tool: 按需深抓 Article
│   └── spike-list.mjs · spike-profile.mjs   # 调试 gate
├── templates/topics/<slug>/
│   ├── SCHEMA.md               # JSON frontmatter:仅 sources(无 slots)
│   ├── <prompt-name>.md        # 任意数量、任意命名的 prompt 模板
│   └── ...
└── docs/
    ├── DESIGN.md (本文件)
    └── TOPIC_AUTHORING.md
```

### 4.2 Topic 数据目录

```
<topic-path>/
├── raw/daily/YYYY-MM-DD.md       # 当月原始采集(每次 ingest 全局重排)
├── summaries.md                  # 当月日概览(evening 类 prompt 维护)
├── wiki/
│   ├── daily/YYYY-MM-DD.md       # 当日 ## section: <name> 分段
│   └── topic/                    # 主题 wiki(v3 不实现)
├── cache/articles/YYYY-MM/       # 按月 article 缓存
└── archive/YYYY-MM/              # 上月归档
```

数据目录由 config.json 的 `topics.<slug>.path` 指定,通常放 iCloud / Obsidian 同步盘。**只装运行时产物,不入 git**。

---

## 5. CLI

```bash
# Ingest
perch ingest --topic <slug> [--out <path>] [--dry] [--limit N]
   --out 默认 raw/daily/$(today).md

# Report(通用 prompt runner)
perch report --topic <slug> --prompt <name> [--inputs <paths>] [--date YYYY-MM-DD] [--section <name>]
   --inputs   默认 raw/daily/$(today).md;支持 comma-separated 多文件
   --date     默认 today(topic.timezone),决定 {DATE} 占位符 + wiki 写到哪天
   --section  默认 = --prompt 值,决定 wiki section 名

# Enrich
perch enrich --topic <slug> --url <status_url> [--date YYYY-MM-DD]

# Archive
perch archive --topic <slug> [--dry-run]

# Admin
perch admin list
perch admin create [--from-json <spec.json>]
```

`--topic` 缺省 = `config.json` 的 `default_topic`。

### 5.1 v2 → v3 命令对照

| v2 | v3 |
|---|---|
| `perch ingest` | `perch ingest`(行为等价,新增 `--out`) |
| `perch analyze --slot evening` | `perch report --prompt evening` |
| `perch analyze --slot now` | (无直接等价)cron 自己根据时间选 prompt |
| `perch digest` | (合并回 evening prompt 的 summary 任务) |
| `perch enrich` | `perch enrich`(不变) |
| `perch archive` | `perch archive`(不变) |
| `perch admin create` | `perch admin create`(不变) |

---

## 6. Raw 格式

每个 Topic 的 `raw/daily/YYYY-MM-DD.md` 是当日所有 source 合并的事实原始库。

- **一天一个文件**,**全局时间倒序**
- **每次 ingest 整体重排**(不是前插)
- **多 source 合并**:同 Topic 多个 source 写进同一天文件,block 内 `via: slug1, slug2` 标注
- **去重粒度 = tweet ID**,只扫每个 block 标题行 `/status/(\d+)`
- **长推完整性**:redux store 已合并 `note_tweet` 进 `full_text`,raw 的 `type:` 行带 `hydrated`
- **转发信号聚合**:纯 RT 合一个 block + `🔁 reposted by: @A, @B`;quote 保留多 block,通过 quote URL 关联
- **外链不抓**;**Twitter Article 不预抓**(只存 `🖼️ article: "title"` 预览,prompt 中按需 enrich)

block 格式见 v2(不变)。

---

## 7. 风险

### R1. X 内部状态结构漂移
Timeline 走 redux store,改版会断。status 详情页 + Article 走 DOM,DOM 改版会影响它们。
**缓解**:多路径 fallback;timeline key 前缀匹配 + listId includes 兜底;`spike-list.mjs` / `spike-profile.mjs` 作 review gate。

### R2. 零配置是幻觉
新 topic 至少要配 sources + 1 份以上 prompt。**接受 1-2 小时配置成本**(v3 比 v2 略低,因为没有 slot/window 这些抽象要懂)。

### R3. Skill 模式的依赖
Skill 模式 report 依赖"当前 Claude 会话读 stdout 的 prompt 并接棒",脱离会话静默失败。
**缓解**:v3.1 引入 **Direct 模式**(`lib/llm.mjs::runPromptWithTools`),脚本直连 Anthropic Messages API + agent loop + read_file/bash tools,prompt 模板**不变**。两种模式由 `--llm skill|direct` 或 `PERCH_LLM_MODE` env 切换。Direct 模式适合 cron / openclaw / 任意无 Claude Code 会话的 runner。

### R4. 月度归档数据完整性
**缓解**:`topic.archive()` 必须幂等 + `--dry-run`;手动跑若干次再 cron。

### R5. 调度交给外部 = 用户出错面更大
v3 把"什么时候跑、看哪些 inputs、用哪份 prompt"交给用户。错配 prompt 和 inputs(比如用 morning prompt 跑昨天的 raw)= 输出语义错乱。
**缓解**:文档清晰 + cron 命令模板化;长期看 LLM Direct + schedule 字段(v3.x)能让框架级 sanity check 重新成为可能。

---

## 8. v3 实现状态

| 步 | 任务 | 状态 |
|---|---|---|
| 1 | Topic class 简化(删除 slot 字段) | ✅ |
| 2 | lib/report.mjs 通用 runner | ✅ |
| 3 | lib/ingest.mjs 接受 --out | ✅ |
| 4 | wiki.mjs: upsertWikiSection(无排序约束) | ✅ |
| 5 | scripts/perch.mjs report 子命令 | ✅ |
| 6 | scripts/wiki-write.mjs --section | ✅ |
| 7 | ai-radar / crypto-radar 模板迁移 | ✅ |
| 8 | LLM Direct 模式(`lib/llm.mjs::runPromptWithTools` + agent loop) | ✅(v3.1) |
| 9 | SCHEMA `schedule` 字段 + 通用 runner | ⏸ 不做(v3 哲学就是不做调度) |
| 10 | Topic Wiki rebuild / stale | ⏸ 不实现 |
| 11 | 跨 topic 查询 | ⏸ 不实现 |

### v3 明确不做

- Schedule 自动驱动(v3 哲学就是不做调度,Direct 模式落地后已覆盖 cron / openclaw 场景)
- Topic Wiki 的 rebuild / stale 机制
- 跨 topic 查询
- summaries 月度切分归档
- per-topic timezone

---

## 9. 术语表

| 术语 | 含义 |
|---|---|
| **Topic** | 配置容器(sources + prompts + 数据目录),通过 method 触发行为 |
| **Source** | Topic 的数据输入端,目前支持 `x-list` / `x-user` |
| **Prompt 模板** | `templates/topics/<slug>/<name>.md`,任意数量、任意命名 |
| **Section** | wiki/daily 文件内的 `## section: <name>` 分段;名字由调用者 `--section` 决定 |
| **Daily Wiki** | 归属日 1 份文件,按 section 分段;report 维护 |
| **Summaries** | 当月日概览(`## YYYY-MM-DD`),时间倒序 prepend |
| **Raw** | 归一化后的原始推文 markdown,一天一个文件 |
| **Skill 模式** | LLM 介入步由当前 Claude 会话接棒;脚本只渲染 prompt |
| **Direct 模式** | LLM 介入步由脚本直连 Anthropic API;v3.x 实现 |
| **Agent tool** | prompt 内被 Claude Bash 调用的辅助脚本(wiki-write / summary-write / fetch-article) |
