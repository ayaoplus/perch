// normalize.mjs — perch raw 格式归一化 + 去重辅助
//
// 逻辑沿袭自 ai-radar/scripts/collect.mjs(formatTweet / formatLocalTime / getTodayDate /
// readExistingIds / mlookup),从原脚本解耦出来:timezone 参数化、不再读 config。
// 这些函数的输出格式是 perch raw 文件的事实标准(见 DESIGN §5)。

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

const DEFAULT_TIMEZONE = 'Asia/Shanghai';

/**
 * 按指定时区返回今天的 YYYY-MM-DD 字符串。
 */
export function getTodayDate(timezone = DEFAULT_TIMEZONE) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/**
 * 把 ISO 时间字符串格式化为 `MM-DD HH:MM`(24h,用于 raw block 标题)。
 * 输入非法时返回空串,由上层决定 fallback 到 tweet.authoredAt.text。
 */
export function formatLocalTime(iso, timezone = DEFAULT_TIMEZONE) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone,
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${byType.month}-${byType.day} ${byType.hour}:${byType.minute}`;
}

/**
 * 按 `authoredAt.dateTime` 对 tweet 列表做时间倒序排序(最新在前)。
 *
 * 为什么是工具函数而不是 fetch 层内置:
 *   - x-fetcher 是 Layer 1(按 DOM 顺序取 N 条),不掺业务语义
 *   - 真实业务场景(时间窗口 + 增量采集)由 collect 层组合 dedup / sort / window-filter
 *   - profile 路径的 DOM 顶部可能是 pinned tweet(非时间顺序),本函数把它按实际发布时间排回
 *
 * 缺失或非法的 `authoredAt.dateTime` 视为时间戳 0(沉到最后)。原数组不被原地改动。
 */
export function sortTweetsByTime(tweets) {
  return [...tweets].sort((a, b) => {
    const aT = new Date(a?.authoredAt?.dateTime || 0).getTime();
    const bT = new Date(b?.authoredAt?.dateTime || 0).getTime();
    return bT - aT;
  });
}

/**
 * 按 `statusId` 对 tweet 列表去重,保留首次出现的条目、顺序不变。
 *
 * 典型用法:多源混跑(例如 list + profile)时,把各自 `fetchX*().items` spread 到一起,
 * 过一遍这个函数:
 *   const all = dedupTweets([...listRes.items, ...profileRes.items]);
 *
 * 单次抓取不需要用 — x-adapter 内部已按 statusId 去重过。
 * 没有 `statusId` 的条目会被过滤(x-adapter 少数边界 shape,例如独立的链接卡)。
 */
export function dedupTweets(tweets) {
  const seen = new Set();
  const out = [];
  for (const t of tweets) {
    const id = t?.statusId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(t);
  }
  return out;
}

/**
 * 扫描一个 raw markdown 文件,返回其中已出现的**顶层** tweet ID 集合。
 *
 * 去重粒度 = tweet ID,只从每个 block 的标题行(`## ` 开头)里抓 `/status/(\d+)`。
 * 刻意**不**扫整个文件的 ID,是因为 block 里 `🔗 quote: ...` / `🔗 link: ...` 行可能
 * 也带 `/status/NNN`。若那条 quoted tweet 日后被 list 内账号以顶层身份发出,
 * 全局扫描会把它误判为已存在,静默丢数据。这是 ai-radar vendor 来的固有缺陷。
 */
export async function readExistingIds(rawPath) {
  if (!existsSync(rawPath)) return new Set();
  const content = await readFile(rawPath, 'utf-8');
  const ids = new Set();
  // `m` flag 让 `^` 匹配每行行首;`.` 默认不跨行,所以 non-greedy `.*?` 只在标题行内搜。
  const titleRe = /^## .*?\/status\/(\d+)/gm;
  let m;
  while ((m = titleRe.exec(content)) !== null) ids.add(m[1]);
  return ids;
}

// 在 x-adapter metrics 对象里按 key 优先级取展示值,全空时返回 '0'。
function mlookup(metrics, ...keys) {
  for (const k of keys) {
    if (metrics?.[k]) return metrics[k].display || String(metrics[k].numeric ?? '');
  }
  return '0';
}

/**
 * 把 x-adapter 原始 tweet 对象渲染成一个 raw markdown block。
 * 输出结构(DESIGN §5):
 *   ## @handle (Name) · MM-DD HH:MM · [source](url)
 *   type: tweet
 *
 *   正文
 *
 *   📊 N RT · N 💬 · N ❤️ · Nx views
 *   🖼️ images · video · article
 *   🔗 quote: ...
 *   🔗 link: ...
 *
 *   ---
 *
 * @param {object} tweet — anyreach x-adapter 的 tweet 对象(shape 见 adapters/x.mjs)
 * @param {object} [options]
 * @param {string} [options.timezone='Asia/Shanghai']
 * @returns {string} 以 `\n` 分隔,末尾带分隔线和空行,可直接 concat 成整块 raw。
 */
export function formatTweet(tweet, options = {}) {
  const timezone = options.timezone || DEFAULT_TIMEZONE;

  const handle = tweet.author?.handle || '(unknown)';
  const name = tweet.author?.name || '';
  const localTime = formatLocalTime(tweet.authoredAt?.dateTime, timezone) || tweet.authoredAt?.text || '';
  const url = tweet.statusUrl || '';
  const type = tweet.entryType || 'tweet';

  const rt = mlookup(tweet.metrics, 'retweet');
  const reply = mlookup(tweet.metrics, 'reply');
  const like = mlookup(tweet.metrics, 'like');
  const views = tweet.views?.display || '';

  const mediaBits = [];
  if (tweet.media?.images?.length) {
    mediaBits.push(`${tweet.media.images.length} image${tweet.media.images.length > 1 ? 's' : ''}`);
  }
  if (tweet.media?.hasVideo) mediaBits.push('video');
  if (tweet.longformPreview?.title) mediaBits.push(`article: "${tweet.longformPreview.title}"`);

  const quotedLine = tweet.quotedTweet
    ? (() => {
        const qAuthor = tweet.quotedTweet.authors?.[0];
        const qHandle = qAuthor?.handle || '(unknown)';
        const qText = (tweet.quotedTweet.texts?.[0] || '').slice(0, 140);
        const qUrl = tweet.quotedTweet.statusUrls?.[0] || '';
        return `🔗 quote: ${qHandle} — ${qText}${qUrl ? ` [${qUrl}]` : ''}`;
      })()
    : '';

  const externalLine = tweet.externalCard?.url ? `🔗 link: ${tweet.externalCard.url}` : '';
  const bodyText = tweet.text || '(no text)';

  const lines = [];
  lines.push(`## ${handle}${name ? ` (${name})` : ''} · ${localTime} · [source](${url})`);
  lines.push(`type: ${type}${tweet.isTruncated ? ' · truncated' : ''}`);
  lines.push('');
  lines.push(bodyText);
  lines.push('');
  let stats = `📊 ${rt} RT · ${reply} 💬 · ${like} ❤️`;
  if (views) stats += ` · ${views} views`;
  lines.push(stats);
  if (mediaBits.length) lines.push(`🖼️ ${mediaBits.join(' · ')}`);
  if (quotedLine) lines.push(quotedLine);
  if (externalLine) lines.push(externalLine);
  lines.push('');
  lines.push('---');
  lines.push('');
  return lines.join('\n');
}
