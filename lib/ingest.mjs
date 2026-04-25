// ingest.mjs — Ingest 角色:外部 source → 当日 raw 文件
//
// 对应 v1 collect.mjs 的业务编排,但作为 Topic.method 暴露,而不是独立脚本。
// 流水线:
//   loadTopic → 对每个 source 调 x-fetcher → dedupTweets → readExistingIds 过滤
//            → sortTweetsByTime → formatTweet
//            → splitRawBlocks + mergeBlocksByTimeDesc(全局时间倒序重排)
//            → 整体重写 raw/daily/YYYY-MM-DD.md
//
// 不变量:raw 文件全局时间倒序。每次写盘整体重排,而不是新 block 前插。

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

/**
 * 对一个 Topic 跑 ingest。
 *
 * @param {Topic} topic
 * @param {{dry?: boolean, limit?: number, log?: (msg: string) => void}} opts
 *   - dry:不写盘,返回统计 + 前几条样本
 *   - limit:覆盖所有 source 的 fetch_limit(1-200)
 *   - log:日志输出回调,缺省走 stderr [ingest] 前缀
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

  log(`topic=${topic.slug} sources=${topic.sources.length} tz=${topic.timezone}`);

  const todayDate = getTodayDate(topic.timezone);
  const rawDir = path.join(topic.dataPath, 'raw', 'daily');
  const rawPath = path.join(rawDir, `${todayDate}.md`);

  if (!isDry) await mkdir(rawDir, { recursive: true });

  const existingIds = await readExistingIds(rawPath);
  log(`today=${todayDate} rawPath=${rawPath} existingIds=${existingIds.size}`);

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
