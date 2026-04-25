// ingest.mjs — Ingest 角色:外部 source → raw 文件(v3)
//
// v3 改动:接受 opts.out 显式指定写到哪。缺省仍是 raw/daily/{today}.md(today 由
// topic.timezone 决定),保持常用 cron 命令简洁;但用户可以显式传 --out 实现"写到
// 别的路径"(比如临时 smoke-test、跨日补抓等)。
//
// 流水线(不变):
//   对每个 source 调 fetcher → dedup → readExistingIds 过滤 → sort → format
//                            → splitRawBlocks + mergeBlocksByTimeDesc(全局重排)
//                            → 整体重写 out 文件

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { fetchXList, fetchXProfile } from './x-fetcher.mjs';
import {
  formatTweet,
  getTodayDate,
  readExistingIds,
  dedupTweets,
  sortTweetsByTime,
  splitRawBlocks,
  mergeBlocksByTimeDesc,
} from './normalize.mjs';
import { rawDailyPath } from './wiki.mjs';

/**
 * 对一个 Topic 跑 ingest。
 *
 * @param {Topic} topic
 * @param {{
 *   out?: string,                 // 显式指定 raw 文件路径;缺省 raw/daily/{today}.md
 *   dry?: boolean,
 *   limit?: number,               // 覆盖所有 source 的 fetch_limit
 *   log?: (msg: string) => void,
 * }} opts
 * @returns {Promise<{
 *   topic: string, date: string, rawPath: string,
 *   fetched: number, afterDedup: number, new: number,
 *   wrote: boolean, sample?: any[], allSourcesFailed?: boolean,
 * }>}
 */
export async function ingest(topic, opts = {}) {
  const log = opts.log || ((msg) => process.stderr.write(`[ingest] ${msg}\n`));
  const isDry = !!opts.dry;
  const limitOverride = opts.limit;

  if (limitOverride != null) {
    if (!Number.isInteger(limitOverride) || limitOverride < 1 || limitOverride > 200) {
      throw new Error(`ingest: limit must be integer 1-200, got: ${JSON.stringify(limitOverride)}`);
    }
  }

  const todayDate = getTodayDate(topic.timezone);
  const rawPath = opts.out || rawDailyPath(topic, todayDate);

  log(`topic=${topic.slug} sources=${topic.sources.length} tz=${topic.timezone}`);

  if (!isDry) await mkdir(path.dirname(rawPath), { recursive: true });

  const existingIds = await readExistingIds(rawPath);
  log(`out=${rawPath} existingIds=${existingIds.size}`);

  const allFetched = [];
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
        item.__via = src.slug;
      }
      allFetched.push(...items);
      fetchSuccessCount++;
    } catch (err) {
      log(`  ! fetch failed for ${src.slug}: ${err.message}`);
    }
  }

  if (fetchSuccessCount === 0) {
    return {
      topic: topic.slug, date: todayDate, rawPath,
      fetched: 0, afterDedup: 0, new: 0, wrote: false,
      allSourcesFailed: true,
    };
  }

  const candidates = dedupTweets(allFetched);
  log(`after dedupTweets (cross-source): ${candidates.length}`);

  const newTweets = candidates.filter(t => t.statusId && !existingIds.has(t.statusId));
  log(`after readExistingIds diff: ${newTweets.length} new`);

  if (newTweets.length === 0) {
    log('no new tweets, done');
    return {
      topic: topic.slug, date: todayDate, rawPath,
      fetched: allFetched.length, afterDedup: candidates.length, new: 0, wrote: false,
    };
  }

  const sortedNew = sortTweetsByTime(newTweets);

  if (isDry) {
    log('--dry: not writing file');
    return {
      topic: topic.slug, date: todayDate, rawPath,
      fetched: allFetched.length, afterDedup: candidates.length, new: newTweets.length,
      wrote: false,
      sample: sortedNew.slice(0, 3).map(t => ({
        handle: t.author?.handle,
        time: t.authoredAt?.dateTime,
        text: (t.text || '').slice(0, 80),
        via: t.__via,
      })),
    };
  }

  const newBlockStrs = sortedNew.map(t =>
    formatTweet(t, { timezone: topic.timezone, source: t.__via })
  );

  let finalContent;
  if (!existsSync(rawPath)) {
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
    finalContent = header + newBlockStrs.join('');
  } else {
    const existing = await readFile(rawPath, 'utf-8');
    const { header: existingHeader, blocks: existingBlocks } = splitRawBlocks(existing);
    const merged = mergeBlocksByTimeDesc(existingBlocks, newBlockStrs);
    finalContent = existingHeader + merged.join('');
  }

  await writeFile(rawPath, finalContent, 'utf-8');
  log(`wrote ${rawPath} — added ${sortedNew.length} new tweet(s)`);

  return {
    topic: topic.slug, date: todayDate, rawPath,
    fetched: allFetched.length, afterDedup: candidates.length, new: newTweets.length,
    wrote: true,
  };
}
