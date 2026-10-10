import { MODE_NAMES, legNotes, placeName } from '../plan/files';
import { legDurationS, planEnd, planStart } from '../plan/plan';
import type { Plan, PlanIssue } from '../plan/types';
import { formatDate, formatDuration, formatTimeOnDay } from '../time';
import { RouteBadge } from './RouteBadge';

interface Props {
  plan: Plan;
  issues: PlanIssue[];
}

/** The finished trip: every leg with its places and times. Used on screen and in print. */
export function PlanTable({ plan, issues }: Props) {
  const start = planStart(plan);
  const end = planEnd(plan);
  const errors = issues.filter((i) => i.severity === 'error');
  const when = (iso: string) => formatTimeOnDay(iso, start.time);
  return (
    <div className="plan-table">
      <p className="plan-meta">
        <strong>{formatDate(start.time)}</strong> · {when(start.time)} to {when(end.time)} ·{' '}
        {formatDuration((Date.parse(end.time) - Date.parse(start.time)) / 1000)} ·{' '}
        {placeName(start.place)} → {placeName(end.place)}
      </p>
      {errors.length > 0 && (
        <p className="issue issue-error">
          This plan has {errors.length} problem{errors.length > 1 ? 's' : ''}:{' '}
          {errors.map((e) => e.message).join('; ')}.
        </p>
      )}
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Mode</th>
            <th>From</th>
            <th>Depart</th>
            <th>To</th>
            <th>Arrive</th>
            <th>Duration</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {plan.legs.map((leg, i) => (
            <tr key={leg.id} className={leg.auto ? 'row-auto' : undefined}>
              <td>{i + 1}</td>
              <td>{MODE_NAMES[leg.mode]}</td>
              <td>{placeName(leg.start.place)}</td>
              <td className="num">{when(leg.start.time)}</td>
              <td>{placeName(leg.end.place)}</td>
              <td className="num">{when(leg.end.time)}</td>
              <td className="num">{formatDuration(legDurationS(leg))}</td>
              <td>
                {leg.transit && (
                  <>
                    <RouteBadge
                      name={leg.transit.routeName}
                      color={leg.transit.color}
                      textColor={leg.transit.textColor}
                    />{' '}
                    {leg.transit.headsign}
                    {' · '}
                  </>
                )}
                {legNotes(leg).join(' · ')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
