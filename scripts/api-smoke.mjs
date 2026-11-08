import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const base=process.env.ARL_E2E_URL ?? 'http://127.0.0.1:4317';
const target=new URL(base);
if(!['127.0.0.1','localhost'].includes(target.hostname))throw new Error('Smoke only writes to a disposable local demo');
async function req(path,body){const r=await fetch(base+path,{signal:AbortSignal.timeout(5000),...(body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});assert.ok(r.ok,`HTTP ${r.status}`);return r.json();}
async function until(id,status){for(let i=0;i<120;i++){const d=await req('/api/runs/'+id);if(d.run.status===status)return d;if(['FAILED','EXPIRED'].includes(d.run.status))throw new Error(`Run ${d.run.status}`);await new Promise(r=>setTimeout(r,250));}throw new Error('Run did not reach '+status);}
const {id}=await req('/api/runs',{goal:'Compare stable v1 and v2, exclude beta, and publish a cited report.',scenario:'lost-receipt',model:'scripted'});
const pending=await until(id,'WAITING_APPROVAL');
await req('/api/runs/'+id+'/commands',{kind:'approve',expectedRevision:1,commandId:randomUUID(),operationId:pending.operations[0].id});
const done=await until(id,'SUCCEEDED');assert.equal(done.reports.length,1);assert.equal(done.operations[0].attempts,1);assert.ok(done.events.some(e=>e.type==='operation.recovered'));
console.log('API and worker smoke passed: approved write, lost receipt lookup, one report, one dispatch.');
