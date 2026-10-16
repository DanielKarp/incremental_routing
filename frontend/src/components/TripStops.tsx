import { useEffect, useRef } from 'react';
import type { TransitCall, TripDetail } from '../api';
import { type MissedTrip, routeLabel, stopChoices } from '../plan/build';
import type { TransferNote } from '../plan/transfers';
import type { Direction } from '../plan/types';
import { bringIntoView, bringTopIntoView } from '../scroll';
import { formatTime } from '../time';
import { NoBikesBadge, RouteBadge } from './RouteBadge';

interface Props {
  trip: TripDetail;
  /** The departure (forwards) or arrival (backwards) that was picked. */
  call: TransitCall;
  direction: Direction;
  onChoose: (stopSequence: number) => void;
  /** Back to the list of lines (Escape does it too). */
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
 * to get on among its earlier stops (backwards). Its header, with the way back to the list,
 * the trip and where you board it, stays at the top of the panel while you scroll the stops.
 */
export function TripStops(props: Props) {
  const { trip, call, direction, onChoose, onBack, missed, disabled } = props;
  const forward = direction === 'forward';
  const choices = stopChoices(trip, call.stop_sequence, direction);
  const chooser = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const warning = useRef<HTMLDivElement>(null);
  // A trip just picked starts at its header, however far down the list you picked it from. The
  // button you used has gone, so keyboard focus comes here rather than to the top of the page.
  useEffect(() => {
    bringTopIntoView(chooser.current);
    if (document.activeElement === document.body) heading.current?.focus({ preventScroll: true });
  }, [trip]);
  // The route arrives after the stops are listed; if it misses the trip, that comes into view.
  const reason = missed?.reason;
  useEffect(() => {
    if (reason) bringIntoView(warning.current);
  }, [reason]);
  const instead = missed?.instead;
  const note = instead && props.noteFor?.(instead);
  return (
    <div className="trip-stops" ref={chooser}>
      <h3 ref={heading} tabIndex={-1}>
        {forward ? 'Where do you get off?' : 'Where do you get on?'}
      </h3>
      <p className="muted">Choose a stop here or on the map.</p>
      <div className="trip-stops-header">
        <div className="row align-center">
          <button
            type="button"
            className="secondary trip-stops-back"
            disabled={disabled}
            aria-label="Back to the lines"
            title="Back to the list (Esc)"
            onClick={onBack}
          >
            <span aria-hidden="true">←</span> Lines
          </button>
          <span className="trip-stops-trip">
            <RouteBadge
              name={routeLabel(trip.route)}
              color={trip.route.color}
              textColor={trip.route.text_color}
            />{' '}
            {trip.headsign} {trip.bikes_allowed === 2 && <NoBikesBadge />}
          </span>
        </div>
        <p className="muted">
          {forward
            ? `Boards at ${call.stop.name}, ${formatTime(call.departure)}`
            : `Gets off at ${call.stop.name}, ${formatTime(call.arrival)}`}
        </p>
        {/* In the header, so the stops scrolling under it can't hide it. */}
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
      </div>
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
    </div>
  );
}
