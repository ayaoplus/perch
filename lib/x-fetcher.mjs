// x-fetcher.mjs — 面向 perch 的 X 抓取入口
//
// 组合 vendor 来的 browser-provider / proxy-client / x-adapter,对外只暴露两种
// 高层意图:fetchXList(listUrl) / fetchXProfile(handle|url)。两者都走同一个
// CDP 栈 + x-adapter.extract,返回 x-adapter 的原始 result 对象(包含 items 数组)。
//
// 默认 mode='user' — 假设用户日常 Chrome 已登录 X 并开着远程调试端口。
// x-adapter 自身不做登录墙检测(anyreach 的 adapter-runner 才做);没登录时最多返回空 items。
//
// 备注:S1.2 只正式验证 list 路径;profile 路径(S1.5)的 DOM 差异是 DESIGN §7 R1 的风险点,
// 这里导出占位,真正 spike 在 S1.6 的 review gate。

import { createBrowser } from './browser-provider.mjs';
import { ProxyClient } from './proxy-client.mjs';
import xAdapter from './x-adapter.mjs';

// 页面初次渲染等待,对齐 anyreach adapter-runner 的 1.5s 缓冲。
const PAGE_WARMUP_MS = 1500;

/**
 * 抓取一个 X List 的最新推文。
 * @param {string} listUrl — 形如 https://x.com/i/lists/1234567890
 * @param {object} [options]
 * @param {number} [options.limit=80] — 抓取条数上限,x-adapter 内部会 clamp 到 [1,200]
 * @param {'user'|'managed'} [options.mode='user'] — 'user' 附着已有日常 Chrome,'managed' 启动独立 Chrome
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
    return await xAdapter.extract(proxy, targetId, ctx);
  } finally {
    if (targetId) {
      await proxy.close(targetId).catch(() => {});
    }
    // user mode 下 browser.close() 是 no-op;managed mode 下真正回收 Chrome + proxy + tmp profile。
    await browser.close().catch(() => {});
  }
}
