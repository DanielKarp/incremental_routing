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
import { TRIPS_PER_LINE, groupCalls } from './callGroups';
import { Itinerary } from './components/Itinerary';
import { type MapHandle, type MapMenuItem, MapView, type TripPreview } from './components/MapView';
import { NextLeg, type PendingPath, type TripSelection } from './components/NextLeg';
import { PlanSummary } from './components/PlanSummary';
import { PlanTable } from './components/PlanTable';
import { StartSection } from './components/StartSection';
import { uncoveredOn } from './coverage';
import { type LinePreview, lineCall, linePreviews } from './linePreviews';
import {
  NEAR_STOP_M,
  type LegsResult,
  alightingLegs,
  boardingLegs,
  estimatedRoute,
  needsConnector,
  pathInfo,
  pathLeg,
  pathLegArriving,
  pinName,
  previewLine,
  stopChoices,
  stopPlace,
  waitLeg,
} from './plan/build';
import { parsePlanJson } from './plan/files';
import {
  type EditResult,
  appendLegs,
  findIssues,
  mergeWithNext,
  planEnd,
  planStart,
  prependLegs,
  removeLeg,
  renamePlace,
  setLegDuration,
  setLegEnd,
  setLegPath,
  setLegStart,
} from './plan/plan';
import { adjacentRide, transferContext, transferNote } from './plan/transfers';
import type { Direction, Leg, LegMode, Place, Plan } from './plan/types';
import { loadSession, saveSession } from './storage';
import { localInputToIso, nowLocalInput, toLocalInput } from './time';
import { type TransitSearch, useTransitList } from './transitList';

const NO_LEGS: Leg[] = [];
const NO_PREVIEWS: LinePreview[] = [];
const RADIUS_MIN_M = 50;
const RADIUS_MAX_M = 3000; // The backend's limit.
// The backend's maximum too. With a few trips per line it holds every line downtown, even
// within 3 km (about 360 trips at Civic Center).
const CALL_LIMIT = 500;

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
  // How you get to (or from) the stop for a transit leg.
  const [access, setAccess] = useState<PathMode>('walk');
  const [selection, setSelection] = useState<TripSelection | null>(null);
  // The line pointed at in the list (framed on the map), and those on the map (marked in the
  // list).
  const [listHover, setListHover] = useState<string | null>(null);
  const [mapHover, setMapHover] = useState<string[]>([]);
  const [pending, setPending] = useState<PendingPath | null>(null);
  const [waitMinutes, setWaitMinutes] = useState(10);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showSummary, setShowSummary] = useState(false);
  // A picture of the map for the summary and print: undefined while drawing, null if none.
  const [mapImage, setMapImage] = useState<string | null | undefined>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const mapRef = useRef<MapHandle>(null);

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
    setMapImage(null); // Any earlier picture of the plan is out of date.
  }, [anchorPlace, timeInput, committed]);

  useEffect(() => {
    if (!showSummary) return;
    setMapImage(undefined);
    let current = true;
    mapRef.current?.snapshot().then((image) => current && setMapImage(image));
    return () => {
      current = false;
    };
  }, [showSummary]);

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
  const uncovered = uncoveredOn(feeds, day);

  // The ride you'd change from (forwards) or to (backwards), for transfer rules.
  const ride = plan ? adjacentRide(plan, direction) : null;

  // While Transit is chosen, the departures (or arrivals) near the frontier are listed, and
  // found again whenever anything they depend on changes.
  const onIt = ride?.transit;
  const transitSearch: TransitSearch | null =
    mode === 'transit' && frontier && health?.gtfs_loaded !== false
      ? {
          direction,
          query: {
            point: { lat: frontier.place.lat, lon: frontier.place.lon },
            time: frontier.time,
            radiusM: Math.min(RADIUS_MAX_M, Math.max(RADIUS_MIN_M, radiusM || 500)),
            access,
            transfer: transferContext(ride, direction),
            perRoute: TRIPS_PER_LINE,
            limit: CALL_LIMIT,
          },
          // Don't offer the trip you're already on at this end of the plan.
          skip: onIt && { tripId: onIt.tripId, serviceDate: onIt.serviceDate },
        }
      : null;
  const transit = useTransitList(transitSearch);
  const calls = transit.calls;

  const listing = forward ? 'departures' : 'arrivals';
  const lines = useMemo(() => (calls ? groupCalls(calls, listing) : []), [calls, listing]);
  // The lines are on the map while the list is showing; a chosen trip takes their place.
  const previews = useMemo(
    () => (selection ? NO_PREVIEWS : linePreviews(lines, listing, transit.paths)),
    [selection, lines, listing, transit.paths],
  );

  const tripPreview: TripPreview | null = useMemo(() => {
    if (!selection) return null;
    const { call, trip } = selection;
    const seq = call.stop_sequence;
    const choices = new Set(stopChoices(trip, seq, direction).map((s) => s.stop_sequence));
    return {
      color: trip.route.color,
      stops: trip.stops
        .filter((s) => (direction === 'forward' ? s.stop_sequence >= seq : s.stop_sequence <= seq))
        .map((s) => ({
          lat: s.stop.lat,
          lon: s.stop.lon,
          name: s.stop.name,
          sequence: s.stop_sequence,
          time: direction === 'forward' ? s.arrival : s.departure,
          choosable: choices.has(s.stop_sequence),
        })),
      line: previewLine(trip, seq, direction),
    };
  }, [selection, direction]);

  const closeSummary = useCallback(() => setShowSummary(false), []);

  function resetBuilder() {
    setSelection(null);
    setPending(null);
    // The rows pointed at may be gone; their mouse-leave events never come.
    setListHover(null);
    setMapHover([]);
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
      setNotice('To walk or bike somewhere, right-click it on the map.');
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

  /** A walk or bike route between the frontier and a point, named after a nearby stop. */
  async function routeAtFrontier(from: Plan, m: PathMode, point: LatLon): Promise<PendingPath> {
    const frontierPlace = (forward ? planEnd(from) : planStart(from)).place;
    const [route, nearest] = await Promise.all([
      forward ? routeOrEstimate(m, frontierPlace, point) : routeOrEstimate(m, point, frontierPlace),
      nearestStop(point),
    ]);
    return { mode: m, place: { ...point, name: pinName(point, nearest) }, route };
  }

  /** Adds a walk or bike leg between the frontier and its place. */
  function addPath(to: Plan, { place, route }: PendingPath) {
    commit(
      forward
        ? appendLegs(to, [pathLeg(planEnd(to), place, route)])
        : prependLegs(to, [pathLegArriving(place, planStart(to), route)]),
    );
  }

  const choosePathPoint = (point: LatLon) =>
    run(async () => {
      if (!plan || (mode !== 'walk' && mode !== 'bike')) return;
      setPending(await routeAtFrontier(plan, mode, point));
    });

  function addPending() {
    if (!plan || !pending) return;
    const name = pending.place.name?.trim() || pinName(pending.place);
    addPath(plan, { ...pending, place: { ...pending.place, name } });
  }

  /** From the map's right-click menu: walk or bike there (or from there), added at once. */
  const addPathAt = (m: PathMode, point: LatLon) =>
    run(async () => {
      if (plan) addPath(plan, await routeAtFrontier(plan, m, point));
    });

  // What a right-click on the map offers, following After the end / Before the start.
  const mapMenu: MapMenuItem[] =
    plan && !movingAnchor
      ? [
          { id: 'walk', label: forward ? 'Walk here' : 'Walk from here' },
          { id: 'bike', label: forward ? 'Bike here' : 'Bike from here' },
        ]
      : [];

  function addWait() {
    if (!plan || !(waitMinutes > 0)) return;
    const seconds = Math.round(waitMinutes * 60);
    commit(
      forward
        ? appendLegs(plan, [waitLeg(planEnd(plan), seconds, 'forward')])
        : prependLegs(plan, [waitLeg(planStart(plan), seconds, 'backward')]),
    );
  }

  const chooseCall = (call: TransitCall) =>
    run(async () => {
      setSelection({ call, trip: await api.trip(call.trip_id, call.service_date) });
      // The rows pointed at are gone now; their mouse-leave events never come.
      setListHover(null);
      setMapHover([]);
    });

  /** A line picked by name, in the list or on the map: its next trip (or last arrival). */
  function chooseLine(key: string) {
    const group = lines.find((l) => l.key === key);
    if (group && !busy) void chooseCall(lineCall(group, listing));
  }

  const chooseStop = (stopSequence: number) =>
    run(async () => {
      if (!plan || !selection) return;
      const { call, trip } = selection;
      const callStop = stopPlace(call.stop);
      let result: LegsResult;
      if (forward) {
        const from = planEnd(plan);
        const toStop = needsConnector(from.place, callStop)
          ? await routeOrEstimate(access, from.place, callStop)
          : null;
        result = boardingLegs(from, trip, call.stop_sequence, stopSequence, toStop);
        if (result.ok) commit(appendLegs(plan, result.legs));
      } else {
        const to = planStart(plan);
        const fromStop = needsConnector(callStop, to.place)
          ? await routeOrEstimate(access, callStop, to.place)
          : null;
        result = alightingLegs(to, trip, stopSequence, call.stop_sequence, fromStop);
        if (result.ok) commit(prependLegs(plan, result.legs));
      }
      if (!result.ok) setError(result.reason);
    });

  /** Commit an edit to a leg, or return why it was refused. */
  function applyEdit(result: EditResult): string | null {
    if (!result.ok) return result.reason;
    commit(result.plan);
    return null;
  }

  /** Re-route a walk or bike leg the other way: walk <-> bike, keeping its place in the plan. */
  const switchMode = (legId: string) =>
    run(async () => {
      const leg = plan?.legs.find((l) => l.id === legId);
      if (!plan || !leg || (leg.mode !== 'walk' && leg.mode !== 'bike')) return;
      const other = leg.mode === 'walk' ? 'bike' : 'walk';
      const route = await routeOrEstimate(other, leg.start.place, leg.end.place);
      const refusal = applyEdit(setLegPath(plan, legId, other, pathInfo(route)));
      if (refusal) setError(refusal);
    });

  function openSummary() {
    resetBuilder(); // So the map picture shows just the plan (the line previews hide too).
    setShowSummary(true);
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
              {health.gtfs_problem ?? 'No transit data loaded. Run uv run ir-load-gtfs in backend/.'}
            </p>
          )}
          {uncovered.length > 0 && (
            <p className="warning">
              Schedule data doesn't cover {day} for: {uncovered.join(', ')}. Re-run{' '}
              <code>ir-load-gtfs</code>.
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
              onSetDuration={(legId, s) => applyEdit(setLegDuration(committed, legId, s))}
              onSetStart={(legId, time) => applyEdit(setLegStart(committed, legId, time))}
              onSetEnd={(legId, time) => applyEdit(setLegEnd(committed, legId, time))}
              onSwitchMode={switchMode}
              onMerge={(legId, nextId) => {
                const refusal = applyEdit(mergeWithNext(committed, legId, nextId));
                if (refusal) setError(refusal);
              }}
              onRename={(place, name) => commit(renamePlace(committed, place, name))}
              onRemove={(legId) => commit(removeLeg(committed, legId))}
              onUndo={undo}
              canUndo={history.length > 0}
              onClear={clear}
              onSummary={openSummary}
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
              access={access}
              onAccess={setAccess}
              calls={calls}
              searching={transit.searching}
              searchError={transit.error}
              onRetrySearch={transit.retry}
              noteFor={(call) => transferNote(call, ride, direction)}
              selection={selection}
              onChooseCall={chooseCall}
              onChooseLine={chooseLine}
              onHoverLine={setListHover}
              highlightLines={mapHover}
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
            Transit data: 511.org · Routing: {health?.routing_provider ?? '…'} · Map ©
            OpenStreetMap contributors, OpenFreeMap
          </footer>
        </aside>
        <MapView
          ref={mapRef}
          start={committed ? planStart(committed).place : anchorPlace}
          end={committed ? planEnd(committed).place : null}
          lines={showSummary ? NO_PREVIEWS : previews}
          focusLine={listHover}
          tripPreview={tripPreview}
          pendingPoint={pending?.place ?? null}
          pendingRoute={pending?.route.geometry ?? null}
          picking={picking !== null}
          legs={committed?.legs ?? NO_LEGS}
          onPick={pickOnMap}
          onHoverLines={setMapHover}
          onChooseLine={chooseLine}
          onChooseStop={(sequence) => !busy && void chooseStop(sequence)}
          menu={mapMenu}
          onMenu={(id, point) => {
            if (!busy && (id === 'walk' || id === 'bike')) void addPathAt(id, point);
          }}
        />
      </div>
      {showSummary && committed && (
        <PlanSummary
          plan={committed}
          issues={issues}
          mapImage={mapImage}
          onClose={closeSummary}
        />
      )}
      {committed && (
        <div className="print-only">
          <h1>Trip plan</h1>
          {mapImage && <img className="plan-map" src={mapImage} alt="Map of the whole trip" />}
          <PlanTable plan={committed} issues={issues} />
        </div>
      )}
    </>
  );
}
