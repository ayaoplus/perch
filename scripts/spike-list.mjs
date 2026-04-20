#!/usr/bin/env node
// spike-list.mjs — S1.4 review gate #1
//
// 端到端跑一次 X List 抓取,把原始 tweet 对象经 normalize 转成 raw markdown
// block 输出到 stdout。串联 S1.1(CDP vendor)+ S1.2(fetchXList)+ S1.3(formatTweet),
// 验证整条链路可用 + 输出格式对齐 DESIGN §5。
//
// 用法:
//   node scripts/spike-list.mjs <list-url> [limit]
//
// 示例:
//   node scripts/spike-list.mjs https://x.com/i/lists/<id> 5
//
// 前置条件:
//   - 用户日常 Chrome 已开远程调试端口(默认自动发现 9222/9229/9333)
//   - Chrome 已登录 X
//   - CDP Proxy 没跑的话 browser-provider 会自动 fork(日志在 /tmp/perch-proxy.log)
//
// stderr 走诊断信息;stdout 走 markdown(可重定向到文件核对)。

import { fetchXList } from '../lib/x-fetcher.mjs';
import { formatTweet } from '../lib/normalize.mjs';

const listUrl = process.argv[2];
const limit = Number(process.argv[3] || 5);

if (!listUrl) {
  console.error('usage: node scripts/spike-list.mjs <list-url> [limit]');
  process.exit(1);
}

const result = await fetchXList(listUrl, { limit });

const listName = result.list?.name || '(no name)';
const owner = result.list?.ownerHandle ? ` owner=${result.list.ownerHandle}` : '';
const count = result.items?.length || 0;
console.error(`[spike-list] list="${listName}"${owner} items=${count} timelineType=${result.timelineType}`);

if (count === 0) {
  console.error('[spike-list] FAIL: 0 items. Likely not logged in, or list URL changed.');
  process.exit(1);
}

if (count < limit) {
  // review gate 要求严格:链路通但没拿满 limit 也要显性失败(exit 2),
  // 让 reviewer 明确看到 "链路 OK,但 gate 要求的容量未满足"。
  console.error(`[spike-list] PARTIAL: got ${count} of ${limit} requested. Link works but capacity not met.`);
  for (const tweet of result.items) {
    process.stdout.write(formatTweet(tweet));
  }
  process.exit(2);
}

for (const tweet of result.items) {
  process.stdout.write(formatTweet(tweet));
}
