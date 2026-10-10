import { useState } from 'react';
import { legNotes, legTitle } from '../plan/files';
import { isEndLeg, legDurationS, maxDurationS, planEnd, planStart } from '../plan/plan';
import type { Leg, Plan, PlanIssue } from '../plan/types';
import { formatDuration, formatTimeOnDay } from '../time';
import { NoBikesBadge, RouteBadge } from './RouteBadge';

interface Props {
  plan: Plan;
  issues: PlanIssue[];
  /** Returns an error message if the edit was refused. */
  onSetDuration: (legId: string, seconds: number) => string | null;
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
        {plan.legs.map((leg) => (
          <li key={leg.id} className={`leg leg-${leg.mode}`}>
            <span className="leg-times">
              {formatTimeOnDay(leg.start.time, start.time)}
              <br />
              {formatTimeOnDay(leg.end.time, start.time)}
            </span>
            <div className="leg-body">
              <LegSummary leg={leg} />
              {editable(leg) && (
                <DurationEditor
                  key={`${leg.id}:${leg.start.time}:${leg.end.time}`}
                  leg={leg}
                  maxS={maxDurationS(plan, leg.id)}
                  onCommit={(s) => props.onSetDuration(leg.id, s)}
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
          </li>
        ))}
      </ol>
      <p className="muted">
        Total {formatDuration((Date.parse(end.time) - Date.parse(start.time)) / 1000)}, from{' '}
        {formatTimeOnDay(start.time, start.time)} to {formatTimeOnDay(end.time, start.time)}
      </p>
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
  return (
    <p>
      {legTitle(leg)}
      <span className="muted"> · {notes.join(' · ')}</span>
    </p>
  );
}

interface EditorProps {
  leg: Leg;
  maxS: number | null;
  onCommit: (seconds: number) => string | null;
  disabled?: boolean;
}

/** Minutes field for walk, bike and manual wait legs. Edits past maxS are refused. */
function DurationEditor({ leg, maxS, onCommit, disabled }: EditorProps) {
  const current = Math.round(legDurationS(leg) / 60);
  const [draft, setDraft] = useState(String(current));
  const [error, setError] = useState<string | null>(null);
  const keeps = (leg.fixed ?? 'start') === 'start' ? 'departure' : 'arrival';

  function commit() {
    const minutes = Number(draft);
    if (draft === '' || minutes === current) return;
    const refusal = onCommit(minutes * 60);
    setError(refusal);
    if (refusal) setDraft(String(current));
  }

  return (
    <div className="duration">
      <label title={`Changing the duration keeps the ${keeps} time`}>
        <input
          type="number"
          min={0}
          max={maxS === null ? undefined : Math.floor(maxS / 60)}
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && commit()}
          aria-label="Duration in minutes"
        />{' '}
        min
      </label>
      <span className="muted">
        {maxS !== null && ` up to ${Math.floor(maxS / 60)}`} · keeps {keeps}
      </span>
      {error && <p className="issue issue-error">{error}</p>}
    </div>
  );
}
