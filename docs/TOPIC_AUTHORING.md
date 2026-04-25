# Topic Authoring Guide (v3)

> 给 **人** 和 **agent** 读的"如何配置一个新 Topic"完整指南。架构层面的"为什么这么设计"见 `docs/DESIGN.md`;本文件专注"怎么做"。

---

## 1. 概念速览

Perch 的一等公民是 **Topic** —— 一个对象,封装 `sources + prompts + 数据目录` 的完整配置。所有领域操作都是 `topic.<method>()`。换领域 = 换一整套 topic 配置 + prompt 模板,框架代码不动。

一个 Topic 的组成:

```
Topic (例: ai-radar)
├── sources[]              数据源(X List / X Profile),可多条,同一 raw 合并
├── prompts/               prompt 模板集(任意数量、任意命名)
│   ├── morning.md
│   ├── noon.md
│   ├── evening.md         (典型双产出:wiki + summary)
│   └── weekly.md          (按需新增)
└── 数据目录                raw / wiki / summaries / cache / archive,落盘在独立路径
```

关键不变量:

- **Source 不等于 Topic**。多个 source 默认合并到同一 raw 文件,用 `via: <slug>` 区分。某 source 要独立产出 = **升级成新 topic**
- **Prompt 文件名 = Prompt 标识**。`templates/topics/<slug>/morning.md` 即 `perch report --prompt morning` 的引用
- **调度由外部决定**。framework 不做"什么时候出哪份报告"的判断,cron / openclaw / agent 自己拼命令
- **Topic 逻辑配置(SCHEMA + prompts)在 git 里**;**数据目录不在 git 里**

---

## 2. 三种创建方式

### 2.1 交互向导(人用)

```bash
node scripts/perch.mjs admin create
```

一步步问:slug / 描述 / 数据路径 / sources / prompts。生成:
- `templates/topics/<slug>/SCHEMA.md`
- 每份 `<prompt>.md` 骨架
- `config.json` 的 topic 注册

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
  "prompts": ["morning", "noon", "evening"]
}
```

`prompts` 缺省 = `["default"]`(单 prompt)。

也可以 import 用:

```js
import { Topic } from './lib/topic.mjs';
import { validateTopicSpec } from './lib/admin.mjs';

const err = validateTopicSpec(spec);
if (err) throw new Error(err);
const written = await Topic.create(rootDir, spec);
```

### 2.3 手工

四步:

1. 建目录 `templates/topics/<slug>/`
2. 写 `SCHEMA.md` —— JSON frontmatter 只放 sources;下面人读说明
3. 每份 prompt 写一个 `<name>.md`
4. 在 `config.json` 的 `topics` 下加条目

---

## 3. 字段详解

### 3.1 `SCHEMA.md` frontmatter

文件顶部 `---` 之间一段 **合法 JSON**(不是 YAML)。**v3 只有 sources**(无 slots、无 schedule):

```json
{
  "topic": "my-radar",
  "description": "一行人读描述",
  "sources": [ ... ]
}
```

#### `sources[]`

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `slug` | string | ✅ | 本 topic 内唯一,`^[a-z][a-z0-9-]*$`。写盘时作 `via: <slug>` 落入每个 block |
| `type` | `"list"` \| `"profile"` | ✅ | list = X List;profile = 用户时间线 |
| `target` | string | ✅ | list 时:`https://x.com/i/lists/NNN`。profile 时:handle 或完整 URL |
| `label` | string | | 人读备注 |
| `fetch_limit` | int 1-200 | | 每次抓取上限,默认 80 |

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
| `timezone` | 全局时区,决定"今天"是哪天 |
| `topics.<slug>.path` | **绝对路径**,raw/wiki/summaries/cache/archive 住这里 |
| `topics.<slug>.description` | 回退描述(SCHEMA.description 优先) |
| `topics.<slug>.templates_dir` | 相对仓库根的模板目录 |

### 3.3 Prompt 模板(`<name>.md`)

每个 prompt 对应同目录一份 markdown,顶部没有 frontmatter(全是 prompt 正文)。

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
| `{SOURCES}` | 人读 source 描述 |
| `{ARTICLE_CACHE_DIR}` | 当月 article 缓存目录绝对路径 |
| `{FETCH_ARTICLE_CMD}` | `node /abs/path/scripts/fetch-article.mjs --topic <slug>` |

**v2 → v3 变化**:删除 `{SLOT} / {WINDOW_TYPE} / {WINDOW_START_LABEL} / {WINDOW_END_LABEL} / {RAW_PATH}`。时间过滤由 prompt 自己写(引用 `{DATE}` + 硬编码,如 noon prompt 写 "只看 {DATE} 12:00 之后")。

**prompt 作者约定**:
- 输入语义靠 `{INPUTS_LIST}` 列出文件,Claude 自己 Read
- **不要用 Write 直接写 `{WIKI_PATH}` / `{SUMMARIES_PATH}`** —— 必须用 `{WIKI_WRITE_CMD}` / `{SUMMARY_WRITE_CMD}` heredoc pipe
- 时间过滤由 prompt 自己描述(典型:morning 看全天 / noon 看 12:00 之后 / evening 看全天 + 出 summary)
- ai-radar 的三份 prompt 是参考样例

### 3.4 双产出 prompt(evening 类)

evening 类全天总结想同时产出 wiki section + summary 概览,prompt 里写两个 Bash pipe 命令:

```markdown
## 双产出写入方式

### 1. 详细 wiki

\`\`\`bash
{WIKI_WRITE_CMD} <<'PERCH_EOF'
(完整报告 markdown)
PERCH_EOF
\`\`\`

### 2. 5-7 句日概览

\`\`\`bash
{SUMMARY_WRITE_CMD} <<'PERCH_EOF'
(5-7 句正文,不含 ## DATE 标题,脚本自动加)
PERCH_EOF
\`\`\`
```

一次 LLM 调用,两次 Bash pipe,两次写盘。

### 3.5 调度

v3 框架**不做调度**。报告节奏由外部 cron / openclaw / agent 决定:

```bash
0 8  * * *  perch ingest --topic ai-radar && perch report --topic ai-radar --prompt morning
0 13 * * *  perch ingest --topic ai-radar && perch report --topic ai-radar --prompt noon
0 19 * * *  perch ingest --topic ai-radar && perch report --topic ai-radar --prompt evening
```

凌晨补跑昨天:

```bash
0 3 * * * perch report --topic ai-radar --prompt evening \
    --date $(date -d yesterday +%F) \
    --inputs raw/daily/$(date -d yesterday +%F).md
```

shell 时间运算 + 文件路径自己拼,框架不做特殊处理。

---

## 4. Raw 格式(消费侧要知道)

文件:`<path>/raw/daily/YYYY-MM-DD.md`

一条推文 = 一个 block,**全局**时间倒序(最新在上)。每次 `ingest` 把已有 + 新抓 block 合并后整体按 `MM-DD HH:MM` 重排写回(不是简单前插)。

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
- **Quote tweet 有独立 statusId**:多个 quote → 多个 block,通过 quote URL 关联
- **长推已在 ingest 阶段自动 hydrate**:raw 里是完整正文
- **Article 全文不在 raw 里**:只有 `🖼️ article: "title"` 预览 + statusUrl,按需 enrich
- **外链不抓**:只有 `🔗 link: <url>`,不展开

---

## 5. 按需深抓 Twitter Article

当 report 里 Claude 看到 `🖼️ article: "title"` 预览且回答需要正文时:

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
├── summaries.md                每日概览(evening 类双产出 prompt 维护)
├── wiki/
│   ├── daily/YYYY-MM-DD.md     当日所有 section(按 ## section: <name> 分段)
│   └── topic/<name>.md         按需累积的主题报告(v3 不实现)
├── cache/
│   └── articles/YYYY-MM/<statusId>.md   按需深抓的 article 正文
└── archive/
    └── YYYY-MM/                归档:含上月的 raw/daily + wiki/daily + cache/articles
```

仓库侧:

```
templates/topics/<slug>/
├── SCHEMA.md         frontmatter(只 sources)+ 人读说明
├── morning.md        prompt 模板(任意数量、任意命名)
├── noon.md
├── evening.md
└── weekly.md         按需新增
```

---

## 7. 端到端流程

新 topic 上线:

```bash
# 1. 创建配置
node scripts/perch.mjs admin create
# (或) node scripts/perch.mjs admin create --from-json spec.json

# 2. 编辑 prompt — 把每个 <name>.md 里的占位问题换成真问题
vim templates/topics/<slug>/morning.md
...

# 3. 确认 Chrome 开着 --remote-debugging-port=9222 且登录了 X

# 4. Dry 一次(不写盘)
node scripts/perch.mjs ingest --topic <slug> --dry

# 5. 正式采集(一天多次跑自动按 statusId 去重 + 全局时间重排)
node scripts/perch.mjs ingest --topic <slug>

# 6. 出报告(skill 模式:打 prompt → Claude 接棒生成 → pipe wiki-write)
node scripts/perch.mjs report --topic <slug> --prompt morning

# 7. 月末归档
node scripts/perch.mjs archive --topic <slug> --dry-run
node scripts/perch.mjs archive --topic <slug>
```

**agent 自动化建议**:
- `ingest`:cron 3-4 次/天
- `report`:cron 各时段一次,prompt 名对应该时段
- 凌晨补跑昨天:cron 命令显式传 `--date` + `--inputs`
- `archive`:每月 1 号一次,前置 `--dry-run`

---

## 8. 常见坑 / 设计边界

- **同一 source 想拆出独立产出**:升级为**新 topic**,不要在 raw 层分目录
- **长推 / quote 正文完整性**:Adapter 层从 X redux store 直接读,`note_tweet` 已合并进 `full_text`
- **Prompt 缺失**:`report` 直接报错退出。新增 prompt = 加一份 `.md`
- **时区不是 topic 级**:v3 全局只有一个 `timezone`
- **article cache 跨月不复用**:故意简化,让 archive 能无脑整目录搬
- **外链不抓**:设计边界
- **Write 工具直接覆盖 wiki / summaries**:绝对不能,会抹掉同文件其他 section / 其他天的内容
- **凌晨补跑昨天**:cron 显式传 `--date $(date -d yesterday +%F)` + `--inputs <昨天 raw>`,框架不做自动 wrap
- **prompt 里硬编码小时数**:OK —— prompt 文件即是单一 source of truth(典型:noon 写 "只看 {DATE} 12:00 之后")。这是 v3 与 v2 的关键差别(v2 用 `{WINDOW_*}` 占位符)
- **wiki section 顺序**:按写入顺序;改 cron 顺序就改 wiki 顺序。框架不强加排序

---

## 9. 给 agent 的导航

**代码入口(按 v3 角色调用顺序)**:
- ingest:  `scripts/perch.mjs ingest` → `lib/ingest.mjs::ingest` → `lib/x-fetcher.mjs` → `lib/normalize.mjs`
- report:  `scripts/perch.mjs report` → `lib/report.mjs::report` → 渲染 prompt → stdout(skill 模式)→ Claude 接棒 → `scripts/wiki-write.mjs` → `lib/wiki.mjs::upsertWikiSection`(必要时再 pipe `scripts/summary-write.mjs` → `lib/wiki.mjs::prependSummaryEntry`)
- enrich:  `scripts/perch.mjs enrich` → `lib/enrich.mjs::enrich` → `lib/article-cache.mjs`
- archive: `scripts/perch.mjs archive` → `lib/archive.mjs::archive`
- admin:   `scripts/perch.mjs admin` → `lib/admin.mjs::scaffoldTopic`(或 `Topic.create`)
- Topic 加载: `lib/topic.mjs`(`Topic.load` / `Topic.list` / `Topic.create`;`loadTopic` 函数保留作为兼容 wrapper)

**给自动化 agent 的关键约束**:
- **新建 topic** → 首选 `node scripts/perch.mjs admin create --from-json <spec>` 或 `Topic.create(rootDir, spec)`
- **不要手工拼** SCHEMA.md + config.json
- **生成报告**:每份 prompt 文件名(去 `.md`)即 `--prompt` 值
- **读 raw 别假设"今天"就是 CLI 触发那天** —— 永远用 prompt 里的 `{DATE}` 占位符
- **时间过滤**:prompt 自己写(noon 类硬编码 "只看 {DATE} 12:00 之后";morning / evening 看全部 inputs)

**修改代码前**必读 `CLAUDE.md` 和 `docs/DESIGN.md`。
