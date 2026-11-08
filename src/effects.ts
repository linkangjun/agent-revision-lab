import type { Effects } from './engine.js';
import type { Operation } from './contracts.js';
import { retryRead, TransientError } from './core.js';
export function httpEffects(baseUrl: string, token: string): Effects {
  const headers = { 'content-type': 'application/json', 'x-lab-internal-token': token };
  return {
    async publish(operation: Operation, signal: AbortSignal) {
      // An unconfirmed write must be looked up, never retried here.
      const r = await fetch(new URL('/internal/reports', baseUrl), { method: 'POST', headers, body: JSON.stringify({ operation }), signal, redirect: 'error' });
      if (!r.ok) throw new Error('External report service did not confirm the write');
      return r.json();
    },
    async lookup(operation: Operation, signal: AbortSignal) {
      return retryRead(async () => {
        let r: Response;
        try { r = await fetch(new URL('/internal/reports/' + encodeURIComponent(operation.id), baseUrl), { headers, signal, redirect: 'error' }); }
        catch { signal.throwIfAborted(); throw new TransientError('Report lookup transport failed'); }
        if (r.status === 429 || r.status >= 500) {
          const value=r.headers.get('retry-after');
          const delay=value ? (/^\d+(\.\d+)?$/.test(value) ? Number(value)*1000 : Math.max(0,Date.parse(value)-Date.now())) : undefined;
          throw new TransientError('Report lookup temporarily unavailable',delay!==undefined && Number.isFinite(delay) ? delay : undefined);
        }
        if (!r.ok) throw new Error('External report lookup rejected');
        const data=await r.json();
        return data as {found:boolean;result?:unknown};
      }, {maxAttempts:3,baseDelayMs:100,maxDelayMs:2000,signal});
    },
  };
}
