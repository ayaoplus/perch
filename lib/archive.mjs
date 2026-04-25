// archive.mjs — Archive 角色:月度归档
//
// 对应 v1 lib/rotate.mjs 的归档逻辑,提升为 Topic.method。把 topic 数据目录下非当
// 月的 raw/daily / wiki/daily / cache/articles/<月>/ 搬到 archive/YYYY-MM/。Topic
// Wiki(wiki/topic/)是长期资产,不归档。summaries.md 的月度切分较复杂,v2.x 再做。
//
// 幂等:连跑多次 no-op — 文件搬走后下次 scan 就找不到它。

import path from 'node:path';
import { existsSync } from 'node:fs';
import { readdir, mkdir, rename, stat, access } from 'node:fs/promises';

/**
 * 对一个 Topic 跑 archive。
 *
 * @param {Topic} topic
 * @param {{
 *   dryRun?: boolean,
 *   log?: (msg: string) => void,
 * }} opts
 * @returns {Promise<{
 *   topic: string, dryRun: boolean,
 *   months: string[],
 *   moves: Array<{month: string, from: string, to: string}>,
 *   totalMoves: number,
 * }>}
 */
export async function archive(topic, opts = {}) {
  const log = opts.log || ((msg) => process.stderr.write(`[archive] ${msg}\n`));
  const dryRun = !!opts.dryRun;

  log(`topic=${topic.slug} dataPath=${topic.dataPath}${dryRun ? ' (dry-run)' : ''}`);

  const months = await findArchivableMonths(topic);
  if (months.length === 0) {
    log('no archivable months found (likely all files belong to current month)');
    return { topic: topic.slug, dryRun, months: [], moves: [], totalMoves: 0 };
  }
  log(`archivable months: ${months.join(', ')}`);

  const allMoves = [];
  for (const month of months) {
    const plan = await planArchive(topic, month);
    log(`-- ${month}: ${plan.moves.length} file(s) → ${path.relative(topic.dataPath, plan.archiveDir)}/`);
    for (const move of plan.moves) {
      const relFrom = path.relative(topic.dataPath, move.from);
      const relTo = path.relative(topic.dataPath, move.to);
      log(`   ${relFrom}  →  ${relTo}`);
      allMoves.push({ month, from: move.from, to: move.to });
    }
    if (!dryRun) {
      await executePlan(plan);
    }
  }

  log(`total: ${allMoves.length} file(s) ${dryRun ? 'would be' : 'were'} archived`);
  return {
    topic: topic.slug,
    dryRun,
    months,
    moves: allMoves,
    totalMoves: allMoves.length,
  };
}

/**
 * 返回指定时区下的当前 YYYY-MM。
 */
export function currentMonth(timezone = 'Asia/Shanghai') {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone, year: 'numeric', month: '2-digit',
  }).format(new Date());
}

/**
 * 扫描 topic 数据目录,返回应当归档的 YYYY-MM 列表(不含当月,去重,升序)。
 */
export async function findArchivableMonths(topic) {
  const curr = currentMonth(topic.timezone);
  const months = new Set();

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

  const articlesDir = path.join(topic.dataPath, 'cache', 'articles');
  if (existsSync(articlesDir)) {
    for (const sub of await readdir(articlesDir)) {
      if (/^\d{4}-\d{2}$/.test(sub) && sub !== curr) {
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
 * 对指定月份生成归档 plan。归档三类:
 *   1. raw/daily/YYYY-MM-*.md          → archive/YYYY-MM/raw/daily/
 *   2. wiki/daily/YYYY-MM-*.md         → archive/YYYY-MM/wiki/daily/
 *   3. cache/articles/YYYY-MM/*        → archive/YYYY-MM/cache/articles/
 */
export async function planArchive(topic, month) {
  const archiveDir = path.join(topic.dataPath, 'archive', month);
  const moves = [];

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
 * 执行 plan。mkdir target 父目录后顺序 rename;target 已存在则 skip(数据保护)。
 */
export async function executePlan(plan) {
  for (const move of plan.moves) {
    await mkdir(path.dirname(move.to), { recursive: true });
    try {
      await access(move.to);
      // 目标已存在 — 跳过,不覆盖
      continue;
    } catch {
      // 目标不存在,正常执行
    }
    await rename(move.from, move.to);
  }
}
