// x-fetcher.mjs — 面向 perch 的 X 抓取入口(Layer 1,纯数据抓取)
//
// 组合 browser-provider / proxy-client / x-adapter,对外暴露两种高层意图:
//   - fetchXList(listUrl)         — 从 X redux store 读 list timeline
//   - fetchXProfile(handle|url)   — 从 X redux store 读 user timeline
//
// 默认 mode='user' — 假设用户日常 Chrome 已登录 X 并开着远程调试端口。
// x-adapter 自身不做登录墙检测(由上游 caller 保证登录态);没登录时最多返回空 items。
//
// 分层约定(这层刻意不做的事):
//   - 不按时间排序 items:返回 adapter 原始顺序。profile 顶部可能是 pinned tweet,
//     list 天然按 X 的时间倒序。需要统一顺序的调用方过 normalize.sortTweetsByTime
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

// 打开 tab 后等 DOM / redux store 初始化的首屏时间
const PAGE_WARMUP_MS = 1500;

/**
 * 抓取一个 X List 的最新推文,从 X 内部 redux store 读取。
 * @param {string} listUrl — 形如 https://x.com/i/lists/1234567890
 * @param {object} [options]
 * @param {number} [options.limit=80] — 抓取条数上限,adapter 内部 clamp 到 [1, 200]
 * @param {'user'|'managed'} [options.mode='user'] — 'user' 附着已有 Chrome,'managed' 启动独立 Chrome
 * @returns {Promise<object>} { contentType, timelineType:'list', list, items, entriesInStore, missingIdCount, error }
 */
export async function fetchXList(listUrl, options = {}) {
  return runFetch(listUrl, options, 'list');
}

/**
 * 抓取一个 X 用户的个人时间线,从 X 内部 redux store 读取。
 *
 * 输入形态:
 *   - 'elonmusk' 或 '@elonmusk'                              → https://x.com/elonmusk
 *   - 'elonmusk/media' / '.../articles' / '.../with_replies' → 对应 profile 子 tab
 *   - 完整 URL(https://x.com/... 或 https://twitter.com/...) → 原样透传
 *
 * 保留字(/home, /explore, /i, /search)会被 adapter 的 detect() 判定为 'unknown',
 * runFetch 里的 pageType self-check 会 throw。
 *
 * @returns {Promise<object>} { contentType, timelineType:'profile', profile, items, entriesInStore, ... }
 */
export async function fetchXProfile(handleOrUrl, options = {}) {
  const cleaned = String(handleOrUrl).trim();
  const url = cleaned.startsWith('http')
    ? cleaned
    : `https://x.com/${cleaned.replace(/^@/, '')}`;
  return runFetch(url, options, 'profile');
}

// 统一 CDP 栈生命周期 + adapter 调用。list / profile 都从 redux store 读,单次 extract 即可。
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

    return await xAdapter.extract(proxy, targetId, { url, pageType, limit });
  } finally {
    if (targetId) await proxy.close(targetId).catch(() => {});
    // user mode 下 browser.close() 是 no-op;managed mode 下真正回收 Chrome + proxy + tmp profile
    await browser.close().catch(() => {});
  }
}
