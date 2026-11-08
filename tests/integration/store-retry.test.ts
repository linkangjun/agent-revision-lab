import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Store } from '../../src/store.js';
const url=process.env.ARL_TEST_DATABASE_URL;
describe.skipIf(!url)('atomic execution retry command',()=>{
  it('changes execution once, preserves domain state, and rolls back a failed enqueue',async()=>{
    const enqueues:string[]=[]; let fail=false;
    const store=new Store(url!,{
      async enqueueRun(id,c,executionId=id){ if(fail)throw new Error('Synthetic enqueue failure');expect(c).toBeDefined();enqueues.push(executionId); },
      async wakeRun(){},async workflowStatus(){return {status:'ERROR'};},
    });
    try{
      await store.init(); const run=await store.create({goal:'Synthetic retry contract'});
      fail=true;
      await expect(store.command(run.id,{kind:'retry',commandId:randomUUID(),expectedRevision:1})).rejects.toThrow('enqueue');
      expect((await store.get(run.id)).workflowId).toBe(run.id);
      fail=false;const command={kind:'retry' as const,commandId:randomUUID(),expectedRevision:1};
      const [a,b]=await Promise.all([store.command(run.id,command),store.command(run.id,command)]);
      expect(a.workflowId).not.toBe(run.id);expect(a.workflowId).toBe(b.workflowId);expect(enqueues).toHaveLength(2);
      expect(a.goal).toBe(run.goal);expect(a.revision).toBe(1);
      expect((await store.detail(run.id)).events.filter(e=>e.type==='execution.restarted')).toHaveLength(1);
    }finally{await store.close();}
  });
});
