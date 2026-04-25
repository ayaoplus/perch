// llm.mjs — LLM Direct 模式:agent loop + Anthropic Messages API(v3.1)
//
// 设计意图:让 perch report 脱离 Claude Code 会话也能跑(cron / openclaw / 任意
// 无会话 runner)。流程和 Skill 模式 1:1 对齐:
//   1. report.mjs 渲染好 prompt(占位符已替换)
//   2. lib/llm.mjs 把 prompt 喂给 Anthropic Messages API,带 read_file / bash 两个 tool
//   3. 进入 agent loop:LLM 请求 tool_use → 本地执行 → 把 tool_result 回灌 → 直到
//      LLM stop_reason !== 'tool_use'
//   4. Loop 内 LLM 自己用 Read 读 inputs、用 Bash heredoc pipe 给 wiki-write /
//      summary-write / fetch-article —— 与 Skill 模式下 Claude Code 会话的行为完全一致
//
// 因此 prompt 模板**不需要改**:Skill 和 Direct 共享同一份 prompt。区别只在"谁来跑
// LLM 那一步"。
//
// 安全:bash tool 的 cwd 锁到 perch 仓库根,加 timeout / stdout 大小上限。prompt
// injection 风险来自 X 推文内容,首版不做沙箱白名单(责任在用户 / openclaw 容器),
// 文档里说明。
//
// Provider 选择:
//   PERCH_LLM_PROVIDER=anthropic (默认) → 真实调 Anthropic API,要 ANTHROPIC_API_KEY
//   PERCH_LLM_PROVIDER=stub             → 测试用,内置脚本化的 tool_use 序列,不调网络

import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-4-5';
const DEFAULT_MAX_TOKENS = 16384;
const DEFAULT_LOOP_LIMIT = 50;          // 防死循环
const DEFAULT_BASH_TIMEOUT_MS = 600000; // 单条 bash 最多 10 分钟
const DEFAULT_BASH_OUTPUT_CAP = 200000; // bash 输出超过 200KB 截断
const DEFAULT_READ_FILE_CAP = 2_000_000; // 单次读文件 2MB 上限,防爆 context

// —— 公共入口 ——

/**
 * 跑 LLM Direct 模式的完整 prompt。LLM 会通过 tool_use 自主调用 read_file / bash
 * 完成任务(读 inputs、生成 markdown、pipe 给 wiki-write 等)。
 *
 * @param {string} prompt        - 渲染好的完整 prompt 文本
 * @param {{
 *   rootDir: string,            // perch 仓库根目录(bash cwd)
 *   model?: string,             // 默认 PERCH_LLM_MODEL 或 claude-sonnet-4-5
 *   maxTokens?: number,         // 单次 API 调用 max_tokens
 *   loopLimit?: number,         // 整个 agent loop 最多几轮
 *   provider?: 'anthropic'|'stub',
 *   apiKey?: string,            // 不传则读 ANTHROPIC_API_KEY env
 *   log?: (msg: string) => void,
 *   debug?: boolean,            // 打印每次 API request/response 简化形态
 * }} opts
 * @returns {Promise<{
 *   iterations: number,
 *   inputTokens: number,
 *   outputTokens: number,
 *   finalText: string,
 *   stopReason: string,
 * }>}
 */
export async function runPromptWithTools(prompt, opts = {}) {
  const log = opts.log || ((msg) => process.stderr.write(`[llm] ${msg}\n`));
  const debug = !!opts.debug;
  const provider = opts.provider || process.env.PERCH_LLM_PROVIDER || 'anthropic';
  const model = opts.model || process.env.PERCH_LLM_MODEL || DEFAULT_MODEL;
  const maxTokens = opts.maxTokens || Number(process.env.PERCH_LLM_MAX_TOKENS) || DEFAULT_MAX_TOKENS;
  const loopLimit = opts.loopLimit || DEFAULT_LOOP_LIMIT;
  const rootDir = opts.rootDir;
  if (!rootDir) throw new Error('runPromptWithTools: opts.rootDir is required');

  log(`provider=${provider} model=${model} maxTokens=${maxTokens} loopLimit=${loopLimit}`);

  const tools = TOOL_DEFINITIONS;
  const toolHandlers = makeToolHandlers(rootDir, log);

  let messages = [{ role: 'user', content: prompt }];
  let iterations = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let finalText = '';
  let stopReason = 'unknown';

  const callLLM = provider === 'stub' ? stubProviderFactory() : anthropicProvider(opts.apiKey);

  while (iterations < loopLimit) {
    iterations++;
    log(`iteration ${iterations}: requesting completion...`);
    const response = await callLLM({ model, maxTokens, tools, messages, debug });

    totalInput += response.usage?.input_tokens || 0;
    totalOutput += response.usage?.output_tokens || 0;
    stopReason = response.stop_reason;

    // 把 assistant 回复加入 messages(所有 content blocks 原样保留)
    messages.push({ role: 'assistant', content: response.content });

    // 抽取本轮的 text 片段(用作 finalText 的累积 / 日志)
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

    // 处理所有 tool_use blocks,把 tool_result 一次性回灌
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

// —— Tool 定义(Anthropic Messages API tool schema) ——

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
    const child = spawn('bash', ['-c', command], {
      cwd,
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      if (stdout.length < outputCap) stdout += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < outputCap) stderr += chunk.toString('utf-8');
    });

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

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve(`[bash] spawn error: ${err.message}`);
    });
  });
}

// —— Anthropic provider ——

function anthropicProvider(explicitKey) {
  const apiKey = explicitKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is required for direct LLM mode. Set it in env or pass via opts.apiKey.'
    );
  }
  return async ({ model, maxTokens, tools, messages, debug }) => {
    const body = { model, max_tokens: maxTokens, tools, messages };
    if (debug) {
      process.stderr.write(`[llm.debug] request: ${truncate(JSON.stringify({
        model, max_tokens: maxTokens, tools_count: tools.length, messages_count: messages.length,
        last_role: messages[messages.length - 1]?.role,
      }), 400)}\n`);
    }
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Anthropic API error ${res.status}: ${text.slice(0, 500)}`);
    }
    const data = JSON.parse(text);
    if (debug) {
      process.stderr.write(`[llm.debug] response: stop_reason=${data.stop_reason} usage=${JSON.stringify(data.usage)} content_blocks=${data.content?.length}\n`);
    }
    return data;
  };
}

// —— Stub provider(测试用,不调网络) ——
//
// 行为:第一次响应 → 请求 read_file 第一个 inputs path;第二次响应 → 直接 end_turn。
// 用来测 loop 框架 + tool dispatch,不真的写 wiki / summaries。

function stubProviderFactory() {
  let turn = 0;
  return async ({ messages }) => {
    turn++;
    if (turn === 1) {
      // 从 user prompt 里提取第一个 "- /xxx/raw/..." 行作为 read_file 路径
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
        { type: 'text', text: 'Stub: agent loop and tool dispatch verified. No real LLM was called.' },
      ],
    };
  };
}

// —— utils ——

function truncate(s, n) {
  if (!s) return '';
  s = String(s);
  return s.length > n ? s.slice(0, n) + '...' : s;
}
