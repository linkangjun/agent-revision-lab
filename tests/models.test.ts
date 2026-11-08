import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message, ToolSpec } from '../src/contracts.js';
import { TransientError, validateCall } from '../src/core.js';
import { createOpenAIModel, scriptedModel } from '../src/models.js';

const tools: ToolSpec[] = [{
  name: 'inspect_specs', description: 'Inspect a synthetic spec', effect: 'read',
  parameters: { type: 'object', properties: { includePagination: { type: 'boolean' } }, required: ['includePagination'] },
}];
const signal = new AbortController().signal;
const openAI = () => createOpenAIModel({ OPENAI_API_KEY: 'synthetic-test-value', OPENAI_MODEL: 'test-model' });
const goal: Message = { role: 'user', content: JSON.stringify({ revision: 2, goal: 'Check pagination' }) };

afterEach(() => vi.unstubAllGlobals());

describe('scripted model', () => {
  it('derives a cited report from the read tool and finalizes only after a receipt', async () => {
    const first = await scriptedModel.respond([goal], tools, signal);
    expect(first.calls[0].arguments).toEqual({ includePagination: true });
    const history: Message[] = [goal,
      { role: 'assistant', content: '', toolCalls: first.calls },
      { role: 'tool', toolCallId: first.calls[0].id, content: JSON.stringify({
        ok: true,
        evidence: [{ id: 'ev_limit', resource: 'stable-v1 / stable-v2', pointer: '/orders/limit', before: 100, after: 50 }],
      }) },
    ];
    const second = await scriptedModel.respond(history, tools, signal);
    expect(second.calls[0].name).toBe('publish_report');
    expect(second.calls[0].arguments).toMatchObject({ report: expect.stringContaining('ev_limit') });
    history.push(
      { role: 'assistant', content: '', toolCalls: second.calls },
      { role: 'tool', toolCallId: second.calls[0].id, content: '{"ok":true,"reportId":"confirmed-id","revision":2}' },
    );
    const done = await scriptedModel.respond(history, tools, signal);
    expect(done).toMatchObject({ stop: 'final', text: expect.stringContaining('confirmed-id'), calls: [] });
  });
});

describe('OpenAI wire adapter (simulated HTTP)', () => {
  it('serializes the paired result and preserves the provider call ID', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ choices: [{
      finish_reason: 'tool_calls',
      message: { content: null, tool_calls: [{
        id: 'new-call', type: 'function', function: { name: 'inspect_specs', arguments: '{"includePagination":true}' },
      }] },
    }] }));
    vi.stubGlobal('fetch', fetchMock);
    const model = openAI();
    const messages: Message[] = [goal,
      { role: 'assistant', content: '', toolCalls: [{ id: 'prev', name: 'inspect_specs', arguments: { includePagination: false } }] },
      { role: 'tool', toolCallId: 'prev', content: '{"ok":true}' },
    ];
    const next = await model.respond(messages, tools, signal);
    const [endpoint, request] = fetchMock.mock.calls[0];
    expect(endpoint).toBe('https://api.openai.com/v1/chat/completions');
    expect(request?.signal).toBe(signal);
    expect(JSON.parse(request?.body as string)).toMatchObject({
      model: 'test-model',
      max_completion_tokens: 1000,
      messages: [
        { role: 'user' },
        { role: 'assistant', tool_calls: [{ id: 'prev', function: { arguments: '{"includePagination":false}' } }] },
        { role: 'tool', tool_call_id: 'prev' },
      ],
    });
    expect(next.calls).toEqual([{ id: 'new-call', name: 'inspect_specs', arguments: { includePagination: true } }]);
  });

  it('never passes calls from truncated output to the executor', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ choices: [{
      finish_reason: 'length',
      message: { content: 'partial', tool_calls: [{ id: 'almost', function: { arguments: '{' } }] },
    }] })));
    await expect(openAI().respond([goal], tools, signal)).resolves.toEqual({ stop: 'length', text: 'partial', calls: [] });
  });

  it('turns malformed JSON arguments into a harness validation failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ choices: [{
      finish_reason: 'tool_calls',
      message: { content: null, tool_calls: [{
        id: 'malformed', type: 'function', function: { name: 'inspect_specs', arguments: '{"includePagination":' },
      }] },
    }] })));
    const reply = await openAI().respond([goal], tools, signal);
    expect(validateCall(reply.calls[0], tools)).toMatchObject({ ok: false });
  });

  it('classifies rate limiting without returning the provider response body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('non-public provider detail', {
      status: 429, headers: { 'retry-after': '2' },
    })));
    const error = await openAI().respond([goal], tools, signal).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(TransientError);
    expect(error).toMatchObject({ message: 'OpenAI returned HTTP 429', retryAfterMs: 2000 });
  });

  it('does not contact the provider after cancellation', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(openAI().respond([goal], tools, AbortSignal.abort(new Error('cancelled')))).rejects.toThrow('cancelled');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
