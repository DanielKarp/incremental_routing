// Plan files: JSON to save and load, CSV for spreadsheets, iCalendar for calendar apps.

import { formatDuration, formatLocalDateTime, formatTime } from '../time';
import { legDurationS, planStart, withWaits } from './plan';
import type { Leg, Place, Plan } from './types';

export const PLAN_FORMAT = 'incremental-routing-plan';
export const PLAN_VERSION = 1;

// ---- Describing legs (shared by the summary table and the exports) ----------------------

export const MODE_NAMES: Record<Leg['mode'], string> = {
  transit: 'Transit',
  walk: 'Walk',
  bike: 'Bike',
  wait: 'Wait',
};

export function placeName(place: Place): string {
  return place.name || `${place.lat.toFixed(5)}, ${place.lon.toFixed(5)}`;
}

/** "Express to San Francisco", "Walk to Office", "Wait at Millbrae". */
export function legTitle(leg: Leg): string {
  if (leg.transit) {
    return `${leg.transit.routeName} to ${leg.transit.headsign || placeName(leg.end.place)}`;
  }
  if (leg.mode === 'wait') return `Wait at ${placeName(leg.start.place)}`;
  return `${MODE_NAMES[leg.mode]} to ${placeName(leg.end.place)}`;
}

/** Short facts about a leg beyond its places and times. */
export function legNotes(leg: Leg): string[] {
  const notes: string[] = [];
  if (leg.transit) {
    const stops = leg.transit.stops.length - 1;
    notes.push(`${stops} ${stops === 1 ? 'stop' : 'stops'}`);
    if (leg.transit.bikesAllowed === false) notes.push('bikes not allowed');
  }
  if (leg.path) {
    notes.push(`${(leg.path.distanceM / 1000).toFixed(1)} km`);
    if (leg.path.provider === 'estimate') notes.push('estimated');
    if (Math.abs(legDurationS(leg) - leg.path.routedDurationS) >= 30) {
      notes.push(`edited, routed ${formatDuration(leg.path.routedDurationS)}`);
    }
  }
  if (leg.auto) notes.push('connection');
  return notes;
}

export function planFileName(plan: Plan, extension: string): string {
  return `trip-${formatLocalDateTime(planStart(plan).time).slice(0, 10)}.${extension}`;
}

// ---- JSON ----------------------------------------------------------------------------------

export function planToJson(plan: Plan): string {
  return JSON.stringify({ format: PLAN_FORMAT, version: PLAN_VERSION, plan }, null, 2);
}

export type ParseResult = { ok: true; plan: Plan } | { ok: false; reason: string };

export function parsePlanJson(text: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'That file is not JSON.' };
  }
  if (!isObject(data) || data.format !== PLAN_FORMAT) {
    return { ok: false, reason: 'That file is not an Incremental Routing plan.' };
  }
  if (data.version !== PLAN_VERSION) {
    return { ok: false, reason: `Unsupported plan file version: ${String(data.version)}.` };
  }
  return validatePlan(data.plan);
}

/** Check untrusted data (a file, browser storage) is a plan; derived waits are rebuilt. */
export function validatePlan(value: unknown): ParseResult {
  const problem = planProblem(value);
  if (problem) return { ok: false, reason: `The plan is damaged: ${problem}.` };
  const plan = value as Plan;
  const legs = plan.legs.map((leg) =>
    leg.transit ? { ...leg, transit: { ...leg.transit, textColor: leg.transit.textColor ?? null } } : leg,
  );
  return { ok: true, plan: { anchor: plan.anchor, legs: withWaits(legs) } };
}

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isStrOrNull = (v: unknown) => v === null || isStr(v);
const isTime = (v: unknown) => isStr(v) && !Number.isNaN(Date.parse(v));
const MODES = new Set(['transit', 'walk', 'bike', 'wait']);

export function isPlace(v: unknown): v is Place {
  return (
    isObject(v) &&
    isNum(v.lat) &&
    isNum(v.lon) &&
    (v.name === undefined || isStr(v.name)) &&
    (v.stopId === undefined || isStr(v.stopId))
  );
}

function waypointProblem(v: unknown): string | null {
  if (!isObject(v) || !isPlace(v.place)) return 'a place needs a numeric lat and lon';
  return isTime(v.time) ? null : 'a time is not a valid date';
}

function transitProblem(t: unknown): string | null {
  if (
    !isObject(t) ||
    !isStr(t.tripId) ||
    !isStr(t.serviceDate) ||
    !isStr(t.routeName) ||
    !isStrOrNull(t.headsign) ||
    !isStrOrNull(t.color) ||
    !(t.textColor === undefined || isStrOrNull(t.textColor)) ||
    !(t.bikesAllowed === null || typeof t.bikesAllowed === 'boolean') ||
    !(t.agency === undefined || isStrOrNull(t.agency)) ||
    !(t.geometry === undefined || isCoords(t.geometry)) ||
    !Array.isArray(t.stops)
  ) {
    return 'incomplete transit details';
  }
  const stopsOk = t.stops.every(
    (s) => isObject(s) && isStr(s.stopId) && isStr(s.name) && isNum(s.lat) && isNum(s.lon) && isTime(s.time),
  );
  return stopsOk ? null : 'a transit stop is incomplete';
}

function isCoords(v: unknown): boolean {
  return (
    Array.isArray(v) &&
    v.every((c) => Array.isArray(c) && c.length === 2 && isNum(c[0]) && isNum(c[1]))
  );
}

function pathProblem(p: unknown): string | null {
  const ok =
    isObject(p) &&
    isStr(p.provider) &&
    isNum(p.distanceM) &&
    isNum(p.routedDurationS) &&
    isCoords(p.geometry);
  return ok ? null : 'an invalid path';
}

function legProblem(v: unknown): string | null {
  if (!isObject(v) || !isStr(v.id) || !isStr(v.mode) || !MODES.has(v.mode)) {
    return 'needs an id and a known mode';
  }
  const where = waypointProblem(v.start) ?? waypointProblem(v.end);
  if (where) return where;
  if (v.fixed !== undefined && v.fixed !== 'start' && v.fixed !== 'end') return 'an unknown fixed end';
  if (v.auto !== undefined && typeof v.auto !== 'boolean') return 'an invalid auto flag';
  if (v.mode === 'transit') return transitProblem(v.transit);
  if (v.path !== undefined) return pathProblem(v.path);
  return null;
}

function planProblem(v: unknown): string | null {
  if (!isObject(v)) return 'no plan found';
  const anchor = waypointProblem(v.anchor);
  if (anchor) return `start point: ${anchor}`;
  if (!Array.isArray(v.legs)) return 'legs is not a list';
  for (const [i, leg] of v.legs.entries()) {
    const problem = legProblem(leg);
    if (problem) return `leg ${i + 1}: ${problem}`;
  }
  const ids = v.legs.map((leg) => (leg as Obj).id);
  return new Set(ids).size === ids.length ? null : 'two legs share an id';
}

// ---- CSV -----------------------------------------------------------------------------------

const CSV_HEADER = [
  'leg',
  'mode',
  'from',
  'depart',
  'to',
  'arrive',
  'duration_min',
  'agency',
  'route',
  'headsign',
  'notes',
  'from_lat',
  'from_lon',
  'to_lat',
  'to_lon',
];

/** One row per leg, waits included. Times are Bay Area local time. */
export function planToCsv(plan: Plan): string {
  const rows = plan.legs.map((leg, i) => [
    String(i + 1),
    MODE_NAMES[leg.mode],
    text(placeName(leg.start.place)),
    formatLocalDateTime(leg.start.time),
    text(placeName(leg.end.place)),
    formatLocalDateTime(leg.end.time),
    (legDurationS(leg) / 60).toFixed(1),
    text(leg.transit?.agency ?? ''),
    text(leg.transit?.routeName ?? ''),
    text(leg.transit?.headsign ?? ''),
    text(legNotes(leg).join('; ')),
    leg.start.place.lat.toFixed(6),
    leg.start.place.lon.toFixed(6),
    leg.end.place.lat.toFixed(6),
    leg.end.place.lon.toFixed(6),
  ]);
  const lines = [CSV_HEADER, ...rows].map((row) => row.map(csvCell).join(','));
  // The byte-order mark makes Excel read the file as UTF-8.
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** Keep spreadsheet apps from treating names like "=SUM(…)" as formulas. */
function text(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

// ---- iCalendar -----------------------------------------------------------------------------

/** One event per leg you chose (connection waits are implied by the gaps). RFC 5545. */
export function planToIcs(plan: Plan, now: Date = new Date()): string {
  const stamp = icsTime(now.toISOString());
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Incremental Routing//Trip planner//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];
  for (const leg of plan.legs) {
    if (leg.auto) continue;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${leg.id}@incremental-routing`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsTime(leg.start.time)}`,
      `DTEND:${icsTime(leg.end.time)}`,
      `SUMMARY:${icsText(legTitle(leg))}`,
      `LOCATION:${icsText(placeName(leg.start.place))}`,
      `DESCRIPTION:${icsText(legDescription(leg))}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

function legDescription(leg: Leg): string {
  const from = `${placeName(leg.start.place)} at ${formatTime(leg.start.time)}`;
  const to = `${placeName(leg.end.place)} at ${formatTime(leg.end.time)}`;
  const notes = legNotes(leg);
  const facts = notes.length ? ` (${notes.join(', ')})` : '';
  if (leg.mode === 'wait') return `Wait at ${from} until ${formatTime(leg.end.time)}.`;
  return `From ${from}\nTo ${to}${facts}`;
}

/** 2026-10-12T14:43:00.000Z -> 20261012T144300Z */
function icsTime(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function icsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** Lines over 75 octets continue on the next line, which starts with a space. */
function foldLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = '';
  let size = 0;
  for (const char of line) {
    const bytes = encoder.encode(char).length;
    const limit = parts.length === 0 ? 75 : 74;
    if (size + bytes > limit) {
      parts.push(current);
      current = '';
      size = 0;
    }
    current += char;
    size += bytes;
  }
  parts.push(current);
  return parts.join('\r\n ');
}
