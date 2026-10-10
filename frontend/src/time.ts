// All times are shown in the planning region's zone, whatever the browser's own zone is.
export const PLAN_TZ = 'America/Los_Angeles';

const timeFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: PLAN_TZ,
  hour: 'numeric',
  minute: '2-digit',
});

export function formatTime(iso: string): string {
  return timeFormat.format(new Date(iso));
}

export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** The current time in PLAN_TZ as a datetime-local input value ("2026-10-12T07:50"). */
export function nowLocalInput(now: Date = new Date()): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: PLAN_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
