import type { PathMode, RouteResult, TransitCall, TripDetail } from '../api';
import { pathDurationS, pathInfo } from '../plan/build';
import { hillNotes, hillProfile } from '../plan/hills';
import { addSeconds } from '../plan/plan';
import type { TransferNote } from '../plan/transfers';
import type { Direction, LegMode, Place, Waypoint } from '../plan/types';
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

interface Props {
  direction: Direction;
  mode: LegMode;
  /** End of the plan when going forwards, its start when going backwards. */
  frontier: Waypoint;
  busy: boolean;
  onDirection: (direction: Direction) => void;
  onMode: (mode: LegMode) => void;

  radiusM: number;
  onRadius: (metres: number) => void;
  /** How you get between the frontier and the stop: walking or cycling. */
  access: PathMode;
  onAccess: (access: PathMode) => void;
  /** The departures (or arrivals) near the frontier: null until found. */
  calls: TransitCall[] | null;
  searching: boolean;
  searchError: string | null;
  onRetrySearch: () => void;
  noteFor: (call: TransitCall) => TransferNote | null;
  selection: TripSelection | null;
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
  onAddWait: () => void;
}

const MODES: { mode: LegMode; label: string }[] = [
  { mode: 'transit', label: 'Transit' },
  { mode: 'walk', label: 'Walk' },
  { mode: 'bike', label: 'Bike' },
  { mode: 'wait', label: 'Wait' },
];

/** Builds the next leg at either end of the plan. */
export function NextLeg(props: Props) {
  const { direction, mode, frontier } = props;
  const forward = direction === 'forward';
  const where = frontier.place.name || 'the start point';
  return (
    <section className="next-leg">
      <h2>Next leg</h2>
      <div className="toggle" role="group" aria-label="Which end of the plan to extend">
        <button type="button" aria-pressed={forward} onClick={() => props.onDirection('forward')}>
          After the end
        </button>
        <button type="button" aria-pressed={!forward} onClick={() => props.onDirection('backward')}>
          Before the start
        </button>
      </div>
      <p className="muted">
        {forward
          ? `Continuing from ${where} at ${formatTime(frontier.time)}.`
          : `Arriving at ${where} by ${formatTime(frontier.time)}.`}{' '}
        Right-click the map to walk or bike {forward ? 'there' : 'from there'}.
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
      {mode === 'transit' && <TransitPanel {...props} />}
      {(mode === 'walk' || mode === 'bike') && <PathPanel {...props} />}
      {mode === 'wait' && <WaitPanel {...props} />}
    </section>
  );
}

function TransitPanel(p: Props) {
  const forward = p.direction === 'forward';
  if (p.selection) {
    return (
      <TripStops
        trip={p.selection.trip}
        call={p.selection.call}
        direction={p.direction}
        onChoose={p.onChooseStop}
        onBack={p.onBackToCalls}
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
      {(p.calls || p.searching || p.searchError) && (
        <h3>{forward ? 'Departures you can reach' : 'Arrivals that get you there'}</h3>
      )}
      {p.calls ? (
        <CallList
          calls={p.calls}
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

function PathPanel(p: Props) {
  const forward = p.direction === 'forward';
  const verb = p.mode === 'walk' ? 'walking' : 'cycling';
  if (!p.pending) {
    return (
      <p className="hint">
        Click the map where you’re {verb} {forward ? 'to' : 'from'}.
      </p>
    );
  }
  const { route, place } = p.pending;
  const seconds = pathDurationS(route);
  const hills = p.mode === 'bike' ? hillProfile(pathInfo(route)) : null;
  const other = addSeconds(p.frontier.time, forward ? seconds : -seconds);
  return (
    <div className="pending">
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
      <div className="row">
        <button type="button" disabled={p.busy} onClick={p.onAddPending}>
          Add {p.mode} leg
        </button>
        <button type="button" className="secondary" onClick={p.onCancelPending}>
          Cancel
        </button>
      </div>
      <p className="muted">Click elsewhere on the map to change the point.</p>
    </div>
  );
}

function WaitPanel(p: Props) {
  const forward = p.direction === 'forward';
  return (
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
      <button type="button" disabled={p.busy || !(p.waitMinutes > 0)} onClick={p.onAddWait}>
        {forward ? 'Add wait at the end' : 'Add wait at the start'}
      </button>
    </div>
  );
}
