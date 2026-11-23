import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TimetableState } from '../api';
import { TimetableStatusView, progressText } from './TimetableStatus';

const render = (state: TimetableState) =>
  renderToStaticMarkup(<TimetableStatusView state={state} onRetry={() => {}} />);

describe('the timetable status', () => {
  it('says the timetable is loading, and how much of it has come', () => {
    expect(render({ status: 'loading', progress: null })).toBe(
      '<p class="muted" role="status">Loading the timetable… </p>',
    );
    const progress = { loaded: 3_100_000, total: 8_622_861 };
    expect(render({ status: 'loading', progress })).toContain(
      'Loading the timetable… <span aria-hidden="true">3.1 of 8.6 MB</span>',
    );
  });

  it('says why it failed, with Try again', () => {
    const html = render({ status: 'failed', reason: 'No timetable at /data/manifest.json.' });
    expect(html).toContain(
      '<p class="error grow" role="alert">Couldn&#x27;t load the timetable: ' +
        'No timetable at /data/manifest.json.</p>',
    );
    expect(html).toContain('<button type="button" class="secondary">Try again</button>');
  });

  it('goes once the timetable is in', () => {
    expect(render({ status: 'ready' })).toBe('');
  });
});

describe('progressText', () => {
  it('counts in megabytes, to a tenth', () => {
    expect(progressText({ loaded: 0, total: 8_622_861 })).toBe('0.0 of 8.6 MB');
    expect(progressText({ loaded: 8_622_861, total: 8_622_861 })).toBe('8.6 of 8.6 MB');
    // Never more than all of it.
    expect(progressText({ loaded: 9_000_000, total: 8_622_861 })).toBe('8.6 of 8.6 MB');
  });
});
