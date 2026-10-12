# Incremental Routing

Plan a multi-leg trip one leg at a time, mixing Bay Area transit (every operator, from
511.org's regional feed) with walking and cycling. See [PLAN.md](PLAN.md) for the concept, data
sources, architecture, decisions and what's next.

**Status:** MVP complete (milestones M0–M5), plus refinements (M6–M7), packaged for Docker
(M8), with line previews on the map (M9).

- Build a trip forwards and backwards from transit, walk, bike and wait legs.
- While you choose a ride, the map shows where each line nearby goes. Pick lines and stops in
  the list or on the map.
- Bike or walk to and from stops, and edit when walks, rides and waits leave or arrive.
- Departures are listed by line. Transfer warnings come from the agencies' own rules.
- Hilly bike rides show a simple height profile.
- Print the trip with a map, or export it as CSV, a calendar file or a JSON plan that you can
  open again or send to someone.
- The plan is autosaved in your browser.

## Run it with Docker

This is the easy way, on a home server or on your own computer. You need:

- Docker with Compose: Docker Engine on Linux, or Docker Desktop on Windows and macOS;
- about 1 GB of disk;
- a free 511.org API token: <https://511.org/open-data/token>.

```sh
git clone https://github.com/DanielKarp/incremental_routing.git
cd incremental_routing
cp .env.example .env              # then put your token in .env: API_511_KEY=...
docker compose up -d --build
```

Open <http://localhost:8000>.

- **First start.** The app downloads the transit data and builds its database, which takes
  about a minute. Reload the page once it's done.
- **Data refresh.** The data is checked every few hours and downloaded again once it's a week
  old. `REFRESH_DAYS` in `.env` changes that.
- **Storage.** The data lives in a Docker volume, so it survives restarts and updates.

Day to day:

| To | Run |
| --- | --- |
| Update to the latest version | `git pull && docker compose up -d --build` |
| See what it's doing | `docker compose logs -f app` |
| Fetch fresh schedules now | `docker compose exec app ir-load-gtfs` |
| Stop it | `docker compose down` (the data is kept) |

The app listens on this machine only. To reach it from other devices on your network, set
`BIND=0.0.0.0` in `.env` and use the machine's address. The app has no logins of its own, so
don't open it to the internet directly; use the tunnel below instead.

### Share it with friends through a Cloudflare tunnel

A Cloudflare tunnel gives the app a web address without opening ports on your router.
Cloudflare Access then asks visitors for an emailed one-time code, so only the people you list
get in. Both are free, for up to 50 people. You need a domain whose DNS is on Cloudflare.

1. In the Cloudflare Zero Trust dashboard, create a tunnel (type *Cloudflared*). Copy its
   token into `.env` as `TUNNEL_TOKEN=...`.
2. Give the tunnel a public hostname, such as `trips.example.com`, pointing to the service
   `http://app:8000`.
3. Under Access, add a *self-hosted* application for that hostname. Its policy should allow
   your friends' email addresses, with one-time PIN as the login method. Don't skip this step:
   without it, anyone who finds the address can use the app.
4. Start the app and the tunnel:

   ```sh
   docker compose --profile tunnel up -d --build
   ```

Your friends open `https://trips.example.com`, enter their email and the code they receive,
and plan away. Each person's plans stay in their own browser; they can save them as JSON files
to keep or share. Cloudflare's guides cover the details:
[tunnels](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) and
[self-hosted applications](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-apps/).

### Settings

Everything goes in `.env`; [.env.example](.env.example) lists each setting.

- `API_511_KEY` is the only one you must set.
- Walk and bike routes come from the public FOSSGIS Valhalla server (fair use, no key). Its bike
  times already allow for hills.
- `ROUTING_PROVIDER=straight-line` works without any routing service.
- `ROUTING_PROVIDER=ors`, with an `ORS_API_KEY`, uses openrouteservice instead. Its bike times
  ignore hills, and it gives no height profiles.

## Develop without Docker

You need Python 3.11+ with [uv](https://docs.astral.sh/uv/), Node 22.12+, and the same `.env`
at the repository root. Each block starts from the repository root, in its own terminal; both
must keep running.

```sh
# Backend (first terminal)
cd backend
uv sync
uv run ir-load-gtfs         # downloads the 511 regional feed, then builds data/gtfs.sqlite
uv run uvicorn --factory incremental_routing.api:create_app --reload   # http://127.0.0.1:8000

# Frontend (second terminal)
cd frontend
npm install
npm run dev                 # http://localhost:5173 (proxies /api to the backend)
```

After `npm run build`, the backend also serves the built app at <http://127.0.0.1:8000>, as it
does in Docker.

**The transit data.**

- It's 511.org's regional feed: one GTFS feed for every Bay Area operator. That's 41 agencies,
  including Caltrain, BART, VTA, Muni, AC Transit, SamTrans, Golden Gate Transit and the
  ferries.
- The download is about 60 MB. Building takes about a minute and gives a database of about
  620 MB. The key is never printed, even when a download fails.
- Re-run `uv run ir-load-gtfs` every month or so. Agencies update their schedules at different
  times, so the load summary lists any agency whose schedule ends within 30 days. The app also
  names any agency whose schedule doesn't cover the day you're planning.
- `uv run ir-load-gtfs --skip-download` rebuilds from the feed already on disk. Run it after
  pulling an update if the app says the database was built by an older version.

## Using it

1. **Plan from a point.** Click the map and set the time. It can be where you set off, where
   you need to be, or anywhere in between. Give it a name such as "Home".
2. **Add legs** under *Next leg*. Choose *After the end* to plan forwards or *Before the
   start* to plan backwards, then a mode:
   - **Transit:** pick how you'll reach the stop: *Get to the stop by Walking* or *Bike*
     (when planning backwards, how you'll leave it). Then *Find departures* (or *Find
     arrivals*). Each line nearby gets a row with its next three departures (or, backwards,
     its last three arrivals).

     The map shows those lines too, thin and faded in their own colours, each with a dot at
     the stop where you'd catch it. Forwards, a line runs from that stop to the end of its
     route; backwards, from the start of its route to the stop. Point at a row to highlight
     its line and zoom to it, or point at a line on the map to see its name.

     Pick a time, or click a line's name for its next departure (or last arrival). You can
     also click the line itself on the map; where lines overlap, you're asked which one.
     Then choose the stop where you get off (or on), in the list or on the map. The walk or
     bike ride to or from the stop, and any wait, are added for you.

     When you change from another ride, the list notes the agency's transfer rules. It warns
     when a connection is shorter than the agency's minimum, or when the agency says the
     transfer isn't possible. You can still choose a warned trip. Changes between different
     agencies have no rules, so judge those yourself.
   - **Walk / Bike:** click the map where you're going (or coming from), check the preview,
     name the place and add the leg. A bike ride that climbs or descends at least 20 m shows
     a small height profile, with its total climb and descent.
   - **Wait:** add a stop of a set number of minutes, e.g. for coffee.
3. **Adjust** walk, bike and wait legs in the itinerary.
   - Change when they leave or arrive, or how long they take. An end that meets a ride
     directly is fixed. Next to a wait, or at either end of the plan, it can move. A leg can't
     run into its neighbours.
   - *Switch to bike* / *Switch to walk* re-routes a leg.
   - *Rename places* changes a place's name everywhere it appears.
   - **Remove** takes off the first or last leg, and **Undo** reverts any change.
4. **Finish** with *Summary & export*. It shows a map of the whole trip and the itinerary.
   - Print both.
   - Download a CSV, or add the trip to your calendar (.ics).
   - *Save plan (.json)* to keep the plan or send it to someone. *Open plan…* (top of the
     page) loads it again.

## Tests

```sh
cd backend && uv run pytest && uv run ruff check .
cd frontend && npm test && npm run build
```

The backend tests run against a small synthetic GTFS feed (`backend/tests/conftest.py`). It
covers trips past midnight, holiday exceptions, stops without scheduled times, parent stations,
the daylight-saving change day, shapes and transfer rules.

## License

The code is released under the [MIT License](LICENSE). The data it uses comes from the services
below, under their own terms.

## Data and attribution

- Transit schedules: the 511 SF Bay regional GTFS feed (511.org open data).
- Map: © OpenStreetMap contributors, tiles by OpenFreeMap. Rendered with MapLibre GL JS.
- Walk and bike routing and heights: Valhalla (FOSSGIS public server), or openrouteservice
  (HeiGIT) if you choose it.
