# Perch — Agent Guide

## 项目定位

Perch 是一个**多 Topic 个人信息漏斗**:围绕不同主题,从 X(List / 用户时间线)采集数据,经过清洗与 LLM 工作流后,产出 Daily Wiki、Topic Wiki 和后续衍生产物。

完整设计先看 `DOCS/DESIGN.md`。任务拆解先看 `DOCS/TASKS.md`。两者比本文件优先级更高。

## 当前仓库状态

这是 **v1 骨架阶段** 的仓库,设计先行,实现尚未铺开:

- `lib/` 目前还是空壳,后续会 vendor `~/development/anyreach/` 的最小 CDP / X 抓取能力
- `sources/` 和 `processors/` 目前是占位目录,还没进入插件化实现
- `templates/topics/ai-radar/` 已放入早 / 午 / 晚三份报告模板
- `config.json` 已定义默认 topic `ai-radar` 及其数据目录

不要把设计文档里的未来能力误判成“仓库里已经实现”。

## 目录职责

- `CLAUDE.md`:项目协作规则与开发边界
- `AGENTS.md`:给自动化 agent 的仓库速览与执行约束
- `DOCS/DESIGN.md`:架构、概念、风险、路线图
- `DOCS/TASKS.md`:当前阶段可执行任务清单
- `config.json`:默认 topic、topic 路径、rotate 配置
- `lib/`:中间固定层。放 vendor 后的 CDP client、X fetcher、normalize、rotate 等共享代码
- `sources/`:采集端定义或文档。v1 主要是 `x-list` / `x-user`
- `processors/`:产出端定义或文档。v1 先围绕 report 能力
- `templates/topics/<topic>/`:topic 级 prompt / 模板

## 工作原则

1. 动手前先读 `CLAUDE.md`、`DOCS/DESIGN.md`、`DOCS/TASKS.md`，再看相关目录现状。
2. 优先遵循 `DOCS/TASKS.md` 的当前步骤。现阶段重点是 **Step 1 — Vendor CDP 瘦核 + X fetcher**。
3. 参考 / vendor 代码时,只读本地上游:
   - `~/development/anyreach/`
   - `~/development/ikiw/`
   - `~/development/ai-radar/`
   不要为这些内容再去网上找替代实现。
4. `~/development/ai-radar/` 是冻结的参考源,不是运行时代码。新开发全部落在当前仓库。
5. 不要提前实现 v1 明确排除的能力:Topic Wiki stale / rebuild、跨 topic 查询、Processor 插件化、SQLite 索引层。
6. 当前仓库代码量很少,先把最小链路跑通,不要为了“未来扩展”过度抽象。

## 实现偏好

- 编辑前先读文件,理解现状,不要按想象补结构
- 不主动重构未被要求修改的部分
- 不添加多余注释,不过度工程化
- 命名要直接表达用途,变量作用域尽量小
- 同类逻辑出现 3 次再抽象
- 发现修改可能破坏既有产出或数据结构时,先说明风险再继续

## 数据与架构边界

- Topic 是一等公民。切换领域时,通常是换整套 topic 配置,不是只换一个 URL
- 中间层固定:raw 格式、summaries 规范、frontmatter、月度 rotate
- 两端扩展:Source 可新增,Processor 可新增,但 v1 不急着做插件化
- Topic 数据目录不应写死为 `~/your-data-dir`。以 `config.json` 或 topic 配置为准
- Topic Wiki 是长期资产,按设计不参与月度归档

## 提交规则

- 完成一个**可验证的修改单元**后,做一次原子 `git commit` 并 `git push`
- 以下情况先确认:
  - 涉及敏感文件,如 `.env`、secret、证书
  - 破坏性操作,如删历史、强制推送、schema 删字段
  - 多个不相关改动需要拆成多个提交

## 当前优先级判断

如果没有额外指令,默认按下面顺序理解任务优先级:

1. 打通 `lib/` 里的 vendor CDP / X 抓取链路
2. 打通 `normalize` 和 raw 落盘
3. 迁移 `ai-radar` topic 配置并完成 `/perch collect`
4. 再做 Daily Wiki 生成与 rotate

不要跳过前面的采集链路,直接去做高层报告命令。
