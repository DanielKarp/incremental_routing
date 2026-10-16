import type { Feature, FeatureCollection, LineString, Point } from 'geojson';
import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { type Ref, type RefObject, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { LatLon } from '../api';
import { isPale } from '../color';
import { type LinePreview, accessText, inListOrder, previewText } from '../linePreviews';
import { type MapMenuItem, SingleClick, isRepeatClick } from '../mapClicks';
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
// How far a menu sits from the point it was opened at (pixels).
const MENU_OFFSET_PX = 10;
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

/** A view of the map to come back to (see MapHandle.saveView). */
export interface SavedView {
  camera: maplibregl.CameraOptions;
  /** How many times you had moved the map yourself when it was saved. */
  moves: number;
}

export interface MapHandle {
  /** A PNG data URL of the map fitted to the whole plan, or null if it can't be captured. */
  snapshot(): Promise<string | null>;
  /**
   * The view to come back to from the stop chooser: the map as it is now, or as it was before
   * the line you rested on in the list was framed, since the trip's framing is much the same.
   */
  saveView(): SavedView | null;
  /** Eases back to a saved view, unless you've moved the map yourself since it was saved. */
  restoreView(view: SavedView): void;
}

interface Props {
  ref?: Ref<MapHandle>;
  /** Where the plan begins (before any legs: the point it is planned from). */
  start: Place | null;
  /** Where the plan ends, once it has legs. */
  end: Place | null;
  /** While choosing a trip: every line in the list, drawn faintly with the stop to catch it. */
  lines: LinePreview[];
  /** The line pointed at in the list: highlighted. */
  focusLine: string | null;
  /** The line the pointer rested on in the list (see CallList): framed. */
  frameLine: string | null;
  tripPreview: TripPreview | null;
  /** A walk or bike leg being set up: its picked point and route. */
  pendingPoint: Place | null;
  pendingRoute: [number, number][] | null;
  /** Whether a click on empty map picks a point (shows a crosshair), rather than open the menu. */
  picking: boolean;
  /** Whether the start pin can be dragged (before the first leg). */
  startDraggable: boolean;
  /** The start pin was dropped there. False if the start can't move now: the pin goes back. */
  onMoveStart: (point: LatLon) => boolean;
  legs: Leg[];
  onPick: (point: LatLon) => void;
  /** The lines under the pointer on the map, if any. */
  onHoverLines: (keys: string[]) => void;
  onChooseLine: (key: string) => void;
  /** A stop of the trip being chosen was clicked. */
  onChooseStop: (sequence: number) => void;
  /**
   * What a right-click offers at the point clicked, as does a click on empty map that picks
   * nothing; none means no menu.
   */
  menu: MapMenuItem[];
  onMenu: (id: string, point: LatLon) => void;
}

/** What's under the pointer: a stop of the trip being chosen, or some line previews. */
type Hit =
  | { kind: 'stop'; stop: maplibregl.MapGeoJSONFeature }
  | { kind: 'lines'; keys: string[] };

export function MapView(props: Props) {
  const { ref, start, end, lines, focusLine, frameLine, tripPreview } = props;
  const { pendingPoint, pendingRoute } = props;
  const { picking, legs } = props;
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  // Map event handlers are bound once; these keep them looking at the latest props.
  const latest = useRef(props);
  // Sources and layers can only be added once the style has loaded.
  const [styleReady, setStyleReady] = useState(false);
  // The lines under the pointer on the map: highlighted, but not framed (the map stays put).
  const [mapHover, setMapHover] = useState<string[]>([]);
  // The view before a line in the list was framed, to go back to when the pointer leaves, and
  // the plan's legs and your moves then.
  const viewBeforeFocus = useRef<{
    view: maplibregl.CameraOptions;
    legs: Leg[];
    moves: number;
  } | null>(null);
  // How many times you've moved the map yourself: dragged, zoomed or turned it. The app's own
  // moves don't count.
  const userMoves = useRef(0);

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
      maxWidth: 'none', // Set in styles.css, where a phone's screen can narrow it.
    });
    let hovered: string[] = [];
    const hover = (keys: string[]) => {
      if (keys.join('\n') === hovered.join('\n')) return;
      hovered = keys;
      setMapHover(keys);
      latest.current.onHoverLines(keys);
    };
    // The menu open on the map, if any: which line (where several meet), or the map's menu.
    let menu: maplibregl.Popup | null = null;
    const choose = (key: string) => {
      hover([]);
      latest.current.onChooseLine(key);
    };
    // Escape closes an open menu and does nothing else: the key is marked as used, so the
    // summary and the panel leave it alone (see App). It's heard first, before the page's own
    // fields, so it doesn't clear Filter lines as well when that has focus (see NextLeg).
    const closeOnEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !menu?.isOpen()) return;
      menu.remove();
      e.preventDefault();
    };
    document.addEventListener('keydown', closeOnEscape, true);
    /** Opens the map's menu at a point, if it offers anything. */
    const openMenu = (at: maplibregl.LngLat): boolean => {
      const items = latest.current.menu;
      if (!items.length) return false;
      tip.remove();
      hover([]);
      menu?.remove();
      const point = { lat: at.lat, lon: at.lng };
      menu = showMenu(
        m,
        at,
        items.map((item) => ({
          content: [item.label],
          onChoose: () => latest.current.onMenu(item.id, point),
        })),
      );
      return true;
    };
    // A click on empty map waits to see whether it's half of a double-click, which only zooms.
    const singleClick = new SingleClick();

    m.on('mousemove', (e) => {
      const hit = hitAt(m, e.point);
      m.getCanvas().style.cursor = hit ? 'pointer' : latest.current.picking ? 'crosshair' : '';
      if (!hit) {
        tip.remove();
        hover([]);
        return;
      }
      tip.setLngLat(e.lngLat).setDOMContent(hitLabel(hit, latest.current.lines)).addTo(m);
      hover(hit.kind === 'lines' ? hit.keys : []);
    });
    m.on('mouseout', () => {
      tip.remove();
      hover([]);
    });
    // Only your moves come from an input event.
    m.on('movestart', (e) => {
      if (e.originalEvent) userMoves.current++;
    });
    m.on('click', (e) => {
      singleClick.cancel(); // The newest click counts.
      // A click away from an open menu only closes it: it mustn't move the plan's start.
      if (menu?.isOpen()) {
        menu.remove();
        return;
      }
      // The second click of a double-click only zooms.
      if (isRepeatClick(e.originalEvent)) return;
      const hit = hitAt(m, e.point);
      const { lines, onChooseStop } = latest.current;
      if (!hit) {
        const at = e.lngLat;
        singleClick.wait(() => {
          const { picking, onPick } = latest.current;
          if (picking) onPick({ lat: at.lat, lon: at.lng });
          else openMenu(at);
        });
        return;
      }
      tip.remove(); // What it labelled is about to change.
      if (hit.kind === 'stop') {
        const { sequence, choosable } = hit.stop.properties;
        if (choosable) onChooseStop(Number(sequence));
      } else if (hit.keys.length === 1) {
        choose(hit.keys[0]);
      } else {
        menu = showLineChooser(m, e.lngLat, hit.keys, lines, { choose, hover });
      }
    });
    m.on('dblclick', () => singleClick.cancel());
    // A touch soon after a tap is a double tap, which zooms (touch screens send no dblclick
    // for it), or the start of some other gesture.
    m.on('touchstart', () => singleClick.cancel());
    m.on('contextmenu', (e) => {
      singleClick.cancel();
      // No browser menu on top of ours.
      if (openMenu(e.lngLat)) e.originalEvent.preventDefault();
    });
    m.on('load', () => {
      addOverlayLayers(m);
      setStyleReady(true);
    });
    map.current = m;
    // Lets browser tests (and the console) reach the map in development builds.
    if (import.meta.env.DEV) Object.assign(window, { __map: m });
    return () => {
      document.removeEventListener('keydown', closeOnEscape, true);
      singleClick.cancel();
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
      saveView() {
        const m = map.current;
        if (!m) return null;
        const framed = viewBeforeFocus.current;
        const moves = userMoves.current;
        return { camera: framed && framed.moves === moves ? framed.view : cameraOf(m), moves };
      },
      restoreView({ camera, moves }) {
        const m = map.current;
        if (m && moves === userMoves.current) m.easeTo({ ...camera, duration: 500 });
      },
    }),
    [legs],
  );

  useMarker(map, start, START, {
    enabled: props.startDraggable,
    title: 'Drag to move the start',
    onDrop: (point) => latest.current.onMoveStart(point),
  });
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

  // Frame the line the pointer rested on in the list, and go back to the earlier view when
  // the pointer leaves the list. Lines merely passed over, or scrolled past, are highlighted
  // but not framed. The map doesn't move when a list loads: that happens after every change.
  // A line's path can arrive after the pointer has rested on its row; it's framed then.
  const framable = !!frameLine && lines.some((l) => l.key === frameLine && l.line);
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const { lines: all, legs: now, tripPreview: trip } = latest.current;
    const bounds = frameLine && linesBounds(all.filter((l) => l.key === frameLine));
    if (bounds) {
      viewBeforeFocus.current ??= { view: cameraOf(m), legs: now, moves: userMoves.current };
      m.fitBounds(bounds, { padding: 60, maxZoom: 15, duration: 500 });
    } else if (!frameLine && viewBeforeFocus.current) {
      // Not when a trip was just chosen, or the plan changed: the map shows those instead.
      if (!trip && viewBeforeFocus.current.legs === now) {
        m.easeTo({ ...viewBeforeFocus.current.view, duration: 500 });
      }
      viewBeforeFocus.current = null;
    }
  }, [frameLine, framable]);

  // As a string, so the effect runs only when the lines change. Lines pointed at on the map
  // may have been filtered out of the list since.
  const pointed = mapHover.filter((key) => lines.some((l) => l.key === key));
  const highlight = JSON.stringify(pointed.length ? pointed : focusLine ? [focusLine] : []);
  useEffect(() => {
    if (styleReady && map.current) highlightLines(map.current, JSON.parse(highlight));
  }, [styleReady, highlight]);

  return <div ref={container} className="map" data-testid="map" />;
}

/** Where the map is looking now. */
function cameraOf(m: maplibregl.Map): maplibregl.CameraOptions {
  return { center: m.getCenter(), zoom: m.getZoom(), bearing: m.getBearing(), pitch: m.getPitch() };
}

/** A pin you can drag while `drag.enabled`: where it's dropped goes to `drag.onDrop`. */
interface PinDrag {
  enabled: boolean;
  /** Shown on the pin while it can be dragged. */
  title: string;
  /** False if the place can't move now: the pin goes back. */
  onDrop: (point: LatLon) => boolean;
}

function useMarker(
  map: RefObject<maplibregl.Map | null>,
  place: Place | null,
  color: string,
  drag?: PinDrag,
) {
  const at: [number, number] | null = place ? [place.lon, place.lat] : null;
  const shown = at !== null;
  // The pin moves with the place rather than being made again, so it keeps keyboard focus
  // while it's dragged with the arrow keys.
  const position = useRef(at);
  const marker = useRef<maplibregl.Marker | null>(null);
  const onDrop = useRef(drag?.onDrop);
  useEffect(() => {
    position.current = at;
    onDrop.current = drag?.onDrop;
  });
  useEffect(() => {
    if (!map.current || !position.current) return;
    const pin = new maplibregl.Marker({ color }).setLngLat(position.current).addTo(map.current);
    // A drag with the mouse or a finger ends here, and so does one with the arrow keys.
    pin.on('dragend', () => {
      const { lat, lng } = pin.getLngLat().wrap();
      if (!onDrop.current?.({ lat, lon: lng }) && position.current) {
        pin.setLngLat(position.current);
      }
    });
    marker.current = pin;
    return () => {
      pin.remove();
      marker.current = null;
    };
  }, [map, shown, color]);
  const lat = place?.lat;
  const lon = place?.lon;
  useEffect(() => {
    if (lat !== undefined && lon !== undefined) marker.current?.setLngLat([lon, lat]);
  }, [lat, lon]);
  const title = drag?.enabled ? drag.title : null;
  useEffect(() => {
    const pin = marker.current;
    if (!pin) return;
    pin.setDraggable(title !== null);
    if (title !== null) pin.getElement().title = title;
    else pin.getElement().removeAttribute('title');
  }, [title, shown]);
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

/** What the label on the map says about what's under the pointer. */
function hitLabel(hit: Hit, lines: LinePreview[]): Node {
  if (hit.kind === 'stop') {
    const { name, time, choosable } = hit.stop.properties;
    const when = time ? ` · ${formatTime(String(time))}` : '';
    return document.createTextNode(`${name}${when}${choosable ? '' : ' (not a choice)'}`);
  }
  // In the list's order, each with its time, stop and the way there.
  const found = inListOrder(hit.keys, lines);
  const label = document.createDocumentFragment();
  for (const line of found.slice(0, MAX_LABELS)) {
    label.append(element('div', 'map-tip-line', lineSummary(line), ...noteOf(line)));
  }
  if (found.length > MAX_LABELS) {
    label.append(element('div', 'map-tip-more', `+${found.length - MAX_LABELS} more`));
  }
  if (found.length === 1) {
    const time = formatTime(found[0].time);
    label.append(element('div', 'map-tip-action', `Click to take the ${time}`));
  }
  return label;
}

function element(tag: string, className: string, ...content: (string | Node)[]): HTMLElement {
  const el = document.createElement(tag);
  el.className = className;
  el.append(...content);
  return el;
}

/**
 * A line on one line: "9:02 AM · 38R 48th Avenue · Beale St & Mission St, 2 min walk". Too
 * long for the space, the route and the stop are cut short, the stop first.
 */
function lineSummary(line: LinePreview): HTMLElement {
  return element(
    'span',
    'line-summary',
    element('strong', 'line-summary-time', formatTime(line.time)),
    '·',
    element('span', 'line-summary-name', line.label),
    '·',
    element('span', 'line-summary-stop', `${line.stop.name},`),
    element('span', 'line-summary-access', accessText(line)),
  );
}

/** A line's transfer note, if it has one, in the colour of its level. */
function noteOf(line: LinePreview): HTMLElement[] {
  return line.note ? [element('span', `line-note issue-${line.note.level}`, line.note.text)] : [];
}

interface MenuEntry {
  content: (string | Node)[];
  /** Shown when the pointer rests on the entry: all of it, if it's cut short. */
  title?: string;
  onChoose: () => void;
  /** The pointer moved onto the entry (true) or off it. */
  onPoint?: (pointing: boolean) => void;
}

interface MenuOptions {
  heading?: string;
  /** Added to the menu's class, for its own styles. */
  className?: string;
  onClose?: () => void;
}

/** A small menu at a point on the map. Choosing an entry closes it. */
function showMenu(
  m: maplibregl.Map,
  at: maplibregl.LngLat,
  entries: MenuEntry[],
  { heading, className, onClose }: MenuOptions = {},
): maplibregl.Popup {
  const popup = new maplibregl.Popup({
    className: className ? `map-menu ${className}` : 'map-menu',
    offset: MENU_OFFSET_PX,
    closeButton: false,
    closeOnClick: false, // The map's click handler closes it.
    maxWidth: 'none', // Set in styles.css, where a phone's screen can narrow it.
  });
  const content = document.createElement('div');
  const list = document.createElement('div');
  list.className = 'map-menu-list';
  list.setAttribute('role', 'menu');
  // The heading stays put while a long list scrolls.
  if (heading) {
    content.append(element('strong', 'map-menu-heading', heading));
    list.setAttribute('aria-label', heading);
  }
  for (const entry of entries) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary';
    button.setAttribute('role', 'menuitem');
    if (entry.title) button.title = entry.title;
    button.append(...entry.content);
    if (entry.onPoint) {
      button.addEventListener('mouseenter', () => entry.onPoint?.(true));
      button.addEventListener('mouseleave', () => entry.onPoint?.(false));
    }
    button.addEventListener('click', () => {
      popup.remove();
      entry.onChoose();
    });
    list.append(button);
  }
  content.append(list);
  if (onClose) popup.on('close', onClose);
  popup.setLngLat(at).setDOMContent(content).addTo(m);
  // The menu goes above or below the point, wherever it fits. On a short map (a phone's) it
  // might fit neither way, so then its list is shortened to fit the larger side (but not to
  // less than two entries or so), and scrolls.
  const y = m.project(at).y;
  const around = popup.getElement().offsetHeight - list.offsetHeight + MENU_OFFSET_PX;
  const room = Math.floor(Math.max(y, m.getContainer().clientHeight - y) - around);
  if (list.offsetHeight > room) {
    list.style.maxHeight = `${Math.max(room, 60)}px`;
    popup.setLngLat(at); // Placed again for its new height.
  }
  return popup;
}

/**
 * Where lines overlap, a click asks which one, in the list's order: by time. Each choice says
 * which trip it takes, from which stop, and any transfer note. Pointing at a choice highlights
 * its line.
 */
function showLineChooser(
  m: maplibregl.Map,
  at: maplibregl.LngLat,
  keys: string[],
  lines: LinePreview[],
  on: { choose: (key: string) => void; hover: (keys: string[]) => void },
): maplibregl.Popup {
  const entries = inListOrder(keys, lines).map((line): MenuEntry => {
    const swatch = document.createElement('span');
    swatch.className = isPale(line.color) ? 'swatch pale' : 'swatch';
    swatch.style.background = line.color ? `#${line.color}` : ACCENT;
    return {
      content: [swatch, element('span', 'line-choice', lineSummary(line), ...noteOf(line))],
      title: [previewText(line), line.note?.text].filter(Boolean).join('\n'),
      onChoose: () => on.choose(line.key),
      onPoint: (pointing) => on.hover(pointing ? [line.key] : []),
    };
  });
  return showMenu(m, at, entries, {
    heading: 'Which line?',
    className: 'line-chooser',
    onClose: () => on.hover([]),
  });
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
