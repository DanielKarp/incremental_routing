# Incremental Routing: MVP plan

A route planner for building a multi-leg trip **one leg at a time**, mixing public transit with
cycling and walking. Instead of asking a journey planner for "the best route", you choose
every leg yourself and the app keeps the itinerary consistent in space and time.

This document scopes the MVP, records the data-source decisions, and lays out the milestones.
The scaffold in this repository implements milestone M0.

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

## 2. MVP scope

**In scope**

- One local user, on a laptop, in a browser.
- Transit schedules for **Caltrain, BART and VTA** (static GTFS, no real-time).
- Leg types: transit, walk, bike, wait (waits inserted automatically, or added by hand).
- Forward and backward planning from an anchor picked on the map.
- Walk/bike routes from a hosted routing API, with a manual override for the duration.
- A final itinerary listing every leg with start and end time and place, exportable.

**Out of scope for MVP** (see §10)

- Real-time delays (GTFS-Realtime), other Bay Area agencies, and automatic "best route" search.
- Accounts, sharing and multiple devices.
- Address search. You pick points on the map; stations can be found by name from GTFS.
- Enforcing bike-on-board rules. The data is shown but not enforced.

## 3. User flow

### Forward (the main flow)

1. Click the map and set a time. That's the anchor, and it becomes the frontier.
2. Choose a mode for the next leg:
   - **Transit**: see departures from stops near the frontier after its time. Only trips you
     can still walk to are shown. Pick one, then pick the stop to get off at from that trip's
     remaining stops.
     - If the boarding stop isn't at the frontier, the app inserts a walk to the stop. The walk
       starts right away, and a wait fills any time left before the departure.
   - **Walk / Bike**: click the destination. The router returns a path and duration, and
     you can edit the duration.
   - **Wait**: stay put for N minutes, e.g. a coffee stop.
3. The new leg's end becomes the frontier, and step 2 repeats.
4. Any time gap between two legs is filled with an automatic **wait** leg. For example, a bike
   leg reaches the station at 7:50 and the train leaves at 8:00.

### Backward

This is the same flow mirrored. You see **arrivals** at stops near the frontier before its time,
pick a trip, then pick where you got on from its earlier stops. The walk from the stop to the
frontier leaves as soon as you get off, and any spare time becomes a wait at the frontier
(decision 1, mirrored). Walk, bike and wait legs you add keep their **end** time fixed and
compute the start time.

### Leg types

| Mode | Start / end chosen by | Times come from | Editable |
| --- | --- | --- | --- |
| Transit | Departure (or arrival) list, then a stop on that trip | Timetable | No: fixed by the schedule |
| Walk, Bike | Frontier, then a map click | Routing API | Duration (end moves forward, start moves backward) |
| Wait | Same place at both ends | Gap between legs, or manual | Manual waits only |

## 4. Data model

```ts
interface Waypoint { place: { lat; lon; name?; stopId? }; time: string /* ISO, with offset */ }
interface Leg {
  id: string;
  mode: 'transit' | 'walk' | 'bike' | 'wait';
  start: Waypoint;
  end: Waypoint;
  auto?: boolean;                 // derived (waits), rebuilt on every change
  transit?: { tripId; serviceDate; routeName; headsign; color; stops: [...] };
  path?: { provider; distanceM; routedDurationS; geometry };
}
interface Plan { anchor: Waypoint; legs: Leg[] }
```

The real definitions are in `frontend/src/plan/types.ts`.

**Invariants**, enforced by `withWaits` and `findIssues` in `frontend/src/plan/plan.ts`:

1. Legs are chronological.
2. **Continuous in time.** A gap between legs becomes an automatic wait leg. An **overlap**
   (the next leg starts before the previous one ends) is a *missed connection*. Nothing is
   ever silently re-timed, because transit times can't move. Duration edits that would cause
   an overlap are refused (§9, decision 2), and `findIssues` still reports any overlap as a
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

### 5.1 Transit: GTFS schedule feeds

| Agency | Static GTFS URL | Key | Notes |
| --- | --- | --- | --- |
| Caltrain | `https://data.trilliumtransit.com/gtfs/caltrain-ca-us/caltrain-ca-us.zip` | No | Hosted by Trillium for Caltrain |
| BART | `https://www.bart.gov/dev/schedules/google_transit.zip` | No | Covered by BART's developer license agreement. Stations are modeled as parent stations with platforms. |
| VTA | `https://gtfs.vta.org/gtfs_vta.zip` | No | Bus and light rail; by far the largest feed |

These URLs live in `backend/src/incremental_routing/gtfs/feeds.py`. `uv run ir-load-gtfs`
downloads them and builds one SQLite file.

**Alternative: 511.org.** With one free API key, the [511 SF Bay open data
API](https://511.org/open-data/transit) serves the same per-agency feeds (`operator_id=…`) and a
consolidated **regional feed** for every Bay Area operator (`operator_id=RG`), plus matching
GTFS-Realtime. The direct agency URLs remain the default because they need no key. Set
`GTFS_SOURCE=511` and `API_511_KEY` to load the regional feed instead (see M6 notes).

**Freshness.** Agencies publish new feeds at service changes, several times a year. Mirrored
copies on the Mobility Database showed date ranges that had already ended, so always fetch from
the source. The loader prints each feed's date range and flags expired feeds, and the UI warns
when the selected date falls outside a feed's range. Re-run the loader monthly.

The date range comes from the service calendar, not from `feed_info.txt`. BART's August 2026
feed still declared an end date of 2026-08-30, while its calendar ran to 2027-01-10.

**GTFS details the loader and queries already handle:**

- Times past `24:00:00` for trips that run past midnight. Every query checks yesterday's
  service day too.
- The service day begins at "noon minus 12 h", which is not midnight on daylight-saving change
  days.
- Service days come from `calendar.txt` plus `calendar_dates.txt` exceptions (holidays).
- Parent stations versus boardable platforms.
- Stops without a scheduled time are interpolated between scheduled timepoints.
- ID collisions between feeds: every ID is prefixed with its feed, e.g. `bart:…`.
- No boarding at a trip's last stop, or where `pickup_type=1`. The same applies to alighting.
- Zips with files nested in a folder. Stray macOS `__MACOSX/` entries are ignored; VTA's zip
  has them.
- Not handled yet: `frequencies.txt` (headway-based trips). The loader warns if a feed uses it.
  Caltrain ships the file with a header only, and none of the three feeds uses it today.

### 5.2 Walking and cycling routes

| Option | Free usage | Key | Fit |
| --- | --- | --- | --- |
| **OpenRouteService** (recommended) | Free plan: 2,000 directions requests/day, 40/min | Free signup | `foot-walking`, `cycling-regular`, plus `cycling-road`, `cycling-electric` and `cycling-mountain`. Returns GeoJSON path, distance and duration. |
| **Valhalla, FOSSGIS public server** | Free under a fair-use policy, rate-limited | None | `pedestrian` and `bicycle` costing. This is the zero-config default for development. |
| Stadia Maps (hosted Valhalla) | Free tier for non-commercial use (check current limits) | Yes | Same API as FOSSGIS, so the same provider class works with a different URL and key. |
| Google Routes API | Monthly free usage, then pay-as-you-go | Key + billing account | Its terms restrict showing results on non-Google maps and caching them. Poor fit here. |
| Mapbox Directions | Monthly free allowance | Key + account | Its terms tie results to Mapbox maps. |
| Self-hosted Valhalla, GraphHopper or OSRM | Unlimited | None | Docker plus a Northern California OSM extract, needing about 2–4 GB RAM. The upgrade path after the MVP. |

**Decision:** use OpenRouteService when `ORS_API_KEY` is set, and otherwise the public Valhalla
server. Both sit behind one `RoutingProvider` interface (`backend/src/incremental_routing/routing/`),
selected by `ROUTING_PROVIDER`. A `straight-line` provider exists for offline development and
tests. One user making one request per walk or bike leg is far below the ORS daily quota. Cache
results by mode and rounded coordinates if that ever changes.

Router speeds are generic. Typical defaults are about 5 km/h walking and roughly 15–20 km/h cycling.
That's one reason duration overrides are a core feature rather than an extra.

### 5.3 Base map

MapLibre GL JS with **OpenFreeMap** vector tiles: free, no key, OpenStreetMap data, no SLA. If it
ever becomes unreliable, switch the style URL in `MapView.tsx` to MapTiler or Stadia (free tiers
with keys), or to a self-hosted Protomaps file of the Bay Area.

### 5.4 Place search (after MVP)

Searching stop names from GTFS covers stations. For addresses, use ORS geocoding (same key) or
Photon/Nominatim (fair use).

## 6. Architecture

```
Browser: React + MapLibre                       Backend: FastAPI (Python)
┌──────────────────────────────┐                ┌──────────────────────────────────────┐
│ plan/  pure plan rules (TS)  │   GET /api/    │ gtfs/query.py  ──▶ data/gtfs.sqlite  │
│ components/  map, lists,     │ ─ departures ─▶│                       ▲              │
│   leg builder, itinerary     │   arrivals     │ ir-load-gtfs ─────────┘ (download +  │
│ localStorage + JSON export   │   trip         │                         build)       │
│                              │   POST /route ▶│ routing/ ─▶ ORS | Valhalla | straight│
└──────────────────────────────┘                └──────────────────────────────────────┘
```

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Whether GTFS data is loaded, and the active routing provider |
| `GET /api/feeds` | Loaded feeds and their valid date ranges |
| `GET /api/stops/nearby?lat&lon&radius_m` | Boardable stops near a point |
| `GET /api/departures?lat&lon&time&radius_m&window_min` | Trips you can walk to and board after `time` (forward) |
| `GET /api/arrivals?lat&lon&time&…` | Trips you can ride to arrive before `time` (backward) |
| `GET /api/trip?trip_id&service_date` | A trip's full stop list with times and board/alight flags |
| `POST /api/route {mode, origin, destination}` | Walk or bike path, distance and duration |

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
3. Drop departures you can't reach on foot: straight-line distance × 1.3 detour factor ÷
   1.3 m/s walking speed.
4. Keep one entry per trip, at its nearest stop, sorted by time.

Arrivals are the mirror image: alighting allowed, arriving at least the walk time before the
query time.

**Choosing where to get off:** `/api/trip` returns every stop with absolute times. The UI lists
stops after the boarding stop where `can_alight` is true (forward), or stops before the alighting
stop where `can_board` is true (backward).

**Connector walks:** when the chosen stop isn't at the frontier, the UI requests a walk route
from the frontier to the stop and adds it as a leg. `withWaits` then fills the remaining time.

**Normalization:** after every edit, `withWaits` rebuilds the wait legs and `findIssues`
reports overlaps, gaps in space and negative durations. The UI marks those legs and doesn't
fix them automatically.

## 8. Milestones

| # | Milestone | Done when |
| --- | --- | --- |
| M0 ✅ | Scaffold | GTFS loader and queries, routing providers, API, map page listing departures and arrivals, plan model. Unit tests for all of it. |
| M1 🟡 | Real-data check | All three feeds load. Departures at Millbrae, San Jose Diridon and Mountain View match the published timetables. Query latency measured. Feed quirks fixed. *Mostly done; see below.* |
| M2 ✅ | Forward transit legs | Pick a departure, then a stop to get off at, and the leg (with connector walk and wait) is added. Transit legs are drawn on the map, and an itinerary panel lists the legs. You can build home → Caltrain → BART by clicking. |
| M3 ✅ | Walk and bike legs | Choose a mode at the frontier, click a destination, and get a routed path drawn on the map. Duration is editable, conflicts are shown, manual waits work, and you can remove the last leg. |
| M4 ✅ | Backward planning | Arrivals list, choose where to board, prepend legs. Walk and bike legs keep their end time fixed. A plan can grow both ways from the anchor. |
| M5 ✅ | Output and persistence | A final itinerary table (leg, mode, from, depart, to, arrive, duration). Print view. Export to JSON, CSV and calendar (ICS). Autosave and import. |
| M6 ✅ | Refinements from testing | Bike to and from stops, and switch walk ↔ bike later. Edit departure and arrival times. 511 regional feed. Transit lines from `shapes.txt`. Rename places. A map in the summary and printout. Transfer warnings from `transfers.txt`. |

M1 must come first because real feeds always surprise you. Everything after it is UI work on
top of the existing API.

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
- **511 regional feed.** `GTFS_SOURCE=511` (or `ir-load-gtfs --source 511`) builds the
  database from 511.org's consolidated feed for every Bay Area operator, using `API_511_KEY`.
  - The key is sent as a request parameter and never printed, including in error messages.
  - The two sources are never loaded together, because the regional feed already contains the
    agencies.
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
- **Transfer warnings.** When you extend the plan from a transit leg, the departure (or
  arrival) list shows the agency's `transfers.txt` rule for each candidate:
  - a warning when the connection is shorter than the minimum, or when the agency rules the
    transfer out;
  - a note for timed transfers.

  Rules can be for a platform or its parent station, and limited to routes or trips; the most
  specific matching rule wins. The agency feeds have few rules:
  - Caltrain's timed transfers at San Jose Diridon.
  - BART's platform rules at 12 stations. Most are 0 minutes. Coliseum ↔ the Oakland
    Airport line is 4 minutes, and some route pairs at Warm Springs and Union City are 1
    minute.

  The 511 feed has the same rules, plus a few timed transfers for WestCat and FAST. None of
  its rules are between agencies.
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
  - Walk and bike legs used the straight-line estimate, because the routing hosts are blocked
    in the cloud sandbox.

### M2 notes

- If the walking router fails, connector walks fall back to the straight-line estimate and are
  labelled "(estimated)". This is what happens in the cloud sandbox, where the routing hosts
  are blocked.
- Same-station changes need no walk leg when the platforms are within 75 m. Millbrae's
  Caltrain platform and BART's "Caltrain Transfer Platform" are an example.
- The departure list leaves out the trip you have just got off.
- Searches start exactly at the frontier time, so a 0-minute change can be offered.
  Minimum transfer times (`transfers.txt`) remain a later refinement.

### M1 findings (feeds downloaded 2026-10-10)

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
- **Still to do.**
  - Compare a few stations against the agencies' published timetables by hand.
  - Exercise live walk/bike routing. `api.openrouteservice.org` and
    `valhalla1.openstreetmap.de` are still blocked in the cloud sandbox.

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
   scooter, may park, or may use bikeshare, and modelling any of that is out of scope. In
   today's feeds this affects 66 VTA bus trips. Every Caltrain and BART trip allows bikes.
5. **Connections to stops can be by bike** (added after testing). This is chosen while
   planning a transit leg, and any walk or bike leg can be switched later.
6. **Transfer rules are advice.** `transfers.txt` minimums show as warnings in the departure
   and arrival lists only. Choosing a warned connection is allowed.

**Risks:**

- **Feed URLs move or expire.** Mitigated by the loader's expiry check and UI warnings.
  The 511.org fallback covers every agency.
- **Schedule-only data.** Real trips run late. GTFS-Realtime through 511 is the follow-up.
- **Cross-agency transfers.** At Millbrae, Diridon and Mountain View each agency has its own
  stop IDs, 100–300 m apart. The connector walk covers this. Neither the agency feeds nor the
  511 regional feed describe transfers between agencies, so there are no warnings for them.
- **Busy stops with every operator.** Downtown, a 500 m radius takes in hundreds of
  departures an hour. The list shows the first 40, which at Powell is only the next 10
  minutes. Filtering by agency or grouping by route would fix this; it's still to decide.
- **Free services without an SLA** (ORS, FOSSGIS, OpenFreeMap). The provider interface and the
  style URL make each one swappable.

## 10. After the MVP

- Real-time delays and alerts (511 GTFS-Realtime, with the same API key).
- A "Suggest" button that asks a full journey planner (OpenTripPlanner or MOTIS, self-hosted)
  for the next leg or two.
- Elevation profiles for bike legs.
- Bike share, multiple saved plans, shareable links.
- Self-hosted routing to remove quotas entirely.
