import type { TransitCall } from '../api';
import { formatDuration, formatTime } from '../time';

interface Props {
  calls: TransitCall[];
  direction: 'departures' | 'arrivals';
}

/** Trips you could board (departures) or alight from (arrivals) near the selected point. */
export function CallList({ calls, direction }: Props) {
  if (!calls.length) return <p className="muted">No trips found in this window.</p>;
  return (
    <ul className="calls">
      {calls.map((call) => {
        const time = direction === 'departures' ? call.departure : call.arrival;
        const name = call.route.short_name || call.route.long_name || call.route.route_id;
        return (
          <li key={`${call.trip_id}@${call.service_date}`} className="call">
            <span className="call-time">{formatTime(time)}</span>
            <span
              className="route-badge"
              style={{
                background: call.route.color ? `#${call.route.color}` : undefined,
                color: call.route.text_color ? `#${call.route.text_color}` : undefined,
              }}
            >
              {name}
            </span>
            <span className="call-headsign">{call.headsign ?? ''}</span>
            <span className="call-stop muted">
              {call.stop.name} · {formatDuration(call.stop.walk_s)} walk
            </span>
          </li>
        );
      })}
    </ul>
  );
}
