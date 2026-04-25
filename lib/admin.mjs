// admin.mjs — Admin 角色:Topic 配置 CRUD(scaffold + validate + render + list)
//
// 对应 v1 scripts/new-topic.mjs 里的纯函数(scaffoldTopic / validateTopicSpec /
// renderSchemaMd / renderSlotPrompt),抽出来作为 lib 模块,被 Topic.create 委托。
//
// CLI 入口(交互向导 / --from-json)由 scripts/perch.mjs 的 admin subcommand 提供,
// 不在这里。本模块只暴露纯函数(无副作用 + 文件系统副作用受参数控制)。

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { DEFAULT_SLOTS } from './topic.mjs';

/**
 * 校验 topic spec 的合法性,返回第一个错误字符串或 null(通过)。纯函数。
 */
export function validateTopicSpec(spec) {
  if (!spec || typeof spec !== 'object') return 'spec must be an object';
  if (!/^[a-z][a-z0-9-]*$/.test(spec.topic || '')) return 'topic slug must match ^[a-z][a-z0-9-]*$';
  if (!Array.isArray(spec.sources) || spec.sources.length === 0) return 'sources must be a non-empty array';
  const srcSlugs = new Set();
  for (const [i, s] of spec.sources.entries()) {
    if (!s || typeof s !== 'object') return `sources[${i}] is not an object`;
    if (!/^[a-z][a-z0-9-]*$/.test(s.slug || '')) return `sources[${i}].slug invalid`;
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
  if (spec.slots !== undefined) {
    if (!Array.isArray(spec.slots) || spec.slots.length === 0) {
      return 'slots, when present, must be a non-empty array';
    }
    const slotNames = new Set();
    const slotHours = new Set();
    for (const [i, s] of spec.slots.entries()) {
      if (!/^[a-z][a-z0-9-]*$/.test(s.name || '')) return `slots[${i}].name invalid`;
      if (s.name === 'now') return `slot name "now" is reserved`;
      if (slotNames.has(s.name)) return `slots has duplicate name "${s.name}"`;
      slotNames.add(s.name);
      if (!Number.isInteger(s.start_hour) || s.start_hour < 0 || s.start_hour > 23) {
        return `slots[${i}].start_hour must be integer 0-23`;
      }
      if (slotHours.has(s.start_hour)) return `slots has duplicate start_hour ${s.start_hour}`;
      slotHours.add(s.start_hour);
      if (s.window !== undefined && !['today', 'since_prev'].includes(s.window)) {
        return `slots[${i}].window must be "today" or "since_prev"`;
      }
    }
  }
  return null;
}

/**
 * 生成 SCHEMA.md 内容(JSON frontmatter + 人读说明)。
 */
export function renderSchemaMd(spec) {
  const fm = JSON.stringify(spec, null, 2);
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
| \`target\` | list 时为 list URL;profile 时为 handle(\`elonmusk\` / \`@elonmusk\`)或完整 profile URL |
| \`label\` | 人读备注,仅用于文档和日志 |
| \`fetch_limit\` | 每次 ingest 拉取上限(1-200),建议 80。详见 DESIGN §2.4 的 generous limit 哲学 |

## 时段槽位

见 frontmatter 的 \`slots\` 数组。每条:

| 字段 | 含义 |
|---|---|
| \`name\` | 槽位名;对应同目录 \`<name>.md\` analyze prompt 模板 |
| \`start_hour\` | 0-23 整数,该槽位起始小时 |
| \`window\` | \`today\` / \`since_prev\`,analyze 报告覆盖窗口 |

## 清洗与报告

- **清洗规则**:Domain 层当前直接落 raw。如需按关键词/账号黑名单过滤,在 ingest 层加一层
- **Analyze 模板**:每个 slot 对应一份 \`<slot>.md\`
- **Digest 模板**:可选,在 \`digest.md\` 里覆盖默认通用模板(generic 5-7 句日概览)
`;
}

/**
 * 为一个 slot 生成最小可跑的 analyze prompt 骨架。
 */
export function renderSlotPrompt(slug, slot) {
  return `# ${slug} — ${slot.name} 报告

## 任务

基于 \`{RAW_PATH}\`({DATE} 的当日 raw 采集),为 topic "${slug}" 生成 ${slot.name} 时段报告。

## 时间窗口

- **类型**: {WINDOW_TYPE}
- **起点**: {WINDOW_START_LABEL}
- **终点**: {WINDOW_END_LABEL}

只分析发布时间落在此窗口内的推文(raw block 标题行的 \`MM-DD HH:MM\` 时间戳,与窗口做字符串比较即可)。

## 数据源

{SOURCES}

## 要回答的问题

(在这里替换成你真正要回答的问题。每题建议包含:问题本身 / 需要的输入字段 / 期望的输出结构)

### Q1. (你的第一个问题)

### Q2. ...

## 输出格式

按你设计的结构生成完整 markdown(不含 \`## slot: {SLOT}\` 外层标题,脚本会自动加)。

## 写入方式

生成完成后用 Bash heredoc 管道给 wiki-write 脚本(它对当日 wiki 的 \`## slot: {SLOT}\` 段做幂等 upsert,其他 slot 的 section 原样保留):

\`\`\`bash
{WIKI_WRITE_CMD} <<'PERCH_EOF'
(把你生成的完整 markdown 原样放这里)
PERCH_EOF
\`\`\`

最终文件落在 \`{WIKI_PATH}\`(当日所有 slot 共用一份)。不要用 Write 工具直接覆盖。

## 工具:按需深抓 article

如果某个问题真的需要读 Twitter Article 全文(raw 里只有 \`🖼️ article: "title"\` 和 statusUrl),
在回答前跑:

\`\`\`
{FETCH_ARTICLE_CMD} <status_url>
\`\`\`

输出是缓存 markdown 的绝对路径(首次抓取后缓存到 \`{ARTICLE_CACHE_DIR}\`,同月内复用);
用 Read 工具读该文件取正文。只在**确有需要**时抓,不要批量预抓。

普通长推已在 ingest 阶段自动 hydrate 为完整正文,不需要再深抓。
`;
}

/**
 * 把一个 spec 写盘(SCHEMA.md + slot 模板 + config.json 注册)。
 * 不覆盖已有文件 / 已有 config 条目;冲突 throw。
 *
 * @param {string} rootDir
 * @param {object} spec
 * @returns {Promise<string[]>} 写入的文件绝对路径列表
 */
export async function scaffoldTopic(rootDir, spec) {
  const err = validateTopicSpec(spec);
  if (err) throw new Error(`invalid spec: ${err}`);
  if (!spec.dataPath || !path.isAbsolute(spec.dataPath)) {
    throw new Error('spec.dataPath must be an absolute path');
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

  const written = [];

  const effectiveSlots = spec.slots === undefined
    ? DEFAULT_SLOTS.map(s => ({ ...s }))
    : spec.slots.map(s => ({ ...s, window: s.window || 'today' }));

  await mkdir(templatesDir, { recursive: true });
  const schemaPath = path.join(templatesDir, 'SCHEMA.md');
  const schemaBody = renderSchemaMd({
    topic: spec.topic,
    description: spec.description || spec.topic,
    sources: spec.sources,
    slots: effectiveSlots,
  });
  await writeFile(schemaPath, schemaBody, 'utf-8');
  written.push(schemaPath);

  for (const slot of effectiveSlots) {
    const p = path.join(templatesDir, `${slot.name}.md`);
    await writeFile(p, renderSlotPrompt(spec.topic, slot), 'utf-8');
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
