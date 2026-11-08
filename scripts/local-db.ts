import EmbeddedPostgres from 'embedded-postgres';
import { mkdir, mkdtemp, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';

export async function freePort(): Promise<number> {
  const s = createServer(); await new Promise<void>((res,rej)=>{s.once('error',rej);s.listen(0,'127.0.0.1',res);});
  const p = (s.address() as {port:number}).port; await new Promise<void>(res=>s.close(()=>res()));return p;
}
export async function localDatabase() {
  // Ephemeral dedicated cluster. Existing databases and host configuration are never changed.
  await mkdir('.local',{recursive:true});
  const dir = await mkdtemp(resolve('.local','test-pg-')); const port = await freePort();
  const password = randomBytes(24).toString('hex');
  const cluster = new EmbeddedPostgres({databaseDir:dir,port,user:'postgres',password,persistent:false,authMethod:'scram-sha-256',postgresFlags:['-h','127.0.0.1'],onLog:()=>{},onError:()=>{}});
  await cluster.initialise(); await cluster.start(); await cluster.createDatabase('agent_revision_lab');
  return {url:`postgresql://postgres:${password}@127.0.0.1:${port}/agent_revision_lab`,close:()=>cluster.stop()};
}
