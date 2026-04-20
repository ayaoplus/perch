# Perch — 开发任务清单

> DESIGN.md §8 路线图的可执行版本。分层拆解:近期细,远期粗,跑到哪里再展开。
>
> **用法**:一边开发一边勾选。`★` 标注的是 **review gate** — 完成后主动拉 review 再推进下一条。

---

## Step 1 — Vendor CDP 瘦核 + X fetcher(当前重点)

**目标**:从 `~/development/anyreach/` 把 CDP 核心和 X adapter vendor 进 `lib/`,两种入口(list / 用户时间线)都能拿到归一化 tweet。

**风险**:DESIGN §7 R1 — profile DOM 可能与 list 不同,anyreach 只验证过 list,profile 要 spike。

### 子任务

- [x] **S1.1 vendor CDP 栈(5 个文件 + 2 处 patch)**
  - 动作:从 `~/development/anyreach/` 把 `browser-provider.mjs`(Chrome + Proxy 生命周期,user/managed 双模式)、`cdp-proxy.mjs`(HTTP-over-CDP bridge 子进程)、`proxy-client.mjs`(HTTP 客户端)、`x-adapter.mjs`(1700+ 行 X 抓取逻辑)、`_utils.mjs`(sleep/downloadFile)原样复制进 `lib/`
  - 交付:上述 5 个 vendor 文件 + `browser-provider.mjs` 内的 2 处 `[perch vendor]` patch(cdp-proxy 路径改为同级、log 文件名 `anyreach-proxy.log → perch-proxy.log`)
  - 验证:5 个文件就位,`proxy-client.mjs` 的 `ProxyClient` 可 import;端到端跑通留到 S1.4 review gate

- [x] **S1.2 `lib/x-fetcher.mjs` 暴露 fetchXList / fetchXProfile**
  - 动作:组合 `browser-provider` + `proxy-client` + `x-adapter`,对外提供两个 high-level 函数。默认 `mode='user'` 附着用户日常 Chrome。list 和 profile 走同一条 CDP 链路,差异只在 `x-adapter.detect(url)` 返回的 pageType
  - 交付:`lib/x-fetcher.mjs`(list + profile 同文件,profile 真正 spike 留到 S1.5)
  - 验证:list 端到端留到 S1.4;profile DOM 风险留到 S1.6

- [x] **S1.3 `lib/normalize.mjs`(tweet → raw block + 去重)**
  - 动作:实现 `formatTweet` / `formatLocalTime` / `getTodayDate` / `readExistingIds` + 私有 `mlookup`,timezone 参数化
  - 交付:`lib/normalize.mjs` 4 个导出函数
  - 验证:端到端跑盘留到 S1.4

- [x] **S1.4 ★ Review gate #1:list 抓取链路跑通**
  - 动作:`scripts/spike-list.mjs` 落盘,串起 S1.1 + S1.2 + S1.3。外部 review agent 真实 list 跑通
  - 顺手修的 bug:`readExistingIds` 只扫标题行 ID — 原实现把 block 里 quote 行的 ID 也计入,若该 tweet 日后真作为顶层出现会被误判重复
  - 文档对齐:DESIGN §5 raw 格式骨架补 `(Name)` + `MM-DD`,对齐 normalize 实际产出
  - 验证:格式对齐、ID 唯一、时间倒序 — 全通过

- [x] **S1.5 profile 入口打磨(代码工作量退化说明)**
  - 审视结果:anyreach x-adapter 已完整实现 profile 分支 — `_extractProfile`(行 1653)和 `_extractList`(行 1614)结构高度对称,共享底层 `collectTimelineItems` + `normalizeCard`,items 返回 shape 一致。DOM 假设基于 `data-testid` 选择器(UserName / UserDescription / UserUrl / ...),多语言计数(Posts/帖子 + 万/亿)已覆盖
  - 动作:给 `fetchXProfile` 补输入 `trim()`,扩充 docstring 说明已支持的 URL 形态(`handle` / `@handle` / `handle/media` / 完整 URL)和返回 shape。x-adapter 内部代码**一行未改**
  - 交付:`lib/x-fetcher.mjs` 的 `fetchXProfile` 注释 + 输入规范化
  - 验证:真正的 DOM 选择器是否随 X 改版漂移,只有 S1.6 的 live spike 能答;本步交付为零风险代码

- [x] **S1.6 ★ Review gate #2:profile 抓取链路跑通(Codex review)**
  - 动作:`scripts/spike-profile.mjs` 落盘,展示"原始 DOM 顺序 vs sortTweetsByTime 后"两个视角;stdout 走排序后 markdown
  - Codex 现场验证:profile 抓取链路通、shape 与 list 一致、formatTweet 可直接复用
  - 发现的真问题(已消化到设计里):profile DOM 顶部可能是 pinned tweet(非时间顺序),`limit=N` 下 pinned 挤占一位会让最老的那条应收推文漏采。根因不在 fetch 层,解在 Step 2 的 collect 业务层 — 用 generous limit + 窗口过滤 + ID 去重 + 时间排序来消化
  - 顺带修正:`scripts/spike-list.mjs` `count < limit` 走 exit 2,review gate 不再静默通过 partial;`lib/normalize.mjs` 新增 `sortTweetsByTime` 工具(smoke:pinned 老推文正确沉底、null 时间沉最底);`lib/x-fetcher.mjs` 顶部写清 Layer 1 边界(不排序 / 不窗口 / 不过滤 pinned,全交业务层)
  - 验证:profile 格式与 list 一致;pinned 处理由业务层(Step 2)编排,fetch 层不为它调整

- [x] **S1.7 收尾:API 文档对齐 + 跨源去重工具**
  - 动作:走原规划里"保持两个函数但对齐文档"那条出口。统一签名在没调用方的情况下是过度设计,强行 `fetchX({type, url})` 或 `fetchXMultiple` 只会把清晰的命名换成参数 bag
  - 交付:
    - `lib/normalize.mjs` 新增 `dedupTweets(tweets)` 纯函数,按 `statusId` 去重且保留首次出现顺序
    - `lib/x-fetcher.mjs` 顶部注释补一段:两个入口的 `.items` 形态完全一致(同 `normalizeCard`),混跑合并后过 `dedupTweets` 即可;并说明为什么不在此层做统一 API
  - 验证:inline smoke 跑通 [1,2] + [2,3] → [1,2,3];list + profile 真实混跑留给有调用方时再验

---

## Step 2 — Skill 骨架 + `ai-radar` topic 配置(中颗粒)

**目标**:`/perch collect --topic ai-radar` 能端到端跑通,raw 落到 topic 数据目录。

- [x] **S2.1 `SCHEMA.md` 模板(JSON frontmatter + 人读正文)** — 顶部两行 `---` 之间放合法 JSON(`topic` / `description` / `sources[]`);正文是业务目标 / 数据源说明 / 采集策略等 LLM & 人都能读的描述。用 JSON 而非 YAML 是为了不引入依赖
- [x] **S2.2 `templates/topics/ai-radar/SCHEMA.md`** — 一条 `ai-kol` source(list),target 是现有的 AI KOL list URL,fetch_limit 80;正文记录业务目标、采集策略、清洗/报告约定
- [x] **S2.3 `lib/topic.mjs`** — `loadTopic(slug, rootDir)` 读 config.json + SCHEMA frontmatter,产出 `{slug, description, timezone, dataPath, templatesDir, sources[]}`,校验 sources 的必要字段
- [x] **S2.4 `scripts/collect.mjs`(`/perch collect` 入口)** — 按 DESIGN §2.1 管线:对每个 source 调 fetchXList/fetchXProfile → dedupTweets 跨源合并 → readExistingIds diff → sortTweetsByTime → formatTweet 追加(带 via 行)到 `raw/daily/YYYY-MM-DD.md`。支持 `--dry` 和 `--topic`。不实现时间窗状态(ID 去重已覆盖,DESIGN §2.1 同步简化)
  - 顺带改:`lib/normalize.mjs` `formatTweet` 加 `options.source` 参数 → 渲染 `via:` 行;DESIGN §2.1 pipeline 简化去掉 lastRunTime;DESIGN §4.1/§4.2 目录结构更新(加 `scripts/` / `topic.mjs` / `templates/topics/` SCHEMA,数据目录去掉 SCHEMA)
- [ ] **S2.5 ★ Review gate #3:端到端跑通 `ai-radar` collect** — raw 文件按 DESIGN §5 格式写入,多次跑累积不漏不重
  - **Codex 第一轮(2026-04-20)**:✅ loadTopic / SCHEMA 解析、✅ 首次文件创建带头部 + Sources 列表、✅ block 格式(`## @handle (Name) · MM-DD · [source]` + type + via + metrics + media/quote/link)、✅ 前插保持时间倒序、✅ ID 去重无重复 block。⚠️ **中级 finding**:单次 collect 不稳 — 第一次实跑拿到 11 条老推文但顶部是 04-17、紧接第二次实跑才补齐 04-20 的 6 条。根因是 X timeline **lazy DOM**:首次 extract 看到的是 cache,最新推文由异步请求 append 到顶部
  - **修法(已落盘 `db0c5f2`)**:`lib/x-fetcher.mjs` 默认 2-pass extract — warmup 1.5s → extract1 → stabilize 3s → extract2(同一 tab,不 navigate)→ 按 statusId 合并。加 `options.stabilize=false` 给 spike / 单次探测 opt-out(默认 true)。Fetch 层 robustness,不穿透到 Business 层
  - **Codex 第二轮**:基于 `6b1926e`(即 `db0c5f2` 修复之前的 commit)复述了同一 finding,数字完全一致。不是新问题,待基于 HEAD 重测以确认 2-pass 吸收已生效

> 跑到 Step 2 收尾时,再回来把 Step 3-5 展开成子任务。

---

## Step 3 — Daily Wiki 生成(morning/noon/evening)

**v1 走 Skill 模式**:`scripts/report.mjs` 把 prompt 占位符填好打到 stdout,**当前 Claude 会话接棒**读 raw → 生成 wiki → 写盘。cron 自动化(直接调 API、无会话依赖)留 v2。

- [x] **S3.1 三份时段 prompt 模板化** — 改硬编码路径 / source label 为 `{RAW_PATH}` / `{WIKI_PATH}` / `{SUMMARIES_PATH}` / `{SOURCES}` / `{DATE}` 占位符。业务内容(Q 题目、时间窗、判定规则、格式要求)原样保留
- [x] **S3.2 `lib/wiki.mjs`** — `rawDailyPath` / `wikiDailyPath` / `summariesPath` 三个纯路径函数 + `prependSummaryEntry`(在 summaries.md 顶部 `<!-- -->` 注释之后插入日条目,保持时间倒序)
- [x] **S3.3 `scripts/report.mjs`(`/perch report` 入口)** — 解析 slot(`now` 按 topic.timezone 映射:5–11 morning / 12–17 noon / 其他 evening)、读对应 prompt 模板、做占位符替换、stdout 输出完整 prompt
- [x] **S3.4 SKILL.md 命令说明** — v1 已实现命令表 + Skill 模式说明(为什么 report 和 collect/rotate 工作方式不同)
- [ ] **S3.5 ★ Review gate:Claude 真跑一次 morning / noon / evening** — 验证 wiki 内容质量、写盘路径正确、evening 的 summaries.md 追加正常,以及占位符都被正确替换(没漏掉 `{XXX}` 字样)
  - **Codex 第二轮**:✅ 三个 slot 的 prompt 模板都能正确生成、占位符全部替换无残留;❌ 发现两个 bug 已修:
    - **中级**:`report.mjs --topic ai-radar`(省略 slot)报错 "invalid slot 'ai-radar'",因为旧 CLI 解析把 `--topic` 的 value 当成 positional。修法:小 `parseArgs` 识别 VALUE_FLAGS 跳过其 value
    - **低级**:`prependSummaryEntry` 非幂等,同日期重复调用会在 summaries.md 生成多个 `## YYYY-MM-DD`。修法:插入前调 `removeExistingDayEntry` 切掉旧条目(exact heading match,避开 `## 2026-04-20-suffix` 误伤)
  - wiki 实际产出质量仍需 Claude 会话真接棒一次才能验

## Step 4 — 月度 rotate 脚本

**v1 归档范围**:非当月的 `raw/daily/YYYY-MM-*.md` 和 `wiki/daily/YYYY-MM-*.md` → `archive/YYYY-MM/{raw,wiki}/daily/`。

**v1 不归档**:Topic Wiki(长期资产)、`summaries.md`(按月切分较复杂,v2 再做;DESIGN §3.3 的 "按月 reset" 意图当前由 rotate 外的手工操作兜底)、`SCHEMA.md`(不在数据目录)。

- [x] **S4.1 `lib/rotate.mjs`** — `currentMonth(tz)` + `findArchivableMonths(topic)`(扫 raw/daily 和 wiki/daily 文件前缀,返回去重排序的非当月 YYYY-MM)+ `planArchive(topic, month)`(返回 `{archiveDir, moves[]}`,moves 每项 `{from, to}`)+ `executePlan(plan)`(mkdir + rename)
- [x] **S4.2 `scripts/rotate.mjs`(`/perch rotate` 入口)** — `--topic` / `--dry-run`,对每个可归档月份 plan → log → execute,路径以 `path.relative(topic.dataPath, ...)` 打印节省行宽
- [x] **S4.3 幂等设计** — scan 是"找非当月 + 还没搬走的文件",搬走后下次 scan 自然找不到。无需额外 state
- [ ] **S4.4 ★ Review gate:真月末跑一次 `--dry-run` 再实跑** — 验证 archive 目录结构正确(`archive/YYYY-MM/{raw,wiki}/daily/`)、原位置文件已被搬走、连跑第二次报告 "no archivable months"
  - **Codex 第二轮**:✅ 用临时 fixture 目录验证了 `findArchivableMonths → planArchive → executePlan` 全链路,旧月 raw/daily 和 wiki/daily 文件能被搬到 `archive/YYYY-MM/`,再次 scan 变成 no-op(幂等 OK);真实 ai-radar 目录当前没有可归档月份,`--dry-run` 返回 "no archivable months" 符合预期
  - 月末真实归档行为待真实月末 live gate

## Step 5 — 加第二个 topic(验证配置化)

具体 topic 待 Step 3 收尾后定(AI 先打磨到每天真用,再挑 Web3,详见 DESIGN §7 R3)。目标只是验证:**换一份 SCHEMA.md 就能跑新 topic,不改框架代码**。

---

## v1 之后(不在当前窗口内)

见 DESIGN §8 "v1 先不做":Topic Wiki rebuild/stale、跨 topic 查询、Processor 插件化、SQLite 索引层。
