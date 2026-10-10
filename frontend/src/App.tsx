import { useEffect, useMemo, useState } from 'react';
import {
  api,
  type FeedInfo,
  type Health,
  type LatLon,
  type RouteResult,
  type TransitCall,
  type TripDetail,
} from './api';
import { CallList } from './components/CallList';
import { Itinerary } from './components/Itinerary';
import { MapView, type PreviewStop } from './components/MapView';
import { TripStops } from './components/TripStops';
import { boardingLegs, estimatedRoute, needsConnector, stopPlace } from './plan/build';
import { appendLeg, findIssues, planEnd, planStart, setLegDuration } from './plan/plan';
import type { Leg, Place, Plan } from './plan/types';
import { formatTime, localInputToIso, nowLocalInput } from './time';

type Direction = 'departures' | 'arrivals';

const NO_LEGS: Leg[] = [];

const RADIUS_MIN_M = 50;
const RADIUS_MAX_M = 3000; // The backend's limit.

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [feeds, setFeeds] = useState<FeedInfo[]>([]);

  // Before the first leg, the plan is just the anchor, editable via the map and time field.
  const [anchorPlace, setAnchorPlace] = useState<Place | null>(null);
  const [timeInput, setTimeInput] = useState(nowLocalInput);
  // Once legs exist, the plan is fixed here; earlier versions are kept for undo.
  const [committed, setCommitted] = useState<Plan | null>(null);
  const [history, setHistory] = useState<Plan[]>([]);

  const [direction, setDirection] = useState<Direction>('departures');
  const [radiusM, setRadiusM] = useState(500);
  const [calls, setCalls] = useState<TransitCall[] | null>(null);
  const [selection, setSelection] = useState<{ call: TransitCall; trip: TripDetail } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    api
      .health()
      .then((h) => {
        setHealth(h);
        if (h.gtfs_loaded) return api.feeds().then(setFeeds);
      })
      .catch((e: Error) => setError(`Backend unreachable: ${e.message}`));
  }, []);

  const anchorTime = useMemo(() => {
    try {
      return localInputToIso(timeInput);
    } catch {
      return null; // Half-typed or cleared time field.
    }
  }, [timeInput]);

  const plan: Plan | null = useMemo(() => {
    if (committed) return committed;
    if (!anchorPlace || !anchorTime) return null;
    return { anchor: { place: anchorPlace, time: anchorTime }, legs: [] };
  }, [committed, anchorPlace, anchorTime]);

  const issues = useMemo(() => (plan ? findIssues(plan) : []), [plan]);
  const frontier = plan ? (direction === 'departures' ? planEnd(plan) : planStart(plan)) : null;

  const day = timeInput.slice(0, 10);
  const uncoveredFeeds = feeds.filter(
    (f) => (f.end_date && f.end_date < day) || (f.start_date && f.start_date > day),
  );

  const callStops = useMemo(() => {
    if (selection) return [];
    const byId = new Map((calls ?? []).map((c) => [c.stop.stop_id, c.stop]));
    return [...byId.values()];
  }, [calls, selection]);

  const tripPreview: PreviewStop[] | null = useMemo(() => {
    if (!selection) return null;
    return selection.trip.stops
      .filter((s) => s.stop_sequence >= selection.call.stop_sequence)
      .map((s) => ({ lat: s.stop.lat, lon: s.stop.lon, name: s.stop.name }));
  }, [selection]);

  function resetSearch() {
    setCalls(null);
    setSelection(null);
  }

  function commit(next: Plan) {
    if (!plan) return;
    setHistory((h) => [...h, plan]);
    setCommitted(next.legs.length ? next : null);
  }

  function undo() {
    const previous = history[history.length - 1];
    setHistory((h) => h.slice(0, -1));
    setCommitted(previous?.legs.length ? previous : null);
    resetSearch();
  }

  function clear() {
    setCommitted(null);
    setHistory([]);
    resetSearch();
  }

  function pickOnMap(point: LatLon) {
    if (committed) {
      setNotice('Clear the plan to choose a different starting point.');
      return;
    }
    setAnchorPlace({ ...point, name: 'Start' });
    resetSearch();
  }

  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await task();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const search = () =>
    run(async () => {
      if (!plan || !frontier) return;
      setSelection(null);
      const query = {
        point: frontier.place,
        time: frontier.time,
        radiusM: Math.min(RADIUS_MAX_M, Math.max(RADIUS_MIN_M, radiusM || 500)),
      };
      const found = await (direction === 'departures'
        ? api.departures(query)
        : api.arrivals(query));
      // Don't offer the trip you've just stepped off.
      const lastRide = direction === 'departures' ? plan.legs[plan.legs.length - 1]?.transit : null;
      setCalls(
        found.filter(
          (c) => !lastRide || c.trip_id !== lastRide.tripId || c.service_date !== lastRide.serviceDate,
        ),
      );
    });

  const chooseCall = (call: TransitCall) =>
    run(async () => {
      setSelection({ call, trip: await api.trip(call.trip_id, call.service_date) });
    });

  const alightAt = (alightSeq: number) =>
    run(async () => {
      if (!plan || !selection) return;
      const { call, trip } = selection;
      const from = planEnd(plan);
      const board = stopPlace(call.stop);
      let walk: RouteResult | null = null;
      if (needsConnector(from.place, board)) {
        try {
          walk = await api.route('walk', from.place, board);
        } catch (e) {
          walk = estimatedRoute('walk', from.place, board);
          setNotice(`Walking route unavailable (${(e as Error).message}); using an estimate.`);
        }
      }
      const result = boardingLegs(from, trip, call.stop_sequence, alightSeq, walk);
      if (!result.ok) {
        setError(result.reason);
        return;
      }
      commit(result.legs.reduce(appendLeg, plan));
      resetSearch();
    });

  function setDuration(legId: string, seconds: number): string | null {
    if (!plan) return null;
    // Legs are planned forwards for now, so their start stays put (M4 adds backwards).
    const result = setLegDuration(plan, legId, seconds, 'start');
    if (!result.ok) return result.reason;
    commit(result.plan);
    return null;
  }

  return (
    <div className="app">
      <aside className="panel">
        <h1>Incremental Routing</h1>

        {health && !health.gtfs_loaded && (
          <p className="warning">
            No transit data loaded. Run <code>uv run ir-load-gtfs</code> in <code>backend/</code>.
          </p>
        )}
        {uncoveredFeeds.length > 0 && (
          <p className="warning">
            Schedule data doesn't cover {day} for:{' '}
            {uncoveredFeeds.map((f) => f.feed_id).join(', ')}. Re-run <code>ir-load-gtfs</code>.
          </p>
        )}

        <section>
          <h2>Start</h2>
          <p className={anchorPlace ? '' : 'muted'}>
            {anchorPlace
              ? `${anchorPlace.lat.toFixed(5)}, ${anchorPlace.lon.toFixed(5)}`
              : 'Click the map to choose a starting point.'}
          </p>
          <label className="field">
            Time
            <input
              type="datetime-local"
              value={timeInput}
              disabled={!!committed}
              onChange={(e) => {
                setTimeInput(e.target.value);
                resetSearch();
              }}
            />
          </label>
        </section>

        {committed && (
          <Itinerary
            plan={committed}
            issues={issues}
            onSetDuration={setDuration}
            onUndo={undo}
            onClear={clear}
          />
        )}

        {plan && frontier && (
          <section>
            <h2>Next leg</h2>
            <p className="muted">
              {direction === 'departures' ? 'From' : 'Arriving at'}{' '}
              {frontier.place.name ?? 'start'} {direction === 'departures' ? 'after' : 'before'}{' '}
              {formatTime(frontier.time)}
            </p>
            <div className="segmented" role="radiogroup" aria-label="Direction">
              {(['departures', 'arrivals'] as const).map((d) => (
                <label key={d}>
                  <input
                    type="radio"
                    name="direction"
                    checked={direction === d}
                    onChange={() => {
                      setDirection(d);
                      resetSearch();
                    }}
                  />
                  {d === 'departures' ? 'Departing after' : 'Arriving before'}
                </label>
              ))}
            </div>
            <label className="field">
              Search radius (m)
              <input
                type="number"
                min={RADIUS_MIN_M}
                max={RADIUS_MAX_M}
                step={50}
                value={radiusM}
                onChange={(e) => setRadiusM(Number(e.target.value))}
              />
            </label>
            <button type="button" disabled={busy} onClick={search}>
              {busy ? 'Working…' : 'Find transit'}
            </button>
          </section>
        )}

        {notice && <p className="warning">{notice}</p>}
        {error && <p className="error">{error}</p>}

        {selection ? (
          <TripStops
            trip={selection.trip}
            boardSeq={selection.call.stop_sequence}
            onAlight={alightAt}
            onBack={() => setSelection(null)}
            disabled={busy}
          />
        ) : (
          calls && (
            <section>
              <h2>{direction === 'departures' ? 'Departures' : 'Arrivals'}</h2>
              {direction === 'arrivals' && (
                <p className="muted">Planning backwards from these comes in milestone M4.</p>
              )}
              <CallList
                calls={calls}
                direction={direction}
                onSelect={direction === 'departures' ? chooseCall : undefined}
                disabled={busy}
              />
            </section>
          )
        )}

        <footer className="muted">
          Routing: {health?.routing_provider ?? '…'} · Map © OpenStreetMap contributors,
          OpenFreeMap
        </footer>
      </aside>
      <MapView
        anchor={anchorPlace}
        frontier={committed ? planEnd(committed).place : null}
        stops={callStops}
        tripPreview={tripPreview}
        legs={committed?.legs ?? NO_LEGS}
        onPick={pickOnMap}
      />
    </div>
  );
}
