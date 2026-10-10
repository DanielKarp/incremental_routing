import type { PathMode, TransitCall } from '../api';
import { routeLabel } from '../plan/build';
import type { TransferNote } from '../plan/transfers';
import { formatDuration, formatTime } from '../time';
import { NoBikesBadge, RouteBadge } from './RouteBadge';

interface Props {
  calls: TransitCall[];
  direction: 'departures' | 'arrivals';
  /** How you'd get between the stop and your point. */
  access: PathMode;
  /** A heads-up about changing to or from the adjacent ride, if any. */
  noteFor?: (call: TransitCall) => TransferNote | null;
  /** When set, each trip is a button that picks it. */
  onSelect?: (call: TransitCall) => void;
  disabled?: boolean;
}

/** Trips you could board (departures) or alight from (arrivals) near the frontier. */
export function CallList({ calls, direction, access, noteFor, onSelect, disabled }: Props) {
  if (!calls.length) return <p className="muted">No trips found in this window.</p>;
  return (
    <ul className="calls">
      {calls.map((call) => {
        const time = direction === 'departures' ? call.departure : call.arrival;
        const note = noteFor?.(call);
        const content = (
          <>
            <span className="call-time">{formatTime(time)}</span>
            <RouteBadge
              name={routeLabel(call.route)}
              color={call.route.color}
              textColor={call.route.text_color}
            />
            <span className="call-headsign">
              {call.headsign ?? ''} {call.bikes_allowed === 2 && <NoBikesBadge />}
            </span>
            <span className="call-stop muted">
              {call.route.agency ? `${call.route.agency} · ` : ''}
              {call.stop.name} · {formatDuration(call.stop.access_s)}{' '}
              {access === 'bike' ? 'by bike' : 'walk'}
            </span>
            {note && <span className={`call-note issue-${note.level}`}>{note.text}</span>}
          </>
        );
        return (
          <li key={`${call.trip_id}@${call.service_date}`}>
            {onSelect ? (
              <button
                type="button"
                className="call call-button"
                disabled={disabled}
                onClick={() => onSelect(call)}
              >
                {content}
              </button>
            ) : (
              <div className="call">{content}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
