// enrich.mjs — Enrich 角色:按需深抓 Twitter Article → 月度缓存
//
// 对应 v1 fetch-article.mjs 的核心逻辑,但作为 Topic.method 暴露。一般由 analyze
// 阶段的 Claude 会话在 prompt 里 Bash 调用 scripts/fetch-article.mjs(后者会复用本
// 模块逻辑),也可以从 CLI 直接 `perch enrich --url ...` 触发。
//
// 行为:
//   - 命中缓存 → 直接返回路径,不碰 CDP
//   - 未命中 → CDP 打开 status URL → x-adapter status 提取 → 写月度缓存 → 返回路径
//   - 非 article(普通推文)→ 抛错,避免污染缓存

import { getTodayDate } from './normalize.mjs';
import {
  articleCachePath,
  statusIdFromUrl,
  hasCachedArticle,
  writeCachedArticle,
} from './article-cache.mjs';
import { createBrowser } from './browser-provider.mjs';
import { ProxyClient } from './proxy-client.mjs';
import xAdapter from './x-adapter.mjs';

/**
 * 对一个 Topic 跑 enrich(深抓单条 Twitter Article)。
 *
 * @param {Topic} topic
 * @param {string} statusUrl
 * @param {{
 *   date?: string,                     // 决定缓存落在哪个月;默认今日
 *   log?: (msg: string) => void,
 * }} opts
 * @returns {Promise<{
 *   topic: string, date: string, statusId: string,
 *   path: string, cached: boolean,
 * }>}
 */
export async function enrich(topic, statusUrl, opts = {}) {
  const log = opts.log || ((msg) => process.stderr.write(`[enrich] ${msg}\n`));

  if (!statusUrl) throw new Error('enrich: missing statusUrl');
  const statusId = statusIdFromUrl(statusUrl);
  if (!statusId) throw new Error(`enrich: cannot extract statusId from URL: ${statusUrl}`);

  const date = opts.date || getTodayDate(topic.timezone);
  const cachedPath = articleCachePath(topic, date, statusId);

  if (hasCachedArticle(topic, date, statusId)) {
    log(`cache hit: ${cachedPath}`);
    return { topic: topic.slug, date, statusId, path: cachedPath, cached: true };
  }

  const browser = await createBrowser({ mode: 'user' });
  const proxy = new ProxyClient(browser.proxyPort);

  let tabId = null;
  try {
    tabId = await proxy.newTab(statusUrl);
    await new Promise(r => setTimeout(r, 1500));

    const result = await xAdapter.extract(proxy, tabId, {
      url: statusUrl,
      pageType: 'status',
    });

    if (!result || result.error) {
      throw new Error(`adapter could not extract status page: ${result?.error || 'unknown'}`);
    }

    if (!result.article || !result.article.markdown) {
      throw new Error(`status page is not a Twitter Article (contentType=${result.contentType}). Use the tweet body from raw instead.`);
    }

    const meta = {
      title: result.article.title || '',
      author: result.tweet?.author?.handle || '',
      status_url: statusUrl,
      text_length: result.article.textLength || result.article.markdown.length || 0,
    };

    const written = await writeCachedArticle(topic, date, statusId, meta, result.article.markdown);
    log(`wrote cache: ${written} (${meta.text_length} chars)`);
    return { topic: topic.slug, date, statusId, path: written, cached: false };
  } finally {
    if (tabId) await proxy.close(tabId).catch(() => {});
    await browser.close().catch(() => {});
  }
}
