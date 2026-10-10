// Heads-ups from the feed's transfers.txt while choosing the next transit leg. Only advice:
// a tight or forbidden connection can still be chosen.

import type { TransitCall } from '../api';
import { formatDuration } from '../time';
import { toMs } from './plan';
import type { Direction, Leg, Plan } from './types';

export interface TransferNote {
  level: 'warning' | 'info';
  text: string;
}

/**
 * The ride you'd be changing from (planning forwards) or to (backwards): the plan's last or
 * first leg, if it's a transit leg. Transfer rules only apply right next to one.
 */
export function adjacentRide(plan: Plan, direction: Direction): Leg | null {
  const userLegs = plan.legs.filter((l) => !l.auto);
  const leg = direction === 'forward' ? userLegs[userLegs.length - 1] : userLegs[0];
  return leg?.mode === 'transit' ? leg : null;
}

/** The ride's stop and trip, as the API wants them for looking up transfer rules. */
export function transferContext(ride: Leg | null, direction: Direction) {
  const place = direction === 'forward' ? ride?.end.place : ride?.start.place;
  if (!ride?.transit || !place?.stopId) return undefined;
  return { stopId: place.stopId, tripId: ride.transit.tripId };
}

/** What to tell the user about changing between `ride` and a candidate trip, if anything. */
export function transferNote(
  call: TransitCall,
  ride: Leg | null,
  direction: Direction,
): TransferNote | null {
  const rule = call.transfer;
  if (!rule || !ride) return null;
  const slackS =
    direction === 'forward'
      ? (toMs(call.departure) - toMs(ride.end.time)) / 1000
      : (toMs(ride.start.time) - toMs(call.arrival)) / 1000;
  if (rule.type === 3) {
    return { level: 'warning', text: "The agency says this transfer isn't possible" };
  }
  if (rule.min_transfer_s && slackS < rule.min_transfer_s) {
    return {
      level: 'warning',
      text: `${formatDuration(slackS)} to change; the agency allows at least ${formatDuration(rule.min_transfer_s)}`,
    };
  }
  if (rule.type === 1) return { level: 'info', text: 'Timed transfer: the connection is held' };
  return null;
}
