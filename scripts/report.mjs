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

// 解析当前 slot + 对应的归属日期。两种模式统一处理:
//   - `now` 凌晨(hour < 首 slot.start_hour)→ slot=末 slot, date=昨天
//   - 显式指定 slot,但 now 在该 slot 今天的 start_hour 之前 → date=昨天(看昨天那个实例)
//   - 其它情况 → date=今天
// 这样 endLabel 永远不会比 startLabel 小(见 computeWindow 里的 min 语义)。
const { slot, date } = resolveSlotAndDate(slotArg, now, topic.timezone, topic.slots);

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

// 解析 slot + 归属 date,对 `now` 和显式指定统一处理。
//
// 规则(hour = 当前时刻在 topic.timezone 下的小时):
//   - slotArg === 'now':
//       · hour ≥ 首 slot.start_hour → pickSlot 正常逻辑,date = 今天
//       · hour < 首 slot.start_hour → slot = 末 slot,date = **昨天**(凌晨 wrap)
//   - slotArg === 显式 slot 名:
//       · hour ≥ slotDef.start_hour → date = 今天(slot 今天已开始,包含进行中 / 已过)
//       · hour < slotDef.start_hour → date = **昨天**(slot 今天未开始,看昨天那个实例)
//
// 为什么显式 slot 未开始时要 wrap 到昨天:之前 date 永远取今天会让 `report noon` 在凌晨跑
// 产出 "05:00 → 18:00"(全是未来时刻,raw 里根本没东西)。归属到昨天 noon 既合理又保证
// startLabel ≤ endLabel(canonical),消除"未来窗口"问题。
function resolveSlotAndDate(slotArg, now, timezone, slots) {
  const hour = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', hour12: false,
  }).format(now));
  const today = getTodayDate(timezone);

  if (slotArg === 'now') {
    if (hour < slots[0].start_hour) {
      return { slot: slots[slots.length - 1].name, date: shiftDate(today, -1) };
    }
    let cur = slots[0];
    for (const s of slots) {
      if (hour >= s.start_hour) cur = s;
      else break;
    }
    return { slot: cur.name, date: today };
  }

  // 显式 slot:若今天还没到该 slot 起点,归属昨天
  const slotDef = slots.find(s => s.name === slotArg);
  if (!slotDef) {
    // 不应该到这里(入口已经校验 slot 合法性),保守返回 today
    return { slot: slotArg, date: today };
  }
  if (hour < slotDef.start_hour) {
    return { slot: slotArg, date: shiftDate(today, -1) };
  }
  return { slot: slotArg, date: today };
}

// YYYY-MM-DD ± N 天,字符串运算。不依赖时区(因为 input 已经是 timezone 下的 YYYY-MM-DD)。
function shiftDate(ymd, deltaDays) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + deltaDays * 86400000;
  const nd = new Date(t);
  return `${nd.getUTCFullYear()}-${String(nd.getUTCMonth() + 1).padStart(2, '0')}-${String(nd.getUTCDate()).padStart(2, '0')}`;
}

// 计算 slot 的报告覆盖窗口,给 prompt 模板提供 {WINDOW_*} 占位符。
//
// window 语义:
//   - 'today'     — 覆盖归属日的 00:00 至 endLabel
//   - 'since_prev'— 覆盖"归属日的 prev.start_hour" 至 endLabel;当前 slot 是首个(没有 prev)
//                    时 fallback 为 today,避免跨昨日 raw
//
// endLabel 逻辑(两种模式统一):
//   - date !== today(wrapped / 显式回退到昨天)→ 用该 slot 的 **canonical end**(下一 slot
//     起点,或末 slot 的归属日 23:59):报告覆盖那个 slot 在昨日的完整实例
//   - date === today → 取 **min(now, canonical end)**:
//       · slot 进行中 → now(匹配 DESIGN 的"到触发时刻"语义)
//       · slot 已过 → canonical end(不把之后其它 slot 的时段包进来)
//   这消除了之前"显式指定 slot 在 slot 时段前触发"会产生未来窗口 / 反向窗口的问题。
//   前置条件:resolveSlotAndDate 已保证 "date === today" 时 now ≥ slotDef.start_hour。
//
// label 格式:`YYYY-MM-DD HH:MM`(raw block 标题是 `MM-DD HH:MM`,Claude 按字符串比较过滤)。
function computeWindow(slotDef, slotsAll, now, timezone, date) {
  const today = getTodayDate(timezone);
  const canonical = canonicalEndLabel(slotDef, slotsAll, date);
  let endLabel;
  if (date !== today) {
    endLabel = canonical;
  } else {
    const nowLabel = `${date} ${fmtHHMM(now, timezone)}`;
    endLabel = nowLabel < canonical ? nowLabel : canonical;
  }

  const windowType = slotDef?.window || 'today';
  if (windowType === 'since_prev') {
    const idx = slotsAll.findIndex(s => s.name === slotDef.name);
    if (idx > 0) {
      const prev = slotsAll[idx - 1];
      const startLabel = `${date} ${String(prev.start_hour).padStart(2, '0')}:00`;
      return { type: 'since_prev', startLabel, endLabel };
    }
    // 首个 slot,退化为 today(同 DESIGN §3.1 明示的简化,避免跨昨日 raw)
    return { type: 'today', startLabel: `${date} 00:00`, endLabel };
  }

  return { type: 'today', startLabel: `${date} 00:00`, endLabel };
}

// 该 slot "按设计应该覆盖到哪一刻":非末 slot 到下一 slot 起点;末 slot 到归属日 23:59。
function canonicalEndLabel(slotDef, slotsAll, date) {
  const idx = slotsAll.findIndex(s => s.name === slotDef?.name);
  if (idx >= 0 && idx < slotsAll.length - 1) {
    const next = slotsAll[idx + 1];
    return `${date} ${String(next.start_hour).padStart(2, '0')}:00`;
  }
  return `${date} 23:59`;
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
