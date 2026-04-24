---
name: perch
description:
  多 Topic 个人信息漏斗。从 X(List 或用户时间线)采集数据,按 Topic 生成 Daily/Topic Wiki 和各类衍生产出。
  触发场景:X 数据采集、每日/时段报告生成、管理多主题信息漏斗(AI / Web3 / ...)。
  v1 主链路已实现。完整设计见 docs/DESIGN.md,快速入门见 README.md。
---

# Perch

> 互联网数据处理框架。每个 Topic = 一组数据源 + 一套 LLM 工作流。

## ⚠️ 必读:设计规范

**完整架构、风险、v1 状态、术语全部在 `docs/DESIGN.md`。任何实现前请先读。**

## 当前状态

v1 主链路已实现:collect / report / rotate / fetch-article / new-topic / wiki-write。命令见下。

## 核心概念(3 个)

| 概念 | 含义 |
|---|---|
| **Topic** | 配置包 = source + 清洗规则 + 报告模板 + 摘要 prompt。每个 Topic 一个独立数据目录 |
| **Daily Wiki** | 归属日 1 份文件(`YYYY-MM-DD.md`),按 topic 配置的 slot(morning/noon/evening/...)分段为 `## slot: <name>`,每个 slot 重跑幂等替换自己那段;月末归档 |
| **Topic Wiki** | 跨日期累积,按需产出,带 frontmatter 可 stale → rebuild |

## 架构一图流

```
[Source 插件]  →  [中间层固定]  →  [Processor 插件]
     ↓                ↓                     ↓
  X List         Raw 格式              Daily Wiki
  X 用户时间线    summaries.md          Topic Wiki
                 月度 rotate            ...(可扩展)
                 Frontmatter 规范
```

中间固定(raw 格式、summaries、frontmatter、rotate),两头可扩展(新 source / 新 processor 平行加)。

代码内部按 **Fetch / Business / Tool** 三层分工,业务语义只落在 Business 层。详见 DESIGN §2.1。

## 命令

### v1 已实现

| 命令 | 底层脚本 | 工作模式 |
|---|---|---|
| `/perch collect [--topic <slug>] [--dry]` | `scripts/collect.mjs` | 纯自动化:抓 X → dedup + readExistingIds → sort → 写 raw |
| `/perch report [<slot>\|now] [--topic <slug>]` | `scripts/report.mjs` | **Skill 模式**(见下) |
| `/perch rotate [--dry-run] [--topic <slug>]` | `scripts/rotate.mjs` | 纯自动化:搬非当月 `raw/daily/*` 和 `wiki/daily/*` 到 `archive/YYYY-MM/` |
| `node scripts/fetch-article.mjs <status_url> [--topic <slug>]` | `scripts/fetch-article.mjs` | report 阶段 Claude 按需 Bash 调用:CDP 抓 Twitter Article → 缓存 `cache/articles/YYYY-MM/` |
| `node scripts/new-topic.mjs [--from-json <spec>]` | `scripts/new-topic.mjs` | 纯自动化:交互 / 非交互创建 topic(SCHEMA + prompt + config 注册) |
| `{WIKI_WRITE_CMD} << 'PERCH_EOF' ... PERCH_EOF` | `scripts/wiki-write.mjs` | report 阶段 Claude 管道调用:按 slot 对当日 wiki 做 section 级幂等 upsert |

### v1 明确不实现(DESIGN §7)

- `/perch wiki "主题"` — Topic Wiki stale / rebuild 机制
- `/perch query "..."` — 跨 topic 查询

### 为什么 report 走 Skill 模式(和 collect / rotate 不同)

`collect` 和 `rotate` 是**确定性任务**(纯 IO,不需要智能):脚本自己跑完即可,将来 cron 化无障碍。

`report` 需要 LLM 智能(slot 内的 Q1–Qn 判断都是内容分析),v1 走 **Skill 模式**:

1. `scripts/report.mjs` 读 topic 配置 + 对应时段的 prompt 模板
2. 把模板里的 `{RAW_PATH}` / `{WIKI_PATH}` / `{WIKI_WRITE_CMD}` / `{SUMMARIES_PATH}` / `{SOURCES}` / `{DATE}` / `{WINDOW_*}` 等占位符填实
3. 完整 prompt 打到 stdout
4. **当前 Claude 会话读到 stdout 后接棒**:读 raw → 按 prompt 生成 slot markdown → **用 `{WIKI_WRITE_CMD}` heredoc pipe 给 `wiki-write.mjs` 做 section 级 upsert**(evening 时额外把一条概览 append 到 `{SUMMARIES_PATH}`)

所以 `/perch report` 不直接产出 wiki,是"让 Claude 产出 wiki"。wiki-write.mjs 负责持久化(按 slot 幂等替换 + 其他 slot section 原样保留),Claude 只管生成内容。cron 自动化(无会话依赖、直接调 Anthropic API)留 v2。
