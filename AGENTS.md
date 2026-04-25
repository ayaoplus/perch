# Perch — Agent Guide (v3)

## 项目定位

Perch 是一个**多 Topic 的互联网数据处理框架**。Topic 是配置容器,prompt 模板是数据,**调度交给外部**。当前落地方向是 X:从 X(List / 用户时间线)采集数据,经过 LLM 工作流后产出 Daily Wiki 和日概览。

完整设计先看 `docs/DESIGN.md`。快速入口见 `README.md`。两者比本文件优先级更高。

## 当前仓库状态(v3.1)

5 个角色,Topic 配置容器:

- `lib/topic.mjs` — Topic class(static load/list/create + 5 个实例方法)
- `lib/{ingest,report,enrich,archive,admin}.mjs` — 角色实现
- `lib/llm.mjs` — **v3.1 新增**:Direct 模式 agent loop + Anthropic Messages API + read_file/bash tools + stub provider
- `lib/{normalize,wiki,article-cache}.mjs` — Tool 层
- `lib/{x-fetcher,x-adapter,*cdp*}.mjs` — Adapter 层
- `scripts/perch.mjs` — 主 CLI(单入口,subcommand: ingest / report / enrich / archive / admin;`--llm` 选 skill/direct)
- `scripts/{wiki-write,summary-write,fetch-article}.mjs` — Agent tools(被 Skill 模式的 Claude 或 Direct 模式的 LLM bash tool 调用,行为同构)
- `templates/topics/<slug>/` — 每个 topic 的 SCHEMA.md + 任意多份 `<name>.md` prompt
- `config.example.json` 是占位模板,`config.json`(本地、gitignore)指定 default_topic / timezone / 各 topic 的 path 和 templates_dir

## 目录职责

- `CLAUDE.md`:项目协作规则与开发边界
- `AGENTS.md`:给自动化 agent 的仓库速览
- `README.md`:面向人的快速入门
- `SKILL.md`:Skill 元数据 + 命令表
- `docs/DESIGN.md`:架构、概念、风险、规范
- `docs/TOPIC_AUTHORING.md`:创建和配置 topic 的详细指南
- `lib/`:Adapter + Domain + Tool 三层
- `scripts/`:主 CLI + Agent tools + spike 调试 gate
- `templates/topics/<slug>/`:每个 topic 的逻辑配置(随仓库版本化)

## 新增 / 配置 topic 的推荐路径

Agent 如需新建 topic,**首选 `node scripts/perch.mjs admin create --from-json <spec>`**(非交互、有校验、不覆盖已有配置)。也可以直接 `import { Topic } from './lib/topic.mjs'` 调 `Topic.create(rootDir, spec)`。

`spec.prompts` 是字符串数组,列出要生成的 prompt 名;省略时默认 `["default"]`。

完整字段定义 / 常见坑见 `docs/TOPIC_AUTHORING.md`。**不要**手工拼 SCHEMA.md + config.json,容易漏校验。

## 跑 report 时的关键语义

- **`--prompt <name>`** 对应 `templates/topics/<slug>/<name>.md`,文件名(去 `.md`)即标识
- **`--section <name>`** 缺省 = `--prompt`,决定 wiki section 名
- **`--inputs <paths>`** 缺省 = today raw 单文件;comma-separated 支持多文件
- **`--date YYYY-MM-DD`** 缺省 = today,决定 `{DATE}` + wiki 写哪天
- **`--llm skill|direct`** 缺省 = skill;Direct 模式需要 `ANTHROPIC_API_KEY` env(适合 cron / openclaw)
- **凌晨补跑昨天** = cron 命令显式传 `--date $(date -d yesterday +%F)` 和 `--inputs <昨天 raw>`,框架不做自动 wrap
- **prompt 模板里时间过滤**:模板自己写,如 noon 模板里硬编码 "只看 {DATE} 12:00 之后"
- **wiki 写入必须走 `{WIKI_WRITE_CMD}` heredoc pipe**,不能 Write 工具直接覆盖 `{WIKI_PATH}` —— 当日 wiki 是共享文件,直接覆盖会抹掉其他 section
- **summaries 写入**(evening 类双产出):走 `{SUMMARY_WRITE_CMD}` heredoc pipe

## LLM 模式(v3.1)

| 模式 | 触发 | 适用场景 |
|---|---|---|
| Skill(默认) | Claude Code 会话内,`--llm skill` 或缺省 | 手动跑、调 prompt、debug |
| Direct | `--llm direct` 或 `PERCH_LLM_MODE=direct` env | cron / openclaw / 无会话 runner |

Direct 模式 env:
- `PERCH_LLM_PROVIDER`(`anthropic`(默认) / `openai` / `stub`)
- Provider key:`ANTHROPIC_API_KEY` 或 `OPENAI_API_KEY`(后者可配 `PERCH_LLM_BASE_URL` 指 OpenRouter / Together / 本地 vLLM 等)
- `PERCH_LLM_MODEL` / `PERCH_LLM_MAX_TOKENS`
- `PERCH_LLM_MAX_RETRIES` / `PERCH_LLM_INITIAL_BACKOFF_MS`(429/5xx/网络抖动 retry)
- `PERCH_LLM_DEBUG=1`

两种模式 prompt 模板**完全共享**。Direct 模式的 agent loop 给 LLM 暴露 `read_file` / `bash` 工具,行为同构 Claude Code 会话。

## 工作原则

1. 动手前先读 `CLAUDE.md`、`docs/DESIGN.md`、`README.md`,再看相关目录现状
2. 按 DESIGN §2.3 的 **Adapter / Domain / Tool** 三层分工改代码:Adapter 层保持原样(不排序 / 不做时间窗 / 不过滤 pinned),业务语义只落在 Domain 层
3. 不要提前实现 v3 明确排除的能力(DESIGN §8):LLM Direct、schedule 自动驱动、Topic Wiki stale/rebuild、跨 topic 查询
4. 不为"未来扩展"过度抽象。同样的逻辑出现 3 次再抽象

## 实现偏好

- 编辑前先读文件,理解现状,不要按想象补结构
- 不主动重构未被要求修改的部分
- 不添加多余注释,不过度工程化
- 命名要直接表达用途,变量作用域尽量小
- 发现修改可能破坏既有产出或数据结构时,先说明风险再继续

## 数据与架构边界

- Topic 是配置容器(不是行为驱动者)
- 中间层固定:raw 格式、summaries 规范、月度 archive
- Prompt 是数据,新增形态报告 = 加一份 `.md` 文件
- Topic 数据目录由 `config.json` 的 `topics.<slug>.path` 指定,不写死路径
- Topic Wiki 是长期资产,按设计不参与月度归档

## 提交规则

- 完成一个**可验证的修改单元**后,做一次原子 `git commit` 并 `git push`
- 以下情况先确认:
  - 涉及敏感文件(.env / secret / 证书)
  - 破坏性操作(删历史、强制推送、schema 删字段)
  - 多个不相关改动需要拆成多个提交

## v2 → v3 迁移说明

v3 把"调度"职责从框架剥出去,slot / window / wrap 等抽象消失:

| v2 概念 | v3 形态 |
|---|---|
| `topic.analyze(slot)` + `topic.digest()` | `topic.report(promptName)`(单一通用 method) |
| SCHEMA.slots(name + start_hour + window) | SCHEMA 不再有 slots;prompt 文件即标识 |
| `{WINDOW_*}` prompt 占位符 | 删除;prompt 自己写时间过滤 |
| `--slot <name>` | `--prompt <name>` + `--section <name>` |
| 凌晨 wrap 自动 | cron 命令显式传 `--date` + `--inputs` |
| evening prompt 附带 digest 任务,但 v2 拆出去了 | evening prompt 双产出(wiki + summary,一次 LLM 调用) |
