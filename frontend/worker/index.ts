// The Cloudflare Worker: the site is static assets (dist/, see wrangler.jsonc), served without
// it. /api/* comes here, for walk and bike routes (api.ts), and so does any other path no file
// answers, which gets the assets' 404.

import { handleApi, type RoutingEnv } from './api';

interface Env extends RoutingEnv {
  /** The site's files, for anything else that reaches the Worker. */
  ASSETS: Fetcher;
}

export default {
  fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/api/')) return handleApi(request, env);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
