// rotate.mjs — 月度归档工具
//
// 把 topic 数据目录下**非当月**的 raw/daily 和 wiki/daily 文件搬到 archive/YYYY-MM/。
// Topic Wiki(wiki/topic/)是长期资产,不归档。summaries.md 按月切分较复杂,v1 不处理
// (v2 再做,见 DESIGN §3.3 的月度 reset 意图)。
//
// 幂等:连跑多次 no-op — 若某月文件已经搬走了,下次 scan 就找不到它。

import path from 'node:path';
import { existsSync } from 'node:fs';
import { readdir, mkdir, rename } from 'node:fs/promises';

/**
 * 返回指定时区下的当前 YYYY-MM。
 */
export function currentMonth(timezone = 'Asia/Shanghai') {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
  }).format(new Date());
}

/**
 * 扫描 topic 数据目录,返回应当归档的 YYYY-MM 列表(不包括当月,去重,升序)。
 * 依据 `raw/daily/` 和 `wiki/daily/` 下文件名的 YYYY-MM- 前缀。
 */
export async function findArchivableMonths(topic) {
  const curr = currentMonth(topic.timezone);
  const scanDirs = [
    path.join(topic.dataPath, 'raw', 'daily'),
    path.join(topic.dataPath, 'wiki', 'daily'),
  ];
  const months = new Set();
  for (const dir of scanDirs) {
    if (!existsSync(dir)) continue;
    const files = await readdir(dir);
    for (const f of files) {
      const m = f.match(/^(\d{4}-\d{2})-/);
      if (m && m[1] !== curr) months.add(m[1]);
    }
  }
  return [...months].sort();
}

/**
 * 对指定月份,生成 "要搬什么文件到哪里" 的 plan。
 *
 * @returns {Promise<{archiveDir: string, moves: Array<{from: string, to: string}>}>}
 */
export async function planArchive(topic, month) {
  const archiveDir = path.join(topic.dataPath, 'archive', month);
  const moves = [];

  // raw/daily/YYYY-MM-*.md
  const rawSrc = path.join(topic.dataPath, 'raw', 'daily');
  if (existsSync(rawSrc)) {
    for (const f of await readdir(rawSrc)) {
      if (f.startsWith(`${month}-`) && f.endsWith('.md')) {
        moves.push({
          from: path.join(rawSrc, f),
          to: path.join(archiveDir, 'raw', 'daily', f),
        });
      }
    }
  }

  // wiki/daily/YYYY-MM-*.md
  const wikiSrc = path.join(topic.dataPath, 'wiki', 'daily');
  if (existsSync(wikiSrc)) {
    for (const f of await readdir(wikiSrc)) {
      if (f.startsWith(`${month}-`) && f.endsWith('.md')) {
        moves.push({
          from: path.join(wikiSrc, f),
          to: path.join(archiveDir, 'wiki', 'daily', f),
        });
      }
    }
  }

  return { archiveDir, moves };
}

/**
 * 执行 plan。mkdir target 父目录后顺序 rename。
 * target 已存在同名文件会被 overwrite(rename 默认行为)。
 */
export async function executePlan(plan) {
  for (const move of plan.moves) {
    await mkdir(path.dirname(move.to), { recursive: true });
    await rename(move.from, move.to);
  }
}
