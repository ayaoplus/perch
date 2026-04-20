// topic.mjs — Topic 配置加载(Business 层的入口原子)
//
// 从 perch/config.json 读全局配置,从 templates/topics/<slug>/SCHEMA.md 读该 topic 的
// JSON frontmatter(sources 等),拼成一个 topic 对象供 scripts/collect.mjs 等消费。
//
// 为什么 SCHEMA 放 templates_dir(perch 仓库)而不是 topic 数据目录(iCloud):
//   - templates_dir 随 perch 仓库版本化,便于 review / diff
//   - 数据目录只装运行时产物(raw / wiki / summaries / archive),不入 git
//   - config.json 的 `templates_dir` 字段本来就是给这种"逻辑配置 + prompt"的

import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Topic 没显式配 slots 时的 fallback。保持 v1 旧行为:morning/noon/evening 三槽,
// 边界 5/12/18 与 report.mjs:pickSlot 原硬编码等价。window 默认 'today'。
//
// export 出去给 scripts/new-topic.mjs 在 spec.slots 省略时写进 SCHEMA.md,确保运行时
// loadTopic 的 fallback 行为和脚手架一致。
export const DEFAULT_SLOTS = [
  { name: 'morning', start_hour: 5, window: 'today' },
  { name: 'noon', start_hour: 12, window: 'today' },
  { name: 'evening', start_hour: 18, window: 'today' },
];

const SLOT_NAME_RE = /^[a-z][a-z0-9-]*$/;
const VALID_WINDOWS = new Set(['today', 'since_prev']);

/**
 * 加载一个 Topic 的完整运行时配置。
 *
 * @param {string|null} topicSlug - Topic slug;null/undefined 时用 config.default_topic
 * @param {string} rootDir        - perch 仓库根目录(用来解析 config.json 和 templates_dir)
 * @returns {Promise<{
 *   slug: string,
 *   description: string,
 *   timezone: string,
 *   dataPath: string,
 *   templatesDir: string,
 *   sources: Array<{slug, type, target, label?, fetch_limit?}>,
 *   slots: Array<{name: string, start_hour: number, window: 'today'|'since_prev'}>,
 * }>}
 */
export async function loadTopic(topicSlug, rootDir) {
  const config = JSON.parse(await readFile(path.join(rootDir, 'config.json'), 'utf-8'));

  const slug = topicSlug || config.default_topic;
  if (!slug) {
    throw new Error('No topic specified and no default_topic in config.json');
  }

  const topic = config.topics?.[slug];
  if (!topic) throw new Error(`Topic not found in config.json: ${slug}`);
  if (!topic.path) throw new Error(`Topic "${slug}" missing 'path' in config.json`);
  if (!topic.templates_dir) throw new Error(`Topic "${slug}" missing 'templates_dir' in config.json`);

  const templatesDir = path.resolve(rootDir, topic.templates_dir);
  const schema = await loadSchema(path.join(templatesDir, 'SCHEMA.md'));

  if (!Array.isArray(schema.sources) || schema.sources.length === 0) {
    throw new Error(`Topic "${slug}" has no sources defined in SCHEMA.md`);
  }
  for (const src of schema.sources) {
    if (!src.slug) throw new Error(`Topic "${slug}" has a source missing 'slug'`);
    if (!src.type) throw new Error(`Topic "${slug}" source "${src.slug}" missing 'type'`);
    if (!src.target) throw new Error(`Topic "${slug}" source "${src.slug}" missing 'target'`);
    if (src.type !== 'list' && src.type !== 'profile') {
      throw new Error(`Topic "${slug}" source "${src.slug}" has unsupported type: ${src.type}`);
    }
  }

  const slots = validateSlots(slug, schema.slots);

  return {
    slug,
    description: schema.description || topic.description || '',
    timezone: config.timezone || 'Asia/Shanghai',
    dataPath: topic.path,
    templatesDir,
    sources: schema.sources,
    slots,
  };
}

/**
 * 校验并规范化 topic 的 slots 配置。
 *
 * 规则:
 *   - 缺省 → fallback 默认 3 槽(保持 v1 旧行为)
 *   - 非空数组;每条含合法 `name` 和 `start_hour`
 *   - `name` 满足 `^[a-z][a-z0-9-]*$`,不得为 `now`(保留给 report.mjs 的自动映射)
 *   - `start_hour` 为 0~23 整数
 *   - `name` 全局唯一
 *   - `window` 可选,取值 'today' 或 'since_prev',缺省 'today'
 *       · 'today'      — 报告覆盖今日 00:00 至当前时刻
 *       · 'since_prev' — 报告覆盖该 slot 上一个 slot 的 start_hour 至当前时刻
 *                        (该 slot 是首个 slot 时 fallback 为 today,避免跨昨日 raw 的复杂度)
 *   - 返回按 start_hour 升序排好的副本,下游 pickSlot 可直接线性扫描
 */
function validateSlots(topicSlug, raw) {
  if (raw === undefined) return DEFAULT_SLOTS.map(s => ({ ...s }));
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`Topic "${topicSlug}" has invalid 'slots' in SCHEMA.md: must be a non-empty array`);
  }

  const seen = new Set();
  const normalized = raw.map((s, i) => {
    if (!s || typeof s !== 'object') {
      throw new Error(`Topic "${topicSlug}" slot #${i} is not an object`);
    }
    const name = s.name;
    if (typeof name !== 'string' || !SLOT_NAME_RE.test(name)) {
      throw new Error(`Topic "${topicSlug}" slot #${i} has invalid name "${name}" (must match ${SLOT_NAME_RE})`);
    }
    if (name === 'now') {
      throw new Error(`Topic "${topicSlug}" slot name "now" is reserved`);
    }
    if (seen.has(name)) {
      throw new Error(`Topic "${topicSlug}" has duplicate slot name: "${name}"`);
    }
    seen.add(name);

    const h = s.start_hour;
    if (!Number.isInteger(h) || h < 0 || h > 23) {
      throw new Error(`Topic "${topicSlug}" slot "${name}" has invalid start_hour ${h} (must be integer 0-23)`);
    }

    const win = s.window === undefined ? 'today' : s.window;
    if (!VALID_WINDOWS.has(win)) {
      throw new Error(`Topic "${topicSlug}" slot "${name}" has invalid window "${win}" (must be one of: ${[...VALID_WINDOWS].join(', ')})`);
    }

    return { name, start_hour: h, window: win };
  });

  return normalized.sort((a, b) => a.start_hour - b.start_hour);
}

/**
 * 读 SCHEMA.md 的 frontmatter。格式约定:文件顶部两行 `---` 之间是一段合法 JSON,
 * 之后是人读 markdown 正文。用 JSON 而不是 YAML 是为了不引入依赖(JSON.parse 原生)。
 */
async function loadSchema(schemaPath) {
  const content = await readFile(schemaPath, 'utf-8');
  const m = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!m) {
    throw new Error(`SCHEMA.md missing frontmatter block: ${schemaPath}`);
  }
  try {
    return JSON.parse(m[1]);
  } catch (e) {
    throw new Error(`SCHEMA.md frontmatter is not valid JSON (${schemaPath}): ${e.message}`);
  }
}
