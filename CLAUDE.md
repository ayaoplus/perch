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

- **Fetch**(`lib/x-fetcher.mjs` / `x-adapter.mjs`)返回 DOM 顺序的原始 tweet + 数据完整性兜底(2-pass 稳定性 / 长推 hydrate / socialContext 识别)。不排序、不做时间窗、不识别 pinned
- **Business**(`scripts/collect.mjs` / `report.mjs` / `rotate.mjs` / `fetch-article.mjs` / `new-topic.mjs`)编排业务语义:跨源合并、ID 去重 + 聚合、**全局时间重排**(不是前插)、slot 映射 + 日期回退、窗口计算、按 topic 写盘
- **Tool**(`lib/normalize.mjs` / `topic.mjs` / `wiki.mjs` / `rotate.mjs` / `article-cache.mjs`)提供可组合原子

不要把业务语义倒回 Fetch 层。

## 新建 / 配置 topic

优先用 `node scripts/new-topic.mjs --from-json <spec>`(有校验、幂等)。`spec.slots` 可省略 → fallback `DEFAULT_SLOTS`。详细字段 / 常见坑见 `docs/TOPIC_AUTHORING.md`。

## 时段报告语义

- **wrap 统一规则**:触发时 hour < 对应 slot 的 `start_hour` → `date` 回退到昨天(`now` 凌晨 / 显式 slot 在该 slot 今天起点前触发都走这条)。`date`、raw、wiki 一起回退
- **endLabel**:归属日=昨天 → canonical end;归属日=今天 → `min(now, canonical)`。这同时杜绝反向窗口和未来窗口
- prompt 模板**不要硬编码小时数**,用 `{WINDOW_*}` 占位符,让 SCHEMA.slots.window 成为单一 source of truth

## 状态

v1 全链路已实现:collect / report / rotate / fetch-article / new-topic 五条管线闭环。两个 topic 在跑:ai-radar + crypto-radar。详见 `docs/DESIGN.md` §7。

v1 明确不做:Topic Wiki stale/rebuild、跨 topic 查询、Processor 插件化、SQLite 索引、`report` 的 cron 化、summaries 月度切分归档、跨昨日 raw 的 since_prev 首 slot、per-topic timezone、外链深抓。
