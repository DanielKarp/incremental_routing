// Reading a walk or bike route request as the server did (POST /api/route in its api.py): FastAPI
// read the body as JSON only when its Content-Type said JSON, and pydantic checked it against
// models.RouteRequest. A request it can't accept gets the same 422 detail as there: every field
// at fault, in the model's order, each with pydantic's type, location, message and input, which
// the frontend's errorDetail() turns into "Invalid origin.lat: field required."

import type { LatLon, PathMode } from './routing';

export interface RouteRequest {
  mode: PathMode;
  origin: LatLon;
  destination: LatLon;
}

/** One of pydantic's errors, as FastAPI sent them in `detail`. */
export interface FieldError {
  type: string;
  loc: (string | number)[];
  msg: string;
  input: unknown;
  ctx?: Record<string, unknown>;
}

/** A request the server would have refused, with its status and detail. */
export class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string | FieldError[],
  ) {
    super(typeof detail === 'string' ? detail : 'Invalid request');
  }
}

/** The route request in `request`'s body, checked; or a RequestError saying what's wrong. */
export async function readRouteRequest(request: Request): Promise<RouteRequest> {
  const body = await readBody(request);
  const problems: FieldError[] = [];
  const at = (...loc: (string | number)[]) => ['body', ...loc];
  if (body === null) {
    problems.push({ type: 'missing', loc: at(), msg: 'Field required', input: null });
  } else if (!isObject(body)) {
    problems.push(notAnObject(at(), body));
  } else {
    const mode = body.mode;
    if (!Object.hasOwn(body, 'mode')) problems.push(missing(at('mode'), body));
    else if (mode !== 'walk' && mode !== 'bike') {
      problems.push({
        type: 'literal_error',
        loc: at('mode'),
        msg: "Input should be 'walk' or 'bike'",
        input: mode,
        ctx: { expected: "'walk' or 'bike'" },
      });
    }
    const origin = latLon(body, 'origin', problems);
    const destination = latLon(body, 'destination', problems);
    if (!problems.length) {
      return { mode: mode as PathMode, origin: origin!, destination: destination! };
    }
  }
  throw new RequestError(422, problems);
}

const BAD_BODY = 'There was an error parsing the body';

/**
 * The request's body as FastAPI handed it to pydantic: null when empty, parsed when its
 * Content-Type is JSON (application/json, or any application/...+json), else its text.
 */
async function readBody(request: Request): Promise<unknown> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length) return null;
  if (!saysJson(request.headers.get('content-type'))) {
    return new TextDecoder().decode(bytes);
  }
  let text: string;
  try {
    // Invalid UTF-8 was an error parsing the body there too. A byte order mark is skipped.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new RequestError(400, BAD_BODY);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    // Python's json module says where the text goes wrong, and how; this says where if the
    // runtime's parser does, and its own words for how.
    const message = (e as Error).message;
    const position = Number(/at position (\d+)/.exec(message)?.[1] ?? 0);
    throw new RequestError(422, [
      {
        type: 'json_invalid',
        loc: ['body', position],
        msg: 'JSON decode error',
        input: {},
        ctx: { error: message.replace(/ in JSON at position.*$/s, '') },
      },
    ]);
  }
}

/** Whether a Content-Type is JSON, as Python's email.message reads one. */
function saysJson(contentType: string | null): boolean {
  if (!contentType) return false;
  const type = contentType.split(';')[0].trim().toLowerCase();
  // Anything but type/subtype counts as text/plain.
  if (type.split('/').length !== 2) return false;
  const [main, sub] = type.split('/');
  return main === 'application' && (sub === 'json' || sub.endsWith('+json'));
}

/** origin or destination: an object with a latitude and longitude, both numbers. */
function latLon(
  body: Record<string, unknown>,
  field: 'origin' | 'destination',
  problems: FieldError[],
): LatLon | null {
  if (!Object.hasOwn(body, field)) {
    problems.push(missing(['body', field], body));
    return null;
  }
  const point = body[field];
  if (!isObject(point)) {
    problems.push(notAnObject(['body', field], point));
    return null;
  }
  const lat = float(point, ['body', field, 'lat'], problems);
  const lon = float(point, ['body', field, 'lon'], problems);
  return { lat, lon };
}

// A number in a string, as pydantic reads one: surrounding space and underscores between
// digits allowed.
const DIGITS = '\\d(?:_?\\d)*';
const NUMBER_TEXT = new RegExp(
  `^[+-]?(?:${DIGITS}(?:\\.(?:${DIGITS})?)?|\\.${DIGITS})(?:[eE][+-]?${DIGITS})?$`,
);
const INFINITE_TEXT = /^[+-]?(?:inf|infinity|nan)$/i;

/**
 * A float field of `point`, as pydantic checks one (in lax mode): a number, a bool (as 0 or
 * 1) or a number in a string. Unlike the server, infinities and NaN are refused, as they are
 * with pydantic's allow_inf_nan=False: there, they made an error of some other kind later on.
 */
function float(point: Record<string, unknown>, loc: string[], problems: FieldError[]): number {
  const field = loc[loc.length - 1];
  if (!Object.hasOwn(point, field)) {
    problems.push(missing(loc, point));
    return NaN;
  }
  const value = point[field];
  let x = NaN;
  if (typeof value === 'number') x = value;
  else if (typeof value === 'boolean') x = Number(value);
  else if (typeof value === 'string') {
    const text = value.trim();
    if (NUMBER_TEXT.test(text)) x = Number(text.replace(/_/g, ''));
    else if (!INFINITE_TEXT.test(text)) {
      problems.push({
        type: 'float_parsing',
        loc,
        msg: 'Input should be a valid number, unable to parse string as a number',
        input: value,
      });
      return NaN;
    }
  } else {
    problems.push({ type: 'float_type', loc, msg: 'Input should be a valid number', input: value });
    return NaN;
  }
  if (!Number.isFinite(x)) {
    const msg = 'Input should be a finite number';
    problems.push({ type: 'finite_number', loc, msg, input: value });
  }
  return x;
}

function missing(loc: (string | number)[], input: unknown): FieldError {
  return { type: 'missing', loc, msg: 'Field required', input };
}

function notAnObject(loc: (string | number)[], input: unknown): FieldError {
  return {
    type: 'model_attributes_type',
    loc,
    msg: 'Input should be a valid dictionary or object to extract fields from',
    input,
  };
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
