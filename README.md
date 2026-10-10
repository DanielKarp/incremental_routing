# Incremental Routing

Plan a multi-leg trip one leg at a time, mixing Bay Area transit (every operator, from
511.org's regional feed) with walking and cycling. See [PLAN.md](PLAN.md) for the concept, data
sources, architecture, decisions and what's next.

**Status:** MVP complete (milestones M0–M5), plus two rounds of refinements (M6–M7).
- Build a trip forwards and backwards from transit, walk, bike and wait legs.
- Bike or walk to and from stops, and edit when walks, rides and waits leave or arrive.
- Departures are listed by line. Transfer warnings come from the agencies' own rules.
- Hilly bike rides show a simple height profile.
- Print the trip with a map, or export it as CSV, a calendar file or a JSON plan that you can
  open again or send to someone.
- The plan is autosaved in your browser.

## Prerequisites

- Python 3.11+ and [uv](https://docs.astral.sh/uv/)
- Node 22.12+
- A free 511.org API token: <https://511.org/open-data/token>

## Run it

Each block starts from the repository root, in its own terminal; both must keep running.

```sh
# Backend (first terminal)
cd backend
uv sync
cp .env.example .env        # then set API_511_KEY in .env (Windows cmd: use `copy`)
uv run ir-load-gtfs         # downloads the 511 regional feed, then builds data/gtfs.sqlite
uv run uvicorn --factory incremental_routing.api:create_app --reload   # http://127.0.0.1:8000

# Frontend (second terminal, from the repository root)
cd frontend
npm install
npm run dev                 # http://localhost:5173 (proxies /api to the backend)
```

The transit data is 511.org's regional feed: one GTFS feed for every Bay Area operator (41
agencies, including Caltrain, BART, VTA, Muni, AC Transit, SamTrans, Golden Gate Transit and
the ferries). The download is about 60 MB. Building takes about a minute and gives a database
of about 620 MB. The key is never printed, even when a download fails.

Re-run `uv run ir-load-gtfs` every month or so. Agencies update their schedules at different
times, so the load summary lists any agency whose schedule ends within 30 days. The app also
names any agency whose schedule doesn't cover the day you're planning.
`uv run ir-load-gtfs --skip-download` rebuilds from the feed already on disk.

**After pulling an update**, run `uv run ir-load-gtfs --skip-download` if the app says the
transit database was built by an older version.

Walk and bike routes come from the public FOSSGIS Valhalla server (fair use, no key). Its bike
times already allow for hills. `ROUTING_PROVIDER=straight-line` works fully offline.
`ROUTING_PROVIDER=ors`, with an `ORS_API_KEY`, uses openrouteservice instead; its bike times
ignore hills, and it gives no height profiles.

## Using it

1. **Plan from a point.** Click the map and set the time. It can be where you set off, where
   you need to be, or anywhere in between. Give it a name such as "Home".
2. **Add legs** under *Next leg*. Choose *After the end* to plan forwards or *Before the
   start* to plan backwards, then a mode:
   - **Transit:** pick how you'll reach the stop: *Get to the stop by Walking* or *Bike*
     (when planning backwards, how you'll leave it). Then *Find departures* (or *Find
     arrivals*). Each line nearby gets a row with its next three departures (or, backwards,
     its last three arrivals). Pick a time, then the stop where you get off (or on). The walk
     or bike ride to or from the stop, and any wait, are added for you.

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

## Data and attribution

- Transit schedules: the 511 SF Bay regional GTFS feed (511.org open data).
- Map: © OpenStreetMap contributors, tiles by OpenFreeMap. Rendered with MapLibre GL JS.
- Walk and bike routing and heights: Valhalla (FOSSGIS public server), or openrouteservice
  (HeiGIT) if you choose it.
