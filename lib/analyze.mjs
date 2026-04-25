// analyze.mjs — Analyze 角色:raw + slot 窗口 → wiki 当日的 slot section
//
// 对应 v1 report.mjs 的业务编排,但作为 Topic.method 暴露。流水线:
//   解析 slot+date(now / 显式 + 凌晨 wrap 回退)
//     → 计算 window(canonical end / min(now, canonical))
//     → 加载 prompt 模板(<slot>.md)
//     → 渲染所有占位符
//     → 输出完整 prompt
//       · skill 模式:打 stdout,Claude 会话接棒
//       · direct 模式(v2.x):调 lib/llm.mjs::complete(),内部完成 wiki upsert
//
// 关键不变量(沿用 v1):
//   - date / RAW_PATH / WIKI_PATH / 窗口起止由统一的 date 决定,不会错位
//   - endLabel 同时杜绝反向窗口(start>end)和未来窗口(end>now 且数据未发生)

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { getTodayDate } from './normalize.mjs';
import { rawDailyPath, wikiDailyPath, summariesPath } from './wiki.mjs';
import { articleCacheDir } from './article-cache.mjs';

/**
 * 对一个 Topic 跑 analyze。
 *
 * @param {Topic} topic
 * @param {string} slotArg              - slot name 或 'now'
 * @param {{
 *   date?: string,                     // 显式归属日(覆盖 wrap 逻辑,慎用)
 *   llm?: 'skill'|'direct',            // 默认 'skill'
 *   log?: (msg: string) => void,
 *   stdout?: (text: string) => void,   // skill 模式下 prompt 的输出渠道
 * }} opts
 * @returns {Promise<{
 *   topic: string, slot: string, date: string,
 *   window: {type: string, startLabel: string, endLabel: string},
 *   rawPath: string, wikiPath: string,
 *   prompt: string,
 *   mode: 'skill'|'direct',
 * }>}
 */
export async function analyze(topic, slotArg, opts = {}) {
  const log = opts.log || ((msg) => process.stderr.write(`[analyze] ${msg}\n`));
  const stdout = opts.stdout || ((text) => process.stdout.write(text));
  const llmMode = opts.llm || 'skill';

  const slotArgLower = String(slotArg || 'now').toLowerCase();
  const validSlots = [...topic.slots.map(s => s.name), 'now'];
  if (!validSlots.includes(slotArgLower)) {
    throw new Error(`invalid slot "${slotArgLower}" for topic "${topic.slug}" — use one of: ${validSlots.join(', ')}`);
  }

  const now = new Date();
  const { slot, date } = opts.date
    ? { slot: slotArgLower === 'now' ? pickSlotByHour(topic.slots, now, topic.timezone) : slotArgLower, date: opts.date }
    : resolveSlotAndDate(slotArgLower, now, topic.timezone, topic.slots);

  const slotDef = topic.slots.find(s => s.name === slot);
  if (!slotDef) {
    throw new Error(`internal: resolved slot "${slot}" not in topic.slots`);
  }
  const windowInfo = computeWindow(slotDef, topic.slots, now, topic.timezone, date);

  const promptPath = path.join(topic.templatesDir, `${slot}.md`);
  let template;
  try {
    template = await readFile(promptPath, 'utf-8');
  } catch (err) {
    throw new Error(`reading prompt template ${promptPath}: ${err.message}`);
  }

  const filled = renderPrompt(topic, { slot, date, windowInfo, template });

  log(`topic=${topic.slug} slot=${slot} date=${date} window=${windowInfo.type} [${windowInfo.startLabel} → ${windowInfo.endLabel}]`);
  log(`rawPath=${rawDailyPath(topic, date)}`);
  log(`wikiPath=${wikiDailyPath(topic, date)}`);

  if (llmMode === 'skill') {
    stdout(filled);
  } else if (llmMode === 'direct') {
    throw new Error('analyze: direct LLM mode not implemented in v2 (留 v2.x via lib/llm.mjs::complete)');
  } else {
    throw new Error(`analyze: unknown llm mode "${llmMode}"`);
  }

  return {
    topic: topic.slug,
    slot,
    date,
    window: windowInfo,
    rawPath: rawDailyPath(topic, date),
    wikiPath: wikiDailyPath(topic, date),
    prompt: filled,
    mode: llmMode,
  };
}

// —— prompt 渲染 ——

function renderPrompt(topic, { slot, date, windowInfo, template }) {
  const sourcesDesc = topic.sources
    .map(s => {
      const kind = s.type === 'list' ? 'X List' : 'X Profile';
      const name = s.label || s.slug;
      return `${kind} "${name}"`;
    })
    .join(' + ');

  const fetchArticleCmd = `node ${path.join(topic.rootDir, 'scripts', 'fetch-article.mjs')} --topic ${topic.slug}`;
  const wikiWriteCmd = `node ${path.join(topic.rootDir, 'scripts', 'wiki-write.mjs')} --topic ${topic.slug} --date ${date} --slot ${slot}`;

  return template
    .replace(/\{TOPIC_SLUG\}/g, topic.slug)
    .replace(/\{DATE\}/g, date)
    .replace(/\{SLOT\}/g, slot)
    .replace(/\{RAW_PATH\}/g, rawDailyPath(topic, date))
    .replace(/\{WIKI_PATH\}/g, wikiDailyPath(topic, date))
    .replace(/\{WIKI_WRITE_CMD\}/g, wikiWriteCmd)
    .replace(/\{SUMMARIES_PATH\}/g, summariesPath(topic))
    .replace(/\{SOURCES\}/g, sourcesDesc)
    .replace(/\{WINDOW_TYPE\}/g, windowInfo.type)
    .replace(/\{WINDOW_START_LABEL\}/g, windowInfo.startLabel)
    .replace(/\{WINDOW_END_LABEL\}/g, windowInfo.endLabel)
    .replace(/\{ARTICLE_CACHE_DIR\}/g, articleCacheDir(topic, date))
    .replace(/\{FETCH_ARTICLE_CMD\}/g, fetchArticleCmd);
}

// —— slot + date 解析(v1 report.mjs 原样搬移) ——

/**
 * 解析 slot + 归属 date,对 'now' 和显式指定统一处理。
 *
 * 规则(hour = 当前时刻在 topic.timezone 下的小时):
 *   - slotArg === 'now':
 *       · hour ≥ slots[0].start_hour → pickSlot 正常逻辑,date = 今天
 *       · hour < slots[0].start_hour → slot = 末 slot,date = 昨天(凌晨 wrap)
 *   - slotArg === 显式 slot 名:
 *       · hour ≥ slotDef.start_hour → date = 今天
 *       · hour < slotDef.start_hour → date = 昨天(slot 今天未开始,看昨天那个实例)
 *
 * 显式 slot 未开始时 wrap 到昨天,避免 "report noon" 在凌晨产出 "05:00 → 18:00"
 * 全未来窗口的 bug。
 */
export function resolveSlotAndDate(slotArg, now, timezone, slots) {
  const hour = currentHourInTz(now, timezone);
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

  const slotDef = slots.find(s => s.name === slotArg);
  if (!slotDef) {
    return { slot: slotArg, date: today };
  }
  if (hour < slotDef.start_hour) {
    return { slot: slotArg, date: shiftDate(today, -1) };
  }
  return { slot: slotArg, date: today };
}

function pickSlotByHour(slots, now, timezone) {
  const hour = currentHourInTz(now, timezone);
  if (hour < slots[0].start_hour) return slots[slots.length - 1].name;
  let cur = slots[0];
  for (const s of slots) {
    if (hour >= s.start_hour) cur = s;
    else break;
  }
  return cur.name;
}

function currentHourInTz(now, timezone) {
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', hour12: false,
  }).format(now));
}

/**
 * YYYY-MM-DD ± N 天,字符串运算。
 */
function shiftDate(ymd, deltaDays) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + deltaDays * 86400000;
  const nd = new Date(t);
  return `${nd.getUTCFullYear()}-${String(nd.getUTCMonth() + 1).padStart(2, '0')}-${String(nd.getUTCDate()).padStart(2, '0')}`;
}

// —— window 计算(v1 report.mjs 原样搬移) ——

/**
 * 计算 slot 的报告覆盖窗口。
 *
 * window 语义:
 *   - 'today'      — 归属日 00:00 → endLabel
 *   - 'since_prev' — 上一 slot 的 start_hour → endLabel;首 slot 自动 fallback 为 today
 *
 * endLabel:
 *   - date != today → canonical end(下一 slot 起点 / 末 slot 用归属日 23:59)
 *   - date == today → min(now, canonical end)
 *
 * label 格式:`YYYY-MM-DD HH:MM`
 */
export function computeWindow(slotDef, slotsAll, now, timezone, date) {
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
    return { type: 'today', startLabel: `${date} 00:00`, endLabel };
  }

  return { type: 'today', startLabel: `${date} 00:00`, endLabel };
}

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
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const h = parts.find(p => p.type === 'hour')?.value || '00';
  const m = parts.find(p => p.type === 'minute')?.value || '00';
  return `${h}:${m}`;
}
