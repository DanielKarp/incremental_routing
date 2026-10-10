import type { TransitCall, TripDetail } from '../api';
import { routeLabel } from '../plan/build';
import type { Direction } from '../plan/types';
import { formatTime } from '../time';
import { NoBikesBadge, RouteBadge } from './RouteBadge';

interface Props {
  trip: TripDetail;
  /** The departure (forwards) or arrival (backwards) that was picked. */
  call: TransitCall;
  direction: Direction;
  onChoose: (stopSequence: number) => void;
  onBack: () => void;
  disabled?: boolean;
}

/**
 * After picking a trip: choose where to get off among its later stops (forwards), or where
 * to get on among its earlier stops (backwards).
 */
export function TripStops({ trip, call, direction, onChoose, onBack, disabled }: Props) {
  const forward = direction === 'forward';
  const choices = trip.stops.filter((s) =>
    forward
      ? s.stop_sequence > call.stop_sequence && s.can_alight
      : s.stop_sequence < call.stop_sequence && s.can_board,
  );
  return (
    <div className="trip-stops">
      <h3>{forward ? 'Where do you get off?' : 'Where do you get on?'}</h3>
      <p>
        <RouteBadge
          name={routeLabel(trip.route)}
          color={trip.route.color}
          textColor={trip.route.text_color}
        />{' '}
        {trip.headsign} {trip.bikes_allowed === 2 && <NoBikesBadge />}
      </p>
      <p className="muted">
        {forward
          ? `Boards at ${call.stop.name}, ${formatTime(call.departure)}`
          : `Gets off at ${call.stop.name}, ${formatTime(call.arrival)}`}
      </p>
      <ul className="calls">
        {choices.map((s) => (
          <li key={s.stop_sequence}>
            <button
              type="button"
              className="call call-button stop-choice"
              disabled={disabled}
              onClick={() => onChoose(s.stop_sequence)}
            >
              <span className="call-time">{formatTime(forward ? s.arrival : s.departure)}</span>
              <span>{s.stop.name}</span>
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="secondary" onClick={onBack}>
        Back to the list
      </button>
    </div>
  );
}
