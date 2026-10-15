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
import { UndoBar } from './components/UndoBar';
import { uncoveredOn } from './coverage';
import { isTypingIn, isUndoKey } from './keys';
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
  removeFrom,
  renamePlace,
  setLegDuration,
  setLegEnd,
  setLegPath,
  setLegStart,
} from './plan/plan';
import { adjacentRide, transferContext, transferNote } from './plan/transfers';
import type { Direction, Leg, LegMode, Place, Plan } from './plan/types';
import { loadHistory, loadSession, saveHistory, saveSession } from './storage';
import { isPlausibleInput, localInputToIso, nowLocalInput, toLocalInput } from './time';
import { type TransitSearch, useTransitList } from './transitList';
import type { UndoLabel, UndoStep } from './undo';

const NO_LEGS: Leg[] = [];
const NO_PREVIEWS: LinePreview[] = [];
const RADIUS_MIN_M = 50;
const RADIUS_MAX_M = 3000; // The backend's limit.
// The backend's maximum too. With a few trips per line it holds every line downtown, even
// within 3 km (about 360 trips at Civic Center).
const CALL_LIMIT = 500;
// The undo history can be large, so it's saved this long after it last changed (or when you
// leave the page) rather than at every change, as the plan is.
const HISTORY_SAVE_DELAY_MS = 1000;

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
  // Once legs exist the plan lives here; earlier versions are kept for undo, across reloads.
  const [committed, setCommitted] = useState<Plan | null>(saved?.plan ?? null);
  const [history, setHistory] = useState<UndoStep[]>(() => (saved ? loadHistory(saved.plan) : []));

  // Building the next leg.
  const [direction, setDirection] = useState<Direction>(saved?.direction ?? 'forward');
  const [mode, setMode] = useState<LegMode>('transit');
  const [radiusM, setRadiusM] = useState(500);
  // How you get to (or from) the stop for a transit leg.
  const [access, setAccess] = useState<PathMode>('walk');
  const [selection, setSelection] = useState<TripSelection | null>(null);
  // The line pointed at in the list (highlighted on the map), the one it rested on (framed on
  // the map), and those pointed at on the map (marked in the list).
  const [listHover, setListHover] = useState<string | null>(null);
  const [listDwell, setListDwell] = useState<string | null>(null);
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
    saveSession({ anchor: anchorPlace, timeInput, plan: committed, direction });
    setMapImage(null); // Any earlier picture of the plan is out of date.
  }, [anchorPlace, timeInput, committed, direction]);

  useEffect(() => {
    let unsaved = true;
    const save = () => {
      if (unsaved) saveHistory(history, committed);
      unsaved = false;
    };
    const timer = setTimeout(save, HISTORY_SAVE_DELAY_MS);
    const onHide = () => document.visibilityState === 'hidden' && save();
    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('pagehide', save);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [history, committed]);

  useEffect(() => {
    if (!showSummary) return;
    setMapImage(undefined);
    let current = true;
    mapRef.current?.snapshot().then((image) => current && setMapImage(image));
    return () => {
      current = false;
    };
  }, [showSummary]);

  const anchorTime = useMemo(
    // Not while the field is half-typed or cleared, or its year is still being typed.
    () => (isPlausibleInput(timeInput) ? localInputToIso(timeInput) : null),
    [timeInput],
  );

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
  const uncovered = committed || anchorTime ? uncoveredOn(feeds, day) : [];

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
    setListDwell(null);
    setMapHover([]);
  }

  /**
   * Keep the plan as it is now, start point and time included, so Undo can bring it back.
   * `label` names the change about to be made: the button then reads "Undo <label>". Call it
   * before changing the start of a plan without legs; changes to legs go through commit.
   */
  function remember(label: UndoLabel) {
    if (plan) setHistory((h) => [...h, { label, plan }]);
  }

  /** Make `next` the plan, after a change named `label`. Undo goes back to the plan before. */
  function commit(next: Plan, label: UndoLabel) {
    if (!plan) return;
    remember(label);
    setCommitted(next.legs.length ? next : null);
    // Renaming places renames the start point too.
    setAnchorPlace(next.anchor.place);
    resetBuilder();
  }

  function undo() {
    const previous = history[history.length - 1]?.plan;
    if (!previous) return;
    setHistory((h) => h.slice(0, -1));
    setCommitted(previous.legs.length ? previous : null);
    // The start point may differ (after undoing an import or a rename), so restore it too.
    setAnchorPlace(previous.anchor.place);
    setTimeInput(toLocalInput(previous.anchor.time));
    setMovingAnchor(false);
    resetBuilder();
  }

  // Ctrl+Z (Cmd+Z on a Mac) undoes too, but not in a field, which keeps its own undo, nor while
  // the summary is open over the plan or a request is under way. Holding the keys down undoes
  // one step, not one for each repeat.
  const undoKey = useRef<() => void>(undefined);
  useEffect(() => {
    undoKey.current = () => !showSummary && !busy && undo();
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !isUndoKey(e) || isTypingIn(e.target)) return;
      e.preventDefault();
      if (!e.repeat) undoKey.current?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /** Remove every leg but keep the start point. Undo brings them back. */
  function clear() {
    if (!plan) return;
    remember('clear plan');
    setCommitted(null);
    // A plan without legs starts forwards, as after a reload.
    setDirection('forward');
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
      'add',
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
      'add',
    );
  }

  const chooseCall = (call: TransitCall) =>
    run(async () => {
      setSelection({ call, trip: await api.trip(call.trip_id, call.service_date) });
      // The rows pointed at are gone now; their mouse-leave events never come.
      setListHover(null);
      setListDwell(null);
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
        if (result.ok) commit(appendLegs(plan, result.legs), 'add');
      } else {
        const to = planStart(plan);
        const fromStop = needsConnector(callStop, to.place)
          ? await routeOrEstimate(access, callStop, to.place)
          : null;
        result = alightingLegs(to, trip, stopSequence, call.stop_sequence, fromStop);
        if (result.ok) commit(prependLegs(plan, result.legs), 'add');
      }
      if (!result.ok) setError(result.reason);
    });

  /** Commit an edit to a leg, or return why it was refused. */
  function applyEdit(result: EditResult, label: UndoLabel): string | null {
    if (!result.ok) return result.reason;
    commit(result.plan, label);
    return null;
  }

  /** Re-route a walk or bike leg the other way: walk <-> bike, keeping its place in the plan. */
  const switchMode = (legId: string) =>
    run(async () => {
      const leg = plan?.legs.find((l) => l.id === legId);
      if (!plan || !leg || (leg.mode !== 'walk' && leg.mode !== 'bike')) return;
      const other = leg.mode === 'walk' ? 'bike' : 'walk';
      const route = await routeOrEstimate(other, leg.start.place, leg.end.place);
      const label = other === 'bike' ? 'switch to bike' : 'switch to walk';
      const refusal = applyEdit(setLegPath(plan, legId, other, pathInfo(route)), label);
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
    // The history of the plan you had is dropped, but Undo can still bring that plan back.
    setHistory(plan ? [{ label: 'open plan', plan }] : []);
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
              direction={direction}
              onSetDuration={(legId, s) =>
                applyEdit(setLegDuration(committed, legId, s), 'time change')
              }
              onSetStart={(legId, time) =>
                applyEdit(setLegStart(committed, legId, time), 'time change')
              }
              onSetEnd={(legId, time) =>
                applyEdit(setLegEnd(committed, legId, time), 'time change')
              }
              onSwitchMode={switchMode}
              onMerge={(legId, nextId) => {
                const refusal = applyEdit(mergeWithNext(committed, legId, nextId), 'merge');
                if (refusal) setError(refusal);
              }}
              onRename={(place, name) => commit(renamePlace(committed, place, name), 'rename')}
              onRemove={(legId) => commit(removeFrom(committed, legId, direction), 'remove')}
              onSummary={openSummary}
              disabled={busy}
            />
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
              onDwellLine={setListDwell}
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

          {(committed || history.length > 0) && (
            <UndoBar
              history={history}
              onUndo={undo}
              canClear={!!committed}
              onClear={clear}
              disabled={busy}
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
          frameLine={listDwell}
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
