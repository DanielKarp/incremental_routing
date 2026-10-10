# Incremental Routing

Plan a multi-leg trip one leg at a time, mixing Bay Area transit (Caltrain, BART, VTA) with
walking and cycling. See [PLAN.md](PLAN.md) for the concept, data sources, architecture and
roadmap.

**Status:** MVP complete (milestones M0–M5). You can build a trip forwards and backwards from
transit, walk, bike and wait legs, then print it or export it as CSV, a calendar file or a
reusable JSON plan. The plan is autosaved in your browser.

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

Without an ORS key, walk and bike routing uses the public FOSSGIS Valhalla server (fair use).
Set `ROUTING_PROVIDER=straight-line` to work fully offline.

## Using it

1. **Plan from a point.** Click the map and set the time. It can be where you set off, where
   you need to be, or anywhere in between. Give it a name such as "Home".
2. **Add legs** under *Next leg*. Choose *After the end* to plan forwards or *Before the
   start* to plan backwards, then a mode:
   - **Transit:** *Find departures* (or *Find arrivals*), choose a trip, then the stop where
     you get off (or on). The walk to or from the stop and any wait are added for you.
   - **Walk / Bike:** click the map where you're going (or coming from), check the preview,
     name the place and add the leg.
   - **Wait:** add a stop of a set number of minutes, e.g. for coffee.
3. **Adjust** walk, bike and wait durations in the itinerary. A leg can't be stretched into
   its neighbours. **Remove** takes off the first or last leg, and **Undo** reverts any change.
4. **Finish** with *Summary & export*: print the itinerary, download a CSV, add it to your
   calendar (.ics), or *Save plan* (.json) to open later with *Open plan…*.

## Tests

```sh
cd backend && uv run pytest && uv run ruff check .
cd frontend && npm test && npm run build
```

The backend tests run against a small synthetic GTFS feed (`backend/tests/conftest.py`). It
covers trips past midnight, holiday exceptions, stops without scheduled times, parent stations
and the daylight-saving change day.

## Data and attribution

- Transit schedules: Caltrain, BART (under the BART Developer License Agreement) and VTA GTFS
  feeds.
- Map: © OpenStreetMap contributors, tiles by OpenFreeMap. Rendered with MapLibre GL JS.
- Walk and bike routing: openrouteservice (HeiGIT) or Valhalla (FOSSGIS public server).
