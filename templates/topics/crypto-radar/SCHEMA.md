---
{
  "topic": "crypto-radar",
  "description": "币圈交易",
  "sources": [
    {
      "slug": "general-trading",
      "type": "list",
      "target": "https://x.com/i/lists/REPLACE_WITH_YOUR_LIST_ID",
      "label": "综合交易",
      "fetch_limit": 80
    },
    {
      "slug": "secondary-traders",
      "type": "list",
      "target": "https://x.com/i/lists/REPLACE_WITH_YOUR_LIST_ID",
      "label": "币圈二级交易员",
      "fetch_limit": 80
    },
    {
      "slug": "research",
      "type": "list",
      "target": "https://x.com/i/lists/REPLACE_WITH_YOUR_LIST_ID",
      "label": "币圈投研",
      "fetch_limit": 80
    },
    {
      "slug": "alpha-hunt",
      "type": "list",
      "target": "https://x.com/i/lists/REPLACE_WITH_YOUR_LIST_ID",
      "label": "alpha机会挖掘",
      "fetch_limit": 80
    }
  ],
  "slots": [
    {
      "name": "early",
      "start_hour": 6,
      "window": "today"
    },
    {
      "name": "morning",
      "start_hour": 10,
      "window": "today"
    },
    {
      "name": "afternoon",
      "start_hour": 14,
      "window": "today"
    },
    {
      "name": "evening",
      "start_hour": 19,
      "window": "today"
    }
  ]
}
---

# Topic: crypto-radar

## 业务目标

(在这里写清楚该 topic 的信息漏斗目标:你要用这些数据回答什么问题 / 产出什么形态。)

## 数据源

见 frontmatter 的 `sources` 数组。字段含义:

| 字段 | 含义 |
|---|---|
| `slug` | 本 topic 内唯一。collect 写盘时作为 `via: <slug>` 行落到每个 block,便于按源过滤 |
| `type` | `list` / `profile` |
| `target` | list 时为 list URL;profile 时为 handle(`elonmusk` / `@elonmusk`)或完整 profile URL |
| `label` | 人读备注,仅用于文档和日志 |
| `fetch_limit` | 每次 collect 拉取上限(1-200),建议 80。详见 DESIGN §2.1 的 generous limit 哲学 |

## 时段槽位

见 frontmatter 的 `slots` 数组。每条:

| 字段 | 含义 |
|---|---|
| `name` | 槽位名;对应同目录 `<name>.md` prompt 模板 |
| `start_hour` | 0-23 整数,该槽位起始小时 |
| `window` | `today` / `since_prev`,报告覆盖窗口 |

## 清洗与报告

- **清洗规则**:Business 层当前直接落 raw。如需按关键词/账号黑名单过滤,在 collect 层加一层,不改 fetch
- **报告模板**:每个 slot 对应一份 `<slot>.md`,用占位符模板化
- **摘要 prompt**:根据该 topic 的具体问题演化
