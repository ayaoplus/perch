#!/usr/bin/env node
// perch.mjs — Perch v2 主 CLI(单入口,subcommand 路由到 Topic methods)
//
// 设计意图:CLI 是 Topic.method 的薄 dispatcher,不含业务语义。所有领域逻辑都在
// lib/{ingest,analyze,digest,enrich,archive,admin}.mjs。这里只做:
//   - 解析 subcommand 和 flags
//   - 加载 Topic
//   - 调对应 method
//   - 把结果或错误格式化输出
//
// Subcommands:
//   ingest  --topic <slug> [--dry] [--limit N]
//   analyze --topic <slug> [--slot <name>|now] [--date YYYY-MM-DD]
//   digest  --topic <slug> [--date YYYY-MM-DD]
//   enrich  --topic <slug> --url <status_url> [--date YYYY-MM-DD]
//   archive --topic <slug> [--dry-run]
//   admin   list
//   admin   create [--from-json <spec.json>]
//
// `--topic` 缺省 → config.json 的 default_topic。

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { Topic } from '../lib/topic.mjs';
import { scaffoldTopic } from '../lib/admin.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// —— CLI 解析 ——

const VALUE_FLAGS = new Set(['--topic', '--slot', '--date', '--url', '--limit', '--from-json', '--month']);

function parseArgs(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      if (VALUE_FLAGS.has(a)) {
        flags[a.slice(2)] = args[i + 1];
        i++;
      } else {
        flags[a.slice(2)] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

const argv = process.argv.slice(2);
const { flags, positional } = parseArgs(argv);
const subcommand = positional[0] || null;

if (flags.help || flags.h || !subcommand) {
  printHelp();
  process.exit(subcommand ? 0 : 1);
}

try {
  switch (subcommand) {
    case 'ingest':   await cmdIngest();   break;
    case 'analyze':  await cmdAnalyze();  break;
    case 'digest':   await cmdDigest();   break;
    case 'enrich':   await cmdEnrich();   break;
    case 'archive':  await cmdArchive();  break;
    case 'admin':    await cmdAdmin();    break;
    default:
      err(`unknown subcommand: ${subcommand}`);
      printHelp();
      process.exit(1);
  }
} catch (e) {
  // lib 模块的错误已自带 "<role>: ..." 上下文,这里只输出 message,避免重复前缀
  err(e.message);
  if (process.env.PERCH_DEBUG) err(e.stack || '');
  process.exit(1);
}

// —— subcommand handlers ——

async function cmdIngest() {
  const topic = await Topic.load(flags.topic || null, rootDir);
  const limit = flags.limit != null ? Number(flags.limit) : undefined;
  const result = await topic.ingest({ dry: !!flags.dry, limit });
  if (result.allSourcesFailed) {
    err('all sources failed to fetch');
    process.exit(2);
  }
  if (flags.dry) {
    process.stdout.write(JSON.stringify({
      topic: result.topic,
      date: result.date,
      fetched: result.fetched,
      afterDedup: result.afterDedup,
      new: result.new,
      sample: result.sample || [],
    }, null, 2) + '\n');
  }
}

async function cmdAnalyze() {
  const topic = await Topic.load(flags.topic || null, rootDir);
  const slotArg = flags.slot || 'now';
  await topic.analyze(slotArg, {
    date: flags.date || undefined,
    llm: 'skill',
  });
  // analyze 在 skill 模式下已经把 prompt 打到 stdout,这里无需额外输出
}

async function cmdDigest() {
  const topic = await Topic.load(flags.topic || null, rootDir);
  await topic.digest({
    date: flags.date || undefined,
    llm: 'skill',
  });
}

async function cmdEnrich() {
  if (!flags.url) {
    err('enrich: --url <status_url> is required');
    process.exit(1);
  }
  const topic = await Topic.load(flags.topic || null, rootDir);
  const result = await topic.enrich(flags.url, {
    date: flags.date || undefined,
  });
  process.stdout.write(result.path + '\n');
}

async function cmdArchive() {
  const topic = await Topic.load(flags.topic || null, rootDir);
  await topic.archive({ dryRun: !!flags['dry-run'] });
}

async function cmdAdmin() {
  const action = positional[1] || 'help';
  if (action === 'list') {
    const list = await Topic.list(rootDir);
    if (list.length === 0) {
      log('no topics registered in config.json');
      return;
    }
    for (const t of list) {
      const mark = t.isDefault ? '*' : ' ';
      process.stdout.write(`${mark} ${t.slug.padEnd(20)}  ${t.description}\n`);
      process.stdout.write(`    path: ${t.path}\n`);
    }
    process.stdout.write('\n("*" = default topic)\n');
    return;
  }
  if (action === 'create') {
    if (flags['from-json']) {
      await runAdminCreateFromJson(flags['from-json']);
    } else {
      await runAdminCreateInteractive();
    }
    return;
  }
  err(`unknown admin action: ${action}. Try: list / create`);
  process.exit(1);
}

async function runAdminCreateFromJson(file) {
  const spec = JSON.parse(await readFile(file, 'utf-8'));
  const written = await scaffoldTopic(rootDir, spec);
  log(`✅ Topic "${spec.topic}" 已创建。`);
  for (const p of written) log(`  wrote ${path.relative(rootDir, p)}`);
  printNextSteps(spec.topic);
}

async function runAdminCreateInteractive() {
  const rl = readline.createInterface({ input, output });

  try {
    process.stdout.write(`\nPerch — 新 Topic 向导\n\n`);
    process.stdout.write(`将要创建:\n`);
    process.stdout.write(`  1) templates/topics/<slug>/SCHEMA.md + <slot>.md\n`);
    process.stdout.write(`  2) config.json 里注册新 topic\n`);
    process.stdout.write(`按 Ctrl-C 可随时中止(未写入任何文件)。\n\n`);

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

    process.stdout.write('\n-- 数据源(sources,至少一条)--\n');
    const sources = [];
    while (true) {
      const more = sources.length === 0
        ? 'y'
        : (await rl.question(`已添加 ${sources.length} 个 source,继续?(y/N):`)).trim().toLowerCase();
      if (more !== 'y') break;
      const type = await askValidated(rl, '  类型(list / profile):',
        v => ['list', 'profile'].includes(v) ? null : '只接受 list 或 profile');
      const target = await askValidated(rl,
        type === 'list' ? '  target(list URL):' : '  target(handle 或 profile URL):',
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
      process.stdout.write('!! 至少需要一个 source\n');
      process.exit(1);
    }

    process.stdout.write('\n-- 时段槽位(slots)--\n');
    process.stdout.write('  [1] 默认 3 槽(morning@5 / noon@12 / evening@18)\n');
    process.stdout.write('  [2] 默认 4 槽(early@6 / morning@10 / afternoon@14 / evening@19)\n');
    process.stdout.write('  [3] 自定义\n');
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
        process.stdout.write('!! 至少需要一个 slot\n');
        process.exit(1);
      }
    }
    slots.sort((a, b) => a.start_hour - b.start_hour);

    const spec = { topic: slug, description, dataPath, sources, slots };
    process.stdout.write('\n将生成的配置(preview):\n');
    process.stdout.write(JSON.stringify(spec, null, 2) + '\n');
    const go = (await rl.question('\n确认写入?(y/N):')).trim().toLowerCase();
    if (go !== 'y') {
      process.stdout.write('已中止,未写入任何文件。\n');
      return;
    }

    const written = await scaffoldTopic(rootDir, spec);
    process.stdout.write(`\n✅ Topic "${slug}" 已创建。\n`);
    for (const p of written) process.stdout.write(`  wrote ${path.relative(rootDir, p)}\n`);
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
    process.stdout.write(`  ! ${e}\n`);
  }
}

function printNextSteps(slug) {
  process.stdout.write(`\n下一步:\n`);
  process.stdout.write(`  1) 编辑 templates/topics/${slug}/<slot>.md,把占位问题换成真问题\n`);
  process.stdout.write(`  2) 确认用户日常 Chrome 已开 --remote-debugging-port=9222 并登录 X\n`);
  process.stdout.write(`  3) Dry:    node scripts/perch.mjs ingest --topic ${slug} --dry\n`);
  process.stdout.write(`  4) 正式:  node scripts/perch.mjs ingest --topic ${slug}\n`);
  process.stdout.write(`  5) 报告:  node scripts/perch.mjs analyze --topic ${slug}\n`);
  process.stdout.write(`  6) 概览:  node scripts/perch.mjs digest --topic ${slug}\n`);
  process.stdout.write(`字段/架构详解见 docs/TOPIC_AUTHORING.md。\n\n`);
}

function printHelp() {
  process.stdout.write(`
Perch v2 — 多 Topic 个人信息漏斗

用法:
  node scripts/perch.mjs <subcommand> [flags]

Subcommands(对应 Topic methods):
  ingest    抓 X → 跨源去重 → 全局时间重排 → 写当日 raw
  analyze   渲染 slot prompt → (skill 模式)Claude 接棒生成 wiki section
  digest    渲染 digest prompt → Claude 接棒生成日概览 → prepend summaries.md
  enrich    深抓单条 Twitter Article → 月度缓存
  archive   月度归档:非当月 raw / wiki / cache → archive/YYYY-MM/
  admin     Topic 配置 CRUD(list / create)

常用例:
  node scripts/perch.mjs ingest --topic ai-radar [--dry] [--limit 80]
  node scripts/perch.mjs analyze --topic ai-radar [--slot evening|now] [--date YYYY-MM-DD]
  node scripts/perch.mjs digest --topic ai-radar [--date YYYY-MM-DD]
  node scripts/perch.mjs enrich --topic ai-radar --url <status_url>
  node scripts/perch.mjs archive --topic ai-radar [--dry-run]
  node scripts/perch.mjs admin list
  node scripts/perch.mjs admin create [--from-json spec.json]

--topic 缺省 → config.json 的 default_topic
完整设计见 docs/DESIGN.md。
`);
}

function log(msg) {
  process.stderr.write(`[perch] ${msg}\n`);
}

function err(msg) {
  process.stderr.write(`[perch] ERROR: ${msg}\n`);
}
