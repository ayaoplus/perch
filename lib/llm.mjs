// llm.mjs — LLM Direct 模式:agent loop + provider 抽象 + retry/rate-limit(v3.2)
//
// 设计意图:让 perch report 脱离 Claude Code 会话也能跑(cron / openclaw / 任意
// 无会话 runner)。流程和 Skill 模式 1:1 对齐:
//   1. report.mjs 渲染好 prompt(占位符已替换)
//   2. lib/llm.mjs 把 prompt 喂给 LLM provider,带 read_file / bash 两个 tool
//   3. 进入 agent loop:LLM 请求 tool_use → 本地执行 → 把 tool_result 回灌 → 直到
//      LLM stop_reason !== 'tool_use'
//   4. Loop 内 LLM 自己用 read_file 读 inputs、用 bash heredoc pipe 给 wiki-write /
//      summary-write / fetch-article —— 与 Skill 模式下 Claude Code 会话的行为一致
//
// Provider 抽象(PERCH_LLM_PROVIDER env):
//   - anthropic(默认)— Anthropic Messages API,需 ANTHROPIC_API_KEY
//   - openai           — OpenAI Chat Completions API(同时兼容 OpenRouter / Together /
//                        本地 vLLM 等 OpenAI-compatible endpoint),需 OPENAI_API_KEY,
//                        endpoint 可用 PERCH_LLM_BASE_URL 覆盖
//   - stub             — 测试用,内置脚本化 tool_use 序列,不调网络
//
// 内部 agent loop 用 Anthropic-style content blocks(text / tool_use / tool_result);
// openai provider 在调用前后做双向转换,agent loop 完全不动。
//
// 错误处理:429 / 5xx / 网络抖动 exponential backoff + jitter retry。respect
// retry-after header(若有)。可重试错误用 RetryableError 标记,其他直接抛出。
//
// 安全:bash tool cwd 锁到 perch 仓库根,加 timeout / stdout 大小上限。prompt
// injection 风险(X 推文内容)首版不做白名单,文档中说明。

import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-4-5';
const OPENAI_DEFAULT_MODEL = 'gpt-4o';
const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MAX_TOKENS = 16384;
const DEFAULT_LOOP_LIMIT = 50;
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_INITIAL_BACKOFF_MS = 1000;
const DEFAULT_BASH_TIMEOUT_MS = 600000;
const DEFAULT_BASH_OUTPUT_CAP = 200000;
const DEFAULT_READ_FILE_CAP = 2_000_000;

// —— 公共入口 ——

/**
 * 跑 LLM Direct 模式的完整 prompt。
 *
 * @param {string} prompt
 * @param {{
 *   rootDir: string,
 *   model?: string,
 *   maxTokens?: number,
 *   loopLimit?: number,
 *   provider?: 'anthropic'|'openai'|'stub',
 *   apiKey?: string,
 *   baseUrl?: string,             // openai 自定义 endpoint
 *   maxRetries?: number,
 *   initialBackoffMs?: number,
 *   log?: (msg: string) => void,
 *   debug?: boolean,
 * }} opts
 */
export async function runPromptWithTools(prompt, opts = {}) {
  const log = opts.log || ((msg) => process.stderr.write(`[llm] ${msg}\n`));
  const debug = !!opts.debug;
  const provider = opts.provider || process.env.PERCH_LLM_PROVIDER || 'anthropic';
  const maxTokens = opts.maxTokens || Number(process.env.PERCH_LLM_MAX_TOKENS) || DEFAULT_MAX_TOKENS;
  const loopLimit = opts.loopLimit || DEFAULT_LOOP_LIMIT;
  const maxRetries = opts.maxRetries ?? Number(process.env.PERCH_LLM_MAX_RETRIES ?? DEFAULT_MAX_RETRIES);
  const initialBackoffMs = opts.initialBackoffMs ?? Number(process.env.PERCH_LLM_INITIAL_BACKOFF_MS ?? DEFAULT_INITIAL_BACKOFF_MS);
  const rootDir = opts.rootDir;
  if (!rootDir) throw new Error('runPromptWithTools: opts.rootDir is required');

  const model = resolveModel(provider, opts.model);

  log(`provider=${provider} model=${model} maxTokens=${maxTokens} loopLimit=${loopLimit} maxRetries=${maxRetries}`);

  const tools = TOOL_DEFINITIONS;
  const toolHandlers = makeToolHandlers(rootDir, log);

  const callLLMRaw = makeProviderCall(provider, opts);
  const callLLM = (req) => withRetry(() => callLLMRaw(req), { maxRetries, initialBackoffMs, log });

  let messages = [{ role: 'user', content: prompt }];
  let iterations = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let finalText = '';
  let stopReason = 'unknown';

  while (iterations < loopLimit) {
    iterations++;
    log(`iteration ${iterations}: requesting completion...`);
    const response = await callLLM({ model, maxTokens, tools, messages, debug });

    totalInput += response.usage?.input_tokens || 0;
    totalOutput += response.usage?.output_tokens || 0;
    stopReason = response.stop_reason;

    messages.push({ role: 'assistant', content: response.content });

    const textBlocks = (response.content || []).filter(b => b.type === 'text');
    const turnText = textBlocks.map(b => b.text).join('\n').trim();
    if (turnText) {
      log(`assistant text (${turnText.length} chars): ${truncate(turnText, 200)}`);
      finalText = turnText;
    }

    if (stopReason !== 'tool_use') {
      log(`stop_reason=${stopReason}, loop done`);
      break;
    }

    const toolUses = (response.content || []).filter(b => b.type === 'tool_use');
    if (toolUses.length === 0) {
      log(`stop_reason=tool_use 但无 tool_use blocks,异常退出`);
      break;
    }

    const toolResults = [];
    for (const tu of toolUses) {
      const handler = toolHandlers[tu.name];
      if (!handler) {
        log(`! unknown tool "${tu.name}",返回 error`);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: `Error: unknown tool "${tu.name}"`,
          is_error: true,
        });
        continue;
      }
      try {
        log(`tool_use ${tu.name}: ${truncate(JSON.stringify(tu.input), 160)}`);
        const result = await handler(tu.input);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: result,
        });
      } catch (e) {
        log(`! tool ${tu.name} failed: ${e.message}`);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: `Error: ${e.message}`,
          is_error: true,
        });
      }
    }

    messages.push({ role: 'user', content: toolResults });
  }

  if (iterations >= loopLimit) {
    log(`! loopLimit=${loopLimit} hit,可能死循环或任务过大,强制退出`);
  }

  log(`completed: iterations=${iterations} input_tokens=${totalInput} output_tokens=${totalOutput}`);
  return { iterations, inputTokens: totalInput, outputTokens: totalOutput, finalText, stopReason };
}

// —— Tool 定义 ——

const TOOL_DEFINITIONS = [
  {
    name: 'read_file',
    description:
      'Read the content of a file from the local filesystem. Use this to read inputs (raw markdown files), wiki, summaries, or article cache.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the file. Inputs paths are provided in the prompt.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'bash',
    description:
      'Execute a shell command. Working directory is the perch repository root. Use this to invoke wiki-write.mjs / summary-write.mjs / fetch-article.mjs via heredoc pipes as instructed by the prompt. Output is captured (stdout + stderr); large outputs are truncated.',
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Shell command to execute (zsh/bash compatible). Heredocs supported.',
        },
      },
      required: ['command'],
    },
  },
];

// —— Tool handlers ——

function makeToolHandlers(rootDir, log) {
  return {
    read_file: async ({ path }) => {
      if (typeof path !== 'string' || !path) throw new Error('read_file: path required');
      const text = await readFile(path, 'utf-8');
      if (text.length > DEFAULT_READ_FILE_CAP) {
        log(`! read_file truncated: ${path} (${text.length} chars → first ${DEFAULT_READ_FILE_CAP})`);
        return text.slice(0, DEFAULT_READ_FILE_CAP) +
          `\n\n[... truncated, file is ${text.length} chars total ...]`;
      }
      return text;
    },
    bash: async ({ command }) => {
      if (typeof command !== 'string' || !command.trim()) throw new Error('bash: command required');
      return await runShell(command, rootDir, DEFAULT_BASH_TIMEOUT_MS, DEFAULT_BASH_OUTPUT_CAP);
    },
  };
}

function runShell(command, cwd, timeoutMs, outputCap) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], { cwd, env: process.env });
    let stdout = '';
    let stderr = '';
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, timeoutMs);

    child.stdout.on('data', (chunk) => { if (stdout.length < outputCap) stdout += chunk.toString('utf-8'); });
    child.stderr.on('data', (chunk) => { if (stderr.length < outputCap) stderr += chunk.toString('utf-8'); });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const truncated = stdout.length >= outputCap || stderr.length >= outputCap;
      const out = (stdout.length > outputCap ? stdout.slice(0, outputCap) + '\n[... stdout truncated ...]\n' : stdout);
      const errOut = (stderr.length > outputCap ? stderr.slice(0, outputCap) + '\n[... stderr truncated ...]\n' : stderr);
      const head = killed
        ? `[bash] command timed out after ${timeoutMs}ms, killed.\n`
        : `[bash] exit_code=${code ?? 0}${signal ? ` signal=${signal}` : ''}${truncated ? ' (output truncated)' : ''}\n`;
      resolve(head + (out ? `--- stdout ---\n${out}` : '') + (errOut ? `--- stderr ---\n${errOut}` : ''));
    });

    child.on('error', (err) => { clearTimeout(timer); resolve(`[bash] spawn error: ${err.message}`); });
  });
}

// —— Retry / 错误分类 ——

class RetryableError extends Error {
  constructor(message, { httpStatus, retryAfterMs, code } = {}) {
    super(message);
    this.name = 'RetryableError';
    this.httpStatus = httpStatus;
    this.retryAfterMs = retryAfterMs;
    this.code = code;
  }
}

async function withRetry(fn, { maxRetries, initialBackoffMs, log }) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      const retryable = e instanceof RetryableError || isNetworkError(e);
      if (!retryable || attempt >= maxRetries) throw e;
      const delay = computeBackoff(attempt, initialBackoffMs, e);
      log(`! retryable error (attempt ${attempt + 1}/${maxRetries}): ${e.message}; backing off ${delay}ms`);
      await sleep(delay);
      attempt++;
    }
  }
}

function isNetworkError(e) {
  if (!e) return false;
  // Node 18+ 的原生 fetch 失败时抛 TypeError("fetch failed"),具体 code 在 cause 里。
  // 部分场景 cause.code 缺失(尤其 undici 版本差异),所以也匹配 message 兜底。
  if (e.name === 'TypeError' && /fetch failed/i.test(String(e.message || ''))) return true;
  const code = e.code || e.cause?.code;
  return ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_SOCKET'].includes(code);
}

function computeBackoff(attempt, initialBackoffMs, e) {
  // retry-after header(秒)优先,但 cap 在 60 秒避免极端等待
  if (e instanceof RetryableError && e.retryAfterMs) {
    return Math.min(e.retryAfterMs, 60000);
  }
  const base = initialBackoffMs * Math.pow(2, attempt);
  const jitter = Math.random() * 0.3 * base;
  return Math.floor(base + jitter);
}

// —— Provider 选择 ——

function resolveModel(provider, explicit) {
  if (explicit) return explicit;
  if (process.env.PERCH_LLM_MODEL) return process.env.PERCH_LLM_MODEL;
  if (provider === 'openai') return OPENAI_DEFAULT_MODEL;
  return ANTHROPIC_DEFAULT_MODEL;
}

function makeProviderCall(provider, opts) {
  switch (provider) {
    case 'anthropic': return anthropicProvider(opts.apiKey);
    case 'openai':    return openaiProvider(opts.apiKey, opts.baseUrl);
    case 'stub':      return stubProviderFactory();
    default:
      throw new Error(`Unknown LLM provider "${provider}"; expected one of: anthropic, openai, stub`);
  }
}

// —— Anthropic provider ——

function anthropicProvider(explicitKey) {
  const apiKey = explicitKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is required for anthropic provider. Set it in env or pass via opts.apiKey.'
    );
  }
  return async ({ model, maxTokens, tools, messages, debug }) => {
    const body = { model, max_tokens: maxTokens, tools, messages };
    if (debug) {
      process.stderr.write(`[llm.debug] anthropic request: ${truncate(JSON.stringify({
        model, max_tokens: maxTokens, tools_count: tools.length, messages_count: messages.length,
        last_role: messages[messages.length - 1]?.role,
      }), 400)}\n`);
    }
    const res = await safeFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throwHttpError(res, text);
    const data = JSON.parse(text);
    if (debug) {
      process.stderr.write(`[llm.debug] anthropic response: stop_reason=${data.stop_reason} usage=${JSON.stringify(data.usage)} content_blocks=${data.content?.length}\n`);
    }
    return data;
  };
}

// —— OpenAI provider(兼容 OpenRouter / Together / 本地 vLLM 等 OpenAI-compatible API) ——

function openaiProvider(explicitKey, explicitBaseUrl) {
  const apiKey = explicitKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'OPENAI_API_KEY is required for openai provider. Set it in env or pass via opts.apiKey.'
    );
  }
  const baseUrl = explicitBaseUrl || process.env.PERCH_LLM_BASE_URL || OPENAI_DEFAULT_BASE_URL;

  return async ({ model, maxTokens, tools, messages, debug }) => {
    // Anthropic-style → OpenAI-style
    const oaiTools = tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
    const oaiMessages = anthropicMessagesToOpenai(messages);

    const body = {
      model,
      max_tokens: maxTokens,
      tools: oaiTools,
      tool_choice: 'auto',
      messages: oaiMessages,
    };

    if (debug) {
      process.stderr.write(`[llm.debug] openai request: baseUrl=${baseUrl} model=${model} tools=${oaiTools.length} messages=${oaiMessages.length} last_role=${oaiMessages[oaiMessages.length - 1]?.role}\n`);
    }

    const res = await safeFetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throwHttpError(res, text);
    const data = JSON.parse(text);
    if (debug) {
      process.stderr.write(`[llm.debug] openai response: finish_reason=${data.choices?.[0]?.finish_reason} usage=${JSON.stringify(data.usage)}\n`);
    }

    // OpenAI-style → Anthropic-style
    return openaiResponseToAnthropic(data);
  };
}

/**
 * Anthropic messages → OpenAI messages 转换。
 *
 * Anthropic 形态:
 *   user.content    : string | [text|tool_result blocks]
 *   assistant.content: [text|tool_use blocks]
 *
 * OpenAI 形态:
 *   user      : { role: 'user', content: string }
 *   assistant : { role: 'assistant', content: string|null, tool_calls?: [...] }
 *   tool      : { role: 'tool', tool_call_id, content: string }    (每个 tool_result 一条)
 */
function anthropicMessagesToOpenai(messages) {
  const out = [];
  for (const msg of messages) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        out.push({ role: 'user', content: msg.content });
      } else if (Array.isArray(msg.content)) {
        // 区分 tool_result 块和普通 text 块
        const toolResults = msg.content.filter(b => b.type === 'tool_result');
        const textBlocks = msg.content.filter(b => b.type === 'text');
        for (const tr of toolResults) {
          const content = typeof tr.content === 'string'
            ? tr.content
            : JSON.stringify(tr.content);
          out.push({
            role: 'tool',
            tool_call_id: tr.tool_use_id,
            content: tr.is_error ? `[error] ${content}` : content,
          });
        }
        if (textBlocks.length > 0) {
          out.push({ role: 'user', content: textBlocks.map(b => b.text).join('\n') });
        }
      }
    } else if (msg.role === 'assistant') {
      const content = Array.isArray(msg.content) ? msg.content : [];
      const text = content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      const toolUses = content.filter(b => b.type === 'tool_use');
      const oaiMsg = {
        role: 'assistant',
        content: text || null,
      };
      if (toolUses.length > 0) {
        oaiMsg.tool_calls = toolUses.map(tu => ({
          id: tu.id,
          type: 'function',
          function: {
            name: tu.name,
            arguments: JSON.stringify(tu.input || {}),
          },
        }));
      }
      out.push(oaiMsg);
    }
  }
  return out;
}

/**
 * OpenAI Chat Completion response → Anthropic-style response(供 agent loop 消费)。
 */
function openaiResponseToAnthropic(data) {
  const choice = data.choices?.[0];
  if (!choice) {
    throw new Error(`openai response missing choices: ${JSON.stringify(data).slice(0, 300)}`);
  }
  const msg = choice.message || {};
  const blocks = [];
  if (msg.content) {
    blocks.push({ type: 'text', text: msg.content });
  }
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      let input = {};
      try {
        input = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        input = { _raw: tc.function?.arguments || '' };
      }
      blocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function?.name || '',
        input,
      });
    }
  }
  // finish_reason 映射:tool_calls → tool_use,其他 → end_turn / max_tokens
  let stop_reason = 'end_turn';
  if (choice.finish_reason === 'tool_calls') stop_reason = 'tool_use';
  else if (choice.finish_reason === 'length') stop_reason = 'max_tokens';
  return {
    content: blocks,
    stop_reason,
    usage: {
      input_tokens: data.usage?.prompt_tokens || 0,
      output_tokens: data.usage?.completion_tokens || 0,
    },
  };
}

// —— Stub provider(测试用) ——
//
// 行为:
//   - 默认:第一次响应 → 请求 read_file 第一个 inputs path;第二次响应 → end_turn
//   - PERCH_LLM_STUB_FAIL_FIRST=N:前 N 次抛 RetryableError(模拟 429),验证 retry 退避
//   - PERCH_LLM_STUB_FATAL_FIRST=N:前 N 次抛非可重试错误,验证错误立即透传

function stubProviderFactory() {
  let turn = 0;
  let retryableLeft = Number(process.env.PERCH_LLM_STUB_FAIL_FIRST || 0);
  let fatalLeft = Number(process.env.PERCH_LLM_STUB_FATAL_FIRST || 0);
  return async ({ messages }) => {
    if (fatalLeft > 0) {
      fatalLeft--;
      throw new Error('Stub fatal error (not retryable)');
    }
    if (retryableLeft > 0) {
      retryableLeft--;
      throw new RetryableError('Stub rate-limit simulation (429)', {
        httpStatus: 429,
        retryAfterMs: 100, // 测试用快速重试
      });
    }
    turn++;
    if (turn === 1) {
      const firstUser = messages[0]?.content || '';
      const m = String(firstUser).match(/^-\s+(\S+\.md)\s*$/m);
      const path = m ? m[1] : '/tmp/perch-stub-no-input';
      return {
        stop_reason: 'tool_use',
        usage: { input_tokens: 100, output_tokens: 20 },
        content: [
          { type: 'text', text: 'Stub: requesting read_file as smoke test.' },
          { type: 'tool_use', id: 'stub_t1', name: 'read_file', input: { path } },
        ],
      };
    }
    return {
      stop_reason: 'end_turn',
      usage: { input_tokens: 200, output_tokens: 30 },
      content: [
        { type: 'text', text: 'Stub: agent loop, tool dispatch and retry verified. No real LLM was called.' },
      ],
    };
  };
}

// —— HTTP utilities ——

async function safeFetch(url, init) {
  try {
    return await fetch(url, init);
  } catch (e) {
    // fetch throws for network errors;包成 RetryableError 让 withRetry 处理
    if (isNetworkError(e)) {
      throw new RetryableError(`network error: ${e.message}`, { code: e.code || e.cause?.code });
    }
    throw e;
  }
}

function throwHttpError(res, text) {
  const status = res.status;
  const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
  const body = truncate(text || '', 500);

  if (status === 429 || (status >= 500 && status < 600)) {
    throw new RetryableError(`HTTP ${status}: ${body}`, { httpStatus: status, retryAfterMs });
  }
  // 4xx(非 429) → 配置错误,立刻抛
  throw new Error(`HTTP ${status}: ${body}`);
}

function parseRetryAfter(header) {
  if (!header) return undefined;
  // retry-after 可以是秒数 或 HTTP-date。秒数走 Number,HTTP-date 转 ms。
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

// —— utils ——

function truncate(s, n) {
  if (!s) return '';
  s = String(s);
  return s.length > n ? s.slice(0, n) + '...' : s;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
