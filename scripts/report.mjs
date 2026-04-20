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
//   {TOPIC_SLUG}         — topic slug(例 ai-radar)
//   {DATE}               — YYYY-MM-DD(按 topic.timezone)
//   {SLOT}               — 当前 slot name
//   {RAW_PATH}           — 当日 raw 文件绝对路径
//   {WIKI_PATH}          — 本次 wiki 产出的绝对路径
//   {SUMMARIES_PATH}     — summaries.md 绝对路径
//   {SOURCES}            — 人读的 source 描述(从 SCHEMA.sources 拼)
//   {WINDOW_TYPE}        — today | since_prev(取自 slot.window,缺省 today)
//   {WINDOW_START_LABEL} — 窗口起点,人读格式(如 "2026-04-20 00:00")
//   {WINDOW_END_LABEL}   — 窗口终点(当前触发时刻),同上格式
//   {ARTICLE_CACHE_DIR}  — 当月 article 缓存目录的绝对路径
//   {FETCH_ARTICLE_CMD}  — 按需深抓 article 的命令行前缀(模板里直接拼 status URL 用)

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadTopic } from '../lib/topic.mjs';
import { getTodayDate } from '../lib/normalize.mjs';
import { rawDailyPath, wikiDailyPath, summariesPath } from '../lib/wiki.mjs';
import { articleCacheDir } from '../lib/article-cache.mjs';

// "--X value" 形式的 flag,它们的 value 不该被当成 positional 参数。
const VALUE_FLAGS = new Set(['--topic']);

function parseArgs(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (VALUE_FLAGS.has(a)) {
        flags[name] = args[i + 1];
        i++;  // skip value
      } else {
        flags[name] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

const { flags, positional } = parseArgs(process.argv.slice(2));
const slotArg = (positional[0] || 'now').toLowerCase();
const topicSlug = flags.topic || null;

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let topic;
try {
  topic = await loadTopic(topicSlug, rootDir);
} catch (err) {
  log(`ERROR loading topic: ${err.message}`);
  process.exit(1);
}

// slot 名字是 topic 级配置:topic.slots 的 name 列表 + `now` 自动映射。
const validSlots = [...topic.slots.map(s => s.name), 'now'];
if (!validSlots.includes(slotArg)) {
  log(`ERROR: invalid slot "${slotArg}" for topic "${topic.slug}" — use one of: ${validSlots.join(', ')}`);
  process.exit(1);
}

const now = new Date();
const slot = slotArg === 'now' ? pickSlot(now, topic.timezone, topic.slots) : slotArg;
const date = getTodayDate(topic.timezone);

const slotDef = topic.slots.find(s => s.name === slot);
const windowInfo = computeWindow(slotDef, topic.slots, now, topic.timezone, date);

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

// {FETCH_ARTICLE_CMD}:在 prompt 里直接拼 <status_url> 即可
const rootDir_ = rootDir;
const fetchArticleCmd = `node ${path.join(rootDir_, 'scripts', 'fetch-article.mjs')} --topic ${topic.slug}`;

const filled = template
  .replace(/\{TOPIC_SLUG\}/g, topic.slug)
  .replace(/\{DATE\}/g, date)
  .replace(/\{SLOT\}/g, slot)
  .replace(/\{RAW_PATH\}/g, rawDailyPath(topic, date))
  .replace(/\{WIKI_PATH\}/g, wikiDailyPath(topic, date, slot))
  .replace(/\{SUMMARIES_PATH\}/g, summariesPath(topic))
  .replace(/\{SOURCES\}/g, sourcesDesc)
  .replace(/\{WINDOW_TYPE\}/g, windowInfo.type)
  .replace(/\{WINDOW_START_LABEL\}/g, windowInfo.startLabel)
  .replace(/\{WINDOW_END_LABEL\}/g, windowInfo.endLabel)
  .replace(/\{ARTICLE_CACHE_DIR\}/g, articleCacheDir(topic, date))
  .replace(/\{FETCH_ARTICLE_CMD\}/g, fetchArticleCmd);

log(`topic=${topic.slug} slot=${slot} date=${date} window=${windowInfo.type} [${windowInfo.startLabel} → ${windowInfo.endLabel}]`);
log(`rawPath=${rawDailyPath(topic, date)}`);
log(`wikiPath=${wikiDailyPath(topic, date, slot)}`);

// stdout 输出填好的 prompt — 当前 Claude 会话应接棒读 RAW_PATH,产出 wiki 内容,写入 WIKI_PATH
process.stdout.write(filled);

// —— helpers ——

function log(msg) {
  process.stderr.write(`[report] ${msg}\n`);
}

// 按指定时区拿当前小时,映射到 topic 自定义 slot。
//
// slots 已按 start_hour 升序(由 loadTopic 保证)。语义:每个 slot 覆盖 [start_hour, 下一 slot.start_hour)
// 的小时区间,最后一个 slot 环绕到次日第一个 slot 的 start_hour。hour 小于最小 start_hour 时
// 视为"上一轮未闭合的最后一个 slot"(例如凌晨 3 点,若最早 slot 是 5 点 morning,最晚 slot 是
// 18 点 evening,则 3 点 → evening)。
function pickSlot(now, timezone, slots) {
  const hour = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', hour12: false,
  }).format(now));
  let current = slots[slots.length - 1];  // 绕回前一天最后一个 slot
  for (const s of slots) {
    if (hour >= s.start_hour) current = s;
    else break;
  }
  return current.name;
}

// 计算 slot 的报告覆盖窗口,给 prompt 模板提供 {WINDOW_*} 占位符。
//
// window 语义:
//   - 'today'     — 覆盖今日 00:00 至当前触发时刻
//   - 'since_prev'— 覆盖上一 slot(按 start_hour 升序)的 start_hour 至当前触发时刻
//     · 若当前 slot 是首个(没有上一 slot),fallback 为 today — 避免跨昨日 raw 的复杂度
//
// label 格式:`YYYY-MM-DD HH:MM`(raw 里 block 标题行是 `MM-DD HH:MM`,Claude 用这个比较可
// 自行按时间过滤 block,不需要对 raw 做物理切片)。
function computeWindow(slotDef, slotsAll, now, timezone, todayDate) {
  const endLabel = `${todayDate} ${fmtHHMM(now, timezone)}`;
  const windowType = slotDef?.window || 'today';

  if (windowType === 'since_prev') {
    const idx = slotsAll.findIndex(s => s.name === slotDef.name);
    if (idx > 0) {
      const prev = slotsAll[idx - 1];
      const startLabel = `${todayDate} ${String(prev.start_hour).padStart(2, '0')}:00`;
      return { type: 'since_prev', startLabel, endLabel };
    }
    // 首个 slot,退化为 today
    return { type: 'today', startLabel: `${todayDate} 00:00`, endLabel };
  }

  return { type: 'today', startLabel: `${todayDate} 00:00`, endLabel };
}

function fmtHHMM(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const h = parts.find(p => p.type === 'hour')?.value || '00';
  const m = parts.find(p => p.type === 'minute')?.value || '00';
  return `${h}:${m}`;
}
