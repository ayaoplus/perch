# Perch — Agent Guide

## 项目定位

Perch 是一个**多 Topic 的互联网数据处理框架**。当前 v1 的首个落地方向是 X:围绕不同主题,从 X(List / 用户时间线)采集数据,经过清洗与 LLM 工作流后,产出 Daily Wiki、Topic Wiki 和后续衍生产物。

完整设计先看 `docs/DESIGN.md`。快速入口见 `README.md`。两者比本文件优先级更高。

## 当前仓库状态

v1 主链路全部已实现:

- `lib/` 是 Fetch + Tool 层:CDP 栈、X 抓取(含长推 hydrate + socialContext 识别)、normalize(dedup 聚合)、topic 加载、wiki 路径、article 缓存、rotate
- `scripts/` 是 Business 层入口:collect / report / rotate / fetch-article / new-topic + spike 脚本
- `templates/topics/<slug>/` 每个 topic 的 SCHEMA.md + 时段 prompt
- `config.json` 指定 default_topic / timezone / 各 topic 的 path 和 templates_dir
- `sources/` 和 `processors/` 是占位目录,v1 还没进入插件化

## 目录职责

- `CLAUDE.md`:项目协作规则与开发边界
- `AGENTS.md`:给自动化 agent 的仓库速览与执行约束
- `README.md`:面向人的快速入门
- `docs/DESIGN.md`:架构、概念、风险、规范
- `docs/TOPIC_AUTHORING.md`:创建和配置 topic 的详细指南(给人和 agent)
- `config.json`:默认 topic、topic 路径、rotate 配置
- `lib/`:Fetch 层(x-fetcher / CDP 栈 / x-adapter)+ Tool 层(normalize / topic / wiki / article-cache / rotate)
- `scripts/`:Business 层入口(collect / report / rotate / fetch-article / new-topic)+ review gate spike 脚本
- `sources/`:采集端定义或文档(v1 占位)
- `processors/`:产出端定义或文档(v1 占位)
- `templates/topics/<slug>/`:每个 topic 的 SCHEMA.md + 时段 prompt

## 新增 / 配置 topic 的推荐路径

Agent 如需新建 topic,**首选 `scripts/new-topic.mjs --from-json <spec>`**(非交互、有校验、不覆盖已有配置);`scaffoldTopic` / `validateTopicSpec` / `renderSchemaMd` / `renderSlotPrompt` 也可以直接 import。`spec.slots` 可省略,会 fallback 到 `lib/topic.mjs` 导出的 `DEFAULT_SLOTS`(和运行时 loadTopic 同一个 source of truth)。完整字段定义、端到端流程、常见坑见 `docs/TOPIC_AUTHORING.md`。不要手工拼 SCHEMA.md + config.json,容易漏校验。

## 跑 report 时的关键语义(agent 必读)

- **优先用 `report now`**,凌晨 wrap / 时区 / 归属日期 / window 全部自动解析
- **凌晨 wrap**:触发时 hour < `slots[0].start_hour` 时,slot 映射到**昨天最后一个 slot**,`{DATE}` / `{RAW_PATH}` / `{WIKI_PATH}` 全部同步指向昨天
- **显式 `report <slot>` 的 endLabel 是 canonical**(下一 slot 起点或归属日 23:59),不是当前时刻 — 避免"显式指定非当前时段"算出反向窗口
- **读 raw 时永远用 prompt 里的 `{DATE}` 占位符**,不要假设"今天"就是 CLI 触发那天(wrap 场景下 `{DATE}` 是昨天)
- **prompt 模板不要硬编码小时数**(如"过去 12h""完整 24h"),用 `{WINDOW_TYPE}` / `{WINDOW_START_LABEL}` / `{WINDOW_END_LABEL}` 占位符,让 SCHEMA.slots.window 成为单一 source of truth。参考 ai-radar 三份 prompt

## 工作原则

1. 动手前先读 `CLAUDE.md`、`docs/DESIGN.md`、`README.md`,再看相关目录现状。
2. 按 DESIGN §2.1 的 **Fetch / Business / Tool** 三层分工改代码:Fetch 层保持原样(不排序 / 不做时间窗 / 不过滤 pinned),业务语义(时间窗、pinned、跨次去重)只落在 Business 层,不要把这些逻辑倒回 Fetch 层。
3. 不要提前实现 v1 明确排除的能力(DESIGN §7):Topic Wiki stale / rebuild、跨 topic 查询、Processor 插件化、SQLite 索引、`report` 的 cron 化、summaries 月度切分归档。
4. 不为"未来扩展"过度抽象。同样的逻辑出现 3 次再抽象。

## 实现偏好

- 编辑前先读文件,理解现状,不要按想象补结构
- 不主动重构未被要求修改的部分
- 不添加多余注释,不过度工程化
- 命名要直接表达用途,变量作用域尽量小
- 发现修改可能破坏既有产出或数据结构时,先说明风险再继续

## 数据与架构边界

- Topic 是一等公民。切换领域时,通常是换整套 topic 配置,不是只换一个 URL
- 中间层固定:raw 格式、summaries 规范、frontmatter、月度 rotate
- 两端扩展:Source 可新增,Processor 可新增,但 v1 不急着做插件化
- Topic 数据目录由 `config.json` 的 `topics.<slug>.path` 指定,不写死 `~/your-data-dir`
- Topic Wiki 是长期资产,按设计不参与月度归档

## 提交规则

- 完成一个**可验证的修改单元**后,做一次原子 `git commit` 并 `git push`
- 以下情况先确认:
  - 涉及敏感文件,如 `.env`、secret、证书
  - 破坏性操作,如删历史、强制推送、schema 删字段
  - 多个不相关改动需要拆成多个提交

## 接下来关注的

v1 主链路全部实现(两个 topic 在跑:`ai-radar` + `crypto-radar`),当前重心:

1. 让两个 topic 的实际产出打磨到每天真用(收集反馈、调时段 prompt、检验归档 / wrap / 全局重排)
2. 稳定后,再考虑 v1 明确排除的能力(见 DESIGN §7):Topic Wiki rebuild、跨 topic 查询、Processor 插件化、`report` 的 cron / 直连 API、跨昨日 raw 的 since_prev 首 slot 支持、per-topic timezone
