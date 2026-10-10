import { useEffect, useMemo, useState } from 'react';
import { api, type FeedInfo, type Health, type LatLon, type TransitCall } from './api';
import { CallList } from './components/CallList';
import { MapView } from './components/MapView';
import { nowLocalInput } from './time';

type Direction = 'departures' | 'arrivals';

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [feeds, setFeeds] = useState<FeedInfo[]>([]);
  const [anchor, setAnchor] = useState<LatLon | null>(null);
  const [time, setTime] = useState(nowLocalInput);
  const [direction, setDirection] = useState<Direction>('departures');
  const [calls, setCalls] = useState<TransitCall[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .health()
      .then((h) => {
        setHealth(h);
        if (h.gtfs_loaded) return api.feeds().then(setFeeds);
      })
      .catch((e: Error) => setError(`Backend unreachable: ${e.message}`));
  }, []);

  const day = time.slice(0, 10);
  const uncoveredFeeds = feeds.filter(
    (f) => (f.end_date && f.end_date < day) || (f.start_date && f.start_date > day),
  );
  const stops = useMemo(() => {
    const byId = new Map((calls ?? []).map((c) => [c.stop.stop_id, c.stop]));
    return [...byId.values()];
  }, [calls]);

  async function search() {
    if (!anchor) return;
    setLoading(true);
    setError(null);
    try {
      const query = { point: anchor, time };
      setCalls(await (direction === 'departures' ? api.departures(query) : api.arrivals(query)));
    } catch (e) {
      setError((e as Error).message);
      setCalls(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="app">
      <aside className="panel">
        <h1>Incremental Routing</h1>

        {health && !health.gtfs_loaded && (
          <p className="warning">
            No transit data loaded. Run <code>uv run ir-load-gtfs</code> in <code>backend/</code>.
          </p>
        )}
        {uncoveredFeeds.length > 0 && (
          <p className="warning">
            Schedule data doesn't cover {day} for:{' '}
            {uncoveredFeeds.map((f) => f.feed_id).join(', ')}. Re-run <code>ir-load-gtfs</code>.
          </p>
        )}

        <section>
          <h2>Starting point</h2>
          <p className={anchor ? '' : 'muted'}>
            {anchor
              ? `${anchor.lat.toFixed(5)}, ${anchor.lon.toFixed(5)}`
              : 'Click the map to choose a point.'}
          </p>
          <label className="field">
            Time
            <input type="datetime-local" value={time} onChange={(e) => setTime(e.target.value)} />
          </label>
          <div className="segmented" role="radiogroup" aria-label="Direction">
            {(['departures', 'arrivals'] as const).map((d) => (
              <label key={d}>
                <input
                  type="radio"
                  name="direction"
                  checked={direction === d}
                  onChange={() => setDirection(d)}
                />
                {d === 'departures' ? 'Departing after' : 'Arriving before'}
              </label>
            ))}
          </div>
          <button type="button" disabled={!anchor || loading} onClick={search}>
            {loading ? 'Searching…' : 'Find transit'}
          </button>
        </section>

        {error && <p className="error">{error}</p>}
        {calls && (
          <section>
            <h2>{direction === 'departures' ? 'Departures' : 'Arrivals'}</h2>
            <CallList calls={calls} direction={direction} />
          </section>
        )}

        <footer className="muted">
          Routing: {health?.routing_provider ?? '…'} · Map © OpenStreetMap contributors,
          OpenFreeMap
        </footer>
      </aside>
      <MapView anchor={anchor} stops={stops} onPick={setAnchor} />
    </div>
  );
}
