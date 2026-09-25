import { useEffect, useState } from 'react';
import { api } from '../api';
import { fmtTime, todayStr } from '../format';

interface DayBooking {
  id: number;
  code: string;
  starts_at: string;
  ends_at: string;
  status: string;
  customer_name: string;
  service_name: string;
}

const HOUR_START = 6;
const HOUR_END = 23;
const PX_PER_HOUR = 56;

export default function DayView() {
  const [date, setDate] = useState(todayStr());
  const [bookings, setBookings] = useState<DayBooking[]>([]);

  useEffect(() => {
    api.get<DayBooking[]>(`/api/admin/day?date=${date}`).then(setBookings).catch(() => setBookings([]));
  }, [date]);

  const top = (iso: string) => {
    const d = new Date(iso);
    return (d.getHours() + d.getMinutes() / 60 - HOUR_START) * PX_PER_HOUR;
  };
  const height = (b: DayBooking) =>
    ((new Date(b.ends_at).getTime() - new Date(b.starts_at).getTime()) / 3600000) * PX_PER_HOUR;

  return (
    <div>
      <div className="dayview-head">
        <h1 className="admin-title">Day view</h1>
        <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>

      <div className="panel timeline-panel">
        <div className="timeline" style={{ gridTemplateColumns: '64px 1fr' }}>
          {/* header row */}
          <div className="tl-corner" />
          <div className="tl-provider-head">
            <span className="tl-provider-name">Appointments</span>
          </div>
          {/* hours gutter */}
          <div className="tl-hours" style={{ height: (HOUR_END - HOUR_START) * PX_PER_HOUR }}>
            {Array.from({ length: HOUR_END - HOUR_START }, (_, i) => (
              <div key={i} className="tl-hour" style={{ height: PX_PER_HOUR }}>
                {String(HOUR_START + i).padStart(2, '0')}:00
              </div>
            ))}
          </div>
          {/* single column */}
          <div className="tl-col" style={{ height: (HOUR_END - HOUR_START) * PX_PER_HOUR }}>
            {Array.from({ length: HOUR_END - HOUR_START }, (_, i) => (
              <div key={i} className="tl-gridline" style={{ top: i * PX_PER_HOUR }} />
            ))}
            {bookings.map((b) => (
              <div
                key={b.id}
                className="tl-booking"
                style={{ top: top(b.starts_at), height: Math.max(height(b) - 2, 20) }}
                title={`${b.code} — ${b.customer_name}`}
              >
                <strong>{fmtTime(b.starts_at)}</strong> {b.customer_name}
                <div className="tl-service">{b.service_name}</div>
              </div>
            ))}
          </div>
        </div>
        {bookings.length === 0 && <p className="muted center pad">No bookings on this day.</p>}
      </div>
    </div>
  );
}
