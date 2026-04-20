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
| `slug` | 唯一标识。collect 写盘时会作为 `via: <slug>` 行落到每个 block 里,便于事后按 source 过滤 |
| `type` | `list` / `profile` |
| `target` | list 时为 list URL;profile 时为 handle(`elonmusk` / `@elonmusk`)或完整 profile URL |
| `label` | 人读备注,仅用于文档和日志 |
| `fetch_limit` | 每次 collect 从该 source 拉取的推文上限。见下节"采集策略" |

当前一个 X list,覆盖 AI 主流 KOL。未来可平行追加:独立 KOL 的 profile(`type: profile`)、行业研究机构的 list 等。

## 采集策略

- **跑频**:3~4 次/天(morning / noon / evening + 可选晚间补收),由 cron / 手动触发
- **fetch_limit**:建议 80 以上。DESIGN §2.1 已说明,generous limit 的作用是给 pinned / DOM 抖动 / 当日高频账号留余量,让下游 ID 去重兜底而不是让 limit 卡边界
- **去重**:tweet ID,`normalize.readExistingIds` 扫当日 raw 文件标题行(DESIGN §5)
- **时间排序**:写盘前 `normalize.sortTweetsByTime` 统一时间倒序(profile 路径 pinned 会被自然沉底)

## 清洗与报告约定

- **清洗规则**(v1 不做):Business 层当前直接落 raw,不筛内容。未来如需按关键词 / 账号黑名单过滤,在 collect 层加一层,不改 fetch
- **报告模板**:`morning.md` / `noon.md` / `evening.md`(同目录)— Step 3 实现时可能按新 raw 结构(含 `via:` 行)做 prompt 微调
- **摘要 prompt**:Step 3 设计,暂无
