// admin.mjs — Admin 角色:Topic 配置 CRUD(v3)
//
// v3 改动:spec.prompts 替代 spec.slots。SCHEMA.md frontmatter 不再写 slots 字段;
// scaffoldTopic 根据 prompts 列表生成对应的 .md 模板。
//
// spec 形态:
//   {
//     "topic": "my-radar",
//     "description": "...",
//     "dataPath": "/abs/path",
//     "sources": [...],
//     "prompts": ["morning", "noon", "evening"]   // 可选,默认 ["default"]
//   }

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const PROMPT_NAME_RE = /^[a-z][a-z0-9-]*$/;
const SOURCE_SLUG_RE = /^[a-z][a-z0-9-]*$/;
const TOPIC_SLUG_RE = /^[a-z][a-z0-9-]*$/;

/**
 * 校验 topic spec 的合法性,返回第一个错误字符串或 null。纯函数。
 */
export function validateTopicSpec(spec) {
  if (!spec || typeof spec !== 'object') return 'spec must be an object';
  if (!TOPIC_SLUG_RE.test(spec.topic || '')) return 'topic slug must match ^[a-z][a-z0-9-]*$';
  if (!Array.isArray(spec.sources) || spec.sources.length === 0) return 'sources must be a non-empty array';

  const srcSlugs = new Set();
  for (const [i, s] of spec.sources.entries()) {
    if (!s || typeof s !== 'object') return `sources[${i}] is not an object`;
    if (!SOURCE_SLUG_RE.test(s.slug || '')) return `sources[${i}].slug invalid`;
    if (srcSlugs.has(s.slug)) return `sources has duplicate slug "${s.slug}"`;
    srcSlugs.add(s.slug);
    if (!['list', 'profile'].includes(s.type)) return `sources[${i}].type must be list|profile`;
    if (typeof s.target !== 'string' || !s.target.trim()) return `sources[${i}].target required`;
    if (s.fetch_limit !== undefined) {
      if (!Number.isInteger(s.fetch_limit) || s.fetch_limit < 1 || s.fetch_limit > 200) {
        return `sources[${i}].fetch_limit must be integer 1-200`;
      }
    }
  }

  if (spec.prompts !== undefined) {
    if (!Array.isArray(spec.prompts) || spec.prompts.length === 0) {
      return 'prompts, when present, must be a non-empty array';
    }
    const seen = new Set();
    for (const [i, name] of spec.prompts.entries()) {
      if (typeof name !== 'string' || !PROMPT_NAME_RE.test(name)) {
        return `prompts[${i}] invalid (must match ${PROMPT_NAME_RE})`;
      }
      if (seen.has(name)) return `prompts has duplicate "${name}"`;
      seen.add(name);
    }
  }

  // v2 → v3 兼容性提示:spec.slots 还能传但会被忽略
  // (校验通过,但 scaffoldTopic 会 stderr 警告)

  return null;
}

/**
 * 生成 SCHEMA.md 内容(JSON frontmatter + 人读说明)。
 */
export function renderSchemaMd(spec) {
  const fm = JSON.stringify({
    topic: spec.topic,
    description: spec.description || spec.topic,
    sources: spec.sources,
  }, null, 2);

  return `---
${fm}
---

# Topic: ${spec.topic}

## 业务目标

(在这里写清楚该 topic 的信息漏斗目标:你要用这些数据回答什么问题 / 产出什么形态。)

## 数据源

见 frontmatter 的 \`sources\` 数组。字段含义:

| 字段 | 含义 |
|---|---|
| \`slug\` | 本 topic 内唯一。ingest 写盘时作为 \`via: <slug>\` 行落到每个 block,便于按源过滤 |
| \`type\` | \`list\` / \`profile\` |
| \`target\` | list 时为 list URL;profile 时为 handle 或完整 profile URL |
| \`label\` | 人读备注,仅用于文档和日志 |
| \`fetch_limit\` | 每次 ingest 拉取上限(1-200),建议 80 |

## Prompt 模板

同目录下每份 \`<name>.md\` 是一份 prompt 模板。\`<name>\` 是任意标识,
作为 \`perch report --prompt <name>\` 的引用。新增形态报告 = 加一份 .md。

可用占位符见 \`docs/TOPIC_AUTHORING.md\`。

## 调度

v3 框架不做调度。报告节奏由外部 cron / openclaw / agent 决定。
典型早午晚三份报告:三个 cron + 各自 \`perch report --prompt <name>\`。
`;
}

/**
 * 为一个 prompt 生成最小可跑的骨架。
 */
export function renderPromptStub(slug, promptName) {
  return `# ${slug} — ${promptName} 报告

## 任务

基于 inputs(\`{INPUTS}\`,${'`{DATE}`'} 的 raw 采集),为 topic "${slug}" 生成 ${promptName} 形态报告。

## 数据范围

输入文件:
{INPUTS_LIST}

(如需时间过滤,在此处自行约束。例如:"只分析 {DATE} 12:00 之后发布的 block"。)

## 数据源

{SOURCES}

## 要回答的问题

(在这里替换成你真正要回答的问题。每题建议包含:问题本身 / 需要的输入字段 / 期望的输出结构。)

### Q1. (你的第一个问题)

### Q2. ...

## 输出格式

按你设计的结构生成完整 markdown(不含 \`## section: {SECTION_NAME}\` 外层标题,脚本会自动加)。

## 写入方式

生成完整 markdown 后,**用 Bash heredoc 管道给 wiki-write 脚本**:

\`\`\`bash
{WIKI_WRITE_CMD} <<'PERCH_EOF'
(把你生成的完整 markdown 原样放这里)
PERCH_EOF
\`\`\`

最终文件落在 \`{WIKI_PATH}\`(当日所有 section 共用一份)。

## (可选)同时输出日概览

如果这是 evening 类全天总结报告,可以**额外**把 5-7 句日概览 prepend 到 \`{SUMMARIES_PATH}\`:

\`\`\`bash
{SUMMARY_WRITE_CMD} <<'PERCH_EOF'
(5-7 句日概览正文,**不含** \`## {DATE}\` 标题,脚本自动加)
PERCH_EOF
\`\`\`

## 工具:按需深抓 article

如果某个问题需要读 Twitter Article 全文(raw 里只有 \`🖼️ article: "title"\` 预览):

\`\`\`
{FETCH_ARTICLE_CMD} <status_url>
\`\`\`

输出是缓存 markdown 的绝对路径。普通长推已在 ingest 阶段自动 hydrate,不需要再深抓。
`;
}

/**
 * 把 spec 写盘:SCHEMA.md + prompts/*.md + config.json 注册。
 *
 * 不覆盖已有文件 / 已有 config 条目;冲突 throw。
 */
export async function scaffoldTopic(rootDir, spec) {
  const err = validateTopicSpec(spec);
  if (err) throw new Error(`invalid spec: ${err}`);
  if (!spec.dataPath || !path.isAbsolute(spec.dataPath)) {
    throw new Error('spec.dataPath must be an absolute path');
  }

  if (spec.slots !== undefined) {
    process.stderr.write(
      `[admin] DEPRECATION: spec.slots 在 v3 已废弃,请改用 spec.prompts(数组形式列出 prompt 名字)。本次将忽略 slots 字段。\n`
    );
  }

  const configPath = path.join(rootDir, 'config.json');
  const config = JSON.parse(await readFile(configPath, 'utf-8'));
  if (config.topics?.[spec.topic]) {
    throw new Error(`topic "${spec.topic}" already exists in config.json`);
  }
  const templatesDir = path.join(rootDir, 'templates', 'topics', spec.topic);
  if (existsSync(templatesDir)) {
    throw new Error(`templates dir already exists: ${templatesDir}`);
  }

  const promptNames = spec.prompts && spec.prompts.length > 0
    ? spec.prompts
    : ['default'];

  const written = [];

  await mkdir(templatesDir, { recursive: true });
  const schemaPath = path.join(templatesDir, 'SCHEMA.md');
  await writeFile(schemaPath, renderSchemaMd(spec), 'utf-8');
  written.push(schemaPath);

  for (const name of promptNames) {
    const p = path.join(templatesDir, `${name}.md`);
    await writeFile(p, renderPromptStub(spec.topic, name), 'utf-8');
    written.push(p);
  }

  config.topics = config.topics || {};
  config.topics[spec.topic] = {
    path: spec.dataPath,
    description: spec.description || spec.topic,
    templates_dir: `templates/topics/${spec.topic}`,
  };
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  written.push(configPath);

  return written;
}
