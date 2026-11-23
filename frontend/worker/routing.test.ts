// The routing providers, as the server's tests had them (backend/tests/test_routing.py), and
// real Valhalla answers read as the server's provider read them (fixtures/route.json, recorded
// from it).

import { describe, expect, it } from 'vitest';
import recorded from './fixtures/route.json';
import { decodePolyline } from './geo';
import {
  type LatLon,
  OrsProvider,
  type PathMode,
  RoutingError,
  StraightLineProvider,
  ValhallaProvider,
  makeProvider,
} from './routing';

const ORIGIN = { lat: 37.4, lon: -122.1 };
const DEST = { lat: 37.41, lon: -122.1 };

// The example from Google's polyline format documentation.
const GOOGLE_EXAMPLE = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';

interface Seen {
  url: string;
  init: RequestInit;
  headers: Headers;
  body: any;
}

/** A fetch() that answers with `answer`, and what it was asked. */
function mockFetch(answer: (seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const get = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const request = {
      url: String(input),
      init,
      headers: new Headers(init.headers),
      body: JSON.parse(String(init.body)),
    };
    seen.push(request);
    return answer(request);
  };
  return Object.assign(get as typeof fetch, { seen });
}

describe('decodePolyline', () => {
  it('decodes the documentation example', () => {
    const points = decodePolyline(GOOGLE_EXAMPLE);
    const expected = [
      [38.5, -120.2],
      [40.7, -120.95],
      [43.252, -126.453],
    ];
    points.forEach((p, k) => {
      expect(p[0]).toBeCloseTo(expected[k][0], 9);
      expect(p[1]).toBeCloseTo(expected[k][1], 9);
    });
  });

  it("won't read past a polyline that ends mid-point", () => {
    expect(() => decodePolyline(GOOGLE_EXAMPLE.slice(0, -1))).toThrow(RangeError);
  });
});

describe('ORS', () => {
  it('asks for the route with the key, and reads it', async () => {
    const get = mockFetch(() =>
      Response.json({
        features: [
          {
            geometry: {
              coordinates: [
                [-122.1, 37.4],
                [-122.1, 37.41],
              ],
            },
            properties: { summary: { distance: 1234.5, duration: 300.0 } },
          },
        ],
      }),
    );
    const result = await new OrsProvider('secret', get).route('bike', ORIGIN, DEST);
    const [{ url, headers, body }] = get.seen;
    expect(url).toMatch(/\/v2\/directions\/cycling-regular\/geojson$/);
    expect(headers.get('Authorization')).toBe('secret');
    expect(body).toEqual({
      coordinates: [
        [-122.1, 37.4],
        [-122.1, 37.41],
      ],
    });
    expect(result).toEqual({
      mode: 'bike',
      provider: 'ors',
      distance_m: 1234.5,
      duration_s: 300,
      geometry: [
        [-122.1, 37.4],
        [-122.1, 37.41],
      ],
      elevation_m: null,
      elevation_interval_m: null,
    });
  });

  it('counts a route without a summary as none at all, as ORS means it', async () => {
    const get = mockFetch(() =>
      Response.json({ features: [{ geometry: { coordinates: [] }, properties: {} }] }),
    );
    const result = await new OrsProvider('secret', get).route('walk', ORIGIN, ORIGIN);
    expect([result.distance_m, result.duration_s]).toEqual([0, 0]);
  });
});

function valhallaTrip(leg: Record<string, unknown>) {
  return {
    trip: { summary: { length: 0.1, time: 30.0 }, legs: [{ shape: GOOGLE_EXAMPLE, ...leg }] },
  };
}

describe('Valhalla', () => {
  it('asks for the route, with the key if there is one, and reads it', async () => {
    const get = mockFetch(() =>
      Response.json({
        trip: { summary: { length: 1.5, time: 1100.0 }, legs: [{ shape: GOOGLE_EXAMPLE }] },
      }),
    );
    const result = await new ValhallaProvider('https://example.test/route', 'k', get).route(
      'walk',
      ORIGIN,
      DEST,
    );
    const [{ url, init, headers, body }] = get.seen;
    expect(Object.fromEntries(new URL(url).searchParams)).toEqual({ api_key: 'k' });
    expect(init.method).toBe('POST');
    expect(headers.get('User-Agent')).toBe('incremental-routing/0.1 (personal trip planner)');
    expect(body.costing).toBe('pedestrian');
    expect(body.locations[0]).toEqual({ lat: 37.4, lon: -122.1 });
    expect([result.distance_m, result.duration_s]).toEqual([1500, 1100]);
    // Precision 6 and [lon, lat] order.
    expect(result.geometry[0][0]).toBeCloseTo(-12.02, 9);
    expect(result.geometry[0][1]).toBeCloseTo(3.85, 9);
  });

  it('leaves the key out when there is none', async () => {
    const get = mockFetch(() => Response.json(valhallaTrip({})));
    await new ValhallaProvider('https://example.test/route?x=1', null, get).route(
      'walk',
      ORIGIN,
      DEST,
    );
    expect(get.seen[0].url).toBe('https://example.test/route?x=1');
  });

  it('gives bike routes their heights', async () => {
    const get = mockFetch(() =>
      Response.json(valhallaTrip({ elevation_interval: 30.0, elevation: [3.9, 4.04, 12.0, 30.5] })),
    );
    const provider = new ValhallaProvider('https://example.test/route', null, get);
    const result = await provider.route('bike', ORIGIN, DEST);
    expect(get.seen[0].body.elevation_interval).toBe(30);
    expect(result.elevation_m).toEqual([3.9, 4.0, 12.0, 30.5]);
    expect(result.elevation_interval_m).toBe(30);

    const walk = await provider.route('walk', ORIGIN, DEST);
    expect(get.seen[1].body).not.toHaveProperty('elevation_interval');
    expect(walk.elevation_m).toBeNull();
  });

  it.each([
    ['a server without elevation tiles', {}],
    ['no heights', { elevation_interval: 30.0, elevation: [] }],
    ['too few for a profile', { elevation_interval: 30.0, elevation: [4.0] }],
    ['a gap', { elevation_interval: 30.0, elevation: [4.0, null, 6.0] }],
    ['a no-data value', { elevation_interval: 30.0, elevation: [4.0, -32768, 6.0] }],
    ['another spacing', { elevation_interval: 10.0, elevation: [4.0, 5.0] }],
  ])('leaves the heights out given %s', async (_, leg) => {
    const get = mockFetch(() => Response.json(valhallaTrip(leg)));
    const result = await new ValhallaProvider('https://example.test/route', null, get).route(
      'bike',
      ORIGIN,
      DEST,
    );
    expect([result.elevation_m, result.elevation_interval_m]).toEqual([null, null]);
  });

  it('joins the legs of a route where they meet', async () => {
    const two = {
      trip: {
        summary: { length: 1, time: 60 },
        legs: [{ shape: GOOGLE_EXAMPLE }, { shape: GOOGLE_EXAMPLE }],
      },
    };
    const get = mockFetch(() => Response.json(two));
    const result = await new ValhallaProvider('https://example.test/route', null, get).route(
      'walk',
      ORIGIN,
      DEST,
    );
    expect(result.geometry).toHaveLength(5);
  });

  describe.each(recorded.valhalla)('reads a real answer as the server did: $name', (route) => {
    it('asks the same, and makes the same route of the answer', async () => {
      const get = mockFetch(() => Response.json(route.response));
      const result = await new ValhallaProvider('https://example.test/route', null, get).route(
        route.mode as PathMode,
        route.origin as LatLon,
        route.destination as LatLon,
      );
      expect(get.seen[0].body).toEqual(route.request);
      expect(result).toEqual(route.result);
    });
  });
});

describe('when the router fails', () => {
  const route = (answer: () => Response | Promise<Response>) =>
    new ValhallaProvider('https://example.test/route', null, mockFetch(answer)).route(
      'walk',
      ORIGIN,
      DEST,
    );

  it('says what the router said, briefly', async () => {
    const said = 'ä'.repeat(400);
    const failed = route(() => new Response(said, { status: 400 }));
    await expect(failed).rejects.toThrow(RoutingError);
    await expect(failed).rejects.toThrow(`valhalla: HTTP 400: ${'ä'.repeat(300)}`);
    await expect(failed).rejects.not.toThrow('ä'.repeat(301));
  });

  it('takes no answer but 200 for a route, not even a redirect', async () => {
    const get = mockFetch(() => new Response('', { status: 302 }));
    const failed = new OrsProvider('k', get).route('walk', ORIGIN, DEST);
    await expect(failed).rejects.toThrow('ors: HTTP 302: ');
    expect(get.seen[0].init.redirect).toBe('manual');
  });

  it("says when it couldn't be reached, or didn't answer in time", async () => {
    await expect(
      route(() => {
        throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND') });
      }),
    ).rejects.toThrow('valhalla: request failed: fetch failed: getaddrinfo ENOTFOUND');
    await expect(
      route(() => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      }),
    ).rejects.toThrow('valhalla: request failed: timed out');
  });

  it.each([
    ['not JSON', () => new Response('<html>')],
    ['no trip', () => Response.json({ error: 'x' })],
    ['a shape that is not a polyline', () => Response.json(valhallaTrip({ shape: 5 }))],
    ['a polyline cut short', () => Response.json(valhallaTrip({ shape: '_p~iF~ps|' }))],
    ['no length', () => Response.json({ trip: { summary: {}, legs: [] } })],
  ])('says so when the answer is %s', async (_, answer) => {
    await expect(route(answer)).rejects.toThrow('valhalla: unexpected response shape');
  });

  it('says so when ORS sends no route', async () => {
    const get = mockFetch(() => Response.json({ features: [] }));
    await expect(new OrsProvider('k', get).route('walk', ORIGIN, DEST)).rejects.toThrow(
      'ors: unexpected response shape',
    );
  });
});

describe('the straight-line estimate', () => {
  it('allows for detours, at a walking pace', async () => {
    const result = await new StraightLineProvider().route('walk', ORIGIN, DEST);
    expect(result.distance_m / (1112 * 1.3)).toBeCloseTo(1, 2);
    expect(result.duration_s).toBeCloseTo(result.distance_m / 1.3, 9);
    expect(result.geometry).toEqual([
      [-122.1, 37.4],
      [-122.1, 37.41],
    ]);
  });
});

describe('makeProvider', () => {
  it('is Valhalla unless the settings say otherwise', () => {
    expect(makeProvider({}).name).toBe('valhalla');
    expect(makeProvider({ ROUTING_PROVIDER: ' ' }).name).toBe('valhalla');
    // An ORS key alone doesn't switch providers: Valhalla's bike times allow for hills.
    expect(makeProvider({ ORS_API_KEY: 'k' }).name).toBe('valhalla');
    expect(makeProvider({ ORS_API_KEY: 'k', ROUTING_PROVIDER: 'ORS' }).name).toBe('ors');
    expect(makeProvider({ ROUTING_PROVIDER: 'straight-line' }).name).toBe('straight-line');
    expect(() => makeProvider({ ROUTING_PROVIDER: 'ors' })).toThrow(
      'ROUTING_PROVIDER=ors requires ORS_API_KEY',
    );
    expect(() => makeProvider({ ROUTING_PROVIDER: 'osrm' })).toThrow(
      "Unknown ROUTING_PROVIDER 'osrm'",
    );
  });

  it('uses the public FOSSGIS server unless another is named', async () => {
    const get = mockFetch(() => Response.json(valhallaTrip({})));
    await makeProvider({}, get).route('walk', ORIGIN, DEST);
    await makeProvider({ VALHALLA_ROUTE_URL: 'https://api.stadiamaps.com/route/v1' }, get).route(
      'walk',
      ORIGIN,
      DEST,
    );
    expect(get.seen.map((s) => s.url)).toEqual([
      'https://valhalla1.openstreetmap.de/route',
      'https://api.stadiamaps.com/route/v1',
    ]);
  });
});
