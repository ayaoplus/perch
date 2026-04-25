#!/usr/bin/env node
// perch.mjs — Perch v3 主 CLI(单入口,subcommand 路由到 Topic methods)
//
// v3 形态:
//   ingest    抓 X → dedup → 全局重排 → 写 raw(默认 today raw,可 --out)
//   report    渲染 prompt → (skill 模式)Claude 接棒(取代 v2 analyze + digest)
//   enrich    深抓 Twitter Article → 月度缓存
//   archive   月度归档
//   admin     Topic 配置 CRUD(list / create)

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

const VALUE_FLAGS = new Set([
  '--topic', '--prompt', '--inputs', '--date', '--section',
  '--url', '--limit', '--from-json', '--out', '--llm',
]);

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
    case 'report':   await cmdReport();   break;
    case 'enrich':   await cmdEnrich();   break;
    case 'archive':  await cmdArchive();  break;
    case 'admin':    await cmdAdmin();    break;
    default:
      err(`unknown subcommand: ${subcommand}`);
      printHelp();
      process.exit(1);
  }
} catch (e) {
  err(e.message);
  if (process.env.PERCH_DEBUG) err(e.stack || '');
  process.exit(1);
}

// —— subcommand handlers ——

async function cmdIngest() {
  const topic = await Topic.load(flags.topic || null, rootDir);
  const limit = flags.limit != null ? Number(flags.limit) : undefined;
  const result = await topic.ingest({
    out: flags.out,
    dry: !!flags.dry,
    limit,
  });
  if (result.allSourcesFailed) {
    err('all sources failed to fetch');
    process.exit(2);
  }
  if (flags.dry) {
    process.stdout.write(JSON.stringify({
      topic: result.topic,
      date: result.date,
      rawPath: result.rawPath,
      fetched: result.fetched,
      afterDedup: result.afterDedup,
      new: result.new,
      sample: result.sample || [],
    }, null, 2) + '\n');
  }
}

async function cmdReport() {
  if (!flags.prompt) {
    err('report: --prompt <name> is required');
    process.exit(1);
  }
  const topic = await Topic.load(flags.topic || null, rootDir);
  const inputs = flags.inputs ? splitInputs(flags.inputs) : undefined;

  // --llm 优先 → env PERCH_LLM_MODE → 默认 'skill'
  const llmMode = (flags.llm || process.env.PERCH_LLM_MODE || 'skill').toLowerCase();
  if (!['skill', 'direct'].includes(llmMode)) {
    err(`report: --llm must be 'skill' or 'direct', got: ${llmMode}`);
    process.exit(1);
  }

  await topic.report(flags.prompt, {
    inputs,
    date: flags.date || undefined,
    section: flags.section || undefined,
    llm: llmMode,
    debug: !!process.env.PERCH_LLM_DEBUG,
  });
  // skill 模式 prompt 走 stdout;direct 模式 LLM 完成后 lib/llm.mjs 已打日志到 stderr
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
    process.stdout.write(`\nPerch v3 — 新 Topic 向导\n\n`);
    process.stdout.write(`将要创建:\n`);
    process.stdout.write(`  1) templates/topics/<slug>/SCHEMA.md\n`);
    process.stdout.write(`  2) templates/topics/<slug>/<prompt>.md(每个 prompt 一份)\n`);
    process.stdout.write(`  3) config.json 里注册新 topic\n`);
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

    process.stdout.write('\n-- Prompt 模板 --\n');
    process.stdout.write('  [1] 默认 1 份(default)\n');
    process.stdout.write('  [2] 早午晚 3 份(morning / noon / evening)\n');
    process.stdout.write('  [3] 自定义(逗号分隔,如 "morning,evening,weekly")\n');
    const choice = await askValidated(rl, '选择(1/2/3):',
      v => ['1', '2', '3'].includes(v) ? null : '请输入 1、2 或 3');

    let prompts;
    if (choice === '1') {
      prompts = ['default'];
    } else if (choice === '2') {
      prompts = ['morning', 'noon', 'evening'];
    } else {
      const raw = await askValidated(rl, '  prompt 名字(逗号分隔,每个匹配 ^[a-z][a-z0-9-]*$):',
        v => {
          const arr = v.split(',').map(s => s.trim()).filter(Boolean);
          if (arr.length === 0) return '至少一个';
          for (const n of arr) {
            if (!/^[a-z][a-z0-9-]*$/.test(n)) return `"${n}" 不合法`;
          }
          return null;
        });
      prompts = raw.split(',').map(s => s.trim()).filter(Boolean);
    }

    const spec = { topic: slug, description, dataPath, sources, prompts };
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

function splitInputs(s) {
  return String(s).split(',').map(p => p.trim()).filter(Boolean);
}

function printNextSteps(slug) {
  process.stdout.write(`\n下一步:\n`);
  process.stdout.write(`  1) 编辑 templates/topics/${slug}/<prompt>.md,把占位问题换成真问题\n`);
  process.stdout.write(`  2) 确认用户日常 Chrome 已开 --remote-debugging-port=9222 并登录 X\n`);
  process.stdout.write(`  3) Dry:    node scripts/perch.mjs ingest --topic ${slug} --dry\n`);
  process.stdout.write(`  4) 正式:  node scripts/perch.mjs ingest --topic ${slug}\n`);
  process.stdout.write(`  5) 报告:  node scripts/perch.mjs report --topic ${slug} --prompt <name>\n`);
  process.stdout.write(`字段/架构详解见 docs/TOPIC_AUTHORING.md。\n\n`);
}

function printHelp() {
  process.stdout.write(`
Perch v3 — 多 Topic 个人信息漏斗(调度由外部决定)

用法:
  node scripts/perch.mjs <subcommand> [flags]

Subcommands(对应 Topic methods):
  ingest    抓 X → 跨源去重 → 全局时间重排 → 写 raw(默认 today raw)
  report    渲染 prompt → (skill 模式)Claude 接棒生成 wiki section / summary
  enrich    深抓单条 Twitter Article → 月度缓存
  archive   月度归档:非当月 raw / wiki / cache → archive/YYYY-MM/
  admin     Topic 配置 CRUD(list / create)

常用例:
  node scripts/perch.mjs ingest --topic ai-radar [--out path] [--dry] [--limit 80]
  node scripts/perch.mjs report --topic ai-radar --prompt morning
  node scripts/perch.mjs report --topic ai-radar --prompt evening --date 2026-04-23
  node scripts/perch.mjs report --topic ai-radar --prompt weekly --inputs "raw/daily/2026-04-{20..26}.md"
  node scripts/perch.mjs enrich --topic ai-radar --url <status_url>
  node scripts/perch.mjs archive --topic ai-radar [--dry-run]
  node scripts/perch.mjs admin list
  node scripts/perch.mjs admin create [--from-json spec.json]

调度由外部 cron / openclaw / agent 完成。典型 cron:
  0 8  * * *  perch ingest --topic ai-radar && perch report --topic ai-radar --prompt morning
  0 13 * * *  perch ingest --topic ai-radar && perch report --topic ai-radar --prompt noon
  0 19 * * *  perch ingest --topic ai-radar && perch report --topic ai-radar --prompt evening

--topic 缺省 → config.json 的 default_topic
--inputs 缺省 → today raw 单文件
--date   缺省 → today(topic.timezone)
--section 缺省 → = --prompt
--llm    缺省 → 'skill'(env PERCH_LLM_MODE 可覆盖);'direct' 模式连接真实 LLM API

LLM Direct 模式(脱离 Claude Code 会话,适合 cron / openclaw):
  Anthropic:  ANTHROPIC_API_KEY=sk-ant-... perch report ... --llm direct
  OpenAI:     OPENAI_API_KEY=sk-... PERCH_LLM_PROVIDER=openai perch report ... --llm direct
  其他兼容:   再加 PERCH_LLM_BASE_URL=https://openrouter.ai/api/v1 (或 Together / 本地 vLLM)

  env: PERCH_LLM_PROVIDER (anthropic/openai/stub) / PERCH_LLM_MODEL / PERCH_LLM_MAX_TOKENS
       PERCH_LLM_MAX_RETRIES (默认 5,429/5xx/网络抖动自动退避) / PERCH_LLM_INITIAL_BACKOFF_MS
       PERCH_LLM_DEBUG=1

完整设计见 docs/DESIGN.md。
`);
}

function log(msg) {
  process.stderr.write(`[perch] ${msg}\n`);
}

function err(msg) {
  process.stderr.write(`[perch] ERROR: ${msg}\n`);
}
