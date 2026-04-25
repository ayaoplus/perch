// digest.mjs — Digest 角色:当日 wiki → summaries.md 的 `## YYYY-MM-DD` 条目
//
// v1 里这步是 evening prompt 的"附加任务",和 analyze 绑在一起。v2 拆出独立 method:
//   - analyze 只负责生成 wiki section
//   - digest 独立读已生成的 wiki,蒸馏成 5-7 句日概览,prepend 到 summaries.md
//
// Topic 可在 templates/topics/<slug>/digest.md 提供自定义模板;缺省走通用 fallback。
//
// 模式同 analyze:
//   - skill 模式(默认):打 stdout,Claude 接棒生成 summary 条目 → pipe 给 summary-write
//   - direct 模式(v2.x):lib/llm.mjs::complete() 内联跑

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { getTodayDate } from './normalize.mjs';
import { wikiDailyPath, summariesPath } from './wiki.mjs';

/**
 * 对一个 Topic 跑 digest。
 *
 * @param {Topic} topic
 * @param {{
 *   date?: string,                     // 默认今日(topic.timezone)
 *   llm?: 'skill'|'direct',
 *   log?: (msg: string) => void,
 *   stdout?: (text: string) => void,
 * }} opts
 */
export async function digest(topic, opts = {}) {
  const log = opts.log || ((msg) => process.stderr.write(`[digest] ${msg}\n`));
  const stdout = opts.stdout || ((text) => process.stdout.write(text));
  const llmMode = opts.llm || 'skill';

  const date = opts.date || getTodayDate(topic.timezone);
  const wikiPath = wikiDailyPath(topic, date);

  let wikiExists = true;
  try {
    await stat(wikiPath);
  } catch {
    wikiExists = false;
  }
  if (!wikiExists) {
    throw new Error(`digest: wiki file not found for ${topic.slug} ${date}: ${wikiPath}. Run analyze first.`);
  }

  const template = await loadDigestTemplate(topic);
  const filled = renderPrompt(topic, { date, wikiPath, template });

  log(`topic=${topic.slug} date=${date} wikiPath=${wikiPath} summariesPath=${summariesPath(topic)}`);

  if (llmMode === 'skill') {
    stdout(filled);
  } else if (llmMode === 'direct') {
    throw new Error('digest: direct LLM mode not implemented in v2 (留 v2.x via lib/llm.mjs::complete)');
  } else {
    throw new Error(`digest: unknown llm mode "${llmMode}"`);
  }

  return {
    topic: topic.slug,
    date,
    wikiPath,
    summariesPath: summariesPath(topic),
    prompt: filled,
    mode: llmMode,
  };
}

async function loadDigestTemplate(topic) {
  const customPath = path.join(topic.templatesDir, 'digest.md');
  try {
    return await readFile(customPath, 'utf-8');
  } catch {
    return DEFAULT_DIGEST_TEMPLATE;
  }
}

function renderPrompt(topic, { date, wikiPath, template }) {
  const summaryWriteCmd = `node ${path.join(topic.rootDir, 'scripts', 'summary-write.mjs')} --topic ${topic.slug} --date ${date}`;

  return template
    .replace(/\{TOPIC_SLUG\}/g, topic.slug)
    .replace(/\{DATE\}/g, date)
    .replace(/\{WIKI_PATH\}/g, wikiPath)
    .replace(/\{SUMMARIES_PATH\}/g, summariesPath(topic))
    .replace(/\{SUMMARY_WRITE_CMD\}/g, summaryWriteCmd);
}

// 通用默认 digest prompt — 任何 topic 都能用。topic 可在 templates 目录里
// 放一份 digest.md 覆盖此默认值。
const DEFAULT_DIGEST_TEMPLATE = `# {TOPIC_SLUG} — {DATE} 日概览生成

## 任务

读 \`{WIKI_PATH}\`({DATE} 当日的全部 slot 报告),提炼一条 5-7 句的日概览,作为
\`{SUMMARIES_PATH}\` 索引的一行(置顶,时间倒序)。

日概览的目标读者是"未来的自己":未来回顾时只看这一条就能想起这天发生了什么。
所以**写实质内容,不写空话**。

## 内容要求

5-7 句,覆盖以下要素(按重要性排序,不全齐也行):

1. **2-3 个最主要事件**(具体到事/人/数据)
2. **KOL 态度分布**(谁挺谁、有没有公开对撞)
3. **关键数据点**(release / 数字 / 链接)
4. **中英温差**(英文圈热但中文圈还没跟上的)
5. **异常信号**(冷热反差、新冒出的趋势)

## 写作风格

- 紧凑、信息密度高,不堆形容词
- 提到具体人/项目时带 @handle 或项目名,便于回忆
- 不重复 wiki 已经详尽展开的细节,**只留索引价值**

## 写入方式

用 Bash heredoc 管道给 summary-write 脚本(它会幂等 prepend 到 summaries.md
顶部,同日重跑替换前一次条目):

\`\`\`bash
{SUMMARY_WRITE_CMD} <<'PERCH_EOF'
(把你提炼的 5-7 句日概览原样放这里,**不要**包 \`## {DATE}\` 标题,脚本自动加)
PERCH_EOF
\`\`\`

最终条目落在 \`{SUMMARIES_PATH}\`。
`;
