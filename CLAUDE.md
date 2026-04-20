# Perch — Project Guidelines

## 项目定位

多 Topic 个人信息漏斗 · 互联网数据处理框架。**完整设计见 `docs/DESIGN.md`,任何实现前必读;快速入门见 `README.md`。**

## 提交规则(原子提交)

- **完成一个可验证的修改单元后,自动做一次 `git commit + git push`,不逐次询问**
- "提交" = commit + push 到远端,**只 commit 不算完成**
- 仅在以下情况先确认:
  - 涉及敏感文件(.env / secret / 证书)
  - 破坏性操作(删历史、强制推送、schema 删字段)
  - 多个不相关改动需要拆分成多个 commit

## 编码习惯

- 编辑代码前**先读文件**,理解现有逻辑再动手
- 不主动重构未被要求修改的代码
- 不添加多余注释,不过度工程化
- 发现可能破坏现有功能的修改,先提醒再执行
- 函数名 / 变量名要一眼看明白用途,变量作用域越小越好
- 同样的逻辑出现 3 次才抽象

## 架构原则

按 DESIGN §2.1 的 **Fetch / Business / Tool** 三层分工改代码:

- **Fetch**(`lib/x-fetcher.mjs`)返回 DOM 顺序的原始 tweet。不排序、不做时间窗、不识别 pinned。内部 2-pass 稳定性只吸收 lazy-DOM 抖动,不是业务语义
- **Business**(`scripts/collect.mjs` / `report.mjs` / `rotate.mjs`)编排业务语义:跨源合并、ID 去重、时间排序、按 topic 写盘
- **Tool**(`lib/normalize.mjs` / `topic.mjs` / `wiki.mjs` / `rotate.mjs`)提供可组合原子

不要把业务语义倒回 Fetch 层。

## 状态

v1 主链路已实现:collect / report / rotate 三条管线闭环。详见 `docs/DESIGN.md` §7。

v1 明确不做:Topic Wiki stale/rebuild、跨 topic 查询、Processor 插件化、SQLite 索引、`report` 的 cron 化、summaries 月度切分归档。
