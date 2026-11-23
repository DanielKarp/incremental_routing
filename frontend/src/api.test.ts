import initSqlJs from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CallQuery, type TimetableState, errorDetail } from './api';
import { BASE_URL, fixtureFetch, manifest, openFixture } from './timetable/fixtures/fixture';
import {
  type DownloadOptions,
  downloadTimetable,
  fetchManifest,
  openTimetable,
} from './timetable/load';
import { TimetableError } from './timetable/params';
import { type Ask, type Tell, serveTimetable } from './timetable/remote';
import type { Timetable } from './timetable/timetable';

describe('errorDetail', () => {
  it('passes a message through', () => {
    expect(errorDetail('No trip bayarea:1 on 2026-10-12')).toBe('No trip bayarea:1 on 2026-10-12');
  });

  it('names the fields a request got wrong', () => {
    // What FastAPI sent for /api/departures?time=202609-10-20T09:00&radius_m=5000.
    const detail = [
      {
        type: 'datetime_from_date_parsing',
        loc: ['query', 'time'],
        msg: 'Input should be a valid datetime or date, invalid date separator, expected `-`',
        input: '202609-10-20T09:00',
      },
      {
        type: 'less_than_equal',
        loc: ['query', 'radius_m'],
        msg: 'Input should be less than or equal to 3000',
        input: '5000',
        ctx: { le: 3000 },
      },
    ];
    expect(errorDetail(detail)).toBe(
      'Invalid time: input should be a valid datetime or date, invalid date separator, ' +
        'expected `-`. Invalid radius_m: input should be less than or equal to 3000.',
    );
  });

  it('names nested fields, and the request when no field is given', () => {
    expect(errorDetail([{ loc: ['body', 'origin', 'lat'], msg: 'Field required' }])).toBe(
      'Invalid origin.lat: field required.',
    );
    expect(errorDetail([{ loc: ['body'], msg: 'JSON decode error' }])).toBe(
      'Invalid request: JSON decode error.',
    );
  });

  it('falls back to JSON for anything else', () => {
    expect(errorDetail({ code: 7 })).toBe('{"code":7}');
    expect(errorDetail([1, 2])).toBe('[1,2]');
  });
});

// --- The timetable behind the transit queries ---------------------------------------------------
// The app keeps it in a Web Worker; here a stand-in for one runs the worker's own end
// (serveTimetable) on the test timetable, passing messages as copies, a moment later, as a
// worker would.

const DEPARTURES: CallQuery = {
  point: { lat: 37.4, lon: -122.1 },
  time: '2026-10-12T07:50',
  radiusM: 500,
};

/** The test timetable, loaded as the worker loads the real one, a kilobyte at a time. */
async function loadFixture(options: DownloadOptions): Promise<Timetable> {
  const sql = await initSqlJs({ useOldExtensionFunctions: false });
  const got = await fetchManifest(BASE_URL, { ...options, fetch: fixtureFetch() });
  const bytes = await downloadTimetable(BASE_URL, got, { ...options, fetch: fixtureFetch(1000) });
  return openTimetable(sql, bytes, got);
}

let load: (options: DownloadOptions) => Promise<Timetable>;
let workers: StandInWorker[];

class StandInWorker extends EventTarget {
  terminated = false;
  private readonly answer: (message: Ask) => void;

  constructor(
    readonly url: URL,
    readonly options: WorkerOptions,
  ) {
    super();
    workers.push(this);
    this.answer = serveTimetable(load, (message) => this.later(() => this.tell(message)));
  }

  postMessage(message: Ask) {
    const copy = structuredClone(message);
    this.later(() => this.answer(copy));
  }

  terminate() {
    this.terminated = true;
  }

  tell(message: Tell) {
    this.dispatchEvent(new MessageEvent('message', { data: structuredClone(message) }));
  }

  private later(then: () => void) {
    setTimeout(() => this.terminated || then());
  }
}

// For the test timetable's file, which is a data: URL.
const realFetch = globalThis.fetch;

/** A fresh api.ts, with nothing loaded yet; and what /api/info says. */
async function freshApi(
  info: () => Response = () => Response.json({ routing_provider: 'valhalla' }),
) {
  vi.resetModules();
  const answer = async (url: string, init?: RequestInit) =>
    url === '/api/info' ? info() : realFetch(url, init);
  vi.stubGlobal('fetch', vi.fn(answer));
  return import('./api');
}

describe('the transit queries', () => {
  let timetable: Timetable;
  beforeAll(async () => {
    timetable = await openFixture();
  });
  beforeEach(() => {
    load = loadFixture;
    workers = [];
    vi.stubGlobal('Worker', StandInWorker);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('are answered by the timetable, in its worker, as it answers them', async () => {
    const { api } = await freshApi();
    expect(await api.feeds()).toEqual(timetable.feeds());
    expect(await api.nearbyStops({ lat: 37.43, lon: -122.1 }, 200)).toEqual(
      timetable.nearbyStops({ lat: 37.43, lon: -122.1 }, 200),
    );
    expect(await api.departures(DEPARTURES)).toEqual(timetable.departures(DEPARTURES));
    const back = { ...DEPARTURES, point: { lat: 37.43, lon: -122.1 }, time: '2026-10-12T08:30' };
    expect(await api.arrivals(back)).toEqual(timetable.arrivals(back));
    expect(await api.trip('tr:T_MORNING', '2026-10-12')).toEqual(
      timetable.trip('tr:T_MORNING', '2026-10-12'),
    );
    const trips = [
      { trip_id: 'tr:T_MORNING', stop_sequence: 2 },
      { trip_id: 'tr:T_BUS', stop_sequence: 1 },
    ];
    expect(await api.lines('forward', trips)).toEqual(timetable.lines('forward', trips));
    expect((await api.departures(DEPARTURES)).length).toBeGreaterThan(0);
  });

  it('share one timetable, loaded once, in a module worker', async () => {
    const { api } = await freshApi();
    await Promise.all([api.feeds(), api.departures(DEPARTURES), api.health()]);
    await api.trip('tr:T_MORNING', '2026-10-12');
    expect(workers).toHaveLength(1);
    expect(workers[0].url.pathname).toMatch(/\/timetable\/worker\.ts$/);
    expect(workers[0].options).toEqual({ type: 'module' });
  });

  it('fail as the server failed: with its status and message', async () => {
    const { api, ApiError } = await freshApi();
    const unknown = api.trip('tr:NOPE', '2026-10-12');
    await expect(unknown).rejects.toBeInstanceOf(ApiError);
    await expect(unknown).rejects.toMatchObject({ status: 404, message: "Unknown trip 'tr:NOPE'" });
    await expect(api.departures({ ...DEPARTURES, radiusM: 5000 })).rejects.toMatchObject({
      status: 422,
      message: 'Invalid radius_m: input should be less than or equal to 3000.',
    });
  });

  it('say how the loading goes, then that the timetable is ready', async () => {
    const { api, timetableState } = await freshApi();
    const states: TimetableState[] = [];
    timetableState.subscribe(() => states.push(timetableState.get()));
    expect(timetableState.get()).toEqual({ status: 'loading', progress: null });
    await api.feeds();
    expect(states.at(-1)).toEqual({ status: 'ready' });
    const progress = states.flatMap((s) => (s.status === 'loading' && s.progress) || []);
    const total = manifest.timetable.gzip_bytes;
    expect(progress[0]).toEqual({ loaded: 0, total });
    expect(progress.at(-1)).toEqual({ loaded: total, total });
    expect(progress.length).toBeGreaterThan(3);
  });

  it('say why the timetable could not be had, and try again when asked', async () => {
    const why = 'No timetable at /data/manifest.json (404 Not Found). Run `uv run ir-build-data`.';
    load = async () => {
      throw new TimetableError(503, why);
    };
    const { api, ApiError, timetableState } = await freshApi();
    const failed = api.departures(DEPARTURES);
    await expect(failed).rejects.toBeInstanceOf(ApiError);
    await expect(failed).rejects.toMatchObject({ status: 503, message: why });
    expect(timetableState.get()).toEqual({ status: 'failed', reason: why });
    expect(await api.health()).toEqual({
      status: 'ok',
      gtfs_loaded: false,
      gtfs_problem: why,
      routing_provider: 'valhalla',
    });
    expect(workers.every((w) => w.terminated)).toBe(true);

    // Try again.
    load = loadFixture;
    timetableState.load();
    expect(timetableState.get()).toEqual({ status: 'loading', progress: null });
    expect(await api.departures(DEPARTURES)).toHaveLength(1);
    expect(timetableState.get()).toEqual({ status: 'ready' });
    expect(workers).toHaveLength(3);
  });

  it('start again if the worker fails once loaded', async () => {
    const { api, timetableState } = await freshApi();
    await api.feeds();
    const asked = api.departures(DEPARTURES);
    // As a worker's ErrorEvent says it (Node has no ErrorEvent).
    workers[0].dispatchEvent(Object.assign(new Event('error'), { message: 'out of memory' }));
    await expect(asked).rejects.toMatchObject({
      status: 503,
      message: "The timetable couldn't be opened: out of memory",
    });
    expect(timetableState.get()).toMatchObject({ status: 'failed' });
    expect(await api.departures(DEPARTURES)).toHaveLength(1);
    expect(workers).toHaveLength(2);
  });

  it('refuse anything but the queries', async () => {
    const posted: Tell[] = [];
    const answer = serveTimetable(loadFixture, (message) => posted.push(message));
    answer({ id: 7, method: 'close' as never, args: [] });
    await vi.waitFor(() => expect(posted.at(-1)?.type).toBe('refused'));
    expect(posted.at(-1)).toEqual({
      type: 'refused',
      id: 7,
      error: { message: 'No such query: close' },
    });
  });
});

describe('health', () => {
  beforeEach(() => {
    load = loadFixture;
    workers = [];
    vi.stubGlobal('Worker', StandInWorker);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('says the timetable is in, and which router the Worker uses', async () => {
    const { api } = await freshApi(() => Response.json({ routing_provider: 'straight-line' }));
    expect(await api.health()).toEqual({
      status: 'ok',
      gtfs_loaded: true,
      gtfs_problem: null,
      routing_provider: 'straight-line',
    });
  });

  it("fails as it did when the Worker can't say", async () => {
    const detail = 'ROUTING_PROVIDER=ors requires ORS_API_KEY';
    const { api, ApiError } = await freshApi(() => Response.json({ detail }, { status: 500 }));
    const health = api.health();
    await expect(health).rejects.toBeInstanceOf(ApiError);
    await expect(health).rejects.toMatchObject({ status: 500, message: detail });
  });
});

describe('route', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks the site's Worker, and says why it refused as the server said it", async () => {
    const { api } = await import('./api');
    const get = vi.fn(async () =>
      Response.json(
        { detail: [{ type: 'missing', loc: ['body', 'origin', 'lat'], msg: 'Field required' }] },
        { status: 422 },
      ),
    );
    vi.stubGlobal('fetch', get);
    const origin = { lat: 37.4, lon: -122.1 };
    await expect(api.route('walk', origin, origin)).rejects.toMatchObject({
      status: 422,
      message: 'Invalid origin.lat: field required.',
    });
    expect(get).toHaveBeenCalledWith('/api/route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'walk', origin, destination: origin }),
    });
  });
});
