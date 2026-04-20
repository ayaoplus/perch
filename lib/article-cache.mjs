// article-cache.mjs — Twitter Article 全文的按月缓存
//
// 当 report 阶段(Claude 会话)看到 raw block 里有 `🖼️ article: "..."` 预览且判断回答问题
// 需要正文时,会调用 `scripts/fetch-article.mjs <status_url>` 用 CDP 抓完整文章 markdown。
// 抓回来的正文写到这个缓存,同一 statusId 跨多个 slot / 多次 report 共享;月末 rotate 把
// 上月缓存目录一并搬到 archive(生命周期与 raw/daily / wiki/daily 对齐)。
//
// 路径布局(DESIGN §4.2):
//   <topic-path>/cache/articles/YYYY-MM/<statusId>.md
//
// 跨月策略(v1 简化):缓存按"引用发生月份"归档,跨月重引用会重抓一次。这是故意的:
// 避免跨 archive/cache 查找,月末 rotate 可以无脑整目录 rename。article 不是高频重复项,
// 重抓成本可控。如果将来变成热点(数据支持),再升级成按 statusId 全局扁平缓存。
//
// 缓存文件格式(给 Claude 读的,顶部一份精简 YAML-ish 元信息 + 正文 markdown):
//   ---
//   title: <文章标题>
//   author: <@handle>
//   status_url: <URL>
//   fetched_at: <ISO 时间>
//   text_length: <N>
//   ---
//
//   <markdown 正文>

import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

/**
 * 返回 "当前月" 的 article 缓存目录(绝对路径)。`date` 是 YYYY-MM-DD,前 7 位作为月份。
 */
export function articleCacheDir(topic, date) {
  const month = date.slice(0, 7);
  return path.join(topic.dataPath, 'cache', 'articles', month);
}

/**
 * 返回指定 statusId 的缓存文件路径(绝对)。
 */
export function articleCachePath(topic, date, statusId) {
  return path.join(articleCacheDir(topic, date), `${statusId}.md`);
}

/**
 * 从 statusUrl 里解析 `/status/(\d+)`。返回 string 或 null。
 */
export function statusIdFromUrl(statusUrl) {
  const m = String(statusUrl || '').match(/\/status\/(\d+)/);
  return m ? m[1] : null;
}

/**
 * 是否在当前月份的缓存里已有该 article。
 */
export function hasCachedArticle(topic, date, statusId) {
  return existsSync(articleCachePath(topic, date, statusId));
}

/**
 * 读取缓存的完整内容(含头部 frontmatter + 正文)。返回字符串或 null(未命中)。
 */
export async function readCachedArticle(topic, date, statusId) {
  const p = articleCachePath(topic, date, statusId);
  if (!existsSync(p)) return null;
  return await readFile(p, 'utf-8');
}

/**
 * 写入/覆盖缓存。meta 字段缺失会用空串兜底;正文必填。
 *
 * @param {object} topic     — loadTopic 返回的对象
 * @param {string} date      — YYYY-MM-DD(被引用日,决定落在哪个月的缓存目录)
 * @param {string} statusId  — tweet/article 的 status id(唯一 key)
 * @param {object} meta      — { title?, author?, status_url?, text_length? }
 * @param {string} markdown  — article 的完整 markdown 正文
 * @returns {Promise<string>} 写入的绝对路径
 */
export async function writeCachedArticle(topic, date, statusId, meta, markdown) {
  const p = articleCachePath(topic, date, statusId);
  await mkdir(path.dirname(p), { recursive: true });
  const header = [
    '---',
    `title: ${oneLine(meta?.title)}`,
    `author: ${oneLine(meta?.author)}`,
    `status_url: ${oneLine(meta?.status_url)}`,
    `fetched_at: ${new Date().toISOString()}`,
    `text_length: ${Number(meta?.text_length) || (markdown?.length || 0)}`,
    '---',
    '',
  ].join('\n');
  await writeFile(p, header + (markdown || ''), 'utf-8');
  return p;
}

// 安全地把 frontmatter 里的值压成单行,避免换行 / 冒号破坏简易 YAML 解析
function oneLine(v) {
  return String(v || '').replace(/\s+/g, ' ').trim();
}
