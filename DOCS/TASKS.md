# Perch — 开发任务清单

> DESIGN.md §8 路线图的可执行版本。分层拆解:近期细,远期粗,跑到哪里再展开。
>
> **用法**:一边开发一边勾选。`★` 标注的是 **review gate** — 完成后主动拉 review 再推进下一条。

---

## Step 1 — Vendor CDP 瘦核 + X fetcher(当前重点)

**目标**:从 `~/development/anyreach/` 把 CDP 核心和 X adapter vendor 进 `lib/`,两种入口(list / 用户时间线)都能拿到归一化 tweet。

**风险**:DESIGN §7 R1 — profile DOM 可能与 list 不同,anyreach 只验证过 list,profile 要 spike。

### 子任务

- [ ] **S1.1 vendor CDP client → `lib/cdp-client.mjs`**
  - 动作:读 `~/development/anyreach/` 源码,圈定最小必要文件(启动/连接真实 Chrome、页面导航、evaluate、DOM 读取),裁掉其他 adapter、proxy server、CLI 入口
  - 交付:`lib/cdp-client.mjs`(单文件或小目录,不带无关依赖)
  - 验证:`node` 里 import 能加载,demo 能连上一个已开的 Chrome tab 并取到 title

- [ ] **S1.2 vendor X list adapter → `lib/x-fetcher.mjs`(list 模式)**
  - 动作:从 anyreach 的 X adapter 抽出 list 页抓取路径,导出 `fetchXList(url, options) → tweet[]`(原始对象,未格式化)
  - 交付:`lib/x-fetcher.mjs` 只含 list 入口
  - 验证:传入一个 list URL,返回 tweet 数组,字段覆盖 handle / text / time / metrics / media / quote|reply

- [ ] **S1.3 vendor 归一化逻辑 → `lib/normalize.mjs`**
  - 动作:抄 `~/development/ai-radar/scripts/collect.mjs` 里的 `formatTweet` / `readExistingIds` / 时间格式化工具
  - 交付:`lib/normalize.mjs` 导出 `normalizeTweet(raw) → markdown block` 和 `readExistingIds(filepath) → Set<id>`
  - 验证:一个 tweet 原始对象 → 产出符合 DESIGN §5 raw 格式的 markdown block(`## @handle · HH:MM · [source](url)` + metrics + media)

- [ ] **S1.4 ★ Review gate #1:list 抓取链路跑通**
  - 动作:写 `scripts/spike-list.mjs` 串起 S1.1 + S1.2 + S1.3,用 ai-radar 现有的 list URL 跑一次,输出到 stdout
  - 交付:一段真实的 normalized tweet markdown(至少 3 条)
  - 验证:格式与 ai-radar 当前产出对齐,ID 唯一,时间倒序

- [ ] **S1.5 扩展 profile 模式 → `x-fetcher.mjs` 新增 `fetchXProfile(handle, options)`**
  - 动作:打开一个 X 用户 profile 页,观察 DOM 差异,调整选择器。**这是 R1 spike,难度不确定**
  - 交付:`fetchXProfile(handle)` 返回 shape 与 list 一致的 tweet 数组
  - 验证:传入 `handle` 能拿到该用户最近推文,字段齐全

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
