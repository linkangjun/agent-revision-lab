import { useEffect, useState } from 'react';

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const message = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
      ? body.error : 'Request failed';
    throw new Error(`${message} (${response.status})`);
  }
  return await response.json() as T;
}

export function post<T>(path: string, body: unknown, signal?: AbortSignal) {
  return api<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
}

export const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Request failed';

export function usePolling<T>(path: string, refresh = 0, paused = false) {
  const [value, setValue] = useState<T>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (paused) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const result = await api<T>(path, { signal: controller.signal });
        if (!controller.signal.aborted) { setValue(result); setError(undefined); }
      } catch (cause) {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(load, 2000);
      }
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [path, refresh, paused]);
  return { value, error };
}
