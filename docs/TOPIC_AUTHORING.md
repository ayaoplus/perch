# Topic Authoring Guide

> 给 **人** 和 **agent** 读的"如何配置一个新 Topic"完整指南。架构层面的"为什么这么设计"见 `docs/DESIGN.md`;本文件专注"怎么做"。

---

## 1. 概念速览

Perch 的一等公民是 **Topic** — 一组 `sources + slots + 时段 prompt` 的完整配置包。换领域 = 换一整套 topic 配置,框架代码不动。

一个 Topic 的组成:

```
Topic (例: ai-radar / my-radar)
├── sources[]        数据源(X List / X Profile),可多条,同一 raw 合并
├── slots[]          每日报告时段(morning/noon/evening…),topic 级自定义
│   └── window       每个 slot 的报告覆盖窗口(today / since_prev)
├── prompt 模板      每个 slot 一份 `<slot>.md`,给 Claude 用的问题清单
└── 数据目录          raw / wiki / summaries / cache / archive,落盘在独立路径
```

关键不变量(破坏任一都会掉到"设计之外"):

- **Source 不等于 Topic**。多个 source 默认合并到同一 raw 文件(`raw/daily/YYYY-MM-DD.md`),用 `via: <slug>` 区分。如果某 source 要独立产出,**升级成新 topic**,不要在 raw 层分目录
- **Slot name 是文件名也是占位符值**,同时被 wiki 文件名、prompt 模板文件名、`{SLOT}` 占位符引用。改名 = 跨三处改动
- **Slot window 不改 raw 结构**,只是给 Claude 的 prompt 里注入时间边界让它自己按 `MM-DD HH:MM` 过滤。raw 永远是当日整天的
- **Topic 逻辑配置(SCHEMA + prompt)在 git 里**,**数据目录不在 git 里**。前者走 `templates/topics/<slug>/`,后者由 `config.json` 的 `topics.<slug>.path` 指定(可以是 iCloud)

---

## 2. 三种创建方式

### 2.1 交互向导(人用)

```bash
node scripts/new-topic.mjs
```

一步步问:slug / 描述 / 数据路径 / sources / slots。确认后一次性生成:
- `templates/topics/<slug>/SCHEMA.md`(frontmatter + 人读说明)
- 每个 slot 一份 `<slot>.md` prompt 骨架
- 在 `config.json` 的 `topics` 下注册条目

**向导不会覆盖已有文件**,冲突即退出。

### 2.2 JSON 非交互(agent 用)

```bash
node scripts/new-topic.mjs --from-json spec.json
```

适合 agent 或 CI。`spec.json` 格式:

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
    },
    {
      "slug": "btc-maximalists",
      "type": "list",
      "target": "https://x.com/i/lists/0987654321",
      "label": "BTC Maxi",
      "fetch_limit": 80
    }
  ],
  "slots": [
    { "name": "early", "start_hour": 6, "window": "today" },
    { "name": "morning", "start_hour": 10, "window": "today" },
    { "name": "afternoon", "start_hour": 14, "window": "since_prev" },
    { "name": "evening", "start_hour": 19, "window": "today" }
  ]
}
```

agent 也可以直接 import 用:

```js
import { scaffoldTopic, validateTopicSpec } from './scripts/new-topic.mjs';

const err = validateTopicSpec(spec);
if (err) throw new Error(err);
const written = await scaffoldTopic(rootDir, spec);
```

### 2.3 手工(最透明,也最容易错)

三步:

1. 建目录 `templates/topics/<slug>/`
2. 写 `SCHEMA.md` — 顶部 JSON frontmatter(定义 sources + slots),下面人读说明
3. 每个 slot 写一份 `<slot>.md` prompt
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
| `target` | string | ✅ | list 时:`https://x.com/i/lists/NNN`。profile 时:handle(`elonmusk` / `@elonmusk`)或完整 URL(也支持 `elonmusk/media`、`elonmusk/articles`、`elonmusk/with_replies`) |
| `label` | string | | 人读备注 |
| `fetch_limit` | int 1-200 | | 每次抓取上限,默认 80。设计上是 **generous**:给 pinned / 当日高频账号留余量,下游 ID 去重兜底。不是精确卡口 |

#### `slots[]`

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `name` | string | ✅ | `^[a-z][a-z0-9-]*$`,不得为保留字 `now`。决定 prompt 模板文件名和 wiki 文件名后缀 |
| `start_hour` | int 0-23 | ✅ | 该 slot 从几点起。加载时自动按 `start_hour` 升序排序 |
| `window` | `"today"` \| `"since_prev"` | | 报告覆盖窗口,默认 `today` |

**缺省整个 `slots` 字段**会 fallback 到三槽 `morning@5 / noon@12 / evening@18`(保留 v1 旧行为)。这条 fallback 在两个层面生效:
- **手写 SCHEMA.md** 时:loadTopic 运行时自动回填
- **`new-topic.mjs --from-json`** 时:scaffoldTopic 也接受 spec 省略 `slots`,并会把 DEFAULT_SLOTS **显式写进**生成的 SCHEMA.md(这样 SCHEMA 文件打开就能看到完整配置,不依赖运行时行为)

**window 语义**:
- `today`:覆盖今日 00:00 → 当前触发时刻。适合"今天讨论最多的标的是什么"这种**累积统计型**问题。后段报告会涵盖前段内容(这不是 bug,而是特性)
- `since_prev`:只覆盖"上一 slot.start_hour → 当前触发时刻"。适合"这段时间有什么新冒出来的"这种**增量型**问题。当前 slot 是第一个 slot 时,自动 fallback 为 `today`(避免跨昨日 raw)

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
| `timezone` | 全局时区,决定"今天"是哪天、时段切分在哪。当前不支持 per-topic 覆盖 |
| `topics.<slug>.path` | **绝对路径**,raw/wiki/summaries/cache/archive 住这里。不入 git,可放同步盘 |
| `topics.<slug>.description` | 回退描述(SCHEMA.description 优先) |
| `topics.<slug>.templates_dir` | 相对仓库根的模板目录,通常 `templates/topics/<slug>` |

### 3.3 Slot prompt 模板(`<slot>.md`)

每个 slot 对应同目录一份 markdown,顶部没有 frontmatter(全是 prompt 正文)。**全文都会被 Claude 读**,所以把任务描述 / 问题清单 / 输出格式都写进去即可。

可用占位符(report.mjs 负责替换):

| 占位符 | 值 |
|---|---|
| `{TOPIC_SLUG}` | topic slug |
| `{DATE}` | `YYYY-MM-DD`(**归属日**,不是"今天"—— wrap 场景指向昨天,详见下节) |
| `{SLOT}` | 当前 slot name |
| `{RAW_PATH}` | 归属日 raw 文件绝对路径 |
| `{WIKI_PATH}` | 本次 wiki 产出绝对路径(归属日 + slot) |
| `{SUMMARIES_PATH}` | `summaries.md` 绝对路径 |
| `{SOURCES}` | 人读 source 描述(`X List "AI KOL" + X Profile "elonmusk"`) |
| `{WINDOW_TYPE}` | `today` \| `since_prev` |
| `{WINDOW_START_LABEL}` | 窗口起点,`YYYY-MM-DD HH:MM` 格式(对 `today` 是 `date 00:00`;对 `since_prev` 是 `date prev.start_hour:00`) |
| `{WINDOW_END_LABEL}` | 窗口终点,`YYYY-MM-DD HH:MM` 格式,三种取值见下面的 **report now 行为** 一节 |
| `{ARTICLE_CACHE_DIR}` | 当月 article 缓存目录绝对路径 |
| `{FETCH_ARTICLE_CMD}` | `node /abs/path/to/scripts/fetch-article.mjs --topic <slug>`(Claude 直接拼 `<status_url>` 用) |

**prompt 作者约定**:模板里**不要硬编码**"过去 12h""完整 24h"这种小时数,而是引用 `{WINDOW_TYPE}` / `{WINDOW_START_LABEL}` / `{WINDOW_END_LABEL}`。这样 SCHEMA.slots 的 window 配置变更会自动反映到 prompt 里,不用改两处。ai-radar 的三份 prompt 是参考样例。

### 3.4 `report` 的 slot 映射 + 日期回退 + endLabel

**所有 agent 在 prompt 处理 raw 时必须理解这一节**,避免用错日期或分析未来窗口。

`report.mjs` 对 `now` 和显式指定 slot 统一走同一条 `resolveSlotAndDate`,核心是"当 slot 在今天**还没开始**时,回退到昨天那个实例":

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
| 今天 | **`min(now, canonical end)`**:slot 进行中→now(到触发时刻);slot 已过→canonical(不溢出到下一 slot) |

**例子**(ai-radar slots=`morning@5 / noon@12 / evening@18`):

| 触发时刻 CST | 命令 | slot / date | window |
|---|---|---|---|
| 00:38 | `report now` | evening / 昨天 | `今天-1 00:00 → 23:59` |
| 00:38 | `report noon` | noon / 昨天 | `今天-1 05:00 → 18:00` |
| 00:38 | `report evening` | evening / 昨天 | `今天-1 00:00 → 23:59` |
| 14:00 | `report now` | noon / 今天 | `今天 05:00 → 14:00`(进行中) |
| 14:00 | `report noon` | noon / 今天 | `今天 05:00 → 14:00`(同上) |
| 19:00 | `report noon` | noon / 今天 | `今天 05:00 → 18:00`(已过 → canonical) |
| 23:30 | `report now` | evening / 今天 | `今天 00:00 → 23:30`(evening 进行中) |

**两个都能杜绝的 bug**:
- **反向窗口**(start > end)— 曾在显式 slot 凌晨触发 + since_prev 下出现
- **未来窗口**(endLabel 在 now 之后)— 曾在显式 slot 在 slot 时段前触发时出现

**agent 使用建议**:
- **推荐用 `report now`** — 时区 / wrap / 日期 / endLabel 全自动
- **显式 `report <slot>`** 在今天还没到该 slot 时,会自动指向**昨天**那个实例(当成"回看"/补跑)
- **想生成"今天某个未来 slot"的报告**?等到那个 slot 时段再跑 — 今天还没发生的数据不能凭空分析

---

## 4. Raw 格式(消费侧要知道)

文件:`<path>/raw/daily/YYYY-MM-DD.md`

一条推文 = 一个 block,**全局**时间倒序(最新在上)。每次 `collect` 运行会把"已有 block"和"新抓 block"合并后整体按 `MM-DD HH:MM` 时间戳重排写回(不是简单前插),所以"晚到的旧推文"会自动排到正确位置,不会破坏倒序不变量。

block 结构:

```markdown
## @handle (Name) · MM-DD HH:MM · [source](https://x.com/handle/status/NNN)
type: tweet · hydrated
via: slug1, slug2                 (多 source 看到同一推文时聚合)
🔁 reposted by: @alice, @bob      (仅纯 RT;多个 reposter 会聚合到一行)

推文完整正文(长推已 hydrate 为完整正文)

📊 12 RT · 3 💬 · 47 ❤️ · 5k views
🖼️ 2 images · video · article: "长文标题"
🔗 quote: @orig — 原推完整正文 [https://x.com/orig/status/MMM]
🔗 link: https://external.example.com/article

---
```

关键约定:

- **去重粒度 = 顶层 statusId**。只扫 `## ` 标题行的 `/status/(\d+)`,避免 quote 行的 ID 被误判
- **纯 RT 共享原推 statusId**:多个推主 RT 同一条 → 一个 block + `reposted by: @A, @B`
- **Quote tweet 有独立 statusId**:多个推主 quote 同一条 → 多个 block,通过 `🔗 quote: ... [url]` 里的同一 URL 关联
- **长推已在 collect 阶段自动 hydrate**:raw 里的正文是完整的,`hydrated` 标志表示走过了这条路径
- **Article 全文不在 raw 里**:只有 `🖼️ article: "title"` 预览 + statusUrl,按需用 fetch-article 深抓
- **外链不抓**:只有 `🔗 link: <url>`,不展开

---

## 5. 按需深抓 Twitter Article

当 slot 的 prompt 让 Claude 回答一个问题,且 raw 里看到 `🖼️ article: "title"` 预览但不够时,Claude 可以 Bash 深抓:

```bash
node scripts/fetch-article.mjs <status_url> [--topic <slug>]
```

行为:

1. 命中 `<path>/cache/articles/YYYY-MM/<statusId>.md` 缓存 → 直接输出缓存路径
2. 未命中 → 用 CDP 开 status 页,x-adapter `_extractStatus` 抓完整 markdown,写缓存 + 输出路径
3. status 页不是 twitter Article(普通长推 / 找不到文章) → 退出码 2,stderr 报错

**只抓 twitter Article**。普通长推 collect 阶段已 hydrate,不需要再抓。外链文章**不抓**(设计边界)。

缓存按引用月归档,月末 rotate 随 raw/wiki 一起搬到 `archive/YYYY-MM/cache/articles/`。

---

## 6. 目录结构(最终)

每个 topic 的数据目录:

```
<topic.path>/
├── raw/
│   └── daily/YYYY-MM-DD.md     当日原始采集(多 source 合并,时间倒序)
├── summaries.md                每日概览(按 `## YYYY-MM-DD` 倒序,evening report 维护)
├── wiki/
│   ├── daily/YYYY-MM-DD-{slot}.md   每个 slot 一份报告
│   └── topic/<name>.md              按需累积的主题报告(v1 手动触发)
├── cache/
│   └── articles/YYYY-MM/<statusId>.md   按需深抓的 article 正文
└── archive/
    └── YYYY-MM/                归档:含上月的 raw/daily + wiki/daily + cache/articles
```

仓库侧:

```
templates/topics/<slug>/
├── SCHEMA.md         frontmatter(sources + slots)+ 人读说明
├── morning.md        每个 slot.name 一份 prompt 模板
├── noon.md
└── evening.md
```

---

## 7. 端到端流程

新 topic 上线:

```bash
# 1. 创建配置
node scripts/new-topic.mjs
# (或) node scripts/new-topic.mjs --from-json spec.json

# 2. 编辑 prompt — 把每个 <slot>.md 里的"占位问题"换成你真要问的 6-N 个问题
vim templates/topics/<slug>/morning.md
vim templates/topics/<slug>/noon.md
...

# 3. 确认 Chrome 开着 --remote-debugging-port=9222 且登录了 X

# 4. Dry 一次(不写盘,看抓到什么)
node scripts/collect.mjs --topic <slug> --dry

# 5. 正式采集(写进当日 raw;一天多次跑自动按 statusId 去重 + 全局时间重排)
node scripts/collect.mjs --topic <slug>
node scripts/collect.mjs --topic <slug> --limit 20    # 可选:临时覆盖所有 source 的 fetch_limit

# 6. 生成某个 slot 的报告(Claude 会话里跑)
node scripts/report.mjs now --topic <slug>            # 自动选 slot + 凌晨 wrap 到昨天末 slot
node scripts/report.mjs morning --topic <slug>        # 显式指定(end 用 canonical,不受当前时刻影响)

# 7. 月末归档(上月 raw + wiki + article cache → archive/)
node scripts/rotate.mjs --topic <slug> --dry-run
node scripts/rotate.mjs --topic <slug>
```

**agent 跑自动化建议**:
- `collect`:定时 3~4 次/天,CLI 幂等(statusId 去重 + 全局重排都能吸收重复调用)
- `report`:优先用 `now`,时区 / slot / 归属日期 / window 全部自动解析;凌晨触发会自动 wrap 到昨天末 slot,`{DATE}` / `{RAW_PATH}` / `{WIKI_PATH}` 一起指向昨天
- `rotate`:每月 1 号跑一次,前置 `--dry-run` 看 plan

---

## 8. 常见坑 / 设计边界

- **同一 source 想拆出独立产出**:升级为**新 topic**,不要在 raw 层分目录(DESIGN §5 的硬约束)
- **长推 / quote 正文完整性**:Fetch 层从 X redux store 直接读,`note_tweet` 已经被 X 合并进 `full_text`,长推 + quote 的全文都是现成的,不需要"二次 hydrate"这一步。Quote 也从 store 里 `entities.tweets[<quoted_id>]` 直接拿 text,无截断
- **时段模板缺失**:`report.mjs` 直接报错退出。新增 slot 记得同步建 prompt 模板
- **slot 名字叫 `now`**:会在 loadTopic 阶段被拒(`now` 是保留字,给 `report.mjs now` 的自动映射用)
- **时区不是 topic 级**:v1 全局只有一个 `timezone`。跨时区多 topic 要到 v2
- **article cache 跨月不复用**:同一篇文章 5 月被引用缓存到 `2026-05/`,6 月再引会在 `2026-06/` 再抓一次。故意简化,让 rotate 能无脑整目录搬
- **外链不抓**:设计边界。社交语境不等于"知识图谱",外站内容太杂,值得抓的走 twitter article 这条已登录可控的路
- **凌晨跑 `report now` / 显式 slot 在该 slot 今天起点前触发会 wrap 到昨天**:这是设计行为,`date` / `raw` / `wiki` / `window` 一起回退到**昨天的那个 slot 实例**。想生成"今天某个未来 slot"的报告只能等(数据还没发生)
- **`since_prev` 首 slot fallback 到 today**:想让 morning 真正覆盖昨晚 overnight,需要在 `slots[0].start_hour` 之前跑 `report now`(会 wrap 回昨日末 slot,归属日完整 24h)。不要在 morning prompt 里暗示"过去 12-15h 包含昨晚",当前实现不支持跨昨日 raw
- **endLabel 绝不溢出到未来或下一 slot**:归属日=今天时,`end = min(now, canonical)`。slot 进行中就是"到触发时刻",slot 已过就 cap 在 canonical(下一 slot 的起点),不会把之后 slot 的数据混进这一份报告
- **prompt 里硬编码小时数**:不要在模板里写"过去 5h""完整 24h",用 `{WINDOW_START_LABEL}` / `{WINDOW_END_LABEL}` 占位符,这样改 SCHEMA.slots.window 会自动生效,不用改两处(ai-radar 三个 prompt 是参考样例)
- **raw 里"晚到的旧推文"**:collect 每次运行整体按时间重排写盘(`splitRawBlocks` + `mergeBlocksByTimeDesc`),所以晚一轮才抓到的旧推文会被插到文件中的正确位置,不会破坏全局倒序

---

## 9. 给 agent 的导航

**代码入口(按调用顺序)**:
- collect: `scripts/collect.mjs` → `lib/x-fetcher.mjs` → `lib/x-adapter.mjs` → `lib/normalize.mjs`(formatTweet / dedupTweets / splitRawBlocks / mergeBlocksByTimeDesc)
- report: `scripts/report.mjs` → prompt 模板 + 占位符替换 → Claude 会话接棒 → 写 `wiki/daily/...`
- 按需深抓: `scripts/fetch-article.mjs` → `lib/article-cache.mjs`
- 归档: `scripts/rotate.mjs` → `lib/rotate.mjs`
- Topic 加载: `lib/topic.mjs`(所有脚本的共同入口;`DEFAULT_SLOTS` 也从这里导出)
- Topic 脚手架: `scripts/new-topic.mjs`(`scaffoldTopic` / `validateTopicSpec` / `renderSchemaMd` / `renderSlotPrompt` 四个可 import 的纯函数)

**给自动化 agent 的关键约束**:
- **新建 topic** → 首选 `scripts/new-topic.mjs --from-json <spec>`(有校验、幂等、不覆盖已有配置);`spec.slots` 可省略自动 fallback DEFAULT_SLOTS
- **不要手工拼** SCHEMA.md + config.json — 容易漏校验(slot name `^[a-z][a-z0-9-]*$`、不得为 `now`、start_hour 0-23、window 枚举、source slug 唯一…)
- **不要把时间窗口写死在 prompt 模板**里 — 用 `{WINDOW_*}` 占位符,让 SCHEMA.slots 成为单一 source of truth
- **生成报告优先用 `report now`** — 时区 / wrap / 归属日期 / endLabel 全自动;显式 slot 用于补跑或复盘(end 是 canonical 不是 now)
- **读 raw 别假设"今天"就是 CLI 触发那天** — 永远用 prompt 里的 `{DATE}` 占位符(wrap 场景下它指昨天)

**修改代码前**必读 `CLAUDE.md` 和 `docs/DESIGN.md`。不要越过 Fetch / Business / Tool 三层分工(见 DESIGN §2.1)。
