#!/usr/bin/env node
// rotate.mjs — /perch rotate 入口
//
// 把 topic 数据目录下的非当月 raw/daily / wiki/daily 文件搬到 archive/YYYY-MM/。
// Topic Wiki 和 summaries.md 在 v1 不动(见 lib/rotate.mjs 注释)。
//
// 用法:
//   node scripts/rotate.mjs [--topic <slug>] [--dry-run]
//
// 幂等:重跑 no-op(没有可归档月份就正常退出 0)。
//
// 退出码:
//   0 — 正常(包括 "no archivable months" 和 dry-run)
//   1 — 配置 / IO 致命错误

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadTopic } from '../lib/topic.mjs';
import { findArchivableMonths, planArchive, executePlan } from '../lib/rotate.mjs';

const argv = process.argv.slice(2);
const getFlag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};
const hasFlag = (name) => argv.includes(`--${name}`);

const topicSlug = getFlag('topic');
const isDry = hasFlag('dry-run');

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let topic;
try {
  topic = await loadTopic(topicSlug, rootDir);
} catch (err) {
  log(`ERROR loading topic: ${err.message}`);
  process.exit(1);
}

log(`topic=${topic.slug} dataPath=${topic.dataPath}${isDry ? ' (dry-run)' : ''}`);

const months = await findArchivableMonths(topic);
if (months.length === 0) {
  log('no archivable months found (likely all files belong to current month)');
  process.exit(0);
}
log(`archivable months: ${months.join(', ')}`);

let totalMoves = 0;
for (const month of months) {
  const plan = await planArchive(topic, month);
  log(`-- ${month}: ${plan.moves.length} file(s) → ${path.relative(topic.dataPath, plan.archiveDir)}/`);
  for (const move of plan.moves) {
    const relFrom = path.relative(topic.dataPath, move.from);
    const relTo = path.relative(topic.dataPath, move.to);
    log(`   ${relFrom}  →  ${relTo}`);
  }
  if (!isDry) {
    try {
      await executePlan(plan);
    } catch (err) {
      log(`ERROR archiving ${month}: ${err.message}`);
      process.exit(1);
    }
  }
  totalMoves += plan.moves.length;
}

log(`total: ${totalMoves} file(s) ${isDry ? 'would be' : 'were'} archived`);

function log(msg) {
  process.stderr.write(`[rotate] ${msg}\n`);
}
