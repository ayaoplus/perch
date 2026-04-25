// wiki.mjs — Wiki / summaries 文件路径与读写辅助
//
// Tool 层(被 lib/analyze.mjs / lib/digest.mjs / scripts/wiki-write.mjs / scripts/summary-write.mjs 组合使用)的可组合原子:
//   rawDailyPath(topic, date)                          — 当日 raw markdown 路径
//   wikiDailyPath(topic, date)                         — 当日 wiki 路径(整天一份)
//   summariesPath(topic)                               — topic 的 summaries.md 路径
//   prependSummaryEntry                                — summaries.md 的 `## DATE` 段 upsert
//   upsertWikiSlotSection(topic, date, slot, body, slots) — 当日 wiki 的 `## slot: <name>` 段 upsert
//
// 路径布局见 DESIGN §4.2。wiki/daily 的设计:每天 1 份文件,多 slot 各占一个
// `## slot: <name>` 二级 section,按 slot.start_hour 升序排列。同 slot 重跑幂等替换。

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
 * 在 summaries.md 顶部插入一条日概览,**幂等 upsert**:同日期重复调用会用新内容替换旧条目,
 * 不会生成重复的 `## YYYY-MM-DD` 段落。
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
      '<!-- 时间倒序,最新在上。由 perch digest 维护。 -->',
      '',
      entry,
    ].join('\n');
    await writeFile(p, header, 'utf-8');
    return p;
  }

  let content = await readFile(p, 'utf-8');

  // 幂等:若已有 `## {date}` 条目,先切掉它(含其后到下一个 `## ` 标题之前的整段)
  content = removeExistingDayEntry(content, date);

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

// 切掉 `## ${date}` 整段(含其后到下一个 `## ` 标题前 或 EOF)。标题行必须是完整的
// `## YYYY-MM-DD`,避免把 `## 2026-04-20-something` 之类误切。
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
 * 幂等 upsert:把某个 slot 的报告 body 写到当日 wiki 文件的 `## slot: <name>` section。
 *
 * 文件结构(新建或重写时):
 *   # YYYY-MM-DD — <topic.slug>
 *
 *   <!-- 由 perch report 生成...(自动回填) -->
 *
 *   ## slot: morning
 *
 *   {body of morning slot}
 *
 *   ## slot: noon
 *
 *   {body of noon slot}
 *   ...
 *
 * 语义:
 *   - 同 slot 重跑 → 替换该 section body(不重复追加)
 *   - 其他 slot 的 section 原样保留
 *   - sections 始终按 `slots` 参数传入的 start_hour 升序排列(由 loadTopic 保证已排序)
 *   - 不认识的 slot(SCHEMA 改过 slot 名但 wiki 留着旧 section)保留在末尾,不丢数据
 *   - 文件头部 + 注释每次都**重新生成**,视为"由框架拥有的 boilerplate"
 *
 * 原子写:先写 `<path>.tmp` 再 rename,避免中途崩溃留下半截文件。
 *
 * @param {object} topic — loadTopic 返回的对象
 * @param {string} date  — YYYY-MM-DD
 * @param {string} slot  — slot name(必须在 topic.slots 里)
 * @param {string} body  — 该 slot 的 markdown 报告内容(不含 `## slot: <name>` 标题行)
 * @param {Array<{name: string, start_hour: number}>} slots — topic.slots,决定排序
 * @returns {Promise<string>} 写入后的文件绝对路径
 */
export async function upsertWikiSlotSection(topic, date, slot, body, slots) {
  const filePath = wikiDailyPath(topic, date);
  await mkdir(path.dirname(filePath), { recursive: true });

  // 读已有 sections(若文件存在)
  const sections = new Map();
  if (existsSync(filePath)) {
    const existing = await readFile(filePath, 'utf-8');
    for (const [name, sectionBody] of parseWikiSections(existing)) {
      sections.set(name, sectionBody);
    }
  }

  // 覆盖当前 slot
  sections.set(slot, String(body).trim());

  // 按 slots 顺序拼装,未知 slot(改过 SCHEMA 后的残留)保留到末尾,不丢数据
  const knownOrder = slots.map(s => s.name);
  const parts = [];
  for (const name of knownOrder) {
    if (sections.has(name)) parts.push(renderSection(name, sections.get(name)));
  }
  for (const [name, content] of sections) {
    if (!knownOrder.includes(name)) parts.push(renderSection(name, content));
  }

  const header = buildWikiHeader(topic, date);
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
    '<!-- 由 perch analyze 生成。sections 按 slot.start_hour 升序排列;同 slot 重跑会替换自己那段,不影响其他 slot。 -->',
    '',
  ].join('\n');
}

function renderSection(slotName, body) {
  return `## slot: ${slotName}\n\n${String(body).trim()}\n\n`;
}

// 解析 `## slot: <name>` 分段。锚点行必须是**行首 + 完全匹配**,Claude 报告内容里的普通
// ## 标题(如 `## Q1. 最高声量事件`)不会被误判。
function parseWikiSections(content) {
  const ANCHOR = /^## slot: ([a-z][a-z0-9-]*)\s*$/;
  const sections = new Map();
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
      currentLines = [];
    } else if (currentName !== null) {
      currentLines.push(line);
    }
    // 锚点之前的内容(文件头 + 注释)忽略,由 buildWikiHeader 统一生成
  }
  if (currentName !== null) {
    sections.set(currentName, currentLines.join('\n').trim());
  }
  return sections;
}
