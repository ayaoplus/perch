#!/usr/bin/env node
// collect.mjs — /perch collect 入口(Business 层)
//
// 对应 DESIGN §2.1 的 collect 管线:
//   loadTopic → 对每个 source 调 x-fetcher → dedupTweets → readExistingIds 过滤
//            → sortTweetsByTime → formatTweet 追加到 raw/daily/YYYY-MM-DD.md
//
// 用法:
//   node scripts/collect.mjs [--topic <slug>] [--dry] [--limit N]
//
// --limit N  覆盖所有 source 的 fetch_limit(临时手动跑用,SCHEMA.md 里的值不变)
//
// 前置:用户日常 Chrome 已开远程调试端口(9222/9229/9333 其一)且已登录 X。
// CDP Proxy 没跑的话 browser-provider 会自动 fork(日志 /tmp/perch-proxy.log)。
//
// 退出码:
//   0 — 正常(包括 "no new tweets")
//   1 — 配置 / IO / 致命错误(topic 不存在、SCHEMA 解析失败、写盘失败等)
//   2 — 所有 source 抓取都失败(可能登录态丢失 / proxy 起不来 / 网络)

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadTopic } from '../lib/topic.mjs';
import { fetchXList, fetchXProfile } from '../lib/x-fetcher.mjs';
import {
  formatTweet,
  getTodayDate,
  readExistingIds,
  dedupTweets,
  sortTweetsByTime,
} from '../lib/normalize.mjs';

// —— CLI 解析 ——

const argv = process.argv.slice(2);
const getFlag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};
const hasFlag = (name) => argv.includes(`--${name}`);

const topicSlug = getFlag('topic');
const isDry = hasFlag('dry');
const limitOverride = (() => {
  const v = getFlag('limit');
  if (v === null) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 200) {
    throw new Error(`--limit must be an integer in [1, 200], got: ${v}`);
  }
  return n;
})();

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// —— 加载 topic ——

let topic;
try {
  topic = await loadTopic(topicSlug, rootDir);
} catch (err) {
  log(`ERROR loading topic: ${err.message}`);
  process.exit(1);
}

log(`topic=${topic.slug} sources=${topic.sources.length} tz=${topic.timezone}`);

// —— 准备 raw 文件路径 ——

const todayDate = getTodayDate(topic.timezone);
const rawDir = path.join(topic.dataPath, 'raw', 'daily');
const rawPath = path.join(rawDir, `${todayDate}.md`);

if (!isDry) {
  await mkdir(rawDir, { recursive: true });
}

const existingIds = await readExistingIds(rawPath);
log(`today=${todayDate} rawPath=${rawPath} existingIds=${existingIds.size}`);

// —— 逐 source 抓取 ——

const allFetched = [];  // 每条推文会被打上内部 `__via` 字段
let fetchSuccessCount = 0;

for (const src of topic.sources) {
  const limit = limitOverride ?? src.fetch_limit ?? 80;
  log(`→ fetching source "${src.slug}" (${src.type}, limit=${limit}${limitOverride != null ? ' · CLI override' : ''})`);
  try {
    const result = src.type === 'list'
      ? await fetchXList(src.target, { limit })
      : await fetchXProfile(src.target, { limit });

    const items = result.items || [];
    log(`  got ${items.length} items`);
    for (const item of items) {
      item.__via = src.slug;  // 内部标注,formatTweet 时传给 options.source
    }
    allFetched.push(...items);
    fetchSuccessCount++;
  } catch (err) {
    log(`  ! fetch failed for ${src.slug}: ${err.message}`);
  }
}

if (fetchSuccessCount === 0) {
  log('ERROR: all sources failed to fetch');
  process.exit(2);
}

// —— dedup → readExistingIds 过滤 → sort ——

let candidates = dedupTweets(allFetched);
log(`after dedupTweets (cross-source): ${candidates.length}`);

const newTweets = candidates.filter(t => t.statusId && !existingIds.has(t.statusId));
log(`after readExistingIds diff: ${newTweets.length} new`);

if (newTweets.length === 0) {
  log('no new tweets, done');
  process.exit(0);
}

const sortedNew = sortTweetsByTime(newTweets);

// —— dry run:打印样本退出 ——

if (isDry) {
  log('--dry: not writing file');
  console.log(JSON.stringify({
    topic: topic.slug,
    date: todayDate,
    fetched: allFetched.length,
    afterDedup: candidates.length,
    new: newTweets.length,
    sample: sortedNew.slice(0, 3).map(t => ({
      handle: t.author?.handle,
      time: t.authoredAt?.dateTime,
      text: (t.text || '').slice(0, 80),
      via: t.__via,
    })),
  }, null, 2));
  process.exit(0);
}

// —— 写盘:新建或前插 ——

const newBlocks = sortedNew.map(t =>
  formatTweet(t, { timezone: topic.timezone, source: t.__via })
).join('');

let finalContent;
if (!existsSync(rawPath)) {
  // 全新文件:加 header
  const sourceLines = topic.sources
    .map(s => `- ${s.slug}: ${s.type} · ${s.target}`)
    .join('\n');
  const header = [
    `# ${topic.slug} Raw — ${todayDate}`,
    '',
    `本日原始采集。时间倒序(最新在上)。`,
    '',
    `Sources:`,
    sourceLines,
    '',
    '---',
    '',
  ].join('\n');
  finalContent = header + newBlocks;
} else {
  // 已有文件:把新 block 插到第一个 `## ` 标题之前,保持时间倒序
  const existing = await readFile(rawPath, 'utf-8');
  const firstHeadingIdx = existing.search(/^## /m);
  if (firstHeadingIdx >= 0) {
    finalContent = existing.slice(0, firstHeadingIdx) + newBlocks + existing.slice(firstHeadingIdx);
  } else {
    // 没有任何 block(比如只有 header),追加到末尾
    finalContent = existing.endsWith('\n') ? existing + newBlocks : existing + '\n' + newBlocks;
  }
}

await writeFile(rawPath, finalContent, 'utf-8');
log(`wrote ${rawPath} — added ${sortedNew.length} new tweet(s)`);

// —— helpers ——

function log(msg) {
  process.stderr.write(`[collect] ${msg}\n`);
}
