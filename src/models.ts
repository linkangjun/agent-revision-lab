import { chatMessage, chatTool, TransientError } from './core.js';
import type { Message, Model, ModelReply, ToolCall } from './contracts.js';

const completed = (text: string): ModelReply => ({ stop: 'final', text, calls: [] });
const invoke = (id: string, name: string, args: unknown): ModelReply => ({
  stop: 'tools', text: '', calls: [{ id, name, arguments: args }],
});

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // A malformed argument cannot pass the harness's JSON-object check.
    return null;
  }
}

function latestToolResults(messages: Message[]): Map<string, Record<string, unknown> | undefined> {
  const names = new Map<string, string>();
  const results = new Map<string, Record<string, unknown> | undefined>();
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) names.set(call.id, call.name);
    } else if (message.role === 'tool' && message.toolCallId) {
      const name = names.get(message.toolCallId);
      if (name) results.set(name, object(parse(message.content)));
    }
  }
  return results;
}

/** Deterministic demonstration. No inference API or credentials are used. */
export const scriptedModel: Model = {
  name: 'scripted',
  async respond(messages, _tools, signal) {
    signal.throwIfAborted();
    const results = latestToolResults(messages);
    if (results.has('publish_report')) {
      const receipt = results.get('publish_report');
      return receipt?.ok === true && typeof receipt.reportId === 'string'
        ? completed(`Compatibility report confirmed (receipt ${receipt.reportId}).`)
        : completed('The report write was not confirmed.');
    }
    if (results.has('inspect_specs')) {
      const inspection = results.get('inspect_specs');
      if (inspection?.ok !== true || !Array.isArray(inspection.evidence)) {
        return completed('The compatibility check could not establish evidence.');
      }
      const evidence = inspection.evidence.map(object).filter((entry): entry is Record<string, unknown> =>
        !!entry && typeof entry.id === 'string' && typeof entry.resource === 'string' && typeof entry.pointer === 'string',
      );
      if (!evidence.length) return completed('The compatibility check returned no citable evidence.');
      const report = [
        'Stable API compatibility report (beta excluded)',
        ...evidence.map(entry =>
          `- ${entry.pointer}: ${JSON.stringify(entry.before)} → ${JSON.stringify(entry.after)} [${entry.id}; ${entry.resource}]`,
        ),
      ].join('\n');
      return invoke('script-publish', 'publish_report', { report });
    }
    const goalMessage = messages.find(message => message.role === 'user');
    const goal = object(parse(goalMessage?.content ?? ''))?.goal;
    return invoke('script-inspect', 'inspect_specs', {
      includePagination: typeof goal === 'string' && /pagination|分页/i.test(goal),
    });
  },
};

type OpenAIEnvironment = Partial<Record<'OPENAI_API_KEY' | 'OPENAI_MODEL', string>>;

function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value) * 1000;
  const time = Date.parse(value);
  return Number.isFinite(time) ? Math.max(0, time - Date.now()) : undefined;
}

function parseCompletion(body: unknown): ModelReply {
  const choices = object(body)?.choices;
  const choice = Array.isArray(choices) ? object(choices[0]) : undefined;
  if (!choice) throw new Error('OpenAI returned no completion choice');
  const message = object(choice.message);
  if (!message) throw new Error('OpenAI returned no assistant message');
  const text = typeof message.content === 'string' ? message.content : '';
  // Truncation can leave valid-looking but incomplete tool arguments.
  if (choice.finish_reason === 'length') return { stop: 'length', text, calls: [] };
  if (choice.finish_reason === 'stop' && (message.tool_calls == null ||
    (Array.isArray(message.tool_calls) && !message.tool_calls.length))) return completed(text);
  if (choice.finish_reason !== 'tool_calls' || !Array.isArray(message.tool_calls) || !message.tool_calls.length) {
    throw new Error('OpenAI returned an unsupported completion outcome');
  }
  const ids = new Set<string>();
  const calls = message.tool_calls.map((raw: unknown): ToolCall => {
    const call = object(raw);
    const fn = object(call?.function);
    if (call?.type !== 'function' || typeof call.id !== 'string' || !call.id ||
      ids.has(call.id) || typeof fn?.name !== 'string' || !fn.name || typeof fn.arguments !== 'string') {
      throw new Error('OpenAI returned an invalid tool call');
    }
    ids.add(call.id);
    return { id: call.id, name: fn.name, arguments: parse(fn.arguments) };
  });
  return { stop: 'tools', text, calls };
}

/** Opt-in adapter. The caller owns model selection, budgets, and retry policy. */
export function createOpenAIModel(env: OpenAIEnvironment = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
}): Model {
  const key = env.OPENAI_API_KEY?.trim();
  const model = env.OPENAI_MODEL?.trim();
  if (!key || !model) throw new Error('Set OPENAI_API_KEY and OPENAI_MODEL to use OpenAI');
  return {
    name: `openai:${model}`,
    async respond(messages, tools, signal) {
      signal.throwIfAborted();
      const body = JSON.stringify({
        model,
        messages: messages.map(chatMessage),
        tools: tools.length ? tools.map(chatTool) : undefined,
        max_completion_tokens: 1000,
      });
      let response: Response;
      try {
        response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body,
          signal,
          redirect: 'error',
        });
      } catch {
        signal.throwIfAborted();
        throw new TransientError('OpenAI request failed');
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        const error = `OpenAI returned HTTP ${response.status}`;
        if (response.status === 408 || response.status === 429 || response.status >= 500) {
          throw new TransientError(error, retryAfter(response.headers.get('retry-after')));
        }
        throw new Error(error);
      }
      const decoded: unknown = await response.json().catch(() => {
        signal.throwIfAborted();
        throw new Error('OpenAI returned invalid JSON');
      });
      const reply = parseCompletion(decoded);
      signal.throwIfAborted();
      return reply;
    },
  };
}
