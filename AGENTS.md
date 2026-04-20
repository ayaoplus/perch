# Perch — Agent Guide

## 项目定位

Perch 是一个**多 Topic 的互联网数据处理框架**。当前 v1 的首个落地方向是 X:围绕不同主题,从 X(List / 用户时间线)采集数据,经过清洗与 LLM 工作流后,产出 Daily Wiki、Topic Wiki 和后续衍生产物。

完整设计先看 `docs/DESIGN.md`。快速入口见 `README.md`。两者比本文件优先级更高。

## 当前仓库状态

v1 主链路(collect / report / rotate)已实现:

- `lib/` 是 Fetch + Tool 层:CDP 栈、X 抓取、normalize、topic 加载、wiki 路径、rotate
- `scripts/` 是 Business 层入口:collect / report / rotate + spike 脚本
- `templates/topics/<slug>/` 每个 topic 的 SCHEMA.md + 时段 prompt
- `config.json` 指定 default_topic / timezone / 各 topic 的 path 和 templates_dir
- `sources/` 和 `processors/` 是占位目录,v1 还没进入插件化

## 目录职责

- `CLAUDE.md`:项目协作规则与开发边界
- `AGENTS.md`:给自动化 agent 的仓库速览与执行约束
- `README.md`:面向人的快速入门
- `docs/DESIGN.md`:架构、概念、风险、规范
- `config.json`:默认 topic、topic 路径、rotate 配置
- `lib/`:Fetch 层(x-fetcher / CDP 栈 / x-adapter)+ Tool 层(normalize / topic / wiki / rotate)
- `scripts/`:Business 层入口(collect / report / rotate)+ review gate spike 脚本
- `sources/`:采集端定义或文档(v1 占位)
- `processors/`:产出端定义或文档(v1 占位)
- `templates/topics/<slug>/`:每个 topic 的 SCHEMA.md + 时段 prompt

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

v1 主链路已实现,当前重心:

1. 让首个 topic(当前是 `ai-radar`)的实际产出打磨到每天真用(收集反馈、调时段 prompt、检验归档)
2. 稳定后,加**第二个 topic**(预期是 Web3)验证配置化真的 work — 换一份 SCHEMA 就能跑
3. 上述跑稳定后,再考虑 v1 明确排除的能力(见 DESIGN §7)
