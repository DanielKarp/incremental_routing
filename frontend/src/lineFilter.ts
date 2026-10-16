// "Filter lines" above the departure (or arrival) list. It narrows the lines shown, there and on
// the map, by what you type: a route's name, a headsign, a stop or an operator. It never changes
// what is searched for.

import type { RouteInfo, TransitCall } from './api';
import type { CallGroup } from './callGroups';

// Words people use for an operator. Typed as a whole word, one of these picks that operator's
// lines only: "caltrain" leaves out the buses at the Caltrain station. Most operators are found
// by their names or initials anyway (BART, VTA, SFMTA, SMART, ACE), but not Muni.
const OPERATORS: Record<string, string[]> = {
  ac: ['AC TRANSIT'],
  ace: ['Altamont Corridor Express'],
  airtrain: ['SFO Airport'],
  amtrak: ['Capitol Corridor Joint Powers Authority'],
  bart: ['Bay Area Rapid Transit'],
  caltrain: ['Caltrain'],
  gg: ['Golden Gate Transit', 'Golden Gate Ferry'],
  muni: ['San Francisco Municipal Transportation Agency'],
  samtrans: ['SamTrans'],
  sfmta: ['San Francisco Municipal Transportation Agency'],
  smart: ['Sonoma-Marin Area Rail Transit'],
  vta: ['VTA'],
};

// Words for a kind of vehicle, as GTFS route types: 0 tram (Muni Metro, VTA light rail), 1 metro
// (BART), 2 rail (Caltrain, ACE, SMART), 3 bus, 4 ferry, 5 cable car. Typed as a whole word, or
// both words of two, one of these picks those lines only.
const MODES: Record<string, number[]> = {
  bus: [3],
  cable: [5],
  'cable car': [5],
  ferry: [4],
  'light rail': [0],
  rail: [0, 1, 2],
  streetcar: [0],
  train: [1, 2],
  tram: [0],
};

/** One thing a line must match: an operator, a kind of vehicle, or the start of a word. */
type Term =
  | { kind: 'operators'; names: string[] }
  | { kind: 'modes'; types: number[] }
  | { kind: 'text'; word: string };

/** Lower case, without accents, so "Caña" is found by "cana". */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/** The words of a name: "Beale St & Mission St" -> beale, st, mission, st. */
function words(text: string): string[] {
  return fold(text)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * What a filter asks for: one or more alternatives, separated by commas ("bart, caltrain"), each
 * a list of terms that a line must all match ("bart sfo"). Empty when nothing has been typed.
 */
function parseFilter(query: string): Term[][] {
  return query.split(',').flatMap((part) => {
    const typed = words(part);
    const terms: Term[] = [];
    for (let i = 0; i < typed.length; i++) {
      const pair = `${typed[i]} ${typed[i + 1]}`;
      if (MODES[pair]) {
        terms.push({ kind: 'modes', types: MODES[pair] });
        i++;
      } else if (OPERATORS[typed[i]]) {
        terms.push({ kind: 'operators', names: OPERATORS[typed[i]].map(fold) });
      } else if (MODES[typed[i]]) {
        terms.push({ kind: 'modes', types: MODES[typed[i]] });
      } else {
        terms.push({ kind: 'text', word: typed[i] });
      }
    }
    return terms.length ? [terms] : [];
  });
}

/**
 * Whether a typed word starts `word`. A number is taken whole, so "1" finds route 1, 1X and 1st
 * Street but not route 10, and "22" finds 22nd Street.
 */
export function startsWord(word: string, typed: string): boolean {
  if (!word.startsWith(typed)) return false;
  return !/[0-9]$/.test(typed) || !/[0-9]/.test(word.charAt(typed.length));
}

/** An operator's initials, when its name has a few words: BART, SFMTA, GGT, SMART. */
function initials(agency: string): string | null {
  const parts = words(agency);
  return parts.length > 1 ? parts.map((w) => w[0]).join('') : null;
}

/** Every word a line can be found by: its route, headsign, stop and operator. */
function lineWords(route: RouteInfo, call: TransitCall): string[] {
  return [route.short_name, route.long_name, call.headsign, call.stop.name, route.agency]
    .filter((text): text is string => !!text)
    .flatMap(words);
}

function matches(term: Term, call: TransitCall, found: string[]): boolean {
  const { route } = call;
  if (term.kind === 'operators') return !!route.agency && term.names.includes(fold(route.agency));
  if (term.kind === 'modes') return term.types.includes(route.route_type);
  const short = route.agency ? initials(route.agency) : null;
  return found.some((w) => startsWord(w, term.word)) || !!short?.startsWith(term.word);
}

/** Whether the filter has anything in it to match. */
export function isFiltering(query: string): boolean {
  return parseFilter(query).length > 0;
}

/**
 * The lines that match a filter, in the same order. A line matches an alternative when it
 * matches all of its terms, and the filter when it matches any alternative. Matching ignores
 * case. With nothing typed, every line is kept (the same array).
 */
export function filterLines(groups: CallGroup[], query: string): CallGroup[] {
  const filter = parseFilter(query);
  if (!filter.length) return groups;
  return groups.filter((group) => {
    // Every trip of a line has the same route, headsign and stop.
    const call = group.calls[0];
    const found = lineWords(call.route, call);
    return filter.some((terms) => terms.every((term) => matches(term, call, found)));
  });
}
