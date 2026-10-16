import { Fragment, type KeyboardEvent, useId, useState } from 'react';
import { MODE_NAMES, legNotes, legTitle, placeName } from '../plan/files';
import { hillProfile } from '../plan/hills';
import {
  canMergeWithNext,
  legBounds,
  legDurationS,
  maxDurationS,
  planEnd,
  planPlaces,
  planStart,
  removedWith,
  samePlace,
  tidyName,
} from '../plan/plan';
import type { Direction, Leg, Place, Plan, PlanIssue } from '../plan/types';
import { atLocalTime, formatClock, formatDuration, formatTimeOnDay } from '../time';
import { timesHint } from '../timesHint';
import { HillProfile } from './HillProfile';
import { NameInPlace } from './NameField';
import { NoBikesBadge, RouteBadge } from './RouteBadge';

/**
 * Something to say under one leg, about what you just did to it: why a change was refused, or
 * what else a change moved.
 */
export interface LegMessage {
  legId: string;
  text: string;
  tone: 'error' | 'warning';
}

/** Each edit returns an error message if it was refused, to show under the leg (LegMessage). */
export interface LegEdits {
  onSetDuration: (legId: string, seconds: number) => string | null;
  onSetStart: (legId: string, time: string) => string | null;
  onSetEnd: (legId: string, time: string) => string | null;
}

interface Props extends LegEdits {
  plan: Plan;
  issues: PlanIssue[];
  /** Which end of the plan you're extending: removing a leg in the middle takes those beyond it. */
  direction: Direction;
  onSwitchMode: (legId: string) => void;
  /** Merge a walk, bike or wait leg with the same kind of leg right after it, `nextId`. */
  onMerge: (legId: string, nextId: string) => void;
  /** Rename a place everywhere it appears, from its name in a leg or under Rename places. */
  onRename: (place: Place, name: string) => void;
  /** Remove a leg you chose, and the legs that go with it (see removedWith). */
  onRemove: (legId: string) => void;
  onSummary: () => void;
  /** While a request is in flight, edits wait so they can't race it. */
  disabled?: boolean;
  /** Shown under its leg until the next action. */
  message?: LegMessage | null;
}

export function Itinerary(props: Props) {
  const { plan, issues } = props;
  const start = planStart(plan);
  const end = planEnd(plan);
  // How many legs go with a leg you chose when you remove it: those beyond one in the middle.
  const beyond = (leg: Leg) => (leg.auto ? 0 : removedWith(plan, leg.id, props.direction).length);
  const removeButton = (leg: Leg) => (
    <RemoveButton
      leg={leg}
      beyond={beyond(leg)}
      direction={props.direction}
      disabled={props.disabled}
      onRemove={props.onRemove}
    />
  );
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
                <LegSummary
                  leg={leg}
                  // Where the plan begins, unless the From line names it: after legs added
                  // before the start, or the first ones removed, no other row does.
                  from={i === 0 && !samePlace(leg.start.place, plan.anchor.place)}
                  disabled={props.disabled}
                  onRename={props.onRename}
                />
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
                {!leg.auto && !beyond(leg) && removeButton(leg)}
              </div>
              {editable(leg) && (
                <LegTimesEditor
                  // Kept while the leg's times change, so a field keeps focus after Enter.
                  key={leg.id}
                  plan={plan}
                  leg={leg}
                  edits={props}
                  disabled={props.disabled}
                />
              )}
              {issues
                .filter((i) => i.legId === leg.id && i.kind !== 'bikes-not-allowed')
                .map((i) => (
                  <p key={i.kind} className={`issue issue-${i.severity} leg-wide`}>
                    {i.message}
                  </p>
                ))}
              {props.message?.legId === leg.id && (
                <p
                  className={`issue issue-${props.message.tone} leg-wide`}
                  role={props.message.tone === 'error' ? 'alert' : 'status'}
                >
                  {props.message.text}
                </p>
              )}
              {beyond(leg) > 0 && removeButton(leg)}
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
      </div>
    </section>
  );
}

/**
 * Removes a leg you chose. A leg in the middle takes the `beyond` legs after it (or before it,
 * planning backwards) with it, which its text says. That one sits at the foot of the row, away
 * from Switch to walk / bike, and shows only on the row you point at or move into, so a stray
 * click can't take half the trip (Undo brings it all back).
 */
function RemoveButton(props: {
  leg: Leg;
  beyond: number;
  direction: Direction;
  disabled?: boolean;
  onRemove: (legId: string) => void;
}) {
  const { leg, beyond } = props;
  const side = props.direction === 'forward' ? 'after' : 'before';
  return (
    <button
      type="button"
      className={beyond ? 'link remove remove-beyond' : 'link remove'}
      disabled={props.disabled}
      aria-label={
        beyond
          ? `Remove ${legTitle(leg)} and the ${beyond} ${beyond === 1 ? 'leg' : 'legs'} ${side} it`
          : `Remove: ${legTitle(leg)}`
      }
      onClick={(e) => {
        // The second click of a double-click would remove the leg that took its place.
        if (e.detail > 1) return;
        props.onRemove(leg.id);
      }}
    >
      {beyond ? `Remove this and the ${beyond === 1 ? 'one' : beyond} ${side}` : 'Remove'}
    </button>
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

/**
 * A leg in a few words. Its places' names can be clicked to rename them. With `from`, a walk or
 * bike ride names where it leaves from too.
 */
function LegSummary(props: {
  leg: Leg;
  from?: boolean;
  disabled?: boolean;
  onRename: (place: Place, name: string) => void;
}) {
  const { leg } = props;
  const nameOf = (place: Place) => (
    <NameInPlace
      place={place}
      disabled={props.disabled}
      onRename={(name) => props.onRename(place, name)}
    />
  );
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
          {nameOf(leg.start.place)} → {nameOf(leg.end.place)} · {legNotes(leg)[0]} · {duration}
        </span>
      </p>
    );
  }
  if (leg.mode === 'wait') {
    return (
      <p>
        Wait {duration}
        <span className="muted"> at {nameOf(leg.start.place)}</span>
      </p>
    );
  }
  const notes = legNotes(leg).filter((n) => !n.startsWith('edited'));
  const hills = leg.mode === 'bike' && leg.path ? hillProfile(leg.path) : null;
  return (
    <>
      <p>
        {MODE_NAMES[leg.mode]} {props.from && <>from {nameOf(leg.start.place)} </>}to{' '}
        {nameOf(leg.end.place)}
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
 * Departure, arrival and duration of a walk, bike or manual wait leg, on one line. An end that
 * meets a ride is fixed; moving a free end shifts the leg, or stretches it if the other end is
 * fixed. What can move is said over the leg's summary while one of the fields has focus.
 */
function LegTimesEditor({ plan, leg, edits, disabled }: EditorProps) {
  const bounds = legBounds(plan, leg.id);
  const maxS = maxDurationS(plan, leg.id);
  const minutes = Math.round(legDurationS(leg) / 60);
  const [start, setStart] = useState(formatClock(leg.start.time));
  const [end, setEnd] = useState(formatClock(leg.end.time));
  const [duration, setDuration] = useState(String(minutes));
  // The fields follow the leg when its times change: after an edit here, and after Undo, a
  // switch, a merge or anything else that moves it.
  const times = `${leg.start.time}/${leg.end.time}`;
  const [shown, setShown] = useState(times);
  if (shown !== times) {
    setShown(times);
    setStart(formatClock(leg.start.time));
    setEnd(formatClock(leg.end.time));
    setDuration(String(minutes));
  }
  const hintId = useId();
  const isWait = leg.mode === 'wait';

  // A refused edit puts the times back; the itinerary says why, under the leg.
  function commit(refusal: string | null) {
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
    <div className="times-editor leg-wide">
      <div className="times-fields">
        <label className="field">
          {isWait ? 'From' : 'Leave'}
          <input
            type="time"
            value={start}
            disabled={disabled || !bounds.startFree}
            title={
              bounds.startFree
                ? undefined
                : `Fixed: it ${isWait ? 'starts' : 'leaves'} as the ride before it arrives`
            }
            aria-describedby={hintId}
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
            title={
              bounds.endFree
                ? undefined
                : `Fixed: it ${isWait ? 'ends' : 'arrives'} as the ride after it leaves`
            }
            aria-describedby={hintId}
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
            aria-describedby={hintId}
          />
        </label>
      </div>
      <p className="muted times-hint" id={hintId}>
        {timesHint(plan, leg.id)}
      </p>
    </div>
  );
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
  const name = place.name ?? '';
  const [draft, setDraft] = useState(name);
  // As in the From line (see NameField): a request that starts as you type puts the name back.
  if (disabled && draft !== name) setDraft(name);
  const save = () => tidyName(draft) !== tidyName(name) && onRename(tidyName(draft));
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
