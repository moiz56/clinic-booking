import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { fmtDateTime, fmtTime, money, STATUS_LABELS } from '../format';
import type { Booking } from '../types';
import RescheduleDialog from '../components/RescheduleDialog';
import ReviewForm from '../components/ReviewForm';

export default function Manage() {
  const [params] = useSearchParams();
  const [code, setCode] = useState(params.get('code') ?? '');
  const [email, setEmail] = useState(params.get('email') ?? '');
  const [booking, setBooking] = useState<Booking | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [rescheduling, setRescheduling] = useState(false);

  async function lookup(e?: React.FormEvent) {
    e?.preventDefault();
    setError('');
    setBusy(true);
    try {
      setBooking(await api.get<Booking>(
        `/api/bookings/lookup?code=${encodeURIComponent(code.trim())}&email=${encodeURIComponent(email.trim())}`
      ));
    } catch (err) {
      setBooking(null);
      setError(err instanceof ApiError ? err.message : 'Lookup failed');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (params.get('code') && params.get('email')) void lookup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function cancel() {
    if (!booking) return;
    if (!window.confirm('Cancel this booking? The slot will be released.')) return;
    setBusy(true);
    setError('');
    try {
      setBooking(await api.post<Booking>(`/api/bookings/${booking.code}/cancel`, { email }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Cancellation failed');
    } finally {
      setBusy(false);
    }
  }

  const upcoming = booking && booking.status === 'confirmed' && new Date(booking.starts_at) > new Date();
  const canReschedule =
    upcoming &&
    new Date() <
      new Date(new Date(booking!.starts_at).getTime() - (booking!.reschedule_cutoff_min ?? 120) * 60000);

  return (
    <div className="container narrow-page">
      <h1>Manage your booking</h1>
      <p className="muted">Enter your booking code and the email you booked with.</p>

      <form onSubmit={lookup} className="lookup-form">
        <input className="input" placeholder="Booking code (e.g. BK-7F3K2A)" required
          value={code} onChange={(e) => setCode(e.target.value)} />
        <input className="input" type="email" placeholder="Email used for booking" required
          value={email} onChange={(e) => setEmail(e.target.value)} />
        <button className="btn btn-primary" disabled={busy}>{busy ? 'Looking up…' : 'Find booking'}</button>
      </form>

      {error && <p className="error-box">{error}</p>}

      {booking && (
        <div className="manage-card">
          <div className="manage-head">
            <div className="provider-avatar" style={{ background: booking.color }}>{booking.emoji}</div>
            <div>
              <h2>{booking.provider_name}</h2>
              <p className="muted">{booking.service_name}</p>
            </div>
            <span className={`badge badge-${booking.status}`}>{STATUS_LABELS[booking.status]}</span>
          </div>
          <div className="confirm-details">
            <div><span>Code</span><strong>{booking.code}</strong></div>
            <div><span>When</span><strong>{fmtDateTime(booking.starts_at)} – {fmtTime(booking.ends_at)}</strong></div>
            <div><span>Booked by</span><strong>{booking.customer_name}</strong></div>
            <div><span>Price</span><strong>{money(booking.price_cents)}</strong></div>
            {booking.notes && <div><span>Notes</span><strong>{booking.notes}</strong></div>}
          </div>
          {upcoming && (
            <div className="btn-row">
              {canReschedule && (
                <button className="btn btn-ghost" onClick={() => setRescheduling((r) => !r)} disabled={busy}>
                  🔁 Reschedule
                </button>
              )}
              <button className="btn btn-danger" onClick={cancel} disabled={busy}>
                {busy ? 'Cancelling…' : 'Cancel booking'}
              </button>
            </div>
          )}
          {rescheduling && booking && (
            <RescheduleDialog
              booking={booking}
              email={email}
              onDone={(b) => {
                setBooking(b);
                setRescheduling(false);
              }}
              onClose={() => setRescheduling(false)}
            />
          )}
          {booking.status === 'completed' && !booking.reviewed && (
            <ReviewForm
              onSubmit={async (rating, comment) => {
                await api.post(`/api/bookings/${booking.code}/review`, { email, rating, comment });
                setBooking({ ...booking, reviewed: true });
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}
