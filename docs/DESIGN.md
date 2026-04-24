# Perch — 设计规范

> 多 Topic 个人信息漏斗 · 互联网数据处理框架

---

## 1. 项目定位

**一句话**:多 Topic 的个人信息漏斗。每个 Topic = 一组数据源 + 一套 LLM 工作流(采集 → 清洗 → 摘要 → 分析报告),本地 Markdown 落地,可扩展。

**核心价值(护城河)**:

1. **X 能抓**(登录态真实 Chrome + CDP 瘦核,不靠官方 API)
2. **LLM 工作流**(时段报告 / 选题分析 / 主题蒸馏)

这两件事组合起来,市面上没有现成工具能替代。

**明确不做**:

- 不做 RSS(市面有 miniflux/NetNewsWire,别重造轮子)
- 不做长期归档知识库(perch 是"信息漏斗",不是 wiki 本身)
- 不做通用平台抓取(只做 X,专注登录态 + 时段报告这对组合)

---

## 2. 核心架构

```
[Source 插件]     [中间层固定]         [Processor 插件]
     ↓                 ↓                      ↓
  X List          Raw 格式              Daily Wiki
  X 用户时间线     summaries.md          Topic Wiki
                  月度 rotate            Distill / Visual Card / ...
                  Frontmatter 规范       (未来扩展)
                  stale / rebuild
```

**设计哲学**:中间固定,两头可扩展。

- **中间固定**(所有 Topic 共用):raw 格式、summaries 规范、frontmatter、归档生命周期、rotate 脚本
- **两头扩展**:Source 端平行加新数据源,Processor 端平行加新产出形态

### 2.1 运行时分层:Fetch / Business / Tool

除了上述"插件化"维度,代码内部还按三层组织职责,**业务语义(pinned、时间窗、跨次去重)只落在 Business 层**:

| 层 | 位置 | 做什么 | **不**做什么 |
|---|---|---|---|
| **Fetch** | `lib/x-fetcher.mjs` · `lib/x-adapter.mjs` | 打开 X 页面后从其内部 redux store 直接读 timeline(`state.urt.<timelineKey>` + `state.entities.tweets/users`),原样输出每条 tweet(含长推全文 + `socialContext` repost 信息) | 不排序、不做时间窗过滤、不识别 pinned、不爬 DOM |
| **Business** | `scripts/collect.mjs` · `scripts/report.mjs` · `scripts/rotate.mjs` · `scripts/fetch-article.mjs` · `scripts/new-topic.mjs` | 编排业务流:generous limit + 跨次去重 + **existing+new block 全局时间重排**(非前插) · slot 映射 + 日期回退 + 窗口计算 · 月度归档 · 按需 article 深抓 · topic 脚手架 | 不直接碰 CDP / 页面 DOM |
| **Tool** | `lib/normalize.mjs` · `lib/topic.mjs` · `lib/wiki.mjs` · `lib/rotate.mjs` · `lib/article-cache.mjs` | 可组合原子:`formatTweet` / `dedupTweets`(聚合 `__via` + `repostedBy`)/ `sortTweetsByTime` / `readExistingIds` / `splitRawBlocks` + `mergeBlocksByTimeDesc`(raw 全局重排)/ `loadTopic` + `DEFAULT_SLOTS` / 路径辅助 / article 缓存读写 | 不做业务流编排 |

**为什么这么分**:实证例子是 profile 页面的 pinned tweet。`fetchXProfile(.., {limit:5})` 顶部可能是钉着的老推文,"顺序错"只是表象,**本质是 pinned 挤占一个位置导致最老应收推文漏采**。如果修法是"在 Fetch 层默认按时间排 + 过滤 pinned",就把业务语义污染到底层 API,将来"想保留 pinned"或"想要原序"的场景就得反向 opt-out。反过来保持 Fetch 干净,业务层按场景自行组合,扩展性和可测试性都更好。

**为什么走 redux store 而不是 DOM**:X 的 SPA 进入 list/profile 页面时先通过内部 GraphQL(如 `ListLatestTweetsTimeline` / `UserTweets`)一次性拿回 80+ 条数据塞进 redux,虚拟列表只 mount 其中可见的 7-10 条到 DOM。以 DOM 为数据源等于强行把"完整数据"从"只渲染一屏"的 UI 里反推回来,要跟 IntersectionObserver 懒加载、Chrome tab throttle、React unmount 轮转斗,既不完整也不稳定(实测 limit=80 往往只拿 4-40 条)。直接读 redux store 拿到的是 X 自己已经解出的 API response,含长推全文(`note_tweet` 已合并进 `full_text`)、repost 链(`retweeted_status` / `user`)、精确 metrics、views,全都 idempotent,不受 tab 焦点 / 虚拟列表影响。2-pass stabilize、hydrate truncated、DOM selector 漂移这些原本 Fetch 层的"兜底 robustness"一锅全免。

**真实业务场景(collect 管线)**:

```
fetchXList/Profile(generous limit,例如 80~200)          # 每个 source 独立拉
  → (Fetch 内) 读 X redux store 的 timeline + 实体          # 自带长推全文 + repost + metrics,单次取
  → normalize.dedupTweets                                 # 跨 source 合并 + 聚合 __via / repostedBy
  → readExistingIds 对比当日 raw 文件,过滤已存在          # 跨次去重
  → formatTweet 渲染每条新 tweet 为 block 字符串
  → splitRawBlocks 拆旧文件;mergeBlocksByTimeDesc 合并新+旧   # **全局**按 MM-DD HH:MM 倒序重排
  → 整体重写 raw 文件(保持"全局时间倒序"不变量)
```

预期跑频 3~4 次/天(多 topic 可并行排期,见 §3.1)。**不需要显式"时间窗 / lastRunTime"状态** — ID 去重(`readExistingIds` + `dedupTweets`)已完全覆盖去重需求,`fetch_limit` 的 generous 取值自然限定了"只看最近一批"。generous limit 的真正作用是**给 pinned / 当日高频账号留余量**,让下游 ID 去重兜底而不是让 limit 卡边界。

**为什么是"整体重写"而不是"前插新 block"**:当某个 source 这一轮才抓到一条较旧的 tweet(pinned 挤占、list 成员刚把旧推文顶上来、不同 source 晚一轮才出现),简单前插会让它出现在文件最顶部,破坏"全局时间倒序"这一消费侧依赖的不变量。整体按 `MM-DD HH:MM` 重排的开销对单日 raw(典型几百条 block、<200KB)可忽略,而稳定性收益明显。collect 运行时也提供 `--limit N` CLI 覆盖所有 source 的 `fetch_limit`,用于手动 smoke-test 或 rate-sensitive 场景。

---

## 3. 核心概念

### 3.1 Topic(一等公民)

一个 Topic = 一组 **source + 时段槽位(slots) + 清洗规则 + 报告模板 + 摘要 prompt** 的配置包。

**"换领域"= 换整个配置包**,不是换一个 URL 那么简单。这是 day 1 就要锁定的抽象。

每个 Topic 独立目录、独立生命周期、独立归档。

**时段槽位(slots)是 Topic 级配置**:在 SCHEMA.md 的 frontmatter 里用 `slots: [{name, start_hour, window}]` 定义。不同 Topic 可以有不同数量、不同边界、不同报告窗口的时段(如新闻类早高峰 4 槽 today、市场类晚高峰 3 槽 since_prev)。缺省时 fallback 到 `morning@5 / noon@12 / evening@18 / window=today` 保持向后兼容。每个 slot name 对应同目录的 `<name>.md` 模板文件。

**Slot 的 window 字段**(默认 `today`)决定该 slot 报告的时间覆盖:

- `today` — 从今日 00:00 到 endLabel,累积视角(适合"今天讨论最多的 X"这类统计型问题)
- `since_prev` — 从上一 slot 的 start_hour 到 endLabel,增量视角(适合"这段时间新出什么"类问题);首个 slot 自动 fallback 为 today,避免跨昨日 raw 的复杂度

window 不影响 raw 物理结构(仍是一日一文件),只通过 `{WINDOW_*}` 占位符注入到 prompt,让 Claude 自行按 `MM-DD HH:MM` 时间戳过滤 block。

**slot 映射 + 日期回退**(`report.mjs` 的 `resolveSlotAndDate`,`now` 和显式指定共用一条路径):

| slotArg | 触发时刻条件(hour 在 topic.timezone) | 映射 slot | 归属日期 `date` |
|---|---|---|---|
| `now` | hour ≥ `slots[0].start_hour` | `pickSlot(hour)` | **今天** |
| `now` | hour < `slots[0].start_hour` | **最后一个 slot**(凌晨 wrap) | **昨天** |
| `<显式>` | hour ≥ `slotDef.start_hour` | 显式 slot | **今天**(该 slot 进行中 / 已过) |
| `<显式>` | hour < `slotDef.start_hour` | 显式 slot | **昨天**(今天实例还没开始,看昨天那个) |

**关键不变量**:`date`、`rawDailyPath(date)`、`wikiDailyPath(date)`、窗口起止都由这个统一的 `date` 决定,**不会出现 date 不一致的错位组合**。wiki 当日一份,slot 粒度走 `## slot: <name>` section upsert(见 §3.2)。

**endLabel 语义**(`computeWindow` 里两种模式统一):

| 归属日 | endLabel |
|---|---|
| 昨天(wrap / 显式回退) | **canonical end**:下一 slot 的 `start_hour:00`,最后一个 slot 用归属日 `23:59` |
| 今天 | **`min(now, canonical end)`**:slot 进行中取 `now`(到触发时刻),slot 已过取 canonical(不越界到下一 slot) |

**两个同时杜绝的 bug**:
- **反向窗口**(start > end):显式 `report noon` 在凌晨 01:07 曾算出 `05:00 → 01:07`。现 date 回退到昨天,end=昨天 canonical,start<end ✓
- **未来窗口**(end > now 且数据还没发生):`report morning` 在 00:xx 曾算出今天 `00:00 → 12:00` 全未来。现 date 回退到昨天,端点都落在昨天内 ✓

**Topic 脚手架**:`scripts/new-topic.mjs` 提供两种创建方式:交互向导(人用)和 `--from-json`(agent 用)。后者还暴露了 `scaffoldTopic` / `validateTopicSpec` / `renderSchemaMd` / `renderSlotPrompt` 四个可 import 的纯函数。`spec.slots` 省略时会 fallback 到 `DEFAULT_SLOTS`(从 `lib/topic.mjs` 导出的单一 source of truth),与运行时 `loadTopic` 的 fallback 行为对齐。详见 `docs/TOPIC_AUTHORING.md`。

### 3.2 两种 Wiki

| 类型 | 路径 | 触发方式 | 特征 |
|---|---|---|---|
| **Daily Wiki** | `wiki/daily/YYYY-MM-DD.md` | 时段自动(morning/noon/evening 等) | 当日单份,按 `## slot: <name>` 分段,start_hour 升序排列;slot 级幂等 upsert(同 slot 重跑替换自己那段);用完归档 |
| **Topic Wiki** | `wiki/topic/{topic-slug}.md` | 按需,跨日期累积 | 带 frontmatter,可 stale → rebuild |

Daily 为主,Topic 为辅(看需要才建)。两者都是独立能力,框架层都支持。

Daily wiki 的写入不走 Claude 直接 Write,而是 Claude 生成自己那段 markdown 后 Bash 管道给 `scripts/wiki-write.mjs` 做 section 级 upsert(`lib/wiki.mjs::upsertWikiSlotSection`)。设计收益:Claude 只负责生成内容,文件结构(section 锚点 / 排序 / 幂等)由脚本 deterministic 保证,避免让 LLM 复刻其他 slot 的 section 这种易错任务。

### 3.3 月度切分(精简哲学)

**原则**:永远不维护大数据库。按时间切,只管当月。

- 活跃库 = 只当月
- 每月 1 号 rotate 上月 `raw/daily` + `wiki/daily` + `cache/articles/上月/` 到 `archive/YYYY-MM/`
- **Topic Wiki 不归档**(长期资产,跨月保留)
- **summaries.md 当前不归档**(v1 简化,按月切分较复杂,留 v2)
- 跨月查询:归档视为只读库(按需读 `archive/YYYY-MM/`,不重建索引)

**为什么不是"当月+上月"**:双月窗口在月初会膨胀到近 60 天,波动大、无必要。单月最干净。

**为什么 article cache 按月切(而不是扁平按 statusId)**:按月切让 rotate 能无脑整目录 rename,生命周期与 raw/wiki 严格对齐。代价:同一篇 article 跨月被引用会重抓一次。article 不是高频重复项,重抓成本可控。若数据表明同一文章跨月重复是高频,再升级为扁平 + 全局扫描。

---

## 4. 目录结构

### 4.1 Skill 本体(代码 + 插件)

```
~/.claude/skills/perch/
├── SKILL.md
├── README.md                   # 面向人的快速入门
├── CLAUDE.md                   # 项目协作规则
├── AGENTS.md                   # 自动化 agent 速览
├── config.json                 # 全局配置(默认 topic、归档策略、timezone)
├── lib/                        # Fetch + Tool 层
│   ├── browser-provider.mjs    # Chrome + CDP Proxy 生命周期(user / managed 双模式)
│   ├── cdp-proxy.mjs           # HTTP-over-CDP bridge,独立子进程
│   ├── proxy-client.mjs        # CDP Proxy 的 HTTP 客户端(newTab/eval/click/...)
│   ├── _utils.mjs              # adapter 共享小工具(sleep / downloadFile)
│   ├── x-adapter.mjs           # X list/profile 从 redux store 读取;status/longform 走 DOM(单推详情页)
│   ├── x-fetcher.mjs           # CDP 栈生命周期 + adapter 调用,对外暴露 fetchXList / fetchXProfile
│   ├── normalize.mjs           # tweet 对象 → raw markdown block + 去重 / 排序 / 聚合
│   ├── topic.mjs               # Topic 配置加载(读 config.json + SCHEMA.md frontmatter)
│   ├── wiki.mjs                # Wiki / summaries 路径与写入辅助(含幂等 upsert)
│   ├── article-cache.mjs       # Twitter Article 按月缓存的路径 + 读写原子
│   └── rotate.mjs              # 月度归档工具(含 article cache)
├── scripts/                    # Business 层入口 + review gate spike
│   ├── collect.mjs             # /perch collect 入口
│   ├── report.mjs              # /perch report 入口(Skill 模式,打印完整 prompt 给 Claude)
│   ├── rotate.mjs              # /perch rotate 入口
│   ├── fetch-article.mjs       # 按需深抓 Twitter Article(Claude 会话里 Bash 调用)
│   ├── new-topic.mjs           # 新 topic 脚手架(交互向导 + --from-json)
│   ├── spike-list.mjs          # list 抓取 review gate
│   └── spike-profile.mjs       # profile 抓取 review gate
├── sources/                    # 采集插件(可扩展端之一,v1 占位)
│   ├── x-list.md
│   └── x-user.md
├── processors/                 # 产出插件(可扩展端之二,v1 占位)
│   ├── report.md
│   ├── visual-card.md
│   └── distill.md
├── templates/topics/<slug>/    # 每个 topic 的逻辑配置(随 perch 仓库版本化)
│   ├── SCHEMA.md               # JSON frontmatter 定义 sources + slots;正文是人读说明
│   ├── morning.md              # 每个 slot.name 一份同名 prompt 模板
│   ├── noon.md                 # (默认三槽示例;slot 数量/名字由 SCHEMA.slots 决定)
│   └── evening.md
└── docs/
    ├── DESIGN.md               # 本文件
    └── TOPIC_AUTHORING.md      # 人 / agent 创建 topic 的详细指南
```

### 4.2 Topic 数据目录(纯运行时产物)

```
<topic-path>/                   # 由 config.json 的 topics.<slug>.path 指定
├── raw/
│   └── daily/YYYY-MM-DD.md     # 当月原始采集
├── summaries.md                # 当月日概览(按 `## YYYY-MM-DD` 时间倒序追加,evening report 维护)
├── wiki/
│   ├── daily/YYYY-MM-DD.md     # 当日所有 slot 合并成 1 份,按 `## slot: <name>` 分段,start_hour 升序
│   └── topic/                  # 主题 wiki(带 frontmatter)
├── cache/
│   └── articles/YYYY-MM/       # 按月累积的 Twitter Article 深抓缓存
│       └── <statusId>.md       #   frontmatter(title/author/fetched_at/...) + markdown 正文
└── archive/
    └── YYYY-MM/                # 上月归档:raw/daily + wiki/daily + cache/articles/
```

**说明**:
- Topic 数据目录**只装运行时产物**(raw / wiki / summaries / cache / archive),不入 git。路径由 config.json 指定,可以放在 iCloud / Obsidian 等同步盘
- Topic 的**逻辑配置**(SCHEMA、prompt 模板)不在这里,而是在 §4.1 的 `templates/topics/<slug>/` 下,随 perch 仓库版本化。**分离的理由**:逻辑配置要 review / diff / 回滚,数据不需要;让数据目录保持纯粹也便于 rotate 归档
- `cache/articles/` 由 `scripts/fetch-article.mjs` 按需写入(Claude 在 report 阶段判断需要正文时 Bash 调用),同月内按 statusId 复用,月末 rotate 跟 raw/wiki 一起搬走

---

## 5. Raw 格式

每个 Topic 的 `raw/daily/YYYY-MM-DD.md` 是当日所有 source 合并的事实原始库。核心约定:

- **一天一个文件**,**全局时间倒序**(最新在上,不变量)
- **每次 collect 整体重排**,不是"新 block 前插"。一旦某个 source 这一轮才抓到一条旧 tweet(pinned 挤占 / list 成员刚顶上来 / source 晚一轮才出现),全局重排能把它放到时间上正确的位置,不破坏倒序不变量
- **多 source 合并**:同 Topic 下配置的多个 source(多 list / 多 profile)写进同一天文件,block 内用 `via: slug1, slug2` 标注来源(多 source 看到同一推文时聚合成一行)
- **去重粒度 = tweet ID**,只扫每个 block 标题行的 `/status/(\d+)`(避免把 quote/link 行里的 ID 误算为顶层已存在)
- **长推完整性**:X redux store 里的 tweet 实体已经把 `note_tweet` 合并进 `full_text`,Fetch 层直接拿到全文;raw 的 `type:` 行带 `hydrated` 标志表示"正文完整,非截断版"
- **转发信号聚合**:
  - **纯 RT**(无评论)在 X 里 statusId 就是原推的 ID,多人 RT 同一条会被 dedup 合到一个 block,`🔁 reposted by: @A, @B` 列出所有转发者
  - **Quote tweet**(带评论)是独立 statusId,保留多个 block,通过 `🔗 quote: ... [url]` 里指向同一原推 URL 的关联让消费侧(Claude)识别"多人引用同一原推"
- **外链不抓**:卡片只存 `🔗 link: <url>`,不展开外站
- **Twitter Article 不预抓**:只有 `🖼️ article: "title"` 预览。report 阶段按需走 `scripts/fetch-article.mjs`
- **block 格式**:
  ```
  ## @handle (Name) · MM-DD HH:MM · [source](url)
  type: tweet · hydrated             (hydrated 恒显示在有完整正文的条目上)
  via: slug1, slug2                  (多 source 时出现,值来自 SCHEMA.sources[].slug)
  🔁 reposted by: @A, @B              (仅当有人纯 RT 了这条时出现)

  推文完整正文

  📊 N RT · N 💬 · N ❤️ · Nx views
  🖼️ images · video · article: "title"   (可选,有媒体才出现)
  🔗 quote: @handle — 完整 quote 正文 [url]  (可选,有引用才出现;不再 140 字截断)
  🔗 link: <external-url>            (可选,有外链卡片才出现)

  ---
  ```
  Name 可缺省;MM-DD 防跨日/跨时区边界歧义

**为什么是"先日期后合并"而不是"每 source 一个目录"**:消费侧(Daily Wiki / summaries / 时段报告)天然是"今天这个 Topic 发生了什么"的跨 source 视角,文件布局与消费模式同构;若单 source 要独立产出(独立 wiki / 独立 prompt),正确的升级路径是**拆成新 Topic**(Topic 是一等公民),而不是在 raw 层预支独立目录

---

## 6. 风险清单(已识别)

### R1. X 内部状态结构随版本漂移

Timeline(list / profile)现在读 X 的 redux store(`state.urt.<timelineKey>` + `state.entities.tweets.entities` + `state.entities.users.entities`)。X 若重构内部状态形状(改 timeline key 前缀、调 entity normalize schema、移字段位置),Fetch 层会看到空 timeline 或缺字段。status 单推详情页、Twitter Article 深抓仍走 DOM selector,DOM 改版会影响它们。

**缓解**:
- store 字段用多路径 fallback(`full_text → text`、`rest_id → id_str`、`extended_entities.media → entities.media`),不硬依赖单路径
- timeline key 用前缀匹配 + `includes(listId)` 兜底,不锁死完整 key 名
- `scripts/spike-list.mjs` / `spike-profile.mjs` 作可重放 gate,改版后立刻暴露断裂

### R2. 零配置是幻觉

"给一个数据源就能分析"只是**采集入口**的简化。每个新 Topic 至少要配 **4 样**:

- 数据源(list / 用户列表)
- 清洗规则(什么算噪音)
- 报告模板(要问哪些问题)
- 摘要 prompt(AI 风格 vs Web3 风格完全不同)

**缓解**:接受"新 topic 上线 = 2-3 小时配置"这个现实。SCHEMA.md 模板化降低配置成本。

### R3. Web3 场景挑战远大于 AI

- AI list:观点 + 链接 + 数据,清洗规则好写
- Web3 list:meme 图 + $TICKER + 黑话 + pump 信号,清洗规则和价值判定都模糊

**缓解**:先把 AI topic 打磨到自己每天真用,再挑 Web3。不并行起步。

### R4. 月度 rotate 的数据完整性

cron 失败、重入错乱、归档漏文件 = 丢数据。

**缓解**:rotate 脚本必须**幂等 + `--dry-run`**。手动跑若干次验证后才上 cron。

---

## 7. v1 实现状态

| 步 | 任务 | 状态 |
|---|---|---|
| 1 | CDP 瘦核 + X fetcher(list + profile) | ✅ 完成 |
| 2 | Skill 骨架 + config + Topic SCHEMA + collect 端到端 | ✅ 完成 |
| 3 | Daily Wiki 生成(多 slot 自定义,window today/since_prev) | ✅ 完成(Skill 模式,cron 化留 v2) |
| 4 | 月度 rotate 脚本(`--dry-run` + 幂等,含 article cache) | ✅ 完成(真月末归档留 live gate) |
| 5 | Fetch 层从 DOM 爬虫迁到 X redux store 读取(长推 / repost / metrics 自带) | ✅ 完成 |
| 6 | 按需 Twitter Article 深抓 + 按月缓存 | ✅ 完成(`scripts/fetch-article.mjs`) |
| 7 | 新 topic 脚手架(交互向导 + `--from-json`) | ✅ 完成(`scripts/new-topic.mjs`) |
| 8 | `report now` wrap 时 date/raw/wiki/window 一致性 + 显式 slot canonical end | ✅ 完成(消除反向时间窗 / 错位 raw) |
| 9 | collect 全局时间重排(非前插) | ✅ 完成(`splitRawBlocks` + `mergeBlocksByTimeDesc`) |
| 10 | 加第二个 topic 验证配置化 | ✅ 完成(本地双 topic 跑通,仓库只保留 `ai-radar` 示例) |

### v1 明确不做

- Topic Wiki 的 rebuild / stale 机制
- 跨 topic 查询
- Processor 插件化(第一版 report 一种)
- SQLite 索引层(v2 视查询需求再加)
- `/perch report` 的 cron 化 / 直连 API(当前走 Claude Code Skill 模式)
- `summaries.md` 的月度切分归档(rotate 只动 raw/daily + wiki/daily + cache/articles,v2 再补 summaries 切分)
- 外链(非 twitter article)深抓
- per-topic timezone(当前全局时区)
- **跨昨日 raw 的 since_prev 首 slot 支持**:当前首 slot 配 since_prev 会 fallback 到 today;想让 morning 真正覆盖昨晚 overnight 得在凌晨 first_slot.start_hour 之前跑 `report now`(会 wrap 到昨日末 slot,归属日完整 24h)。v2 再考虑跨日语义

---

## 8. 开放问题(TBD)

- **Topic 间共享 KOL 观测**:同一账号出现在多 list 时,是否 cross-reference?
- **历史 wiki 在 prompt 迭代后是否自动 rebuild**:v1 手动触发,待场景明朗再考虑自动化
- **SQLite 索引层什么时候加**:触发条件 = 跨月查询 / 按关键词查 / 按 metrics 排序 真的成为日常需求时
- **report 何时上 cron / 直连 API**:v1 Skill 模式依赖当前 Claude 会话,自动化是 v2 的事

---

## 9. 附录:术语表

| 术语             | 含义                                                               |
| -------------- | ---------------------------------------------------------------- |
| **Topic**      | 一个配置包(source + 清洗 + 模板 + 摘要 prompt),对应一个独立数据目录                   |
| **Source**     | Topic 的数据输入端,插件化。当前支持 `x-list` / `x-user`                        |
| **Processor**  | Topic 的数据产出端,插件化。当前支持 `report`(后续扩展 `distill` / `visual-card` 等) |
| **Daily Wiki** | 时段触发的一次性报告,日期+slot 绑定                                            |
| **Topic Wiki** | 按需生成的跨日期主题报告,带 frontmatter 可 rebuild                             |
| **Raw**        | 归一化后的原始推文 markdown 文件,一天一个                                       |
| **Summaries**  | 当月推文的日概览索引,LLM 一次读完用于定位相关推文                                      |
| **Rotate**     | 月度归档操作,把非当月 raw/wiki 移到 `archive/YYYY-MM/`                       |
| **Skill 模式**   | `/perch report` 的工作方式:脚本准备好 prompt,当前 Claude 会话接棒生成              |
