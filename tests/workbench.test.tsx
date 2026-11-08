// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Command, Operation, Run, RunDetail } from '../src/contracts';
import { Workbench } from '../web/Workbench';

const now = '2026-11-09T00:00:00.000Z';
const run: Run = {
  id: 'run-main', goal: 'Compare stable API versions', revision: 2,
  status: 'WAITING_APPROVAL', model: 'scripted', scenario: 'lost-receipt',
  turns: 2, maxTurns: 8, deadline: now, messages: [], pending: [], final: null, error: null,
  context: { messages: [], estimatedTokens: 202, omittedMessages: 3, tokenCounter: 'estimate', limit: 1200 },
  createdAt: now, updatedAt: now,
};
const operation: Operation = {
  id: 'operation-current', runId: run.id, revision: 2, callId: 'call-2', tool: 'publish_report',
  args: { report: 'A cited comparison' }, argsHash: 'digest', state: 'PROPOSED', result: null, attempts: 0,
  approvedUntil: null, createdAt: now,
};
const detail = (overrides: Partial<RunDetail> = {}): RunDetail => ({
  run, operations: [operation],
  events: [{ id: 1, runId: run.id, revision: 1, type: 'tool_intent_recorded', detail: { operation: 'previous' }, createdAt: now }],
  reports: [], ...overrides,
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function backend(snapshot: RunDetail, options: { command?: (payload: Command) => Response; list?: Run[] } = {}) {
  const commands: Command[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === '/api/runs') return json(options.list ?? [snapshot.run]);
    if (path === '/api/runs/' + snapshot.run.id) return json(snapshot);
    if (path === '/api/runs/' + snapshot.run.id + '/commands') {
      const command = JSON.parse(String(init?.body)) as Command;
      commands.push(command);
      return options.command?.(command) ?? json(snapshot.run);
    }
    throw new Error('Unexpected path ' + path);
  });
  vi.stubGlobal('fetch', fetch);
  return commands;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Agent Revision Lab workbench', () => {
  it('starts a keyless experiment from an empty workspace', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/runs' && init?.method === 'POST') return json({ id: run.id }, 201);
      if (String(input) === '/api/runs') return json([]);
      if (String(input) === '/api/runs/' + run.id) return json(detail());
      throw new Error('Unexpected path ' + String(input));
    });
    vi.stubGlobal('fetch', fetch);
    const user = userEvent.setup();
    render(<Workbench />);
    expect(await screen.findByText('No runs recorded.')).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('Scenario'), 'lost-receipt');
    await user.click(screen.getByRole('button', { name: 'Start run' }));
    await screen.findByRole('heading', { name: run.goal });
    const request = fetch.mock.calls.find(([path, init]) => path === '/api/runs' && init?.method === 'POST');
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({
      model: 'scripted', scenario: 'lost-receipt', goal: expect.stringContaining('exclude beta'),
    });
    expect(screen.getByText('Scripted model')).toBeTruthy();
    expect(screen.getByText(/3 messages omitted/)).toBeTruthy();
  });

  it('binds approval to the displayed current operation and revision', async () => {
    const commands = backend(detail({ operations: [{ ...operation, id: 'operation-stale', revision: 1 }, operation] }));
    const user = userEvent.setup();
    render(<Workbench />);
    const approve = await screen.findByRole('button', { name: 'Approve write' });
    expect(screen.getAllByRole('button', { name: 'Approve write' })).toHaveLength(1);
    await user.click(approve);
    await waitFor(() => expect(commands).toEqual([{
      kind: 'approve', operationId: operation.id, expectedRevision: 2,
      commandId: expect.stringMatching(/^[\da-f]{8}-[\da-f-]{27}$/i),
    }]));
    expect(screen.getByText('Tool intent recorded')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Export trace' }).getAttribute('href')).toBe('/api/runs/' + run.id + '/export');
  });

  it('sends revision changes and requires cancellation confirmation', async () => {
    const commands = backend(detail());
    const user = userEvent.setup();
    render(<Workbench />);
    await user.click(await screen.findByRole('button', { name: 'Revise goal' }));
    await user.clear(screen.getByLabelText('Revised goal'));
    await user.type(screen.getByLabelText('Revised goal'), 'Also check pagination');
    await user.click(screen.getByRole('button', { name: 'Save revision' }));
    await waitFor(() => expect(commands[0]).toMatchObject({ kind: 'revise', goal: 'Also check pagination', expectedRevision: 2 }));
    await user.click(screen.getByRole('button', { name: 'Cancel run' }));
    expect(commands).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Confirm cancellation' }));
    await waitFor(() => expect(commands[1]).toMatchObject({ kind: 'cancel', expectedRevision: 2 }));
  });

  it('requires outcome, evidence and confirmation for a manual reconciliation', async () => {
    const unknown = { ...operation, revision: 1, state: 'UNKNOWN' as const };
    const commands = backend(detail({ run: { ...run, status: 'WAITING_RECONCILIATION' }, operations: [unknown] }));
    const user = userEvent.setup();
    render(<Workbench />);
    await user.click(await screen.findByRole('button', { name: 'Reconcile outcome' }));
    const form = screen.getByRole('form', { name: 'Reconcile the write' });
    const submit = within(form).getByRole('button', { name: 'Record outcome' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await user.selectOptions(within(form).getByLabelText('Observed outcome'), 'applied');
    await user.type(within(form).getByLabelText('Evidence note'), 'The destination lists the original write.');
    expect(submit.disabled).toBe(true);
    await user.click(within(form).getByRole('checkbox', { name: 'I verified this outcome at the destination.' }));
    await user.click(submit);
    await waitFor(() => expect(commands[0]).toMatchObject({
      kind: 'reconcile', expectedRevision: 2, operationId: unknown.id,
      resolution: 'applied', note: 'The destination lists the original write.',
    }));
  });

  it('shows a failed command and keeps its idempotency key for retry', async () => {
    let attempts = 0;
    const commands = backend(detail(), { command: () => attempts++ ? json(run) : json({ error: 'Temporarily unavailable' }, 503) });
    const user = userEvent.setup();
    render(<Workbench />);
    await user.click(await screen.findByRole('button', { name: 'Approve write' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Temporarily unavailable (503)');
    await user.click(screen.getByRole('button', { name: 'Approve write' }));
    await waitFor(() => expect(commands).toHaveLength(2));
    expect(commands[1]).toEqual(commands[0]);
  });

  it('offers an explicit retry for a stopped executor and preserves the goal revision', async () => {
    const commands = backend(detail({ execution: { status: 'ERROR', executorId: 'test-worker' } }));
    const user = userEvent.setup();
    render(<Workbench />);
    const retry = await screen.findByRole('button', { name: 'Retry execution' });
    expect(screen.getByRole('alert').textContent).toBe('Execution stopped. Your run state is preserved.');
    expect(commands).toHaveLength(0);
    await user.click(retry);
    await waitFor(() => expect(commands[0]).toMatchObject({ kind: 'retry', expectedRevision: 2, commandId: expect.any(String) }));
  });

  it.each(['unknown outcome', 'terminal run'] as const)('disables executor retry with a %s', async reason => {
    const commands = backend(detail({
      execution: { status: 'MAX_RECOVERY_ATTEMPTS_EXCEEDED' },
      run: { ...run, status: reason === 'terminal run' ? 'FAILED' : 'WAITING_RECONCILIATION' },
      operations: reason === 'unknown outcome' ? [{ ...operation, state: 'UNKNOWN' }] : [],
    }));
    const user = userEvent.setup();
    render(<Workbench />);
    const retry = await screen.findByRole('button', { name: 'Retry execution' }) as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    if (reason === 'unknown outcome') expect(screen.getByRole('button', { name: 'Reconcile outcome' })).toBeTruthy();
    await user.click(retry);
    expect(commands).toHaveLength(0);
  });

  it('discards a stale detail request when the selection changes', async () => {
    const secondRun = { ...run, id: 'run-second', goal: 'Verify the second API' };
    let finishFirst: ((response: Response) => void) | undefined;
    let firstSignal: AbortSignal | null | undefined;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/runs') return Promise.resolve(json([run, secondRun]));
      if (path === '/api/runs/' + run.id) {
        firstSignal = init?.signal;
        return new Promise<Response>(resolve => { finishFirst = resolve; });
      }
      if (path === '/api/runs/' + secondRun.id) return Promise.resolve(json(detail({ run: secondRun, operations: [] })));
      throw new Error('Unexpected path ' + path);
    }));
    const user = userEvent.setup();
    render(<Workbench />);
    const other = await screen.findByRole('button', { name: /Verify the second API/ });
    await waitFor(() => expect(finishFirst).toBeTypeOf('function'));
    await user.click(other);
    await screen.findByRole('heading', { name: secondRun.goal });
    expect(firstSignal?.aborted).toBe(true);
    await act(async () => { finishFirst?.(json(detail())); });
    expect(screen.queryByRole('heading', { name: run.goal })).toBeNull();
    expect(screen.getByRole('heading', { name: secondRun.goal })).toBeTruthy();
  });

  it('keeps a run-list failure visible', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'Database unavailable' }, 503)));
    render(<Workbench />);
    expect((await screen.findByRole('alert')).textContent).toContain('Could not load runs: Database unavailable (503)');
  });
});
