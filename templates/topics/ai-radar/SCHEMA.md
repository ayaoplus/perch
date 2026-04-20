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
  ],
  "slots": [
    { "name": "morning", "start_hour": 5, "window": "today" },
    { "name": "noon", "start_hour": 12, "window": "today" },
    { "name": "evening", "start_hour": 18, "window": "today" }
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

## 时段槽位(slots)

frontmatter 的 `slots` 数组定义该 topic 的**时段节奏**(Topic 级配置)。每条:

| 字段 | 含义 |
|---|---|
| `name` | 槽位名,必须满足 `^[a-z][a-z0-9-]*$`,不得为保留字 `now`。会被用作 `{SLOT}` 占位符值、wiki 文件名后缀、模板文件名 |
| `start_hour` | 整数 0-23,该槽位起始小时(topic.timezone);下一槽位的 start_hour 是其结束小时。最后一槽环绕次日首槽 |
| `window` | 可选,`"today"`(默认)或 `"since_prev"`。报告的时间覆盖窗口 |

**window 语义**:
- `"today"` — 每个 slot 覆盖"今日 00:00 → 当前时刻",后段报告是"今日全貌"的逐步完善(适合"今天讨论最多"这种统计型问题)
- `"since_prev"` — 只覆盖"上一 slot 的 start_hour → 当前时刻"(适合"这段时间新冒出什么"的增量视角)。首个 slot 自动 fallback 为 today,避免跨昨日 raw 的复杂度

报告脚本会以 `{WINDOW_TYPE}` / `{WINDOW_START_LABEL}` / `{WINDOW_END_LABEL}` 占位符把窗口传给时段 prompt,由 Claude 自行按 raw block 的时间戳过滤。

`report.mjs now` 按当前时间映射到对应槽位;`hour < 最小 start_hour` 时(如凌晨 3 点)视为"上一轮最后一个槽位"。

每个 `name` 对应同目录下一个 `<name>.md` prompt 模板,缺失会报错。

缺省 `slots` 字段时 fallback 到三槽:morning@5 / noon@12 / evening@18(window=today,保持 v1 旧行为)。

## 清洗与报告约定

- **清洗规则**(v1 不做):Business 层当前直接落 raw,不筛内容。未来如需按关键词 / 账号黑名单过滤,在 collect 层加一层,不改 fetch
- **报告模板**:每个 `slots[].name` 对应同目录下一个 `.md` 模板(默认 `morning.md` / `noon.md` / `evening.md`)
- **摘要 prompt**:随时段模板各自演化
