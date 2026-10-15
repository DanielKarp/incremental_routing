# Incremental Routing: plan

A route planner for building a multi-leg trip **one leg at a time**, mixing public transit with
cycling and walking. Instead of asking a journey planner for "the best route", you choose
every leg yourself and the app keeps the itinerary consistent in space and time.

This document describes the planner as built (the MVP plus two rounds of refinements,
packaged for Docker), the data sources and decisions behind it, and what might come next.

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

- A few people, in a browser. It runs on a home server and is shared through a Cloudflare
  tunnel, or a technical friend runs the same Docker setup on their own machine (decision 13).
  There are no accounts: each person's plans stay in their own browser.
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

1. Click the map and set a time. That's the anchor, and it becomes the frontier.
2. Choose a mode for the next leg:
   - **Transit**: see departures from stops near the frontier after its time, grouped by line
     (decision 8). They're listed as soon as Transit is chosen, and again whenever anything
     they depend on changes (decision 15). Only trips you can still reach on foot or by bike
     are shown. The map draws each of those lines from its stop onwards (decision 14). Pick a
     trip, in the list or by clicking its line on the map. Then pick the stop to get off at from that trip's remaining
     stops, in the list or on the map.
     - If the boarding stop isn't at the frontier, the app inserts a walk or bike ride to the
       stop. It starts right away, and a wait fills any time left before the departure.
   - **Walk / Bike**: click the destination. The router returns a path and duration. You can
     edit when the leg leaves or arrives, or how long it takes, and a hilly bike ride shows a
     height profile. From any mode, a right-click on the map adds a walk or bike leg there
     at once (decision 16).
   - **Wait**: stay put for N minutes, e.g. a coffee stop.
3. The new leg's end becomes the frontier, and step 2 repeats.
4. Any time gap between two legs is filled with an automatic **wait** leg. For example, a bike
   leg reaches the station at 7:50 and the train leaves at 8:00.

### Backward

This is the same flow mirrored. You see **arrivals** at stops near the frontier before its time,
with each line drawn up to its stop, pick a trip, then pick where you got on from its earlier
stops. The walk or bike ride from the
stop to the frontier leaves as soon as you get off, and any spare time becomes a wait at the frontier
(decision 1, mirrored). Walk, bike and wait legs you add keep their **end** time fixed and
compute the start time.

### Leg types

| Mode | Start / end chosen by | Times come from | Editable |
| --- | --- | --- | --- |
| Transit | Departure (or arrival) list or a line on the map, then a stop on that trip | Timetable | No: fixed by the schedule |
| Walk, Bike | Frontier, then a map click (or a right-click, from any mode) | Routing API (Valhalla) | Departure, arrival or duration, within its neighbours (decision 2). Two in a row of the same mode can merge (decision 17) |
| Wait | Same place at both ends | Gap between legs, or manual | Manual waits only. Any two waits in a row can merge |

## 4. Data model

```ts
interface Waypoint { place: { lat; lon; name?; stopId? }; time: string /* ISO, with offset */ }
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

**Where state lives.** The plan lives in the browser: React state, autosaved to localStorage,
and exportable as JSON. The backend is a stateless facts service ("what departs from here?",
"how long is this ride?"). For a single-user local app this keeps the backend trivial and makes
the plan rules pure functions that are easy to test.

## 5. Data sources

### 5.1 Transit: the 511 regional GTFS feed

The **511 SF Bay regional feed** is the source of truth (decision 9). It is one consolidated
GTFS feed for every Bay Area operator, from the [511 SF Bay open data
API](https://511.org/open-data/transit) (`operator_id=RG`). On 2026-10-10 it held 41 agencies,
21,627 stops, 90,168 trips and 3.1 million stop times. It needs a free API key
(`API_511_KEY`).

`uv run ir-load-gtfs` downloads it (about 60 MB) and builds one SQLite file (about 620 MB) in
about a minute. The feed is defined in `backend/src/incremental_routing/gtfs/feeds.py`. The
agencies' own Caltrain, BART and VTA feeds were used until M6, and are no longer supported.

**Freshness.** Each agency's schedule in the feed ends on its own date, and 511 republishes the
feed as agencies update. The feed's overall date range (2021–2099) says nothing, so dates are
tracked per agency:
- the loader lists agencies whose schedules end within 30 days, and flags expired ones;
- the UI names any agency whose schedule doesn't cover the day being planned.

Re-run the loader monthly. In October 2026, VTA's schedule ends on 2026-10-25.

Dates come from the service calendars, not from `feed_info.txt`, which publishers forget to
update. BART's own August 2026 feed still declared an end date of 2026-08-30, while its
calendar ran to 2027-01-10.

**GTFS details the loader and queries handle:**

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

All providers sit behind one `RoutingProvider` interface
(`backend/src/incremental_routing/routing/`), selected by `ROUTING_PROVIDER`:
- `valhalla` (the default): the FOSSGIS server, or any Valhalla endpoint such as Stadia Maps.
- `ors` (needs `ORS_API_KEY`): openrouteservice. Its hosted bike times ignore hills, and it
  returns no heights, so there are no profiles.
- `straight-line`: an estimate for offline development and tests. It is also the fallback when
  the router fails, labelled "(estimated)".

One user making one request per walk or bike leg is well within fair use. Quotas are fine for
now, and self-hosted routing is on hold (§10).

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
Browser: React + MapLibre                       Backend: FastAPI (Python)
┌──────────────────────────────┐                ┌──────────────────────────────────────┐
│ plan/  pure plan rules (TS)  │   GET /api/    │ gtfs/query.py  ──▶ data/gtfs.sqlite  │
│ components/  map, lists,     │ ─ departures ─▶│                       ▲              │
│   leg builder, itinerary     │   arrivals     │ ir-load-gtfs ─────────┘ (download +  │
│ localStorage + JSON export   │   trip         │                         build)       │
│                              │   POST /lines  │                                      │
│                              │   POST /route ▶│ routing/ ─▶ Valhalla | ORS | straight│
└──────────────────────────────┘                └──────────────────────────────────────┘
```

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Whether GTFS data is loaded (and if not, why), and the routing provider |
| `GET /api/feeds` | Loaded feeds, with each agency's schedule dates |
| `GET /api/stops/nearby?lat&lon&radius_m&access` | Boardable stops near a point, with the time to reach them on foot or by bike |
| `GET /api/departures?lat&lon&time&radius_m&window_min&limit&access&per_route&transfer_stop&transfer_trip` | Trips you can reach and board after `time` (forward), each with any transfer rule |
| `GET /api/arrivals?…` (same parameters) | Trips you can ride to arrive before `time` (backward) |
| `GET /api/trip?trip_id&service_date` | A trip's stops with times and board/alight flags, and its shape |
| `POST /api/lines {direction, trips}` | For the map: the part of each listed trip you could ride from its stop (forward) or to it (backward), simplified |
| `POST /api/route {mode, origin, destination}` | Walk or bike path, distance and duration, with heights along bike routes |

**Deployment.** One Docker image holds everything. The backend serves the built frontend at
`/` and the API under `/api/`, and `ir-load-gtfs --keep-fresh` runs beside it to keep the
transit data current. `compose.yml` runs the image, keeps the data in a volume, and optionally
adds a Cloudflare tunnel (`--profile tunnel`). Settings come from one `.env` at the repository
root, which Compose and the backend both read.

Times without an offset are read as Bay Area local time, and responses carry the offset
(`-07:00` or `-08:00`). The UI always shows Bay Area time, whatever time zone your laptop is in.

**Why this shape.** SQLite needs no database server, and departure queries hit a
`(stop_id, departure_s)` index, so they should be fast at this scale. The backend does
the GTFS work, where Python's tooling is strongest. All plan logic is pure TypeScript, so it is
fast to iterate on and easy to unit-test.

## 7. Key algorithms

**Departures near a point** (`GtfsStore.departures`):

1. Find boardable stops within the radius: a bounding box from an index, then exact
   distance.
2. For each feed, and for service days *yesterday* and *today*: work out the active
   `service_id`s, then run a time-window query on stop times.
3. Drop departures you can't reach in time: straight-line distance × 1.3 detour factor, at
   1.3 m/s on foot or 4.5 m/s by bike, rounded up to whole minutes.
4. Keep one entry per trip, at its nearest stop, sorted by time. With `per_route`, keep only
   the first few trips of each route, headsign and stop before the overall limit.

Arrivals are the mirror image: alighting allowed, arriving at least the access time before the
query time.

**Choosing where to get off:** `/api/trip` returns every stop with absolute times. The UI lists
stops after the boarding stop where `can_alight` is true (forward), or stops before the alighting
stop where `can_board` is true (backward).

**Line previews** (`GtfsStore.lines`): for each line in the list, the UI sends the trip it
stands for (the next departure, or the last arrival when planning backwards) and its stop. The
backend cuts that trip's shape from the stop to the trip's last stop (forward), or from its
first stop to the stop (backward). It matches stops to the shape as `/api/trip` does, and runs
stop to stop when the shape can't be used. Each path is then simplified to within 10 m
(Douglas–Peucker), which keeps 60 lines to about 40 KB.

**Connector walks:** when the chosen stop isn't at the frontier, the UI requests a walk or bike
route from the frontier to the stop and adds it as a leg. `withWaits` then fills the remaining time.

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
| M8 ✅ | Docker and sharing | One image serves the whole app and keeps its data fresh. Compose runs it at home or on a friend's machine, with an optional Cloudflare tunnel. MIT licence. |
| M9 ✅ | Line previews | While you choose a ride, the map shows every line in the list, faded in its own colour, with the stop to catch it. Pointing at a row highlights and frames its line, and pointing at a line marks its row. Lines, and the stop to get off at (or on), can be picked on the map. |
| M10 ✅ | Fewer clicks | The departure (or arrival) list loads by itself. A right-click on the map adds a walk or bike leg there straight away. |
| M11 ✅ | Merge legs | Where two walks, two bike rides or two waits meet, a button between them joins them into one leg. |

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
    *Walk from here* and *Bike from here*. It appears once there's a start point.
  - The leg is routed and added at once, named after the nearest stop (or by coordinates),
    and *Next leg* keeps its mode: after *Walk here* from the Transit panel, the departures
    from the new end are listed.
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
    lines overlap, all of them are highlighted and named.
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
    message gives the routed time.
- **Editing times.** Walk and bike legs have *Leave*, *Arrive* and *Minutes* fields. Manual
  waits have *From*, *Until* and *Minutes*. See decision 2 for what can move.
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
  stops included. A new name applies everywhere the place appears, and can be undone.
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
  ("Near Hamilton & High"), or otherwise by its coordinates. You can edit the name before
  adding the leg. The start point's name can be edited until the first leg is added.
- **Durations** from the router are rounded up to whole minutes. That matches timetables and
  keeps connections on the safe side.
- **Which end stays fixed** is stored on each leg:
  - Legs planned forwards keep their departure.
  - Legs planned backwards keep their arrival.
  - Walks to or from a stop always leave immediately (decision 1).
- **Removing.** Only the first and last legs you chose can be removed, because removing one
  in the middle would leave a gap. Undo steps back through every change, including Clear plan
  and Open plan.
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
  restored on reload. This is per browser and best effort, so use Save plan (.json) to keep or
  move a plan.
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
   and arrival lists only. Choosing a warned connection is allowed.
7. **Schedules only.** The tool plans future trips, so live data would add complexity
   without helping. Only static GTFS schedules are used.
8. **Departures by line.** The departure and arrival lists show each line nearby (a route,
   headsign and stop) once, with its next three trips, or its last three arrivals when
   planning backwards. Busy lines can't crowd out the rest; a line's later trips are left
   out.
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
13. **Shared from a home server; installable with Docker.** The app runs in Docker on a Linux
    home server, reached through a Cloudflare tunnel, and Cloudflare Access lets in only the
    listed email addresses. Technical friends can run the same setup on their own machine,
    with their own 511 key. The code is MIT-licensed.
14. **Previews show where each line can take you.** While you choose a ride, each line in the
    list is drawn from its stop to the end of its trip (or, planning backwards, from the start
    of its trip to the stop). Where a line runs both ways along the same streets, its two
    directions together show the whole line; where they differ, each shows only its own
    onward route. Previews are thin and see-through in the line's colour, so they can't be
    mistaken for planned rides.
15. **Lists follow the plan.** There's no search button. The departure or arrival list is
    found again whenever the plan or the search settings change. The map stays where you put
    it when a list loads; only resting the pointer on a row frames a line.
16. **Right-click adds walk and bike legs at once.** The menu follows the direction toggle.
    Its leg skips the preview and is named after a stop nearby (or by coordinates), and the
    *Next leg* panel keeps its mode. *Undo* and *Rename places* fix a wrong click or name.
17. **Merging joins legs as they are.** Two walks, bike rides or waits in a row become one leg
    that follows both routes, so no times change and nothing else in the plan moves. It isn't
    re-routed; a direct route would be a new leg. Automatic waits merge too.

**Risks:**

- **Schedules run out.** Each agency's schedule in the 511 feed ends on its own date (VTA's on
  2026-10-25). The loader and the app flag it, and re-running `ir-load-gtfs` fixes it once the
  agency has published a new one.
- **No logins of its own.** The app trusts whoever reaches it. Cloudflare Access is what keeps
  the shared copy private, and the app listens on the local machine only by default.
- **Home server uptime.** The shared copy is up only while the home server and its internet
  connection are.
- **Free services without an SLA** (511.org, FOSSGIS Valhalla, OpenFreeMap). Their quotas are
  fine for one user. The provider interface and the style URL make the router and the map
  swappable.

## 10. What's next

**On hold**

- Place search: stations by name, and addresses (§5.4).
- Self-hosted walk and bike routing, to remove quotas. The public server's limits are fine for
  now.

**Declined**

- A "Suggest" button that asks a journey planner for the next leg or two (§2).
- Bike share, saved-plan lists and shareable links (decision 12).
- Live data (decision 7).
