#!/usr/bin/env node
// wiki-write.mjs — 从 stdin 读 markdown,对 topic 当日 wiki 做 slot 级幂等 upsert
//
// 设计意图:report.mjs 跑 skill 模式时,Claude 生成报告内容后用 Bash 把内容管道给这个脚本,
// 由脚本负责"按 slot 幂等替换 section"的文件结构维护。职责分工:
//   - Claude:生成自己那个 slot 的 markdown 报告(不关心文件位置 / 其他 slot 的 section)
//   - 本脚本:定位 `## slot: <name>` 段,替换或插入,其他 slot section 原样保留
//
// 和 fetch-article.mjs 同构 — Claude 在 prompt 流程中需要"持久化副作用"就 Bash 调这类脚本。
//
// 用法:
//   {report 生成的 markdown 内容} | node scripts/wiki-write.mjs --topic <slug> --date <YYYY-MM-DD> --slot <slot>
//
// 或 heredoc:
//   node scripts/wiki-write.mjs --topic ai-radar --date 2026-04-24 --slot morning <<'PERCH_EOF'
//   # 🌅 AI Radar morning 简报 — 2026-04-24
//   ...
//   PERCH_EOF
//
// 退出码:
//   0 — 成功(stdout = 被 upsert 的 wiki 文件绝对路径)
//   1 — 参数 / 配置错误 / stdin 为空

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadTopic } from '../lib/topic.mjs';
import { upsertWikiSlotSection } from '../lib/wiki.mjs';

// —— CLI 解析 ——

const argv = process.argv.slice(2);
const flags = {};
const VALUE_FLAGS = new Set(['--topic', '--date', '--slot']);
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
if (!flags.slot) die('missing --slot');
if (!/^\d{4}-\d{2}-\d{2}$/.test(flags.date)) die(`--date must be YYYY-MM-DD, got: ${flags.date}`);

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let topic;
try {
  topic = await loadTopic(flags.topic || null, rootDir);
} catch (e) {
  die(`loadTopic: ${e.message}`);
}

if (!topic.slots.find(s => s.name === flags.slot)) {
  die(`slot "${flags.slot}" not defined in topic "${topic.slug}"; available: ${topic.slots.map(s => s.name).join(', ')}`);
}

// —— 读 stdin ——

const body = await readStdin();
if (!body.trim()) die('stdin is empty — nothing to upsert');

// —— upsert ——

const written = await upsertWikiSlotSection(topic, flags.date, flags.slot, body, topic.slots);
process.stderr.write(`[wiki-write] upserted slot "${flags.slot}" (${body.length} chars) → ${written}\n`);
process.stdout.write(written + '\n');

// —— helpers ——

function die(msg) {
  process.stderr.write(`[wiki-write] ERROR: ${msg}\n`);
  process.exit(1);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}
