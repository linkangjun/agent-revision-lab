import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { Command, Operation, Run, RunDetail, RunEvent, Scenario } from '../src/contracts';
import { errorMessage, post, usePolling } from './api';

const sampleGoal = 'Compare stable v1 and v2, exclude beta, and publish a cited compatibility report.';
const terminal = new Set<Run['status']>(['SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED']);
const scenarios: Record<Scenario, { label: string; description: string }> = {
  clean: { label: 'Clean run', description: 'Review the API changes and approve the report.' },
  'lost-receipt': { label: 'Lost receipt', description: 'The write succeeds, but the receipt is lost. Lookup is available.' },
  'no-lookup': { label: 'No lookup', description: 'The receipt is lost and the outcome needs manual reconciliation.' },
};
const statusText: Record<Run['status'], string> = {
  QUEUED: 'Queued', RUNNING: 'Running', WAITING_APPROVAL: 'Needs approval',
  WAITING_RECONCILIATION: 'Needs reconciliation', SUCCEEDED: 'Succeeded',
  FAILED: 'Failed', CANCELLED: 'Cancelled', EXPIRED: 'Expired',
};

function Glyph({ name }: { name: 'plus' | 'arrow' | 'download' | 'loop' | 'branch' }) {
  const paths: Record<typeof name, ReactNode> = {
    plus: <path d="M8 3v10M3 8h10" />,
    arrow: <path d="M3 8h10m-4-4 4 4-4 4" />,
    download: <path d="M8 2v8m-3-3 3 3 3-3M3 11v3h10v-3" />,
    loop: <path d="M12.5 5.5A5 5 0 1 0 13 9M13 2v4h-4" />,
    branch: <><circle cx="4" cy="3.5" r="1.5"/><circle cx="4" cy="12.5" r="1.5"/><circle cx="12" cy="3.5" r="1.5"/><path d="M4 5v6m8-6c0 4-8 2-8 6"/></>,
  };
  return <svg className="glyph" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function Badge({ status }: { status: Run['status'] }) {
  return <span className={'badge status-' + status.toLowerCase()}>{statusText[status]}</span>;
}

function ErrorNotice({ children }: { children: ReactNode }) {
  return <p className="error-notice" role="alert">{children}</p>;
}

function modelLabel(model: string) {
  return model === 'scripted' ? 'Scripted model' : model === 'openai' ? 'OpenAI' : model;
}

function operationLabel(id: string, runId: string) {
  return id.startsWith(runId + ':') ? id.slice(runId.length + 1) : id.slice(0, 12);
}

function Json({ value }: { value: unknown }) {
  return <pre className="data-block">{JSON.stringify(value, null, 2) ?? '—'}</pre>;
}

function ArgumentsPreview({ operation }: { operation: Operation }) {
  const args = operation.args;
  if (operation.tool === 'publish_report' && args && typeof args === 'object' && 'report' in args && typeof args.report === 'string' && Object.keys(args).length === 1) {
    return <pre className="data-block">{args.report}</pre>;
  }
  return <Json value={args} />;
}

function NewRun({ onCreate, onBack }: { onCreate: (id: string) => void; onBack?: () => void }) {
  const [goal, setGoal] = useState(sampleGoal);
  const [scenario, setScenario] = useState<Scenario>('clean');
  const [model, setModel] = useState<'scripted' | 'openai'>('scripted');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const inFlight = useRef<AbortController | null>(null);
  useEffect(() => () => inFlight.current?.abort(), []);

  async function start(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current || !goal.trim()) return;
    const controller = new AbortController();
    inFlight.current = controller;
    setBusy(true);
    setError(undefined);
    try {
      const result = await post<{ id: string }>('/api/runs', { goal: goal.trim(), scenario, model }, controller.signal);
      if (!controller.signal.aborted) onCreate(result.id);
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause));
    } finally {
      inFlight.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return <main className="new-main" id="workspace">
    <header className="new-intro">
      <span className="eyebrow accent">01 / START AN EXPERIMENT</span>
      <h1>Give an agent<br /> a goal<span className="accent">.</span></h1>
      <p>Follow each decision from the first model turn to the last tool receipt. Revise the goal while the run is in progress to see what changes.</p>
    </header>
    <form className="new-form" onSubmit={start}>
      <fieldset disabled={busy}>
        <label htmlFor="new-goal">Goal</label>
        <textarea id="new-goal" rows={3} required maxLength={4000} value={goal} onChange={event => setGoal(event.target.value)} />
        <div className="form-row">
          <div>
            <label htmlFor="scenario">Scenario</label>
            <select id="scenario" value={scenario} onChange={event => setScenario(event.target.value as Scenario)} aria-describedby="scenario-help">
              {Object.entries(scenarios).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="model">Model</label>
            <select id="model" value={model} onChange={event => setModel(event.target.value as typeof model)} aria-describedby="model-help">
              <option value="scripted">Scripted (no API key)</option>
              <option value="openai">OpenAI</option>
            </select>
          </div>
        </div>
        <p id="scenario-help" className="hint">{scenarios[scenario].description}</p>
        <p id="model-help" className="hint">{model === 'scripted' ? 'The scripted model uses a fixed demonstration flow.' : 'Uses the server’s configured OpenAI model and sends model inputs to OpenAI.'}</p>
        {error && <ErrorNotice>{error}</ErrorNotice>}
        <div className="actions">
          <button className="button primary" type="submit" disabled={!goal.trim()}>{busy ? 'Starting…' : 'Start run'}<Glyph name="arrow" /></button>
          {onBack && <button type="button" className="button quiet" onClick={onBack}>Back to run</button>}
        </div>
      </fieldset>
    </form>
  </main>;
}

function eventTitle(type: string) {
  const words = type.replace(/[_\-.]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const eventTime = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
function Timeline({ events, revision }: { events: RunEvent[]; revision: number }) {
  return <section className="timeline-section" aria-labelledby="timeline-title">
    <div className="section-heading"><div><span className="eyebrow accent">02 / TRACE</span><h2 id="timeline-title">Execution timeline</h2></div><span className="count">{events.length} {events.length === 1 ? 'event' : 'events'}</span></div>
    {events.length === 0 && <p className="quiet-empty">No execution events yet.</p>}
    <ol className="timeline">
      {events.map(event => <li key={event.id} className={event.revision < revision ? 'prior' : undefined}>
        <div className="event-meta"><span className="revision">REV {event.revision}</span><time dateTime={event.createdAt}>{eventTime.format(new Date(event.createdAt))}</time></div>
        <details className="event-detail">
          <summary>{eventTitle(event.type)}</summary>
          <Json value={event.detail} />
        </details>
      </li>)}
    </ol>
  </section>;
}

type PendingCommand = Omit<Command, 'commandId'>;
type CommandForm = { kind: 'revise'; revision: number } | { kind: 'cancel'; revision: number } | { kind: 'reconcile'; revision: number; operationId: string };

function CommandPanel({ form, run, operation, busy, onClose, onSubmit }: {
  form: CommandForm; run: Run; operation?: Operation; busy: boolean; onClose: () => void; onSubmit: (payload: PendingCommand) => Promise<void>;
}) {
  const [goal, setGoal] = useState(run.goal);
  const [note, setNote] = useState('');
  const [resolution, setResolution] = useState<'' | 'applied' | 'not_applied'>('');
  const [checked, setChecked] = useState(false);
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => { title.current?.focus(); }, []);
  const stale = form.revision !== run.revision || (form.kind === 'reconcile' ? operation?.state !== 'UNKNOWN' : terminal.has(run.status));
  const heading = form.kind === 'revise' ? 'Revise the goal' : form.kind === 'cancel' ? 'Cancel this run' : 'Reconcile the write';
  const canSubmit = !stale && (form.kind === 'revise' ? !!goal.trim() && goal.trim() !== run.goal : form.kind === 'cancel' ? true : !!resolution && !!note.trim() && checked);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit || busy) return;
    const expectedRevision = form.revision;
    if (form.kind === 'revise') void onSubmit({ kind: 'revise', expectedRevision, goal: goal.trim() });
    else if (form.kind === 'cancel') void onSubmit({ kind: 'cancel', expectedRevision });
    else if (resolution) void onSubmit({ kind: 'reconcile', expectedRevision, operationId: form.operationId, resolution, note: note.trim() });
  }

  return <form onSubmit={submit} className="command-panel" aria-label={heading}>
    <fieldset disabled={busy}>
      <h3 ref={title} tabIndex={-1}>{heading}</h3>
      {stale && <ErrorNotice>The run changed while this form was open. Close it and check the latest state before continuing.</ErrorNotice>}
      {form.kind === 'revise' && <>
        <p className="hint">This starts a new goal revision. Existing approvals belong to the previous goal.</p>
        <label htmlFor="revised-goal">Revised goal</label>
        <textarea id="revised-goal" rows={3} maxLength={4000} required value={goal} onChange={event => setGoal(event.target.value)} />
      </>}
      {form.kind === 'cancel' && <p className="hint">Cancel further work on revision {form.revision}. A tool write already sent may still take effect.</p>}
      {form.kind === 'reconcile' && <>
        <p className="hint">Check the destination first. Record the outcome of <code>{operationLabel(form.operationId, run.id)}</code> for operation revision {operation?.revision ?? '—'}.</p>
        <label htmlFor="resolution">Observed outcome</label>
        <select id="resolution" required value={resolution} onChange={event => { setResolution(event.target.value as typeof resolution); setChecked(false); }}>
          <option value="">Choose an outcome…</option>
          <option value="applied">Write was applied</option>
          <option value="not_applied">Write was not applied</option>
        </select>
        <label htmlFor="reconciliation-note">Evidence note</label>
        <textarea id="reconciliation-note" required rows={2} maxLength={1000} value={note} onChange={event => { setNote(event.target.value); setChecked(false); }} />
        <label className="check-label"><input type="checkbox" checked={checked} onChange={event => setChecked(event.target.checked)} /> I verified this outcome at the destination.</label>
      </>}
      <div className="actions"><button type="submit" className="button primary" disabled={!canSubmit}>{busy ? 'Saving…' : form.kind === 'revise' ? 'Save revision' : form.kind === 'cancel' ? 'Confirm cancellation' : 'Record outcome'}</button><button type="button" className="button quiet" onClick={onClose}>Close</button></div>
    </fieldset>
  </form>;
}

function Inspector({ detail, commandBusy, onApprove, onReconcile }: {
  detail: RunDetail; commandBusy: boolean; onApprove: (operation: Operation) => void; onReconcile: (operation: Operation) => void;
}) {
  const { run, operations, reports } = detail;
  const context = run.context;
  return <aside className="inspector" aria-label="Run details">
    <section className="inspector-section">
      <span className="eyebrow accent">03 / EFFECTS</span><h2>Operations</h2>
      {operations.length === 0 && <p className="hint">Tool writes will appear here.</p>}
      <div className="operations">
        {operations.map(operation => <article key={operation.id} className="operation">
          <div className="operation-meta"><span className="revision">REV {operation.revision}</span><span className={'operation-state state-' + operation.state.toLowerCase()}>{eventTitle(operation.state)}</span></div>
          <h3>{operation.tool}</h3>
          <p className="hint">{operation.attempts} {operation.attempts === 1 ? 'attempt' : 'attempts'} · <code title={operation.id}>{operationLabel(operation.id, run.id)}</code></p>
          <details open={operation.state === 'PROPOSED' && operation.revision === run.revision ? true : undefined}><summary>Arguments</summary><ArgumentsPreview operation={operation} /></details>
          {operation.result != null && <details><summary>Result</summary><Json value={operation.result} /></details>}
          {operation.state === 'PROPOSED' && operation.revision === run.revision && run.status === 'WAITING_APPROVAL' &&
            <button type="button" className="button primary full" disabled={commandBusy} onClick={() => onApprove(operation)}>Approve write <Glyph name="arrow" /></button>}
          {operation.state === 'UNKNOWN' && <button type="button" className="button outline full" disabled={commandBusy} onClick={() => onReconcile(operation)}>Reconcile outcome</button>}
        </article>)}
      </div>
    </section>
    <section className="inspector-section context-section">
      <span className="eyebrow accent">04 / INPUT</span><h2>Context budget</h2>
      {context ? <>
        <div className="meter-line"><strong>{context.estimatedTokens.toLocaleString()}</strong><span>/ {context.limit.toLocaleString()} estimated tokens</span></div>
        <meter aria-label="Estimated context usage" min={0} max={Math.max(1, context.limit)} value={context.estimatedTokens} />
        <p className="hint">{context.omittedMessages} {context.omittedMessages === 1 ? 'message' : 'messages'} omitted · {context.tokenCounter}</p>
        <details><summary>Projected messages</summary><Json value={context.messages} /></details>
      </> : <p className="hint">The first model input has not been recorded.</p>}
    </section>
    {reports.length > 0 && <section className="inspector-section">
      <span className="eyebrow accent">05 / OUTPUT</span><h2>Published reports</h2>
      {reports.map(report => <details key={report.operationId} className="report"><summary>Revision {report.revision} · {operationLabel(report.operationId, run.id)}</summary><p>{report.report}</p></details>)}
    </section>}
  </aside>;
}

function RunView({ id, onChange }: { id: string; onChange: () => void }) {
  const path = '/api/runs/' + encodeURIComponent(id);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const { value: detail, error } = usePolling<RunDetail>(path, refresh, busy);
  const [commandError, setCommandError] = useState<string>();
  const [form, setForm] = useState<CommandForm>();
  const inFlight = useRef<AbortController | null>(null);
  const commandIds = useRef(new Map<string, string>());
  useEffect(() => () => inFlight.current?.abort(), []);

  async function command(payload: PendingCommand) {
    if (inFlight.current) return;
    const controller = new AbortController();
    inFlight.current = controller;
    setBusy(true);
    setCommandError(undefined);
    const key = JSON.stringify(payload);
    try {
      const commandId = commandIds.current.get(key) ?? crypto.randomUUID();
      commandIds.current.set(key, commandId);
      await post<Run>(path + '/commands', { ...payload, commandId }, controller.signal);
      if (!controller.signal.aborted) {
        commandIds.current.delete(key);
        setForm(undefined);
        onChange();
      }
    } catch (cause) {
      if (!controller.signal.aborted) setCommandError(errorMessage(cause));
    } finally {
      inFlight.current = null;
      if (!controller.signal.aborted) { setBusy(false); setRefresh(value => value + 1); }
    }
  }

  if (!detail) return <main id="workspace" className="waiting-view">{error ? <ErrorNotice>{error}</ErrorNotice> : <p role="status">Loading run…</p>}</main>;
  const { run, events, operations, execution } = detail;
  const ended = terminal.has(run.status);
  const executionStopped = execution?.status === 'ERROR' || execution?.status === 'MAX_RECOVERY_ATTEMPTS_EXCEEDED';
  const needsReconciliation = operations.some(operation => operation.state === 'UNKNOWN');
  return <div className="run-layout">
    <main id="workspace" className="run-main">
      <header className="run-heading">
        <div className="run-topline"><span className="eyebrow accent">01 / GOAL</span><span className="run-id" title={id}>{id.slice(0, 12)}</span></div>
        <h1>{run.goal}</h1>
        <div className="run-facts"><Badge status={run.status} /><span className="revision">REV {run.revision}</span><span>{modelLabel(run.model)}</span><span>{scenarios[run.scenario].label}</span><span>{run.turns}/{run.maxTurns} turns</span></div>
        <div className="actions run-actions">
          {!ended && <>
            <button type="button" className="button outline" disabled={busy} onClick={() => setForm({ kind: 'revise', revision: run.revision })}><Glyph name="branch" /> Revise goal</button>
            <button type="button" className="button quiet" disabled={busy} onClick={() => setForm({ kind: 'cancel', revision: run.revision })}>Cancel run</button>
          </>}
          <a className="button quiet export" href={path + '/export'} download><Glyph name="download" /> Export trace</a>
        </div>
        {executionStopped && <section className="error-notice" aria-label="Execution stopped">
          <p role="alert"><strong>Execution stopped.</strong> Your run state is preserved.</p>
          {ended ? <p>This run has ended.</p> : needsReconciliation ? <p>Reconcile the unknown tool outcome before retrying execution.</p> : null}
          <div className="actions"><button type="button" className="button outline" disabled={busy || ended || needsReconciliation}
            onClick={() => void command({ kind: 'retry', expectedRevision: run.revision })}>Retry execution</button></div>
        </section>}
        {form && <CommandPanel key={form.kind === 'reconcile' ? form.kind + form.operationId + form.revision : form.kind + form.revision} form={form} run={run} operation={form.kind === 'reconcile' ? operations.find(operation => operation.id === form.operationId) : undefined} busy={busy} onClose={() => setForm(undefined)} onSubmit={command} />}
        {error && <ErrorNotice>Could not refresh this run: {error}</ErrorNotice>}
        {commandError && <ErrorNotice>{commandError}</ErrorNotice>}
        {run.error && <ErrorNotice>{run.error}</ErrorNotice>}
        {run.final && <details className="final-result"><summary>Final response</summary><p>{run.final}</p></details>}
      </header>
      <Timeline events={events} revision={run.revision} />
    </main>
    <Inspector detail={detail} commandBusy={busy} onApprove={operation => void command({ kind: 'approve', expectedRevision: run.revision, operationId: operation.id })}
      onReconcile={operation => setForm({ kind: 'reconcile', revision: run.revision, operationId: operation.id })} />
  </div>;
}

export function Workbench() {
  const [selection, setSelection] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const { value: runs, error } = usePolling<Run[]>('/api/runs', refresh);
  const firstList = useRef(true);
  useEffect(() => {
    if (!runs || !firstList.current) return;
    firstList.current = false;
    if (runs[0]) setSelection(current => current ?? runs[0].id);
    else setCreating(true);
  }, [runs]);
  const active = selection ?? runs?.[0]?.id;
  const listRefresh = () => setRefresh(value => value + 1);
  return <>
    <a className="skip" href="#workspace">Skip to workspace</a>
    <header className="masthead">
      <div className="wordmark"><span className="mark"><Glyph name="branch" /></span><span>Agent Revision Lab</span></div>
      <span className="local-label"><span aria-hidden="true" />Local only</span>
    </header>
    <div className="shell">
      <nav className="runs" aria-label="Runs">
        <div className="rail-heading"><span className="eyebrow">RUN LOG</span><span className="count">{runs?.length ?? '—'}</span></div>
        <button type="button" className="button new-button" onClick={() => setCreating(true)}><Glyph name="plus" /> New run</button>
        {error && <ErrorNotice>Could not load runs: {error}</ErrorNotice>}
        {!runs && !error && <p className="rail-empty" role="status">Loading runs…</p>}
        {runs?.length === 0 && <p className="rail-empty">No runs recorded.</p>}
        <ul className="run-list">
          {runs?.map(run => <li key={run.id}><button type="button" aria-current={active === run.id && !creating ? 'true' : undefined} onClick={() => { setSelection(run.id); setCreating(false); }}>
            <span className="rail-goal">{run.goal}</span><span className="rail-meta"><Badge status={run.status} /><span className="revision">R{run.revision}</span></span>
          </button></li>)}
        </ul>
        <div className="rail-foot"><Glyph name="loop" /><span>Scripted runs use synthetic data.</span></div>
      </nav>
      {!runs && !error && !creating ? <main id="workspace" className="waiting-view"><p role="status">Loading workspace…</p></main> : creating || !active ? <NewRun onCreate={id => { setSelection(id); setCreating(false); listRefresh(); }} onBack={active ? () => setCreating(false) : undefined} /> : <RunView key={active} id={active} onChange={listRefresh} />}
    </div>
  </>;
}
