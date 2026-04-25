# Perch — Project Guidelines (v2)

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

## v2 架构原则

按 DESIGN §2 的两个正交维度:

### 角色维度(信息生命周期)

| 角色 | 实现 | 职责 |
|---|---|---|
| **Ingest** | `lib/ingest.mjs` | 外部 source → 当日 raw |
| **Analyze** | `lib/analyze.mjs` | raw + slot 窗口 → wiki section(LLM 介入) |
| **Digest** | `lib/digest.mjs` | 当日 wiki → summaries 条目(LLM 介入) |
| **Enrich** | `lib/enrich.mjs` | 单点深抓 article → 月度缓存 |
| **Archive** | `lib/archive.mjs` | 月度归档 |
| **Admin** | `lib/admin.mjs` | Topic 配置 CRUD |

新需求(周报、跨 topic 查询)是给 Topic 加 method,不是新增"命令"。角色清单是收敛的。

### 实现层维度

| 层 | 位置 | 做什么 |
|---|---|---|
| **Adapter** | `lib/x-fetcher.mjs` · `lib/x-adapter.mjs` | 和外部世界打交道:CDP / X redux store |
| **Domain** | `lib/topic.mjs`(Topic class)+ 6 个角色模块 | 领域逻辑;接收 Topic 实例完成生命周期一步 |
| **Tool** | `lib/normalize.mjs` · `lib/wiki.mjs` · `lib/article-cache.mjs` | 可组合原子(format / dedup / 路径辅助 / idempotent upsert) |

CLI(`scripts/perch.mjs`)在 Domain 之上,只做 subcommand 路由,**不含业务语义**。

不要把业务语义倒回 Adapter 层(Fetch 不排序、不做时间窗、不识别 pinned)。

## 新建 / 配置 topic

优先用 `node scripts/perch.mjs admin create --from-json <spec>`(有校验、幂等)。`spec.slots` 可省略 → fallback `DEFAULT_SLOTS`。详细字段 / 常见坑见 `docs/TOPIC_AUTHORING.md`。

## Analyze / Digest 语义

- **wrap 统一规则**:触发时 hour < 对应 slot 的 `start_hour` → `date` 回退到昨天(`now` 凌晨 / 显式 slot 在该 slot 今天起点前触发都走这条)。`date`、raw、wiki 一起回退
- **endLabel**:归属日=昨天 → canonical end;归属日=今天 → `min(now, canonical)`。同时杜绝反向窗口和未来窗口
- prompt 模板**不要硬编码小时数**,用 `{WINDOW_*}` 占位符
- **wiki 写入**:当日 wiki 是 1 份共享文件,slot 粒度走 `## slot: <name>` section 幂等 upsert。Claude 必须用 `{WIKI_WRITE_CMD}` heredoc pipe 写,**不要**用 Write 工具直接覆盖 `{WIKI_PATH}`(会抹掉其他 slot 的 section)
- **summaries 写入**(digest 独立产出):同理走 `{SUMMARY_WRITE_CMD}` heredoc pipe,不要 Write 直接覆盖 `{SUMMARIES_PATH}`

## v2 状态

主链路全部实现:`perch ingest / analyze / digest / enrich / archive / admin`。Topic 升为一等对象。仓库内置示例 topic(`ai-radar`),SCHEMA 里的 X list ID 是占位符。详见 `docs/DESIGN.md` §9。

v2 明确不做:LLM Direct 模式(留接口)、schedule 自动驱动、Topic Wiki stale/rebuild、跨 topic 查询、summaries 月度切分归档、per-topic timezone、外链深抓。
