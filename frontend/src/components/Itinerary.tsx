import { Fragment, type KeyboardEvent, useState } from 'react';
import { legNotes, legTitle, placeName } from '../plan/files';
import { hillProfile } from '../plan/hills';
import {
  type LegBounds,
  canMergeWithNext,
  departureWindow,
  durationAnchor,
  isEndLeg,
  legBounds,
  legDurationS,
  maxDurationS,
  planEnd,
  planPlaces,
  planStart,
} from '../plan/plan';
import type { Leg, Place, Plan, PlanIssue } from '../plan/types';
import { atLocalTime, formatClock, formatDuration, formatTime, formatTimeOnDay } from '../time';
import { HillProfile } from './HillProfile';
import { NoBikesBadge, RouteBadge } from './RouteBadge';

/** Each edit returns an error message if it was refused. */
export interface LegEdits {
  onSetDuration: (legId: string, seconds: number) => string | null;
  onSetStart: (legId: string, time: string) => string | null;
  onSetEnd: (legId: string, time: string) => string | null;
}

interface Props extends LegEdits {
  plan: Plan;
  issues: PlanIssue[];
  onSwitchMode: (legId: string) => void;
  /** Merge a walk, bike or wait leg with the same kind of leg right after it, `nextId`. */
  onMerge: (legId: string, nextId: string) => void;
  onRename: (place: Place, name: string) => void;
  onRemove: (legId: string) => void;
  onUndo: () => void;
  canUndo: boolean;
  onClear: () => void;
  onSummary: () => void;
  /** While a request is in flight, edits wait so they can't race it. */
  disabled?: boolean;
}

export function Itinerary(props: Props) {
  const { plan, issues } = props;
  const start = planStart(plan);
  const end = planEnd(plan);
  return (
    <section>
      <h2>Itinerary</h2>
      <ol className="itinerary">
        {plan.legs.map((leg, i) => (
          <Fragment key={leg.id}>
            <li className={`leg leg-${leg.mode}`}>
              <span className="leg-times">
                {formatTimeOnDay(leg.start.time, start.time)}
                <br />
                {formatTimeOnDay(leg.end.time, start.time)}
              </span>
              <div className="leg-body">
                <LegSummary leg={leg} />
                {editable(leg) && (
                  <LegTimesEditor
                    key={`${leg.id}:${leg.mode}:${leg.start.time}:${leg.end.time}`}
                    plan={plan}
                    leg={leg}
                    edits={props}
                    disabled={props.disabled}
                  />
                )}
                {issues
                  .filter((i) => i.legId === leg.id && i.kind !== 'bikes-not-allowed')
                  .map((i) => (
                    <p key={i.kind} className={`issue issue-${i.severity}`}>
                      {i.message}
                    </p>
                  ))}
              </div>
              <div className="leg-actions">
                {(leg.mode === 'walk' || leg.mode === 'bike') && (
                  <button
                    type="button"
                    className="link"
                    disabled={props.disabled}
                    onClick={() => props.onSwitchMode(leg.id)}
                  >
                    {leg.mode === 'walk' ? 'Switch to bike' : 'Switch to walk'}
                  </button>
                )}
                {!leg.auto && isEndLeg(plan, leg.id) && (
                  <button
                    type="button"
                    className="link remove"
                    disabled={props.disabled}
                    aria-label={`Remove: ${legTitle(leg)}`}
                    onClick={() => props.onRemove(leg.id)}
                  >
                    Remove
                  </button>
                )}
              </div>
            </li>
            {canMergeWithNext(plan, leg.id) && (
              <MergeButton
                // Keyed by the pair: after a merge, the button for the next pair is a new one,
                // so a held Enter key can't carry on into it.
                key={`${leg.id}>${plan.legs[i + 1].id}`}
                first={leg}
                second={plan.legs[i + 1]}
                disabled={props.disabled}
                onMerge={props.onMerge}
              />
            )}
          </Fragment>
        ))}
      </ol>
      <p className="muted">
        Total {formatDuration((Date.parse(end.time) - Date.parse(start.time)) / 1000)}, from{' '}
        {formatTimeOnDay(start.time, start.time)} to {formatTimeOnDay(end.time, start.time)}
      </p>
      <details className="places">
        <summary>Rename places</summary>
        {planPlaces(plan).map((place) => (
          <PlaceName
            key={`${place.lat},${place.lon},${place.stopId ?? ''}:${place.name ?? ''}`}
            place={place}
            disabled={props.disabled}
            onRename={(name) => props.onRename(place, name)}
          />
        ))}
      </details>
      <div className="row wrap">
        <button type="button" onClick={props.onSummary}>
          Summary &amp; export
        </button>
        <button
          type="button"
          className="secondary"
          disabled={props.disabled || !props.canUndo}
          onClick={props.onUndo}
        >
          Undo
        </button>
        <button type="button" className="secondary" disabled={props.disabled} onClick={props.onClear}>
          Clear plan
        </button>
      </div>
    </section>
  );
}

/** Between two walks, two bike rides or two waits: merges them into one. */
function MergeButton(props: {
  first: Leg;
  second: Leg;
  disabled?: boolean;
  onMerge: (legId: string, nextId: string) => void;
}) {
  const { first, second } = props;
  const into = `into one ${MERGED_NAMES[first.mode]}`;
  return (
    <li className={`leg-merge leg-merge-${first.mode}`}>
      <button
        type="button"
        className="link"
        disabled={props.disabled}
        aria-label={`Merge ${legTitle(first)} and ${legTitle(second)} ${into}`}
        onClick={(e) => {
          // The second click of a double-click would merge the next pair too.
          if (e.detail > 1) return;
          props.onMerge(first.id, second.id);
        }}
      >
        Merge {into}
      </button>
    </li>
  );
}

// What two merged legs become: "Merge into one bike ride".
const MERGED_NAMES: Record<Leg['mode'], string> = {
  walk: 'walk',
  bike: 'bike ride',
  wait: 'wait',
  transit: 'ride',
};

const editable = (leg: Leg) =>
  leg.mode === 'walk' || leg.mode === 'bike' || (leg.mode === 'wait' && !leg.auto);

function LegSummary({ leg }: { leg: Leg }) {
  const duration = formatDuration(legDurationS(leg));
  if (leg.transit) {
    const t = leg.transit;
    return (
      <p>
        <RouteBadge name={t.routeName} color={t.color} textColor={t.textColor} /> {t.headsign}{' '}
        {t.bikesAllowed === false && <NoBikesBadge />}
        <br />
        <span className="muted">
          {t.agency ? `${t.agency} · ` : ''}
          {leg.start.place.name} → {leg.end.place.name} · {legNotes(leg)[0]} · {duration}
        </span>
      </p>
    );
  }
  if (leg.mode === 'wait') {
    return (
      <p>
        Wait {duration}
        <span className="muted"> at {leg.start.place.name ?? 'start'}</span>
      </p>
    );
  }
  const notes = legNotes(leg).filter((n) => !n.startsWith('edited'));
  const hills = leg.mode === 'bike' && leg.path ? hillProfile(leg.path) : null;
  return (
    <>
      <p>
        {legTitle(leg)}
        <span className="muted"> · {notes.join(' · ')}</span>
      </p>
      {hills && <HillProfile profile={hills} />}
    </>
  );
}

interface EditorProps {
  plan: Plan;
  leg: Leg;
  edits: LegEdits;
  disabled?: boolean;
}

/**
 * Departure, arrival and duration of a walk, bike or manual wait leg. An end that meets a ride
 * is fixed; moving a free end shifts the leg, or stretches it if the other end is fixed.
 */
function LegTimesEditor({ plan, leg, edits, disabled }: EditorProps) {
  const bounds = legBounds(plan, leg.id);
  const maxS = maxDurationS(plan, leg.id);
  const minutes = Math.round(legDurationS(leg) / 60);
  const [start, setStart] = useState(formatClock(leg.start.time));
  const [end, setEnd] = useState(formatClock(leg.end.time));
  const [duration, setDuration] = useState(String(minutes));
  const [error, setError] = useState<string | null>(null);
  const isWait = leg.mode === 'wait';

  function commit(refusal: string | null) {
    setError(refusal);
    if (refusal) {
      setStart(formatClock(leg.start.time));
      setEnd(formatClock(leg.end.time));
      setDuration(String(minutes));
    }
  }
  const commitStart = () =>
    start && start !== formatClock(leg.start.time) &&
    commit(edits.onSetStart(leg.id, atLocalTime(leg.start.time, start)));
  const commitEnd = () =>
    end && end !== formatClock(leg.end.time) &&
    commit(edits.onSetEnd(leg.id, atLocalTime(leg.end.time, end)));
  const commitDuration = () =>
    duration !== '' && Number(duration) !== minutes &&
    commit(edits.onSetDuration(leg.id, Number(duration) * 60));
  const onEnter = (save: () => unknown) => (e: KeyboardEvent) => e.key === 'Enter' && save();

  return (
    <div className="times-editor">
      <div className="row wrap align-end">
        <label className="field">
          {isWait ? 'From' : 'Leave'}
          <input
            type="time"
            value={start}
            disabled={disabled || !bounds.startFree}
            title={bounds.startFree ? undefined : 'Fixed: it leaves as the ride before it arrives'}
            onChange={(e) => setStart(e.target.value)}
            onBlur={commitStart}
            onKeyDown={onEnter(commitStart)}
          />
        </label>
        <label className="field">
          {isWait ? 'Until' : 'Arrive'}
          <input
            type="time"
            value={end}
            disabled={disabled || !bounds.endFree}
            title={bounds.endFree ? undefined : 'Fixed: it arrives as the ride after it leaves'}
            onChange={(e) => setEnd(e.target.value)}
            onBlur={commitEnd}
            onKeyDown={onEnter(commitEnd)}
          />
        </label>
        <label className="field">
          Minutes
          <input
            type="number"
            min={0}
            max={maxS === null ? undefined : Math.floor(maxS / 60)}
            value={duration}
            disabled={disabled}
            onChange={(e) => setDuration(e.target.value)}
            onBlur={commitDuration}
            onKeyDown={onEnter(commitDuration)}
            aria-label="Duration in minutes"
          />
        </label>
      </div>
      <p className="muted">{hint(plan, leg, bounds, maxS)}</p>
      {error && <p className="issue issue-error">{error}</p>}
    </div>
  );
}

/** What can move, in a few words: "can leave until 8:35 · up to 22 min, keeping departure". */
function hint(plan: Plan, leg: Leg, bounds: LegBounds, maxS: number | null): string {
  const parts: string[] = [];
  const { earliest, latest } = departureWindow(plan, leg.id);
  if (earliest && latest) parts.push(`can leave ${formatTime(earliest)}–${formatTime(latest)}`);
  else if (latest) parts.push(`can leave until ${formatTime(latest)}`);
  else if (earliest) parts.push(`can leave from ${formatTime(earliest)}`);
  if (!bounds.startFree) parts.push('leaves as the ride arrives');
  if (!bounds.endFree) parts.push('arrives as the ride leaves');
  const keeps = durationAnchor(plan, leg.id) === 'start' ? 'departure' : 'arrival';
  parts.push(`${maxS === null ? '' : `up to ${Math.floor(maxS / 60)} min, `}keeping ${keeps}`);
  return parts.join(' · ');
}

/** One place's name, renamed everywhere it appears when you finish editing. */
function PlaceName({
  place,
  disabled,
  onRename,
}: {
  place: Place;
  disabled?: boolean;
  onRename: (name: string) => void;
}) {
  const [draft, setDraft] = useState(place.name ?? '');
  const save = () => draft.trim() !== (place.name ?? '') && onRename(draft.trim());
  return (
    <label className="field">
      <span className="muted">{place.stopId ? 'Stop' : 'Place'}</span>
      <input
        value={draft}
        placeholder={placeName({ ...place, name: undefined })}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === 'Enter' && save()}
      />
    </label>
  );
}
