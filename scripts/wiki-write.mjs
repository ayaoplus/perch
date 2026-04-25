#!/usr/bin/env node
// wiki-write.mjs — 从 stdin 读 markdown,对 topic 当日 wiki 做 section 级幂等 upsert(v3)
//
// Agent tool。设计意图:report 跑 skill 模式时,Claude 生成报告内容后用 Bash 把内容
// 管道给这个脚本,由脚本负责"按 section 幂等替换"的文件结构维护。
//
// v3 改动:--slot 改为 --section(语义更通用,section 名由调用者决定,不再绑定 SCHEMA.slots)。
//
// 用法:
//   {report 生成的 markdown 内容} | node scripts/wiki-write.mjs --topic <slug> --date <YYYY-MM-DD> --section <name>
//
// heredoc 形式:
//   node scripts/wiki-write.mjs --topic ai-radar --date 2026-04-24 --section morning <<'PERCH_EOF'
//   # 🌅 AI Radar morning 简报 — 2026-04-24
//   ...
//   PERCH_EOF
//
// 退出码:
//   0 — 成功(stdout = 被 upsert 的 wiki 文件绝对路径)
//   1 — 参数 / 配置错误 / stdin 为空

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Topic } from '../lib/topic.mjs';
import { upsertWikiSection } from '../lib/wiki.mjs';

const argv = process.argv.slice(2);
const flags = {};
const VALUE_FLAGS = new Set(['--topic', '--date', '--section']);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    if (VALUE_FLAGS.has(a)) {
      flags[a.slice(2)] = argv[i + 1];
      i++;
    } else {
      flags[a.slice(2)] = true;
    }
  }
}

if (!flags.date) die('missing --date (YYYY-MM-DD)');
if (!flags.section) die('missing --section');
if (!/^\d{4}-\d{2}-\d{2}$/.test(flags.date)) die(`--date must be YYYY-MM-DD, got: ${flags.date}`);
if (!/^[a-z][a-z0-9-]*$/.test(flags.section)) die(`--section must match ^[a-z][a-z0-9-]*$, got: ${flags.section}`);

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let topic;
try {
  topic = await Topic.load(flags.topic || null, rootDir);
} catch (e) {
  die(`loadTopic: ${e.message}`);
}

const body = await readStdin();
if (!body.trim()) die('stdin is empty — nothing to upsert');

const written = await upsertWikiSection(topic, flags.date, flags.section, body);
process.stderr.write(`[wiki-write] upserted section "${flags.section}" (${body.length} chars) → ${written}\n`);
process.stdout.write(written + '\n');

function die(msg) {
  process.stderr.write(`[wiki-write] ERROR: ${msg}\n`);
  process.exit(1);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}
