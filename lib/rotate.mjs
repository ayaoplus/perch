// rotate.mjs — 月度归档工具
//
// 把 topic 数据目录下**非当月**的 raw/daily、wiki/daily 和 cache/articles/ 文件搬到
// archive/YYYY-MM/。Topic Wiki(wiki/topic/)是长期资产,不归档。summaries.md 按月切分较
// 复杂,v1 不处理(v2 再做,见 DESIGN §3.3 的月度 reset 意图)。
//
// 幂等:连跑多次 no-op — 若某月文件已经搬走了,下次 scan 就找不到它。

import path from 'node:path';
import { existsSync } from 'node:fs';
import { readdir, mkdir, rename, stat } from 'node:fs/promises';

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
 * 依据三处:
 *   - `raw/daily/YYYY-MM-*.md` 文件名前缀
 *   - `wiki/daily/YYYY-MM-*.md` 文件名前缀
 *   - `cache/articles/YYYY-MM/` 子目录名本身
 */
export async function findArchivableMonths(topic) {
  const curr = currentMonth(topic.timezone);
  const months = new Set();

  // 文件名前缀扫描(raw / wiki)
  for (const dir of [
    path.join(topic.dataPath, 'raw', 'daily'),
    path.join(topic.dataPath, 'wiki', 'daily'),
  ]) {
    if (!existsSync(dir)) continue;
    for (const f of await readdir(dir)) {
      const m = f.match(/^(\d{4}-\d{2})-/);
      if (m && m[1] !== curr) months.add(m[1]);
    }
  }

  // 子目录名扫描(cache/articles)
  const articlesDir = path.join(topic.dataPath, 'cache', 'articles');
  if (existsSync(articlesDir)) {
    for (const sub of await readdir(articlesDir)) {
      if (/^\d{4}-\d{2}$/.test(sub) && sub !== curr) {
        // 只把真实目录计入(防止意外的同名文件)
        try {
          const s = await stat(path.join(articlesDir, sub));
          if (s.isDirectory()) months.add(sub);
        } catch {}
      }
    }
  }

  return [...months].sort();
}

/**
 * 对指定月份,生成 "要搬什么文件到哪里" 的 plan。
 *
 * 归档三类:
 *   1. `raw/daily/YYYY-MM-*.md`                → `archive/YYYY-MM/raw/daily/`
 *   2. `wiki/daily/YYYY-MM-*.md`               → `archive/YYYY-MM/wiki/daily/`
 *   3. `cache/articles/YYYY-MM/*` 下的所有文件 → `archive/YYYY-MM/cache/articles/`
 *      (整目录搬;搬完后 executePlan 会留一个空的源目录,这里不特意清,下次 rotate no-op)
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

  // cache/articles/YYYY-MM/*
  const articleSrc = path.join(topic.dataPath, 'cache', 'articles', month);
  if (existsSync(articleSrc)) {
    for (const f of await readdir(articleSrc)) {
      moves.push({
        from: path.join(articleSrc, f),
        to: path.join(archiveDir, 'cache', 'articles', f),
      });
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
