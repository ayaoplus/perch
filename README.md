# Perch

> 多 Topic 个人信息漏斗 · 互联网数据处理框架

每个 Topic 是一组 **sources + LLM 工作流** 的配置包:从 X(List / 用户时间线)采集原始推文,清洗归一化,按时段产出 Daily Wiki,按月归档。换领域 = 换一份 Topic 配置,不改框架代码。

完整设计见 [`docs/DESIGN.md`](docs/DESIGN.md)。创建 topic 的详细指南(给人和 agent)见 [`docs/TOPIC_AUTHORING.md`](docs/TOPIC_AUTHORING.md)。

---

## 核心能力

| 能力 | 入口 | 说明 |
|---|---|---|
| **采集** | `scripts/collect.mjs` | 真实登录态 Chrome + CDP 读 X redux store → 跨源去重 + repost 聚合 → 按时间倒序写入当日 raw |
| **报告** | `scripts/report.mjs` | 时段 prompt 模板化(slot 数量/边界/覆盖窗口 topic 级自定义),由 Claude 会话接棒生成 Daily Wiki |
| **按需深抓** | `scripts/fetch-article.mjs` | Claude 在 report 阶段需要 Twitter Article 全文时 Bash 调用,CDP 抓取 + 按月缓存 |
| **归档** | `scripts/rotate.mjs` | 每月把非当月的 raw / wiki / article cache 搬到 `archive/YYYY-MM/`,幂等,支持 `--dry-run` |
| **新 topic 脚手架** | `scripts/new-topic.mjs` | 交互向导或 `--from-json` 非交互,一步生成 SCHEMA + 每 slot 的 prompt 骨架 + config 注册 |

---

## 架构速览

三层,业务语义只在 Business 层(详见 DESIGN §2.1):

```
Fetch  (lib/x-fetcher.mjs · lib/x-adapter.mjs)
    ↓  读 X redux store(长推全文 / repost / metrics 自带,无 DOM 爬虫)
Business (scripts/collect.mjs · report.mjs · rotate.mjs · fetch-article.mjs · new-topic.mjs)
    ↓  编排:跨源合并 · ID 去重 + repost 聚合 · 时间排序 · 窗口计算 · 按需深抓 · Topic 脚手架
Tool  (lib/normalize.mjs · topic.mjs · wiki.mjs · article-cache.mjs · rotate.mjs)
       formatTweet · dedupTweets · loadTopic · articleCachePath · ...
```

---

## 目录结构

```
perch/
├── config.json                 # 全局:default_topic / timezone / 各 topic 的 path+templates_dir
├── lib/                        # 运行时代码(Fetch + Tool 层)
├── scripts/                    # Business 层入口(collect / report / rotate + spike)
├── sources/ · processors/      # 插件化占位(v1 还没用到)
├── templates/topics/<slug>/    # 每个 topic 的 SCHEMA.md + 时段 prompt
└── docs/DESIGN.md              # 完整设计规范
```

Topic **数据**(raw / wiki / summaries / archive)住在 `config.json` 指定的 `path` 下(例如 iCloud 同步盘),不入 git;Topic **逻辑配置**(SCHEMA + prompt)住在 `templates/topics/<slug>/`,入 git。

---

## 运行前提

- Node.js ≥ 22(原生 fetch + WebSocket)
- 用户日常 Chrome 已开 `--remote-debugging-port=9222`(或 9229 / 9333),并登录 X
- 首次 clone 后:`cp config.example.json config.json`,再按实际情况改里面的数据目录 `path`(`config.json` 已被 gitignore,不会误入仓库)
- 对应的 `templates/topics/<slug>/SCHEMA.md` 存在且 frontmatter 合法(示例 topic `ai-radar` 的 X list ID 是占位符,记得替换成自己的)

没起 CDP Proxy 子进程时,`lib/browser-provider.mjs` 会自动 fork 一个,日志在 `/tmp/perch-proxy.log`。

---

## 常用命令

```bash
# 采集(自动化)
node scripts/collect.mjs --topic ai-radar                # 正式跑,写入当日 raw(全局按时间重排,非前插)
node scripts/collect.mjs --topic ai-radar --dry          # 看统计和前 3 条样本,不写盘
node scripts/collect.mjs --topic ai-radar --limit 20     # 临时覆盖所有 source 的 fetch_limit

# 报告(Skill 模式:脚本打印完整 prompt,当前 Claude 会话接棒生成并写 wiki)
node scripts/report.mjs now --topic ai-radar             # 推荐:自动选 slot + 凌晨 wrap 到昨天 + window 自动算
node scripts/report.mjs morning --topic ai-radar         # 显式指定(end 用 canonical,不受当前时刻影响)

# 按需深抓 Twitter Article(Claude 在 report 阶段需要时 Bash 调用)
node scripts/fetch-article.mjs https://x.com/author/status/NNN --topic ai-radar

# 月度归档(月末手跑,建议先 dry-run)
node scripts/rotate.mjs --topic ai-radar --dry-run
node scripts/rotate.mjs --topic ai-radar

# 新建一个 topic
node scripts/new-topic.mjs                               # 交互向导
node scripts/new-topic.mjs --from-json spec.json         # 非交互,agent 友好(slots 可省略 → DEFAULT_SLOTS)
node scripts/new-topic.mjs --help
```

**`report now` 的关键行为**(agent 必读):凌晨(hour < `slots[0].start_hour`)触发时,slot 自动映射到**昨天的最后一个 slot**,`{DATE}` / `{RAW_PATH}` / `{WIKI_PATH}` 同步指向昨天;`{WINDOW_END_LABEL}` 用归属日 `23:59`(看昨天整天)。详见 [`docs/TOPIC_AUTHORING.md §3.4`](docs/TOPIC_AUTHORING.md)。

---

## 状态

v1 已实现 collect / report / rotate / fetch-article / new-topic 五条主链路:

- Fetch 层读 X redux store(长推全文、repost 链、metrics 自带)+ dedup 聚合(纯 RT 合并、quote 完整保留)
- Slot 数量 / 边界 / 覆盖窗口全部 topic 级可配(`SCHEMA.slots`);`report now` 自带日期回退 + wrap;显式 slot 用 canonical end
- Raw 每次写盘**全局时间重排**(非前插),吸收 pinned / source 晚到的旧推
- Twitter Article 按需深抓 + 按月缓存 + 随 rotate 归档
- 新 topic 脚手架(交互 / `--from-json`,都有 spec 校验;`slots` 可省略自动 fallback `DEFAULT_SLOTS`)
- 仓库内置一个示例 topic:`ai-radar`(AI 博主选题漏斗),`templates/topics/ai-radar/SCHEMA.md` 里的 X list ID 是占位符,需替换成你自己的

未来会加的能力(详见 DESIGN §7 / §8):

- Topic Wiki 的 stale / rebuild
- 跨 topic 查询
- Processor 插件化(多形态产出)
- `report` 的 cron 化 / 直连 API(当前走 Claude Code Skill 模式)
- per-topic timezone、summaries 月度切分归档
