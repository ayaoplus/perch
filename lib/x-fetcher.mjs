// x-fetcher.mjs — 面向 perch 的 X 抓取入口(Layer 1,纯数据抓取)
//
// 组合 vendor 来的 browser-provider / proxy-client / x-adapter,对外暴露两种高层意图:
//   - fetchXList(listUrl)        — 从 X redux store 读 list timeline(单次,idempotent)
//   - fetchXProfile(handle|url)  — 走 DOM 爬虫 + 2-pass stabilize + 长推 hydrate(待迁)
//
// 默认 mode='user' — 假设用户日常 Chrome 已登录 X 并开着远程调试端口。
// x-adapter 自身不做登录墙检测(由上游 caller 保证登录态);没登录时最多返回空 items。
//
// 分层约定(这层刻意不做的事):
//   - 不按时间排序 items:返回 adapter 原始顺序。profile 顶部可能是 pinned tweet,
//     list 天然按 X 的时间倒序。需要统一顺序的调用方自行过 normalize.sortTweetsByTime
//   - 不做时间窗口过滤:业务层(collect)基于 readExistingIds 做跨次去重
//   - 不识别 / 过滤 pinned:pinned 是"业务噪音"不是"数据异常",交给业务层决策
//
// 真实业务的调用管线(由 collect 层编排,不是这里):
//   fetchXList/Profile(generous limit)
//     → normalize.dedupTweets(跨 source 合并 + 聚合 __via / repostedBy)
//     → readExistingIds 对比已有文件,过滤已存在
//     → normalize.sortTweetsByTime
//     → formatTweet + splitRawBlocks + mergeBlocksByTimeDesc → 整体重写 raw

import { createBrowser } from './browser-provider.mjs';
import { ProxyClient } from './proxy-client.mjs';
import xAdapter from './x-adapter.mjs';

// 页面初次渲染等待:打开 tab 后等 DOM / redux store 初始化稳定再抓
const PAGE_WARMUP_MS = 1500;
// profile DOM 2-pass extract 之间的等待:给 X lazy DOM 把最新推文 append 到顶部的时间
const STABILIZE_DELAY_MS = 3000;
// profile 长推 hydrate 时访问 status page 的 warmup
const STATUS_PAGE_WARMUP_MS = 1500;
// profile 长推 hydrate 每条总超时,避免单条卡死拖垮整个 collect
const HYDRATE_PER_ITEM_TIMEOUT_MS = 15000;

/**
 * 抓取一个 X List 的最新推文,通过读 X 内部 redux store 返回。
 * @param {string} listUrl — 形如 https://x.com/i/lists/1234567890
 * @param {object} [options]
 * @param {number} [options.limit=80] — 抓取条数上限,adapter 内部会 clamp 到 [1, 200]
 * @param {'user'|'managed'} [options.mode='user'] — 'user' 附着已有 Chrome,'managed' 启动独立 Chrome
 * @returns {Promise<object>} adapter 返回的 result:{ contentType, timelineType:'list', list, items, entriesInStore, ... }
 */
export async function fetchXList(listUrl, options = {}) {
  return runFetch(listUrl, options, 'list');
}

/**
 * 抓取一个 X 用户的个人时间线。
 *
 * 支持的输入形态:
 *   - 'elonmusk' 或 '@elonmusk'         → https://x.com/elonmusk
 *   - 'elonmusk/media' / '.../articles' / '.../with_replies' → 对应 profile 子 tab
 *   - 完整 URL(https://x.com/... 或 https://twitter.com/...)→ 原样透传
 *
 * 保留字(/home, /explore, /i, /search 等)会被 adapter 的 detect() 判定为 'unknown',
 * runFetch 里的 pageType self-check 会 throw。
 *
 * profile 当前还走 DOM 2-pass extract + 长推 hydrate(待迁 store)。
 */
export async function fetchXProfile(handleOrUrl, options = {}) {
  const cleaned = String(handleOrUrl).trim();
  const url = cleaned.startsWith('http')
    ? cleaned
    : `https://x.com/${cleaned.replace(/^@/, '')}`;
  return runFetch(url, options, 'profile');
}

// 统一 CDP 栈生命周期 + adapter 调用;list/profile 共用,具体抓取策略在 extract 内部分流
async function runFetch(url, options, expectedPageType) {
  const mode = options.mode || 'user';
  const limit = options.limit ?? 80;

  const browser = await createBrowser({ mode });
  const proxy = new ProxyClient(browser.proxyPort);

  let targetId;
  try {
    targetId = await proxy.newTab(url);
    await new Promise(r => setTimeout(r, PAGE_WARMUP_MS));

    const pageType = xAdapter.detect(url);
    if (pageType !== expectedPageType) {
      throw new Error(
        `x-adapter detected page type "${pageType}" but caller expected "${expectedPageType}" (url: ${url})`
      );
    }

    const ctx = { url, pageType, limit };
    const firstResult = await xAdapter.extract(proxy, targetId, ctx);

    // list 路径:store 读是 idempotent + 完整(含长推全文),单次 extract 就够了
    if (pageType === 'list') {
      return firstResult;
    }

    // profile 路径:DOM 爬虫仍需要 2-pass stabilize 吸收 lazy DOM,然后对 isTruncated 长推 hydrate
    await new Promise(r => setTimeout(r, STABILIZE_DELAY_MS));
    let secondResult = null;
    try {
      secondResult = await xAdapter.extract(proxy, targetId, ctx);
    } catch {
      return firstResult;
    }

    const mergedItems = mergeById(firstResult.items || [], secondResult.items || []);
    await hydrateTruncatedItems(proxy, mergedItems);

    return {
      ...secondResult,
      items: mergedItems,
      itemCount: mergedItems.length,
    };
  } finally {
    if (targetId) await proxy.close(targetId).catch(() => {});
    // user mode 下 browser.close() 是 no-op;managed mode 下真正回收 Chrome + proxy + tmp profile
    await browser.close().catch(() => {});
  }
}

// 对 items 中 isTruncated=true 的 tweet 单独访问 status URL 抓完整 text 替换。
// 顺序执行不并发,避免触发反爬;每条失败不 throw,保留截断版 + isTruncated=true 让 Business 层可感知。
async function hydrateTruncatedItems(proxy, items) {
  const targets = items.filter(t => t?.isTruncated && t?.statusUrl);
  for (const item of targets) {
    let tabId = null;
    try {
      tabId = await proxy.newTab(item.statusUrl);
      await new Promise(r => setTimeout(r, STATUS_PAGE_WARMUP_MS));
      const extractPromise = xAdapter.extract(proxy, tabId, { url: item.statusUrl, pageType: 'status' });
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('hydrate_timeout')), HYDRATE_PER_ITEM_TIMEOUT_MS),
      );
      const result = await Promise.race([extractPromise, timeoutPromise]);
      const full = result?.tweet?.text;
      if (typeof full === 'string' && full.length > (item.text || '').length) {
        item.text = full;
        item.textBlocks = result.tweet.textBlocks || [full];
        item.isTruncated = !!result.tweet.isTruncated;
        item.hydrated = true;
      }
    } catch {
      // 失败保留截断版 + isTruncated=true
    } finally {
      if (tabId) await proxy.close(tabId).catch(() => {});
    }
  }
}

// profile 2-pass 合并去重。不反向 import normalize.dedupTweets,几行代码不值得共享。
function mergeById(a, b) {
  const seen = new Set();
  const merged = [];
  for (const t of [...a, ...b]) {
    const id = t?.statusId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    merged.push(t);
  }
  return merged;
}
