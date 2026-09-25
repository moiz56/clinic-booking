import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { fmtDateTime, fmtTime } from '../format';
import type { Booking, Provider, Slot } from '../types';
import SlotPicker from './SlotPicker';

interface Props {
  booking: Booking;
  /** Email that owns the booking (guest lookup email). */
  email: string;
  onDone: (updated: Booking) => void;
  onClose: () => void;
}

export default function RescheduleDialog({ booking, email, onDone, onClose }: Props) {
  const [provider, setProvider] = useState<Provider | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    api.get<Provider>('/api/provider')
      .then(setProvider)
      .catch(() => setError('Could not load availability'));
  }, []);

  async function confirm() {
    if (!slot) return;
    setBusy(true);
    setError('');
    try {
      const updated = await api.post<Booking>(`/api/bookings/${booking.code}/reschedule`, { email, start: slot.start });
      onDone(updated);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError(err.message + ' The slot list has been refreshed.');
        setSlot(null);
        setRefreshKey((k) => k + 1);
      } else {
        setError(err instanceof Error ? err.message : 'Reschedule failed');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="reschedule-box">
      <div className="panel-head">
        <h2>Pick a new time</h2>
        <button className="btn btn-ghost btn-sm" onClick={onClose}>✕ Close</button>
      </div>
      <p className="muted small">
        Currently: {fmtDateTime(booking.starts_at)} – {fmtTime(booking.ends_at)}
      </p>
      {provider ? (
        <SlotPicker
          provider={provider}
          serviceId={booking.service_id}
          excludeBookingId={booking.id}
          slot={slot}
          onSelect={setSlot}
          refreshKey={refreshKey}
        />
      ) : (
        <p className="muted">Loading…</p>
      )}
      {error && <p className="error-box">{error}</p>}
      <button className="btn btn-primary" disabled={!slot || busy} onClick={confirm}>
        {busy ? 'Rescheduling…' : slot ? `Move to ${fmtDateTime(slot.start)}` : 'Select a new slot'}
      </button>
    </div>
  );
}
