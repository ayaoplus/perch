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

  return {
    slug,
    description: schema.description || topic.description || '',
    timezone: config.timezone || 'Asia/Shanghai',
    dataPath: topic.path,
    templatesDir,
    sources: schema.sources,
  };
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
