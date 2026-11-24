# Deploying and developing

How to run your own copy of Incremental Routing on a web host, with this repository's own
Cloudflare setup as the example, and how to work on it on your own machine.
[README.md](README.md) describes what the app does and how it works.

## Host it anywhere

The app is a static site: the page, its scripts and the timetable, which the browser downloads
once and searches itself. Any host that serves files can serve it. The one thing that isn't a
file is walk and bike routing: `POST /api/route` passes the two ends of a leg to a routing
service and returns the route, and `GET /api/info` names that service in the page's footer.

**Build it.** With your 511.org token in `builder/.env` (see
[Develop locally](#develop-locally)):

```sh
cd builder && uv run ir-build-data          # the timetable, into frontend/public/data
cd ../frontend && npm ci && npm run build   # the site, into frontend/dist
```

Then upload everything in `frontend/dist`: `index.html`, `assets/`, `data/` (`manifest.json`
and the timetable, `timetable-<hash>.sqlite.gz`) and `_headers`. The largest file is the
timetable, at about 9 MB.

**What the host has to get right:**

- **Caching.** `data/manifest.json` names the current timetable, so browsers must check it on
  every visit (`Cache-Control: no-cache`). Every other file has a hash in its name and can be
  kept for good (`Cache-Control: public, max-age=31536000, immutable`). `_headers` sets this
  for hosts that read it, such as Cloudflare and Netlify. Elsewhere, set the same headers in
  the host's own settings. A host that can't set headers works too. Browsers then keep the
  manifest for as long as the host's default (10 minutes on GitHub Pages), so a new timetable
  can take that long to reach them. They also check the timetable for changes now and then,
  which is a quick request, not a new download.
- **Compression.** The timetable is already gzipped, so serve it as it is. A host that also
  sends it with `Content-Encoding: gzip` works too: the app looks at the data it receives, not
  the headers.
- **The address.** The site expects to be at the root of a domain or subdomain, such as
  `trips.example.com`. To serve it from a path, such as
  `example.github.io/incremental_routing/`, build with
  `npm run build -- --base /incremental_routing/`. The page, scripts and timetable then load
  from that path. The app still asks for `/api/route` and `/api/info` at the root, so routing
  then needs the second or third option below, or a change to
  [frontend/src/api.ts](frontend/src/api.ts).
- **A weekly rebuild.** Agencies change their schedules, and 511.org's feed follows, so build
  and upload the site again every week. The Deploy workflow
  ([.github/workflows/deploy.yml](.github/workflows/deploy.yml)) does this for Cloudflare. For
  another host, replace its last step, `npm run deploy`, with `npm run build` and the host's
  own upload step.

**Walk and bike routing**, three ways:

1. **A function on the host, as the example below does.**
   - `handleApi(request, env)` in [frontend/worker/api.ts](frontend/worker/api.ts) takes a
     standard `Request` and returns a `Response`. Hosts with serverless functions that use the
     same types, such as Vercel, Netlify and Deno Deploy, can run it with a few lines of
     wrapper.
   - Map `/api/*` to the function, and pass it the settings described under
     [Walk and bike routing](#walk-and-bike-routing) as `env` (for example `process.env`).
   - This is the only option that keeps a routing service's key secret.
2. **Straight from the browser to the router.** The public FOSSGIS Valhalla server accepts
   requests from pages on any site, so the page could call it directly, with nothing running
   on the host. This needs a small code change that hasn't been made yet:
   [api.ts](frontend/src/api.ts) would run the routing code in `frontend/worker/routing.ts`
   itself, instead of asking `/api/route` and `/api/info`. It only suits a router without a
   key, since anyone can read a key in the page.
3. **No routing.** Without `/api/route`, each walk and bike leg is a straight-line estimate,
   and the app says so when the leg is added. It also shows "Walk and bike routing is
   unreachable" when the page opens, because the footer can't get `/api/info`.

**Some hosts:**

- **Cloudflare:** free. It sets the headers from `_headers` and runs the routing function as
  a Worker. This is the example below, and what this repository uses.
- **Netlify:** reads `_headers`, and runs the routing function as a Netlify Function.
- **Vercel:** headers go in its own `vercel.json`, and it runs the routing function as a Vercel
  Function.
- **GitHub Pages:**
  - free for public repositories only; a private one needs a paid plan;
  - it can't set headers or run functions, so routing would have to be the second or third
    option above;
  - it serves from a path unless you give it your own domain.

## Example: Cloudflare (free)

This is how this repository is deployed. The site's files are the static assets of a
Cloudflare Worker, and the Worker itself ([frontend/worker](frontend/worker)) answers `/api/*`:
the first routing option above. Cloudflare's free Workers plan serves it on your own domain. A
GitHub Actions workflow builds the timetable from 511.org's feed and deploys the site whenever
`main` changes, and again every Monday morning, so the schedules stay current.

Anyone with the address can use it: there are no logins. Each person's plans stay in their own
browser (they can save them as JSON files to keep or share), and the site stores none of them.
Walk and bike routes come from the public FOSSGIS Valhalla server, which is free under a
fair-use policy: fine for a few friends planning trips, not for heavy use. If you share the
address widely, use a routing service with a key (below).

You need:

- a Cloudflare account, with your domain on it;
- this repository on GitHub (yours, or a fork), with Actions enabled;
- a free 511.org API token: <https://511.org/open-data/token>.

One-time setup:

1. **A Cloudflare API token.** In the Cloudflare dashboard, go to *My Profile → API Tokens →
   Create Token* and use the *Edit Cloudflare Workers* template. Under *Account Resources*
   pick your account, and under *Zone Resources* your domain. Create it and copy the token;
   it's shown only once.
2. **Your account ID.** Open your domain's *Overview* page in the dashboard: the account ID is
   under *API*, on the right. It's also the 32-character code in the dashboard's address,
   `dash.cloudflare.com/<account ID>/…`. If you've never used Workers, open *Workers & Pages*
   once too, so that Cloudflare sets up your `workers.dev` subdomain.
3. **Three repository secrets.** On GitHub, in the repository's *Settings → Secrets and
   variables → Actions*, add a *New repository secret* for each:

   - `CLOUDFLARE_API_TOKEN`: the token from step 1;
   - `CLOUDFLARE_ACCOUNT_ID`: the account ID from step 2;
   - `API_511_KEY`: your 511.org token.
4. **The first deploy.** In the repository's *Actions* tab, choose *Deploy*, then *Run
   workflow* on `main`. It runs the tests, downloads the feed and builds the timetable (a
   couple of minutes), and deploys the Worker `incremental-routing`. The site is then up at
   the `workers.dev` address at the end of the deploy step's log.
5. **Your domain.** In the dashboard, go to *Workers & Pages →* `incremental-routing` *→
   Settings → Domains & Routes → Add → Custom domain*, and enter a name on your domain, such
   as `trips.example.com`. Cloudflare adds the DNS record and the certificate, and the site is
   there within minutes.

After that:

- Every push to `main` deploys, and every Monday a run rebuilds the timetable from that week's
  feed. A run that fails (511.org is down, say) deploys nothing, so the site keeps the
  timetable it has, and GitHub emails you. *Run workflow* tries again.
- In a public repository, GitHub turns off scheduled workflows after 60 days without
  activity. If the Monday runs stop, turn *Deploy* back on in the *Actions* tab.
- The page and the timetable are static files, which Cloudflare serves free without limit.
  The Worker runs only for walk and bike routes, well within the free plan's 100,000
  requests a day.

### Walk and bike routing

The Worker's settings are vars in
[frontend/wrangler.jsonc](frontend/wrangler.jsonc); change them there rather than in the
dashboard, since each deploy sets them from the file.

- `ROUTING_PROVIDER` is `valhalla` (the default), `ors` or `straight-line`. Valhalla's bike
  times already allow for hills. `straight-line` works without any routing service. `ors`
  (openrouteservice) needs `ORS_API_KEY`; its bike times ignore hills, and it gives no height
  profiles.
- `VALHALLA_ROUTE_URL` is the public FOSSGIS server by default. Any Valhalla-compatible
  `/route` endpoint works, such as Stadia Maps (`https://api.stadiamaps.com/route/v1`) with
  its key as `VALHALLA_API_KEY`.

Keys are secrets, set once and kept across deploys. From `frontend/`, after
`npx wrangler login`:

```sh
npx wrangler secret put VALHALLA_API_KEY    # or ORS_API_KEY
```

They can also be added in the dashboard: the Worker's *Settings → Variables and Secrets*, as
type *Secret*.

## Develop locally

You need Python 3.11+ with [uv](https://docs.astral.sh/uv/), Node 22.12+, and your 511.org
token in `builder/.env`: copy [.env.example](.env.example) there and fill in `API_511_KEY`.

```sh
# Build the timetable: downloads the 511 feed, then writes frontend/public/data
cd builder
uv run ir-build-data

# Run the app
cd ../frontend
npm install
npm run dev                 # http://localhost:5173
```

- `npm run dev` answers `/api/*` with the Worker's own code. Its settings come from
  `wrangler.jsonc`, then `frontend/.dev.vars` (for keys, never committed), then the
  environment: `ROUTING_PROVIDER=straight-line npm run dev` needs no routing service.
- `npm run preview` builds the site and runs it as Cloudflare does, with `wrangler dev`, at
  <http://localhost:8787>.
- `npm run deploy` deploys from your machine (`npx wrangler login` first), as the workflow
  does.

### The transit data

- It's 511.org's regional feed: one GTFS feed for every Bay Area operator. That's 41 agencies,
  including Caltrain, BART, VTA, Muni, AC Transit, SamTrans, Golden Gate Transit and the
  ferries.
- The download is about 60 MB. `ir-build-data` loads it into a full SQLite database (about
  620 MB, in `builder/data/build`) and derives the timetable the browser downloads from it:
  28 MB, 8.6 MB gzipped, in `frontend/public/data`, which is never committed. It all takes
  about a minute. The key is never printed, even when a download fails.
- Agencies update their schedules at different times, so the build lists any agency whose
  schedule ends within 30 days. The app also names any agency whose schedule doesn't cover
  the day you're planning.
- `uv run ir-build-data --skip-download` builds from the feed already on disk.

### Tests

```sh
cd builder && uv run pytest && uv run ruff check .
cd frontend && npm test && npm run build
```

The builder tests run against a small synthetic GTFS feed (`builder/tests/conftest.py`). It
covers trips past midnight, holiday exceptions, stops without scheduled times, parent
stations, the daylight-saving change day, shapes and transfer rules. The frontend's timetable
tests read the same feed, built as the real timetable is, and compare the answers with ones
recorded from the app's former server. The CI workflow runs all of these on every push and
pull request.
