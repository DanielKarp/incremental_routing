import type { Feature, FeatureCollection, LineString, Point } from 'geojson';
import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { type Ref, type RefObject, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { LatLon } from '../api';
import { isPale } from '../color';
import type { LinePreview } from '../linePreviews';
import type { Leg, Place } from '../plan/types';
import { formatTime } from '../time';

// MapLibre finds its worker next to its own module by default, which breaks once Vite
// pre-bundles (dev) or bundles (build) it: the map would show only its background colour.
maplibregl.setWorkerUrl(workerUrl);

// OpenFreeMap: free vector tiles from OpenStreetMap data, no API key.
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const BAY_AREA: [number, number] = [-122.05, 37.5];
const ACCENT = '#2563eb';
const PENDING = '#7c3aed';
const START = '#d1495b';
const END = '#15803d';
// Edges that are white for most routes are this instead for pale ones (see isPale).
const PALE_EDGE = '#4b5563';
const SNAPSHOT_TIMEOUT_MS = 10_000;
// Pointing at a row frames its line after this pause, so sweeping down the list doesn't
// throw the map around.
const FOCUS_DELAY_MS = 150;
// How far from the pointer (pixels) a line or stop still counts as under it.
const POINTER_SLOP_PX = 6;
// At most this many line names in the hover label.
const MAX_LABELS = 4;

export interface PreviewStop {
  lat: number;
  lon: number;
  name: string;
  /** For the trip being chosen: the stop's place on it, its time, and whether you can pick it. */
  sequence?: number;
  time?: string;
  choosable?: boolean;
}

/** The trip being chosen: its stops, and the line to draw (following its shape if known). */
export interface TripPreview {
  stops: PreviewStop[];
  line: [number, number][];
  /** The route's colour, hex without '#'. */
  color?: string | null;
}

export interface MapHandle {
  /** A PNG data URL of the map fitted to the whole plan, or null if it can't be captured. */
  snapshot(): Promise<string | null>;
}

interface Props {
  ref?: Ref<MapHandle>;
  /** Where the plan begins (before any legs: the point it is planned from). */
  start: Place | null;
  /** Where the plan ends, once it has legs. */
  end: Place | null;
  /** While choosing a trip: every line in the list, drawn faintly with the stop to catch it. */
  lines: LinePreview[];
  /** The line pointed at in the list: highlighted and framed. */
  focusLine: string | null;
  tripPreview: TripPreview | null;
  /** A walk or bike leg being set up: its picked point and route. */
  pendingPoint: Place | null;
  pendingRoute: [number, number][] | null;
  /** Whether a map click picks a point (shows a crosshair). */
  picking: boolean;
  legs: Leg[];
  onPick: (point: LatLon) => void;
  /** The lines under the pointer on the map, if any. */
  onHoverLines: (keys: string[]) => void;
  onChooseLine: (key: string) => void;
  /** A stop of the trip being chosen was clicked. */
  onChooseStop: (sequence: number) => void;
}

/** What's under the pointer: a stop of the trip being chosen, or some line previews. */
type Hit =
  | { kind: 'stop'; stop: maplibregl.MapGeoJSONFeature }
  | { kind: 'lines'; keys: string[] };

export function MapView(props: Props) {
  const { ref, start, end, lines, focusLine, tripPreview, pendingPoint, pendingRoute } = props;
  const { picking, legs } = props;
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  // Map event handlers are bound once; these keep them looking at the latest props.
  const latest = useRef(props);
  // Sources and layers can only be added once the style has loaded.
  const [styleReady, setStyleReady] = useState(false);
  // The lines under the pointer on the map: highlighted, but not framed (the map stays put).
  const [mapHover, setMapHover] = useState<string[]>([]);

  useEffect(() => {
    latest.current = props;
  });

  useEffect(() => {
    const m = new maplibregl.Map({
      container: container.current!,
      style: MAP_STYLE,
      center: BAY_AREA,
      zoom: 9.5,
      // Keeps the last frame readable, so the plan can be captured for printing.
      canvasContextAttributes: { preserveDrawingBuffer: true },
    });
    m.addControl(new maplibregl.NavigationControl(), 'top-right');
    const tip = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      className: 'map-tip',
      offset: 10,
    });
    let hovered: string[] = [];
    const hover = (keys: string[]) => {
      if (keys.join('\n') === hovered.join('\n')) return;
      hovered = keys;
      setMapHover(keys);
      latest.current.onHoverLines(keys);
    };
    // Asks which line was meant, where several meet.
    let chooser: maplibregl.Popup | null = null;
    const choose = (key: string) => {
      hover([]);
      latest.current.onChooseLine(key);
    };

    m.on('mousemove', (e) => {
      const hit = hitAt(m, e.point);
      m.getCanvas().style.cursor = hit ? 'pointer' : latest.current.picking ? 'crosshair' : '';
      if (!hit) {
        tip.remove();
        hover([]);
        return;
      }
      tip.setLngLat(e.lngLat).setText(hitLabel(hit, latest.current.lines)).addTo(m);
      hover(hit.kind === 'lines' ? hit.keys : []);
    });
    m.on('mouseout', () => {
      tip.remove();
      hover([]);
    });
    m.on('click', (e) => {
      // A click away from an open chooser only closes it: it mustn't move the plan's start.
      if (chooser?.isOpen()) {
        chooser.remove();
        return;
      }
      const hit = hitAt(m, e.point);
      const { lines, onChooseStop, onPick } = latest.current;
      if (!hit) {
        onPick({ lat: e.lngLat.lat, lon: e.lngLat.lng });
        return;
      }
      tip.remove(); // What it labelled is about to change.
      if (hit.kind === 'stop') {
        const { sequence, choosable } = hit.stop.properties;
        if (choosable) onChooseStop(Number(sequence));
      } else if (hit.keys.length === 1) {
        choose(hit.keys[0]);
      } else {
        chooser = showLineChooser(m, e.lngLat, hit.keys, lines, { choose, hover });
      }
    });
    m.on('load', () => {
      addOverlayLayers(m);
      setStyleReady(true);
    });
    map.current = m;
    // Lets browser tests (and the console) reach the map in development builds.
    if (import.meta.env.DEV) Object.assign(window, { __map: m });
    return () => {
      m.remove();
      map.current = null;
      setStyleReady(false);
    };
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      async snapshot() {
        const m = map.current;
        const bounds = planBounds(legs);
        if (!m || !bounds) return null;
        m.fitBounds(bounds, { padding: 40, maxZoom: 15, animate: false });
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, SNAPSHOT_TIMEOUT_MS);
          m.once('idle', () => {
            clearTimeout(timer);
            resolve();
          });
          m.triggerRepaint();
        });
        try {
          return m.getCanvas().toDataURL('image/png');
        } catch {
          return null; // A tainted canvas (cross-origin tiles without CORS) can't be read.
        }
      },
    }),
    [legs],
  );

  useMarker(map, start, START);
  useMarker(map, end, END);
  useMarker(map, pendingPoint, PENDING);

  useEffect(() => {
    if (map.current) map.current.getCanvas().style.cursor = picking ? 'crosshair' : '';
  }, [picking]);

  useEffect(() => {
    const source = map.current?.getSource<maplibregl.GeoJSONSource>('pending');
    if (!styleReady || !source) return;
    const route = pendingRoute && pendingRoute.length > 1 ? [pendingRoute] : [];
    source.setData(lineCollection(route));
  }, [styleReady, pendingRoute]);

  useEffect(() => {
    const source = map.current?.getSource<maplibregl.GeoJSONSource>('legs');
    if (styleReady && source) source.setData(legFeatures(legs));
  }, [styleReady, legs]);

  // Show the whole plan whenever it changes.
  useEffect(() => {
    const bounds = planBounds(legs);
    if (map.current && bounds) map.current.fitBounds(bounds, { padding: 60, maxZoom: 15 });
  }, [legs]);

  useEffect(() => {
    const m = map.current;
    const source = m?.getSource<maplibregl.GeoJSONSource>('trip-preview');
    if (!m || !styleReady || !source) return;
    source.setData(previewFeatures(tripPreview));
    if (tripPreview && tripPreview.line.length > 1) {
      const bounds = new maplibregl.LngLatBounds();
      tripPreview.line.forEach((c) => bounds.extend(c));
      m.fitBounds(bounds, { padding: 60, maxZoom: 14 });
    }
  }, [styleReady, tripPreview]);

  useEffect(() => {
    const source = map.current?.getSource<maplibregl.GeoJSONSource>('line-previews');
    if (styleReady && source) source.setData(lineFeatures(lines));
  }, [styleReady, lines]);

  // Frame every line once their paths arrive (a new list, or a new search).
  const drawn = lines
    .filter((l) => l.line)
    .map((l) => l.key)
    .join('|');
  useEffect(() => {
    const bounds = linesBounds(latest.current.lines);
    if (map.current && bounds) map.current.fitBounds(bounds, { padding: 60, maxZoom: 15 });
  }, [drawn]);

  // Frame the line pointed at in the list; back to all of them when the pointer leaves.
  useEffect(() => {
    const m = map.current;
    const all = latest.current.lines;
    if (!m || !all.length) return;
    const timer = setTimeout(() => {
      const target = focusLine ? all.filter((l) => l.key === focusLine) : all;
      const bounds = linesBounds(target);
      if (bounds) m.fitBounds(bounds, { padding: 60, maxZoom: 15, duration: 500 });
    }, FOCUS_DELAY_MS);
    return () => clearTimeout(timer);
  }, [focusLine]);

  // As a string, so the effect runs only when the lines change.
  const highlight = JSON.stringify(mapHover.length ? mapHover : focusLine ? [focusLine] : []);
  useEffect(() => {
    if (styleReady && map.current) highlightLines(map.current, JSON.parse(highlight));
  }, [styleReady, highlight]);

  return <div ref={container} className="map" data-testid="map" />;
}

function useMarker(map: RefObject<maplibregl.Map | null>, place: Place | null, color: string) {
  const lat = place?.lat;
  const lon = place?.lon;
  useEffect(() => {
    if (!map.current || lat === undefined || lon === undefined) return;
    const marker = new maplibregl.Marker({ color }).setLngLat([lon, lat]).addTo(map.current);
    return () => {
      marker.remove();
    };
  }, [map, lat, lon, color]);
}

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };
const isLine: maplibregl.ExpressionSpecification = ['==', ['geometry-type'], 'LineString'];
const isPoint: maplibregl.ExpressionSpecification = ['==', ['geometry-type'], 'Point'];
const routeColor: maplibregl.ExpressionSpecification = ['coalesce', ['get', 'color'], ACCENT];
const hasEdge: maplibregl.ExpressionSpecification = ['to-boolean', ['get', 'edge']];
// White, or dark for a pale route; the route's colour, or dark for a pale one.
const whiteEdge: maplibregl.ExpressionSpecification = ['coalesce', ['get', 'edge'], '#ffffff'];
const routeEdge: maplibregl.ExpressionSpecification = ['coalesce', ['get', 'edge'], routeColor];
const isChoosable: maplibregl.ExpressionSpecification = ['==', ['get', 'choosable'], true];
const noLines: maplibregl.ExpressionSpecification = ['literal', []];
const round: maplibregl.LineLayerSpecification['layout'] = {
  'line-cap': 'round',
  'line-join': 'round',
};

function addOverlayLayers(m: maplibregl.Map) {
  m.addSource('line-previews', { type: 'geojson', data: EMPTY });
  m.addSource('trip-preview', { type: 'geojson', data: EMPTY });
  m.addSource('legs', { type: 'geojson', data: EMPTY });
  m.addSource('pending', { type: 'geojson', data: EMPTY });

  // The lines you could take: thin and see-through under everything else. The ones pointed at
  // get a white halo, where a planned ride has a dark edge (a pale line gets a thin dark one).
  m.addLayer({
    id: 'line-previews-halo',
    type: 'line',
    source: 'line-previews',
    filter: ['all', isLine, ['in', ['get', 'key'], noLines]],
    layout: round,
    paint: {
      'line-color': whiteEdge,
      'line-width': ['case', hasEdge, 6, 8],
      'line-opacity': 0.9,
    },
  });
  m.addLayer({
    id: 'line-previews',
    type: 'line',
    source: 'line-previews',
    filter: isLine,
    layout: round,
    paint: { 'line-color': routeColor, 'line-width': 3, 'line-opacity': 0.6 },
  });
  // Wider than the drawn line and invisible, so a line is easy to point at.
  m.addLayer({
    id: 'line-previews-hit',
    type: 'line',
    source: 'line-previews',
    filter: isLine,
    paint: { 'line-color': '#000000', 'line-width': 14, 'line-opacity': 0 },
  });
  m.addLayer({
    id: 'line-preview-stops',
    type: 'circle',
    source: 'line-previews',
    filter: isPoint,
    paint: {
      'circle-radius': 4,
      'circle-color': routeColor,
      'circle-stroke-color': whiteEdge,
      'circle-stroke-width': 2,
    },
  });

  // The trip being chosen, in its route's colour, with the stops you can pick.
  m.addLayer({
    id: 'trip-preview-halo',
    type: 'line',
    source: 'trip-preview',
    filter: isLine,
    layout: round,
    paint: {
      'line-color': whiteEdge,
      'line-width': ['case', hasEdge, 6, 8],
      'line-opacity': 0.9,
    },
  });
  m.addLayer({
    id: 'trip-preview-line',
    type: 'line',
    source: 'trip-preview',
    filter: isLine,
    layout: round,
    paint: { 'line-color': routeColor, 'line-width': 4, 'line-opacity': 0.9 },
  });
  m.addLayer({
    id: 'trip-preview-stops',
    type: 'circle',
    source: 'trip-preview',
    filter: isPoint,
    paint: {
      'circle-radius': ['case', isChoosable, 6, 3.5],
      'circle-color': '#ffffff',
      'circle-stroke-color': ['case', isChoosable, routeEdge, '#9ca3af'],
      'circle-stroke-width': 2,
    },
  });

  // A dark edge under each ride, so pale route colours (Caltrain's grey locals, BART's yellow)
  // still stand out from the map.
  m.addLayer({
    id: 'legs-transit-casing',
    type: 'line',
    source: 'legs',
    filter: ['all', isLine, ['==', ['get', 'mode'], 'transit']],
    layout: round,
    paint: { 'line-color': '#1f2937', 'line-width': 8, 'line-opacity': 0.8 },
  });
  m.addLayer({
    id: 'legs-transit',
    type: 'line',
    source: 'legs',
    filter: ['all', isLine, ['==', ['get', 'mode'], 'transit']],
    layout: round,
    paint: { 'line-color': routeColor, 'line-width': 5 },
  });
  m.addLayer({
    id: 'legs-path',
    type: 'line',
    source: 'legs',
    filter: ['all', isLine, ['!=', ['get', 'mode'], 'transit']],
    layout: round,
    paint: {
      'line-color': ['match', ['get', 'mode'], 'bike', '#15803d', '#374151'],
      'line-width': 3,
      'line-dasharray': [1, 2],
    },
  });
  // The plan's start and end, drawn into the map (unlike the markers) so snapshots show them.
  m.addLayer({
    id: 'legs-ends',
    type: 'circle',
    source: 'legs',
    filter: isPoint,
    paint: {
      'circle-radius': 7,
      'circle-color': ['match', ['get', 'end'], 'start', START, END],
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 2,
    },
  });
  m.addLayer({
    id: 'pending-path',
    type: 'line',
    source: 'pending',
    layout: round,
    paint: { 'line-color': PENDING, 'line-width': 4, 'line-dasharray': [1, 1.5] },
  });
}

type NumberValue = maplibregl.DataDrivenPropertyValueSpecification<number>;

/** Brings some line previews forward (or none, for all at their usual strength). */
function highlightLines(m: maplibregl.Map, keys: string[]) {
  const isKey: maplibregl.ExpressionSpecification = ['in', ['get', 'key'], ['literal', keys]];
  // The value for the highlighted lines, for the rest, and for all when none is highlighted.
  const pick = (on: number, off: number, none: number) =>
    (keys.length ? ['case', isKey, on, off] : none) as NumberValue;
  m.setFilter('line-previews-halo', ['all', isLine, isKey]);
  m.setPaintProperty('line-previews', 'line-opacity', pick(1, 0.2, 0.6));
  m.setPaintProperty('line-previews', 'line-width', pick(4, 3, 3));
  m.setLayoutProperty('line-previews', 'line-sort-key', pick(1, 0, 0));
  m.setPaintProperty('line-preview-stops', 'circle-radius', pick(6, 4, 4));
  m.setPaintProperty('line-preview-stops', 'circle-opacity', pick(1, 0.25, 1));
  m.setPaintProperty('line-preview-stops', 'circle-stroke-opacity', pick(1, 0.25, 1));
}

function hitAt(m: maplibregl.Map, point: maplibregl.Point): Hit | null {
  // A line's stop counts as the line.
  const layers = ['trip-preview-stops', 'line-previews-hit', 'line-preview-stops'].filter((id) =>
    m.getLayer(id),
  );
  if (!layers.length) return null;
  const box: [maplibregl.PointLike, maplibregl.PointLike] = [
    [point.x - POINTER_SLOP_PX, point.y - POINTER_SLOP_PX],
    [point.x + POINTER_SLOP_PX, point.y + POINTER_SLOP_PX],
  ];
  const features = m.queryRenderedFeatures(box, { layers });
  const stop = features.find((f) => f.layer.id === 'trip-preview-stops');
  if (stop) return { kind: 'stop', stop };
  const keys = [...new Set(features.map((f) => String(f.properties.key)))];
  return keys.length ? { kind: 'lines', keys } : null;
}

function hitLabel(hit: Hit, lines: LinePreview[]): string {
  if (hit.kind === 'stop') {
    const { name, time, choosable } = hit.stop.properties;
    const when = time ? ` · ${formatTime(String(time))}` : '';
    return `${name}${when}${choosable ? '' : ' (not a choice)'}`;
  }
  const labels = hit.keys.map((k) => lines.find((l) => l.key === k)?.label ?? k);
  const more = labels.length > MAX_LABELS ? `\n+${labels.length - MAX_LABELS} more` : '';
  return labels.slice(0, MAX_LABELS).join('\n') + more;
}

/** Where lines overlap, a click asks which one. Pointing at a choice highlights its line. */
function showLineChooser(
  m: maplibregl.Map,
  at: maplibregl.LngLat,
  keys: string[],
  lines: LinePreview[],
  on: { choose: (key: string) => void; hover: (keys: string[]) => void },
): maplibregl.Popup {
  const popup = new maplibregl.Popup({
    className: 'line-chooser',
    offset: 10,
    closeOnClick: false, // The map's click handler closes it.
  });
  const list = document.createElement('div');
  list.className = 'line-chooser-list';
  const heading = document.createElement('strong');
  heading.textContent = 'Which line?';
  list.append(heading);
  for (const key of keys) {
    const line = lines.find((l) => l.key === key);
    if (!line) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary';
    const swatch = document.createElement('span');
    swatch.className = isPale(line.color) ? 'swatch pale' : 'swatch';
    swatch.style.background = line.color ? `#${line.color}` : ACCENT;
    button.append(swatch, document.createTextNode(line.label));
    button.addEventListener('mouseenter', () => on.hover([key]));
    button.addEventListener('mouseleave', () => on.hover([]));
    button.addEventListener('click', () => {
      popup.remove();
      on.choose(key);
    });
    list.append(button);
  }
  popup.on('close', () => on.hover([]));
  popup.setLngLat(at).setDOMContent(list).addTo(m);
  return popup;
}

/** A transit leg follows its shape when the feed has one, else runs stop to stop. */
function legLine(leg: Leg): [number, number][] | null {
  if (leg.transit) {
    if (leg.transit.geometry && leg.transit.geometry.length > 1) return leg.transit.geometry;
    return leg.transit.stops.map((s) => [s.lon, s.lat]);
  }
  if (leg.path && leg.path.geometry.length > 1) return leg.path.geometry;
  return null;
}

function planBounds(legs: Leg[]): maplibregl.LngLatBounds | null {
  if (!legs.length) return null;
  const bounds = new maplibregl.LngLatBounds();
  for (const leg of legs) {
    bounds.extend([leg.start.place.lon, leg.start.place.lat]);
    bounds.extend([leg.end.place.lon, leg.end.place.lat]);
    legLine(leg)?.forEach((c) => bounds.extend(c));
  }
  return bounds;
}

/** Bounds of the lines' paths and stops, or null when no path has arrived yet. */
function linesBounds(lines: LinePreview[]): maplibregl.LngLatBounds | null {
  const drawn = lines.filter((l) => l.line);
  if (!drawn.length) return null;
  const bounds = new maplibregl.LngLatBounds();
  for (const l of drawn) {
    bounds.extend([l.stop.lon, l.stop.lat]);
    l.line?.forEach((c) => bounds.extend(c));
  }
  return bounds;
}

function legFeatures(legs: Leg[]): FeatureCollection<LineString | Point> {
  const features: Feature<LineString | Point>[] = [];
  for (const leg of legs) {
    const coordinates = legLine(leg);
    if (!coordinates) continue;
    features.push({
      type: 'Feature',
      properties: { mode: leg.mode, color: leg.transit?.color ? `#${leg.transit.color}` : null },
      geometry: { type: 'LineString', coordinates },
    });
  }
  if (legs.length) {
    const first = legs[0].start.place;
    const last = legs[legs.length - 1].end.place;
    features.push(point(first, { end: 'start' }), point(last, { end: 'end' }));
  }
  return { type: 'FeatureCollection', features };
}

function lineFeatures(lines: LinePreview[]): FeatureCollection<LineString | Point> {
  const features: Feature<LineString | Point>[] = [];
  for (const l of lines) {
    const properties = { key: l.key, ...colors(l.color) };
    if (l.line && l.line.length > 1) {
      features.push({
        type: 'Feature',
        properties,
        geometry: { type: 'LineString', coordinates: l.line },
      });
    }
    features.push(point(l.stop, properties));
  }
  return { type: 'FeatureCollection', features };
}

function previewFeatures(preview: TripPreview | null): FeatureCollection<LineString | Point> {
  if (!preview) return { type: 'FeatureCollection', features: [] };
  const color = colors(preview.color);
  return {
    type: 'FeatureCollection',
    features: [
      ...lineCollection(preview.line.length > 1 ? [preview.line] : [], color).features,
      ...preview.stops.map((s) =>
        point(s, {
          name: s.name,
          ...color,
          sequence: s.sequence ?? null,
          time: s.time ?? null,
          choosable: s.choosable ?? false,
        }),
      ),
    ],
  };
}

/** A route colour (hex without '#'), and the edge it needs if pale, as feature properties. */
function colors(hex: string | null | undefined) {
  return { color: hex ? `#${hex}` : null, edge: isPale(hex) ? PALE_EDGE : null };
}

function lineCollection(
  coords: [number, number][][],
  properties: Record<string, unknown> = {},
): FeatureCollection<LineString> {
  return {
    type: 'FeatureCollection',
    features: coords.map((coordinates) => ({
      type: 'Feature',
      properties,
      geometry: { type: 'LineString', coordinates },
    })),
  };
}

function point(
  p: { lat: number; lon: number },
  properties: Record<string, unknown>,
): Feature<Point> {
  return { type: 'Feature', properties, geometry: { type: 'Point', coordinates: [p.lon, p.lat] } };
}
