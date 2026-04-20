#!/usr/bin/env node
// fetch-article.mjs — 按需深抓 Twitter Article 正文(report 阶段工具)
//
// 设计意图:collect 阶段只把 article 标题 + statusUrl 带进 raw(DESIGN §5)。report 阶段
// 如果 Claude 觉得某个问题真的需要文章正文,就 Bash 跑这个脚本,它用 CDP 打开 status URL,
// 用 x-adapter 的 _extractStatus 抓完整 article markdown,缓存到
// `<path>/cache/articles/YYYY-MM/<statusId>.md`,然后把缓存路径输出到 stdout。Claude 拿到
// 路径后用 Read 读正文。
//
// 用法:
//   node scripts/fetch-article.mjs <status_url> [--topic <slug>] [--date YYYY-MM-DD]
//
// - status_url:tweet 的 status URL(从 raw block 里的 `🔗 quote: ... [url]` / `[source](url)` 取)
// - --topic   :不传用 config.default_topic
// - --date    :不传用 topic.timezone 的今天;决定缓存落在哪个月的目录
//
// 输出(stdout):单行缓存文件绝对路径,失败时为空,报错走 stderr
//
// 退出码:
//   0 — 成功(含命中已有缓存)
//   1 — 配置/参数错误
//   2 — 抓取失败(CDP / 登录态 / 非 article 等)
//
// 注意:**只能抓 Twitter Article**(status page 含 `twitterArticleReadView`)。普通长推不是
// article,但它们在 collect 阶段已经被 hydrate 过(Fetch 层),不需要再深抓。

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadTopic } from '../lib/topic.mjs';
import { getTodayDate } from '../lib/normalize.mjs';
import {
  articleCachePath,
  statusIdFromUrl,
  hasCachedArticle,
  writeCachedArticle,
} from '../lib/article-cache.mjs';
import { createBrowser } from '../lib/browser-provider.mjs';
import { ProxyClient } from '../lib/proxy-client.mjs';
import xAdapter from '../lib/x-adapter.mjs';

// —— CLI 解析 ——

const argv = process.argv.slice(2);
const positional = [];
const flags = {};
const VALUE_FLAGS = new Set(['--topic', '--date']);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    if (VALUE_FLAGS.has(a)) {
      flags[a.slice(2)] = argv[i + 1];
      i++;
    } else {
      flags[a.slice(2)] = true;
    }
  } else {
    positional.push(a);
  }
}

const statusUrl = positional[0];
if (!statusUrl) {
  err('ERROR: missing <status_url>. Usage: fetch-article.mjs <status_url> [--topic <slug>] [--date YYYY-MM-DD]');
  process.exit(1);
}
const statusId = statusIdFromUrl(statusUrl);
if (!statusId) {
  err(`ERROR: cannot extract statusId from URL: ${statusUrl}`);
  process.exit(1);
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let topic;
try {
  topic = await loadTopic(flags.topic || null, rootDir);
} catch (e) {
  err(`ERROR loading topic: ${e.message}`);
  process.exit(1);
}

const date = flags.date || getTodayDate(topic.timezone);

// —— 命中缓存就直接返回路径,不碰 CDP ——

const cached = articleCachePath(topic, date, statusId);
if (hasCachedArticle(topic, date, statusId)) {
  err(`cache hit: ${cached}`);
  process.stdout.write(cached + '\n');
  process.exit(0);
}

// —— 用 CDP 访问 status page,跑 x-adapter 的 status 提取 ——

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
    err(`ERROR: adapter could not extract status page: ${result?.error || 'unknown'}`);
    process.exit(2);
  }

  // 只把 "twitterArticleReadView" 命中的 longform 写进缓存。普通 tweet 的 status page
  // 没有 result.article,这里就返回 2,避免假数据污染缓存。
  if (!result.article || !result.article.markdown) {
    err(`ERROR: status page is not a Twitter Article (contentType=${result.contentType}). Use the tweet body from raw instead.`);
    process.exit(2);
  }

  const meta = {
    title: result.article.title || '',
    author: result.tweet?.author?.handle || '',
    status_url: statusUrl,
    text_length: result.article.textLength || result.article.markdown.length || 0,
  };

  const written = await writeCachedArticle(topic, date, statusId, meta, result.article.markdown);
  err(`wrote cache: ${written} (${meta.text_length} chars)`);
  process.stdout.write(written + '\n');
  process.exit(0);
} catch (e) {
  err(`ERROR: ${e.message}`);
  process.exit(2);
} finally {
  if (tabId) await proxy.close(tabId).catch(() => {});
  await browser.close().catch(() => {});
}

function err(msg) {
  process.stderr.write(`[fetch-article] ${msg}\n`);
}
