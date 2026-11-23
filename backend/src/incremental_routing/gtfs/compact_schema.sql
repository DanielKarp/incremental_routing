-- The compact timetable: what the static site downloads (gzipped) and queries in the browser.
--
-- compact.py derives it from the full database that loader.py builds, and checks that it gives
-- back every table the server's queries read (see ROUND_TRIPS there for the SQL that does it).
-- So it holds the same data, in less space:
--
-- - How a trip runs is stored once: where it goes is a path (its shape, and its stops with
--   their GTFS stop_sequence, pickup and drop-off types and shape distances), and the path
--   with running times relative to the trip's start is a pattern. Trips that run the same way
--   at different times share a pattern, and each trip is one row: its pattern and its start.
--   So a trip's stop times are
--       SELECT ps.stop_sequence, s.stop_id, t.start + pt.arrival AS arrival_s,
--              t.start + pt.departure AS departure_s, ps.pickup_type, ps.drop_off_type,
--              ps.shape_dist, ps.shape_index
--       FROM trips t JOIN patterns p ON p.id = t.pattern
--       JOIN path_stops ps ON ps.path = p.path
--       JOIN pattern_times pt ON pt.pattern = p.id AND pt.stop_sequence = ps.stop_sequence
--       LEFT JOIN stops s ON s.id = ps.stop
--       WHERE t.trip_id = ? ORDER BY ps.stop_sequence
--   with NULL times where the full database has them (a stop with no time that couldn't be
--   interpolated).
-- - Shapes are simplified (Douglas-Peucker, to 5 m) and each is packed into one blob, laid out
--   as described at the shapes table below. Where the server places each stop on its trip's
--   shape (TripStop.shape_index, from shapes.stop_indices on the full shape) is worked out
--   when building, and stored as path_stops.shape_index; those points are always kept.

-- IDs. The feed's own IDs are kept as text, prefixed with the feed ID as in the full database
-- ("bayarea:12TH"): feeds.feed_id, stops.stop_id, routes.route_id, services.service_id,
-- shapes.shape_id and trips.trip_id. Tables refer to feeds, stops, routes, services, shapes,
-- paths and patterns by their integer `id` instead. Two exceptions keep text, as in the full database:
-- stops.parent_station, and the stops, routes and trips transfers.txt names, which the server
-- matches as text and which may name things the feed doesn't have.
--
-- Row order. Where the full database's row order shows in an API response (ties between stops
-- equally far away, between equally specific transfer rules, and conflicting calendar_dates
-- rows, where the last wins), these tables keep it: stops.id follows the full database's rowid
-- order, and transfers and calendar_dates are inserted in it. trips.id follows trip_id order.
--
-- Dates are ISO text (YYYY-MM-DD); times are seconds from the service day's origin, noon minus
-- 12 hours local time (see timeutil.py), and may pass 86400 for trips running past midnight.
--
-- The version below is bumped whenever the tables change; the manifest carries it too.
PRAGMA user_version = 1;

-- built_at (ISO 8601, UTC) and shape_tolerance_m.
CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
) WITHOUT ROWID;

-- One row per feed (the 511 regional feed is the only one today). timezone is the agency
-- timezone its times are in; start_date and end_date are what its calendars cover.
CREATE TABLE feeds (
    id INTEGER PRIMARY KEY,
    feed_id TEXT NOT NULL,
    timezone TEXT NOT NULL,
    start_date TEXT,
    end_date TEXT,
    loaded_at TEXT NOT NULL,
    has_frequencies INTEGER NOT NULL
);

CREATE TABLE routes (
    id INTEGER PRIMARY KEY,
    route_id TEXT NOT NULL,
    feed INTEGER NOT NULL REFERENCES feeds (id),
    agency_name TEXT,
    short_name TEXT,
    long_name TEXT,
    route_type INTEGER NOT NULL,
    color TEXT,
    text_color TEXT
);

-- location_type 0 is a stop or platform, 1 a station; only 0 is offered to board or alight.
CREATE TABLE stops (
    id INTEGER PRIMARY KEY,
    stop_id TEXT NOT NULL,
    feed INTEGER NOT NULL REFERENCES feeds (id),
    name TEXT NOT NULL,
    lat REAL,
    lon REAL,
    location_type INTEGER NOT NULL,
    parent_station TEXT
);

-- Every service ID that trips, calendar or calendar_dates name.
CREATE TABLE services (
    id INTEGER PRIMARY KEY,
    service_id TEXT NOT NULL,
    feed INTEGER NOT NULL REFERENCES feeds (id)
);

CREATE TABLE calendar (
    service INTEGER PRIMARY KEY REFERENCES services (id),
    feed INTEGER NOT NULL REFERENCES feeds (id),
    monday INTEGER NOT NULL,
    tuesday INTEGER NOT NULL,
    wednesday INTEGER NOT NULL,
    thursday INTEGER NOT NULL,
    friday INTEGER NOT NULL,
    saturday INTEGER NOT NULL,
    sunday INTEGER NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL
);

-- exception_type 1 adds the service on that date, 2 removes it. Read in rowid order.
CREATE TABLE calendar_dates (
    service INTEGER NOT NULL REFERENCES services (id),
    feed INTEGER NOT NULL REFERENCES feeds (id),
    date TEXT NOT NULL,
    exception_type INTEGER NOT NULL
);

-- transfers.txt rules that name both stops, with text IDs (see above). transfer_type: 0
-- recommended, 1 timed, 2 needs min_transfer_s, 3 not possible.
CREATE TABLE transfers (
    feed INTEGER NOT NULL REFERENCES feeds (id),
    from_stop TEXT NOT NULL,
    to_stop TEXT NOT NULL,
    transfer_type INTEGER NOT NULL,
    min_transfer_s INTEGER,
    from_route TEXT,
    to_route TEXT,
    from_trip TEXT,
    to_trip TEXT
);

-- points: the simplified shape, n points in 12n bytes, little-endian, no header:
--   bytes 0 .. 8n    n pairs of int32 (lat, lon) in units of 1e-5 degree: the first pair is
--                    the first point, each later pair the change from the point before it.
--                    Divide the running sums by 100000 (rather than multiply by 1e-5) to get
--                    the nearest double to the stored value.
--   bytes 8n .. 12n  n float32: shape_dist_traveled at each point, in the feed's units; NaN
--                    when the feed gives none. A shape has distances at every point or at none
--                    (a feed that leaves some out gets none: the server ignores a shape's
--                    distances unless every point has one).
-- Every point of the feed's shape is within shape_tolerance_m (see meta) of the line through
-- the stored points. The first and last points are always kept, and so are the points the
-- server places stops at (path_stops.shape_index). A shape a trip names but shapes.txt
-- lacks has an empty blob; one with fewer than 2 points isn't drawn (TripDetail.shape is null).
CREATE TABLE shapes (
    id INTEGER PRIMARY KEY,
    shape_id TEXT NOT NULL,
    points BLOB NOT NULL
);

-- shape: the trips' shape, NULL for trips without one. first_seq and last_seq: the lowest and
-- highest stop_sequence, so a trip can't be boarded at its last stop or left at its first;
-- NULL for a path without stops (trips with no stop times).
CREATE TABLE paths (
    id INTEGER PRIMARY KEY,
    shape INTEGER REFERENCES shapes (id),
    first_seq INTEGER,
    last_seq INTEGER
);

-- Each stop of a path, in stop_sequence order (the feed's own numbers, which needn't start at
-- 0 or 1 or be consecutive). stop is NULL where stop_times names a stop stops.txt lacks: the
-- server's queries never see those, as they join stops.
-- shape_index: the index, among the path's shape's stored points, of the point the server
-- places the stop at (TripStop.shape_index is the same point's index among the full shape's
-- points). NULL where the server gives none: the stop is off the shape, the path has no shape
-- or one with fewer than 2 points, or the server doesn't show the stop (stop is NULL, or the
-- stop has no time).
CREATE TABLE path_stops (
    path INTEGER NOT NULL REFERENCES paths (id),
    stop_sequence INTEGER NOT NULL,
    stop INTEGER REFERENCES stops (id),
    pickup_type INTEGER NOT NULL,
    drop_off_type INTEGER NOT NULL,
    shape_dist REAL,
    shape_index INTEGER,
    PRIMARY KEY (path, stop_sequence)
) WITHOUT ROWID;

CREATE TABLE patterns (
    id INTEGER PRIMARY KEY,
    path INTEGER NOT NULL REFERENCES paths (id)
);

-- A pattern's times at each stop of its path (one row per path_stops row): seconds after
-- trips.start, so the first departure is 0, and an arrival before it is negative. NULL for a
-- stop with no time; the patterns of a path have times at the same stops.
CREATE TABLE pattern_times (
    pattern INTEGER NOT NULL REFERENCES patterns (id),
    stop_sequence INTEGER NOT NULL,
    arrival INTEGER,
    departure INTEGER,
    PRIMARY KEY (pattern, stop_sequence)
) WITHOUT ROWID;

-- start: the trip's first departure (that of its first stop with a time), 0 if it has none.
-- route is NULL for a route routes.txt lacks (the server then never offers the trip).
CREATE TABLE trips (
    id INTEGER PRIMARY KEY,
    trip_id TEXT NOT NULL,
    feed INTEGER NOT NULL REFERENCES feeds (id),
    route INTEGER REFERENCES routes (id),
    service INTEGER NOT NULL REFERENCES services (id),
    pattern INTEGER NOT NULL REFERENCES patterns (id),
    start INTEGER NOT NULL,
    headsign TEXT,
    direction_id INTEGER,
    bikes_allowed INTEGER
);

-- Looking things up by their feed IDs.
CREATE UNIQUE INDEX feeds_feed_id ON feeds (feed_id);
CREATE UNIQUE INDEX routes_route_id ON routes (route_id);
CREATE UNIQUE INDEX stops_stop_id ON stops (stop_id);
CREATE UNIQUE INDEX services_service_id ON services (service_id);
CREATE UNIQUE INDEX shapes_shape_id ON shapes (shape_id);
CREATE UNIQUE INDEX trips_trip_id ON trips (trip_id);
-- Stops in a bounding box, as the server finds them: by latitude, then filtered.
CREATE INDEX stops_lat ON stops (lat);
-- Departures and arrivals: the paths calling at a stop, their patterns, and each pattern's
-- trips starting within the window less the pattern's time at the stop.
CREATE INDEX path_stops_stop ON path_stops (stop);
CREATE INDEX patterns_path ON patterns (path);
CREATE INDEX trips_pattern_start ON trips (pattern, start);
-- The services running on a day, and the rules for changing between two stops.
CREATE INDEX calendar_dates_lookup ON calendar_dates (feed, date);
CREATE INDEX transfers_stops ON transfers (from_stop, to_stop);
