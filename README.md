# Perch

> 多 Topic 个人信息漏斗 · 互联网数据处理框架(v3)

每个 Topic = 一组 **数据源 + 任意多份 prompt 模板** 的配置容器。**调度由外部决定**(cron / openclaw / agent / 手动),框架只做"采集 → 文件 → LLM 处理 → 文件"这条流水。换领域 = 换一份 Topic 配置 + prompt,不动框架代码。

完整设计见 [`docs/DESIGN.md`](docs/DESIGN.md)。创建 topic 的详细指南见 [`docs/TOPIC_AUTHORING.md`](docs/TOPIC_AUTHORING.md)。

---

## 核心能力

| 角色 | 命令 | 说明 |
|---|---|---|
| **Ingest** | `perch ingest` | 真实登录态 Chrome + CDP 读 X redux store → 跨源去重 → 全局倒序写当日 raw |
| **Report** | `perch report --prompt <name> [--llm skill\|direct]` | 通用 prompt runner;Skill 模式 Claude 会话接棒,Direct 模式直连 Anthropic API + tool loop |
| **Enrich** | `perch enrich --url <url>` | CDP 深抓 Twitter Article → 按月缓存 |
| **Archive** | `perch archive` | 月末把上月 raw / wiki / cache 搬到 `archive/YYYY-MM/`,幂等,支持 `--dry-run` |
| **Admin** | `perch admin list / create` | Topic 配置 CRUD;`create --from-json` 非交互 |

---

## 架构速览

### 角色清单(信息生命周期)

5 个角色,清单收敛。新形态报告(周报、专题分析)= 写一份 `.md` prompt,**不动框架**。

```
Ingest  →  Report  →  (Wiki section / Summary 条目)
              ↑
            Enrich
              ↑
            Admin
```

### 实现层

```
Adapter (lib/x-fetcher · x-adapter · CDP 栈)
   ↓  和外部世界打交道:读 X redux store
Domain  (lib/topic.mjs Topic class + 5 个角色模块)
   ↓  领域逻辑
Tool    (lib/normalize · wiki · article-cache)
        可组合原子
```

`scripts/perch.mjs` 在 Domain 之上 ~30 行,只做 subcommand 路由 + 默认值填充。

---

## 目录结构

```
perch/
├── config.example.json         # 提交到 git 的占位模板
├── config.json                 # 本地运行时配置(已 gitignore)
├── lib/
│   ├── topic.mjs               # Topic class
│   ├── ingest.mjs / report.mjs / enrich.mjs / archive.mjs / admin.mjs
│   ├── normalize.mjs / wiki.mjs / article-cache.mjs       # Tool 层
│   └── x-fetcher.mjs / x-adapter.mjs / *cdp*               # Adapter 层
├── scripts/
│   ├── perch.mjs               # 主 CLI(单入口)
│   ├── wiki-write.mjs          # Agent tool: section pipe upsert
│   ├── summary-write.mjs       # Agent tool: summary 条目 pipe upsert
│   ├── fetch-article.mjs       # Agent tool: 按需深抓
│   └── spike-list.mjs / spike-profile.mjs   # 调试 gate
├── templates/topics/<slug>/    # 每个 topic 的 SCHEMA.md + 任意多份 <name>.md prompt
└── docs/DESIGN.md              # 完整设计规范
```

Topic **数据**(raw / wiki / summaries / archive)住在 `config.json` 指定的 `path` 下(例如 iCloud 同步盘),不入 git;Topic **逻辑配置**(SCHEMA + prompts)住在 `templates/topics/<slug>/`,入 git。

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
node scripts/perch.mjs ingest --topic ai-radar --out /tmp/test-raw.md   # 显式 out

# Report:渲染 prompt(skill 模式:打 stdout,Claude 接棒生成)
node scripts/perch.mjs report --topic ai-radar --prompt morning
node scripts/perch.mjs report --topic ai-radar --prompt evening
node scripts/perch.mjs report --topic ai-radar --prompt evening --date 2026-04-23  # 补跑昨天

# Report:跨日 / 多文件输入(周报、回顾)
node scripts/perch.mjs report --topic ai-radar --prompt weekly \
    --inputs "raw/daily/2026-04-20.md,raw/daily/2026-04-21.md,raw/daily/2026-04-22.md"

# Enrich:深抓 Twitter Article(report 阶段 Claude 也会按需 Bash 调 fetch-article.mjs)
node scripts/perch.mjs enrich --topic ai-radar --url https://x.com/author/status/NNN

# Archive:月末归档
node scripts/perch.mjs archive --topic ai-radar --dry-run
node scripts/perch.mjs archive --topic ai-radar

# Admin
node scripts/perch.mjs admin list
node scripts/perch.mjs admin create
node scripts/perch.mjs admin create --from-json spec.json
```

### 默认值

- `--topic` 缺省 → `config.json` 的 `default_topic`
- `--inputs` 缺省 → today raw 单文件
- `--date` 缺省 → today(topic.timezone)
- `--section` 缺省 → 与 `--prompt` 同名

### 调度典型形态(cron + Direct 模式)

cron 不在 Claude Code 会话里,需要 **Direct 模式**(脚本直连 Anthropic API 跑 LLM):

```bash
# /etc/cron.d/perch (示例)
ANTHROPIC_API_KEY=sk-ant-...
PERCH_LLM_MODE=direct

0 8  * * *  cd /path/to/perch && node scripts/perch.mjs ingest --topic ai-radar && node scripts/perch.mjs report --topic ai-radar --prompt morning
0 13 * * *  cd /path/to/perch && node scripts/perch.mjs ingest --topic ai-radar && node scripts/perch.mjs report --topic ai-radar --prompt noon
0 19 * * *  cd /path/to/perch && node scripts/perch.mjs ingest --topic ai-radar && node scripts/perch.mjs report --topic ai-radar --prompt evening
```

凌晨补跑昨天:

```bash
0 3 * * *  cd /path/to/perch && node scripts/perch.mjs report --topic ai-radar --prompt evening \
    --date $(date -d yesterday +%F) \
    --inputs raw/daily/$(date -d yesterday +%F).md
```

shell 时间运算 + 文件路径自己拼,框架不做特殊处理。

在 Claude Code 会话里手动跑则用 **Skill 模式**(默认,不需要 env 也不需要 API key):

```bash
node scripts/perch.mjs report --topic ai-radar --prompt morning
```

Skill 模式打 prompt 到 stdout,当前 Claude 会话接棒生成。

---

## v2 → v3 命令对照

| v2 | v3 |
|---|---|
| `perch analyze --slot evening` | `perch report --prompt evening` |
| `perch analyze --slot now` | (无直接等价)cron 自己根据时间选 prompt |
| `perch digest` | (合并回 evening prompt 的双产出) |
| `perch ingest` | `perch ingest`(行为等价,新增 `--out`) |
| `perch enrich` | `perch enrich`(不变) |
| `perch archive` | `perch archive`(不变) |
| `perch admin create` | `perch admin create`(spec.prompts 替代 spec.slots) |

---

## 状态

v3 主链路全部实现:Topic 配置容器 + 5 个角色 method + 通用 prompt runner:

- Adapter 层读 X redux store(长推全文、repost 链、metrics 自带)+ dedup 聚合
- Raw 每次写盘**全局时间重排**(非前插),吸收 pinned / source 晚到的旧推
- **Wiki 当日 1 份文件**,section 粒度走 `## section: <name>` 幂等 upsert,顺序由调用顺序决定
- **Summary 在 evening prompt 内同时输出**(双产出,一次 LLM 调用)
- Twitter Article 按需深抓 + 按月缓存 + 随 archive 归档
- Topic 脚手架(交互 / `--from-json`,都有 spec 校验;`prompts` 可省略 → `default`)
- **slot / window / 凌晨 wrap / canonical end / 独立 digest method 全部消失**

v3.1 新增:

- **LLM Direct 模式**(`lib/llm.mjs::runPromptWithTools`):脚本直连 Anthropic Messages API + agent loop(read_file / bash tools),让 cron / openclaw / 任意无 Claude Code 会话的 runner 都能驱动 report
- 两种模式(Skill / Direct)共享同一份 prompt 模板,行为同构
- Provider 抽象支持 stub(测试用)和 anthropic(默认)

未来会加的能力(详见 DESIGN §8):

- Topic Wiki 的 stale / rebuild
- 跨 topic 查询
- per-topic timezone、summaries 月度切分归档
