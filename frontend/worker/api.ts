// What's left of the server's HTTP API (its api.py, until commit 1c15be0) once the
// timetable is in the browser: walk and bike routes, which need a router and maybe its key.
// The Worker answers /api/* with this, and so does `npm run dev` (worker/vitePlugin.ts):
//
//   POST /api/route  {mode, origin, destination} -> RouteResult, as the server's /api/route:
//                    422 for a request it can't accept, 502 when the router fails.
//   GET  /api/info   {routing_provider}: what /api/health said about routing, for the footer.
//
// Errors are {"detail": ...} as FastAPI sent them. The settings come from the Worker's vars and
// secrets (see routing.ts); no key is ever logged or sent back.

import { readRouteRequest, RequestError } from './request';
import { ConfigError, makeProvider, RoutingError, type RoutingEnv, secrets } from './routing';

export type { RoutingEnv } from './routing';

/** What GET /api/info answers. */
export interface Info {
  routing_provider: string;
}

/**
 * The answer to a request for /api/something. `get` stands in for the network (the router's),
 * in tests.
 */
export async function handleApi(
  request: Request,
  env: RoutingEnv,
  get?: typeof fetch,
): Promise<Response> {
  const keys = secrets(env);
  const { pathname } = new URL(request.url);
  try {
    if (pathname === '/api/route') {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      // As the server did: the request is checked before anything else is.
      const req = await readRouteRequest(request);
      const router = makeProvider(env, get);
      try {
        return json(await router.route(req.mode, req.origin, req.destination));
      } catch (e) {
        if (e instanceof RoutingError) return json({ detail: redact(e.message, keys) }, 502);
        throw e;
      }
    }
    if (pathname === '/api/info') {
      if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed('GET');
      const info: Info = { routing_provider: makeProvider(env, get).name };
      return json(info);
    }
    return json({ detail: 'Not Found' }, 404);
  } catch (e) {
    if (e instanceof RequestError) return json({ detail: e.detail }, e.status);
    // Settings that won't make a router: the server wouldn't have started. Said, so that it
    // can be put right.
    if (e instanceof ConfigError) return json({ detail: e.message }, 500);
    const why = redact(String((e as Error)?.stack ?? e), keys);
    console.error(`${request.method} ${pathname}:`, why);
    return new Response('Internal Server Error', {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function methodNotAllowed(allow: string): Response {
  const headers = { Allow: allow };
  return Response.json({ detail: 'Method Not Allowed' }, { status: 405, headers });
}

/**
 * Text with the keys taken out, as they'd be written in a URL or in JSON: a router's error
 * could quote the request it was sent.
 */
export function redact(text: string, keys: string[]): string {
  for (const key of keys) {
    const inQuery = new URLSearchParams({ k: key }).toString().slice(2);
    const forms = [key, encodeURIComponent(key), inQuery, JSON.stringify(key).slice(1, -1)];
    for (const form of new Set(forms)) text = text.split(form).join('[redacted]');
  }
  return text;
}
