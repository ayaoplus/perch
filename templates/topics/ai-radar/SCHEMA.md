---
{
  "topic": "ai-radar",
  "description": "AI 博主每日选题漏斗",
  "sources": [
    {
      "slug": "ai-kol",
      "type": "list",
      "target": "https://x.com/i/lists/REPLACE_WITH_YOUR_LIST_ID",
      "label": "AI KOL 精选",
      "fetch_limit": 80
    }
  ]
}
---

# Topic: ai-radar

## 业务目标

采集 AI 圈子的精选推文,供 AI 博主每日选题参考。Step 3 的 morning / noon / evening 三份时段报告在这些 raw 上做摘要和选题分析。

## 数据源

见上方 frontmatter 的 `sources` 数组。每个 source 字段定义:

| 字段 | 含义 |
|---|---|
| `slug` | 唯一标识。ingest 写盘时会作为 `via: <slug>` 行落到每个 block,便于按 source 过滤 |
| `type` | `list` / `profile` |
| `target` | list 时为 list URL;profile 时为 handle(`elonmusk` / `@elonmusk`)或完整 profile URL |
| `label` | 人读备注,仅用于文档和日志 |
| `fetch_limit` | 每次 ingest 从该 source 拉取的推文上限。见下节"采集策略" |

## 采集策略

- **跑频**:3~4 次/天,由外部 cron / openclaw / agent 触发
- **fetch_limit**:建议 80。generous limit 给 pinned / DOM 抖动 / 当日高频账号留余量,让下游 ID 去重兜底
- **去重**:tweet ID,`readExistingIds` 扫当日 raw 文件标题行
- **时间排序**:写盘前 `sortTweetsByTime` 统一时间倒序

## Prompt 模板

同目录下的 `morning.md` / `noon.md` / `evening.md` 是三份 prompt,对应早午晚三类报告:

- **morning**:7 题简报 — 快速跟上节奏,不严格做时间过滤
- **noon**:4 题增量 — 只看 12:00 之后新冒出的内容
- **evening**:17 题深度 + 5-7 句日概览(双产出 → wiki + summary)

每份 prompt 文件名(去掉 `.md`)即 `perch report --prompt <name>` 的引用。新增形态(周报、专题分析)= 加一份 `.md`,不动框架。

## 调度

v3 框架不做调度。三份报告由外部 cron 触发,典型形式:

```bash
0 8  * * *  perch ingest --topic ai-radar && perch report --topic ai-radar --prompt morning
0 13 * * *  perch ingest --topic ai-radar && perch report --topic ai-radar --prompt noon
0 19 * * *  perch ingest --topic ai-radar && perch report --topic ai-radar --prompt evening
```
