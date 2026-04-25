---
name: perch
description:
  多 Topic 个人信息漏斗(v2 · Topic 一等公民)。从 X(List 或用户时间线)采集数据,
  按 Topic method(ingest / analyze / digest / archive / enrich / admin)产出
  Daily Wiki + 日概览 + 月度归档。触发场景:X 数据采集、时段报告生成、管理多主题信息漏斗。
  完整设计见 docs/DESIGN.md,快速入门见 README.md。
---

# Perch

> 互联网数据处理框架。每个 Topic 是一等对象,封装一组数据源 + 一套信息加工流水线。

## ⚠️ 必读

**完整架构、风险、术语全部在 `docs/DESIGN.md`。任何实现前请先读。**

## 当前状态(v2)

按"信息生命周期"切角色,Topic 升为一等公民。所有领域操作都是 `topic.<method>()`,CLI 是薄 dispatcher。

## 核心概念

| 概念 | 含义 |
|---|---|
| **Topic** | 一等对象,封装数据源 + 时段配置 + 模板。所有操作都是它的 method |
| **角色** | Ingest / Analyze / Digest / Enrich / Archive / Admin —— 信息生命周期的六个阶段 |
| **Daily Wiki** | 归属日 1 份文件,按 `## slot: <name>` 分段;analyze 维护 |
| **Summaries** | 当月日概览索引,`## YYYY-MM-DD` 时间倒序;digest 维护(v2 新独立 method) |

## 角色与命令

所有命令统一入口 `scripts/perch.mjs`:

| 命令 | 角色 | 工作模式 |
|---|---|---|
| `/perch ingest [--topic <slug>] [--dry] [--limit N]` | Ingest | 纯自动化:抓 X → 跨源去重 → 全局时间重排 → 写 raw |
| `/perch analyze [--topic <slug>] [--slot <name>\|now] [--date YYYY-MM-DD]` | Analyze | **Skill 模式**(渲染 prompt → Claude 接棒) |
| `/perch digest [--topic <slug>] [--date YYYY-MM-DD]` | Digest | **Skill 模式**(独立 method,v2 新增) |
| `/perch enrich [--topic <slug>] --url <status_url>` | Enrich | 纯自动化:CDP 抓 Twitter Article → 月度缓存 |
| `/perch archive [--topic <slug>] [--dry-run]` | Archive | 纯自动化:非当月 raw / wiki / cache → archive/YYYY-MM/ |
| `/perch admin list` / `/perch admin create [--from-json spec.json]` | Admin | 纯自动化:Topic 配置 CRUD |

Agent tools(prompt 内 Claude Bash 调用,不是用户主入口):

| 工具 | 调用时机 |
|---|---|
| `scripts/wiki-write.mjs` | analyze 阶段 Claude 生成完 slot markdown 后 pipe 调用 |
| `scripts/summary-write.mjs` | digest 阶段 Claude 生成完日概览后 pipe 调用 |
| `scripts/fetch-article.mjs` | analyze 阶段 Claude 按需深抓 article(Topic.enrich 的 thin wrapper) |

## v1 → v2 命令对照

| v1 | v2 | 备注 |
|---|---|---|
| `node scripts/collect.mjs` | `node scripts/perch.mjs ingest` | 行为等价 |
| `node scripts/report.mjs <slot>` | `node scripts/perch.mjs analyze --slot <slot>` | prompt 不再附带 digest 任务 |
| `node scripts/rotate.mjs` | `node scripts/perch.mjs archive` | 行为等价 |
| `node scripts/fetch-article.mjs <url>` | `node scripts/perch.mjs enrich --url <url>` | 同时保留 fetch-article.mjs 作为 prompt 内 agent tool |
| `node scripts/new-topic.mjs --from-json` | `node scripts/perch.mjs admin create --from-json` | 行为等价 |
| (无,evening prompt 附带产出) | `node scripts/perch.mjs digest` | **独立 method**,需显式调用 |

## v2 不实现(留 v2.x / 不做)

- LLM Direct 模式(脚本直连 Anthropic API,留 `lib/llm.mjs::complete()` 接口)
- Schedule 自动驱动(SCHEMA `schedule` 字段位置已留)
- Topic Wiki stale / rebuild
- 跨 topic 查询
- summaries 月度切分归档

## 为什么 analyze / digest 走 Skill 模式

`ingest` / `archive` / `enrich` / `admin` 是确定性任务,脚本自己跑完即可。

`analyze` / `digest` 需要 LLM 智能,v2 第一版走 **Skill 模式**:
1. perch.mjs → topic.analyze(slot) → 渲染 prompt → 打 stdout
2. **当前 Claude 会话读到 stdout 后接棒**:读 raw → 生成 markdown → 用 `wiki-write.mjs` heredoc pipe upsert
3. digest 同构,只是 pipe 给 `summary-write.mjs`

cron / openclaw / 任何无会话 runner 要驱动这一步,要等 v2.x 的 LLM Direct 模式落地。
