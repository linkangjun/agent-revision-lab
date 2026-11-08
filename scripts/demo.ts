import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { localDatabase } from './local-db.js';
const db = process.env.DATABASE_URL ? undefined : await localDatabase();
const port = Number(process.env.PORT ?? 4317);
const env = {...process.env,DATABASE_URL:process.env.DATABASE_URL ?? db!.url,ARL_INTERNAL_TOKEN:process.env.ARL_INTERNAL_TOKEN ?? randomBytes(32).toString('hex'),ARL_API_URL:`http://127.0.0.1:${port}`,PORT:String(port)};
const children: ChildProcess[] = [];
let stopping=false;
async function stop(code=0) {
  if(stopping)return;stopping=true;
  for(const child of children) if(child.exitCode===null)child.kill('SIGTERM');
  await Promise.all(children.map(child=>child.exitCode!==null?undefined:new Promise<void>(res=>{child.once('exit',()=>res());setTimeout(()=>{child.kill('SIGKILL');res();},4000).unref();})));
  await db?.close();process.exit(code);
}
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>void stop());
function launch(file:string, extra:Record<string,string>={}) {const p=spawn(process.execPath,['--import','tsx',file],{stdio:'inherit',env:{...env,...extra}});children.push(p);p.once('error',()=>void stop(1));p.once('exit',code=>{if(!stopping)void stop(code??1);});return p;}
launch('src/server.ts');
let ready=false;
for(let i=0;i<150&&!stopping;i++) {try{if((await fetch(`http://127.0.0.1:${port}/api/health`)).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,200));}
if(!ready){console.error('API did not become ready');await stop(1);}else{
  launch('src/worker.ts',{ARL_EXECUTOR_ID:'lab-local'});
  console.log(`\nAgent Revision Lab: http://127.0.0.1:${port}\nScripted model; synthetic API evidence; local-only control.\n${db?'Ephemeral database: stopping this demo removes its data. Set DATABASE_URL for durable storage.':'Using supplied persistent database.'}\n`);
}
