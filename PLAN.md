# Incremental Routing: plan

A route planner for building a multi-leg trip **one leg at a time**, mixing public transit with
cycling and walking. Instead of asking a journey planner for "the best route", you choose
every leg yourself and the app keeps the itinerary consistent in space and time.

This document describes the planner as built (the MVP plus refinements, served since M13 as
a static site on Cloudflare), the data sources and decisions behind it, and what might come
next.

---

## 1. Concepts

| Term | Meaning |
| --- | --- |
| **Waypoint** | A point in space-time: a place (lat/lon, optionally a stop) plus a time. |
| **Leg** | Travel from one waypoint to the next by one mode: `transit`, `walk`, `bike` or `wait`. |
| **Plan** | The ordered chain of legs. Each leg ends where and when the next one begins. |
| **Anchor** | The point in space-time you start planning from. |
| **Frontier** | The open end of the plan you are extending: its end when planning forwards, its start when planning backwards. |

Because a plan has two frontiers, you can plan forwards from the anchor, backwards from it, or
both. For example, "I must be at the office at 9:00, and I'm leaving home on my bike" can be
built from either end.

## 2. Scope

**In scope**

- Anyone with the address, in a browser. It's a static site on Cloudflare's free plan, with
  no logins (decisions 13 and 22). There are no accounts: each person's plans stay in their
  own browser.
- Transit schedules for every Bay Area operator, from the **511 SF Bay regional feed** (static
  GTFS; decisions 7 and 9).
- Leg types: transit, walk, bike, wait (waits inserted automatically, or added by hand).
- Forward and backward planning from an anchor picked on the map.
- Walk and bike routes from Valhalla, with editable times, and a height profile for hilly bike
  rides (decision 10).
- A final itinerary listing every leg with start and end time and place. It can be printed
  with a map, or exported as CSV, a calendar file or a JSON plan.

**Out of scope**

- Automatic "best route" search, including suggestions for the next leg. You choose every
  leg yourself.
- Accounts, saved-plan lists, shareable links and bike share. Plans move as JSON files
  (decision 12).
- Place and address search. You pick points on the map (on hold, §10).
- Live data: delays, cancellations and alerts (decision 7).
- Enforcing bike-on-board rules. The data is shown but not enforced (decision 4).
- Transfer rules between agencies. No feed describes them, so the rider judges those
  connections (decision 11).

## 3. User flow

### Forward (the main flow)

1. Click the map and set a time. That's the anchor, and it becomes the frontier. Until the
   first leg, its pin can be dragged or moved from the map's menu, and *Undo* moves it back
   (decision 18).
2. Choose a mode for the next leg:
   - **Transit**: see departures from stops near the frontier in the hour after its time (or
     3 hours, on request), grouped by line (decision 8). They're listed as soon as Transit is
     chosen, and again whenever anything they depend on changes (decision 15). Only trips you
     can still reach on foot or by bike are shown. The map draws each of those lines from its
     stop onwards (decision 14). Pick a trip, in the list or by clicking its line on the map.
     Then pick the stop to get off at from that trip's remaining stops, in the list or on the
     map, or go back to the lines (*← Lines* or Escape), which come back as you left them.
     - If the boarding stop isn't at the frontier, the app inserts a walk or bike ride to the
       stop. It starts right away, and a wait fills any time left before the departure.
     - That ride is routed as soon as the trip is picked. If it misses the trip, the stop
       list says so and offers the same line's next listed trip that it makes.
   - **Walk / Bike**: click the destination. The router returns a path and duration, and
     switching between Walk and Bike routes the same point the other way. You can edit when
     the leg leaves or arrives, or how long it takes, and a hilly bike ride shows a height
     profile. In Transit or Wait mode a click on the map, or a right-click in any mode, opens
     a menu that adds a walk or bike leg there at once (decision 16).
   - **Wait**: stay put for N minutes, e.g. a coffee stop: one click for 5, 10, 15 or 30.
3. The new leg's end becomes the frontier, and step 2 repeats.
4. Any time gap between two legs is filled with an automatic **wait** leg. For example, a bike
   leg reaches the station at 7:50 and the train leaves at 8:00.

### Backward

This is the same flow mirrored. You see **arrivals** at stops near the frontier in the hour
before its time, with each line drawn up to its stop, pick a trip, then pick where you got on
from its earlier stops. The walk or bike ride from the stop to the frontier leaves as soon as
you get off, and any spare time becomes a wait at the frontier (decision 1, mirrored). Walk,
bike and wait legs you add keep their **end** time fixed and compute the start time.

### Leg types

| Mode | Start / end chosen by | Times come from | Editable |
| --- | --- | --- | --- |
| Transit | Departure (or arrival) list or a line on the map, then a stop on that trip | Timetable | No: fixed by the schedule |
| Walk, Bike | Frontier, then a map click (or the map's menu) | Routing API (Valhalla) | Departure, arrival or duration, within its neighbours (decision 2). Two in a row of the same mode can merge (decision 17) |
| Wait | Same place at both ends | Gap between legs, or manual | Manual waits only. Any two waits in a row can merge |

## 4. Data model

```ts
interface Place { lat; lon; name?; named? /* you typed the name */; stopId? }
interface Waypoint { place: Place; time: string /* ISO, with offset */ }
interface Leg {
  id: string;
  mode: 'transit' | 'walk' | 'bike' | 'wait';
  start: Waypoint;
  end: Waypoint;
  auto?: boolean;                 // derived (waits), rebuilt on every change
  fixed?: 'start' | 'end';        // the end the leg was planned from
  transit?: { tripId; serviceDate; routeName; headsign; agency; color; textColor;
              bikesAllowed; stops: [...]; geometry? /* the ridden part of the shape */ };
  path?: { provider; distanceM; routedDurationS; geometry;
           elevation?: { intervalM; heightsM } /* bike routes */ };
}
interface Plan { anchor: Waypoint; legs: Leg[] }
```

The real definitions are in `frontend/src/plan/types.ts`.

**Invariants**, enforced by `withWaits` and `findIssues` in `frontend/src/plan/plan.ts`:

1. Legs are chronological.
2. **Continuous in time.** A gap between legs becomes an automatic wait leg. An **overlap**
   (the next leg starts before the previous one ends) is a *missed connection*. Nothing is
   ever silently re-timed, because transit times can't move. Edits that would cause an
   overlap are refused (§9, decision 2), and `findIssues` still reports any overlap as a
   safety net.
3. **Continuous in space.** Each leg starts within 75 m of where the previous one ended.
   Otherwise the plan reports a `location-gap` issue.
4. Automatic legs are derived data. They are deleted and rebuilt on every edit, so they can
   never go stale.

**Where state lives.** The plan lives in the browser: React state, autosaved to localStorage
with the direction and the undo history (decision 19), and exportable as JSON. The timetable
(in the browser too) and the routing server only answer facts ("what departs from here?", "how
long is this ride?") and keep nothing. This keeps the site static and makes the plan rules pure
functions that are easy to test.

## 5. Data sources

### 5.1 Transit: the 511 regional GTFS feed

The **511 SF Bay regional feed** is the source of truth (decision 9). It is one consolidated
GTFS feed for every Bay Area operator, from the [511 SF Bay open data
API](https://511.org/open-data/transit) (`operator_id=RG`). On 2026-10-10 it held 41 agencies,
21,627 stops, 90,168 trips and 3.1 million stop times. It needs a free API key
(`API_511_KEY`).

`uv run ir-build-data` (in `builder/`) downloads it (about 60 MB), loads it into one SQLite
file (about 620 MB) and derives from that the compact timetable the browser downloads (28 MB,
8.6 MB gzipped; see the M13 notes), in about a minute. The feed is defined in
`builder/src/incremental_routing/gtfs/feeds.py`. The agencies' own Caltrain, BART and VTA feeds
were used until M6, and are no longer supported.

**Freshness.** Each agency's schedule in the feed ends on its own date, and 511 republishes the
feed as agencies update. The feed's overall date range (2021–2099) says nothing, so dates are
tracked per agency:

- the build lists agencies whose schedules end within 30 days, and flags expired ones;
- the UI names any agency whose schedule doesn't cover the day being planned.

The Deploy workflow rebuilds the timetable from the current feed every Monday (§6). In
October 2026, VTA's schedule ends on 2026-10-25.

Dates come from the service calendars, not from `feed_info.txt`, which publishers forget to
update. BART's own August 2026 feed still declared an end date of 2026-08-30, while its
calendar ran to 2027-01-10.

**GTFS details the loader and the queries handle:**

- Times past `24:00:00` for trips that run past midnight. Every query checks yesterday's
  service day too.
- The service day begins at "noon minus 12 h", which is not midnight on daylight-saving change
  days.
- Service days come from `calendar.txt` plus `calendar_dates.txt` exceptions (holidays).
- Parent stations versus boardable platforms. Station nodes and entrances are never offered as
  stops.
- Stops without a scheduled time are interpolated between scheduled timepoints.
- Every ID is prefixed with its feed (`bayarea:…`).
- No boarding at a trip's last stop, or where `pickup_type=1`. The same applies to alighting.
- Shapes (`shapes.txt`) and transfer rules (`transfers.txt`); see the M6 notes.
- Zips with files nested in a folder. Stray macOS `__MACOSX/` entries are ignored.
- Not handled: `frequencies.txt` (headway-based trips). The loader warns if a feed uses it, and
  the 511 feed doesn't.

### 5.2 Walking and cycling routes

| Option | Free usage | Key | Fit |
| --- | --- | --- | --- |
| **Valhalla, FOSSGIS public server** (used) | Free under a fair-use policy, rate-limited | None | `pedestrian` and `bicycle` costing. Bike speeds follow the road's grade, and routes can come with heights along them. |
| OpenRouteService | Free plan: 2,000 directions requests/day, 40/min | Free signup | `foot-walking`, `cycling-regular` and others. On the hosted service, hills add distance but don't change bike times. |
| Stadia Maps (hosted Valhalla) | Free tier for non-commercial use (check current limits) | Yes | Same API as FOSSGIS, so the same provider class works with a different URL and key. |
| Google Routes API | Monthly free usage, then pay-as-you-go | Key + billing account | Its terms restrict showing results on non-Google maps and caching them. Poor fit here. |
| Mapbox Directions | Monthly free allowance | Key + account | Its terms tie results to Mapbox maps. |
| Self-hosted Valhalla, GraphHopper or OSRM | Unlimited | None | Docker plus a Northern California OSM extract, needing about 2–4 GB RAM. The upgrade path after the MVP. |

**Decision:** the public Valhalla server (decision 10). Its bike times already slow for climbs
and speed up on descents, so they are used as they are. Bike routes are requested with
`elevation_interval` = 30 m, and Valhalla returns the heights along the route for the height
profile, interpolated across bridges and tunnels.

Both providers sit behind one `RoutingProvider` interface (`frontend/src/routing/routing.ts`),
selected by the build setting `VITE_ROUTING_PROVIDER`. The page has run it itself since M14
(decision 23); before that it ran in the site's Worker, and until M13 in the server's `routing/`
package.

- `valhalla` (the default): the FOSSGIS server, or another Valhalla server that takes requests
  from other sites without a key (`VITE_VALHALLA_ROUTE_URL`).
- `straight-line`: an estimate for offline development and tests. It is also the fallback when
  the router fails, labelled "(estimated)".

openrouteservice, and Valhalla servers that need a key (Stadia Maps), went with the Worker in
M14: a key in the page is a key anyone can read.

One user makes a request or two per leg: one per walk or bike leg (another if you switch it
between Walk and Bike before adding it), and one per trip picked whose stop needs a walk or
ride, reused when you choose where to get off. A few people planning at a time are well within
fair use. Since M13 the site is open to anyone, so heavy use would call for a routing service
with a key, which each user would bring themselves (decision 23), or self-hosted routing, which
is on hold (§10).

Router speeds are generic. Typical defaults are about 5 km/h walking and roughly 15–20 km/h cycling.
That's one reason duration overrides are a core feature rather than an extra.

### 5.3 Base map

MapLibre GL JS with **OpenFreeMap** vector tiles: free, no key, OpenStreetMap data, no SLA. If it
ever becomes unreliable, switch the style URL in `MapView.tsx` to MapTiler or Stadia (free tiers
with keys), or to a self-hosted Protomaps file of the Bay Area.

### 5.4 Place search (on hold)

Not planned for now (§10). If it comes back, searching stop names in the GTFS data would cover
stations, and Photon or Nominatim (fair use) could cover addresses.

## 6. Architecture

```
Browser                                      Cloudflare, free plan: static files
┌──────────────────────────────────┐   GET   ┌──────────────────────────────────────┐
│ React + MapLibre                 │◀────────│ the built app (dist/)                │
│ plan/  pure plan rules (TS)      │         │ data/manifest.json                   │
│ components/  map, lists, leg     │         │ data/timetable-<hash>.sqlite.gz      │
│   builder, itinerary             │         └──────────────────────────────────────┘
│ localStorage + JSON export       │                            ▲ npm run deploy
│                                  │         GitHub Actions, Deploy (push to main,
│ Web Worker: timetable/ (sql.js)  │         Mondays, by hand): 511.org feed ─▶
│   stops, departures, arrivals,   │         builder/ ir-build-data ─▶ public/data
│   trips, lines                   │
│                                  │  POST   ┌──────────────────────────────────────┐
│ routing/  walk and bike routes   │────────▶│ Valhalla: the FOSSGIS public server  │
└──────────────────────────────────┘         └──────────────────────────────────────┘
```

| Call in `api.ts` | Answered by | Gives |
| --- | --- | --- |
| `health()` | The timetable, and the build's routing setting | Whether the timetable is loaded (and if not, why), and the routing provider |
| `feeds()` | The timetable's manifest | The feeds, with each agency's schedule dates |
| `nearbyStops(point, radiusM)` | The timetable | Boardable stops near a point, with the time to reach them on foot or by bike |
| `departures(query)` | The timetable | Trips you can reach and board after `time` (forward), each with any transfer rule |
| `arrivals(query)` | The timetable | Trips you can ride to arrive before `time` (backward) |
| `trip(tripId, serviceDate)` | The timetable | A trip's stops with times and board/alight flags, and its shape |
| `lines(direction, trips)` | The timetable | For the map: the part of each listed trip you could ride from its stop (forward) or to it (backward), simplified |
| `route(mode, origin, destination)` | `routing/`, asking the routing server (Valhalla) | Walk or bike path, distance and duration, with heights along bike routes |

Each call takes and gives what the server's endpoint of the same name did until M13, errors
included, so the rest of the app didn't change.

**The timetable.** `uv run ir-build-data` (`builder/`, Python) downloads the 511 feed, loads it
into the full SQLite database, and derives the compact timetable from it:
`data/timetable-<hash>.sqlite.gz`, named by its contents, and `data/manifest.json`, which names
it. The page downloads both in a Web Worker (`frontend/src/timetable/`), checks the
timetable's size and SHA-256, opens it with sql.js and answers the transit calls from it. The
browser revalidates the manifest on each visit and keeps the timetable until a new one is
published.

**Walk and bike routes** (`frontend/src/routing/`) are asked of the routing server straight
from the page (decision 23). The build settings `VITE_ROUTING_PROVIDER` and
`VITE_VALHALLA_ROUTE_URL` name it; by default it's the public FOSSGIS server, which takes
requests from any site and needs no key. Everything the site serves is a static file, and a
path with no file is a 404.

**Deployment.** `frontend/wrangler.jsonc` describes the site (static assets, with no Worker
script), and `npm run deploy` builds and deploys it. The Deploy workflow (`.github/workflows/deploy.yml`) does that on every push to
`main`, every Monday at 12:23 UTC and by hand: it runs the checks (CI), builds the timetable
from that day's feed (with the `API_511_KEY` secret) and deploys with the
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets. Repository variables of the same
names can change the routing settings. A run that fails deploys nothing,
so the site keeps its last timetable; one deploy runs at a time. CI runs the same checks on
every push and pull request. Locally, `npm run dev` serves the app with Vite, and
`npm run preview` serves the production build as Cloudflare does, under `wrangler dev`.

Times without an offset are read as Bay Area local time (the manifest's `default_timezone`),
and answers carry the offset (`-07:00` or `-08:00`). The UI always shows Bay Area time,
whatever time zone your laptop is in.

**Why this shape** (decision 22). The whole timetable fits in a download, 8.6 MB gzipped, and
sql.js runs the server's queries on it in a few milliseconds, so the transit questions need no
server. That left only walk and bike routing, which needed a router and perhaps its key: one
small Worker, until M14 moved routing into the page too (decision 23). The site costs nothing to host, has no machine to keep running or patching, and
its data is refreshed by a scheduled build rather than by a process beside a server. The
builder stays in Python, where the GTFS tooling is strongest, and runs only at build time. All
plan logic is pure TypeScript, so it is fast to iterate on and easy to unit-test.

## 7. Key algorithms

**Departures near a point** (`departures` in `frontend/src/timetable/timetable.ts`, ported in
M13 from the server's `GtfsStore.departures`):

1. Find boardable stops within the radius: a bounding box from an index, then exact
   distance.
2. For each feed, and for service days *yesterday* and *today*: work out the active
   `service_id`s, then find the trips calling at those stops within the time window (in the
   compact timetable, each trip's start plus its pattern's time at the stop).
3. Drop departures you can't reach in time: straight-line distance × 1.3 detour factor, at
   1.3 m/s on foot or 4.5 m/s by bike, rounded up to whole minutes.
4. Keep one entry per trip, at its nearest stop, sorted by time. With `per_route`, keep only
   the first few trips of each route, headsign and stop before the overall limit.

Arrivals are the mirror image: alighting allowed, arriving at least the access time before the
query time.

**Choosing where to get off:** `trip()` returns every stop with absolute times. The UI lists
stops after the boarding stop where `can_alight` is true (forward), or stops before the alighting
stop where `can_board` is true (backward).

**Line previews** (`lines()`): for each line in the list, the UI asks for the trip it stands
for (the next departure, or the last arrival when planning backwards) and its stop. The
timetable cuts that trip's shape from the stop to the trip's last stop (forward), or from its
first stop to the stop (backward). Stops are placed on the shape as for `trip()` (worked out
when the timetable is built), and the path runs stop to stop when the shape can't be used.
Each path is then simplified to within 10 m (Douglas–Peucker), which keeps 60 lines to about
40 KB.

**Connector walks:** when a picked trip's stop isn't at the frontier, the UI requests a walk or
bike route from the frontier to the stop straight away, and `missedTrip` checks that it makes
the trip. The route is added as a leg when you choose where to get off, and `withWaits` then
fills the remaining time.

**Hill profiles** (`frontend/src/plan/hills.ts`): a bike ride gets a profile when it climbs or
descends at least 20 m between any two of its points, in riding order. Gentle rises don't count:
Palo Alto Caltrain to Stanford rises 15 m over 3.4 km. Total climb and descent ignore wobbles
under 2 m. The chart draws heights to one scale up to a 100 m span, so a small hill looks small.

**Normalization:** after every edit, `withWaits` rebuilds the wait legs and `findIssues`
reports overlaps, gaps in space and negative durations. The UI marks those legs and doesn't
fix them automatically.

## 8. Milestones

| # | Milestone | Done when |
| --- | --- | --- |
| M0 ✅ | Scaffold | GTFS loader and queries, routing providers, API, map page listing departures and arrivals, plan model. Unit tests for all of it. |
| M1 ✅ | Real-data check | Feeds load. Query latency measured. Feed quirks fixed. Live walk and bike routing works. No hand-check against printed timetables is needed, because 511 is the source of truth (decision 9). |
| M2 ✅ | Forward transit legs | Pick a departure, then a stop to get off at, and the leg (with connector walk and wait) is added. Transit legs are drawn on the map, and an itinerary panel lists the legs. You can build home → Caltrain → BART by clicking. |
| M3 ✅ | Walk and bike legs | Choose a mode at the frontier, click a destination, and get a routed path drawn on the map. Duration is editable, conflicts are shown, manual waits work, and you can remove the last leg. |
| M4 ✅ | Backward planning | Arrivals list, choose where to board, prepend legs. Walk and bike legs keep their end time fixed. A plan can grow both ways from the anchor. |
| M5 ✅ | Output and persistence | A final itinerary table (leg, mode, from, depart, to, arrive, duration). Print view. Export to JSON, CSV and calendar (ICS). Autosave and import. |
| M6 ✅ | Refinements from testing | Bike to and from stops, and switch walk ↔ bike later. Edit departure and arrival times. 511 regional feed. Transit lines from `shapes.txt`. Rename places. A map in the summary and printout. Transfer warnings from `transfers.txt`. Departures listed by line. |
| M7 ✅ | Simplify and finish | 511 is the only transit source. Valhalla is the router, and its times are used as they are. Hilly bike rides show a height profile. The plan is brought up to date. |
| M8 ✅ | Docker and sharing | One image serves the whole app and keeps its data fresh. Compose runs it at home or on a friend's machine, with an optional Cloudflare tunnel. MIT licence. Replaced by M13. |
| M9 ✅ | Line previews | While you choose a ride, the map shows every line in the list, faded in its own colour, with the stop to catch it. Pointing at a row highlights and frames its line, and pointing at a line marks its row. Lines, and the stop to get off at (or on), can be picked on the map. |
| M10 ✅ | Fewer clicks | The departure (or arrival) list loads by itself. A right-click on the map adds a walk or bike leg there straight away. |
| M11 ✅ | Merge legs | Where two walks, two bike rides or two waits meet, a button between them joins them into one leg. |
| M12 ✅ | Smoother flow | A click on the map opens the walk and bike menu, and the start pin can be dragged. Undo stays in reach, names its step and survives a reload. Legs can be removed mid-trip, and places renamed where they're shown. The list can be filtered and says what it searched, a picked trip is checked against the walk to its stop, and on phones the map stays in view. |
| M13 ✅ | A free static site | The browser downloads the whole timetable, in a compact file, and searches it itself; one Cloudflare Worker gives walk and bike routes. Anyone with the address can use it, with no logins. GitHub Actions tests every push and deploys `main`, with a fresh timetable every Monday. The server and Docker are gone, and the example trips come out as before. |
| M14 ✅ | No Worker | The browser asks Valhalla for walk and bike routes itself, so the site is static files only and any host can serve it. Routers that need a key (openrouteservice, Stadia Maps) are gone until users can bring their own. |

### M14 notes

- **Why** (decision 23). The Worker only passed each leg's two ends on to the public Valhalla
  server, which takes requests from pages on any site. Without it the site is static files
  only, so any host can serve it, and nobody else can use its `/api/route`.
- **What moved.** The routing code (`routing.ts` and `geo.ts`, with their tests and the frozen
  Valhalla answers in `fixtures/route.json`) moved from `frontend/worker/` to
  `frontend/src/routing/`, and `api.ts` runs it in the page. It reads Valhalla's answers as
  before, so routes come out the same.
- **Settings at build time.** `VITE_ROUTING_PROVIDER` (`valhalla` or `straight-line`) and
  `VITE_VALHALLA_ROUTE_URL`, from the environment or `frontend/.env`. The Deploy workflow
  takes them from repository variables of the same names, if they're set. An unknown provider
  is reported when the page opens, and every leg is then an estimate.
- **What the browser can't do.** It can't set `User-Agent` (and the FOSSGIS server's CORS
  rules would refuse a request that tried), so the server knows the site by the `Origin` and
  `Referer` the browser sends. The server also sees each user's IP address with the ends of
  each leg, where before it saw Cloudflare's.
- **Removed.** The Worker (`worker/index.ts`), `/api/route` and `/api/info` with their request
  checks and errors, the Vite plugin that answered them in `npm run dev`, router keys and
  their redaction, and openrouteservice, which can't work without a key.
  `frontend/wrangler.jsonc` now describes static assets only, and CI checks it with
  `wrangler deploy --dry-run`.
- **Checked.**
  - The six example trips, built in the app by script with the Worker and then without it,
    came out the same: the same legs, times and places, and the same routes to the metre for
    all 17 walk and bike legs (4 with heights).
  - The production build under `wrangler dev` served every file with its caching headers, and
    a 404 for a missing file and for `/api/route`. In Chromium the page listed departures and
    asked the FOSSGIS server for the walk to the stop itself, with no estimate, alert or page
    error.
  - The frontend's 432 tests (the 49 others were the Worker's request checks and
    openrouteservice's), type check and build passed.

### M13 notes

- **Why** (decision 22). To run the app for free, open to anyone, with no logins and no
  machine to keep running. The server's only real work was answering transit questions from
  its database; with the timetable small enough to download, the browser can answer them, and
  only walk and bike routes need a server: one small Cloudflare Worker.
- **The compact timetable** (`builder/`, `uv run ir-build-data`).
  - The full database is built from the feed as before (636 MB, or 607 MiB, on the November
    feed), and the timetable derived from it: 28.4 MB, 8.6 MB gzipped.
  - Where a trip goes (its shape, and its stops with their `stop_sequence`, pickup and
    drop-off types and shape distances) is stored once, as a *path*, and its running times
    along that path once, as a *pattern*. Each trip is its pattern and a start time. On the
    511 feed that's 93,174 trips over 2,506 paths and 13,445 patterns, in place of 3,191,827
    stop times.
  - Shapes are simplified to 5 m (Douglas–Peucker) and packed into one blob each, keeping
    252,614 of 1,340,496 points. The points the stops are placed at are always kept, with
    their index: simplified away, a stop would be placed at the nearest point left, which on a
    straight stretch can be kilometres off.
  - Before anything is written, the build checks that the timetable gives back every table
    the server read, all the stop times included, and that the shapes' ends and distances
    there match.
  - `manifest.json` names the file (`timetable-<hash>.sqlite.gz`, a new name whenever the data
    changes), with its sizes and SHA-256s, the schema version and each agency's dates. The
    browser checks the manifest on every visit and keeps the timetable until the name changes.
- **The queries, in the browser** (`frontend/src/timetable/`, with sql.js).
  - The server's queries were ported to TypeScript to give the same answers, field for field,
    ties included: its row order, yesterday's service day first, stable sorts, Python's way of
    comparing clock times on the night the clocks go back, and FastAPI's checks and error
    messages. `api.ts` calls them as it called the endpoints, so the rest of the app didn't
    change.
  - A differential test against the server, on the real data, found them all equal: 2,419
    randomized departure and arrival searches (39,912 calls), 3,670 trips, 9,157 line paths
    and 38,352 nearby stops. Only geometry differed, as simplified: trips' shapes within 5 m
    of the server's, and line previews, simplified again to 10 m from fewer points, at most
    about 16 m. A few `distance_m` values differed in the last bit (JavaScript's `Math.cos`
    isn't the C library's).
  - Departures take about 2 ms (13 ms at the 95th percentile) as the app asks for them.
  - The tests read a fixture built from the builder's synthetic feed, plus trips where order
    decides, and replay 100 requests the server answered on it (`expected.json`, recorded at
    commit 1c15be0 and frozen).
- **In a Web Worker.** At 3 km around Embarcadero, the departures and the paths of their lines
  took 110–167 ms, and held up the page that long when run in it. So the timetable is
  downloaded, opened and queried in a Web Worker (`timetable/worker.ts`, `remote.ts`). While
  it loads, the panel says how much has come ("Loading the timetable… 3.1 of 8.6 MB"); the map
  and the start point work meanwhile, and the departures appear by themselves. A failed
  download says why, with *Try again*.
- **One Cloudflare Worker** (`frontend/worker/`, `frontend/wrangler.jsonc`).
  - The site's files are static assets, served without running it. The Worker answers
    `POST /api/route` (walk and bike routes, through the server's routing providers, ported:
    Valhalla, ORS or a straight line) and `GET /api/info` (which router, for the footer). It
    takes and gives what the server did, and refuses what it refused with the same errors
    (`worker/fixtures/route.json`, recorded from the server and frozen).
  - The settings are its vars; keys are its secrets, and never in the page or a log.
  - A path with no file is a 404, as with the server, so a missing timetable is reported as
    missing rather than read as the page.
  - `npm run dev` answers `/api/*` with the Worker's own code through a Vite plugin;
    `npm run preview` runs the production build under `wrangler dev`.
- **Built and deployed by GitHub Actions** (`.github/workflows/`).
  - CI runs the builder's tests and lint and the frontend's tests, type checks and build, and
    bundles the Worker, on every push and pull request. It needs no secrets.
  - Deploy runs CI, builds the timetable from that day's feed and runs `npm run deploy`: on
    every push to `main`, every Monday at 12:23 UTC (4:23 a.m. in the Bay Area in winter) and
    by hand. If the build fails, nothing is deployed and the site keeps its timetable. One
    deploy runs at a time.
- **Removed.** The FastAPI server (its endpoints, models and `routing/` package), the Docker
  image, Compose file and start script, and `ir-load-gtfs` with its `--keep-fresh` refresher.
  The rest of the Python, which only builds the timetable now, moved from `backend/` to
  `builder/`.
- **Checked.**
  - The six example trips, built in the app by script as they had been with the server, came
    out the same, leg for leg: the same trips, stops, times, walks and rides. Transit legs'
    lines are within 5 m of the server's.
  - After the removals the same six trips came out the same again; the builder's and the
    frontend's tests, type checks and build passed; and the timetable rebuilt from the same
    feed was identical but for when it was built (byte for byte, given the old timestamps).
  - `npm run preview` (the production build under wrangler) loaded the page and the
    timetable and listed departures; `/api/info` and a walk answered; a missing file in
    `data/` was a 404; no page errors.

### M12 notes

- **Map clicks** (decisions 16 and 18).
  - A double-click (or double tap) on the map only zooms. A click on empty map waits 0.3 s
    (a tap 0.5 s, as long as the map waits for a second tap) to see whether another follows,
    and the second click of a slow double-click is dropped. Clicks on a line, or on a stop of
    the trip being chosen, act at once.
  - Once there's a start, a click or tap on empty map in Transit or Wait mode opens the same
    menu as a right-click: *Walk here* and *Bike here* (*Walk from here* and *Bike from here*
    backwards), with *Move the start here* first while there are no legs. A long press on a
    touch screen opens it too, and it stays open when you lift the finger. The first click
    with no start still sets one, and Walk and Bike mode still preview the point clicked.
  - A menu closes once it no longer offers what it says: the map's menu when you change
    direction, add a leg or open the summary, and *Which line?* when the list is found again
    or the filter hides its lines. Menus and line labels stay inside the map and are never
    wider than it; one that doesn't fit beside its point goes above or below it, slid along.
- **The start pin.**
  - Before the first leg the pin can be dragged, or moved with the arrow keys once it has
    focus (one move when you pause). Every move, by dragging, from the menu or with *Move*, is
    a step that *Undo* takes back ("Undo move start"). It restores the place and its name, and
    keeps any time you've set since.
  - A start you named keeps its name when it moves no more than 75 m, so a nudged Home is still
    Home (decision 20).
  - While moving, *Move* reads *Cancel*. Escape steps back one thing at a time, and is left to
    a field that has focus: an open map menu, then the summary, then moving the start, then a
    walk or bike leg waiting to be added, then the stop chooser.
- **The phone layout.**
  - Below 700 px wide the map stays at the top of the screen (38% of its height, at least
    160 px) and only the panel scrolls, so a line or stop chosen in the list shows on the map.
    A phone on its side (under 500 px tall) has the panel beside the map.
  - Map menus list at most 30% of the screen's height there, less on a short map, and scroll.
    They sit over the map's attribution.
  - On a screen 500 px tall or less, the missed-trip warning sits under the stop chooser's
    header rather than in it. On a 667x375 phone the stuck header went from 221 to 95 px,
    leaving 225 px for stops instead of 99.
  - Any device with a touch screen, touch laptops included, always shows *Remove this and the
    N after*, since a tap points and clicks at once.
- **Next leg and messages.**
  - After a leg is added from *Next leg* (or with *Walk here* on the map), the panel scrolls
    only as far as it takes to show the *Next leg* heading and buttons, smoothly unless the
    system asks for less motion. A line under the heading says what was added ("Added:
    Limited, Palo Alto Caltrain Station Northbound 9:10 AM → Millbrae …") until the plan next
    changes. Edits in the itinerary, *Undo* and *Clear plan* never scroll.
  - What the panel brings into view, and a control you Tab to, keep clear of the Undo bar and
    the stop chooser's header. Something taller than the room comes in from its top, and
    nothing scrolls for what's already in view. When the button you used goes away, keyboard
    focus moves to the *Next leg* or stop chooser heading, or to *Undo* after a removal, a
    merge or *Clear plan*.
  - Messages show where you're looking. A refusal or a "Routing unavailable…" notice about
    *Next leg* shows under its mode buttons. Refused switches, merges and time edits show
    under their leg, and a switch that had to move the end the leg keeps says so ("Walking
    takes 15 min, so it now leaves at 8:48 AM"). They go when you next do something. Errors
    about the app or an opened file show at the top of the panel.
  - The Walk and Bike card and the Wait panel are forms, so Enter adds the leg, and Escape
    cancels a walk or bike leg waiting to be added. Switching between Walk and Bike (or *Bike
    instead* / *Walk instead* on the card) routes the same point the other way and keeps its
    name; only the latest answer counts. Clicking the mode or the end already chosen changes
    nothing.
  - The Wait panel has 5, 10, 15 and 30 min buttons that add the wait at once. After a wait
    added there, *Next leg* goes back to the mode you had before Wait; the map's menu still
    leaves the mode alone.
  - Renaming a place keeps what you're building: a walk or bike leg waiting to be added (which
    takes the new name if it goes there), the stop chooser and the "Added:" line.
- **The stop chooser.**
  - Its header stays at the top of the panel while you scroll the stops: *← Lines*, the route
    and headsign, and where you board ("Boards at Sacramento St & Davis St, 9:09 AM"; "Gets
    off at …" backwards). The "Back to the list" button under the stops is gone. After a pick
    far down the list, the panel scrolls up to the chooser's heading.
  - The walk or bike ride to the trip's stop (from it, backwards) is routed as soon as the
    trip is picked, without holding up the stops. If it misses the trip, the header says so
    ("The walk to Palo Alto Caltrain Station Northbound takes 30 min, so you'd miss the
    9:25 AM.") and offers the line's next listed trip from that stop that the route makes
    ("Take the 9:55 AM instead", with its transfer note), or says that none can be made.
    Choosing a stop uses that route, as does the next pick at the same stop. The button only
    offers the same line from the same stop, so it isn't a suggested next leg (§2).
  - Back (*← Lines*, or Escape) puts the list back as you left it: the same scroll, the line's
    row where it was on screen even if something above the list came or went, and the focus
    on its line. The map eases back to where it was before you picked the trip, unless you've
    moved it yourself since (decision 15). Before, the row was usually off screen.
  - Stop times no longer wrap, and a stop with a one-line name takes 36 px instead of 56.
- **The transit list.**
  - It says what it searched: "Departures in the next hour within 500 m, up to 3 per line"
    (backwards, "Arrivals in the hour before 9:30 AM …"). A list that finds nothing says so,
    with *Search within 1 km* (twice the radius, up to 3 km; the field follows) and *Look 3
    hours ahead* (*back*), and suggests clicking the map to walk or bike towards a stop. Under
    a list, *Look 3 hours ahead* is offered up to 1.5 km, and *Just the next hour* undoes it.
    A search that stops at its 500-trip limit says that later lines may be missing.
  - *Filter lines* narrows the list as you type, by route name, headsign, stop or operator,
    ignoring case and accents. Words match from their start and numbers whole ("1" finds the 1
    and 1X but not the 10). Operators go by name, initials (BART, SFMTA) or a word people use
    (muni, ac, gg, caltrain, vta, samtrans, amtrak …), and vehicles by kind (bus, train, light
    rail, tram, ferry, cable car). Spaces mean every word must match; commas give alternatives
    ("bart, caltrain"). The map, its labels and *Which line?* show only the lines that match,
    and "9 of 73 lines · Clear" says how many are left. Escape in the field clears it. The
    filter never searches again.
  - The filter and the 3-hour window stay through the stop chooser and back, a new radius,
    and a wait or time edit at the same place. They go when the plan's end (its start,
    backwards) moves to another place, when the direction changes, and on *Clear plan* and
    *Open plan*. Neither is saved.
  - A line's label on the map, and each entry in *Which line?*, reads "9:03 AM · 38R 48th
    Avenue · Fremont St & Market St, 3 min walk": the trip a click takes, the stop and the
    walk or bike ride there, with any transfer note under it in its colour (decision 6).
    *Which line?* lists the lines in the list's order, and a single line's label ends "Click
    to take the 9:03 AM".
  - A list that loads, or comes back, under a resting pointer frames no line until the pointer
    moves and rests on a row (decision 15).
- **Editing and Undo** (decision 19).
  - *Undo* and *Clear plan* sit in a bar pinned to the bottom of the panel, so they stay on
    screen however long the itinerary gets. *Undo* names the step it undoes: "Undo add",
    "Undo remove", "Undo rename", "Undo merge", "Undo time change", "Undo switch to bike" (or
    walk), "Undo move start", "Undo clear plan" or "Undo open plan".
  - Ctrl+Z (Cmd+Z on a Mac) undoes too, except in a field, which keeps its own undo, while the
    summary is open, or while a request is under way. Holding the keys, or Enter on the
    button, undoes one step. Clicking *Undo* while typing a name or time saves what you typed,
    then undoes it along with the step the button named.
  - The history is saved under its own key a second after it last changed (or as the page is
    hidden), keeping the newest steps that fit in about a million characters. On load, a
    history saved with a different plan, or a damaged step and everything before it, is
    dropped; when storage is full, the plan wins. Opening a plan file keeps one step, back to
    the plan you had. Undoing *Clear plan* plans from the end you were at again.
  - Every wait you added can be removed wherever it is; an automatic wait fills its time. Any
    other leg in the middle goes with the legs beyond it, as one step: "Remove this and the 3
    after" ("… before" backwards), at the foot of its row, away from *Switch to walk / bike*
    (decision 21). With a mouse it shows only on the row you point at or tab into.
- **Names and leg rows.**
  - Once there are legs, Plan from is one line, "From [Home] · Tue Oct 20, 9:00 AM", or
    "Planned from" when the trip no longer begins there and then: legs added before the
    start, or the first legs removed or moved. A plan whose first ride leaves from a stop
    within 75 m still reads "From". The name is a field: Enter or leaving it renames the
    start, as one step, and Escape puts it back.
  - Place names in a leg (where a walk or bike ride goes, where a wait is, both stops of a
    ride) have a dotted underline. Click one, or Tab to it and press Enter, and type over it:
    Enter or clicking away renames the place everywhere, one step each, and Escape puts it
    back. The text is edited where it stands, so nothing moves and a click elsewhere lands
    where it was aimed. When the plan no longer begins at its start point, its first walk or
    bike row says where it leaves from ("Walk from [place] to Home"). *Rename places* stays,
    listing every place.
  - A walk or bike end picked on the map within 75 m of a place whose name you typed takes
    that name (decision 20). Near the other end of the plan (its start forwards, its end
    backwards) the point moves onto that place, so a round trip ends exactly where it began,
    unless you give it a name of its own in the card. Places remember whether you named them
    (`named`, in autosave and plan files); older files still open.
  - Walk, bike and wait legs show *Leave*, *Arrive* and *Minutes* (*From*, *Until* and
    *Minutes* for waits) side by side on one line. What can move shows only while one of the
    leg's fields has focus, in a small box over the leg's summary that takes no room: "Leave
    by 9:00 AM", "Can leave 8:25 AM–8:40 AM" or "Can't move without changing its length",
    then "up to 20 min, keeping the departure". A click on the box only ends the editing. At
    1280x1000 a walk row went from 248 to 103 px, a wait from 178 to 95 and the *Plan from*
    section from 201 to 25; with four legs, *Next leg* starts at 701 px instead of 1358.
- **Bug fixes.**
  - Renaming the start under *Rename places* now renames it in Plan from too, so autosave and
    *Clear plan* keep the new name.
  - While you type a year into the Time field (0002, 0020, 0202 …), nothing is searched and no
    coverage warning shows: a date more than 5 years from today counts as not typed yet, and a
    hint says so once you leave the field. A reload while the field is empty or half-typed
    keeps the start, the plan and the undo history.
  - Requests the backend refuses as invalid explain why in a sentence, not raw JSON.
  - *Before the start* survives a reload along with a plan that has legs.
  - The second click of a double-click only goes where the first one did. A double-click on
    *Remove* used to remove the leg, then click whatever moved under the pointer, and a
    double-clicked *Summary & export* closed the summary it had just opened.
  - A trip that loads after you've switched to another mode or end of the plan is no longer
    drawn on the map with its stops still clickable.
  - Clicking into a name and leaving it as it was no longer adds a step when the name has a
    space at the end, or two in a row, as some 511 stop names do. A stop name for the start
    that arrives after the first leg is added is no longer used.
- **Checked in a browser** on the 511 data, at 1280x1000 and on phone sizes:
  - each of the six stages had its own checks, and a review of them found problems in six
    areas (focus and scrolling, map menus and the pin, double-clicks, what *Next leg* keeps,
    Undo, names), all fixed and checked again;
  - the base journey (Palo Alto → Caltrain to Millbrae → bike to San Bruno → bus to Hillsdale
    → Caltrain to Palo Alto → walk home) took 17 clicks, 29 keystrokes, 4 panel scrolls and 9
    map gestures, against 20 / 41 / 10 / 9 before this work, and the walk home was called
    Home and ended exactly where the plan began;
  - 228 frontend and 85 backend tests pass, with no page errors.

### M11 notes

- **When it's offered.** Between two legs in a row of the same mode, walk, bike or wait, that
  meet at the same place (within 75 m). Never for transit, and never between different modes:
  a walk next to a bike ride, or a wait next to a walk, gets no button.
- **What a merge does** (decision 17).
  - Walks and bike rides keep both routes: one leg from the first start to the second end,
    whose distance, routed time and geometry add up. Hill profiles join end to end, and a
    profile only one of the two had is dropped, rather than shown for part of the ride.
  - Any two waits merge, automatic ones included. A wait you added followed by the automatic
    wait before a departure becomes one wait you own, from the first start to the departure.
    A merged wait stays at your wait's place, even when the automatic one before it was at a
    stop a few metres away.
  - The merged leg keeps the id and planned-from end of the leg you chose, so later time edits
    behave as before. *Undo* splits it again.
- **One merge per click.** Each button is tied to its pair of legs. A double-click, or a held
  Enter key, merges that pair only, even when the merged leg could merge with the next one.
- **Reviewed, then checked in a browser.**
  - Four reviewers looked at the change (plan rules, interface, the request itself, tests),
    and two skeptics checked each finding. Two confirmed findings were fixed: the wait's
    place, and double merges. The button now also names both legs for screen readers.
  - A plan with a coffee wait, Caltrain, two walks, two bike rides and two waits showed
    exactly four buttons. Merging all four went from nine legs to five, with the plan's
    start and end times unchanged.
  - A double-click, and a held Enter, on the first of three walks merged two of them.

### M10 notes

- **Lists load by themselves** (decision 15).
  - Transit's list is searched whenever the plan's end (or start), the direction, how you
    reach the stop, the radius or the start time changes. Each search waits 300 ms after the
    last change, so typing a radius searches once, when you pause.
  - A list is shown only for the search it answers: while a newer one is under way, the
    panel says *Finding departures…*. Coming back to Transit from another mode reuses the
    list without searching again.
  - A failed search says why, with *Try again*.
  - The map no longer moves when a list loads, which now happens after every change.
    Pointing at a row still frames its line, and the map goes back to where it was when the
    pointer leaves the list.
- **Right-click to walk or bike** (decision 16).
  - The menu follows *After the end* / *Before the start*: *Walk here* and *Bike here*, or
    *Walk from here* and *Bike from here*. It appears once there's a start point. Since M12
    a click on empty map in Transit or Wait mode opens it too.
  - The leg is routed and added at once, named after the nearest stop (or by coordinates;
    since M12 a place you named nearby comes first), and *Next leg* keeps its mode: after
    *Walk here* from the Transit panel, the departures from the new end are listed.
  - Escape, or a click elsewhere, closes the menu without doing anything else. Dragging
    with the right button still rotates the map.
- **Checked in a browser** on the 511 data, from Powell Street:
  - the list appeared within 2 s of setting the start;
  - typing a radius searched once, and returning from Walk mode searched none;
  - *Walk here* to Civic Center (10 min) kept the Transit panel and listed 55 lines from
    there; *Bike here* from the Wait panel kept it on Wait; *Walk from here* from Union
    Square was added before the start;
  - a search made to fail showed its error, and *Try again* recovered;
  - no page errors.

### M9 notes

- **What's drawn** (decision 14). Each line is drawn from its stop onwards when planning
  forwards, and up to its stop when planning backwards, with a dot at the stop. Its path
  arrives just after the list, which never waits for it.
- **How it looks.**
  - Previews are thin (3 px) and 60% opaque, under everything else.
  - The line pointed at, in the list or on the map, is drawn at full strength with a white
    halo, and the others fade further.
  - Planned rides stay bold with a dark edge. Dashes are kept for walking and cycling.
  - Pale route colours, such as BART's yellow and Caltrain's grey locals (26 of the 671
    routes), get a thin dark edge in place of the white one so they still show. The same
    goes for the stops of a trip being chosen.
- **Pointing and clicking.**
  - Pointing at a row highlights its line at once. The map frames it only once the pointer
    has rested on the row for 0.4 s (or keyboard focus has stayed in the row), so sweeping
    across the list or scrolling it never moves the map: rows that scroll under a still
    pointer don't count. Leaving the list goes back to the earlier view after 0.3 s (M10).
  - Pointing at a line on the map names it and marks its row without moving the map. Where
    lines overlap, all of them are highlighted and named. Since M12 each name comes with the
    time a click takes, the stop and the walk there.
  - Clicking a line picks its next trip (or last arrival). Where lines overlap, a small menu
    asks which; pointing at a choice highlights that line.
  - Once a trip is picked, its stops on the map can be clicked to get off (or on). Each names
    the stop and its time, and stops you can't use are smaller and grey.
  - Clicking a line never moves the plan's start, and a click away from the menu only closes
    it.
- **Speed**, on the 511 data: Powell Street at 500 m (61 lines) takes about 0.2 s and
  40 KB. Civic Center at 3 km (206 lines) takes about 0.5 s and 130 KB. Matching stops to
  shapes measures along the shape only when a stop needs matching by position.
- **Checked in a browser** on the 511 data:
  - forwards from Powell Street;
  - backwards from Palo Alto;
  - choosing lines and stops on the map, overlapping lines, going back to the list;
  - no page errors.

### M8 notes

The Docker setup was retired in M13, when the app became a static site; these notes are a
record of it.

- **One process.** The backend serves the built frontend (`IR_STATIC_DIR`, by default
  `frontend/dist`). The API routes come first, so the site can't shadow them.
- **The image.**
  - A Node stage builds the site, and a Python stage installs the backend with uv.
  - It runs as a non-root user, with the data in a `/data` volume.
  - It holds no settings or secrets: the 511 key comes from `.env` at run time, and
    `.dockerignore` keeps every `.env` out of the build.
  - The start script runs the data refresher in the background and the server in the
    foreground. Access logging is off, so the server keeps no record of where people search.
- **Keeping the data fresh** (`ir-load-gtfs --keep-fresh DAYS`).
  - Every 6 hours it rebuilds the database if it's missing, from an older version of the app,
    or older than `DAYS` (7 by default).
  - It downloads the feed again only if the downloaded copy is that old too, so restarts and
    app updates don't fetch it needlessly.
  - A failed attempt is retried an hour later.
  - A download that isn't a zip (an error page sent as a success, say) is rejected, keeping
    the copy we have.
- **Compose.** The app is reachable on this machine only by default (`BIND`, `PORT`), with a
  health check on `/api/health`. The `tunnel` profile adds `cloudflared`, which reaches the app
  as `http://app:8000`. Cloudflare Access, set up in the dashboard, limits who can open it.
- **Checked by building and running it here.**
  - The image is 276 MB and contains no `.env`, database or key.
  - On the first start it downloaded and built the 511 data in about a minute, and the health
    check turned healthy. Meanwhile the app answered with a message explaining the wait.
  - After a restart it didn't download again.
  - In a browser, the production build served by the container worked: the map, the
    departure search and the API, with no page errors.
  - The tunnel service's configuration is valid and cloudflared reads `TUNNEL_TOKEN`. The
    tunnel itself needs your Cloudflare account to try.

### M7 notes

- **511 only.** `ir-load-gtfs` downloads the regional feed (it needs `API_511_KEY`) and builds
  from it, and `--skip-download` rebuilds from the downloaded copy. The agency feed list,
  `GTFS_SOURCE` and the per-feed arguments are gone. `--source 511` is still accepted, so older
  instructions keep working.
- **Valhalla by default.** An `ORS_API_KEY` alone no longer switches the router; ORS needs
  `ROUTING_PROVIDER=ors`.
- **Height profiles.**
  - Valhalla returns heights every 30 m along bike routes. They are stored with the leg, so
    they survive autosave, Save plan and Open plan.
  - A ride with a significant hill (§7) shows a small silhouette and its climb and descent, in
    the preview and the itinerary. "climbs 100 m · descends 8 m" also appears in the summary,
    the printout, the CSV and the calendar file.
  - Walks get no profile, and switching a ride to walking removes it.
  - Checked against the live server: Embarcadero to Nob Hill rises from 4 to 106 m (climbs
    100 m, descends 8 m), and Castro to Twin Peaks from 37 to 255 m. Palo Alto Caltrain to
    Stanford goes from 19 to 34 m and shows no profile.
- **JSON plans** (from M5) are the way to keep and share plans (decision 12). A saved,
  cleared and reopened plan keeps its bike heights, shapes and agency names.

### M6 notes

- **Getting to the stop by bike.** The transit panel has a *Get to the stop by Walking /
  Bike* toggle (*Leave the stop by* when planning backwards).
  - It decides which trips count as reachable, and how the connection leg is routed.
  - Any walk or bike leg can be switched to the other mode later. The new route keeps the leg's
    anchored end if the new duration fits, otherwise its other end if that one is free, and is
    refused otherwise.
  - Reachability estimates and legs both round up to whole minutes, so the list and the leg
    agree when the route matches the estimate.
  - If the real route is slower and misses the trip, adding the trip is refused, and the
    message gives the routed time. Since M12 the stop list says so as soon as the trip is
    picked, and offers the line's next trip that the route makes.
- **Editing times.** Walk and bike legs have *Leave*, *Arrive* and *Minutes* fields. Manual
  waits have *From*, *Until* and *Minutes*. See decision 2 for what can move. Since M12 the
  fields sit on one line, and what can move shows while one of them has focus.
- **511 regional feed.** Added alongside the agencies' own feeds; in M7 it became the only
  source.
  - The key is sent as a request parameter and never printed, including in error messages.
  - Routes carry their agency's name, shown in lists, the itinerary, the summary and the CSV.
  - Checked on the real feed (2026-10-10): 41 agencies, 21,627 stops, 90,168 trips and
    3.1 million stop times. Downloading and building took 62 s, giving a 619 MB database.
    Departures for Caltrain, BART and VTA at six shared stations match the agency feeds
    exactly. Queries take 5–25 ms.
  - Dates are tracked per agency. The regional feed's overall range (2021–2099) says nothing,
    while VTA's schedule in it ends on 2026-10-25. The load summary lists agencies whose
    schedules end within 30 days, and the app names any agency whose schedule doesn't cover
    the plan's day.
- **Shapes.**
  - The trip endpoint returns the trip's shape and where each stop falls on it. Stops are
    placed by `shape_dist_traveled` where the feed gives it (Caltrain, and 98% of VTA's
    stops), and matched geometrically otherwise (BART). The matcher always moves forward along
    the shape and is bounded, so loops and routes that double back are handled.
  - Distances are checked against the geometry. Capitol Corridor's stop distances run 5 km
    ahead of its shapes from Richmond on, so a stop placed more than 100 m away by distance
    is matched geometrically instead.
  - A stop more than 500 m from the shape isn't on it. SFO AirTrain's Red line shape skips
    three of its stops, for example. Such a stop gets no index, and rides to or from it are
    drawn stop to stop.
  - Across all 41 agencies in the 511 feed (about 1,000 sampled trips, 19,000 stop calls),
    stops sit a median of 0–28 m from the shape, and 171 m at worst. A trip query, matching
    included, takes 1–7 ms.
  - Transit legs store the ridden part of the shape. The map, the trip preview and the
    printed map follow the track.
- **Renaming places.** *Rename places* under the itinerary lists every place in the plan,
  stops included. A new name applies everywhere the place appears, and can be undone. Since
  M12 a name can also be changed where a leg shows it.
- **Map picture.** Opening *Summary & export* fits the map to the plan and captures it as an
  image. The image appears in the summary and on the printed page. The plan's start and end
  are drawn into the map itself so they show in the picture.
- **Pale route colours.** Rides get a dark edge on the map. Without it, routes in pale
  colours barely showed against the map: Caltrain's grey locals (`dcddde`), its Limited and
  BART's yellow.
- **Departures by line** (decision 8). With every operator loaded, a 500 m radius downtown
  takes in hundreds of trips an hour. A list cut at 40 trips covered only the next 10 minutes
  at Powell, mostly Muni.
  - The API's `per_route` option keeps the first few trips of each route, headsign and stop
    before applying the overall limit. The app asks for 3 per line, up to 500 in all.
  - The list shows one row per line with a button for each time. Transfer notes sit under
    the row, with the time they apply to.
  - At Powell this gives 61 lines and 172 trips, covering the whole hour. Even at 3 km,
    downtown stays under 400 trips.
- **Transfer warnings.** When you extend the plan from a transit leg, the departure (or
  arrival) list shows the agency's `transfers.txt` rule for each candidate:
  - a warning when the connection is shorter than the minimum, or when the agency rules the
    transfer out;
  - a note for timed transfers.

  Rules can be for a platform or its parent station, and limited to routes or trips; the most
  specific matching rule wins. The 511 feed has few rules, and none between agencies
  (decision 11):
  - Caltrain's timed transfers at San Jose Diridon.
  - BART's platform rules at 12 stations. Most are 0 minutes. Coliseum ↔ the Oakland
    Airport line is 4 minutes, and some route pairs at Warm Springs and Union City are 1
    minute.
  - A few timed transfers for WestCat and FAST.
- **Database version.** The database records its schema version. After an update that changes
  the tables, the app says to rebuild (`uv run ir-load-gtfs --skip-download`) instead of
  failing.

### M3–M5 notes

- **Picking points.** For walk and bike legs you click the map, and the route is previewed (a
  dashed purple line) before you add it. A picked point is named after a stop within 150 m
  ("Near Hamilton & High"), or otherwise by its coordinates; since M12 a place you named
  within 75 m comes first (decision 20). You can edit the name before adding the leg. The
  start point's name could be edited only until the first leg was added; since M12 any name
  can be changed where it's shown.
- **Durations** from the router are rounded up to whole minutes. That matches timetables and
  keeps connections on the safe side.
- **Which end stays fixed** is stored on each leg:
  - Legs planned forwards keep their departure.
  - Legs planned backwards keep their arrival.
  - Walks to or from a stop always leave immediately (decision 1).
- **Removing.** At first only the first and last legs you chose could be removed, because
  removing one in the middle would leave a gap. Since M12 a leg in the middle goes with the
  legs beyond it, and a wait you added can be removed anywhere (decision 21). Undo steps back
  through every change, including Clear plan and Open plan (decision 19).
- **Summary & export.**
  - The summary table lists every leg, including waits. Printing shows only the table.
  - CSV has one row per leg, in Bay Area local time. It starts with a byte-order mark so
    Excel reads it as UTF-8. Names starting with `=`, `+`, `-` or `@` are prefixed so
    spreadsheets don't run them as formulas.
  - The calendar file (.ics) has one event per leg you chose. Connection waits are left out,
    since they show as gaps.
  - JSON files are versioned (`incremental-routing-plan`, version 1). Opening one validates it
    and rebuilds the waits.
- **Autosave.** The current plan and start point are kept in this browser (localStorage) and
  restored on reload, and since M12 so are the direction and the undo history. This is per
  browser and best effort, so use Save plan (.json) to keep or move a plan.
- **Browser test on real data** (Monday 2026-10-12):
  - Backwards from Home at 7:30: Rapid 522, a walk to a coffee shop, then a walk home.
  - Forwards from Home: a walk, Caltrain Express to Millbrae, a bike to an office, and a
    15-minute wait.
  - Also checked: duration limits, Remove and Undo, the summary, all three downloads, the
    print layout, reloading and re-opening the file.
  - At the time, walk and bike legs used the straight-line estimate, because the routing hosts
    were blocked in the cloud sandbox.

### M2 notes

- If the walking router fails, connector walks fall back to the straight-line estimate and are
  labelled "(estimated)".
- Same-station changes need no walk leg when the platforms are within 75 m. Millbrae's
  Caltrain platform and BART's "Caltrain Transfer Platform" are an example.
- The departure list leaves out the trip you have just got off.
- Searches start exactly at the frontier time, so a 0-minute change can be offered. Transfer
  warnings followed in M6.

### M1 findings (the agencies' own feeds, downloaded 2026-10-10)

- **Loading.** Downloading and building all three feeds takes about 10 s and produces a 50 MB
  SQLite file.

  | Feed | Valid dates | Total trips | Trips on Mon 2026-10-12 |
  | --- | --- | --- | --- |
  | Caltrain | 2026-01-31 to 2027-01-31 | 260 | 112 (66 on Saturday) |
  | BART | 2026-08-10 to 2027-01-10 | 4,417 | 1,021 |
  | VTA | 2026-08-10 to 2026-10-25 | 9,432 | 3,931 |

  VTA's feed expires soon, so re-download it once VTA publishes the next one.
- **Integrity.** No stop times without a time, and no references to missing stops or routes.
  Times run up to 27:12 (trips past midnight).
- **Query speed.** A 60-minute departure search takes 1–18 ms. The slowest are Palo Alto and
  downtown San Jose, which return 100+ departures.
- **Spot checks.**
  - Northbound Caltrain Express leaves San Jose at 07:22 and reaches SF at 08:22, with the
    express stopping pattern.
  - At 00:30 the departure list correctly includes trains belonging to the previous service
    day.
  - Weekday, Saturday and holiday calendars select the right trips.
- **Bugs found and fixed.**
  - BART's stale `feed_info.txt` caused a false "expired" warning.
  - MapLibre v6 couldn't find its worker once Vite bundled it, so the map showed only its
    background colour. Fixed with `setWorkerUrl`.
- **Closed.** No hand-check against published timetables is needed, because 511 is the
  source of truth (decision 9). Live walk and bike routing works, on your machine and in the
  cloud sandbox since Valhalla was allowed there.

## 9. Decisions and risks

**Decisions** (settled 2026-10-10):

1. **Connector walk timing: leave immediately.** The walk to a stop starts at the frontier
   time, and any spare time becomes a wait at the stop.
2. **Edits never create overlaps.** Walk, bike and manual wait legs can be shortened freely;
   shortening opens a wait. They can be lengthened or moved only until they would run into
   the leg on either side, and edits past that are refused rather than flagged. Nothing
   ripples.
   - *Refined after testing:* an end of a leg is fixed only when it meets a transit leg
     directly (no wait between them). Next to a wait, or at an open end of the plan, both the
     departure and the arrival can be edited.
   - Moving one end shifts the whole leg, keeping its duration, when the other end is free;
     otherwise it changes the duration.
   - Changing the duration keeps a fixed end in place, or otherwise the end the leg was
     planned from.
   - This works the same when planning backwards.
3. **Search radius is configurable.** It defaults to 500 m, and the UI offers 100 m to 3 km.
4. **Bikes are informational only.** A transit leg on a trip with `bikes_allowed = 2` (not
   allowed) shows a warning and nothing else changes. Riders may have a folding bike or
   scooter, may park, or may use bikeshare, and modelling any of that is out of scope. In the
   511 feed (October 2026) this affects 1,339 trips: every SFO AirTrain trip, 66 VTA bus
   trips and 5 LAVTA school trips.
5. **Connections to stops can be by bike** (added after testing). This is chosen while
   planning a transit leg, and any walk or bike leg can be switched later.
6. **Transfer rules are advice.** `transfers.txt` minimums show as warnings in the departure
   and arrival lists, and on the map's labels and *Which line?* menu for those lines. Choosing
   a warned connection is allowed.
7. **Schedules only.** The tool plans future trips, so live data would add complexity
   without helping. Only static GTFS schedules are used.
8. **Departures by line.** The departure and arrival lists show each line nearby (a route,
   headsign and stop) once, with its next three trips in the hour searched, or its last three
   arrivals when planning backwards. The hour can become three on request. Busy lines can't
   crowd out the rest; a line's later trips are left out.
9. **511 is the source of truth.** The regional feed is the only transit data, and the
   agencies' own feeds are retired. Departures aren't checked by hand against printed
   timetables.
10. **Valhalla's times are used as they are.** They already allow for hills. Hilly bike rides
    get a simple height profile, shown only for a climb or descent of at least 20 m.
11. **Changes between agencies are up to the rider.** At Millbrae, Diridon and Mountain View
    each agency has its own stops, 100–300 m apart, and no feed gives transfer rules between
    agencies. The connector walk covers the distance; the rider judges the time.
12. **Plans move as JSON files.** No accounts, saved-plan lists, shareable links or bike
    share. *Save plan (.json)* and *Open plan…* cover keeping a plan and sending it to
    someone.
13. **Shared as a public website, with no logins** (revised in M13). The app is a static site
    on Cloudflare's free plan, on the owner's domain, and anyone with the address can use it.
    Each person's plans stay in their own browser, and the site stores none of them. Anyone
    can deploy their own copy, with their own 511 key and Cloudflare account; the code is
    MIT-licensed. *Until M13:* the app ran in Docker on a Linux home server, reached through
    a Cloudflare tunnel, and Cloudflare Access let in only the listed email addresses.
14. **Previews show where each line can take you.** While you choose a ride, each line in the
    list is drawn from its stop to the end of its trip (or, planning backwards, from the start
    of its trip to the stop). Where a line runs both ways along the same streets, its two
    directions together show the whole line; where they differ, each shows only its own
    onward route. Previews are thin and see-through in the line's colour, so they can't be
    mistaken for planned rides.
15. **Lists follow the plan.** There's no search button. The departure or arrival list is
    found again whenever the plan or the search settings change. *Search within 1 km* and
    *Look 3 hours ahead* only change the settings, and *Filter lines* only narrows what was
    found. The map stays where you put it when a list loads; only resting the pointer on a
    row frames a line, once the pointer has moved, and going back from the stop chooser
    returns the map to where you had it.
16. **A click on the map adds walk and bike legs at once.** Once there's a start, a click on
    empty map in Transit or Wait mode, or a right-click (or long press) in any mode, opens a
    menu that follows the direction toggle; before the first leg it offers *Move the start
    here* first. Its leg skips the preview and is named after a place you named nearby
    (decision 20), a stop nearby or its coordinates, and the *Next leg* panel keeps its mode.
    *Undo* and renaming the place where it's shown fix a wrong click or name.
17. **Merging joins legs as they are.** Two walks, bike rides or waits in a row become one leg
    that follows both routes, so no times change and nothing else in the plan moves. It isn't
    re-routed; a direct route would be a new leg. Automatic waits merge too.
18. **A click on empty map asks rather than acts.** Once there's a start, a single click that
    hits no line or stop never moves the start or adds a leg by itself: in Transit or Wait
    mode it opens the map's menu, and in Walk or Bike mode it previews a route there. A
    double-click only zooms. The start moves only when you drag its pin, choose *Move the
    start here* or use *Move*, and each move is a step *Undo* takes back.
19. **Undo names its step and survives reloads.** Every change is one step, named on the
    button ("Undo rename"), and Ctrl/Cmd+Z undoes too outside a field. The history is saved in
    the browser beside the plan, and dropped if it doesn't lead to the plan restored. Opening
    a plan file keeps only the step back to the plan you had. Undoing a move of the start
    keeps the time, since changing the time isn't a step of its own.
20. **Names you typed are reused for points within 75 m.** A new walk or bike end within 75 m
    of a place whose name you typed takes that name, and near the plan's other end it moves
    onto that place, so a round trip closes; a name of its own, typed in the card, keeps it
    where you clicked. Stops, even renamed ones, and names made from a stop or coordinates
    never lend theirs. A start you named keeps its name through moves of up to 75 m.
21. **Removing never leaves a gap.** A wait you added can be removed on its own anywhere, and
    an automatic wait fills its time. Any other leg in the middle goes with every leg beyond
    it in the planning direction, as one step. The legs that stay keep their times
    (decision 2).
22. **A static site: the timetable runs in the browser** (M13). The whole timetable is built
    into one compact file (8.6 MB gzipped), which the browser downloads once, keeps, and
    searches itself with sql.js, in a Web Worker. Walk and bike routes come from one
    Cloudflare Worker, which keeps any router key. There is no server, database or container
    to run: Cloudflare serves the files for free, and a GitHub Actions workflow rebuilds the
    timetable from 511's feed and redeploys every Monday and on every push to `main`. The
    browser's queries give the server's answers exactly (but for shapes, simplified to 5 m),
    and the server is gone. The cost is the first visit's download, and a timetable up to a
    week older than the feed.
23. **Walk and bike routes come straight from the browser** (M14). The page asks the routing
    server itself, not through a Worker. The public FOSSGIS Valhalla server takes requests from
    any site, so the site is static files only and any host can serve it. Each user's
    requests count against the server's fair-use limits on their own, not all together from
    Cloudflare's addresses, and there's no `/api/route` for others to use. The costs: no key
    can be kept secret, so only routers without one work (if one with a key is ever needed,
    each user would bring their own); the routing server sees each user's IP address with the
    ends of each leg; and changing the router means a rebuild.

**Risks:**

- **Schedules run out.** Each agency's schedule in the 511 feed ends on its own date (VTA's on
  2026-10-25). The build and the app flag it, and the weekly deploy picks up the new schedule
  once the agency has published it.
- **Open to anyone.** With no logins, anyone who finds the address can use the site, and with
  it the public Valhalla server, which counts each user's requests on their own. A few people
  are well within fair use; heavy use would need a routing service with a key, which users
  would bring themselves (decision 23).
- **The weekly refresh can stop.** A failed build deploys nothing, so the site keeps a
  timetable that grows older until a run succeeds; GitHub emails the owner about each
  failure. In a public repository GitHub also turns schedules off after 60 days without
  activity.
- **The first visit downloads 8.6 MB.** On a slow connection the departures take a while to
  appear the first time (the panel shows the progress). Cloudflare serves files of up to
  25 MiB, so the timetable has room to grow.
- **Free services without an SLA** (511.org, FOSSGIS Valhalla, OpenFreeMap, Cloudflare's free
  plan, GitHub Actions). Their quotas are fine for a few people. The provider interface and
  the style URL make the router and the map swappable.

## 10. What's next

**On hold**

- Place search: stations by name, and addresses (§5.4).
- Self-hosted walk and bike routing, to remove quotas. The public server's limits are fine for
  now.

**Declined**

- A "Suggest" button that asks a journey planner for the next leg or two (§2).
- Bike share, saved-plan lists and shareable links (decision 12).
- Live data (decision 7).
- The map following the plan's end: framing the open end after each change instead of the
  whole plan (proposed in the review before M12).
- Arrivals saying where trips come from: rows in the arrivals list such as "Red-S Millbrae ·
  from Richmond" (proposed in the review before M12).
