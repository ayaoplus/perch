// topic.mjs — Topic 一等公民(v2)
//
// Topic 是 perch 的核心抽象:封装一个信息漏斗的全部配置 + 行为(method)。
// 所有领域操作(ingest / analyze / digest / enrich / archive)都是 Topic 的 method,
// 调用者(CLI / agent / cron / 任何外部 runner)只跟 Topic 对象打交道,不需要懂目录
// 结构、不需要懂窗口语义、不需要解析 schedule —— 那些是 Topic 内部的细节。
//
// 实现层面 method 委托到 lib/{ingest,analyze,digest,enrich,archive,admin}.mjs。这里
// 用动态 import 而不是顶部静态 import,避免循环依赖(下游模块需要引用 Topic)。

import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Topic 没显式配 slots 时的 fallback。保持 v1 旧行为:morning/noon/evening 三槽,
// 边界 5/12/18 与 analyze pickSlot 硬编码语义等价。window 默认 'today'。
//
// export 出去给 admin.scaffoldTopic 在 spec.slots 省略时写进 SCHEMA.md,确保运行时
// loadTopic 的 fallback 行为和脚手架一致。
export const DEFAULT_SLOTS = [
  { name: 'morning', start_hour: 5, window: 'today' },
  { name: 'noon', start_hour: 12, window: 'today' },
  { name: 'evening', start_hour: 18, window: 'today' },
];

const SLOT_NAME_RE = /^[a-z][a-z0-9-]*$/;
const VALID_WINDOWS = new Set(['today', 'since_prev']);

/**
 * Topic — 信息漏斗的一等对象。
 *
 * 实例字段刻意和 v1 loadTopic 返回的 plain object 同名(slug / dataPath / sources /
 * slots / timezone / templatesDir / description),旧调用方(scripts/wiki-write.mjs /
 * scripts/fetch-article.mjs / lib/wiki.mjs::* 等)读字段不变,直接 work。
 */
export class Topic {
  constructor(fields) {
    this.slug = fields.slug;
    this.description = fields.description || '';
    this.timezone = fields.timezone;
    this.dataPath = fields.dataPath;
    this.templatesDir = fields.templatesDir;
    this.sources = fields.sources;
    this.slots = fields.slots;
    this.rootDir = fields.rootDir;
  }

  // —— 静态:加载 / 列举 / 创建 ——

  /**
   * 加载一个 Topic 的完整运行时配置,返回 Topic 实例。
   *
   * @param {string|null} slug    - Topic slug;null/undefined 时用 config.default_topic
   * @param {string} rootDir      - perch 仓库根目录
   * @returns {Promise<Topic>}
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

    const slots = validateSlots(effectiveSlug, schema.slots);

    return new Topic({
      slug: effectiveSlug,
      description: schema.description || entry.description || '',
      timezone: config.timezone || 'Asia/Shanghai',
      dataPath: entry.path,
      templatesDir,
      sources: schema.sources,
      slots,
      rootDir,
    });
  }

  /**
   * 列出 config.json 注册的所有 topic 简要信息(不读 SCHEMA.md,只读 config 索引)。
   * @param {string} rootDir
   * @returns {Promise<Array<{slug: string, description: string, path: string, isDefault: boolean}>>}
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
   * 创建一个新 topic(SCHEMA + slot 模板 + config 注册)。
   * 委托给 lib/admin.mjs::scaffoldTopic,这里只是给一个对称的入口。
   */
  static async create(rootDir, spec) {
    const { scaffoldTopic } = await import('./admin.mjs');
    return scaffoldTopic(rootDir, spec);
  }

  // —— 实例方法(领域操作,委托到各 lib 模块) ——

  /**
   * Ingest:抓 X → 跨源去重 → 全局时间重排 → 写当日 raw。
   * @param {{dry?: boolean, limit?: number}} opts
   */
  async ingest(opts = {}) {
    const { ingest } = await import('./ingest.mjs');
    return ingest(this, opts);
  }

  /**
   * Analyze:解析 slot+date+window → 渲染 prompt → (skill 模式)输出 stdout / (direct 模式)调 LLM。
   * @param {string} slotArg  - slot name 或 'now'
   * @param {{date?: string, llm?: 'skill'|'direct'}} opts
   */
  async analyze(slotArg, opts = {}) {
    const { analyze } = await import('./analyze.mjs');
    return analyze(this, slotArg, opts);
  }

  /**
   * Digest:读当日 wiki → 渲染 digest prompt → (skill / direct)→ summaries.md prepend。
   * @param {{date?: string, llm?: 'skill'|'direct'}} opts
   */
  async digest(opts = {}) {
    const { digest } = await import('./digest.mjs');
    return digest(this, opts);
  }

  /**
   * Enrich:深抓单条 Twitter Article 到月度缓存,返回缓存路径。
   * @param {string} statusUrl
   * @param {{date?: string}} opts
   */
  async enrich(statusUrl, opts = {}) {
    const { enrich } = await import('./enrich.mjs');
    return enrich(this, statusUrl, opts);
  }

  /**
   * Archive:把上月的 raw / wiki / cache 搬到 archive/YYYY-MM/。
   * @param {{dryRun?: boolean}} opts
   */
  async archive(opts = {}) {
    const { archive } = await import('./archive.mjs');
    return archive(this, opts);
  }
}

/**
 * 向后兼容:scripts/wiki-write.mjs / scripts/fetch-article.mjs 仍调用 loadTopic。
 * 内部直接 delegate 到 Topic.load,返回的实例字段名兼容旧 plain object 形态。
 */
export async function loadTopic(slug, rootDir) {
  return Topic.load(slug, rootDir);
}

// —— 内部 helpers ——

/**
 * 校验并规范化 topic 的 slots 配置。
 *
 * 规则:
 *   - 缺省 → fallback 默认 3 槽
 *   - 非空数组;每条含合法 name 和 start_hour
 *   - name 满足 ^[a-z][a-z0-9-]*$,不得为 'now'(保留给 analyze 的自动映射)
 *   - start_hour 为 0~23 整数
 *   - name 全局唯一
 *   - window 可选(today / since_prev,缺省 today)
 *   - 返回按 start_hour 升序排好的副本
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
 * 读 SCHEMA.md 的 frontmatter。格式约定:文件顶部两行 --- 之间是一段合法 JSON。
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
