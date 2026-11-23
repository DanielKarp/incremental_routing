// Getting the timetable: data/manifest.json names the current file (timetable-<hash>.sqlite.gz,
// a new name whenever the data changes), which is downloaded, unpacked as it arrives, checked
// against the manifest and opened with sql.js. Only web APIs are used (fetch, streams,
// DecompressionStream, crypto.subtle), so this runs in a page, a worker or Node 22; index.ts
// is the app's way in (from its worker, worker.ts), with sql.js's wasm from Vite.

import type { SqlJsStatic } from 'sql.js';
import { TimetableError } from './params';
import { type Manifest, SCHEMA_VERSION, Timetable } from './timetable';

export const MANIFEST = 'manifest.json';

/** How much of the timetable has arrived: bytes received, of `total`. */
export interface LoadProgress {
  loaded: number;
  total: number;
}

export interface DownloadOptions {
  fetch?: typeof fetch;
  /** Called as the timetable arrives (and once at the start, with nothing loaded). */
  onProgress?: (progress: LoadProgress) => void;
  signal?: AbortSignal;
}

// What a missing timetable means, and how to get one, as the server says it.
const REBUILD = 'Run `uv run ir-build-data` in backend/ (add --skip-download to reuse the feed).';

// Every SQLite database file starts with this.
const SQLITE_HEADER = 'SQLite format 3\0';

/**
 * The manifest in `baseUrl` (a folder URL, ending in "/"). Asked for afresh every time (it
 * names the newest timetable), though the browser may still revalidate a copy it has.
 */
export async function fetchManifest(
  baseUrl: string,
  { fetch: get = fetch, signal }: DownloadOptions = {},
): Promise<Manifest> {
  const url = `${baseUrl}${MANIFEST}`;
  let res: Response;
  try {
    res = await get(url, { cache: 'no-cache', signal });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new TimetableError(503, `Couldn't fetch ${url}: ${(e as Error).message}`);
  }
  if (!res.ok) {
    throw new TimetableError(503, `No timetable at ${url} (${statusText(res)}). ${REBUILD}`);
  }
  let manifest: Manifest;
  try {
    manifest = await res.json();
  } catch {
    throw new TimetableError(503, `${url} isn't a timetable manifest. ${REBUILD}`);
  }
  checkVersion(manifest.schema_version);
  return manifest;
}

/**
 * The manifest's timetable, unpacked: the SQLite file's bytes. The file is named by its
 * contents, so any copy the browser has kept is good; if one turns out damaged anyway, it is
 * downloaded once more, bypassing the cache.
 */
export async function downloadTimetable(
  baseUrl: string,
  manifest: Manifest,
  options: DownloadOptions = {},
): Promise<Uint8Array> {
  try {
    return await downloadOnce(baseUrl, manifest, options, 'default');
  } catch (e) {
    if (!(e instanceof Damaged)) throw e;
    return downloadOnce(baseUrl, manifest, options, 'reload');
  }
}

/** The timetable's SQLite bytes, opened with sql.js. */
export function openTimetable(sql: SqlJsStatic, bytes: Uint8Array, manifest: Manifest): Timetable {
  const db = new sql.Database(bytes);
  try {
    const version = db.exec('PRAGMA user_version')[0]?.values[0]?.[0];
    checkVersion(Number(version));
    return new Timetable(db, manifest);
  } catch (e) {
    db.close();
    throw e;
  }
}

/** A download that didn't give back the manifest's file. */
class Damaged extends TimetableError {}

async function downloadOnce(
  baseUrl: string,
  manifest: Manifest,
  { fetch: get = fetch, onProgress, signal }: DownloadOptions,
  cache: RequestCache,
): Promise<Uint8Array> {
  const { file, gzip_bytes, sqlite_bytes, sqlite_sha256 } = manifest.timetable;
  const url = `${baseUrl}${file}`;
  let res: Response;
  try {
    res = await get(url, { cache, signal });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new TimetableError(503, `Couldn't download ${url}: ${(e as Error).message}`);
  }
  if (!res.ok || !res.body) {
    throw new TimetableError(503, `Couldn't download ${url} (${statusText(res)}). ${REBUILD}`);
  }

  const reader = res.body.getReader();
  // A host may send the file with Content-Encoding: gzip, and the browser then unpacks it on
  // the way: only the data itself tells.
  const head: Uint8Array[] = [];
  let headBytes = 0;
  while (headBytes < 2) {
    const { done, value } = await reader.read();
    if (done) break;
    head.push(value);
    headBytes += value.length;
  }
  const first = concat(head, headBytes);
  const packed = first[0] === 0x1f && first[1] === 0x8b;
  const progress = { loaded: 0, total: packed ? gzip_bytes : sqlite_bytes };
  onProgress?.({ ...progress });
  const received = new ReadableStream<Uint8Array>({
    start(controller) {
      if (!first.length) return;
      progress.loaded += first.length;
      onProgress?.({ ...progress });
      controller.enqueue(first);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      progress.loaded += value.length;
      onProgress?.({ ...progress });
      controller.enqueue(value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
  const unpacked = packed
    ? received.pipeThrough(new DecompressionStream('gzip') as ReadableWritablePair<Uint8Array>)
    : received;

  let bytes: Uint8Array;
  try {
    bytes = await readAll(unpacked, sqlite_bytes);
  } catch (e) {
    if (signal?.aborted || e instanceof Damaged) throw e;
    throw new Damaged(503, `The timetable download was damaged: ${(e as Error).message}`);
  }
  if (new TextDecoder().decode(bytes.subarray(0, SQLITE_HEADER.length)) !== SQLITE_HEADER) {
    throw new Damaged(503, `${url} isn't a SQLite database.`);
  }
  // Pages served over plain HTTP (but for localhost) have no crypto.subtle; the size and the
  // header above are then all that's checked.
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
    if (hex(digest) !== sqlite_sha256) {
      throw new Damaged(503, `${url} doesn't match the manifest's checksum.`);
    }
  }
  return bytes;
}

/** Everything a stream gives, which should be exactly `size` bytes. */
async function readAll(stream: ReadableStream<Uint8Array>, size: number): Promise<Uint8Array> {
  const bytes = new Uint8Array(size);
  let length = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (length + value.length > size) {
      await reader.cancel();
      throw new Damaged(503, `The timetable is larger than the manifest's ${size} bytes.`);
    }
    bytes.set(value, length);
    length += value.length;
  }
  if (length !== size) {
    throw new Damaged(503, `The timetable has ${length} bytes, not the manifest's ${size}.`);
  }
  return bytes;
}

function checkVersion(version: unknown): void {
  if (version !== SCHEMA_VERSION) {
    throw new TimetableError(
      503,
      `The timetable is in a layout this version of the app doesn't read (version ${version},` +
        ` not ${SCHEMA_VERSION}). Reload the page; if that doesn't help, rebuild it. ${REBUILD}`,
    );
  }
}

function concat(chunks: Uint8Array[], length: number): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

function statusText(res: Response): string {
  return `${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
}

function hex(digest: ArrayBuffer): string {
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
