// The timetable in a Web Worker (worker.ts), so that the page never waits on it: opening it, or
// listing every departure within 3 km downtown (a tenth of a second on a fast computer), would
// otherwise hold up scrolling and typing meanwhile. Both ends of the conversation are here:
// serveTimetable() in the worker, openRemoteTimetable() in the page. The answers are the
// Timetable's own, copied across; so are its errors, status and all.

import type { DownloadOptions, LoadProgress } from './load';
import { TimetableError } from './params';
import type { Timetable } from './timetable';

/** The queries the page may ask. */
export type Queries = Pick<
  Timetable,
  'health' | 'feeds' | 'nearbyStops' | 'departures' | 'arrivals' | 'trip' | 'lines'
>;
export type Method = keyof Queries;
const METHODS = new Set<string>([
  'health',
  'feeds',
  'nearbyStops',
  'departures',
  'arrivals',
  'trip',
  'lines',
] satisfies Method[]);

/** An error, as it crosses: a TimetableError keeps its status. */
interface ErrorInfo {
  message: string;
  status?: number;
}

/** What the page sends: a query. */
export interface Ask {
  id: number;
  method: Method;
  args: unknown[];
}

/** What the worker sends: how loading goes, then the answers to queries. */
export type Tell =
  | { type: 'progress'; progress: LoadProgress }
  | { type: 'ready' }
  | { type: 'failed'; error: ErrorInfo }
  | { type: 'answer'; id: number; result: unknown }
  | { type: 'refused'; id: number; error: ErrorInfo };

function errorInfo(e: unknown): ErrorInfo {
  const message = e instanceof Error ? e.message : String(e);
  return e instanceof TimetableError ? { message, status: e.status } : { message };
}

function revive({ message, status }: ErrorInfo): Error {
  return status === undefined ? new Error(message) : new TimetableError(status, message);
}

/**
 * The worker's end: loads the timetable with `load` (saying how that goes), then answers each
 * query `post`ed to it. Returns what to do with each message from the page.
 */
export function serveTimetable(
  load: (options: DownloadOptions) => Promise<Timetable>,
  post: (message: Tell) => void,
): (message: Ask) => void {
  const opened = load({ onProgress: (progress) => post({ type: 'progress', progress }) });
  opened.then(
    () => post({ type: 'ready' }),
    (e) => post({ type: 'failed', error: errorInfo(e) }),
  );
  return ({ id, method, args }) => {
    opened.then(
      (t) => {
        try {
          if (!METHODS.has(method)) throw new Error(`No such query: ${method}`);
          const ask = t[method] as (...args: unknown[]) => unknown;
          post({ type: 'answer', id, result: ask.apply(t, args) });
        } catch (e) {
          post({ type: 'refused', id, error: errorInfo(e) });
        }
      },
      () => {}, // The page was told.
    );
  };
}

/** What the page needs of a Worker (and tests can stand in for). */
export interface WorkerLike {
  postMessage(message: Ask): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<Tell>) => void): void;
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  terminate(): void;
}

export interface RemoteTimetable {
  /** Settles once the timetable is open, or can't be had (and then says why). */
  ready: Promise<void>;
  /** A query, answered as the Timetable answers it, or refused with its error. */
  call<M extends Method>(
    method: M,
    ...args: Parameters<Queries[M]>
  ): Promise<ReturnType<Queries[M]>>;
}

interface Callbacks {
  onProgress: (progress: LoadProgress) => void;
  /** The timetable can't be used, from now on: it couldn't be had, or the worker failed. */
  onFailure: (error: Error) => void;
}

/** The page's end, talking to the worker `worker` runs. */
export function openRemoteTimetable(
  worker: WorkerLike,
  { onProgress, onFailure }: Callbacks,
): RemoteTimetable {
  const pending = new Map<number, { resolve: (x: any) => void; reject: (e: Error) => void }>();
  let asked = 0;
  let failure: Error | null = null;
  let opened: (() => void) | undefined;
  let refused: ((e: Error) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    opened = resolve;
    refused = reject;
  });

  const fail = (error: Error) => {
    if (failure) return;
    failure = error;
    worker.terminate();
    refused!(error);
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
    onFailure(error);
  };

  worker.addEventListener('message', ({ data }) => {
    if (failure) return;
    if (data.type === 'progress') onProgress(data.progress);
    else if (data.type === 'ready') opened!();
    else if (data.type === 'failed') fail(revive(data.error));
    else {
      const asker = pending.get(data.id);
      pending.delete(data.id);
      if (data.type === 'answer') asker?.resolve(data.result);
      else asker?.reject(revive(data.error));
    }
  });
  worker.addEventListener('error', (event) => {
    const why = event.message || "its worker didn't start";
    fail(new TimetableError(503, `The timetable couldn't be opened: ${why}`));
  });

  return {
    ready,
    call(method, ...args) {
      return new Promise((resolve, reject) => {
        if (failure) return reject(failure);
        const id = asked++;
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, method, args });
      });
    },
  };
}
