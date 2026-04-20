#!/usr/bin/env node
// spike-profile.mjs — S1.6 review gate #2
//
// 端到端跑一次 X Profile 抓取,展示原始 DOM 顺序 和 时间排序后 两个视角的差异,
// 让 review agent 直观看到 pinned tweet 的位置与排序后的效果。
//
// 用法:
//   node scripts/spike-profile.mjs <handle-or-url> [limit]
//
// 示例:
//   node scripts/spike-profile.mjs AI_Jasonyu 5
//   node scripts/spike-profile.mjs https://x.com/elonmusk 8
//
// 前置条件:
//   - 用户日常 Chrome 开远程调试端口(9222/9229/9333 其一),已登录 X
//   - CDP Proxy 没跑的话 browser-provider 会自动 fork(日志在 /tmp/perch-proxy.log)
//
// 退出码:
//   0 — 拿满 limit 条,链路和容量都通
//   1 — 抓到 0 条(登录态丢失 / handle 写错 / profile 被墙)
//   2 — 拿到 >0 但 < limit 条(链路通,但容量未满足 gate 要求)

import { fetchXProfile } from '../lib/x-fetcher.mjs';
import { formatTweet, sortTweetsByTime } from '../lib/normalize.mjs';

const handleOrUrl = process.argv[2];
const limit = Number(process.argv[3] || 5);

if (!handleOrUrl) {
  console.error('usage: node scripts/spike-profile.mjs <handle-or-url> [limit]');
  process.exit(1);
}

const result = await fetchXProfile(handleOrUrl, { limit });

const profileHandle = result.profile?.handle || '(no handle)';
const profileName = result.profile?.name || '';
const count = result.items?.length || 0;
console.error(
  `[spike-profile] handle="${profileHandle}"${profileName ? ` name="${profileName}"` : ''} ` +
  `items=${count} timelineType=${result.timelineType}`
);

if (count === 0) {
  console.error('[spike-profile] FAIL: 0 items. Likely not logged in, handle typo, or profile gated.');
  process.exit(1);
}

// 呈现两个视角:原始 DOM 顺序(pinned 可能在前) vs 按 authoredAt 重排后(最新在前)。
// 业务层(Step 2 的 collect)会用 sortTweetsByTime + 窗口过滤来拿"真正的最近推文"。
const rawOrder = result.items;
const sorted = sortTweetsByTime(rawOrder);

console.error('\n--- 原始 DOM 顺序(raw) ---');
for (const t of rawOrder) {
  console.error(`  ${t?.authoredAt?.dateTime || '(no time)'}  @${t?.author?.handle || '?'}`);
}
console.error('\n--- 按 authoredAt 时间倒序(sorted) ---');
for (const t of sorted) {
  console.error(`  ${t?.authoredAt?.dateTime || '(no time)'}  @${t?.author?.handle || '?'}`);
}
console.error('');

// stdout 走"pinned 沉底"后的 markdown,仅为方便 review 对账 — **不是**真实业务 output。
// Business 层(Step 2 collect)要补回被 pinned 挤掉的最近推文,需要 generous limit +
// 时间窗过滤,单靠 sortTweetsByTime 无法补齐被 fetch limit 砍掉的那条。
for (const tweet of sorted) {
  process.stdout.write(formatTweet(tweet));
}

if (count < limit) {
  console.error(`[spike-profile] PARTIAL: got ${count} of ${limit} requested.`);
  process.exit(2);
}
