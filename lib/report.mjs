// report.mjs — Report 角色:通用 prompt runner(v3)
//
// v3 把 v2 的 analyze + digest 合并成一个角色:**给定 prompt 模板 + inputs,渲染出
// 完整 prompt 推到 LLM**。LLM 接棒后做什么(写 wiki section / 写 summary / 既写 wiki
// 又写 summary)由 prompt 内容决定,框架不掺和。
//
// 调用约定:
//   - 调用者(CLI / cron / agent)负责选 prompt name、传 inputs 路径、传 date、传 section
//   - 框架提供合理默认值(inputs = today raw / date = today / section = prompt name)
//   - skill 模式打 stdout 让当前 Claude 会话接棒;direct 模式(v3.x)直连 Anthropic API

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { getTodayDate } from './normalize.mjs';
import { rawDailyPath, wikiDailyPath, summariesPath } from './wiki.mjs';
import { articleCacheDir } from './article-cache.mjs';

const SECTION_NAME_RE = /^[a-z][a-z0-9-]*$/;
const PROMPT_NAME_RE = /^[a-z][a-z0-9-]*$/;

/**
 * 对一个 Topic 跑 report。
 *
 * @param {Topic} topic
 * @param {string} promptName       - 对应 templates/topics/<slug>/<promptName>.md
 * @param {{
 *   inputs?: string[],             // 默认 [today raw 路径]
 *   date?: string,                 // 默认 today(topic.timezone),决定 {DATE} + wiki 写哪天
 *   section?: string,              // 默认 = promptName,决定 wiki section 名
 *   llm?: 'skill'|'direct',
 *   log?: (msg: string) => void,
 *   stdout?: (text: string) => void,
 * }} opts
 */
export async function report(topic, promptName, opts = {}) {
  const log = opts.log || ((msg) => process.stderr.write(`[report] ${msg}\n`));
  const stdout = opts.stdout || ((text) => process.stdout.write(text));
  const llmMode = opts.llm || 'skill';

  if (!PROMPT_NAME_RE.test(String(promptName || ''))) {
    throw new Error(`report: invalid prompt name "${promptName}" (must match ${PROMPT_NAME_RE})`);
  }

  const date = opts.date || getTodayDate(topic.timezone);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`report: invalid date "${date}" (must be YYYY-MM-DD)`);
  }

  const section = opts.section || promptName;
  if (!SECTION_NAME_RE.test(section)) {
    throw new Error(`report: invalid section "${section}" (must match ${SECTION_NAME_RE})`);
  }

  // inputs 缺省 = today raw 单文件;调用者也可以显式传一组(跨日 / glob 展开后)
  const inputs = opts.inputs && opts.inputs.length > 0
    ? opts.inputs
    : [rawDailyPath(topic, date)];

  const promptPath = path.join(topic.templatesDir, `${promptName}.md`);
  let template;
  try {
    template = await readFile(promptPath, 'utf-8');
  } catch (err) {
    throw new Error(`report: reading prompt template ${promptPath}: ${err.message}`);
  }

  const filled = renderPrompt(topic, { promptName, section, date, inputs, template });

  log(`topic=${topic.slug} prompt=${promptName} section=${section} date=${date} inputs=${inputs.length} file(s)`);
  for (const p of inputs) log(`  input: ${p}`);
  log(`wikiPath=${wikiDailyPath(topic, date)}`);

  let llmStats = null;

  if (llmMode === 'skill') {
    stdout(filled);
  } else if (llmMode === 'direct') {
    const { runPromptWithTools } = await import('./llm.mjs');
    llmStats = await runPromptWithTools(filled, {
      rootDir: topic.rootDir,
      log,
      debug: !!opts.debug,
    });
    log(`direct LLM done: iterations=${llmStats.iterations} tokens=${llmStats.inputTokens}/${llmStats.outputTokens} stop=${llmStats.stopReason}`);
  } else {
    throw new Error(`report: unknown llm mode "${llmMode}"`);
  }

  return {
    topic: topic.slug,
    prompt: promptName,
    section,
    date,
    inputs,
    wikiPath: wikiDailyPath(topic, date),
    summariesPath: summariesPath(topic),
    renderedPrompt: filled,
    mode: llmMode,
    llmStats,
  };
}

// —— prompt 渲染 ——

function renderPrompt(topic, { promptName, section, date, inputs, template }) {
  const sourcesDesc = topic.sources
    .map(s => {
      const kind = s.type === 'list' ? 'X List' : 'X Profile';
      const name = s.label || s.slug;
      return `${kind} "${name}"`;
    })
    .join(' + ');

  const inputsCsv = inputs.join(',');
  const inputsList = inputs.map(p => `- ${p}`).join('\n');

  const fetchArticleCmd = `node ${path.join(topic.rootDir, 'scripts', 'fetch-article.mjs')} --topic ${topic.slug}`;
  const wikiWriteCmd = `node ${path.join(topic.rootDir, 'scripts', 'wiki-write.mjs')} --topic ${topic.slug} --date ${date} --section ${section}`;
  const summaryWriteCmd = `node ${path.join(topic.rootDir, 'scripts', 'summary-write.mjs')} --topic ${topic.slug} --date ${date}`;

  return template
    .replace(/\{TOPIC_SLUG\}/g, topic.slug)
    .replace(/\{DATE\}/g, date)
    .replace(/\{PROMPT_NAME\}/g, promptName)
    .replace(/\{SECTION_NAME\}/g, section)
    .replace(/\{INPUTS\}/g, inputsCsv)
    .replace(/\{INPUTS_LIST\}/g, inputsList)
    .replace(/\{WIKI_PATH\}/g, wikiDailyPath(topic, date))
    .replace(/\{WIKI_WRITE_CMD\}/g, wikiWriteCmd)
    .replace(/\{SUMMARIES_PATH\}/g, summariesPath(topic))
    .replace(/\{SUMMARY_WRITE_CMD\}/g, summaryWriteCmd)
    .replace(/\{SOURCES\}/g, sourcesDesc)
    .replace(/\{ARTICLE_CACHE_DIR\}/g, articleCacheDir(topic, date))
    .replace(/\{FETCH_ARTICLE_CMD\}/g, fetchArticleCmd);
}
