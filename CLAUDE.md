# Perch — Project Guidelines

## 项目定位

多 Topic 个人信息漏斗 · 基于 ikiw 思想的互联网数据处理框架。**完整设计见 `docs/DESIGN.md`,任何实现前必读。开发任务清单见 `docs/TASKS.md`。**

## 提交规则(原子提交)

- **完成一个可验证的修改单元后,自动做一次 `git commit + git push`,不逐次询问**
- "提交" = commit + push 到远端,**只 commit 不算完成**
- 仅在以下情况先确认:
  - 涉及敏感文件(.env / secret / 证书)
  - 破坏性操作(删历史、强制推送、schema 删字段)
  - 多个不相关改动需要拆分成多个 commit

## 代码复用约定

所有上游资产在本地 `~/development/` 下,需要参考 / vendor 代码时**直接读本地文件**,不要网上搜。

| 目录 | 用途 |
|---|---|
| `~/development/anyreach/` | CDP Proxy + X adapter 源头。**lib/ 下的代码 vendor 自这里** |
| `~/development/ikiw/` | 思想同源的知识库框架。prompt / frontmatter 规范可 copy |
| `~/development/ai-radar/` | 前身项目。templates 已迁入;`scripts/collect.mjs` 里的 `formatTweet` / `readExistingIds` / 时间格式化函数都是稳定代码,vendor 入 `lib/normalize.mjs` 时直接抄 |

## 编码习惯

- 编辑代码前**先读文件**,理解现有逻辑再动手
- 不主动重构未被要求修改的代码
- 不添加多余注释,不过度工程化
- 发现可能破坏现有功能的修改,先提醒再执行
- 函数名 / 变量名要一眼看明白用途,变量作用域越小越好
- 同样的逻辑出现 3 次才抽象

## 与 ai-radar(老项目)的边界

- 老目录 `~/development/ai-radar/` **保留但冻结**,不再在老目录开发
- 所有新开发在 `~/development/perch/`
- 老目录里的资产(collect.mjs / templates)作为"代码参考源",不作为运行时依赖

## 路线图

见 `docs/DESIGN.md` 第 8 节。**Step 1(vendor CDP + X fetcher)已全部收尾**(S1.4 / S1.6 两个 review gate 均通过)。当前推进 **Step 2 — topic 配置 + `/perch collect`**,细粒度任务见 `docs/TASKS.md`。

路线图 v1 结束前,**不做**:Topic Wiki 的 stale/rebuild 机制、跨 topic 查询、Processor 插件化、SQLite 索引层。
