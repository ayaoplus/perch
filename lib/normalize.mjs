// normalize.mjs — perch raw 格式归一化 + 去重辅助
//
// 为 Business 层(Step 2 collect 等)提供可组合原子:
//   formatTweet        — x-adapter tweet 对象 → raw markdown block
//   formatLocalTime    — ISO 时间 → MM-DD HH:MM(按指定 timezone)
//   getTodayDate       — 指定 timezone 下的 YYYY-MM-DD
//   readExistingIds    — 从 raw 文件扫已存在的顶层 tweet ID(用于跨次去重)
//   dedupTweets        — 按 statusId 去重一个 tweet 列表(in-memory)
//   sortTweetsByTime   — 按 authoredAt 时间倒序排序(非破坏性)
//
// raw 文件的格式约定见 DESIGN §5。timezone 从参数传入,不依赖全局 config。

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
 * 缺失(null/undefined/'')或非法(非空但 `new Date()` 得 NaN)的 `authoredAt.dateTime`
 * 一律视为时间戳 0,沉到最后。原数组不被原地改动。
 */
export function sortTweetsByTime(tweets) {
  const ts = (t) => {
    const v = new Date(t?.authoredAt?.dateTime || 0).getTime();
    return Number.isFinite(v) ? v : 0;
  };
  return [...tweets].sort((a, b) => ts(b) - ts(a));
}

/**
 * 按 `statusId` 对 tweet 列表去重 **+ 聚合**。首次出现的条目保留,顺序按首次出现确定;后续
 * 出现的同 statusId 条目把几个"可叠加字段"合并进已保留副本:
 *
 *   - `__via`     :source slug 列表。同一原推若通过多个 list 观察到,全部保留
 *   - `repostedBy`:RT 转推者列表。X 不为 RT 生成新 statusId,不同账号 RT 同一原推会被 dedup
 *                  到一条 block,repostedBy 合并成数组,Claude 看得出"被 N 个人转了"
 *
 * 典型用法:多源混跑(例如 list + profile 或多 list)时,把各自 `fetchX*().items` 合起来
 * 过这个函数,并在调用前给每条标记 `__via`:
 *   for (const item of items) item.__via = source.slug;
 *   const merged = dedupTweets([...listA, ...listB, ...profileC]);
 *
 * 单次抓取单 source 也建议过一下(统一形态:`__via` / `repostedBy` 都归一化为数组)。
 * 没有 `statusId` 的条目会被过滤(x-adapter 少数边界 shape,例如独立的链接卡)。
 *
 * **返回的是条目的浅拷贝**(`{ ...t }`),修改聚合字段不会污染输入数组里的原对象。其他嵌套
 * 字段(media / quotedTweet / textBlocks 等)共享引用,但 collect 下游不会改它们。
 */
export function dedupTweets(tweets) {
  const byId = new Map();
  const order = [];
  for (const t of tweets) {
    const id = t?.statusId;
    if (!id) continue;
    if (!byId.has(id)) {
      const copy = { ...t };
      copy.__via = toArray(t.__via);
      copy.repostedBy = toRepostArray(t.repostedBy);
      byId.set(id, copy);
      order.push(id);
    } else {
      const existing = byId.get(id);
      for (const v of toArray(t.__via)) {
        if (!existing.__via.includes(v)) existing.__via.push(v);
      }
      for (const r of toRepostArray(t.repostedBy)) {
        const key = r.handle || r.name || '';
        if (!key) continue;
        if (!existing.repostedBy.some(x => (x.handle || x.name || '') === key)) {
          existing.repostedBy.push(r);
        }
      }
    }
  }
  return order.map(id => byId.get(id));
}

// 统一 via 字段为数组:undefined/null → [],string → [string],array → shallow-copy
function toArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? [...v] : [v];
}

// repostedBy 在 normalizeCard 里是单对象 { handle, name } 或 null;支持已经被 dedup 过后的
// 数组形态,避免二次 dedup 把聚合好的列表打散
function toRepostArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.filter(r => r && (r.handle || r.name)).map(r => ({ ...r }));
  if (v.handle || v.name) return [{ ...v }];
  return [];
}

/**
 * 扫描一个 raw markdown 文件,返回其中已出现的**顶层** tweet ID 集合。
 *
 * 去重粒度 = tweet ID,只从每个 block 的标题行(`## ` 开头)里抓 `/status/(\d+)`。
 * 刻意**不**扫整个文件的 ID,是因为 block 里 `🔗 quote: ...` / `🔗 link: ...` 行可能
 * 也带 `/status/NNN`。若那条 quoted tweet 日后被 list 内账号以顶层身份发出,
 * 全局扫描会把它误判为已存在,静默丢数据。
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

/**
 * 把已有 raw 文件内容拆成 `{ header, blocks }`。
 *   - header:文件顶部到第一个 `## ` 标题**之前**的那段(文件标题 + Sources 列表 + 分隔线)
 *   - blocks:每个 `## ` 开头到下一个 `## ` 之前的整段字符串
 *
 * 如果文件里连一个 `## ` 都没有(刚建、空文件),blocks 为 `[]`。
 *
 * 供 collect 在"有新 block 要插入"时用:把 existing + new 一起做**全局时间倒序**排序,
 * 避免"晚到的旧推文"被前插到文件最前 / 破坏"全局时间倒序"不变量(DESIGN §5)。
 */
export function splitRawBlocks(content) {
  const firstHeadingIdx = content.search(/^## /m);
  if (firstHeadingIdx < 0) {
    return { header: content, blocks: [] };
  }
  const header = content.slice(0, firstHeadingIdx);
  const tail = content.slice(firstHeadingIdx);
  // split-on-lookahead 保留分隔符本身,每段都以 `## ` 开头
  const blocks = tail.split(/(?=^## )/m).filter(Boolean);
  return { header, blocks };
}

/**
 * 从一个 block 的标题行里提取 `MM-DD HH:MM` 时间戳,可直接做字符串排序(同年内倒序安全)。
 * 匹配失败返回 '00-00 00:00',这样异常 block 会排到最后。
 */
export function blockTimeKey(block) {
  const m = String(block || '').match(/^## [^\n]*?·\s*(\d{2}-\d{2}\s+\d{2}:\d{2})/m);
  return m ? m[1] : '00-00 00:00';
}

/**
 * 把两组 block(已序列化的字符串片段)**合并 + 全局时间倒序**。同 time key 的顺序稳定
 * (existing 先出现 / new 后出现 的相对顺序保留,因为 Array#sort 在 V8 里是稳定的)。
 *
 * 目标是让"晚到的旧推文"(pinned 挤占、DOM 抖动、source 晚一轮才抓到)进入文件时
 * 也能被按 authoredAt 插到正确位置,而不是一律前插到文件最前。
 */
export function mergeBlocksByTimeDesc(existingBlocks, newBlocks) {
  const keyed = [...existingBlocks, ...newBlocks].map(b => ({ key: blockTimeKey(b), body: b }));
  keyed.sort((a, b) => b.key.localeCompare(a.key));
  return keyed.map(x => x.body);
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
 *   via: slug1, slug2                (source 多值时出现,值来自 SCHEMA.sources[].slug)
 *   🔁 reposted by: @A, @B            (仅当有人纯 RT 了这条时出现)
 *
 *   正文(长推已 hydrate 过,完整无截断)
 *
 *   📊 N RT · N 💬 · N ❤️ · Nx views
 *   🖼️ images · video · article: "title"
 *   🔗 quote: @handle — text [url]   (有引用才出现,正文完整不截断)
 *   🔗 link: <external-url>          (有外链卡片才出现)
 *
 *   ---
 *
 * 多条 block 指向同一原推的两种去重后信号:
 *   - 纯 RT:dedupTweets 会把所有 RT 合并到一个 block,`reposted by:` 行枚举所有转发者
 *   - Quote:不同推主的 quote 是不同 statusId,会有多个 block,但 `🔗 quote: ... [url]` 指向
 *            同一原推 URL,Claude 可以从 URL 关联多条 block = "多人引用同一原推"
 *
 * @param {object} tweet — x-adapter 的 tweet 对象
 * @param {object} [options]
 * @param {string} [options.timezone='Asia/Shanghai']
 * @param {string|string[]} [options.source] — source slug(单值)或 slug 列表(dedup 聚合后多值),
 *                                              出现时渲染为 `via: ...` 行
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

  // quote 正文不再人为截断(140)。X timeline UI 侧可能仍截断显示,要彻底完整需对 quote
  // statusUrl 再做 hydrate,当前未实现(DESIGN §5 注明的 v1 边界)。
  const quotedLine = tweet.quotedTweet
    ? (() => {
        const qAuthor = tweet.quotedTweet.authors?.[0];
        const qHandle = qAuthor?.handle || '(unknown)';
        const qText = tweet.quotedTweet.texts?.[0] || '';
        const qUrl = tweet.quotedTweet.statusUrls?.[0] || '';
        return `🔗 quote: ${qHandle} — ${qText}${qUrl ? ` [${qUrl}]` : ''}`;
      })()
    : '';

  const externalLine = tweet.externalCard?.url ? `🔗 link: ${tweet.externalCard.url}` : '';
  const bodyText = tweet.text || '(no text)';

  // via 支持 string 或 string[]:dedup 聚合后会传数组
  const viaList = Array.isArray(options.source)
    ? options.source.filter(Boolean)
    : (options.source ? [options.source] : []);

  // reposted by:dedup 聚合后 tweet.repostedBy 是对象数组(也兼容单对象形态)
  const repostList = Array.isArray(tweet.repostedBy)
    ? tweet.repostedBy.filter(r => r && (r.handle || r.name))
    : (tweet.repostedBy && (tweet.repostedBy.handle || tweet.repostedBy.name) ? [tweet.repostedBy] : []);

  const lines = [];
  lines.push(`## ${handle}${name ? ` (${name})` : ''} · ${localTime} · [source](${url})`);
  lines.push(`type: ${type}${tweet.isTruncated ? ' · truncated' : ''}${tweet.hydrated ? ' · hydrated' : ''}`);
  if (viaList.length) lines.push(`via: ${viaList.join(', ')}`);
  if (repostList.length) {
    const labels = repostList.map(r => r.handle || r.name);
    lines.push(`🔁 reposted by: ${labels.join(', ')}`);
  }
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
