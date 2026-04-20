// x-fetcher.mjs — 面向 perch 的 X 抓取入口(Layer 1,纯数据抓取)
//
// 组合 vendor 来的 browser-provider / proxy-client / x-adapter,对外只暴露两种
// 高层意图:fetchXList(listUrl) / fetchXProfile(handle|url)。两者都走同一个
// CDP 栈 + x-adapter.extract,返回 x-adapter 的原始 result 对象(包含 items 数组)。
//
// 默认 mode='user' — 假设用户日常 Chrome 已登录 X 并开着远程调试端口。
// x-adapter 自身不做登录墙检测(由上游 caller 保证登录态);没登录时最多返回空 items。
//
// 抖动吸收(Fetch 层 robustness,不是业务语义):
//   X 的 timeline 页面是 lazy DOM — 首次 extract 时看到的可能是 cache 的旧内容,最新
//   推文由异步请求 append 到顶部。默认 fetchX*` 会做 2-pass extract(warmup →
//   extract1 → stabilize delay → extract2 → 按 statusId 合并),复用同一 tab,不 navigate
//   两次。调用方可传 `options.stabilize: false` 退化成单次 extract(spike 或探测场景)。
//
// 长推文完整性(Fetch 层 robustness,不是业务语义):
//   X 在 list/profile timeline 里对超长推文(>280字)会 UI 截断,`isTruncated=true` 且
//   tweetText 是截断版。默认 fetchX*` 会在 2-pass 合并后,对每条 isTruncated 单独访问
//   status page 取完整 tweetText 替换(hydrate)。hydrate 失败会保留截断文本 + isTruncated
//   标记不丢,Business 层可感知。调用方可传 `options.hydrateTruncated: false` 关闭。
//
// 分层约定(这层刻意不做的事):
//   - 不按时间排序 items:返回 x-adapter 原始 DOM 顺序。profile 路径顶部可能是 pinned
//     tweet(非时间顺序);list 路径天然时间倒序。需要统一顺序的调用方自行过
//     `normalize.sortTweetsByTime(items)`
//   - 不做时间窗口过滤:业务层(collect)基于 readExistingIds 做跨次去重
//   - 不识别/过滤 pinned:pinned 是"业务噪音" not "数据异常",交给业务层决策
//
// 真实业务的调用管线(由 Step 2 的 collect 层编排,不是这里):
//   fetchXList/Profile(generous limit)
//     → normalize.dedupTweets(跨源合并)
//     → readExistingIds 对比已有文件,过滤已存在
//     → normalize.sortTweetsByTime
//     → formatTweet 追加写盘
//
// 为什么不在这里统一 API:当前只有 list 在跑,强行抽象出 `fetchX({type, url})`
// 或 `fetchXMultiple(sources)` 都是为假想需求设计。保持两个命名清晰的函数。

import { createBrowser } from './browser-provider.mjs';
import { ProxyClient } from './proxy-client.mjs';
import xAdapter from './x-adapter.mjs';

// 页面初次渲染等待:打开 tab 后等 DOM 初始化稳定再抓。
const PAGE_WARMUP_MS = 1500;
// 2-pass extract 之间的等待:给 X 的 lazy DOM 足够时间把最新推文 append 到顶部。
const STABILIZE_DELAY_MS = 3000;
// Hydrate 访问 status page 后等 article 渲染完成的时间
const STATUS_PAGE_WARMUP_MS = 1500;
// Hydrate 每条的总超时,避免单条卡死拖垮整个 collect
const HYDRATE_PER_ITEM_TIMEOUT_MS = 15000;

/**
 * 抓取一个 X List 的最新推文。
 * @param {string} listUrl — 形如 https://x.com/i/lists/1234567890
 * @param {object} [options]
 * @param {number} [options.limit=80] — 抓取条数上限,x-adapter 内部会 clamp 到 [1,200]
 * @param {'user'|'managed'} [options.mode='user'] — 'user' 附着已有日常 Chrome,'managed' 启动独立 Chrome
 * @param {boolean} [options.stabilize=true] — 2-pass extract 吸收 timeline lazy DOM,false 退化成单次
 * @returns {Promise<object>} x-adapter 返回的 result 对象:{ contentType, timelineType:'list', list, items, ... }
 */
export async function fetchXList(listUrl, options = {}) {
  return fetchXTimeline(listUrl, options, 'list');
}

/**
 * 抓取一个 X 用户的个人时间线。
 *
 * 支持的输入形态:
 *   - `'elonmusk'` 或 `'@elonmusk'`      → https://x.com/elonmusk(主 tab)
 *   - `'elonmusk/media'` / `'.../articles'` / `'.../with_replies'`  → 对应 profile 子 tab
 *   - 完整 URL(`https://x.com/...` 或 `https://twitter.com/...`)  → 原样透传
 *
 * 保留字(/home, /explore, /i, /search 等)会被 x-adapter 的 detect() 判定为 'unknown',
 * 随后 fetchXTimeline 里的 pageType self-check 会 throw。
 *
 * 返回 shape(来自 x-adapter._extractProfile):
 *   {
 *     contentType: 'timeline',
 *     timelineType: 'profile',
 *     profile: { handle, name, bio, location, followers, following, tabs, ... },
 *     items: Array<tweet>,   // 形态与 fetchXList 完全一致,同一个 normalizeCard 产生
 *     itemCount, format
 *   }
 *
 * DESIGN §7 R1 风险:profile DOM 的 `data-testid` 选择器(UserName/UserDescription/UserUrl/...)
 * 是 X 内部标识,但仍可能随改版漂移。真正验证需要 S1.6 的 live spike。
 *
 * 支持 `options.stabilize`(同 fetchXList)、`options.limit`、`options.mode`。
 */
export async function fetchXProfile(handleOrUrl, options = {}) {
  const cleaned = String(handleOrUrl).trim();
  const url = cleaned.startsWith('http')
    ? cleaned
    : `https://x.com/${cleaned.replace(/^@/, '')}`;
  return fetchXTimeline(url, options, 'profile');
}

// 统一的 CDP 栈生命周期 + adapter 调用。list / profile 两种入口共享此链路。
async function fetchXTimeline(url, options, expectedPageType) {
  const mode = options.mode || 'user';
  const limit = options.limit ?? 80;
  const stabilize = options.stabilize !== false;  // 默认开启

  const browser = await createBrowser({ mode });
  const proxy = new ProxyClient(browser.proxyPort);

  let targetId;
  try {
    targetId = await proxy.newTab(url);
    await new Promise(r => setTimeout(r, PAGE_WARMUP_MS));

    // 交叉验证 URL 分类和调用意图 — 错配通常意味着 URL 或 adapter 的假设有偏。
    const pageType = xAdapter.detect(url);
    if (pageType !== expectedPageType) {
      throw new Error(
        `x-adapter detected page type "${pageType}" but caller expected "${expectedPageType}" (url: ${url})`
      );
    }

    const ctx = { url, pageType, limit };
    const firstResult = await xAdapter.extract(proxy, targetId, ctx);

    if (!stabilize) {
      return firstResult;
    }

    // 2-pass extract:等 X 的 lazy DOM 把最新推文 append 到顶部,然后再在**同一个 tab** 上抓
    // 一次。两次合并按 statusId 去重,保留 insertion order。若第二次抓失败(极少见的 DOM
    // 临时状态),退化为第一次的结果 — 不让稳定性机制自己成为失败来源。
    await new Promise(r => setTimeout(r, STABILIZE_DELAY_MS));
    let secondResult = null;
    try {
      secondResult = await xAdapter.extract(proxy, targetId, ctx);
    } catch {
      return firstResult;
    }

    const mergedItems = mergeById(firstResult.items || [], secondResult.items || []);

    // Hydrate truncated tweets:X 在 list/profile timeline 里对长推(>280字)会 UI 截断,
    // tweetText 只有截断版,末尾有 "Show more" 链接(isTruncated=true)。要拿完整正文必须
    // 单独访问该 tweet 的 status page,那里 article DOM 的 tweetText 是展开的。
    //
    // 这是 Fetch 层的数据完整性兜底,和 2-pass stabilize 同级,不是业务决策。默认开启,
    // spike / 探测场景可传 options.hydrateTruncated=false 关闭。
    if (options.hydrateTruncated !== false) {
      await hydrateTruncatedItems(proxy, mergedItems);
    }

    return {
      ...secondResult,              // 用 pass 2 的 meta(list name / profile 信息通常更新,差异很小)
      items: mergedItems,
      itemCount: mergedItems.length,
    };
  } finally {
    if (targetId) {
      await proxy.close(targetId).catch(() => {});
    }
    // user mode 下 browser.close() 是 no-op;managed mode 下真正回收 Chrome + proxy + tmp profile。
    await browser.close().catch(() => {});
  }
}

/**
 * 对 items 中 isTruncated=true 的 tweet 单独访问 status URL,拿完整 tweetText 替换 `text` 字段。
 *
 * 顺序执行,不并发:避免对 X 触发反爬/限流。每条失败不 throw(失败意味着保留截断版 +
 * isTruncated=true 标记,Business 层可感知);只在 hydrate 成功时清 isTruncated,置 hydrated=true。
 */
async function hydrateTruncatedItems(proxy, items) {
  const targets = items.filter(t => t?.isTruncated && t?.statusUrl);
  for (const item of targets) {
    let tabId = null;
    try {
      tabId = await proxy.newTab(item.statusUrl);
      await new Promise(r => setTimeout(r, STATUS_PAGE_WARMUP_MS));
      const extractPromise = xAdapter.extract(proxy, tabId, {
        url: item.statusUrl,
        pageType: 'status',
      });
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('hydrate_timeout')), HYDRATE_PER_ITEM_TIMEOUT_MS),
      );
      const result = await Promise.race([extractPromise, timeoutPromise]);
      const full = result?.tweet?.text;
      if (typeof full === 'string' && full.length > (item.text || '').length) {
        item.text = full;
        item.textBlocks = result.tweet.textBlocks || [full];
        item.isTruncated = !!result.tweet.isTruncated;  // status page 也可能保留 Show more(极罕见)
        item.hydrated = true;
      }
    } catch {
      // 失败保留截断文本 + isTruncated=true,Business 层能看出 hydrate 未完成
    } finally {
      if (tabId) await proxy.close(tabId).catch(() => {});
    }
  }
}

// 本地 mergeById:两次 extract 的 items 合并去重。功能上等价 normalize.dedupTweets,但不依赖
// 上层 Tool 层(x-fetcher 是 Layer 1,反向 import normalize 会污染分层)。几行代码不值得共享。
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
