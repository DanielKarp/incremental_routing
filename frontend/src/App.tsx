import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  api,
  type FeedInfo,
  type Health,
  type LatLon,
  type PathMode,
  type RouteResult,
  type TransitCall,
} from './api';
import { TRIPS_PER_LINE, groupCalls, lineKey } from './callGroups';
import { Itinerary, type LegMessage } from './components/Itinerary';
import { type MapHandle, MapView, type SavedView, type TripPreview } from './components/MapView';
import {
  type AddedLegs,
  NextLeg,
  type PendingPath,
  type TripSelection,
} from './components/NextLeg';
import { PlanSummary } from './components/PlanSummary';
import { PlanTable } from './components/PlanTable';
import { StartSection } from './components/StartSection';
import { UndoBar } from './components/UndoBar';
import { uncoveredOn } from './coverage';
import { DoubleClicks } from './doubleClicks';
import { isTypingIn, isUndoKey } from './keys';
import { filterLines } from './lineFilter';
import { type LinePreview, lineCall, linePreviews } from './linePreviews';
import { type ListSpot, listSpot, putListBack } from './listReturn';
import { emptyClick, mapMenuItems } from './mapClicks';
import {
  NEAR_STOP_M,
  alightingLegs,
  boardingLegs,
  connectorEnds,
  estimatedRoute,
  missedTrip,
  namedPlaceNear,
  nudgedPlace,
  pathInfo,
  pathLeg,
  pathLegArriving,
  pinName,
  previewLine,
  stopChoices,
  stopPlace,
  waitLeg,
} from './plan/build';
import { addedText, parsePlanJson } from './plan/files';
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
  startsAtAnchor,
  switchMoved,
  withName,
} from './plan/plan';
import { adjacentRide, transferContext, transferNote } from './plan/transfers';
import type { Direction, Leg, LegMode, Place, Plan, Waypoint } from './plan/types';
import {
  CALL_LIMIT,
  LONG_WINDOW_MIN,
  type SearchScope,
  WINDOW_MIN,
  searchRadius,
} from './searchScope';
import { keepFocusInView } from './scroll';
import { loadHistory, loadSession, saveHistory, saveSession } from './storage';
import { isPlausibleInput, localInputToIso, nowLocalInput, toLocalInput } from './time';
import { type TransitSearch, useTransitList } from './transitList';
import { type UndoLabel, type UndoStep, undoesTime } from './undo';

const NO_LEGS: Leg[] = [];
const NO_PREVIEWS: LinePreview[] = [];
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

/** A walk or bike route, or a straight-line estimate when the router fails, and why. */
interface Routed {
  route: RouteResult;
  fallback: string | null;
}

/** The list of lines as you left it for the stop chooser, and the map then (see backToList). */
interface ListLeft {
  spot: ListSpot;
  view: SavedView | null;
}

async function routeWithFallback(m: PathMode, from: Place, to: Place): Promise<Routed> {
  try {
    return { route: await api.route(m, from, to), fallback: null };
  } catch (e) {
    return {
      route: estimatedRoute(m, from, to),
      fallback: `Routing unavailable (${(e as Error).message}); using a straight-line estimate.`,
    };
  }
}

export function App() {
  const [saved] = useState(loadSession);
  const [health, setHealth] = useState<Health | null>(null);
  const [feeds, setFeeds] = useState<FeedInfo[]>([]);

  // The point the plan grows from. Editable until the first leg is added.
  const [anchorPlace, setAnchorPlace] = useState<Place | null>(saved?.anchor ?? null);
  const [timeInput, setTimeInput] = useState(saved?.timeInput ?? nowLocalInput());
  // Move was clicked: the next click on the map moves the start there.
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
  // What's typed in Filter lines, and whether the list looks 3 hours ahead (or back) rather
  // than one. Both are for one end of the plan (see listFor).
  const [lineFilter, setLineFilter] = useState('');
  const [longWindow, setLongWindow] = useState(false);
  const [selection, setSelection] = useState<TripSelection | null>(null);
  // The line pointed at in the list (highlighted on the map), the one it rested on (framed on
  // the map), and those pointed at on the map (marked in the list).
  const [listHover, setListHover] = useState<string | null>(null);
  const [listDwell, setListDwell] = useState<string | null>(null);
  const [mapHover, setMapHover] = useState<string[]>([]);
  const [pending, setPending] = useState<PendingPath | null>(null);
  // Each walk or bike route asked for counts up, so only the latest answer is used.
  const pathRequest = useRef(0);
  const [waitMinutes, setWaitMinutes] = useState(10);
  // The mode chosen before Wait, which Next leg goes back to once the wait is added.
  const modeBeforeWait = useRef<LegMode>('transit');
  // The walk or bike ride to the stop of the trip picked (from it, planning backwards). It's
  // routed as soon as the trip is picked, so the stop list can say if it misses the trip, and
  // choosing a stop uses it. Kept for the next pick at the same stop, unless it's an estimate.
  const connector = useRef<{ key: string; routed: Promise<Routed>; estimated?: boolean } | null>(
    null,
  );
  const [connectorDone, setConnectorDone] = useState<{ key: string; routed: Routed } | null>(null);
  // Where the list of lines was when a trip was picked from it, and the map's view then. Back
  // from the stop chooser puts both back; anything else that leaves it forgets them.
  const listLeft = useRef<ListLeft | null>(null);
  // Back was chosen: the list is put back as soon as it shows.
  const [returning, setReturning] = useState<ListLeft | null>(null);

  const [busy, setBusy] = useState(false);
  // What's gone wrong, or is worth knowing: about the app or a file you opened (at the top of
  // the panel), about what you're doing under Next leg (shown there), or about one leg.
  const [alert, setAlert] = useState<{ text: string; tone: 'error' | 'notice' } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [legMessage, setLegMessage] = useState<LegMessage | null>(null);
  // What the last add under Next leg was, said there until the plan next changes.
  const [added, setAdded] = useState<AddedLegs | null>(null);
  const addCount = useRef(0);
  const [showSummary, setShowSummary] = useState(false);
  // A picture of the map for the summary and print: undefined while drawing, null if none.
  const [mapImage, setMapImage] = useState<string | null | undefined>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const mapRef = useRef<MapHandle>(null);
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    api
      .health()
      .then((h) => {
        setHealth(h);
        if (h.gtfs_loaded) return api.feeds().then(setFeeds);
      })
      .catch((e: Error) => setAlert({ text: `Backend unreachable: ${e.message}`, tone: 'error' }));
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
  // What a click on empty map does: set (or move) the point the plan grows from, pick a walk or
  // bike end point, or open the map's menu there.
  const onEmptyClick = emptyClick({
    hasStart: !!anchorPlace,
    movingStart: movingAnchor,
    pathMode,
  });

  const day = timeInput.slice(0, 10);
  const uncovered = committed || anchorTime ? uncoveredOn(feeds, day) : [];

  // The ride you'd change from (forwards) or to (backwards), for transfer rules.
  const ride = plan ? adjacentRide(plan, direction) : null;

  // The line filter and the longer window are kept while you go into the stop chooser and back
  // or change the radius, but not once the plan's end (or start, backwards) moves to another
  // place, or you plan from the other end. Before the first leg that's the start point, which
  // stays put while you type a time.
  const at = frontier?.place ?? anchorPlace;
  const listFor = at && JSON.stringify([direction, at.lat, at.lon]);
  const [filterFor, setFilterFor] = useState(listFor);
  if (filterFor !== listFor) {
    setFilterFor(listFor);
    setLineFilter('');
    setLongWindow(false);
  }

  // While Transit is chosen, the departures (or arrivals) near the frontier are listed, and
  // found again whenever anything they depend on changes.
  const onIt = ride?.transit;
  const scope: SearchScope | null = frontier && {
    direction,
    time: frontier.time,
    radiusM: searchRadius(radiusM),
    windowMin: longWindow ? LONG_WINDOW_MIN : WINDOW_MIN,
  };
  const transitSearch: TransitSearch | null =
    mode === 'transit' && frontier && scope && health?.gtfs_loaded !== false
      ? {
          direction,
          query: {
            point: { lat: frontier.place.lat, lon: frontier.place.lon },
            time: frontier.time,
            radiusM: scope.radiusM,
            windowMin: scope.windowMin,
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
  // Those that Filter lines lets through, in the list and on the map.
  const shownLines = useMemo(() => filterLines(lines, lineFilter), [lines, lineFilter]);
  // The lines are on the map while the list is showing; a chosen trip takes their place.
  const previews = useMemo(
    () =>
      selection
        ? NO_PREVIEWS
        : linePreviews(shownLines, listing, transit.paths, access, (call) =>
            transferNote(call, ride, direction),
          ),
    [selection, shownLines, listing, transit.paths, access, ride, direction],
  );
  // A row pointed at may have been filtered out since; its mouse-leave event never comes.
  const shown = (key: string | null) => (key && previews.some((p) => p.key === key) ? key : null);

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
    listLeft.current = null;
    setReturning(null);
    setPending(null);
    pathRequest.current++; // A walk or bike route still on its way is no longer wanted.
    // The rows pointed at may be gone; their mouse-leave events never come.
    setListHover(null);
    setListDwell(null);
    setMapHover([]);
  }

  /**
   * A new action starts: what was said about the last one goes, under Next leg and under a leg.
   * Not inside commit(), which would drop a notice the same action has just given.
   */
  function clearMessages() {
    setError(null);
    setNotice(null);
    setLegMessage(null);
  }

  /** Say why a change to a leg was refused, under that leg (or under Next leg if it's gone). */
  function refuseLeg(legId: string, text: string) {
    if (plan?.legs.some((l) => l.id === legId)) setLegMessage({ legId, text, tone: 'error' });
    else setError(text);
  }

  /**
   * Keep the plan as it is now, start point and time included, so Undo can bring it back.
   * `label` names the change about to be made: the button then reads "Undo <label>". Call it
   * before changing the start of a plan without legs; changes to legs go through commit.
   */
  function remember(label: UndoLabel) {
    // While the time can't be read there's no plan, but a move of the start is kept all the
    // same: undoing it doesn't set the time back (see undoesTime), so any time will do.
    const before: Plan | null =
      plan ??
      (anchorPlace && !undoesTime(label)
        ? { anchor: { place: anchorPlace, time: new Date().toISOString() }, legs: [] }
        : null);
    if (before) setHistory((h) => [...h, { label, plan: before }]);
  }

  /** Make `next` the plan, after a change named `label`. Undo goes back to the plan before. */
  function commit(next: Plan, label: UndoLabel) {
    if (!plan) return;
    remember(label);
    setCommitted(next.legs.length ? next : null);
    // Renaming places renames the start point too.
    setAnchorPlace(next.anchor.place);
    // Once there are legs the start stays put.
    setMovingAnchor(false);
    resetBuilder();
    setAdded(null); // Said only until the plan next changes.
  }

  /**
   * Commit legs added under Next leg (`legs`, already in `next`). Next leg says what they were
   * and comes back into view (see NextLeg).
   */
  function commitAdd(next: Plan, legs: Leg[]) {
    commit(next, 'add');
    setAdded({ id: ++addCount.current, text: addedText(legs) });
  }

  function undo() {
    const step = history[history.length - 1];
    if (!step) return;
    const previous = step.plan;
    clearMessages();
    setHistory((h) => h.slice(0, -1));
    setCommitted(previous.legs.length ? previous : null);
    // The start point may differ (after undoing an import, a rename or a move), so restore it
    // too. Its time as well, unless that has changed since by itself (see undoesTime).
    setAnchorPlace(previous.anchor.place);
    if (undoesTime(step.label)) setTimeInput(toLocalInput(previous.anchor.time));
    setMovingAnchor(false);
    resetBuilder();
    setAdded(null);
  }

  // Ctrl+Z (Cmd+Z on a Mac) undoes too, but not in a field, which keeps its own undo, nor while
  // the summary is open over the plan or a request is under way. Holding the keys down undoes
  // one step, not one for each repeat.
  const undoKey = useRef<() => void>(undefined);
  // Escape steps back out of what you're doing: it cancels moving the start, or else a walk or
  // bike leg waiting to be added, or else it leaves the stop chooser for the list of lines. It
  // closes an open menu on the map first, and the summary next (they mark the key as used), and
  // it's left to a field that has focus. It returns whether it did anything.
  const escapeKey = useRef<() => boolean>(undefined);
  useEffect(() => {
    undoKey.current = () => !showSummary && !busy && undo();
    escapeKey.current = () => {
      if (showSummary) return false;
      if (movingAnchor) setMovingAnchor(false);
      else if (pending) cancelPending();
      else if (selection && !busy) backToList();
      else return false;
      return true;
    };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTypingIn(e.target)) return;
      if (e.key === 'Escape') {
        if (escapeKey.current?.()) e.preventDefault();
        return;
      }
      if (!isUndoKey(e)) return;
      e.preventDefault();
      if (!e.repeat) undoKey.current?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // The second click of a double-click only goes where the first one did (see DoubleClicks), so
  // it can't do whatever the first click put under the pointer. It's stopped before anything
  // else sees it.
  useEffect(() => {
    const clicks = new DoubleClicks();
    const onClick = (e: MouseEvent) => {
      if (!clicks.strays(e)) return;
      e.stopPropagation();
      e.preventDefault();
    };
    window.addEventListener('click', onClick, true);
    return () => window.removeEventListener('click', onClick, true);
  }, []);

  /** Remove every leg but keep the start point. Undo brings them back. */
  function clear() {
    if (!plan) return;
    clearMessages();
    remember('clear plan');
    setCommitted(null);
    // A plan without legs starts forwards, as after a reload.
    setDirection('forward');
    resetBuilder();
    setAdded(null);
    // Even when the plan ended where it started.
    setLineFilter('');
    setLongWindow(false);
  }

  /** Runs an action that waits for the backend. What goes wrong is said by `fail`. */
  async function run(task: () => Promise<void>, fail: (reason: string) => void = setError) {
    setBusy(true);
    setAlert(null);
    clearMessages();
    try {
      await task();
    } catch (e) {
      fail((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** A walk or bike route for Next leg; if it's only estimated, Next leg says so. */
  async function routeOrEstimate(m: PathMode, from: Place, to: Place): Promise<RouteResult> {
    const { route, fallback } = await routeWithFallback(m, from, to);
    if (fallback) setNotice(fallback);
    return route;
  }

  function pickOnMap(point: LatLon) {
    if (onEmptyClick === 'start') moveAnchor(point);
    else if (onEmptyClick === 'path' && !busy) void choosePathPoint(point);
  }

  /**
   * Set the point the plan grows from, or move it there before the first leg: from Move, the
   * map's menu or by dragging its pin. Undo puts it back. False if it can't move now.
   */
  function moveAnchor(point: LatLon): boolean {
    if (committed || busy) return false;
    clearMessages();
    remember('move start');
    void chooseAnchor(point);
    return true;
  }

  async function chooseAnchor(point: LatLon) {
    // Nudged, it keeps a name you gave it; otherwise it's named after a stop nearby.
    const nudged = nudgedPlace(anchorPlace, point);
    const provisional: Place = nudged ?? { ...point, name: pinName(point) };
    setAnchorPlace(provisional);
    setMovingAnchor(false);
    resetBuilder();
    if (nudged) return;
    const nearest = await nearestStop(point);
    // Name it after a nearby stop, unless it has been renamed or moved meanwhile.
    if (nearest) {
      setAnchorPlace((current) =>
        current === provisional ? { ...provisional, name: pinName(point, nearest) } : current,
      );
    }
  }

  /** A walk or bike route between the frontier and a place, in the direction of travel. */
  function routeAtFrontier(from: Plan, m: PathMode, place: Place): Promise<RouteResult> {
    const frontierPlace = (forward ? planEnd(from) : planStart(from)).place;
    return forward
      ? routeOrEstimate(m, frontierPlace, place)
      : routeOrEstimate(m, place, frontierPlace);
  }

  /**
   * A walk or bike route between the frontier and a point, named after a place you named in
   * the plan nearby (see namedPlaceNear), or else after a nearby stop.
   */
  async function pathToPoint(from: Plan, m: PathMode, point: LatLon): Promise<PendingPath> {
    const named = namedPlaceNear(from, point, direction);
    const [route, nearest] = await Promise.all([
      routeAtFrontier(from, m, named ?? point),
      named ? null : nearestStop(point),
    ]);
    return { mode: m, place: named ?? { ...point, name: pinName(point, nearest) }, route };
  }

  /** Adds a walk or bike leg between the frontier and its place. */
  function addPath(to: Plan, { place, route }: PendingPath) {
    const leg = forward
      ? pathLeg(planEnd(to), place, route)
      : pathLegArriving(place, planStart(to), route);
    commitAdd(forward ? appendLegs(to, [leg]) : prependLegs(to, [leg]), [leg]);
  }

  const choosePathPoint = (point: LatLon) =>
    run(async () => {
      if (!plan || (mode !== 'walk' && mode !== 'bike')) return;
      const request = ++pathRequest.current;
      const picked = await pathToPoint(plan, mode, point);
      // Not if you've picked another point, changed mode or added a leg meanwhile.
      if (request === pathRequest.current) setPending(picked);
    });

  /** The point picked for a walk or bike leg, routed the other way, keeping its name. */
  const reroutePending = (picked: PendingPath, m: PathMode) =>
    run(async () => {
      if (!plan) return;
      const request = ++pathRequest.current;
      const route = await routeAtFrontier(plan, m, picked.place);
      // The name may have been edited meanwhile, so only the route and mode change.
      if (request === pathRequest.current) setPending((p) => p && { ...p, mode: m, route });
    });

  function addPending() {
    if (!plan || !pending || busy || pending.mode !== mode) return;
    const typed = pending.place.name?.trim();
    // A name cleared in the card is named after its coordinates, which aren't yours.
    const place = typed ? { ...pending.place, name: typed } : withName(pending.place, '');
    addPath(plan, { ...pending, place: { ...place, name: place.name || pinName(place) } });
  }

  function cancelPending() {
    setPending(null);
    pathRequest.current++;
  }

  /** From the map's menu: walk or bike there (or from there), added at once. */
  const addPathAt = (m: PathMode, point: LatLon) =>
    run(async () => {
      if (plan) addPath(plan, await pathToPoint(plan, m, point));
    });

  // What the map's menu offers (on a right-click, or a click that picks nothing): moving the
  // start before the first leg, and walking or biking there, following the direction. Nothing
  // while the summary covers the map, so a menu left open there closes (see MapView).
  const mapMenu = showSummary
    ? []
    : mapMenuItems({
        startMovable: !!anchorPlace && !committed,
        canAddLegs: !!plan,
        direction,
      });

  /**
   * Choose the mode under Next leg. With a point picked for a walk or bike leg, switching
   * between Walk and Bike routes that point again; anything else starts the leg over.
   */
  function chooseMode(m: LegMode) {
    clearMessages();
    if (m === 'wait' && mode !== 'wait') modeBeforeWait.current = mode;
    const keep = pending && m !== mode && (m === 'walk' || m === 'bike') ? pending : null;
    setMode(m);
    resetBuilder(); // Which also drops a route still on its way.
    if (keep && (m === 'walk' || m === 'bike')) {
      setPending(keep); // Shown, but not added, until it's routed for this mode.
      if (keep.mode !== m) void reroutePending(keep, m);
    }
  }

  /** From the Wait panel. Next leg then goes back to the mode you had before Wait. */
  function addWait(minutes: number) {
    if (!plan || !(minutes > 0) || busy) return;
    clearMessages();
    const seconds = Math.round(minutes * 60);
    const leg = forward
      ? waitLeg(planEnd(plan), seconds, 'forward')
      : waitLeg(planStart(plan), seconds, 'backward');
    commitAdd(forward ? appendLegs(plan, [leg]) : prependLegs(plan, [leg]), [leg]);
    setMode(modeBeforeWait.current);
  }

  /** The walk or bike ride between the frontier and a trip's stop, if one is needed. */
  function connectorFor(call: TransitCall, at: Waypoint | null = frontier) {
    const ends = at && connectorEnds(at.place, stopPlace(call.stop), direction);
    if (!ends) return null;
    const key = JSON.stringify([access, ends.from.lat, ends.from.lon, ends.to.lat, ends.to.lon]);
    return { ...ends, key };
  }

  /** Starts routing the connection to (or from) a trip's stop, or reuses one for that stop. */
  function routeConnector(call: TransitCall) {
    const c = connectorFor(call);
    if (!c) return;
    const known = connector.current;
    if (known?.key === c.key && !known.estimated) return;
    const entry: { key: string; routed: Promise<Routed>; estimated?: boolean } = {
      key: c.key,
      routed: routeWithFallback(access, c.from, c.to),
    };
    connector.current = entry;
    void entry.routed.then((routed) => {
      // An estimate is used for this pick, but the next one tries the router again.
      entry.estimated = !!routed.fallback;
      if (connector.current === entry) setConnectorDone({ key: c.key, routed });
    });
  }

  const chooseCall = (call: TransitCall) => {
    // From the list or the map, rather than instead of the trip being chosen: Back comes back to
    // the list and the map as they are now.
    if (!selection && panel.current) {
      listLeft.current = {
        spot: listSpot(panel.current, lineKey(call)),
        view: mapRef.current?.saveView() ?? null,
      };
    }
    // The stops are listed without waiting for this route.
    routeConnector(call);
    return run(async () => {
      setSelection({ call, trip: await api.trip(call.trip_id, call.service_date) });
      // The rows pointed at are gone now; their mouse-leave events never come.
      setListHover(null);
      setListDwell(null);
      setMapHover([]);
    });
  };

  /**
   * From the stop chooser back to the list of lines, scrolled as you left it, with the row of
   * the line you picked focused. The map eases back to where it was, unless you've moved it.
   */
  function backToList() {
    if (!selection || busy) return;
    clearMessages();
    setSelection(null);
    const left = listLeft.current;
    listLeft.current = null;
    if (!left) return;
    setReturning(left);
    if (left.view) mapRef.current?.restoreView(left.view);
  }

  // The list is put back once it's on the page again: straight after Back, or once it has been
  // found again. Restoring its scroll doesn't frame a line on the map (see hoverIntent).
  useLayoutEffect(() => {
    if (!returning || selection || !calls || !panel.current) return;
    putListBack(panel.current, returning.spot);
    setReturning(null);
  }, [returning, selection, calls]);

  /**
   * A line picked by name, in the list or on the map: its next trip (or last arrival). Only one
   * that Filter lines lets through.
   */
  function chooseLine(key: string) {
    const group = shownLines.find((l) => l.key === key);
    if (group && !busy) void chooseCall(lineCall(group, listing));
  }

  // The route to (or from) the picked trip's stop, once it's known, and whether it misses the
  // trip; if so, the stop list offers the line's trip it does make.
  const pickedConnector = selection ? connectorFor(selection.call) : null;
  const pickedRoute =
    pickedConnector && connectorDone?.key === pickedConnector.key ? connectorDone.routed : null;
  const missed = selection && frontier && pickedRoute ? missedCall(selection.call) : null;

  function missedCall(call: TransitCall) {
    if (!frontier || !pickedRoute) return null;
    const same = (c: TransitCall) =>
      c.trip_id === call.trip_id &&
      c.service_date === call.service_date &&
      c.stop_sequence === call.stop_sequence;
    const line = lines.find((l) => l.calls.some(same))?.calls ?? [call];
    return missedTrip(frontier, call, line, pickedRoute.route, direction);
  }

  const chooseStop = (stopSequence: number) =>
    run(async () => {
      if (!plan || !selection) return;
      const { call, trip } = selection;
      const at = forward ? planEnd(plan) : planStart(plan);
      // The route found when the trip was picked, or one found now.
      const c = connectorFor(call, at);
      let routed: Routed | null = null;
      if (c) {
        const known = connector.current;
        routed = await (known?.key === c.key
          ? known.routed
          : routeWithFallback(access, c.from, c.to));
        if (routed.fallback) setNotice(routed.fallback);
      }
      const result = forward
        ? boardingLegs(at, trip, call.stop_sequence, stopSequence, routed?.route ?? null)
        : alightingLegs(at, trip, stopSequence, call.stop_sequence, routed?.route ?? null);
      if (!result.ok) setError(result.reason);
      else {
        const next = forward ? appendLegs(plan, result.legs) : prependLegs(plan, result.legs);
        commitAdd(next, result.legs);
      }
    });

  /** Rename a place everywhere it appears in the plan, as one step for Undo. */
  function rename(place: Place, name: string) {
    if (!committed) return;
    clearMessages();
    commit(renamePlace(committed, place, name), 'rename');
  }

  /** Commit an edit to a leg, or say under the leg why it was refused and return that. */
  function applyEdit(result: EditResult, label: UndoLabel, legId: string): string | null {
    clearMessages();
    if (!result.ok) {
      refuseLeg(legId, result.reason);
      return result.reason;
    }
    commit(result.plan, label);
    return null;
  }

  /**
   * Re-route a walk or bike leg the other way: walk <-> bike, keeping its place in the plan.
   * Under the leg it says why it can't, or what else moved, or that the route is estimated.
   */
  const switchMode = (legId: string) =>
    run(
      async () => {
        const leg = plan?.legs.find((l) => l.id === legId);
        if (!plan || !leg || (leg.mode !== 'walk' && leg.mode !== 'bike')) return;
        const other = leg.mode === 'walk' ? 'bike' : 'walk';
        const { route, fallback } = await routeWithFallback(other, leg.start.place, leg.end.place);
        const label = other === 'bike' ? 'switch to bike' : 'switch to walk';
        const result = setLegPath(plan, legId, other, pathInfo(route));
        if (!result.ok) {
          refuseLeg(legId, result.reason);
          return;
        }
        commit(result.plan, label);
        const said = [fallback, switchMoved(plan, result.plan, legId)].filter(Boolean).join(' ');
        if (said) setLegMessage({ legId, text: said, tone: 'warning' });
      },
      (reason) => refuseLeg(legId, reason),
    );

  function openSummary() {
    resetBuilder(); // So the map picture shows just the plan (the line previews hide too).
    setShowSummary(true);
  }

  async function openPlanFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // So choosing the same file again still triggers a change.
    if (!file) return;
    const parsed = parsePlanJson(await file.text());
    clearMessages();
    if (!parsed.ok) {
      setAlert({ text: parsed.reason, tone: 'error' });
      return;
    }
    // The history of the plan you had is dropped, but Undo can still bring that plan back.
    setHistory(plan ? [{ label: 'open plan', plan }] : []);
    setCommitted(parsed.plan.legs.length ? parsed.plan : null);
    setAnchorPlace(parsed.plan.anchor.place);
    setTimeInput(toLocalInput(parsed.plan.anchor.time));
    setMovingAnchor(false);
    resetBuilder();
    setAdded(null);
    setLineFilter('');
    setLongWindow(false);
    setAlert({ text: `Opened ${file.name}.`, tone: 'notice' });
  }

  return (
    <>
      <div className="app">
        <aside
          className="panel"
          ref={panel}
          onKeyDown={(e) => e.key === 'Tab' && keepFocusInView(e.currentTarget)}
        >
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
          {alert && (
            <p
              className={alert.tone === 'error' ? 'error' : 'warning'}
              role={alert.tone === 'error' ? 'alert' : 'status'}
            >
              {alert.text}
            </p>
          )}

          <StartSection
            anchor={anchorPlace}
            timeInput={timeInput}
            locked={!!committed}
            anchorTime={committed?.anchor.time}
            plannedFrom={!!committed && !startsAtAnchor(committed)}
            moving={movingAnchor}
            onName={(name) => setAnchorPlace((p) => (p ? withName(p, name) : p))}
            onRename={(name) => committed && rename(committed.anchor.place, name)}
            busy={busy}
            onTime={(value) => {
              setTimeInput(value);
              clearMessages();
              resetBuilder();
            }}
            onMove={() => setMovingAnchor(true)}
            onCancelMove={() => setMovingAnchor(false)}
          />

          {committed && (
            <Itinerary
              plan={committed}
              issues={issues}
              direction={direction}
              onSetDuration={(legId, s) =>
                applyEdit(setLegDuration(committed, legId, s), 'time change', legId)
              }
              onSetStart={(legId, time) =>
                applyEdit(setLegStart(committed, legId, time), 'time change', legId)
              }
              onSetEnd={(legId, time) =>
                applyEdit(setLegEnd(committed, legId, time), 'time change', legId)
              }
              onSwitchMode={switchMode}
              onMerge={(legId, nextId) =>
                applyEdit(mergeWithNext(committed, legId, nextId), 'merge', legId)
              }
              onRename={rename}
              onRemove={(legId) => {
                clearMessages();
                commit(removeFrom(committed, legId, direction), 'remove');
              }}
              onSummary={openSummary}
              message={legMessage}
              disabled={busy}
            />
          )}

          {plan && frontier && scope && (
            <NextLeg
              direction={direction}
              mode={mode}
              frontier={frontier}
              busy={busy}
              onDirection={(d) => {
                setDirection(d);
                clearMessages();
                resetBuilder();
              }}
              onMode={chooseMode}
              added={added}
              error={error}
              notice={notice}
              laterNotice={pickedRoute?.fallback ?? null}
              radiusM={radiusM}
              onRadius={setRadiusM}
              access={access}
              onAccess={setAccess}
              lines={calls && lines}
              shownLines={shownLines}
              scope={scope}
              cut={transit.cut}
              lineFilter={lineFilter}
              onLineFilter={setLineFilter}
              onLongWindow={setLongWindow}
              searching={transit.searching}
              searchError={transit.error}
              onRetrySearch={transit.retry}
              noteFor={(call) => transferNote(call, ride, direction)}
              selection={selection}
              missed={missed}
              onChooseCall={chooseCall}
              onChooseLine={chooseLine}
              onHoverLine={setListHover}
              onDwellLine={setListDwell}
              highlightLines={mapHover}
              onChooseStop={chooseStop}
              onBackToCalls={backToList}
              pending={pending}
              onPendingName={(name) =>
                setPending((p) => (p ? { ...p, place: withName(p.place, name) } : p))
              }
              onAddPending={addPending}
              onCancelPending={cancelPending}
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
          focusLine={shown(listHover)}
          frameLine={shown(listDwell)}
          tripPreview={tripPreview}
          pendingPoint={pending?.place ?? null}
          pendingRoute={pending?.route.geometry ?? null}
          picking={onEmptyClick !== 'menu'}
          startDraggable={!committed && !busy}
          onMoveStart={moveAnchor}
          legs={committed?.legs ?? NO_LEGS}
          onPick={pickOnMap}
          onHoverLines={setMapHover}
          onChooseLine={chooseLine}
          onChooseStop={(sequence) => !busy && void chooseStop(sequence)}
          menu={mapMenu}
          onMenu={(id, point) => {
            if (id === 'move') moveAnchor(point);
            else if (!busy && (id === 'walk' || id === 'bike')) void addPathAt(id, point);
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
