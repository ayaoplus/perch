# Topic Authoring Guide (v2)

> 给 **人** 和 **agent** 读的"如何配置一个新 Topic"完整指南。架构层面的"为什么这么设计"见 `docs/DESIGN.md`;本文件专注"怎么做"。

---

## 1. 概念速览

Perch 的一等公民是 **Topic** —— 一个对象,封装 `sources + slots + 时段 prompt + (可选)digest 模板` 的完整配置。所有领域操作都是 `topic.<method>()`。换领域 = 换一整套 topic 配置,框架代码不动。

一个 Topic 的组成:

```
Topic (例: ai-radar)
├── sources[]           数据源(X List / X Profile),可多条,同一 raw 合并
├── slots[]             每日报告时段(morning/noon/evening…),topic 级自定义
│   └── window          每个 slot 的报告覆盖窗口(today / since_prev)
├── analyze 模板        每个 slot 一份 `<slot>.md`,给 Claude 用的问题清单
├── digest 模板(可选)  `digest.md`,日概览的自定义 prompt(缺省走通用模板)
└── 数据目录            raw / wiki / summaries / cache / archive,落盘在独立路径
```

关键不变量:

- **Source 不等于 Topic**。多个 source 默认合并到同一 raw 文件(`raw/daily/YYYY-MM-DD.md`),用 `via: <slug>` 区分。如果某 source 要独立产出,**升级成新 topic**,不要在 raw 层分目录
- **Slot name 是文件名也是占位符值**,同时被 wiki 文件名、prompt 模板文件名、`{SLOT}` 占位符引用。改名 = 跨三处改动
- **Slot window 不改 raw 结构**,只是给 Claude 的 prompt 里注入时间边界让它自己按 `MM-DD HH:MM` 过滤。raw 永远是当日整天的
- **Topic 逻辑配置(SCHEMA + prompt)在 git 里**;**数据目录不在 git 里**。前者走 `templates/topics/<slug>/`,后者由 `config.json` 的 `topics.<slug>.path` 指定(可以是 iCloud)

---

## 2. 三种创建方式

### 2.1 交互向导(人用)

```bash
node scripts/perch.mjs admin create
```

一步步问:slug / 描述 / 数据路径 / sources / slots。确认后一次性生成:
- `templates/topics/<slug>/SCHEMA.md`
- 每个 slot 一份 `<slot>.md` analyze prompt 骨架
- 在 `config.json` 的 `topics` 下注册条目

向导**不会覆盖已有文件**,冲突即退出。

### 2.2 JSON 非交互(agent 用)

```bash
node scripts/perch.mjs admin create --from-json spec.json
```

`spec.json` 格式:

```json
{
  "topic": "my-radar",
  "description": "一行人读描述",
  "dataPath": "/Users/me/Library/Mobile Documents/iCloud~md~obsidian/Documents/my-radar",
  "sources": [
    {
      "slug": "defi-ops",
      "type": "list",
      "target": "https://x.com/i/lists/1234567890",
      "label": "DeFi Ops",
      "fetch_limit": 80
    }
  ],
  "slots": [
    { "name": "morning", "start_hour": 6, "window": "today" },
    { "name": "afternoon", "start_hour": 14, "window": "since_prev" },
    { "name": "evening", "start_hour": 19, "window": "today" }
  ]
}
```

也可以直接 import 用:

```js
import { Topic } from './lib/topic.mjs';
import { validateTopicSpec } from './lib/admin.mjs';

const err = validateTopicSpec(spec);
if (err) throw new Error(err);
const written = await Topic.create(rootDir, spec);
```

### 2.3 手工(最透明,也最容易错)

四步:

1. 建目录 `templates/topics/<slug>/`
2. 写 `SCHEMA.md` —— 顶部 JSON frontmatter(定义 sources + slots),下面人读说明
3. 每个 slot 写一份 `<slot>.md` analyze prompt
4. 在 `config.json` 的 `topics` 下加条目

见下节字段详解。

---

## 3. 字段详解

### 3.1 `SCHEMA.md` frontmatter

文件顶部 `---` 之间一段 **合法 JSON**(不是 YAML)。

```json
{
  "topic": "my-radar",
  "description": "一行人读描述",
  "sources": [ ... ],
  "slots":   [ ... ]
}
```

#### `sources[]`

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `slug` | string | ✅ | 本 topic 内唯一,`^[a-z][a-z0-9-]*$`。写盘时作 `via: <slug>` 落入每个 block |
| `type` | `"list"` \| `"profile"` | ✅ | list = X List;profile = 用户时间线 |
| `target` | string | ✅ | list 时:`https://x.com/i/lists/NNN`。profile 时:handle 或完整 URL |
| `label` | string | | 人读备注 |
| `fetch_limit` | int 1-200 | | 每次抓取上限,默认 80。设计上是 **generous**:给 pinned / 当日高频账号留余量 |

#### `slots[]`

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `name` | string | ✅ | `^[a-z][a-z0-9-]*$`,不得为保留字 `now` |
| `start_hour` | int 0-23 | ✅ | 该 slot 从几点起。加载时自动按 `start_hour` 升序 |
| `window` | `"today"` \| `"since_prev"` | | analyze 报告覆盖窗口,默认 `today` |

**缺省整个 `slots` 字段**会 fallback 到三槽 `morning@5 / noon@12 / evening@18`。这条 fallback 在两处生效:
- **手写 SCHEMA.md** 时:Topic.load 运行时自动回填
- **`admin create --from-json`** 时:scaffoldTopic 接受省略,但会把 DEFAULT_SLOTS **显式写进** SCHEMA.md(打开就能看到完整配置,不依赖运行时行为)

**window 语义**:
- `today`:覆盖归属日 00:00 → 当前触发时刻。适合"今天讨论最多的标的是什么"等**累积统计型**问题
- `since_prev`:只覆盖"上一 slot.start_hour → 当前触发时刻"。适合"这段时间有什么新冒出来的"等**增量型**问题。当前 slot 是第一个时,自动 fallback 为 `today`(避免跨昨日 raw)

### 3.2 `config.json` 的 topic 条目

```json
{
  "default_topic": "ai-radar",
  "timezone": "Asia/Shanghai",
  "topics": {
    "my-radar": {
      "path": "/Users/me/...absolute-data-path",
      "description": "描述(与 SCHEMA.description 取其一)",
      "templates_dir": "templates/topics/my-radar"
    }
  }
}
```

| 字段 | 含义 |
|---|---|
| `default_topic` | `--topic` 未传时的 topic slug |
| `timezone` | 全局时区,决定"今天"是哪天、时段切分在哪 |
| `topics.<slug>.path` | **绝对路径**,raw/wiki/summaries/cache/archive 住这里 |
| `topics.<slug>.description` | 回退描述(SCHEMA.description 优先) |
| `topics.<slug>.templates_dir` | 相对仓库根的模板目录,通常 `templates/topics/<slug>` |

### 3.3 Slot prompt 模板(`<slot>.md`)

每个 slot 对应同目录一份 markdown,顶部没有 frontmatter(全是 prompt 正文)。

可用占位符(analyze 渲染时替换):

| 占位符 | 值 |
|---|---|
| `{TOPIC_SLUG}` | topic slug |
| `{DATE}` | `YYYY-MM-DD`(**归属日**,不是"今天"—— wrap 场景指向昨天) |
| `{SLOT}` | 当前 slot name |
| `{RAW_PATH}` | 归属日 raw 文件绝对路径 |
| `{WIKI_PATH}` | 归属日 wiki 文件绝对路径(**当日所有 slot 共用一份**) |
| `{WIKI_WRITE_CMD}` | `node /abs/path/to/scripts/wiki-write.mjs --topic <slug> --date <date> --slot <slot>` |
| `{SUMMARIES_PATH}` | summaries.md 绝对路径(只读引用,不要在 analyze 里写) |
| `{SOURCES}` | 人读 source 描述 |
| `{WINDOW_TYPE}` | `today` \| `since_prev` |
| `{WINDOW_START_LABEL}` · `{WINDOW_END_LABEL}` | `YYYY-MM-DD HH:MM` |
| `{ARTICLE_CACHE_DIR}` | 当月 article 缓存目录绝对路径 |
| `{FETCH_ARTICLE_CMD}` | `node /abs/path/to/scripts/fetch-article.mjs --topic <slug>` |

**prompt 作者约定**:
- 模板里**不要硬编码**"过去 12h""完整 24h"等小时数,引用 `{WINDOW_*}` 占位符
- **不要让 Claude 用 Write 直接写 `{WIKI_PATH}`** —— 当日 wiki 是共享文件,直接覆盖会抹掉其他 slot 的 section。必须用 `{WIKI_WRITE_CMD} <<'PERCH_EOF' ... PERCH_EOF` 走脚本 upsert
- **summaries 不要在 analyze prompt 里产出**(v2 拆出独立 digest method)
- ai-radar 三份 prompt 是参考样例

### 3.4 Digest prompt 模板(可选)

如果 topic 没有 `templates/topics/<slug>/digest.md`,digest 走 `lib/digest.mjs` 的通用默认模板(适合大多数场景)。

要自定义,创建该文件,可用占位符:

| 占位符 | 值 |
|---|---|
| `{TOPIC_SLUG}` | topic slug |
| `{DATE}` | 归属日 |
| `{WIKI_PATH}` | 当日 wiki 文件绝对路径(digest 的输入) |
| `{SUMMARIES_PATH}` | summaries.md 绝对路径(写入目标) |
| `{SUMMARY_WRITE_CMD}` | `node /abs/path/to/scripts/summary-write.mjs --topic <slug> --date <date>` |

写入约定同 wiki-write:用 `{SUMMARY_WRITE_CMD} <<'PERCH_EOF' ... PERCH_EOF` heredoc pipe,**不要**用 Write 直接覆盖 `{SUMMARIES_PATH}`。

### 3.5 `analyze` 的 slot 映射 + 日期回退 + endLabel

**所有 agent 在 prompt 处理 raw 时必须理解这一节**。

`analyze` 对 `now` 和显式指定 slot 统一走同一条 `resolveSlotAndDate`,核心是"当 slot 在今天**还没开始**时,回退到昨天那个实例":

| slotArg | hour(topic.timezone)条件 | slot | `{DATE}` / `{RAW_PATH}` / `{WIKI_PATH}` |
|---|---|---|---|
| `now` | `hour ≥ slots[0].start_hour` | `pickSlot(hour)` | **今天** |
| `now` | `hour < slots[0].start_hour`(凌晨 wrap) | **最后一个 slot** | **昨天** |
| `<显式>` | `hour ≥ slotDef.start_hour` | 显式 slot | **今天** |
| `<显式>` | `hour < slotDef.start_hour` | 显式 slot | **昨天** |

**`{WINDOW_END_LABEL}` 规则**:

| 归属日 | endLabel |
|---|---|
| 昨天 | **canonical end**:下一 slot 的 `start_hour:00`,末 slot 用归属日 `23:59` |
| 今天 | **`min(now, canonical end)`**:slot 进行中→now;slot 已过→canonical |

**例子**(ai-radar slots=`morning@5 / noon@12 / evening@18`):

| 触发时刻 CST | 命令 | slot / date | window |
|---|---|---|---|
| 00:38 | `analyze` | evening / 昨天 | `今天-1 00:00 → 23:59` |
| 00:38 | `analyze --slot noon` | noon / 昨天 | `今天-1 05:00 → 18:00` |
| 14:00 | `analyze` | noon / 今天 | `今天 05:00 → 14:00` |
| 14:00 | `analyze --slot noon` | noon / 今天 | `今天 05:00 → 14:00` |
| 19:00 | `analyze --slot noon` | noon / 今天 | `今天 05:00 → 18:00` |
| 23:30 | `analyze` | evening / 今天 | `今天 00:00 → 23:30` |

**agent 使用建议**:
- **推荐用 `analyze` 不带 `--slot`** —— 时区 / wrap / 日期 / endLabel 全自动
- **显式 `analyze --slot <name>`** 在今天还没到该 slot 时,会自动指向**昨天**那个实例(补跑 / 复盘)
- 想生成"今天某个未来 slot"的报告 —— 等到那个 slot 时段再跑

---

## 4. Raw 格式(消费侧要知道)

文件:`<path>/raw/daily/YYYY-MM-DD.md`

一条推文 = 一个 block,**全局**时间倒序(最新在上)。每次 `ingest` 把"已有 block"和"新抓 block"合并后整体按 `MM-DD HH:MM` 重排写回(不是简单前插)。

block 结构:

```markdown
## @handle (Name) · MM-DD HH:MM · [source](https://x.com/handle/status/NNN)
type: tweet · hydrated
via: slug1, slug2
🔁 reposted by: @alice, @bob

推文完整正文

📊 12 RT · 3 💬 · 47 ❤️ · 5k views
🖼️ 2 images · video · article: "长文标题"
🔗 quote: @orig — 原推完整正文 [https://x.com/orig/status/MMM]
🔗 link: https://external.example.com/article

---
```

关键约定:

- **去重粒度 = 顶层 statusId**。只扫 `## ` 标题行的 `/status/(\d+)`
- **纯 RT 共享原推 statusId**:多人 RT → 一个 block + `reposted by: @A, @B`
- **Quote tweet 有独立 statusId**:多个 quote → 多个 block,通过 `🔗 quote: ... [url]` 关联
- **长推已在 ingest 阶段自动 hydrate**:raw 里的正文是完整的
- **Article 全文不在 raw 里**:只有 `🖼️ article: "title"` 预览 + statusUrl,按需 enrich
- **外链不抓**:只有 `🔗 link: <url>`,不展开

---

## 5. 按需深抓 Twitter Article

当 analyze 里 Claude 看到 `🖼️ article: "title"` 预览且回答需要正文时:

```bash
node scripts/fetch-article.mjs <status_url> [--topic <slug>]
```

或 CLI 形式:

```bash
node scripts/perch.mjs enrich --topic <slug> --url <status_url>
```

行为:

1. 命中 `<path>/cache/articles/YYYY-MM/<statusId>.md` → 直接输出缓存路径
2. 未命中 → 用 CDP 开 status 页 + 抓完整 markdown,写缓存 + 输出路径
3. status 页不是 Article(普通长推 / 找不到文章) → 退出码 2,stderr 报错

**只抓 Twitter Article**。普通长推 ingest 阶段已 hydrate,不需要再抓。外链文章不抓。

缓存按引用月归档,月末 archive 随 raw/wiki 一起搬到 `archive/YYYY-MM/cache/articles/`。

---

## 6. 目录结构(最终)

每个 topic 的数据目录:

```
<topic.path>/
├── raw/
│   └── daily/YYYY-MM-DD.md     当日原始采集(多 source 合并,时间倒序)
├── summaries.md                每日概览(digest 维护,## YYYY-MM-DD 倒序)
├── wiki/
│   ├── daily/YYYY-MM-DD.md     当日所有 slot 合并(按 ## slot: <name> 分段)
│   └── topic/<name>.md         按需累积的主题报告(v2 不实现)
├── cache/
│   └── articles/YYYY-MM/<statusId>.md   按需深抓的 article 正文
└── archive/
    └── YYYY-MM/                归档:含上月的 raw/daily + wiki/daily + cache/articles
```

仓库侧:

```
templates/topics/<slug>/
├── SCHEMA.md         frontmatter(sources + slots)+ 人读说明
├── morning.md        每个 slot.name 一份 analyze prompt
├── noon.md
├── evening.md
└── digest.md         可选:digest 自定义模板;缺省走通用默认
```

---

## 7. 端到端流程

新 topic 上线:

```bash
# 1. 创建配置
node scripts/perch.mjs admin create
# (或) node scripts/perch.mjs admin create --from-json spec.json

# 2. 编辑 prompt —— 把每个 <slot>.md 里的占位问题换成真问题
vim templates/topics/<slug>/morning.md
...

# 3. 确认 Chrome 开着 --remote-debugging-port=9222 且登录了 X

# 4. Dry 一次(不写盘,看抓到什么)
node scripts/perch.mjs ingest --topic <slug> --dry

# 5. 正式采集(一天多次跑自动按 statusId 去重 + 全局时间重排)
node scripts/perch.mjs ingest --topic <slug>

# 6. 生成某个 slot 的报告(skill 模式:打 prompt → Claude 接棒生成 → pipe wiki-write)
node scripts/perch.mjs analyze --topic <slug>            # 自动选 slot + 凌晨 wrap
node scripts/perch.mjs analyze --topic <slug> --slot evening  # 显式指定

# 7. 当日概览(digest 独立 method)
node scripts/perch.mjs digest --topic <slug>

# 8. 月末归档
node scripts/perch.mjs archive --topic <slug> --dry-run
node scripts/perch.mjs archive --topic <slug>
```

**agent 自动化建议**:
- `ingest`:定时 3~4 次/天,CLI 幂等
- `analyze`:优先用不带 `--slot`(等价 `now`),时区 / wrap 全自动。Claude 接棒后**必须用 `{WIKI_WRITE_CMD}` heredoc pipe**,不要 Write 直接覆盖 `{WIKI_PATH}`
- `digest`:每天 evening 之后跑一次(或者将来由 schedule 自动 chain)
- `archive`:每月 1 号跑一次,前置 `--dry-run`

---

## 8. 常见坑 / 设计边界

- **同一 source 想拆出独立产出**:升级为**新 topic**,不要在 raw 层分目录
- **长推 / quote 正文完整性**:Adapter 层从 X redux store 直接读,`note_tweet` 已合并进 `full_text`,长推 + quote 全文都现成
- **时段模板缺失**:`analyze` 直接报错退出。新增 slot 记得同步建 prompt 模板
- **slot 名字叫 `now`**:Topic.load 阶段被拒(保留字)
- **时区不是 topic 级**:v2 全局只有一个 `timezone`,跨时区多 topic 留 v2.x
- **article cache 跨月不复用**:故意简化,让 archive 能无脑整目录搬
- **外链不抓**:设计边界
- **凌晨跑 analyze wrap 到昨天**:设计行为,`date` / `raw` / `wiki` / `window` 一起回退
- **`since_prev` 首 slot fallback 到 today**:不要在 morning prompt 里暗示"过去 12-15h 包含昨晚",当前实现不支持跨昨日 raw
- **endLabel 绝不溢出到未来或下一 slot**:`min(now, canonical)` 杜绝
- **prompt 里硬编码小时数**:不要,用 `{WINDOW_*}` 占位符
- **summaries 在 analyze prompt 里产出**(v1 旧行为):v2 已拆,**analyze prompt 不要再附带 summaries 任务**;summary 由独立的 `perch digest` 产出
- **Write 工具直接覆盖 wiki / summaries**:绝对不能,会抹掉同文件其他 slot / 其他天的内容。永远走 `{WIKI_WRITE_CMD}` / `{SUMMARY_WRITE_CMD}` heredoc pipe

---

## 9. 给 agent 的导航

**代码入口(按 v2 角色调用顺序)**:
- ingest:  `scripts/perch.mjs ingest` → `lib/ingest.mjs::ingest` → `lib/x-fetcher.mjs` → `lib/normalize.mjs`
- analyze: `scripts/perch.mjs analyze` → `lib/analyze.mjs::analyze` → 渲染 prompt → stdout(skill 模式)→ Claude 接棒 → `scripts/wiki-write.mjs` → `lib/wiki.mjs::upsertWikiSlotSection`
- digest:  `scripts/perch.mjs digest` → `lib/digest.mjs::digest` → 渲染 prompt → stdout → Claude 接棒 → `scripts/summary-write.mjs` → `lib/wiki.mjs::prependSummaryEntry`
- enrich:  `scripts/perch.mjs enrich` → `lib/enrich.mjs::enrich` → `lib/article-cache.mjs`(也可由 prompt 内 Claude 直接 Bash `scripts/fetch-article.mjs`)
- archive: `scripts/perch.mjs archive` → `lib/archive.mjs::archive`
- admin:   `scripts/perch.mjs admin` → `lib/admin.mjs::scaffoldTopic`(或 `Topic.create`)
- Topic 加载: `lib/topic.mjs`(`Topic.load` / `Topic.list` / `Topic.create`;`DEFAULT_SLOTS` 也从这里导出;`loadTopic` 函数保留作为兼容 wrapper)

**给自动化 agent 的关键约束**:
- **新建 topic** → 首选 `node scripts/perch.mjs admin create --from-json <spec>` 或 `Topic.create(rootDir, spec)`
- **不要手工拼** SCHEMA.md + config.json
- **不要把时间窗口写死在 prompt 模板**里 —— 用 `{WINDOW_*}` 占位符
- **生成报告优先用 `analyze` 不带 `--slot`** —— 时区 / wrap / endLabel 全自动
- **读 raw 别假设"今天"就是 CLI 触发那天** —— 永远用 `{DATE}` 占位符

**修改代码前**必读 `CLAUDE.md` 和 `docs/DESIGN.md`。不要越过 Adapter / Domain / Tool 三层分工(见 DESIGN §2.2)。
