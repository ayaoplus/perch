// topic.mjs — Topic 一等公民(v3)
//
// v3 简化:Topic 是配置容器,行为由 method 触发,运行时参数由调用者(CLI / cron / agent)决定。
// 删除 v2 的 slot / window 抽象 —— 这些在 v3 是 prompt 自己的事,框架不掺和。
//
// 实例字段:slug / description / timezone / dataPath / templatesDir / sources
// (没有 slots,没有 schedule;调度由外部完成)

import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Topic — 配置容器 + 行为入口。
 *
 * 实例字段沿用 v2 plain object 命名(scripts/wiki-write.mjs / scripts/fetch-article.mjs
 * 等通过字段读 topic.dataPath / topic.slug 等,接口稳定)。
 */
export class Topic {
  constructor(fields) {
    this.slug = fields.slug;
    this.description = fields.description || '';
    this.timezone = fields.timezone;
    this.dataPath = fields.dataPath;
    this.templatesDir = fields.templatesDir;
    this.sources = fields.sources;
    this.rootDir = fields.rootDir;
  }

  // —— 静态:加载 / 列举 / 创建 ——

  /**
   * 加载一个 Topic 的完整运行时配置,返回 Topic 实例。
   *
   * @param {string|null} slug    - Topic slug;null/undefined 时用 config.default_topic
   * @param {string} rootDir      - perch 仓库根目录
   */
  static async load(slug, rootDir) {
    const configPath = path.join(rootDir, 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf-8'));

    const effectiveSlug = slug || config.default_topic;
    if (!effectiveSlug) {
      throw new Error('No topic specified and no default_topic in config.json');
    }

    const entry = config.topics?.[effectiveSlug];
    if (!entry) throw new Error(`Topic not found in config.json: ${effectiveSlug}`);
    if (!entry.path) throw new Error(`Topic "${effectiveSlug}" missing 'path' in config.json`);
    if (!entry.templates_dir) throw new Error(`Topic "${effectiveSlug}" missing 'templates_dir' in config.json`);

    const templatesDir = path.resolve(rootDir, entry.templates_dir);
    const schema = await loadSchema(path.join(templatesDir, 'SCHEMA.md'));

    if (!Array.isArray(schema.sources) || schema.sources.length === 0) {
      throw new Error(`Topic "${effectiveSlug}" has no sources defined in SCHEMA.md`);
    }
    for (const src of schema.sources) {
      if (!src.slug) throw new Error(`Topic "${effectiveSlug}" has a source missing 'slug'`);
      if (!src.type) throw new Error(`Topic "${effectiveSlug}" source "${src.slug}" missing 'type'`);
      if (!src.target) throw new Error(`Topic "${effectiveSlug}" source "${src.slug}" missing 'target'`);
      if (src.type !== 'list' && src.type !== 'profile') {
        throw new Error(`Topic "${effectiveSlug}" source "${src.slug}" has unsupported type: ${src.type}`);
      }
    }

    // v2 → v3 兼容:SCHEMA 里残留的 slots 字段会被忽略,只 stderr 提示一次
    if (schema.slots !== undefined) {
      process.stderr.write(
        `[topic] DEPRECATION: SCHEMA.md of "${effectiveSlug}" still has 'slots' field; ` +
        `v3 ignores it (调度由外部 cron 决定).可以从 SCHEMA 里删掉。\n`
      );
    }

    return new Topic({
      slug: effectiveSlug,
      description: schema.description || entry.description || '',
      timezone: config.timezone || 'Asia/Shanghai',
      dataPath: entry.path,
      templatesDir,
      sources: schema.sources,
      rootDir,
    });
  }

  /**
   * 列出 config.json 注册的所有 topic 简要信息。
   */
  static async list(rootDir) {
    const config = JSON.parse(await readFile(path.join(rootDir, 'config.json'), 'utf-8'));
    const def = config.default_topic || null;
    const entries = config.topics || {};
    return Object.entries(entries).map(([slug, e]) => ({
      slug,
      description: e.description || '',
      path: e.path,
      isDefault: slug === def,
    }));
  }

  /**
   * 创建一个新 topic,委托给 lib/admin.mjs::scaffoldTopic。
   */
  static async create(rootDir, spec) {
    const { scaffoldTopic } = await import('./admin.mjs');
    return scaffoldTopic(rootDir, spec);
  }

  // —— 实例方法 ——

  /**
   * Ingest:抓 sources → 跨源去重 → 全局时间重排 → 写 raw 文件。
   * @param {{out?: string, dry?: boolean, limit?: number, log?: Function}} opts
   */
  async ingest(opts = {}) {
    const { ingest } = await import('./ingest.mjs');
    return ingest(this, opts);
  }

  /**
   * Report:渲染 prompt → (skill 模式)stdout / (direct 模式 v3.x)调 LLM。
   * @param {string} promptName
   * @param {{
   *   inputs?: string[],          // 默认 [today raw]
   *   date?: string,              // 默认 today
   *   section?: string,           // 默认 = promptName
   *   llm?: 'skill'|'direct',
   *   log?: Function,
   *   stdout?: Function,
   * }} opts
   */
  async report(promptName, opts = {}) {
    const { report } = await import('./report.mjs');
    return report(this, promptName, opts);
  }

  /**
   * Enrich:深抓单条 Twitter Article 到月度缓存。
   */
  async enrich(statusUrl, opts = {}) {
    const { enrich } = await import('./enrich.mjs');
    return enrich(this, statusUrl, opts);
  }

  /**
   * Archive:把上月的 raw / wiki / cache 搬到 archive/YYYY-MM/。
   */
  async archive(opts = {}) {
    const { archive } = await import('./archive.mjs');
    return archive(this, opts);
  }
}

/**
 * 向后兼容:scripts/wiki-write.mjs / scripts/fetch-article.mjs 仍可能调用 loadTopic。
 */
export async function loadTopic(slug, rootDir) {
  return Topic.load(slug, rootDir);
}

// —— 内部 helpers ——

/**
 * 读 SCHEMA.md 的 frontmatter。文件顶部两行 --- 之间是合法 JSON。
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
