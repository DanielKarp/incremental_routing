# Incremental Routing

Plan a multi-leg trip one leg at a time, mixing Bay Area transit (Caltrain, BART and VTA, or
every operator via 511.org) with walking and cycling. See [PLAN.md](PLAN.md) for the concept, data sources, architecture and
roadmap.

**Status:** MVP complete (milestones M0–M5), plus a round of refinements (M6).
- Build a trip forwards and backwards from transit, walk, bike and wait legs.
- Bike or walk to and from stops, and edit when walks, rides and waits leave or arrive.
- Transfer warnings come from the agencies' own rules.
- Print the trip with a map, or export it as CSV, a calendar file or a reusable JSON plan.
- The plan is autosaved in your browser.

## Prerequisites

- Python 3.11+ and [uv](https://docs.astral.sh/uv/)
- Node 22.12+

## Run it

Each block starts from the repository root, in its own terminal; both must keep running.

```sh
# Backend (first terminal)
cd backend
uv sync
cp .env.example .env        # optional: add a free ORS_API_KEY (Windows cmd: use `copy`)
uv run ir-load-gtfs         # downloads Caltrain, BART and VTA, then builds data/gtfs.sqlite
uv run uvicorn --factory incremental_routing.api:create_app --reload   # http://127.0.0.1:8000

# Frontend (second terminal, from the repository root)
cd frontend
npm install
npm run dev                 # http://localhost:5173 (proxies /api to the backend)
```

Re-run `uv run ir-load-gtfs` whenever schedules change. It reports each feed's valid dates
and flags expired ones. `uv run ir-load-gtfs bart` refreshes one feed.
`--skip-download` rebuilds from the zip files already on disk.

**After pulling an update**, run `uv run ir-load-gtfs --skip-download` if the app says the
transit database was built by an older version. Updates that add data to the database need a
rebuild. The M6 update is one of them; it adds transit shapes, transfer rules and agency
names.

### Every Bay Area operator (511.org)

The default data needs no key: the Caltrain, BART and VTA feeds. To load every Bay Area
operator from 511.org's regional feed instead (41 agencies, including Muni, SamTrans, AC
Transit, Golden Gate Transit and the ferries):

1. Get a free token at <https://511.org/open-data/token>.
2. Add it to `backend/.env` as `API_511_KEY=…`. Add `GTFS_SOURCE=511` to make 511 the default.
3. Run `uv run ir-load-gtfs`, or `uv run ir-load-gtfs --source 511` if you didn't set
   `GTFS_SOURCE`.

The regional feed already includes Caltrain, BART and VTA, so the two sources are never loaded
together. `uv run ir-load-gtfs --source agencies --skip-download` switches back. The download
is about 60 MB, and building took about a minute; the database is about 620 MB. The key is
never printed, even when a download fails.

Agencies update their schedules at different times, so the load summary lists any whose data
in the feed ends within 30 days. The app also names any agency whose schedule doesn't cover
the day you're planning.

Without an ORS key, walk and bike routing uses the public FOSSGIS Valhalla server (fair use).
Set `ROUTING_PROVIDER=straight-line` to work fully offline.

## Using it

1. **Plan from a point.** Click the map and set the time. It can be where you set off, where
   you need to be, or anywhere in between. Give it a name such as "Home".
2. **Add legs** under *Next leg*. Choose *After the end* to plan forwards or *Before the
   start* to plan backwards, then a mode:
   - **Transit:** pick how you'll reach the stop: *Get to the stop by Walking* or *Bike*
     (when planning backwards, how you'll leave it). Then *Find departures* (or *Find
     arrivals*), choose a trip, and choose the stop where you get off (or on). The walk or
     bike ride to or from the stop, and any wait, are added for you.

     When you change from another ride, the list notes the agency's transfer rules. It warns
     when a connection is shorter than the agency's minimum, or when the agency says the
     transfer isn't possible. You can still choose a warned trip.
   - **Walk / Bike:** click the map where you're going (or coming from), check the preview,
     name the place and add the leg.
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
   - *Save plan* (.json) to open it later with *Open plan…*.

## Tests

```sh
cd backend && uv run pytest && uv run ruff check .
cd frontend && npm test && npm run build
```

The backend tests run against a small synthetic GTFS feed (`backend/tests/conftest.py`). It
covers trips past midnight, holiday exceptions, stops without scheduled times, parent stations,
the daylight-saving change day, shapes and transfer rules.

## Data and attribution

- Transit schedules: Caltrain, BART (under the BART Developer License Agreement) and VTA GTFS
  feeds, or the 511 SF Bay regional feed (511.org open data).
- Map: © OpenStreetMap contributors, tiles by OpenFreeMap. Rendered with MapLibre GL JS.
- Walk and bike routing: openrouteservice (HeiGIT) or Valhalla (FOSSGIS public server).
