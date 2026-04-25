# Perch — Agent Guide (v2)

## 项目定位

Perch 是一个**多 Topic 的互联网数据处理框架**,Topic 一等公民。当前落地方向是 X:围绕不同主题,从 X(List / 用户时间线)采集数据,经过清洗与 LLM 工作流后产出 Daily Wiki 和日概览。

完整设计先看 `docs/DESIGN.md`。快速入口见 `README.md`。两者比本文件优先级更高。

## 当前仓库状态(v2)

按"信息生命周期"切六个角色,每个角色是 Topic 的一个 method。CLI 是薄 dispatcher:

- `lib/topic.mjs` — Topic class(static load/list/create + 6 个实例方法)
- `lib/{ingest,analyze,digest,enrich,archive,admin}.mjs` — 角色实现
- `lib/{normalize,wiki,article-cache}.mjs` — Tool 层(可组合原子)
- `lib/{x-fetcher,x-adapter,*cdp*}.mjs` — Adapter 层(和外部世界打交道)
- `scripts/perch.mjs` — 主 CLI(单入口,subcommand: ingest / analyze / digest / enrich / archive / admin)
- `scripts/{wiki-write,summary-write,fetch-article}.mjs` — Agent tools(prompt 内 Claude Bash 调用)
- `templates/topics/<slug>/` — 每个 topic 的 SCHEMA.md + 时段 prompt + (可选)digest.md
- `config.example.json` 是占位模板,`config.json`(本地、gitignore)指定 default_topic / timezone / 各 topic 的 path 和 templates_dir

## 目录职责

- `CLAUDE.md`:项目协作规则与开发边界
- `AGENTS.md`:给自动化 agent 的仓库速览与执行约束
- `README.md`:面向人的快速入门
- `SKILL.md`:Skill 元数据 + 命令表
- `docs/DESIGN.md`:架构、概念、风险、规范
- `docs/TOPIC_AUTHORING.md`:创建和配置 topic 的详细指南
- `lib/`:Adapter + Domain + Tool 三层
- `scripts/`:主 CLI + Agent tools + spike 调试 gate
- `templates/topics/<slug>/`:每个 topic 的逻辑配置(随仓库版本化)

## 新增 / 配置 topic 的推荐路径

Agent 如需新建 topic,**首选 `node scripts/perch.mjs admin create --from-json <spec>`**(非交互、有校验、不覆盖已有配置)。也可以直接 `import { Topic } from './lib/topic.mjs'` 调 `Topic.create(rootDir, spec)`。`spec.slots` 可省略,会 fallback 到 `lib/topic.mjs` 导出的 `DEFAULT_SLOTS`。完整字段定义、端到端流程、常见坑见 `docs/TOPIC_AUTHORING.md`。

不要手工拼 SCHEMA.md + config.json,容易漏校验。

## 跑 analyze 时的关键语义(agent 必读)

- **优先用 `analyze` 不带 `--slot`**(等价 `--slot now`),时区 / wrap / 归属日期 / window 全部自动解析
- **wrap 规则统一**(now 和显式 slot 共享):当触发 hour < 对应 slot 的 `start_hour` 时,`date` 自动回退到**昨天**,指向昨天那个 slot 实例。`now` 凌晨 wrap 到昨日末 slot 是这个规则的特例
- **endLabel 语义**:归属日是昨天时用 **canonical end**(下一 slot 起点 / 末 slot 23:59);归属日是今天时用 **`min(now, canonical)`**(slot 进行中到触发时刻,slot 已过 cap 在 canonical,不溢出到下一 slot)
- **永远不会出现反向窗口或未来窗口**
- **读 raw 时永远用 prompt 里的 `{DATE}` 占位符**,不要假设"今天"就是 CLI 触发那天(wrap 场景下 `{DATE}` 是昨天)
- **prompt 模板不要硬编码小时数**,用 `{WINDOW_*}` 占位符,让 SCHEMA.slots.window 成为单一 source of truth
- **wiki 写入必须走 `{WIKI_WRITE_CMD}` heredoc pipe**,不能 Write 工具直接覆盖 `{WIKI_PATH}` —— 当日 wiki 是共享文件,直接覆盖会抹掉其他 slot 的 section

## 跑 digest 的关键语义(v2 新增)

- digest 是**独立 method**,不再绑在 evening analyze 里
- 输入是当日 wiki(`{WIKI_PATH}`),输出是 5-7 句日概览,prepend 到 `summaries.md` 顶部
- 模板默认走通用 prompt;topic 可在 `templates/topics/<slug>/digest.md` 提供自定义模板
- 写入走 `{SUMMARY_WRITE_CMD}` heredoc pipe(同构 wiki-write)

## 工作原则

1. 动手前先读 `CLAUDE.md`、`docs/DESIGN.md`、`README.md`,再看相关目录现状
2. 按 DESIGN §2.2 的 **Adapter / Domain / Tool** 三层分工改代码:Adapter 层保持原样(不排序 / 不做时间窗 / 不过滤 pinned),业务语义只落在 Domain 层(角色模块)
3. 不要提前实现 v2 明确排除的能力(DESIGN §9):LLM Direct、schedule 自动驱动、Topic Wiki stale/rebuild、跨 topic 查询、summaries 月度切分归档
4. 不为"未来扩展"过度抽象。同样的逻辑出现 3 次再抽象

## 实现偏好

- 编辑前先读文件,理解现状,不要按想象补结构
- 不主动重构未被要求修改的部分
- 不添加多余注释,不过度工程化
- 命名要直接表达用途,变量作用域尽量小
- 发现修改可能破坏既有产出或数据结构时,先说明风险再继续

## 数据与架构边界

- Topic 是一等公民。切换领域时,通常是换整套 topic 配置,不是只换一个 URL
- 中间层固定:raw 格式、summaries 规范、月度 archive
- 两端扩展:Source 可新增,产出形态可新增(给 Topic 加 method),但 v2 不急着做插件化
- Topic 数据目录由 `config.json` 的 `topics.<slug>.path` 指定,不写死 `~/your-data-dir`
- Topic Wiki 是长期资产,按设计不参与月度归档

## 提交规则

- 完成一个**可验证的修改单元**后,做一次原子 `git commit` 并 `git push`
- 以下情况先确认:
  - 涉及敏感文件,如 `.env`、secret、证书
  - 破坏性操作,如删历史、强制推送、schema 删字段
  - 多个不相关改动需要拆成多个提交

## v1 → v2 迁移说明

v2 重构了角色切分(详见 DESIGN §2.1)。命令对照见 README / SKILL.md。关键变化:

| v1 概念 | v2 概念 |
|---|---|
| 6 个独立脚本(collect/report/rotate/fetch-article/new-topic/wiki-write) | 1 个统一 CLI + Topic methods |
| Fetch / Business / Tool 三层 | Adapter / Domain / Tool 三层(更准确) |
| evening prompt 附带 summaries 产出 | digest 独立 method,显式触发 |
| `loadTopic` 函数返回 plain object | `Topic.load` 返回 Topic 实例(实例字段保持兼容) |
