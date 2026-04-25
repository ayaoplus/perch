---
name: perch
description:
  多 Topic 个人信息漏斗(v3 · Topic + Prompt 模板)。从 X(List 或用户时间线)采集
  数据,按 prompt 模板产出报告 + 概览。**调度由外部决定**(cron / openclaw / agent /
  手动),框架只管"采集 → 文件 → LLM 处理 → 文件"。
  完整设计见 docs/DESIGN.md,快速入门见 README.md。
---

# Perch

> 互联网数据处理框架。每个 Topic = 一组数据源 + 任意多份 prompt 模板。

## ⚠️ 必读

**完整架构、风险、术语全部在 `docs/DESIGN.md`。任何实现前请先读。**

## 当前状态(v3)

v3 退化成纯工具集:框架不做调度,prompt 是数据。slot / window / 凌晨 wrap 这些抽象
**全部消失**。

## 核心概念

| 概念 | 含义 |
|---|---|
| **Topic** | 配置容器(sources + prompts + 数据目录),通过 method 触发行为 |
| **Prompt 模板** | `templates/topics/<slug>/<name>.md`,任意数量、任意命名 |
| **Section** | wiki 内部 `## section: <name>` 分段;名字由 `--section` 决定 |
| **Daily Wiki** | 归属日 1 份文件,按 section 分段;report 维护 |
| **Summaries** | 当月日概览(`## YYYY-MM-DD`),时间倒序 prepend |

## 角色与命令

所有命令统一入口 `scripts/perch.mjs`:

| 命令 | 角色 | 工作模式 |
|---|---|---|
| `/perch ingest [--topic <slug>] [--out path] [--dry] [--limit N]` | Ingest | 纯自动化:抓 X → 跨源去重 → 全局重排 → 写 raw |
| `/perch report --topic <slug> --prompt <name> [--llm skill\|direct] [--inputs paths] [--date YYYY-MM-DD] [--section <name>]` | Report | **Skill** 或 **Direct** 模式(见下) |
| `/perch enrich [--topic <slug>] --url <status_url>` | Enrich | 纯自动化:CDP 抓 Twitter Article → 月度缓存 |
| `/perch archive [--topic <slug>] [--dry-run]` | Archive | 纯自动化:非当月 raw / wiki / cache → archive/YYYY-MM/ |
| `/perch admin list` / `/perch admin create [--from-json spec.json]` | Admin | 纯自动化:Topic 配置 CRUD |

### Report 的两种 LLM 模式

| 模式 | 触发 | 适用场景 |
|---|---|---|
| **Skill**(默认) | `--llm skill` 或缺省 | 在 Claude Code 会话里跑;脚本打 prompt → 当前会话接棒 |
| **Direct** | `--llm direct` 或 `PERCH_LLM_MODE=direct` | cron / openclaw / 任意无会话 runner;脚本直连 Anthropic Messages API + agent loop |

Direct 模式 env:
- `ANTHROPIC_API_KEY`(必需)
- `PERCH_LLM_MODEL`(默认 `claude-sonnet-4-5`)
- `PERCH_LLM_MAX_TOKENS`(默认 16384)
- `PERCH_LLM_DEBUG=1`(打印 API request/response 简要,排错用)
- `PERCH_LLM_PROVIDER=stub`(测试用,跳过真实 API)

**两种模式共享同一份 prompt 模板** —— Direct 模式的 agent loop 给 LLM 暴露 `read_file` / `bash` 工具,行为和 Claude Code 会话同构。

Agent tools(prompt 内 Claude Bash 调用):

| 工具 | 调用时机 |
|---|---|
| `scripts/wiki-write.mjs` | report 阶段 Claude 生成完 markdown 后 pipe(`--section <name>`) |
| `scripts/summary-write.mjs` | evening 类 prompt 生成完日概览后 pipe |
| `scripts/fetch-article.mjs` | report 阶段 Claude 按需深抓 article |

## 默认值约定

- `--topic` 缺省 → `config.json` 的 `default_topic`
- `--inputs` 缺省 → today raw 单文件(`raw/daily/$(today).md`)
- `--date` 缺省 → today(topic.timezone)
- `--section` 缺省 → 与 `--prompt` 同名

调度典型形态(cron + Direct 模式):

```bash
# /etc/cron.d/perch (示例)
ANTHROPIC_API_KEY=sk-ant-...
PERCH_LLM_MODE=direct
0 8  * * *  cd /path/to/perch && node scripts/perch.mjs ingest --topic ai-radar && node scripts/perch.mjs report --topic ai-radar --prompt morning
0 13 * * *  cd /path/to/perch && node scripts/perch.mjs ingest --topic ai-radar && node scripts/perch.mjs report --topic ai-radar --prompt noon
0 19 * * *  cd /path/to/perch && node scripts/perch.mjs ingest --topic ai-radar && node scripts/perch.mjs report --topic ai-radar --prompt evening
```

Skill 模式(Claude Code 内手动跑)不需要 env:`perch report --topic ai-radar --prompt morning` 即可。

凌晨补跑昨天:`perch report ... --date $(date -d yesterday +%F) --inputs raw/daily/$(date -d yesterday +%F).md`,shell 一行,框架不做特殊处理。

## v2 → v3 命令对照

| v2 | v3 | 备注 |
|---|---|---|
| `perch analyze --slot evening` | `perch report --prompt evening` | Slot 概念消失,prompt 是数据 |
| `perch analyze --slot now` | (无直接等价) | cron 自己根据时间选 prompt |
| `perch digest` | (合并回 evening prompt 的双产出) | 一次 LLM 调用同时输出 wiki + summary |
| 其他 | 行为等价 |

## v3 不实现

- Schedule 自动驱动(v3 哲学就是不做调度;Direct 模式 + cron / openclaw 已覆盖)
- Topic Wiki stale / rebuild
- 跨 topic 查询
- summaries 月度切分归档

## Skill 模式 vs Direct 模式

`ingest` / `archive` / `enrich` / `admin` 是确定性任务,脚本自己跑完即可。`report` 需要 LLM 智能,有两条路径:

**Skill 模式**(在 Claude Code 会话里):
1. perch.mjs → topic.report(promptName) → 渲染 prompt → 打 stdout
2. **当前 Claude 会话读到 stdout 后接棒**:读 inputs → 生成 markdown → 用 `wiki-write.mjs` heredoc pipe(必要时再 `summary-write.mjs`)

**Direct 模式**(cron / openclaw / 无会话 runner):
1. perch.mjs → topic.report(promptName, { llm: 'direct' }) → 渲染 prompt
2. `lib/llm.mjs::runPromptWithTools` 直连 Anthropic Messages API,带 `read_file` / `bash` tool
3. Agent loop:LLM 请求 tool_use → 本地执行 → 回灌 → 直到 stop_reason ≠ 'tool_use'

两种模式 prompt 模板 100% 共享,行为同构。
