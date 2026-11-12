import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, Invalid, Conflict, Missing } from './store.js';
import { createRuntimeClient } from './durable.js';
import type { Command, Operation, Scenario } from './contracts.js';
import { canonicalHash } from './core.js';

const sameSecret = (a: string, b: string) => { const x=Buffer.from(a), y=Buffer.from(b); return x.length === y.length && timingSafeEqual(x,y); };
async function body(req: IncomingMessage): Promise<any> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Invalid('application/json required');
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { size += chunk.length; if (size > 64 * 1024) throw new Invalid('Request too large'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Invalid('Invalid JSON'); }
}
function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(data));
}
export async function startServer(options: {databaseUrl: string; internalToken: string; port?: number; host?: string; webRoot?: string}) {
  if (options.internalToken.length < 24) throw new Error('Internal service token must have at least 24 characters');
  const runtime = await createRuntimeClient(options.databaseUrl);
  const store = new Store(options.databaseUrl, runtime); await store.init();
  const port = options.port ?? 4317;
  const webRoot = resolve(options.webRoot ?? 'web-dist');
  const server = createServer(async (req, res) => {
    try {
      // Loopback binding + host/origin checks protect this trusted local workbench against DNS rebinding/CSRF.
      const host = req.headers.host ?? '';
      const hostName = host.split(':')[0];
      if (!['localhost', '127.0.0.1', 'api'].includes(hostName)) { json(res, 403, {error:'Untrusted host'}); return; }
      if (req.headers.origin && ![`http://localhost:${port}`, `http://127.0.0.1:${port}`].includes(req.headers.origin)) { json(res,403,{error:'Cross-origin access denied'});return; }
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      if (path === '/api/health') { await store.pool.query('SELECT 1'); json(res,200,{status:'ok',mode:'local',version:'0.1.0-alpha.2'});return; }
      if (path.startsWith('/internal/')) {
        const token = req.headers['x-lab-internal-token'];
        if (typeof token !== 'string' || !sameSecret(token, options.internalToken)) { json(res,403,{error:'Internal service authentication required'});return; }
        if (path === '/internal/reports' && req.method === 'POST') {
          const input = await body(req); const op = input.operation as Operation;
          if (!op || typeof op.id !== 'string' || typeof op.runId !== 'string' || typeof (op.args as any)?.report !== 'string' || (op.args as any).report.length > 12000) throw new Invalid('Invalid report');
          const hash = canonicalHash(op.args);
          const report = await store.tx(async c => {
            await c.query('INSERT INTO arl_demo_reports(operation_id,run_id,revision,args_hash,report) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [op.id,op.runId,op.revision,hash,(op.args as {report:string}).report]);
            const saved = (await c.query('SELECT args_hash FROM arl_demo_reports WHERE operation_id=$1', [op.id])).rows[0];
            if (saved.args_hash !== hash) throw new Conflict('Idempotency key already bound to different arguments');
            return {ok:true,reportId:op.id,revision:op.revision};
          });
          const run = await store.get(op.runId);
          if (run.scenario === 'lost-receipt' || run.scenario === 'no-lookup') { res.destroy(); return; }
          json(res,200,report);return;
        }
        if (path.startsWith('/internal/reports/') && req.method === 'GET') {
          const id = decodeURIComponent(path.slice('/internal/reports/'.length));
          const r = await store.pool.query('SELECT operation_id,revision FROM arl_demo_reports WHERE operation_id=$1',[id]);
          json(res,200,r.rowCount ? {found:true,result:{ok:true,reportId:id,revision:r.rows[0].revision}} : {found:false});return;
        }
        throw new Missing('Endpoint not found');
      }
      if (path === '/api/runs' && req.method === 'GET') { json(res,200,await store.list());return; }
      if (path === '/api/runs' && req.method === 'POST') {
        const input = await body(req);
        if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.goal !== 'string') throw new Invalid('A goal string is required');
        if (input.model === 'openai' && (!process.env.OPENAI_API_KEY || !process.env.OPENAI_MODEL)) throw new Invalid('OpenAI is not configured. Use the scripted model or configure the server and worker.');
        const run = await store.create({goal: input.goal,scenario: input.scenario as Scenario,model: input.model});json(res,201,{id:run.id});return;
      }
      const revisions=path.match(/^\/api\/runs\/([\w-]+)\/revisions$/);
      if(revisions && req.method==='GET'){await store.get(revisions[1]);const rows=await store.pool.query('SELECT revision,snapshot FROM arl_revisions WHERE run_id=$1 ORDER BY revision',[revisions[1]]);json(res,200,rows.rows);return;}
      const route = path.match(/^\/api\/runs\/([\w-]+)(?:\/(commands|export))?$/);
      if (route) {
        const [,id,action] = route;
        if (action === 'commands' && req.method === 'POST') { json(res,200,await store.command(id,await body(req) as Command));return; }
        if (!action && req.method === 'GET') { const detail=await store.detail(id); json(res,200,{...detail,execution:await runtime.workflowStatus(detail.run.workflowId ?? id)});return; }
        if (action === 'export' && req.method === 'GET') {
          const detail = await store.detail(id);
          const safeFields = new Set(['operationId','operationRevision','staleForCurrentGoal','epoch','argsHash','expiresAt','automaticRedispatch','previousRevision','approvalsInvalidated','inFlightCannotBeRetracted','estimatedTokens','omittedMessages','tokenCounter','turn','model','scenario','reason','tool','evidenceCount','tools','responseRevision','resolution']);
          const exported = {format:'agent-revision-lab/incident-v1',version:'0.1.0-alpha.2',redaction:'Goal, prompts, tool inputs/results, reports and operator notes omitted. Identifiers and hashes retained. This is diagnostic metadata, not deterministic model replay.',run:{id,revision:detail.run.revision,status:detail.run.status,model:detail.run.model,scenario:detail.run.scenario},operations:detail.operations.map(o => ({id:o.id,revision:o.revision,state:o.state,argsHash:o.argsHash,attempts:o.attempts})),events:detail.events.map(e => ({...e,detail:Object.fromEntries(Object.entries(e.detail).filter(([k]) => safeFields.has(k)))}))};
          res.setHeader('content-disposition',`attachment; filename="incident-${id}.json"`);json(res,200,exported);return;
        }
      }
      if (path.startsWith('/api/')) throw new Missing('Endpoint not found');
      if (req.method !== 'GET' && req.method !== 'HEAD') { json(res,405,{error:'Method not allowed'});return; }
      const decoded = decodeURIComponent(path);
      const file = resolve(webRoot, '.' + (decoded === '/' ? '/index.html' : decoded));
      if (!file.startsWith(webRoot + sep)) throw new Missing('File not found');
      let data: Buffer;
      try { data = await readFile(file); } catch { throw new Missing('Workbench not built. Run npm run build.'); }
      const mime: Record<string,string> = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png'};
      res.writeHead(200,{'content-type':mime[extname(file)] ?? 'application/octet-stream','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'"});res.end(req.method==='HEAD'?undefined:data);
    } catch (e) {
      if (res.destroyed || res.headersSent) return;
      const status = e instanceof Invalid || e instanceof Conflict || e instanceof Missing ? e.statusCode : 500;
      json(res,status,{error:status===500 ? 'Request failed. Check the local server configuration.' : (e as Error).message});
    }
  });
  await new Promise<void>((resolve,reject) => {server.once('error',reject);server.listen(port,options.host ?? '127.0.0.1',resolve);});
  return {server,store,runtime,close:async () => {await new Promise<void>(r=>server.close(()=>r()));await store.close();await runtime.close();}};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const databaseUrl = process.env.DATABASE_URL; const internalToken = process.env.ARL_INTERNAL_TOKEN;
  if (!databaseUrl || !internalToken) throw new Error('Use npm run demo, or set DATABASE_URL and ARL_INTERNAL_TOKEN');
  const app = await startServer({databaseUrl,internalToken,port:Number(process.env.PORT ?? 4317),host:process.env.HOST ?? '127.0.0.1'});
  console.log(`Agent Revision Lab listening on port ${process.env.PORT ?? 4317}`);
  for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,()=>void app.close().then(()=>process.exit(0)));
}
