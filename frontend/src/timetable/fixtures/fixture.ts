// The timetable the tests read: conftest.py's synthetic feed and a few more trips, built and
// published as the real one is, with what the server answered on it (expected.json, frozen: see
// README.md here). Rebuild the timetable and manifest with
// `uv run python tests/frontend_fixture.py` in builder/.

import initSqlJs from 'sql.js';
import { downloadTimetable, openTimetable } from '../load';
import type { Manifest, Timetable } from '../timetable';
import manifestJson from './manifest.json';

export const manifest = manifestJson as Manifest;
export const BASE_URL = 'https://example.com/data/';

// The packed timetable, as a data: URL that fetch() reads in Node as in a browser.
const packed = import.meta.glob('./timetable-*.sqlite.gz', {
  query: '?inline',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** The bytes of the fixture's files, by name: the packed timetable and the manifest. */
export async function fixtureFile(name: string): Promise<Uint8Array<ArrayBuffer> | null> {
  if (name === 'manifest.json') return new TextEncoder().encode(JSON.stringify(manifest));
  const url = packed[`./${name}`];
  return url ? new Uint8Array(await (await fetch(url)).arrayBuffer()) : null;
}

/**
 * A fetch() serving the fixture as the site serves data/, in chunks of `chunk` bytes. It
 * records what was asked for, and how.
 */
export function fixtureFetch(chunk = 1024) {
  const requests: { url: string; cache?: RequestCache }[] = [];
  const get = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, cache: init?.cache });
    const bytes = url.startsWith(BASE_URL) ? await fixtureFile(url.slice(BASE_URL.length)) : null;
    if (!bytes) return new Response('Not found', { status: 404, statusText: 'Not Found' });
    return new Response(chunked(bytes, chunk));
  };
  return Object.assign(get as typeof fetch, { requests });
}

export function chunked(bytes: Uint8Array, chunk: number): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) controller.close();
      else controller.enqueue(bytes.slice(at, (at += chunk)));
    },
  });
}

/** The fixture, downloaded and opened as the page does it. */
export async function openFixture(): Promise<Timetable> {
  const sql = await initSqlJs({ useOldExtensionFunctions: false });
  const bytes = await downloadTimetable(BASE_URL, manifest, { fetch: fixtureFetch(65536) });
  return openTimetable(sql, bytes, manifest);
}
