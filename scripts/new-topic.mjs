#!/usr/bin/env node
// new-topic.mjs — 创建新 Topic 的向导 / 脚手架
//
// 两种用法:
//   (交互)    node scripts/new-topic.mjs
//   (非交互)  node scripts/new-topic.mjs --from-json <file>   — 从 JSON 文件读 spec,无交互直接生成
//   (help)    node scripts/new-topic.mjs --help
//
// 写入产物:
//   1. `templates/topics/<slug>/SCHEMA.md`(frontmatter + 人读说明)
//   2. 每个 slot 一份 `<slot>.md` prompt 骨架(占位供你后续替换成真问题)
//   3. `config.json` 注册新 topic 的 path + templates_dir
//
// **保守策略**:脚本不会覆盖已有文件 / 已有 topic 配置。冲突就报错退出。
//
// 字段详解见 docs/TOPIC_AUTHORING.md。

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SLOTS } from '../lib/topic.mjs';

// —— 可 import 的纯函数(便于 agent 驱动 / 单元验证)——

/**
 * 根据一个 topic spec 对象生成 `templates/topics/<slug>/SCHEMA.md` 的完整内容。
 *
 * @param {object} spec  形如 { topic, description, sources, slots }
 * @returns {string}
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
| \`slug\` | 本 topic 内唯一。collect 写盘时作为 \`via: <slug>\` 行落到每个 block,便于按源过滤 |
| \`type\` | \`list\` / \`profile\` |
| \`target\` | list 时为 list URL;profile 时为 handle(\`elonmusk\` / \`@elonmusk\`)或完整 profile URL |
| \`label\` | 人读备注,仅用于文档和日志 |
| \`fetch_limit\` | 每次 collect 拉取上限(1-200),建议 80。详见 DESIGN §2.1 的 generous limit 哲学 |

## 时段槽位

见 frontmatter 的 \`slots\` 数组。每条:

| 字段 | 含义 |
|---|---|
| \`name\` | 槽位名;对应同目录 \`<name>.md\` prompt 模板 |
| \`start_hour\` | 0-23 整数,该槽位起始小时 |
| \`window\` | \`today\` / \`since_prev\`,报告覆盖窗口 |

## 清洗与报告

- **清洗规则**:Business 层当前直接落 raw。如需按关键词/账号黑名单过滤,在 collect 层加一层,不改 fetch
- **报告模板**:每个 slot 对应一份 \`<slot>.md\`,用占位符模板化
- **摘要 prompt**:根据该 topic 的具体问题演化
`;
}

/**
 * 为一个 slot 生成最小可跑的 prompt 骨架。
 * 用户需要手动把"要回答的问题"段落换成真问题。
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

把报告按你设计的结构写入 \`{WIKI_PATH}\`。

## 工具:按需深抓 article

如果某个问题真的需要读 Twitter Article 全文(raw 里只有 \`🖼️ article: "title"\` 和 statusUrl),
在回答前跑:

\`\`\`
{FETCH_ARTICLE_CMD} <status_url>
\`\`\`

输出是缓存 markdown 的绝对路径(首次抓取后缓存到 \`{ARTICLE_CACHE_DIR}\`,同月内复用);
用 Read 工具读该文件取正文。只在**确有需要**时抓,不要批量预抓。

普通长推已在 collect 阶段自动 hydrate 为完整正文,不需要再深抓。
`;
}

/**
 * 校验 topic spec 的合法性,返回第一个错误字符串或 null(通过)。
 * 本函数是纯函数,不访问文件系统,方便 agent 端在写盘前自检。
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
  // `slots` 省略是合法的 —— 和运行时 loadTopic.validateSlots() 保持一致:
  // 缺省会 fallback 到 DEFAULT_SLOTS(v1 默认三槽)。但存在时必须合法。
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
 * 把一个 spec 写盘(SCHEMA.md + slot 模板 + config.json 注册)。
 * 不覆盖已有文件 / 已有 config 条目;冲突 throw。返回写入的文件列表。
 *
 * @param {string} rootDir    perch 仓库根目录
 * @param {object} spec       { topic, description, dataPath, sources, slots }
 * @returns {Promise<string[]>}
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

  // spec.slots 省略 → 用 DEFAULT_SLOTS;显式传入 → normalize window 默认 'today'。
  // SCHEMA.md 总是**显式写出** slots,让人打开文件就能看到完整配置(不依赖运行时 fallback)。
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

// —— 可执行入口(交互向导 / --from-json) ——

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  await runMain();
}

async function runMain() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return;
  }

  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  const fromJsonIdx = argv.indexOf('--from-json');
  if (fromJsonIdx >= 0) {
    const file = argv[fromJsonIdx + 1];
    if (!file) {
      err('ERROR: --from-json requires a file path');
      process.exit(1);
    }
    await runFromJson(rootDir, file);
    return;
  }

  await runInteractive(rootDir);
}

async function runFromJson(rootDir, file) {
  const spec = JSON.parse(await readFile(file, 'utf-8'));
  try {
    const written = await scaffoldTopic(rootDir, spec);
    console.log(`✅ Topic "${spec.topic}" 已创建。`);
    for (const p of written) console.log(`  wrote ${path.relative(rootDir, p)}`);
    printNextSteps(spec.topic);
  } catch (e) {
    err(`ERROR: ${e.message}`);
    process.exit(1);
  }
}

async function runInteractive(rootDir) {
  const rl = readline.createInterface({ input, output });

  try {
    console.log(`\nPerch — 新 Topic 向导\n`);
    console.log(`将要创建:`);
    console.log(`  1) templates/topics/<slug>/SCHEMA.md + <slot>.md`);
    console.log(`  2) config.json 里注册新 topic`);
    console.log(`按 Ctrl-C 可随时中止(未写入任何文件)。\n`);

    const configPath = path.join(rootDir, 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf-8'));

    const slug = await askValidated(rl, 'Topic slug(小写字母/数字/短横线,如 ai-radar):', v => {
      if (!/^[a-z][a-z0-9-]*$/.test(v)) return 'slug 必须匹配 ^[a-z][a-z0-9-]*$';
      if (config.topics?.[v]) return `config.json 里已有 topic "${v}"`;
      if (existsSync(path.join(rootDir, 'templates', 'topics', v))) return `目录已存在`;
      return null;
    });

    const description = (await rl.question('描述(一行,用于人读):')).trim() || slug;

    const dataPath = await askValidated(rl,
      '数据目录绝对路径(建议 iCloud / Obsidian 同步盘):',
      v => (v && path.isAbsolute(v)) ? null : '请填写绝对路径(以 / 开头)');

    console.log('\n-- 数据源(sources,至少一条)--');
    const sources = [];
    while (true) {
      const more = sources.length === 0
        ? 'y'
        : (await rl.question(`已添加 ${sources.length} 个 source,继续?(y/N):`)).trim().toLowerCase();
      if (more !== 'y') break;
      const type = await askValidated(rl, '  类型(list / profile):',
        v => ['list', 'profile'].includes(v) ? null : '只接受 list 或 profile');
      const target = await askValidated(rl,
        type === 'list'
          ? '  target(list URL):'
          : '  target(handle 或 profile URL):',
        v => v ? null : '不能为空');
      const srcSlug = await askValidated(rl, '  source slug(本 topic 内唯一):', v => {
        if (!/^[a-z][a-z0-9-]*$/.test(v)) return 'slug 必须匹配 ^[a-z][a-z0-9-]*$';
        if (sources.some(s => s.slug === v)) return `已有同名 source: ${v}`;
        return null;
      });
      const label = (await rl.question('  label(人读备注,可留空):')).trim();
      const limitRaw = (await rl.question('  fetch_limit(默认 80):')).trim();
      const fl = limitRaw ? Number(limitRaw) : 80;
      const fetch_limit = Number.isInteger(fl) && fl >= 1 && fl <= 200 ? fl : 80;
      sources.push({ slug: srcSlug, type, target, ...(label ? { label } : {}), fetch_limit });
    }
    if (sources.length === 0) {
      console.log('!! 至少需要一个 source'); process.exit(1);
    }

    console.log('\n-- 时段槽位(slots)--');
    console.log('  [1] 默认 3 槽(morning@5 / noon@12 / evening@18)');
    console.log('  [2] 默认 4 槽(early@6 / morning@10 / afternoon@14 / evening@19)');
    console.log('  [3] 自定义');
    const choice = await askValidated(rl, '选择(1/2/3):',
      v => ['1', '2', '3'].includes(v) ? null : '请输入 1、2 或 3');

    let slots;
    if (choice === '1') {
      slots = [
        { name: 'morning', start_hour: 5, window: 'today' },
        { name: 'noon', start_hour: 12, window: 'today' },
        { name: 'evening', start_hour: 18, window: 'today' },
      ];
    } else if (choice === '2') {
      slots = [
        { name: 'early', start_hour: 6, window: 'today' },
        { name: 'morning', start_hour: 10, window: 'today' },
        { name: 'afternoon', start_hour: 14, window: 'today' },
        { name: 'evening', start_hour: 19, window: 'today' },
      ];
    } else {
      slots = [];
      while (true) {
        const more = slots.length === 0
          ? 'y'
          : (await rl.question(`已 ${slots.length} 个 slot,继续?(y/N):`)).trim().toLowerCase();
        if (more !== 'y') break;
        const name = await askValidated(rl, '  slot name(不得为 "now"):', v => {
          if (!/^[a-z][a-z0-9-]*$/.test(v)) return '必须匹配 ^[a-z][a-z0-9-]*$';
          if (v === 'now') return '"now" 是保留字';
          if (slots.some(s => s.name === v)) return `已有同名: ${v}`;
          return null;
        });
        const h = await askValidated(rl, '  start_hour(0-23):', v => {
          const n = Number(v);
          if (!Number.isInteger(n) || n < 0 || n > 23) return '必须 0-23';
          if (slots.some(s => s.start_hour === n)) return `已有同 start_hour`;
          return null;
        });
        const win = await askValidated(rl, '  window(today / since_prev,默认 today):', v => {
          const x = v || 'today';
          return ['today', 'since_prev'].includes(x) ? null : '只接受 today 或 since_prev';
        });
        slots.push({ name, start_hour: Number(h), window: win || 'today' });
      }
      if (slots.length === 0) {
        console.log('!! 至少需要一个 slot'); process.exit(1);
      }
    }
    slots.sort((a, b) => a.start_hour - b.start_hour);

    const spec = { topic: slug, description, dataPath, sources, slots };
    console.log('\n将生成的配置(preview):');
    console.log(JSON.stringify(spec, null, 2));
    const go = (await rl.question('\n确认写入?(y/N):')).trim().toLowerCase();
    if (go !== 'y') {
      console.log('已中止,未写入任何文件。');
      return;
    }

    const written = await scaffoldTopic(rootDir, spec);
    console.log(`\n✅ Topic "${slug}" 已创建。`);
    for (const p of written) console.log(`  wrote ${path.relative(rootDir, p)}`);
    printNextSteps(slug);
  } finally {
    rl.close();
  }
}

async function askValidated(rl, question, validate) {
  while (true) {
    const v = (await rl.question(`${question} `)).trim();
    const e = validate(v);
    if (!e) return v;
    console.log(`  ! ${e}`);
  }
}

function printNextSteps(slug) {
  console.log(`\n下一步:`);
  console.log(`  1) 编辑 templates/topics/${slug}/<slot>.md,把占位问题换成真问题`);
  console.log(`  2) 确认用户日常 Chrome 已开 --remote-debugging-port=9222 并登录 X`);
  console.log(`  3) Dry:  node scripts/collect.mjs --topic ${slug} --dry`);
  console.log(`  4) 正式: node scripts/collect.mjs --topic ${slug}`);
  console.log(`  5) 报告: node scripts/report.mjs now --topic ${slug}\n`);
  console.log(`字段/架构详解见 docs/TOPIC_AUTHORING.md。\n`);
}

function printHelp() {
  console.log(`\nPerch — 新 Topic 向导\n`);
  console.log(`用法:`);
  console.log(`  node scripts/new-topic.mjs                   — 交互模式`);
  console.log(`  node scripts/new-topic.mjs --from-json <f>   — 从 JSON 读 spec,无交互`);
  console.log(`  node scripts/new-topic.mjs --help\n`);
  console.log(`--from-json 的 JSON 形态:`);
  console.log(`  {
    "topic": "my-topic",
    "description": "...",
    "dataPath": "/absolute/path",
    "sources": [
      { "slug": "s1", "type": "list", "target": "https://x.com/i/lists/123", "label": "...", "fetch_limit": 80 }
    ],
    "slots": [                                   // 省略整个 slots 字段 → 默认三槽 morning@5 / noon@12 / evening@18
      { "name": "morning", "start_hour": 6, "window": "today" }
    ]
  }\n`);
  console.log(`字段详解见 docs/TOPIC_AUTHORING.md。\n`);
}

function err(msg) {
  process.stderr.write(`[new-topic] ${msg}\n`);
}
