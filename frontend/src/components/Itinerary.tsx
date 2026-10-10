import { useState } from 'react';
import { legDurationS, maxDurationS, planEnd, planStart } from '../plan/plan';
import type { Leg, Plan, PlanIssue } from '../plan/types';
import { formatDuration, formatTime } from '../time';
import { NoBikesBadge, RouteBadge } from './RouteBadge';

interface Props {
  plan: Plan;
  issues: PlanIssue[];
  /** Returns an error message if the edit was refused. */
  onSetDuration: (legId: string, seconds: number) => string | null;
  onUndo: () => void;
  onClear: () => void;
}

const MODE_LABELS = { walk: 'Walk', bike: 'Bike', wait: 'Wait', transit: 'Ride' } as const;

export function Itinerary({ plan, issues, onSetDuration, onUndo, onClear }: Props) {
  const start = planStart(plan);
  const end = planEnd(plan);
  return (
    <section>
      <h2>Itinerary</h2>
      <ol className="itinerary">
        {plan.legs.map((leg) => (
          <li key={leg.id} className={`leg leg-${leg.mode}`}>
            <span className="leg-times">
              {formatTime(leg.start.time)}
              <br />
              {formatTime(leg.end.time)}
            </span>
            <div className="leg-body">
              <LegSummary leg={leg} />
              {(leg.mode === 'walk' || leg.mode === 'bike' || (leg.mode === 'wait' && !leg.auto)) && (
                <DurationEditor
                  key={`${leg.id}:${leg.end.time}`}
                  leg={leg}
                  maxS={maxDurationS(plan, leg.id, 'start')}
                  onCommit={(s) => onSetDuration(leg.id, s)}
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
          </li>
        ))}
      </ol>
      <p className="muted">
        Total {formatDuration((Date.parse(end.time) - Date.parse(start.time)) / 1000)}, from{' '}
        {formatTime(start.time)} to {formatTime(end.time)}
      </p>
      <div className="row">
        <button type="button" className="secondary" onClick={onUndo}>
          Undo
        </button>
        <button type="button" className="secondary" onClick={onClear}>
          Clear plan
        </button>
      </div>
    </section>
  );
}

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
          {leg.start.place.name} → {leg.end.place.name} · {t.stops.length - 1} stops · {duration}
        </span>
      </p>
    );
  }
  if (leg.mode === 'wait') {
    return (
      <p>
        {MODE_LABELS.wait} {duration}
        <span className="muted"> at {leg.start.place.name ?? 'start'}</span>
      </p>
    );
  }
  const km = leg.path ? ` · ${(leg.path.distanceM / 1000).toFixed(1)} km` : '';
  const estimated = leg.path?.provider === 'estimate' ? ' (estimated)' : '';
  return (
    <p>
      {MODE_LABELS[leg.mode]} to {leg.end.place.name ?? 'pin'}
      <span className="muted">
        {km}
        {estimated}
      </span>
    </p>
  );
}

interface EditorProps {
  leg: Leg;
  maxS: number | null;
  onCommit: (seconds: number) => string | null;
}

/** Minutes field for walk, bike and manual wait legs. Edits past maxS are refused. */
function DurationEditor({ leg, maxS, onCommit }: EditorProps) {
  const current = Math.round(legDurationS(leg) / 60);
  const [draft, setDraft] = useState(String(current));
  const [error, setError] = useState<string | null>(null);

  function commit() {
    const minutes = Number(draft);
    if (draft === '' || minutes === current) return;
    const refusal = onCommit(minutes * 60);
    setError(refusal);
    if (refusal) setDraft(String(current));
  }

  return (
    <div className="duration">
      <label>
        <input
          type="number"
          min={0}
          max={maxS === null ? undefined : Math.floor(maxS / 60)}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && commit()}
          aria-label="Duration in minutes"
        />{' '}
        min
      </label>
      {maxS !== null && <span className="muted"> up to {Math.floor(maxS / 60)}</span>}
      {error && <p className="issue issue-error">{error}</p>}
    </div>
  );
}
