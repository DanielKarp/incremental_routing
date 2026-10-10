import type { TripDetail } from '../api';
import { routeLabel } from '../plan/build';
import { formatTime } from '../time';
import { NoBikesBadge, RouteBadge } from './RouteBadge';

interface Props {
  trip: TripDetail;
  boardSeq: number;
  onAlight: (stopSequence: number) => void;
  onBack: () => void;
  disabled?: boolean;
}

/** After picking a departure: choose where to get off among the trip's later stops. */
export function TripStops({ trip, boardSeq, onAlight, onBack, disabled }: Props) {
  const board = trip.stops.find((s) => s.stop_sequence === boardSeq);
  const later = trip.stops.filter((s) => s.stop_sequence > boardSeq && s.can_alight);
  return (
    <section>
      <h2>Where do you get off?</h2>
      <p>
        <RouteBadge
          name={routeLabel(trip.route)}
          color={trip.route.color}
          textColor={trip.route.text_color}
        />{' '}
        {trip.headsign} {trip.bikes_allowed === 2 && <NoBikesBadge />}
      </p>
      {board && (
        <p className="muted">
          Boards at {board.stop.name}, {formatTime(board.departure)}
        </p>
      )}
      <ul className="calls">
        {later.map((s) => (
          <li key={s.stop_sequence}>
            <button
              type="button"
              className="call call-button stop-choice"
              disabled={disabled}
              onClick={() => onAlight(s.stop_sequence)}
            >
              <span className="call-time">{formatTime(s.arrival)}</span>
              <span>{s.stop.name}</span>
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="secondary" onClick={onBack}>
        Back to departures
      </button>
    </section>
  );
}
