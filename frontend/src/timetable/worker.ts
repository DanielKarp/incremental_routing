// The Web Worker the page keeps the timetable in (see remote.ts): it downloads and opens the
// timetable, then answers the page's queries.

import { loadTimetable } from '.';
import { type Ask, type Tell, serveTimetable } from './remote';

const scope = self as unknown as {
  postMessage(message: Tell): void;
  onmessage: ((event: MessageEvent<Ask>) => void) | null;
};

const answer = serveTimetable(loadTimetable, (message) => scope.postMessage(message));
scope.onmessage = (event) => answer(event.data);
