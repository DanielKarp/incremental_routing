// `npm run dev` without the Worker or wrangler: /api/* is answered by the Worker's own handler
// (api.ts, loaded through Vite, so a change to it applies at once), with the settings `wrangler
// dev` would give it: wrangler.jsonc's vars, then .dev.vars, then the environment
// (`ROUTING_PROVIDER=straight-line npm run dev`). It also says when there's no timetable to
// serve, rather than letting the page have the app's index.html in its place.

import { existsSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import type { Connect, Logger, Plugin, ViteDevServer } from 'vite';
import type { RoutingEnv } from './api.ts';

const SETTINGS = ['ROUTING_PROVIDER', 'VALHALLA_ROUTE_URL', 'VALHALLA_API_KEY', 'ORS_API_KEY'];

export function workerApi(): Plugin {
  let root = '';
  let publicDir = '';
  return {
    name: 'incremental-routing:worker-api',
    configResolved(config) {
      root = config.root;
      publicDir = config.publicDir;
    },
    configureServer(server) {
      // Not for vitest, whose tests have their own timetable.
      if (!process.env.VITEST) warnIfNoTimetable(publicDir, server.config.logger);
      server.middlewares.use(serveApi(server, root));
      server.middlewares.use(noTimetable(publicDir));
    },
  };
}

function serveApi(server: ViteDevServer, root: string): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (!req.url?.startsWith('/api/')) return next();
    answer(server, req, res, root).catch((e) => {
      console.error(e);
      if (!res.headersSent) res.statusCode = 500;
      res.end('Internal Server Error');
    });
  };
}

async function answer(
  server: ViteDevServer,
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
): Promise<void> {
  const api = (await server.ssrLoadModule('/worker/api.ts')) as typeof import('./api.ts');
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (name.startsWith(':') || value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  const method = req.method ?? 'GET';
  const request = new Request(new URL(req.url!, `http://${req.headers.host ?? 'localhost'}`), {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : Buffer.concat(chunks),
  });
  const response = await api.handleApi(request, settings(root));
  res.statusCode = response.status;
  response.headers.forEach((value, name) => res.setHeader(name, value));
  res.end(Buffer.from(await response.arrayBuffer()));
}

/** The Worker's settings as `wrangler dev` would have them, and the environment's over those. */
function settings(root: string): RoutingEnv {
  const vars = readJsonc(join(root, 'wrangler.jsonc')).vars ?? {};
  const devVars = join(root, '.dev.vars');
  const secrets = existsSync(devVars) ? parseEnv(readFileSync(devVars, 'utf8')) : {};
  const env: Record<string, string | undefined> = { ...vars, ...secrets };
  for (const name of SETTINGS) env[name] = process.env[name] ?? env[name];
  return env;
}

/** A JSON file that may have comments and trailing commas, as wrangler.jsonc does. */
function readJsonc(path: string): { vars?: Record<string, string> } {
  const text = readFileSync(path, 'utf8');
  let json = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      // A string, escapes and all.
      let end = i + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      json += text.slice(i, end + 1);
      i = end;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      json += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1 || text.length;
    } else {
      json += c;
    }
  }
  return JSON.parse(json.replace(/,(\s*[}\]])/g, '$1'));
}

// --- No timetable -------------------------------------------------------------------------------

const BUILD_IT = 'cd backend && uv run ir-build-data';

function warnIfNoTimetable(publicDir: string, logger: Logger): void {
  if (existsSync(join(publicDir, 'data', 'manifest.json'))) return;
  logger.warn(`No timetable in ${join(publicDir, 'data')}: build one with \`${BUILD_IT}\`.`);
}

/** Files missing from data/ are missing, not the app's page (which Vite serves for any path). */
function noTimetable(publicDir: string): Connect.NextHandleFunction {
  return (req, res, next) => {
    let path = req.url?.split('?')[0] ?? '';
    try {
      path = decodeURIComponent(path);
    } catch {
      return next();
    }
    if (!path.startsWith('/data/') || existsSync(join(publicDir, path))) return next();
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(`Not found. Build the timetable with \`${BUILD_IT}\`.`);
  };
}
