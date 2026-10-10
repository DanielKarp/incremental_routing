# Incremental Routing

Plan a multi-leg trip one leg at a time, mixing Bay Area transit (Caltrain, BART, VTA) with
walking and cycling. See [PLAN.md](PLAN.md) for the concept, data sources, architecture and
roadmap.

**Status:** milestone M2. You can build a trip forwards from transit legs. Each one is added
with the walk to the stop and any wait, and you can edit walk durations and undo steps. Walk
and bike legs of your own come next (M3), then planning backwards (M4).

## Prerequisites

- Python 3.11+ and [uv](https://docs.astral.sh/uv/)
- Node 22.12+

## Run it

```sh
# Backend
cd backend
uv sync
cp .env.example .env        # optional: add a free ORS_API_KEY for walk/bike routing
uv run ir-load-gtfs         # downloads Caltrain, BART and VTA, then builds data/gtfs.sqlite
uv run uvicorn --factory incremental_routing.api:create_app --reload   # http://127.0.0.1:8000

# Frontend (second terminal)
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

1. Click the map to choose where you start, and set the time.
2. Click **Find transit** to list trips you can reach on foot, then choose one.
3. Choose where to get off. The walk to the stop and any wait are added automatically.
4. Repeat from the new end of the plan. **Undo** steps back, and walk durations can be edited.
   Edits that would run into the next leg are refused.

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
