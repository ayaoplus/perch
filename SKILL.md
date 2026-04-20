---
name: perch
description:
  多 Topic 个人信息漏斗。从 X(List 或用户时间线)采集数据,按 Topic 生成 Daily/Topic Wiki 和各类衍生产出。
  触发场景:X 数据采集、每日/时段报告生成、跨 Topic 查询、管理多主题信息漏斗(AI / Web3 / ...)。
  v1 开发中。命令规划与完整设计见 docs/DESIGN.md,开发任务见 docs/TASKS.md。
---

# Perch

> 基于 ikiw 思想的互联网数据处理框架。每个 Topic = 一组数据源 + 一套 LLM 工作流。

## ⚠️ 必读:设计规范

**完整架构、风险、路线图、术语全部在 `docs/DESIGN.md`。任何实现前请先读。开发任务拆解见 `docs/TASKS.md`。**

## 当前状态:v1 骨架阶段

- **已完成**:项目骨架 + ai-radar 作为首个 Topic 迁入 + 3 个报告模板保留
- **下一步**:路线图 Step 1 — Vendor CDP 瘦核(源:`~/development/anyreach/`)

## 核心概念(3 个)

| 概念 | 含义 |
|---|---|
| **Topic** | 配置包 = source + 清洗规则 + 报告模板 + 摘要 prompt。每个 Topic 一个独立数据库目录 |
| **Daily Wiki** | 时段自动产出(morning/noon/evening),一次性,用完归档 |
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

## 相关本地资产

| 路径 | 用途 |
|---|---|
| `~/development/anyreach/` | CDP 核心 + X adapter 源头,vendor 用 |
| `~/development/ikiw/` | 思想同源的知识库框架,prompt 可 copy |
| `~/development/ai-radar/` | 前身项目,本项目继承其 templates 和 collect.mjs 的稳定函数 |

## 命令(规划中,v1 逐步实现)

- `/perch collect [--topic <name>]` — 采集 Topic 数据
- `/perch report [morning|noon|evening|now] [--topic <name>]` — 生成时段 Daily Wiki
- `/perch wiki "主题" [--topic <name>]` — 生成 Topic Wiki
- `/perch rotate [--dry-run] [--topic <name>]` — 月度归档
- `/perch query "问题" [--topic <name> | --all]` — 跨 Topic 查询
