import { type RefObject, useEffect, useRef } from 'react';
import type { PathMode, RouteResult, TransitCall, TripDetail } from '../api';
import type { CallGroup } from '../callGroups';
import { isFiltering } from '../lineFilter';
import { type MissedTrip, pathDurationS, pathInfo } from '../plan/build';
import { hillNotes, hillProfile } from '../plan/hills';
import { addSeconds } from '../plan/plan';
import type { TransferNote } from '../plan/transfers';
import type { Direction, LegMode, Place, Waypoint } from '../plan/types';
import { bringIntoView } from '../scroll';
import {
  CALL_LIMIT,
  LONG_WINDOW_MIN,
  type SearchScope,
  WINDOW_MIN,
  cutText,
  formatDistance,
  nothingText,
  offersLongWindow,
  scopeText,
  widerRadius,
} from '../searchScope';
import { formatDuration, formatTime } from '../time';
import { CallList } from './CallList';
import { HillProfile } from './HillProfile';
import { TripStops } from './TripStops';

/** A walk or bike leg being set up: the picked point and its route, not yet added. */
export interface PendingPath {
  mode: PathMode;
  place: Place;
  route: RouteResult;
}

export interface TripSelection {
  call: TransitCall;
  trip: TripDetail;
}

/** What the last add under Next leg put in the plan (see addedText); each add has a new id. */
export interface AddedLegs {
  id: number;
  text: string;
}

interface Props {
  direction: Direction;
  mode: LegMode;
  /** End of the plan when going forwards, its start when going backwards. */
  frontier: Waypoint;
  busy: boolean;
  onDirection: (direction: Direction) => void;
  /** Between Walk and Bike, a point already picked is routed again the other way. */
  onMode: (mode: LegMode) => void;
  /** Said under the heading until the plan next changes. */
  added: AddedLegs | null;
  /** About what you're doing here: why it was refused, or that a route is only estimated. */
  error: string | null;
  notice: string | null;
  /**
   * A notice that comes by itself a while after you picked a trip (the route to its stop is only
   * estimated). It shows as the others do, but nothing scrolls to it: you may be reading the
   * stops by then.
   */
  laterNotice: string | null;

  radiusM: number;
  onRadius: (metres: number) => void;
  /** How you get between the frontier and the stop: walking or cycling. */
  access: PathMode;
  onAccess: (access: PathMode) => void;
  /** The lines near the frontier (see groupCalls): null until found. */
  lines: CallGroup[] | null;
  /** Those of them that the line filter lets through. */
  shownLines: CallGroup[];
  /** What the list searched for, or is searching for. */
  scope: SearchScope;
  /** Whether the search stopped at CALL_LIMIT trips, so some lines may be missing. */
  cut: boolean;
  lineFilter: string;
  onLineFilter: (text: string) => void;
  /** Look further ahead (or back) than the hour, or no longer. */
  onLongWindow: (long: boolean) => void;
  searching: boolean;
  searchError: string | null;
  onRetrySearch: () => void;
  noteFor: (call: TransitCall) => TransferNote | null;
  selection: TripSelection | null;
  /** Set once the walk or bike ride to (or from) the picked trip's stop is routed and misses it. */
  missed: MissedTrip | null;
  onChooseCall: (call: TransitCall) => void;
  /** A line was picked by name (in the list or on the map). */
  onChooseLine: (key: string) => void;
  onHoverLine: (key: string | null) => void;
  /** A line in the list is of interest (see CallList), or none is. */
  onDwellLine: (key: string | null) => void;
  /** The lines pointed at on the map. */
  highlightLines: string[];
  onChooseStop: (stopSequence: number) => void;
  onBackToCalls: () => void;

  pending: PendingPath | null;
  onPendingName: (name: string) => void;
  onAddPending: () => void;
  onCancelPending: () => void;

  waitMinutes: number;
  onWaitMinutes: (minutes: number) => void;
  onAddWait: (minutes: number) => void;
}

// One click adds a wait this long; the Minutes field takes any other.
const WAIT_CHIPS_MIN = [5, 10, 15, 30];

const MODES: { mode: LegMode; label: string }[] = [
  { mode: 'transit', label: 'Transit' },
  { mode: 'walk', label: 'Walk' },
  { mode: 'bike', label: 'Bike' },
  { mode: 'wait', label: 'Wait' },
];

/** Builds the next leg at either end of the plan. */
export function NextLeg(props: Props) {
  const { direction, mode, frontier, added, error, notice } = props;
  const said = notice ?? props.laterNotice;
  const forward = direction === 'forward';
  const where = frontier.place.name || 'the start point';
  // In Walk and Bike mode a click on the map picks where to go instead (see PathPanel).
  const clickMenu = mode === 'transit' || mode === 'wait';
  const controls = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const messages = useRef<HTMLDivElement>(null);
  // A refusal or notice shows above the list you were using, and comes into view.
  useEffect(() => bringIntoView(messages.current), [error, notice]);
  // After an add, the controls for the next leg come into view: the panel scrolls no further
  // than it takes, so a short itinerary stays in sight. The button you used is gone (a stop,
  // Add walk leg), so keyboard focus comes here rather than to the top of the page. Only after
  // an add: a rename since then changes the names in what was added, and nothing else.
  const addedId = added?.id;
  useEffect(() => {
    if (addedId === undefined) return;
    bringIntoView(controls.current);
    if (document.activeElement === document.body) heading.current?.focus({ preventScroll: true });
  }, [addedId]);
  return (
    <section className="next-leg">
      <div className="next-leg-controls" ref={controls}>
        <h2 ref={heading} tabIndex={-1}>
          Next leg
        </h2>
        {added && (
          <p className="added" role="status">
            Added: {added.text}
          </p>
        )}
        <div className="toggle" role="group" aria-label="Which end of the plan to extend">
          <button type="button" aria-pressed={forward} onClick={() => props.onDirection('forward')}>
            After the end
          </button>
          <button
            type="button"
            aria-pressed={!forward}
            onClick={() => props.onDirection('backward')}
          >
            Before the start
          </button>
        </div>
        <p className="muted">
          {forward
            ? `Continuing from ${where} at ${formatTime(frontier.time)}.`
            : `Arriving at ${where} by ${formatTime(frontier.time)}.`}
          {clickMenu && ` Click the map to walk or bike ${forward ? 'there' : 'from there'}.`}
        </p>
        <div className="toggle" role="group" aria-label="Mode">
          {MODES.map((m) => (
            <button
              key={m.mode}
              type="button"
              aria-pressed={mode === m.mode}
              onClick={() => props.onMode(m.mode)}
            >
              {m.label}
            </button>
          ))}
        </div>
        {(error || said) && (
          <div className="builder-messages" ref={messages}>
            {said && (
              <p className="warning" role="status">
                {said}
              </p>
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
          </div>
        )}
      </div>
      {mode === 'transit' && <TransitPanel {...props} />}
      {(mode === 'walk' || mode === 'bike') && <PathPanel {...props} />}
      {mode === 'wait' && <WaitPanel {...props} />}
    </section>
  );
}

function TransitPanel(p: Props) {
  const forward = p.direction === 'forward';
  const listHeading = useRef<HTMLHeadingElement>(null);
  if (p.selection) {
    return (
      <TripStops
        trip={p.selection.trip}
        call={p.selection.call}
        direction={p.direction}
        onChoose={p.onChooseStop}
        onBack={p.onBackToCalls}
        missed={p.missed}
        onTakeInstead={p.onChooseCall}
        noteFor={p.noteFor}
        disabled={p.busy}
      />
    );
  }
  const what = forward ? 'departures' : 'arrivals';
  return (
    <>
      <div className="row align-end">
        <div className="field grow">
          {forward ? 'Get to the stop by' : 'Leave the stop by'}
          <div className="toggle" role="group" aria-label="Getting to or from the stop">
            {(['walk', 'bike'] as const).map((a) => (
              <button
                key={a}
                type="button"
                aria-pressed={p.access === a}
                onClick={() => p.onAccess(a)}
              >
                {a === 'walk' ? 'Walking' : 'Bike'}
              </button>
            ))}
          </div>
        </div>
        <label className="field radius">
          Search radius (m)
          <input
            type="number"
            min={50}
            max={3000}
            step={50}
            value={p.radiusM}
            onChange={(e) => p.onRadius(Number(e.target.value))}
          />
        </label>
      </div>
      {(p.lines || p.searching || p.searchError) && (
        <h3 ref={listHeading} tabIndex={-1}>
          {forward ? 'Departures you can reach' : 'Arrivals that get you there'}
        </h3>
      )}
      {(p.searching || !!p.lines?.length) && (
        <>
          <p className="muted">
            {scopeText(p.scope)}
            {p.lines && <WindowLink {...p} heading={listHeading} />}
          </p>
          {p.lines && p.cut && <p className="warning">{cutText(p.scope, CALL_LIMIT)}</p>}
          <LineFilter {...p} />
        </>
      )}
      {p.lines ? (
        p.lines.length === 0 ? (
          <NothingFound {...p} heading={listHeading} />
        ) : p.shownLines.length === 0 ? (
          <p className="muted">No lines here match “{p.lineFilter.trim()}”.</p>
        ) : (
          <CallList
            lines={p.shownLines}
            direction={what}
            access={p.access}
            noteFor={p.noteFor}
            onSelect={p.onChooseCall}
            onChooseLine={p.onChooseLine}
            onHoverLine={p.onHoverLine}
            onDwellLine={p.onDwellLine}
            highlight={p.highlightLines}
            disabled={p.busy}
          />
        )
      ) : p.searchError ? (
        <div className="row align-end">
          <p className="error grow" role="alert">
            Couldn't find {what}: {p.searchError}
          </p>
          <button type="button" className="secondary" onClick={p.onRetrySearch}>
            Try again
          </button>
        </div>
      ) : (
        p.searching && (
          <p className="muted" role="status">
            Finding {what}…
          </p>
        )
      )}
    </>
  );
}

/**
 * "Filter lines" narrows the list, and the lines on the map, to those matching what you type
 * (see filterLines). While it's on, the count of lines it lets through says so.
 */
function LineFilter(p: Props) {
  const input = useRef<HTMLInputElement>(null);
  const filtering = isFiltering(p.lineFilter);
  return (
    <div className="row wrap align-center line-filter">
      <input
        ref={input}
        type="search"
        aria-label="Filter lines"
        placeholder="Filter lines (e.g. BART, Caltrain, 22)"
        value={p.lineFilter}
        onChange={(e) => p.onLineFilter(e.target.value)}
        onKeyDown={(e) => {
          // Escape clears the filter, unless it has just closed a menu on the map (see MapView).
          if (e.key === 'Escape' && !e.defaultPrevented && p.lineFilter) {
            e.preventDefault();
            p.onLineFilter('');
          }
        }}
      />
      {filtering && (
        <span className="muted">
          {p.lines && (
            <span role="status">
              {p.shownLines.length} of {p.lines.length} lines
            </span>
          )}
          {p.lines && ' · '}
          <button
            type="button"
            className="link"
            onClick={() => {
              p.onLineFilter('');
              input.current?.focus(); // The button is gone.
            }}
          >
            Clear
          </button>
        </span>
      )}
    </div>
  );
}

interface Widen {
  /** The list's heading, which keeps keyboard focus when the button you used goes. */
  heading: RefObject<HTMLHeadingElement | null>;
}

/** Under a list: Look 3 hours ahead (or back), or, once it does, just the hour. */
function WindowLink(p: Props & Widen) {
  const forward = p.direction === 'forward';
  const long = p.scope.windowMin > WINDOW_MIN;
  if (!long && !offersLongWindow(p.scope, true)) return null;
  return (
    <>
      {' '}
      <button
        type="button"
        className="link"
        onClick={() => {
          p.onLongWindow(!long);
          p.heading.current?.focus({ preventScroll: true });
        }}
      >
        {long
          ? `Just the ${forward ? 'next hour' : 'hour before'}`
          : `Look ${LONG_WINDOW_MIN / 60} hours ${forward ? 'ahead' : 'back'}`}
      </button>
    </>
  );
}

/** An empty list says what it searched, and offers to search wider, longer or by map. */
function NothingFound(p: Props & Widen) {
  const forward = p.direction === 'forward';
  const wider = widerRadius(p.scope.radiusM);
  const longer = offersLongWindow(p.scope, false);
  const widen = (change: () => void) => () => {
    change();
    p.heading.current?.focus({ preventScroll: true }); // The button is gone while it searches.
  };
  return (
    <div className="nothing-found">
      <p role="status">{nothingText(p.scope)}</p>
      {(wider || longer) && (
        <div className="row wrap">
          {wider && (
            <button type="button" className="secondary" onClick={widen(() => p.onRadius(wider))}>
              Search within {formatDistance(wider)}
            </button>
          )}
          {longer && (
            <button type="button" className="secondary" onClick={widen(() => p.onLongWindow(true))}>
              Look {LONG_WINDOW_MIN / 60} hours {forward ? 'ahead' : 'back'}
            </button>
          )}
        </div>
      )}
      <p className="hint">
        Or click the map to walk or bike {forward ? 'towards a stop' : 'from a stop'}.
      </p>
    </div>
  );
}

function PathPanel(p: Props) {
  const forward = p.direction === 'forward';
  const verb = p.mode === 'walk' ? 'walking' : 'cycling';
  const card = useRef<HTMLFormElement>(null);
  // A new point (or the same one routed the other way) brings its card into view.
  const routed = p.pending?.route;
  useEffect(() => bringIntoView(card.current), [routed]);
  if (!p.pending) {
    return (
      <p className="hint">
        Click the map where you’re {verb} {forward ? 'to' : 'from'}.
      </p>
    );
  }
  const { mode, place, route } = p.pending;
  const seconds = pathDurationS(route);
  const hills = mode === 'bike' ? hillProfile(pathInfo(route)) : null;
  const other = addSeconds(p.frontier.time, forward ? seconds : -seconds);
  const otherMode = p.mode === 'walk' ? 'bike' : 'walk';
  return (
    <form
      className="pending"
      ref={card}
      onSubmit={(e) => {
        e.preventDefault();
        p.onAddPending();
      }}
    >
      <label className="field">
        {forward ? 'To' : 'From'}
        <input value={place.name ?? ''} onChange={(e) => p.onPendingName(e.target.value)} />
      </label>
      <p>
        {(route.distance_m / 1000).toFixed(1)} km · {formatDuration(seconds)}
        {route.provider === 'estimate' && ' (estimated)'} ·{' '}
        {forward ? `arrive ${formatTime(other)}` : `leave ${formatTime(other)}`}
      </p>
      {hills && (
        <div className="hills">
          <HillProfile profile={hills} />
          <span className="muted">{hillNotes(hills).join(' · ')}</span>
        </div>
      )}
      {mode !== p.mode && (
        <p className="muted" role="status">
          Finding a {verb} route…
        </p>
      )}
      <div className="row align-center">
        <button type="submit" disabled={p.busy || mode !== p.mode}>
          Add {mode} leg
        </button>
        <button type="button" className="secondary" onClick={p.onCancelPending}>
          Cancel
        </button>
        <button
          type="button"
          className="link"
          disabled={p.busy}
          onClick={() => p.onMode(otherMode)}
        >
          {otherMode === 'bike' ? 'Bike instead' : 'Walk instead'}
        </button>
      </div>
      <p className="muted">Click elsewhere on the map to change the point.</p>
    </form>
  );
}

function WaitPanel(p: Props) {
  const forward = p.direction === 'forward';
  const where = forward ? 'at the end' : 'at the start';
  return (
    <form
      className="wait-panel"
      onSubmit={(e) => {
        e.preventDefault();
        if (!p.busy && p.waitMinutes > 0) p.onAddWait(p.waitMinutes);
      }}
    >
      <div className="row wrap align-center" role="group" aria-label={`Add a wait ${where}`}>
        <span className="muted">Wait</span>
        {WAIT_CHIPS_MIN.map((minutes) => (
          <button
            key={minutes}
            type="button"
            className="secondary chip"
            disabled={p.busy}
            onClick={() => p.onAddWait(minutes)}
          >
            {minutes} min
          </button>
        ))}
      </div>
      <div className="row align-end">
        <label className="field">
          Minutes
          <input
            type="number"
            min={1}
            step={1}
            value={p.waitMinutes}
            onChange={(e) => p.onWaitMinutes(Number(e.target.value))}
          />
        </label>
        <button type="submit" disabled={p.busy || !(p.waitMinutes > 0)}>
          {forward ? 'Add wait at the end' : 'Add wait at the start'}
        </button>
      </div>
    </form>
  );
}
