import type { TransitCall } from '../api';
import { routeLabel } from '../plan/build';
import { formatDuration, formatTime } from '../time';
import { NoBikesBadge, RouteBadge } from './RouteBadge';

interface Props {
  calls: TransitCall[];
  direction: 'departures' | 'arrivals';
  /** When set, each trip is a button that picks it. */
  onSelect?: (call: TransitCall) => void;
  disabled?: boolean;
}

/** Trips you could board (departures) or alight from (arrivals) near the frontier. */
export function CallList({ calls, direction, onSelect, disabled }: Props) {
  if (!calls.length) return <p className="muted">No trips found in this window.</p>;
  return (
    <ul className="calls">
      {calls.map((call) => {
        const time = direction === 'departures' ? call.departure : call.arrival;
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
              {call.stop.name} · {formatDuration(call.stop.walk_s)} walk
            </span>
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
