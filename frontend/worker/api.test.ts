// The Worker's answers, as the server's: every request in fixtures/route.json got the recorded
// answer from the FastAPI server (POST /api/route, with its straight-line provider), and gets
// the same here. Keys are used, and never sent back or logged.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorDetail } from '../src/api';
import { handleApi, type RoutingEnv } from './api';
import recorded from './fixtures/route.json';

const URL_BASE = 'https://trips.example.com';
const STRAIGHT: RoutingEnv = { ROUTING_PROVIDER: 'straight-line' };
const WALK = {
  mode: 'walk',
  origin: { lat: 37.4, lon: -122.1 },
  destination: { lat: 37.41, lon: -122.1 },
};

function post(body: BodyInit | null, contentType: string | null = 'application/json') {
  return new Request(`${URL_BASE}/api/route`, {
    method: 'POST',
    headers: contentType === null ? {} : { 'Content-Type': contentType },
    body,
  });
}

async function answer(request: Request, env: RoutingEnv = STRAIGHT, get?: typeof fetch) {
  const res = await handleApi(request, env, get);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON; as text.
  }
  return { status: res.status, headers: res.headers, text, body };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/route answers as the server did', () => {
  it.each(recorded.requests.map((r): [string, (typeof recorded.requests)[number]] => [r.name, r]))(
    '%s',
    async (_, r) => {
      const body = Array.isArray(r.body) ? new Uint8Array(r.body as number[]) : r.body;
      // No Content-Type at all: a string body would have one made up for it.
      const sent =
        r.content_type === null && typeof body === 'string' ? new TextEncoder().encode(body) : body;
      const got = await answer(post(sent, r.content_type));
      expect(got.status).toBe(r.status);
      expect(got.body).toEqual(r.response);
      if (r.status !== 200) {
        // Which the app shows as the server's were shown.
        const detail = (r.response as { detail: unknown }).detail;
        expect(errorDetail((got.body as { detail: unknown }).detail)).toBe(errorDetail(detail));
      }
    },
  );

  it('says where JSON goes wrong, though in its own words', async () => {
    const got = await answer(post('{nope'));
    expect(got.status).toBe(422);
    expect(got.body).toEqual({
      detail: [
        {
          type: 'json_invalid',
          loc: ['body', 1],
          msg: 'JSON decode error',
          input: {},
          ctx: { error: expect.any(String) },
        },
      ],
    });
    expect(errorDetail((got.body as { detail: unknown }).detail)).toBe(
      'Invalid 1: JSON decode error.',
    );
  });

  it('refuses infinities, which the server let through to fail later', async () => {
    const huge = '{"mode": "walk", "origin": {"lat": 1e999, "lon": "-inf"}, "destination": {}}';
    const got = await answer(post(huge));
    expect(got.status).toBe(422);
    expect(errorDetail((got.body as { detail: unknown }).detail)).toBe(
      'Invalid origin.lat: input should be a finite number. ' +
        'Invalid origin.lon: input should be a finite number. ' +
        'Invalid destination.lat: field required. Invalid destination.lon: field required.',
    );
  });

  it('takes only POST', async () => {
    const got = await answer(new Request(`${URL_BASE}/api/route`));
    expect(got.status).toBe(405);
    expect(got.body).toEqual({ detail: 'Method Not Allowed' });
    expect(got.headers.get('Allow')).toBe('POST');
  });
});

describe('routes', () => {
  it('come from Valhalla by default, with heights for bike routes', async () => {
    const [route] = recorded.valhalla.filter((v) => v.mode === 'bike');
    const get = vi.fn(async () => Response.json(route.response)) as unknown as typeof fetch;
    const { mode, origin, destination } = route;
    const got = await answer(post(JSON.stringify({ mode, origin, destination })), {}, get);
    expect(got.status).toBe(200);
    expect(got.headers.get('Content-Type')).toMatch(/^application\/json/);
    expect(got.body).toEqual(route.result);
    expect(vi.mocked(get).mock.calls[0][0]).toBe('https://valhalla1.openstreetmap.de/route');
  });

  it("are a 502, saying why, when the router can't give one", async () => {
    const get = (async () => new Response('Failed to parse json request', { status: 400 })) as any;
    const got = await answer(post(JSON.stringify(WALK)), {}, get);
    expect(got.status).toBe(502);
    expect(got.body).toEqual({ detail: 'valhalla: HTTP 400: Failed to parse json request' });
  });

  it('are a 502 however the request to the router fails', async () => {
    const get = (async () => {
      throw 'not an Error';
    }) as any;
    const failed = await answer(post(JSON.stringify(WALK)), {}, get);
    expect(failed.status).toBe(502);
    expect(failed.body).toEqual({ detail: 'valhalla: request failed: not an Error' });
  });

  it('are a 500 when something unforeseen goes wrong, said as FastAPI said it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const get = (async () => ({
      text: async () => '',
      get status(): number {
        throw new Error('unforeseen');
      },
    })) as any;
    const failed = await answer(post(JSON.stringify(WALK)), {}, get);
    expect(failed.status).toBe(500);
    expect(failed.text).toBe('Internal Server Error');
    expect(error).toHaveBeenCalledOnce();
  });
});

describe('keys', () => {
  const VALHALLA = { VALHALLA_API_KEY: 'v4lh4lla-s3cret+/key' };
  const ORS = { ROUTING_PROVIDER: 'ors', ORS_API_KEY: '0rs-s3cret key"\\' };

  /** Everything a request's answer says, and everything logged meanwhile. */
  async function said(env: RoutingEnv, get: typeof fetch, request = post(JSON.stringify(WALK))) {
    const logged: unknown[] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args) => void logged.push(...args));
    }
    const got = await answer(request, env, get);
    const headers = JSON.stringify([...got.headers]);
    return { got, all: `${got.text} ${headers} ${JSON.stringify(logged.map(String))}` };
  }

  /** A router that sends back everything it was sent, as some do in their errors. */
  const echo = (status: number) =>
    (async (url: string, init: RequestInit) =>
      new Response(
        JSON.stringify({ url, headers: [...new Headers(init.headers)], body: init.body }),
        { status },
      )) as unknown as typeof fetch;

  it('are sent to the router, and never back', async () => {
    const get = vi.fn(echo(403));
    const valhalla = await said(VALHALLA, get as typeof fetch);
    expect(String(vi.mocked(get).mock.calls[0][0])).toContain('api_key=v4lh4lla-s3cret%2B%2Fkey');
    expect(valhalla.got.status).toBe(502);
    expect(valhalla.got.text).toContain('[redacted]');

    const ors = await said(ORS, echo(401));
    expect(ors.got.status).toBe(502);
    for (const key of [VALHALLA.VALHALLA_API_KEY, ORS.ORS_API_KEY]) {
      for (const form of [key, encodeURIComponent(key), JSON.stringify(key).slice(1, -1)]) {
        expect(valhalla.all).not.toContain(form);
        expect(ors.all).not.toContain(form);
      }
    }
  });

  it('are never in what a failed request says, or in the log', async () => {
    const leak = (async (url: string) => {
      throw new TypeError(`fetch failed for ${url}`);
    }) as unknown as typeof fetch;
    const { got, all } = await said(VALHALLA, leak);
    expect(got.status).toBe(502);
    expect(all).not.toContain('v4lh4lla');

    // Something unforeseen is logged, but not the key.
    const broken = (async (url: string) => ({
      text: async () => '',
      get status(): number {
        throw new Error(`unforeseen at ${url}`);
      },
    })) as unknown as typeof fetch;
    const unforeseen = await said(VALHALLA, broken);
    expect(unforeseen.got.status).toBe(500);
    expect(unforeseen.all).toContain('unforeseen at https://valhalla1.openstreetmap.de/route');
    expect(unforeseen.all).not.toContain('v4lh4lla');
  });

  it('are not said by /api/info', async () => {
    const { got, all } = await said(ORS, echo(200), new Request(`${URL_BASE}/api/info`));
    expect(got.body).toEqual({ routing_provider: 'ors' });
    expect(all).not.toContain('0rs-s3cret');
  });
});

describe('GET /api/info', () => {
  it('names the routing provider, as /api/health did', async () => {
    const info = (env: RoutingEnv) => answer(new Request(`${URL_BASE}/api/info`), env);
    expect((await info({})).body).toEqual({ routing_provider: 'valhalla' });
    expect((await info(STRAIGHT)).body).toEqual({ routing_provider: 'straight-line' });
  });

  it('says what is wrong with the settings, where the server would not have started', async () => {
    const env = { ROUTING_PROVIDER: 'ors' };
    const info = await answer(new Request(`${URL_BASE}/api/info`), env);
    expect(info.status).toBe(500);
    expect(info.body).toEqual({ detail: 'ROUTING_PROVIDER=ors requires ORS_API_KEY' });
    const route = await answer(post(JSON.stringify(WALK)), env);
    expect(route.status).toBe(500);
    expect(route.body).toEqual({ detail: 'ROUTING_PROVIDER=ors requires ORS_API_KEY' });
  });
});

describe('anything else under /api/', () => {
  it('is not found, as there', async () => {
    for (const path of ['/api/health', '/api/departures', '/api/nope']) {
      const got = await answer(new Request(`${URL_BASE}${path}`));
      expect(got.status).toBe(404);
      expect(got.body).toEqual({ detail: 'Not Found' });
    }
  });
});
