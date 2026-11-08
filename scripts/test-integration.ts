import { spawn } from 'node:child_process';
import { localDatabase } from './local-db.js';
const owned = process.env.ARL_TEST_DATABASE_URL ? undefined : await localDatabase();
const child = spawn(process.execPath,['node_modules/vitest/vitest.mjs','run','tests/integration','--no-file-parallelism',...process.argv.slice(2)],{stdio:'inherit',env:{...process.env,ARL_TEST_DATABASE_URL:process.env.ARL_TEST_DATABASE_URL ?? owned!.url}});
let stopping = false;
async function stop() {if(stopping)return;stopping=true;child.kill('SIGTERM');await owned?.close();}
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>void stop());
const code = await new Promise<number>(res=>{child.once('error',()=>res(1));child.once('exit',c=>res(c??1));});
// embedded-postgres installs a beforeExit hook that otherwise replaces a failed exit code with zero.
await owned?.close();process.exit(code);
