// The timetable in the app: downloaded from the site's data/ folder (the manifest first, then
// the file it names), and opened with sql.js, whose wasm Vite serves next to the app. The app
// keeps it in a Web Worker (worker.ts, remote.ts).

import initSqlJs from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm-browser.wasm?url';
import { type DownloadOptions, downloadTimetable, fetchManifest, openTimetable } from './load';
import type { Timetable } from './timetable';

export type { DownloadOptions, LoadProgress } from './load';
export { downloadTimetable, fetchManifest, openTimetable } from './load';
export { TimetableError } from './params';
export { type Manifest, SCHEMA_VERSION, Timetable } from './timetable';

/** Where `uv run ir-build-data` puts the manifest and timetable: public/data, served as data/. */
export const DATA_URL = `${import.meta.env.BASE_URL}data/`;

/**
 * Download the timetable and open it. Rejects with a TimetableError (status 503) when there
 * is none to be had, or it can't be read; its message says why, as /api/health's gtfs_problem
 * did.
 */
export async function loadTimetable(
  options: DownloadOptions & { baseUrl?: string } = {},
): Promise<Timetable> {
  const { baseUrl = DATA_URL } = options;
  // The wasm compiles while the timetable downloads. The queries need none of sql.js's old
  // extension functions, only SQLite's own.
  const sql = initSqlJs({ locateFile: () => wasmUrl, useOldExtensionFunctions: false });
  // Not left unhandled if the download fails first.
  sql.catch(() => {});
  const manifest = await fetchManifest(baseUrl, options);
  const bytes = await downloadTimetable(baseUrl, manifest, options);
  return openTimetable(await sql, bytes, manifest);
}
