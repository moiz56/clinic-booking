export const money = (cents: number) => `Rs ${(cents / 100).toLocaleString('en-PK')}`;

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const fmtTime = (iso: string | Date) =>
  new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });

export const fmtDate = (iso: string | Date) =>
  new Date(iso).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

export const fmtDateTime = (iso: string | Date) => `${fmtDate(iso)}, ${fmtTime(iso)}`;

/** Local YYYY-MM-DD (never UTC-shifted) */
export const toDateStr = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const todayStr = () => toDateStr(new Date());

export const addDays = (d: Date, n: number) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};

/** "HH:MM[:SS]" -> "HH:MM" */
export const hhmm = (t: string) => t.slice(0, 5);

/** "HH:MM[:SS]" -> "7pm" / "7:30pm" (compact 12-hour, no leading zero, lowercase am/pm) */
export function fmtHour12(t: string): string {
  const [h, m] = t.split(':').map(Number);
  const period = h >= 12 ? 'pm' : 'am';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hour12}${period}` : `${hour12}:${String(m).padStart(2, '0')}${period}`;
}

export const STATUS_LABELS: Record<string, string> = {
  confirmed: 'Confirmed',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_show: 'No-show',
};
