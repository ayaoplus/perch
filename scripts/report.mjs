#!/usr/bin/env node
// report.mjs — /perch report 入口
//
// 读 topic 配置 + slot(morning/noon/evening/now),读对应 prompt 模板,做占位符替换,
// 把完整 prompt 打到 stdout 给**当前 Claude 会话**。Claude 读完 prompt 后会自己执行:
// 读 raw → 生成 wiki → 写到 WIKI_PATH。
//
// 本脚本只做"准备",不直接调 LLM(v1 走 Claude Code skill 模式,cron 自动化留 v2)。
//
// 用法:
//   node scripts/report.mjs [morning|noon|evening|now] [--topic <slug>]
//
// `now` 根据当前时间(topic.timezone)自动选:5–11→morning,12–17→noon,其他→evening。
//
// 占位符约定(prompt 模板可用这些):
//   {TOPIC_SLUG}      — topic slug(例 ai-radar)
//   {DATE}            — YYYY-MM-DD(按 topic.timezone)
//   {SLOT}            — morning / noon / evening
//   {RAW_PATH}        — 当日 raw 文件绝对路径
//   {WIKI_PATH}       — 本次 wiki 产出的绝对路径
//   {SUMMARIES_PATH}  — summaries.md 绝对路径
//   {SOURCES}         — 人读的 source 描述(从 SCHEMA.sources 拼)

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadTopic } from '../lib/topic.mjs';
import { getTodayDate } from '../lib/normalize.mjs';
import { rawDailyPath, wikiDailyPath, summariesPath } from '../lib/wiki.mjs';

const SLOTS = ['morning', 'noon', 'evening', 'now'];

const argv = process.argv.slice(2);
const getFlag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};
const slotArg = (argv.find(a => !a.startsWith('--')) || 'now').toLowerCase();
const topicSlug = getFlag('topic');

if (!SLOTS.includes(slotArg)) {
  log(`ERROR: invalid slot "${slotArg}" — use one of: ${SLOTS.join(', ')}`);
  process.exit(1);
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let topic;
try {
  topic = await loadTopic(topicSlug, rootDir);
} catch (err) {
  log(`ERROR loading topic: ${err.message}`);
  process.exit(1);
}

const slot = slotArg === 'now' ? pickSlot(new Date(), topic.timezone) : slotArg;
const date = getTodayDate(topic.timezone);

const promptPath = path.join(topic.templatesDir, `${slot}.md`);
let template;
try {
  template = await readFile(promptPath, 'utf-8');
} catch (err) {
  log(`ERROR reading prompt template ${promptPath}: ${err.message}`);
  process.exit(1);
}

// 拼 {SOURCES} 的人读描述
const sourcesDesc = topic.sources
  .map(s => {
    const kind = s.type === 'list' ? 'X List' : 'X Profile';
    const name = s.label || s.slug;
    return `${kind} "${name}"`;
  })
  .join(' + ');

const filled = template
  .replace(/\{TOPIC_SLUG\}/g, topic.slug)
  .replace(/\{DATE\}/g, date)
  .replace(/\{SLOT\}/g, slot)
  .replace(/\{RAW_PATH\}/g, rawDailyPath(topic, date))
  .replace(/\{WIKI_PATH\}/g, wikiDailyPath(topic, date, slot))
  .replace(/\{SUMMARIES_PATH\}/g, summariesPath(topic))
  .replace(/\{SOURCES\}/g, sourcesDesc);

log(`topic=${topic.slug} slot=${slot} date=${date}`);
log(`rawPath=${rawDailyPath(topic, date)}`);
log(`wikiPath=${wikiDailyPath(topic, date, slot)}`);

// stdout 输出填好的 prompt — 当前 Claude 会话应接棒读 RAW_PATH,产出 wiki 内容,写入 WIKI_PATH
process.stdout.write(filled);

// —— helpers ——

function log(msg) {
  process.stderr.write(`[report] ${msg}\n`);
}

// 按指定时区拿当前小时,映射到 slot
function pickSlot(now, timezone) {
  const hour = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', hour12: false,
  }).format(now));
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 18) return 'noon';
  return 'evening';
}
