# Perch — Project Guidelines (v3)

## 项目定位

多 Topic 个人信息漏斗 · 互联网数据处理框架。**完整设计见 `docs/DESIGN.md`,任何实现前必读;快速入门见 `README.md`。**

## 提交规则(原子提交)

- **完成一个可验证的修改单元后,自动做一次 `git commit + git push`,不逐次询问**
- "提交" = commit + push 到远端,**只 commit 不算完成**
- 仅在以下情况先确认:
  - 涉及敏感文件(.env / secret / 证书)
  - 破坏性操作(删历史、强制推送、schema 删字段)
  - 多个不相关改动需要拆分成多个 commit

## 编码习惯

- 编辑代码前**先读文件**,理解现有逻辑再动手
- 不主动重构未被要求修改的代码
- 不添加多余注释,不过度工程化
- 发现可能破坏现有功能的修改,先提醒再执行
- 函数名 / 变量名要一眼看明白用途,变量作用域越小越好
- 同样的逻辑出现 3 次才抽象

## v3 架构原则

### 角色维度(信息生命周期)

| 角色 | 实现 | 职责 |
|---|---|---|
| **Ingest** | `lib/ingest.mjs` | 外部 source → raw 文件(默认 today raw,可 `--out`) |
| **Report** | `lib/report.mjs` | 通用 prompt runner:渲染 prompt → LLM(skill 模式) |
| **Enrich** | `lib/enrich.mjs` | 单点深抓 article → 月度缓存 |
| **Archive** | `lib/archive.mjs` | 月度归档 |
| **Admin** | `lib/admin.mjs` | Topic 配置 CRUD |

新形态报告(周报、专题分析)= 写一份 prompt `.md`,**不动框架**。框架只有 5 个角色,清单是收敛的。

### 实现层维度

| 层 | 位置 | 做什么 |
|---|---|---|
| **Adapter** | `lib/x-fetcher.mjs` · `lib/x-adapter.mjs` | 和外部世界打交道:CDP / X redux store |
| **Domain** | `lib/topic.mjs`(Topic class)+ 5 个角色模块 | 领域逻辑 |
| **Tool** | `lib/normalize.mjs` · `lib/wiki.mjs` · `lib/article-cache.mjs` | 可组合原子 |

CLI(`scripts/perch.mjs`)在 Domain 之上 ~30 行,只做 subcommand 路由 + 默认值填充。

不要把业务语义倒回 Adapter 层。

## 调度由外部完成

v3 框架**不做调度**。报告节奏由外部 cron / openclaw / agent 决定:

```bash
0 8  * * *  perch ingest --topic ai-radar && perch report --topic ai-radar --prompt morning
0 13 * * *  perch ingest --topic ai-radar && perch report --topic ai-radar --prompt noon
0 19 * * *  perch ingest --topic ai-radar && perch report --topic ai-radar --prompt evening
```

凌晨补跑、跨日回顾、周报 —— 都是 cron 命令的事,不是框架的事。

## 新建 / 配置 topic

优先用 `node scripts/perch.mjs admin create --from-json <spec>`(有校验、幂等)。`spec.prompts` 数组列出要生成的 prompt 名;省略时默认 `["default"]`。详细字段 / 常见坑见 `docs/TOPIC_AUTHORING.md`。

## Report 语义

- **--prompt <name>** 对应 `templates/topics/<slug>/<name>.md`,文件名(去 `.md`)就是 prompt 标识
- **--section <name>** 缺省 = `--prompt`,决定 wiki 写到哪段
- **--inputs <paths>** 缺省 = today raw 单文件;支持 comma-separated 多文件 / shell 展开 glob 后的 comma-join
- **--date YYYY-MM-DD** 缺省 = today(topic.timezone),决定 `{DATE}` 占位符 + wiki 写到哪天
- prompt 模板里时间过滤靠**模板自己写**(引用 `{DATE}` + 硬编码小时数,如"只看 {DATE} 12:00 之后")
- **wiki 写入**:走 `{WIKI_WRITE_CMD}` heredoc pipe,**不要**用 Write 工具直接覆盖 `{WIKI_PATH}`(会破坏其他 section)
- **summaries 写入**(evening 类双产出):走 `{SUMMARY_WRITE_CMD}` heredoc pipe,同理不要 Write 直接写

## v3 状态

主链路全部实现:`perch ingest / report / enrich / archive / admin`。slot / window / 凌晨 wrap / canonical end / 独立 digest method 全部消失。

**v3.1 新增 LLM Direct 模式**:`lib/llm.mjs::runPromptWithTools` 直连 Anthropic Messages API + agent loop(read_file / bash tools),让 cron / openclaw / 任意无 Claude Code 会话的 runner 都能驱动 report。两种模式(Skill / Direct)共享同一份 prompt 模板,行为同构。

仓库内置示例 topic(`ai-radar`),SCHEMA 里的 X list ID 是占位符。详见 `docs/DESIGN.md` §8。

v3 明确不做:Schedule 自动驱动(Direct 模式 + cron 已覆盖)、Topic Wiki stale/rebuild、跨 topic 查询、summaries 月度切分归档、per-topic timezone、外链深抓。

## LLM Direct 模式(v3.1)

cron / openclaw 跑 report:

```bash
ANTHROPIC_API_KEY=sk-ant-...
PERCH_LLM_MODE=direct
node scripts/perch.mjs report --topic ai-radar --prompt evening
```

env:
- `ANTHROPIC_API_KEY`(必需)
- `PERCH_LLM_MODEL`(默认 `claude-sonnet-4-5`)
- `PERCH_LLM_MAX_TOKENS`(默认 16384)
- `PERCH_LLM_DEBUG=1`(打印 API request/response 简要)
- `PERCH_LLM_PROVIDER=stub`(测试用,跳过真实 API)

Direct 模式的 bash tool cwd 锁到仓库根 + 10 分钟 timeout + 200KB 输出上限。**Prompt injection 风险来自 X 推文内容**,首版不做命令白名单 —— 容器隔离 / 沙箱由 cron / openclaw 层负责。
