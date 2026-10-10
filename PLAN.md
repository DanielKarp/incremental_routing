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
     - If the boarding stop isn't at the frontier, the app inserts a walk to the stop, plus a
       wait if you arrive early.
   - **Walk / Bike**: click the destination. The router returns a path and duration, and
     you can edit the duration.
   - **Wait**: stay put for N minutes, e.g. a coffee stop.
3. The new leg's end becomes the frontier, and step 2 repeats.
4. Any time gap between two legs is filled with an automatic **wait** leg. For example, a bike
   leg reaches the station at 7:50 and the train leaves at 8:00.

### Backward

This is the same flow mirrored. You see **arrivals** at stops near the frontier before its time,
pick a trip, then pick where you got on from its earlier stops. Walk and bike legs keep their
**end** time fixed and compute the start time.

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
   (the next leg starts before the previous one ends) is a *missed connection*. It is flagged
   to the user and never silently re-timed, because transit times can't move.
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
GTFS-Realtime. Use direct URLs for the MVP because they need no key. Move to the 511 regional
feed when adding Muni, SamTrans, AC Transit and others, or when adding real-time data.

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
| M2 | Forward transit legs | Pick a departure, then a stop to get off at, and the leg (with connector walk and wait) is added. Transit legs are drawn on the map, and an itinerary panel lists the legs. You can build home → Caltrain → BART by clicking. |
| M3 | Walk and bike legs | Choose a mode at the frontier, click a destination, and get a routed path drawn on the map. Duration is editable, conflicts are shown, manual waits work, and you can remove the last leg. |
| M4 | Backward planning | Arrivals list, choose where to board, prepend legs. Walk and bike legs keep their end time fixed. A plan can grow both ways from the anchor. |
| M5 | Output and persistence | A final itinerary table (leg, mode, from, depart, to, arrive, duration). Print view. Export to JSON, CSV and calendar (ICS). Autosave and import. |

M1 must come first because real feeds always surprise you. Everything after it is UI work on
top of the existing API.

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

## 9. Open questions and risks

**Decisions I've defaulted. Please confirm or change:**

1. **Connector walk timing.** Leave immediately and wait at the stop (conservative, the
   default), or leave just in time and wait at the start?
2. **Duration edits.** Flag the resulting conflicts (the default), or shift later walk and
   bike legs automatically ("ripple")? Transit legs never move either way.
3. **Search radius.** 500 m by default. Should it grow, say to 2 km, when you're on a bike?
4. **Bike on board.** Caltrain and BART allow bikes with restrictions, and VTA buses have racks.
   Should the plan track "bike with me" across legs and warn when a trip doesn't allow it? GTFS
   `bikes_allowed` is already exposed per trip.

**Risks:**

- **Feed URLs move or expire.** Mitigated by the loader's expiry check and UI warnings.
  The 511.org fallback covers every agency.
- **Schedule-only data.** Real trips run late. GTFS-Realtime through 511 is the follow-up.
- **Cross-agency transfers.** At Millbrae, Diridon and Mountain View each agency has its own
  stop IDs, 100–300 m apart. The connector walk covers this, but `transfers.txt` minimum
  transfer times are ignored for now.
- **Free services without an SLA** (ORS, FOSSGIS, OpenFreeMap). The provider interface and the
  style URL make each one swappable.

## 10. After the MVP

- Real-time delays and alerts (511 GTFS-Realtime).
- The 511 regional feed for all Bay Area agencies.
- A "Suggest" button that asks a full journey planner (OpenTripPlanner or MOTIS, self-hosted)
  for the next leg or two.
- `shapes.txt` for accurate transit lines on the map, and elevation profiles for bike legs.
- Bike share, multiple saved plans, shareable links.
- Self-hosted routing to remove quotas entirely.
