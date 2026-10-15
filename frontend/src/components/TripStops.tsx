import { useEffect, useRef } from 'react';
import type { TransitCall, TripDetail } from '../api';
import { type MissedTrip, routeLabel, stopChoices } from '../plan/build';
import type { TransferNote } from '../plan/transfers';
import type { Direction } from '../plan/types';
import { bringIntoView } from '../scroll';
import { formatTime } from '../time';
import { NoBikesBadge, RouteBadge } from './RouteBadge';

interface Props {
  trip: TripDetail;
  /** The departure (forwards) or arrival (backwards) that was picked. */
  call: TransitCall;
  direction: Direction;
  onChoose: (stopSequence: number) => void;
  onBack: () => void;
  /** Set when the routed walk or bike ride to (or from) the stop misses the trip. */
  missed?: MissedTrip | null;
  /** Take the same line's trip that the route does make instead. */
  onTakeInstead?: (call: TransitCall) => void;
  noteFor?: (call: TransitCall) => TransferNote | null;
  disabled?: boolean;
}

/**
 * After picking a trip: choose where to get off among its later stops (forwards), or where
 * to get on among its earlier stops (backwards).
 */
export function TripStops(props: Props) {
  const { trip, call, direction, onChoose, onBack, missed, disabled } = props;
  const forward = direction === 'forward';
  const choices = stopChoices(trip, call.stop_sequence, direction);
  const warning = useRef<HTMLDivElement>(null);
  // The route arrives after the stops are listed; if it misses the trip, that comes into view.
  const reason = missed?.reason;
  useEffect(() => {
    if (reason) bringIntoView(warning.current);
  }, [reason]);
  const instead = missed?.instead;
  const note = instead && props.noteFor?.(instead);
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
        . Choose a stop here or on the map.
      </p>
      {missed && (
        <div className="missed" ref={warning}>
          <p className="warning" role="alert">
            {missed.reason}
          </p>
          {instead && (
            <div className="row wrap align-center">
              <button
                type="button"
                className="secondary"
                disabled={disabled}
                onClick={() => props.onTakeInstead?.(instead)}
              >
                Take the {formatTime(forward ? instead.departure : instead.arrival)} instead
              </button>
              {note && <span className={`call-note issue-${note.level}`}>{note.text}</span>}
            </div>
          )}
        </div>
      )}
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
