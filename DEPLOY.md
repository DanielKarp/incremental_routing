# Deploying and developing

How to run your own copy of Incremental Routing on Cloudflare, and how to work on it on your
own machine. [README.md](README.md) describes what the app does and how it works.

## Deploy it on Cloudflare (free)

The app is a static site: the page and the timetable, which your browser downloads once and
searches itself, plus a small Cloudflare Worker that fetches walk and bike routes. Cloudflare's
free Workers plan serves it on your own domain. A GitHub Actions workflow builds the timetable
from 511.org's feed and deploys the site whenever `main` changes, and again every Monday
morning, so the schedules stay current.

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
