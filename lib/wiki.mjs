// wiki.mjs — Wiki / summaries 文件路径与读写辅助
//
// Business 层(scripts/report.mjs 等)组合使用的可组合原子:
//   rawDailyPath(topic, date)         — 当日 raw markdown 路径
//   wikiDailyPath(topic, date, slot)  — 当日某时段 wiki 路径
//   summariesPath(topic)              — topic 的 summaries.md 路径
//   prependSummaryEntry               — 在 summaries.md 顶部(HTML 注释之后)插入一条日条目
//
// 路径布局见 DESIGN §4.2。

import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

export function rawDailyPath(topic, date) {
  return path.join(topic.dataPath, 'raw', 'daily', `${date}.md`);
}

export function wikiDailyPath(topic, date, slot) {
  return path.join(topic.dataPath, 'wiki', 'daily', `${date}-${slot}.md`);
}

export function summariesPath(topic) {
  return path.join(topic.dataPath, 'summaries.md');
}

/**
 * 在 summaries.md 顶部插入一条日概览,保持时间倒序。
 *
 * 插入点:第一行注释块 `<!-- ... -->` 之后的第一个 `## ` 标题之前。若文件不存在会新建
 * 一个带头部说明的空文件再插入。
 *
 * @param {object} topic     — loadTopic 返回的对象
 * @param {string} date      — YYYY-MM-DD
 * @param {string} entryBody — 条目正文(不含 `## YYYY-MM-DD` 标题行,本函数会自动包)
 * @returns {Promise<string>} 写入后的文件路径
 */
export async function prependSummaryEntry(topic, date, entryBody) {
  const p = summariesPath(topic);
  await mkdir(path.dirname(p), { recursive: true });

  const entry = `## ${date}\n${String(entryBody).trim()}\n\n`;

  if (!existsSync(p)) {
    const header = [
      `# ${topic.slug} — 日概览 summaries`,
      '',
      '<!-- 时间倒序,最新在上。由 /perch report evening 维护。 -->',
      '',
      entry,
    ].join('\n');
    await writeFile(p, header, 'utf-8');
    return p;
  }

  const content = await readFile(p, 'utf-8');
  // 定位锚点:第一段 `<!-- ... -->` 注释之后的第一个 `## ` 标题
  const commentEnd = content.indexOf('-->');
  const anchorStart = commentEnd >= 0 ? commentEnd + 3 : 0;
  const rel = content.slice(anchorStart).search(/^## /m);

  let newContent;
  if (rel >= 0) {
    const insertAt = anchorStart + rel;
    newContent = content.slice(0, insertAt) + entry + content.slice(insertAt);
  } else {
    // 文件有头部但还没有任何 `## `:追加到末尾
    newContent = content.endsWith('\n') ? content + entry : content + '\n' + entry;
  }

  await writeFile(p, newContent, 'utf-8');
  return p;
}
