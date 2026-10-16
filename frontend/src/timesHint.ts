// What the Leave, Arrive and Minutes fields of a walk, bike or wait leg can do, in a few words.
// The itinerary shows it with the fields while one of them has focus.

import { departureWindow, durationAnchor, legBounds, maxDurationS, toMs } from './plan/plan';
import type { Plan } from './plan/types';
import { formatTime } from './time';

/**
 * "Leave by 8:35 AM · up to 22 min, keeping the departure". A wait starts and ends rather than
 * leaving and arriving: "Start by 8:35 AM".
 */
export function timesHint(plan: Plan, legId: string): string {
  const leg = plan.legs.find((l) => l.id === legId);
  if (!leg) return '';
  const wait = leg.mode === 'wait';
  const leave = wait ? 'start' : 'leave';
  const bounds = legBounds(plan, legId);
  const maxS = maxDurationS(plan, legId);
  const parts: string[] = [];
  const { earliest, latest } = departureWindow(plan, legId);
  if (earliest && latest && toMs(earliest) >= toMs(latest)) {
    // It fills the time between the legs around it.
    parts.push("can't move without changing its length");
  } else if (earliest && latest) {
    parts.push(`can ${leave} ${formatTime(earliest)}–${formatTime(latest)}`);
  } else if (latest) parts.push(`${leave} by ${formatTime(latest)}`);
  else if (earliest) parts.push(`${leave} at ${formatTime(earliest)} or later`);
  if (!bounds.startFree) parts.push(`${wait ? 'starts' : 'leaves'} as the ride arrives`);
  if (!bounds.endFree) parts.push(`${wait ? 'ends' : 'arrives'} as the ride leaves`);
  const keepsStart = durationAnchor(plan, legId) === 'start';
  const keeps = wait ? (keepsStart ? 'start' : 'end') : keepsStart ? 'departure' : 'arrival';
  const length = maxS === null ? 'any length' : `up to ${Math.floor(maxS / 60)} min`;
  parts.push(`${length}, keeping the ${keeps}`);
  const text = parts.join(' · ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
