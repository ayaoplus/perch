# Perch — 设计规范

> 基于 ikiw 思想的互联网数据处理框架 · 多 Topic 个人信息漏斗

**状态**:重构设计文档。现 `ai-radar` skill 会作为首个 Topic 被迁移进来。

---

## 1. 项目定位

**一句话**:多 Topic 的个人信息漏斗。每个 Topic = 一组 X 数据源 + 一套 LLM 工作流(采集 → 清洗 → 摘要 → 分析报告),本地 Markdown 落地,可扩展。

**核心价值(护城河)**:

1. **X 能抓**(登录态真实 Chrome,via vendor 自 anyreach 的 CDP 瘦核)
2. **LLM 工作流**(时段报告 / 选题分析 / 主题蒸馏)

这两件事组合起来,市面上没有现成工具能替代。

**明确不做**:

- 不做 RSS(市面有 miniflux/NetNewsWire,别重造轮子)
- 不做长期归档知识库(那是 ikiw 的定位)
- 不做通用平台抓取(那是 anyreach 的定位)

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

---

## 3. 核心概念

### 3.1 Topic(一等公民)

一个 Topic = 一组 **source + 清洗规则 + 报告模板 + 摘要 prompt** 的配置包。

**"换领域"= 换整个配置包**,不是换一个 URL 那么简单。这是 day 1 就要锁定的抽象。

每个 Topic 独立目录、独立生命周期、独立归档。

### 3.2 两种 Wiki

| 类型 | 路径 | 触发方式 | 特征 |
|---|---|---|---|
| **Daily Wiki** | `wiki/daily/YYYY-MM-DD-{slot}.md` | 时段自动(morning/noon/evening) | 一次产出,用完归档 |
| **Topic Wiki** | `wiki/topic/{topic-slug}.md` | 按需,跨日期累积 | 带 frontmatter,可 stale → rebuild |

Daily 为主,Topic 为辅(看需要才建)。两者都是独立能力,框架层都支持。

### 3.3 月度切分(精简哲学)

**原则**:永远不维护大数据库。按时间切,只管当月。

- 活跃库 = 只当月
- 每月 1 号 rotate 上月 raw/daily + summaries 到 `archive/YYYY-MM/`
- `summaries.md` 按月 reset
- **Topic Wiki 不归档**(长期资产,跨月保留)
- 跨月查询:归档视为只读库(沿用 ikiw `--all` 思路)

**为什么不是"当月+上月"**:双月窗口在月初会膨胀到近 60 天,波动大、无必要。单月最干净。

---

## 4. 目录结构

### 4.1 Skill 本体(代码 + 插件)

```
~/.claude/skills/perch/
├── SKILL.md
├── config.json                 # 全局配置(默认 topic、归档策略、timezone)
├── lib/                        # 中间固定(vendor 自 anyreach 的瘦核 + perch 自己的归一化)
│   ├── browser-provider.mjs    # vendor: Chrome + CDP Proxy 生命周期(user / managed 双模式)
│   ├── cdp-proxy.mjs           # vendor: HTTP-over-CDP bridge,独立子进程
│   ├── proxy-client.mjs        # vendor: CDP Proxy 的 HTTP 客户端(newTab/eval/click/...)
│   ├── _utils.mjs              # vendor: adapter 辅助(sleep / downloadFile)
│   ├── x-adapter.mjs           # vendor: X list/profile/status 提取逻辑(保持 anyreach 原样)
│   ├── x-fetcher.mjs           # perch: 上述 vendor 的组合,对外暴露 fetchXList / fetchXProfile
│   ├── normalize.mjs           # perch: tweet 原始对象 → raw markdown block + 去重辅助
│   └── rotate.mjs              # perch: 月度归档(Step 4 实现)
├── sources/                    # 采集插件(可扩展端之一)
│   ├── x-list.md
│   └── x-user.md
└── processors/                 # 产出插件(可扩展端之二)
    ├── report.md               # 时段/主题报告
    ├── visual-card.md
    └── distill.md
```

### 4.2 Topic 库(数据 + 本 topic 配置)

```
~/your-data-dir/<topic>/
├── SCHEMA.md                   # 本 topic 的 source/清洗/模板/摘要 prompt 配置
├── raw/
│   └── daily/YYYY-MM-DD.md     # 当月原始采集
├── summaries.md                # 当月推文摘要(ikiw 心脏)
├── wiki/
│   ├── daily/                  # 时段 wiki
│   └── topic/                  # 主题 wiki(带 frontmatter)
└── archive/
    └── YYYY-MM/                # 上月归档(目录或 tar.gz)
```

**说明**:Topic 库路径可配置(当前 ai-radar 在 iCloud 的 Obsidian 目录)。不写死 `~/your-data-dir`。

---

## 5. Raw 格式

继承现有 `ai-radar/SCHEMA.template.md` 已稳定的格式,此处不重复。核心约定:

- 一天一个文件,时间倒序(最新在上)
- 去重粒度 = tweet ID(从文件内容正则扫出)
- 每条推文一个 `## @handle · HH:MM · [source](url)` block
- 保留 `type / 推文正文 / 📊 metrics / 🖼️ media / 🔗 quote|reply` 字段

---

## 6. 与现有资产的关系

| 资产 | 关系 |
|---|---|
| `ai-radar`(现有) | 被重构迁入 perch,作为**首个 Topic**(topic 名字:`ai-radar`) |
| `ikiw` | **思想同源,实现完全独立**。可 copy prompt,不引用代码。保持 frontmatter/summaries 规范兼容,方便将来 ikiw 跨库查询消费 perch 的 Topic 库 |
| `anyreach` | **Vendor 核心代码**(CDP client + X adapter)进 `lib/`。此后两个项目独立演进,perch 只走 X,anyreach 继续通用化 |

---

## 7. 风险清单(已识别)

### R1. X profile DOM 结构可能不同于 list

anyreach 现有 X adapter 已验证 list 抓取。但**用户时间线页面(profile)DOM 不同**,vendor 过来可能要补代码。

**缓解**:路线图第 1 步就做 spike 测试,抓一个 profile URL 验证。不行就先补这块,再谈存储层。

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

## 8. 落地路线图(MVP-first)

| 步 | 任务 | 验证点 |
|---|---|---|
| 1 | Vendor CDP 瘦核 + X fetcher(list + profile 两种) | 两种 URL 都能抓到 normalized tweet |
| 2 | Skill 骨架 + config + ai-radar topic 的 SCHEMA + 现有模板迁移 | `perch collect` 跑通,raw 落到新结构 |
| 3 | Daily Wiki 生成(morning/noon/evening) | 三种时段都能产出 |
| 4 | 月度 rotate 脚本(`--dry-run` + 幂等) | 手动跑一次上月归档 |
| 5 | 加第二个 topic(验证配置化真的 work) | 换 SCHEMA 能跑通新 topic |

### v1 先不做

- Topic Wiki 的 rebuild / stale 机制
- 跨 topic 查询(ikiw `--all` 那套)
- Processor 插件化(第一版写死 report 一种)
- SQLite 索引层(v2 视查询需求再加)

---

## 9. 开放问题(TBD)

- **Topic 间共享 KOL 观测**:同一账号出现在多 list 时,是否 cross-reference?
- **历史 wiki 在 prompt 迭代后是否自动 rebuild**:目前继承 ikiw 的 `schema_prompt_hash`,但默认不自动重建,手动触发。v1 够用
- **SQLite 索引层什么时候加**:触发条件 = 跨月查询 / 按关键词查 / 按 metrics 排序 真的成为日常需求时
- **anyreach 未来演进**:如果 anyreach 的 CDP 核心有重大改进,是否值得反向 sync?频率上看 quarterly review 一次

---

## 10. 附录:术语表

| 术语 | 含义 |
|---|---|
| **Topic** | 一个配置包(source + 清洗 + 模板 + 摘要 prompt),对应一个独立数据库目录 |
| **Source** | Topic 的数据输入端,插件化。当前支持 `x-list` / `x-user` |
| **Processor** | Topic 的数据产出端,插件化。当前支持 `report`(后续扩展 `distill` / `visual-card` 等) |
| **Daily Wiki** | 时段触发的一次性报告,日期+slot 绑定 |
| **Topic Wiki** | 按需生成的跨日期主题报告,带 frontmatter 可 rebuild |
| **Raw** | 归一化后的原始推文 markdown 文件,一天一个 |
| **Summaries** | 当月推文的一句话摘要索引,LLM 一次读完用于定位相关推文 |
| **Rotate** | 月度归档操作,把上月 raw+summaries 移到 `archive/YYYY-MM/` |
