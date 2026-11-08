import { describe, expect, it, vi } from 'vitest';
import {
  buildContext, canonicalHash, retryRead, TimeoutError, TransientError, validateCall, withTimeout,
} from '../src/core.js';
import type { Message, ToolSpec } from '../src/contracts.js';

const inspect: ToolSpec = {
  name: 'inspect', effect: 'read', description: 'Inspect a fixture.',
  parameters: { type: 'object', required: ['limit'], additionalProperties: false, properties: { limit: { type: 'integer' } } },
};
const publish: ToolSpec = {
  name: 'publish', effect: 'write', description: 'Publish a fixture.',
  parameters: { type: 'object' },
};
const tools = [inspect, publish];

function block(id: string, name: string, result: string): Message[] {
  return [
    { role: 'assistant', content: '', toolCalls: [{ id, name, arguments: { limit: 20 } }] },
    { role: 'tool', toolCallId: id, content: result },
  ];
}

describe('context projection', () => {
  it('drops old read blocks as pairs and retains the current goal and write evidence', () => {
    const goal = 'Only stable APIs. Exclude beta. Cite the limit change.';
    const confirmedWrite = block('write-1', 'publish', 'receipt:report-1');
    const latest = block('read-2', 'inspect', '/orders limit=50');
    const required = buildContext(goal, 2, [...confirmedWrite, ...latest], tools);
    const old = block('read-1', 'inspect', 'Older evidence '.repeat(500));
    const history: Message[] = [
      { role: 'user', content: 'Obsolete goal: include beta' },
      ...old, ...confirmedWrite, ...latest,
    ];
    const projected = buildContext(goal, 2, history, tools, required.estimatedTokens);
    expect(projected.messages.slice(2)).toEqual([...confirmedWrite, ...latest]);
    expect(projected.messages[1].content).toBe(JSON.stringify({ revision: 2, goal }));
    expect(projected.omittedMessages).toBe(3);
    expect(projected.estimatedTokens).toBeLessThanOrEqual(projected.limit);
    expect(history).toHaveLength(7);
  });

  it('rejects mismatched and unfinished tool history before contacting a model', () => {
    const pair = block('call-1', 'inspect', 'ok');
    expect(() => buildContext('Goal', 1, pair.slice(0, 1), tools)).toThrow(/incomplete/);
    expect(() => buildContext('Goal', 1, [{ ...pair[1], toolCallId: 'unknown' }], tools)).toThrow(/unpaired/);
    expect(() => buildContext('Goal', 1, [pair[0], { ...pair[1], toolCallId: 'other' }], tools)).toThrow(/mismatched/);
  });

  it('counts tool schema overhead and fails when mandatory material cannot fit', () => {
    const noTools = buildContext('Goal', 1, [], []);
    expect(() => buildContext('Goal', 1, [], tools, noTools.estimatedTokens)).toThrow(/budget/);
    const hugeReceipt = block('write-1', 'publish', 'Important receipt '.repeat(2000));
    expect(() => buildContext('Goal', 1, hugeReceipt, tools, 200)).toThrow(/budget/);
  });

  it('retains a multi-tool assistant turn only with all matching results', () => {
    const history: Message[] = [
      { role: 'assistant', content: '', toolCalls: [
        { id: 'one', name: 'inspect', arguments: { limit: 1 } },
        { id: 'two', name: 'inspect', arguments: { limit: 2 } },
      ] },
      { role: 'tool', content: 'second result', toolCallId: 'two' },
      { role: 'tool', content: 'first result', toolCallId: 'one' },
    ];
    expect(buildContext('Goal', 1, history, tools).messages.slice(2)).toEqual(history);
  });
});

describe('tool input', () => {
  it('rejects invalid arguments without coercion or deleting unexpected keys', () => {
    const args = { limit: '20' };
    expect(validateCall({ id: '1', name: inspect.name, arguments: args }, tools)).toMatchObject({ ok: false });
    expect(args.limit).toBe('20');
    expect(validateCall({ id: '1', name: inspect.name, arguments: { limit: 20, extra: true } }, tools)).toMatchObject({ ok: false });
    expect(validateCall({ id: '1', name: 'unregistered', arguments: {} }, tools)).toMatchObject({ ok: false });
    expect(validateCall({ id: '1', name: inspect.name, arguments: { limit: 20 } }, tools)).toEqual({ ok: true });
  });

  it('binds approval hashes to nested JSON values, independent of object key order', () => {
    expect(canonicalHash({ b: 2, a: [{ y: 'x', z: 3 }] })).toBe(canonicalHash({ a: [{ z: 3, y: 'x' }], b: 2 }));
    expect(canonicalHash({ a: [1, 2] })).not.toBe(canonicalHash({ a: [2, 1] }));
    expect(canonicalHash(JSON.parse('{"__proto__":{"x":1}}'))).not.toBe(canonicalHash({}));
    expect(() => canonicalHash({ a: undefined })).toThrow(/JSON/);
  });
});

describe('read and deadline policies', () => {
  it('rejects at the deadline even if the tool ignores cancellation and resolves later', async () => {
    let resolveLate!: (value: string) => void;
    let captured!: AbortSignal;
    const run = withTimeout(signal => {
      captured = signal;
      return new Promise<string>(resolve => { resolveLate = resolve; });
    }, 10);
    await expect(run).rejects.toBeInstanceOf(TimeoutError);
    expect(captured.aborted).toBe(true);
    resolveLate('late success');
    await expect(run).rejects.toBeInstanceOf(TimeoutError);
  });

  it('does not start work for an already cancelled operation', async () => {
    const operation = vi.fn(async () => 'unexpected');
    await expect(withTimeout(operation, 100, AbortSignal.abort(new Error('cancelled')))).rejects.toThrow('cancelled');
    expect(operation).not.toHaveBeenCalled();
  });

  it('retries transient reads up to the limit and never retries permanent errors', async () => {
    const retryable = vi.fn(async () => { throw new TransientError('busy'); });
    const options = { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 };
    await expect(retryRead(retryable, options)).rejects.toThrow('busy');
    expect(retryable).toHaveBeenCalledTimes(3);
    const permanent = vi.fn(async () => { throw new Error('forbidden'); });
    await expect(retryRead(permanent, options)).rejects.toThrow('forbidden');
    expect(permanent).toHaveBeenCalledTimes(1);
  });

  it('stops rather than violating a Retry-After beyond the delay cap', async () => {
    const read = vi.fn(async () => { throw new TransientError('rate limited', 60_000); });
    await expect(retryRead(read, { maxDelayMs: 1000 })).rejects.toThrow('rate limited');
    expect(read).toHaveBeenCalledTimes(1);
  });
});
