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
  - 动作:从 `~/development/ai-radar/scripts/collect.mjs` 沿袭 `formatTweet` / `formatLocalTime` / `getTodayDate` / `readExistingIds`(以及私有 `mlookup`),timezone 从参数传入,去掉对 config 的全局依赖
  - 交付:`lib/normalize.mjs` 导出 4 个函数
  - 验证:输出格式与 ai-radar 现有 raw 文件一致;端到端跑盘留到 S1.4

- [x] **S1.4 ★ Review gate #1:list 抓取链路跑通**
  - 动作:`scripts/spike-list.mjs` 落盘,串起 S1.1 + S1.2 + S1.3。外部 review agent 用等价一次性 harness 跑通真实 list,5/5 拿到结构正确的 markdown,链路通
  - 顺手修的 bug:`readExistingIds` 只扫标题行 ID — 原实现把 block 里 quote 行的 ID 也计入,若该 tweet 日后真作为顶层出现会被误判重复(ai-radar vendor 来的固有缺陷)
  - 文档对齐:DESIGN §5 raw 格式骨架补 `(Name)` + `MM-DD`,对齐 ai-radar / perch normalize 实际产出
  - 验证:格式对齐、ID 唯一、时间倒序 — 全通过

- [x] **S1.5 profile 入口打磨(代码工作量退化说明)**
  - 审视结果:anyreach x-adapter 已完整实现 profile 分支 — `_extractProfile`(行 1653)和 `_extractList`(行 1614)结构高度对称,共享底层 `collectTimelineItems` + `normalizeCard`,items 返回 shape 一致。DOM 假设基于 `data-testid` 选择器(UserName / UserDescription / UserUrl / ...),多语言计数(Posts/帖子 + 万/亿)已覆盖
  - 动作:给 `fetchXProfile` 补输入 `trim()`,扩充 docstring 说明已支持的 URL 形态(`handle` / `@handle` / `handle/media` / 完整 URL)和返回 shape。x-adapter 内部代码**一行未改**
  - 交付:`lib/x-fetcher.mjs` 的 `fetchXProfile` 注释 + 输入规范化
  - 验证:真正的 DOM 选择器是否随 X 改版漂移,只有 S1.6 的 live spike 能答;本步交付为零风险代码

- [ ] **S1.6 ★ Review gate #2:profile 抓取链路跑通**
  - 动作:`scripts/spike-profile.mjs` 跑一次 profile 抓取并 normalize
  - 交付:profile 来源的 normalized markdown
  - 验证:格式与 list 来源完全一致(后续落盘不需要区分来源字段)

- [ ] **S1.7 收尾:统一入口 + 跨源去重**
  - 动作:`x-fetcher.mjs` 提供统一签名(或保持两个函数但对齐文档),去重按 tweet ID
  - 交付:clean 的 `lib/x-fetcher.mjs` API
  - 验证:list + profile 混跑,同一条推文只出现一次

---

## Step 2 — Skill 骨架 + ai-radar topic 迁移(中颗粒)

**目标**:`/perch collect --topic ai-radar` 能端到端跑通,raw 落到 ai-radar topic 库。

- [ ] **S2.1 设计 `SCHEMA.md` 模板** — 定义 Topic 配置规范(source 列表、清洗规则占位、报告模板路径、摘要 prompt 占位)
- [ ] **S2.2 写 ai-radar topic 的 `SCHEMA.md`** — 落到 `templates/topics/ai-radar/SCHEMA.md`,source 指向现有 list/handle
- [ ] **S2.3 `lib/topic.mjs`** — 加载 Topic 配置、解析 source、定位数据目录
- [ ] **S2.4 `/perch collect` 入口** — 读 Topic → 调 x-fetcher → normalize → 追加到 `raw/daily/YYYY-MM-DD.md`(去重 + 时间倒序)
- [ ] **S2.5 ★ Review gate #3:端到端跑通 ai-radar collect** — raw 文件结构、内容与 ai-radar 老项目产出一致

> 跑到 Step 2 收尾时,再回来把 Step 3-5 展开成子任务。

---

## Step 3 — Daily Wiki 生成(morning/noon/evening)

迁移 ai-radar 三份时段 prompt、实现 `summaries.md` 读写、`wiki/daily/` 产出、`/perch report` 入口。**prompt 对齐新 raw 结构的工作量不小,预留打磨时间**。

## Step 4 — 月度 rotate 脚本

`/perch rotate` 幂等 + `--dry-run`,把上月 raw + daily wiki + summaries 归档到 `archive/YYYY-MM/`。**Topic Wiki 不归档(长期资产)**。手跑验证多次再考虑上 cron(DESIGN §7 R4)。

## Step 5 — 加第二个 topic(验证配置化)

具体 topic 待 Step 3 收尾后定(AI 先打磨到每天真用,再挑 Web3,详见 DESIGN §7 R3)。目标只是验证:**换一份 SCHEMA.md 就能跑新 topic,不改框架代码**。

---

## v1 之后(不在当前窗口内)

见 DESIGN §8 "v1 先不做":Topic Wiki rebuild/stale、跨 topic 查询、Processor 插件化、SQLite 索引层。
