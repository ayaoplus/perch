#!/usr/bin/env node
// summary-write.mjs — 从 stdin 读 markdown,prepend 到 topic 的 summaries.md
//
// Agent tool。设计意图:digest method 的 skill 模式下,Claude 生成完日概览的 5-7
// 句正文后,Bash heredoc pipe 到这个脚本,由脚本负责"按 ## YYYY-MM-DD 幂等
// upsert"的文件结构维护。
//
// 和 wiki-write.mjs 同构 — Claude 在 prompt 流程中需要"持久化副作用"就 Bash 调
// 这类脚本。
//
// 用法:
//   {claude 生成的概览正文} | node scripts/summary-write.mjs --topic <slug> --date <YYYY-MM-DD>
//
// heredoc 形式:
//   node scripts/summary-write.mjs --topic ai-radar --date 2026-04-24 <<'PERCH_EOF'
//   今日 OpenAI 发布 ... 主流 KOL 分歧在 ... 建议关注 ...
//   PERCH_EOF
//
// 退出码:
//   0 — 成功(stdout = summaries.md 绝对路径)
//   1 — 参数 / 配置错误 / stdin 为空

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Topic } from '../lib/topic.mjs';
import { prependSummaryEntry } from '../lib/wiki.mjs';

const argv = process.argv.slice(2);
const flags = {};
const VALUE_FLAGS = new Set(['--topic', '--date']);
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
if (!/^\d{4}-\d{2}-\d{2}$/.test(flags.date)) die(`--date must be YYYY-MM-DD, got: ${flags.date}`);

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let topic;
try {
  topic = await Topic.load(flags.topic || null, rootDir);
} catch (e) {
  die(`loadTopic: ${e.message}`);
}

const body = await readStdin();
if (!body.trim()) die('stdin is empty — nothing to upsert');

const written = await prependSummaryEntry(topic, flags.date, body);
process.stderr.write(`[summary-write] upserted ## ${flags.date} (${body.length} chars) → ${written}\n`);
process.stdout.write(written + '\n');

function die(msg) {
  process.stderr.write(`[summary-write] ERROR: ${msg}\n`);
  process.exit(1);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}
