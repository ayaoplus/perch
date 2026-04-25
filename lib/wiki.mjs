// wiki.mjs — Wiki / summaries 文件路径与读写辅助(v3)
//
// Tool 层(被 lib/report.mjs / scripts/wiki-write.mjs / scripts/summary-write.mjs 组合
// 使用)的可组合原子:
//   rawDailyPath(topic, date)
//   wikiDailyPath(topic, date)
//   summariesPath(topic)
//   prependSummaryEntry(topic, date, body)         — summaries.md 的 ## DATE 段 upsert
//   upsertWikiSection(topic, date, section, body)  — 当日 wiki 的 ## section: <name> 段 upsert
//
// v3 变化:upsertWikiSection 不再按"slot.start_hour 升序"排,新 section 追加到末尾,
// 同名替换。section 顺序由调用顺序决定 —— 这是 v3"调度交给外部"的自然延伸。

import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';

export function rawDailyPath(topic, date) {
  return path.join(topic.dataPath, 'raw', 'daily', `${date}.md`);
}

export function wikiDailyPath(topic, date) {
  return path.join(topic.dataPath, 'wiki', 'daily', `${date}.md`);
}

export function summariesPath(topic) {
  return path.join(topic.dataPath, 'summaries.md');
}

/**
 * 在 summaries.md 顶部插入一条日概览,**幂等 upsert**:同日期重复调用会用新内容替换。
 *
 * 插入点:第一段 `<!-- ... -->` 之后的第一个 `## ` 之前。文件不存在则新建。
 */
export async function prependSummaryEntry(topic, date, entryBody) {
  const p = summariesPath(topic);
  await mkdir(path.dirname(p), { recursive: true });

  const entry = `## ${date}\n${String(entryBody).trim()}\n\n`;

  if (!existsSync(p)) {
    const header = [
      `# ${topic.slug} — 日概览 summaries`,
      '',
      '<!-- 时间倒序,最新在上。由 perch report 的 evening 类 prompt 维护。 -->',
      '',
      entry,
    ].join('\n');
    await writeFile(p, header, 'utf-8');
    return p;
  }

  let content = await readFile(p, 'utf-8');
  content = removeExistingDayEntry(content, date);

  const commentEnd = content.indexOf('-->');
  const anchorStart = commentEnd >= 0 ? commentEnd + 3 : 0;
  const rel = content.slice(anchorStart).search(/^## /m);

  let newContent;
  if (rel >= 0) {
    const insertAt = anchorStart + rel;
    newContent = content.slice(0, insertAt) + entry + content.slice(insertAt);
  } else {
    newContent = content.endsWith('\n') ? content + entry : content + '\n' + entry;
  }

  await writeFile(p, newContent, 'utf-8');
  return p;
}

// 切掉 `## ${date}` 整段(含其后到下一个 `## ` 之前 或 EOF)。标题行必须完全匹配 `## YYYY-MM-DD`。
function removeExistingDayEntry(content, date) {
  const heading = `## ${date}`;
  const lines = content.split('\n');

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === heading) {
      start = i;
      break;
    }
  }
  if (start < 0) return content;

  let end = lines.length;
  for (let j = start + 1; j < lines.length; j++) {
    if (lines[j].startsWith('## ')) {
      end = j;
      break;
    }
  }

  lines.splice(start, end - start);
  return lines.join('\n');
}

/**
 * 幂等 upsert:把某个 section 的 markdown body 写到当日 wiki 文件的 `## section: <name>` 段。
 *
 * v3 语义:
 *   - 同 section 重跑 → 替换 body
 *   - 其他 section 原样保留
 *   - section 顺序按写入顺序(同名替换不改位置;新名追加到末尾)
 *   - 框架不强加顺序,顺序由调用者(cron / agent / 用户)决定
 *
 * 文件结构:
 *   # YYYY-MM-DD — <topic.slug>
 *
 *   <!-- 由 perch report 生成... -->
 *
 *   ## section: morning
 *   {morning body}
 *
 *   ## section: noon
 *   {noon body}
 *   ...
 *
 * 原子写:tmp + rename。
 *
 * @param {object} topic    — Topic 实例(只用 slug / dataPath 字段)
 * @param {string} date     — YYYY-MM-DD
 * @param {string} section  — section 名(任意 [a-z][a-z0-9-]* 标识)
 * @param {string} body     — 该 section 的 markdown 内容(不含外层 ## section: 标题)
 * @returns {Promise<string>} 写入后的绝对路径
 */
export async function upsertWikiSection(topic, date, section, body) {
  if (!/^[a-z][a-z0-9-]*$/.test(section)) {
    throw new Error(`upsertWikiSection: invalid section name "${section}" (must match ^[a-z][a-z0-9-]*$)`);
  }
  const filePath = wikiDailyPath(topic, date);
  await mkdir(path.dirname(filePath), { recursive: true });

  // 读已有 sections,保留写入顺序
  const sections = []; // [{name, body}]
  if (existsSync(filePath)) {
    const existing = await readFile(filePath, 'utf-8');
    for (const [name, sectionBody] of parseWikiSections(existing)) {
      sections.push({ name, body: sectionBody });
    }
  }

  // 同名 → 替换;新名 → 追加
  const idx = sections.findIndex(s => s.name === section);
  if (idx >= 0) {
    sections[idx] = { name: section, body: String(body).trim() };
  } else {
    sections.push({ name: section, body: String(body).trim() });
  }

  const header = buildWikiHeader(topic, date);
  const parts = sections.map(s => renderSection(s.name, s.body));
  const finalContent = header + '\n' + parts.join('\n') + (parts.length ? '' : '\n');

  const tmpPath = filePath + '.tmp';
  await writeFile(tmpPath, finalContent, 'utf-8');
  await rename(tmpPath, filePath);
  return filePath;
}

// 文件头部(boilerplate,每次 upsert 重新生成)
function buildWikiHeader(topic, date) {
  return [
    `# ${date} — ${topic.slug}`,
    '',
    '<!-- 由 perch report 生成。section 按写入顺序排列;同 section 重跑会替换自己那段,不影响其他 section。 -->',
    '',
  ].join('\n');
}

function renderSection(sectionName, body) {
  return `## section: ${sectionName}\n\n${String(body).trim()}\n\n`;
}

// 解析 `## section: <name>` 分段。锚点行必须**行首 + 完全匹配**。
function parseWikiSections(content) {
  const ANCHOR = /^## section: ([a-z][a-z0-9-]*)\s*$/;
  const sections = new Map();
  const order = [];
  const lines = content.split('\n');
  let currentName = null;
  let currentLines = [];

  for (const line of lines) {
    const m = ANCHOR.exec(line);
    if (m) {
      if (currentName !== null) {
        sections.set(currentName, currentLines.join('\n').trim());
      }
      currentName = m[1];
      if (!order.includes(currentName)) order.push(currentName);
      currentLines = [];
    } else if (currentName !== null) {
      currentLines.push(line);
    }
  }
  if (currentName !== null) {
    sections.set(currentName, currentLines.join('\n').trim());
  }
  return order.map(name => [name, sections.get(name)]);
}
