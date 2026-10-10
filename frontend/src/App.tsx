import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  type FeedInfo,
  type Health,
  type LatLon,
  type PathMode,
  type RouteResult,
  type TransitCall,
} from './api';
import { Itinerary } from './components/Itinerary';
import { MapView, type PreviewStop } from './components/MapView';
import { NextLeg, type PendingPath, type TripSelection } from './components/NextLeg';
import { PlanSummary } from './components/PlanSummary';
import { PlanTable } from './components/PlanTable';
import { StartSection } from './components/StartSection';
import {
  NEAR_STOP_M,
  type LegsResult,
  alightingLegs,
  boardingLegs,
  estimatedRoute,
  needsConnector,
  pathLeg,
  pathLegArriving,
  pinName,
  stopPlace,
  waitLeg,
} from './plan/build';
import { parsePlanJson } from './plan/files';
import {
  appendLegs,
  findIssues,
  planEnd,
  planStart,
  prependLegs,
  removeLeg,
  setLegDuration,
} from './plan/plan';
import type { Direction, Leg, LegMode, Place, Plan } from './plan/types';
import { loadSession, saveSession } from './storage';
import { localInputToIso, nowLocalInput, toLocalInput } from './time';

const NO_LEGS: Leg[] = [];
const RADIUS_MIN_M = 50;
const RADIUS_MAX_M = 3000; // The backend's limit.

async function nearestStop(point: LatLon) {
  try {
    return (await api.nearbyStops(point, NEAR_STOP_M))[0] ?? null;
  } catch {
    return null; // Only used for a default name.
  }
}

export function App() {
  const [saved] = useState(loadSession);
  const [health, setHealth] = useState<Health | null>(null);
  const [feeds, setFeeds] = useState<FeedInfo[]>([]);

  // The point the plan grows from. Editable until the first leg is added.
  const [anchorPlace, setAnchorPlace] = useState<Place | null>(saved?.anchor ?? null);
  const [timeInput, setTimeInput] = useState(saved?.timeInput ?? nowLocalInput());
  const [movingAnchor, setMovingAnchor] = useState(false);
  // Once legs exist the plan lives here; earlier versions are kept for undo.
  const [committed, setCommitted] = useState<Plan | null>(saved?.plan ?? null);
  const [history, setHistory] = useState<Plan[]>([]);

  // Building the next leg.
  const [direction, setDirection] = useState<Direction>('forward');
  const [mode, setMode] = useState<LegMode>('transit');
  const [radiusM, setRadiusM] = useState(500);
  const [calls, setCalls] = useState<TransitCall[] | null>(null);
  const [selection, setSelection] = useState<TripSelection | null>(null);
  const [pending, setPending] = useState<PendingPath | null>(null);
  const [waitMinutes, setWaitMinutes] = useState(10);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showSummary, setShowSummary] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .health()
      .then((h) => {
        setHealth(h);
        if (h.gtfs_loaded) return api.feeds().then(setFeeds);
      })
      .catch((e: Error) => setError(`Backend unreachable: ${e.message}`));
  }, []);

  useEffect(() => {
    saveSession({ anchor: anchorPlace, timeInput, plan: committed });
  }, [anchorPlace, timeInput, committed]);

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
  const forward = direction === 'forward';
  const frontier = plan ? (forward ? planEnd(plan) : planStart(plan)) : null;
  const pathMode = mode === 'walk' || mode === 'bike';
  // What a map click does: set the point the plan grows from, or pick a walk/bike end point.
  const picking =
    !anchorPlace || movingAnchor ? 'anchor' : pathMode ? 'path' : committed ? null : 'anchor';

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
    const seq = selection.call.stop_sequence;
    return selection.trip.stops
      .filter((s) => (direction === 'forward' ? s.stop_sequence >= seq : s.stop_sequence <= seq))
      .map((s) => ({ lat: s.stop.lat, lon: s.stop.lon, name: s.stop.name }));
  }, [selection, direction]);

  const closeSummary = useCallback(() => setShowSummary(false), []);

  function resetBuilder() {
    setCalls(null);
    setSelection(null);
    setPending(null);
  }

  function commit(next: Plan) {
    if (!plan) return;
    setHistory((h) => [...h, plan]);
    setCommitted(next.legs.length ? next : null);
    resetBuilder();
  }

  function undo() {
    const previous = history[history.length - 1];
    if (!previous) return;
    setHistory((h) => h.slice(0, -1));
    setCommitted(previous.legs.length ? previous : null);
    // The start point may differ (after undoing an import), so restore it too.
    setAnchorPlace(previous.anchor.place);
    setTimeInput(toLocalInput(previous.anchor.time));
    resetBuilder();
  }

  /** Remove every leg but keep the start point. Undo brings them back. */
  function clear() {
    if (!plan) return;
    setHistory((h) => [...h, plan]);
    setCommitted(null);
    resetBuilder();
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

  async function routeOrEstimate(m: PathMode, from: Place, to: Place): Promise<RouteResult> {
    try {
      return await api.route(m, from, to);
    } catch (e) {
      setNotice(`Routing unavailable (${(e as Error).message}); using a straight-line estimate.`);
      return estimatedRoute(m, from, to);
    }
  }

  function pickOnMap(point: LatLon) {
    if (picking === 'anchor') {
      void chooseAnchor(point);
    } else if (picking === 'path') {
      if (!busy) void choosePathPoint(point);
    } else {
      setNotice('To pick a place on the map, choose Walk or Bike under Next leg.');
    }
  }

  async function chooseAnchor(point: LatLon) {
    const provisional: Place = { ...point, name: pinName(point) };
    setAnchorPlace(provisional);
    setMovingAnchor(false);
    resetBuilder();
    const nearest = await nearestStop(point);
    // Name it after a nearby stop, unless it has been renamed or moved meanwhile.
    if (nearest) {
      setAnchorPlace((current) =>
        current === provisional ? { ...provisional, name: pinName(point, nearest) } : current,
      );
    }
  }

  const choosePathPoint = (point: LatLon) =>
    run(async () => {
      if (!plan || (mode !== 'walk' && mode !== 'bike')) return;
      const frontierPlace = (forward ? planEnd(plan) : planStart(plan)).place;
      const [route, nearest] = await Promise.all([
        forward
          ? routeOrEstimate(mode, frontierPlace, point)
          : routeOrEstimate(mode, point, frontierPlace),
        nearestStop(point),
      ]);
      setPending({ mode, place: { ...point, name: pinName(point, nearest) }, route });
    });

  function addPending() {
    if (!plan || !pending) return;
    const place = { ...pending.place, name: pending.place.name?.trim() || pinName(pending.place) };
    commit(
      forward
        ? appendLegs(plan, [pathLeg(planEnd(plan), place, pending.route)])
        : prependLegs(plan, [pathLegArriving(place, planStart(plan), pending.route)]),
    );
  }

  function addWait() {
    if (!plan || !(waitMinutes > 0)) return;
    const seconds = Math.round(waitMinutes * 60);
    commit(
      forward
        ? appendLegs(plan, [waitLeg(planEnd(plan), seconds, 'forward')])
        : prependLegs(plan, [waitLeg(planStart(plan), seconds, 'backward')]),
    );
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
      const found = await (forward ? api.departures(query) : api.arrivals(query));
      // Don't offer the trip you're already on at this end of the plan.
      const adjacent = forward ? plan.legs[plan.legs.length - 1]?.transit : plan.legs[0]?.transit;
      setCalls(
        found.filter(
          (c) => !adjacent || c.trip_id !== adjacent.tripId || c.service_date !== adjacent.serviceDate,
        ),
      );
    });

  const chooseCall = (call: TransitCall) =>
    run(async () => {
      setSelection({ call, trip: await api.trip(call.trip_id, call.service_date) });
    });

  const chooseStop = (stopSequence: number) =>
    run(async () => {
      if (!plan || !selection) return;
      const { call, trip } = selection;
      const callStop = stopPlace(call.stop);
      let result: LegsResult;
      if (forward) {
        const from = planEnd(plan);
        const walk = needsConnector(from.place, callStop)
          ? await routeOrEstimate('walk', from.place, callStop)
          : null;
        result = boardingLegs(from, trip, call.stop_sequence, stopSequence, walk);
        if (result.ok) commit(appendLegs(plan, result.legs));
      } else {
        const to = planStart(plan);
        const walk = needsConnector(callStop, to.place)
          ? await routeOrEstimate('walk', callStop, to.place)
          : null;
        result = alightingLegs(to, trip, stopSequence, call.stop_sequence, walk);
        if (result.ok) commit(prependLegs(plan, result.legs));
      }
      if (!result.ok) setError(result.reason);
    });

  function setDuration(legId: string, seconds: number): string | null {
    if (!plan) return null;
    const result = setLegDuration(plan, legId, seconds);
    if (!result.ok) return result.reason;
    commit(result.plan);
    return null;
  }

  async function openPlanFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // So choosing the same file again still triggers a change.
    if (!file) return;
    const parsed = parsePlanJson(await file.text());
    if (!parsed.ok) {
      setError(parsed.reason);
      return;
    }
    if (plan) setHistory((h) => [...h, plan]);
    setCommitted(parsed.plan.legs.length ? parsed.plan : null);
    setAnchorPlace(parsed.plan.anchor.place);
    setTimeInput(toLocalInput(parsed.plan.anchor.time));
    setMovingAnchor(false);
    resetBuilder();
    setError(null);
    setNotice(`Opened ${file.name}.`);
  }

  return (
    <>
      <div className="app">
        <aside className="panel">
          <header className="panel-header">
            <h1>Incremental Routing</h1>
            <button type="button" className="link" onClick={() => fileInput.current?.click()}>
              Open plan…
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={openPlanFile}
            />
          </header>

          {health && !health.gtfs_loaded && (
            <p className="warning">
              No transit data loaded. Run <code>uv run ir-load-gtfs</code> in{' '}
              <code>backend/</code>.
            </p>
          )}
          {uncoveredFeeds.length > 0 && (
            <p className="warning">
              Schedule data doesn't cover {day} for:{' '}
              {uncoveredFeeds.map((f) => f.feed_id).join(', ')}. Re-run <code>ir-load-gtfs</code>.
            </p>
          )}

          <StartSection
            anchor={anchorPlace}
            timeInput={timeInput}
            locked={!!committed}
            moving={movingAnchor}
            onName={(name) => setAnchorPlace((p) => (p ? { ...p, name } : p))}
            onTime={(value) => {
              setTimeInput(value);
              resetBuilder();
            }}
            onMove={() => setMovingAnchor(true)}
          />

          {committed && (
            <Itinerary
              plan={committed}
              issues={issues}
              onSetDuration={setDuration}
              onRemove={(legId) => commit(removeLeg(committed, legId))}
              onUndo={undo}
              canUndo={history.length > 0}
              onClear={clear}
              onSummary={() => setShowSummary(true)}
              disabled={busy}
            />
          )}
          {!committed && history.length > 0 && (
            <button type="button" className="secondary" onClick={undo}>
              Undo
            </button>
          )}

          {notice && (
            <p className="warning" role="status">
              {notice}
            </p>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}

          {plan && frontier && (
            <NextLeg
              direction={direction}
              mode={mode}
              frontier={frontier}
              busy={busy}
              onDirection={(d) => {
                setDirection(d);
                resetBuilder();
              }}
              onMode={(m) => {
                setMode(m);
                resetBuilder();
              }}
              radiusM={radiusM}
              onRadius={setRadiusM}
              onSearch={search}
              calls={calls}
              selection={selection}
              onChooseCall={chooseCall}
              onChooseStop={chooseStop}
              onBackToCalls={() => setSelection(null)}
              pending={pending}
              onPendingName={(name) =>
                setPending((p) => (p ? { ...p, place: { ...p.place, name } } : p))
              }
              onAddPending={addPending}
              onCancelPending={() => setPending(null)}
              waitMinutes={waitMinutes}
              onWaitMinutes={setWaitMinutes}
              onAddWait={addWait}
            />
          )}

          <footer className="muted">
            Routing: {health?.routing_provider ?? '…'} · Map © OpenStreetMap contributors,
            OpenFreeMap
          </footer>
        </aside>
        <MapView
          start={committed ? planStart(committed).place : anchorPlace}
          end={committed ? planEnd(committed).place : null}
          stops={callStops}
          tripPreview={tripPreview}
          pendingPoint={pending?.place ?? null}
          pendingRoute={pending?.route.geometry ?? null}
          picking={picking !== null}
          legs={committed?.legs ?? NO_LEGS}
          onPick={pickOnMap}
        />
      </div>
      {showSummary && committed && (
        <PlanSummary plan={committed} issues={issues} onClose={closeSummary} />
      )}
      {committed && (
        <div className="print-only">
          <h1>Trip plan</h1>
          <PlanTable plan={committed} issues={issues} />
        </div>
      )}
    </>
  );
}
