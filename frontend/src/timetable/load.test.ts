import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { BASE_URL, chunked, fixtureFetch, fixtureFile, manifest } from './fixtures/fixture';
import {
  type LoadProgress,
  MANIFEST,
  downloadTimetable,
  fetchManifest,
  openTimetable,
} from './load';
import { TimetableError } from './params';
import type { Manifest } from './timetable';

const timetableUrl = `${BASE_URL}${manifest.timetable.file}`;

async function unpacked(): Promise<Uint8Array> {
  const packed = await fixtureFile(manifest.timetable.file);
  const stream = new Response(packed).body!.pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe('fetchManifest', () => {
  it('asks for the manifest afresh each time', async () => {
    const get = fixtureFetch();
    expect(await fetchManifest(BASE_URL, { fetch: get })).toEqual(manifest);
    expect(get.requests).toEqual([{ url: `${BASE_URL}${MANIFEST}`, cache: 'no-cache' }]);
  });

  it('says how to build a timetable when there is none', async () => {
    const missing = fetchManifest('https://example.com/elsewhere/', { fetch: fixtureFetch() });
    await expect(missing).rejects.toThrow(TimetableError);
    await expect(missing).rejects.toMatchObject({ status: 503 });
    await expect(missing).rejects.toThrow(/No timetable at .*manifest\.json \(404 Not Found\)/);
    await expect(missing).rejects.toThrow('uv run ir-build-data');
  });

  it("won't read a timetable laid out for another version of the app", async () => {
    const newer = { ...manifest, schema_version: 2 };
    const get = (async () => Response.json(newer)) as typeof fetch;
    await expect(fetchManifest(BASE_URL, { fetch: get })).rejects.toThrow(
      "a layout this version of the app doesn't read (version 2, not 1)",
    );
  });
});

describe('downloadTimetable', () => {
  it('unpacks the timetable as it arrives, and says how much has', async () => {
    const get = fixtureFetch(1000);
    const progress: LoadProgress[] = [];
    const bytes = await downloadTimetable(BASE_URL, manifest, {
      fetch: get,
      onProgress: (p) => progress.push(p),
    });
    expect(bytes).toEqual(await unpacked());
    expect(bytes.length).toBe(manifest.timetable.sqlite_bytes);
    // Its name changes with its contents, so the browser may keep it as long as it likes.
    expect(get.requests).toEqual([{ url: timetableUrl, cache: 'default' }]);
    const total = manifest.timetable.gzip_bytes;
    expect(progress[0]).toEqual({ loaded: 0, total });
    expect(progress.at(-1)).toEqual({ loaded: total, total });
    // One report per chunk of 1000 bytes, each further on.
    expect(progress.length).toBe(1 + Math.ceil(total / 1000));
    expect(progress.every((p, k) => k === 0 || p.loaded > progress[k - 1].loaded)).toBe(true);
  });

  it('takes the timetable already unpacked, when the host sent it gzip-encoded', async () => {
    const plain = await unpacked();
    const get = (async () => new Response(chunked(plain, 4096))) as typeof fetch;
    const progress: LoadProgress[] = [];
    const bytes = await downloadTimetable(BASE_URL, manifest, {
      fetch: get,
      onProgress: (p) => progress.push(p),
    });
    expect(bytes).toEqual(plain);
    const total = manifest.timetable.sqlite_bytes;
    expect(progress.at(-1)).toEqual({ loaded: total, total });
  });

  it('downloads a damaged timetable again, past the cache', async () => {
    const good = fixtureFetch();
    const requests: (RequestCache | undefined)[] = [];
    const get = (async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init?.cache);
      if (requests.length > 1) return good(url, init);
      const packed = (await fixtureFile(manifest.timetable.file))!;
      return new Response(packed.subarray(0, packed.length - 100)); // cut short
    }) as typeof fetch;
    expect(await downloadTimetable(BASE_URL, manifest, { fetch: get })).toEqual(await unpacked());
    expect(requests).toEqual(['default', 'reload']);
  });

  it("gives up on a timetable that isn't the manifest's", async () => {
    const other: Manifest = {
      ...manifest,
      timetable: { ...manifest.timetable, sqlite_sha256: '0'.repeat(64) },
    };
    const get = fixtureFetch();
    const failed = downloadTimetable(BASE_URL, other, { fetch: get });
    await expect(failed).rejects.toThrow("doesn't match the manifest's checksum");
    await expect(failed).rejects.toMatchObject({ status: 503 });
    expect(get.requests.length).toBe(2);
    const shorter = { ...manifest, timetable: { ...manifest.timetable, sqlite_bytes: 1000 } };
    await expect(downloadTimetable(BASE_URL, shorter, { fetch: fixtureFetch() })).rejects.toThrow(
      "larger than the manifest's 1000 bytes",
    );
  });

  it('reports a timetable that is missing', async () => {
    const gone = { ...manifest, timetable: { ...manifest.timetable, file: 'timetable-0.gz' } };
    await expect(downloadTimetable(BASE_URL, gone, { fetch: fixtureFetch() })).rejects.toThrow(
      /Couldn't download .*timetable-0\.gz \(404 Not Found\)/,
    );
  });
});

describe('openTimetable', () => {
  it('opens the unpacked bytes with sql.js', async () => {
    const sql = await initSqlJs({ useOldExtensionFunctions: false });
    const timetable = openTimetable(sql, await unpacked(), manifest);
    expect(timetable.health()).toEqual({ status: 'ok', gtfs_loaded: true, gtfs_problem: null });
    expect(timetable.feeds()).toEqual(manifest.feeds);
    timetable.close();
  });

  it('checks the layout version in the file too', async () => {
    const sql = await initSqlJs({ useOldExtensionFunctions: false });
    const db = new sql.Database(await unpacked());
    db.exec('PRAGMA user_version = 7');
    const bytes = db.export();
    db.close();
    expect(() => openTimetable(sql, bytes, manifest)).toThrow('(version 7, not 1)');
  });
});
