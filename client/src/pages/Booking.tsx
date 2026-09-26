import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api';
import { fmtHour12, fmtTime, money, WEEKDAYS, WEEKDAYS_SHORT } from '../format';
import type { Booking as BookingType, Provider, Service, Slot } from '../types';
import SlotPicker from '../components/SlotPicker';
import { RatingBadge, Stars } from '../components/Stars';

interface Review {
  rating: number;
  comment: string;
  created_at: string;
  customer_name: string;
  service_name: string;
}

export default function Booking() {
  const navigate = useNavigate();

  const [provider, setProvider] = useState<Provider | null>(null);
  const [service, setService] = useState<Service | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [form, setForm] = useState({ name: '', email: '', phone: '', notes: '' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [reviews, setReviews] = useState<Review[]>([]);

  useEffect(() => {
    api.get<Provider>('/api/provider').then((p) => {
      setProvider(p);
      if (p.services?.length === 1) setService(p.services[0]);
    });
    api.get<Review[]>('/api/provider/reviews').then(setReviews).catch(() => setReviews([]));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!provider || !service || !slot) return;
    setSubmitting(true);
    setError('');
    try {
      const booking = await api.post<BookingType>('/api/bookings', {
        serviceId: service.id,
        start: slot.start,
        customer: { name: form.name, email: form.email, phone: form.phone || undefined },
        notes: form.notes || undefined,
      });
      navigate('/confirmation', { state: { booking } });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError(err.message + ' The slot list has been refreshed.');
        setSlot(null);
        setRefreshKey((k) => k + 1);
      } else {
        setError(err instanceof Error ? err.message : 'Booking failed');
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (!provider) return <div className="container"><p className="muted">Loading…</p></div>;

  return (
    <div className="container">
      <section className="hero">
        <h1>
          Book an appointment with<br />
          <span className="hero-accent">{provider.name}</span>
        </h1>
        <p className="hero-sub">Saleh Kids Care Clinic - R Block Market Wapda Town Phase 2 Multan </p>
        <p className="hero-sub">COntact Number 03035155688 </p>
      </section>

      <div className="detail-layout">
        {/* ---- doctor card ---- */}
        <aside className="detail-side">
          <div className="provider-avatar lg" style={{ background: provider.color }}>{provider.emoji}</div>
          <h1>{provider.name}</h1>
          <p className="provider-title">{provider.title} <RatingBadge avg={provider.avg_rating} count={provider.review_count} /></p>
          <div className="provider-bio rich-text" dangerouslySetInnerHTML={{ __html: provider.bio }} />
          <div className="hours-box">
            <h3>Weekly hours</h3>
            {WEEKDAYS.map((_day, wd) => {
              const windows = (provider.schedules ?? []).filter((s) => s.weekday === wd);
              return (
                <div key={wd} className="hours-row">
                  <span>{WEEKDAYS_SHORT[wd]}</span>
                  <span>
                    {windows.length
                      ? windows.map((w) => `${fmtHour12(w.start_time)}–${fmtHour12(w.end_time)}`).join(', ')
                      : <em className="muted">Closed</em>}
                  </span>
                </div>
              );
            })}
          </div>
        </aside>

        {/* ---- booking flow ---- */}
        <section className="detail-main">
          <div className="step-card">
            <h2><span className="step-num">1</span> Choose a service</h2>
            {(provider.services ?? []).length === 0 && (
              <p className="muted">No services published yet — check back soon.</p>
            )}
            <div className="service-list">
              {(provider.services ?? []).map((s) => (
                <button
                  key={s.id}
                  className={`service-option ${service?.id === s.id ? 'selected' : ''}`}
                  onClick={() => setService(s)}
                >
                  <div>
                    <strong>{s.name}</strong>
                    <div className="rich-text small" dangerouslySetInnerHTML={{ __html: s.description }} />
                  </div>
                  <div className="service-meta">
                    <span className="service-price">{money(s.price_cents)}</span>
                    <span className="service-duration">{s.duration_min} min</span>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {service && (
            <div className="step-card">
              <h2><span className="step-num">2</span> Pick a date &amp; time</h2>
              <SlotPicker
                provider={provider}
                serviceId={service.id}
                slot={slot}
                onSelect={setSlot}
                refreshKey={refreshKey}
              />
            </div>
          )}

          {service && slot && (
            <div className="step-card">
              <h2><span className="step-num">3</span> Your details</h2>
              <div className="summary-bar">
                {service.name} · {new Date(slot.start).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
                {' '}at {fmtTime(slot.start)} · {money(service.price_cents)}
              </div>
              <form onSubmit={submit} className="booking-form">
                <div className="form-row">
                  <label>
                    Full name *
                    <input className="input" required minLength={2} value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })} />
                  </label>
                  <label>
                    Email *
                    <input className="input" type="email" required value={form.email}
                      onChange={(e) => setForm({ ...form, email: e.target.value })} />
                  </label>
                </div>
                <div className="form-row">
                  <label>
                    Phone
                    <input className="input" value={form.phone}
                      onChange={(e) => setForm({ ...form, phone: e.target.value })} />
                  </label>
                  <label>
                    Notes for the doctor
                    <input className="input" value={form.notes}
                      onChange={(e) => setForm({ ...form, notes: e.target.value })} />
                  </label>
                </div>
                {error && <p className="error-box">{error}</p>}
                <button className="btn btn-primary btn-lg" disabled={submitting}>
                  {submitting ? 'Booking…' : `Confirm booking — ${money(service.price_cents)}`}
                </button>
              </form>
            </div>
          )}

          {reviews.length > 0 && (
            <div className="step-card">
              <h2>⭐ Reviews</h2>
              <div className="review-list">
                {reviews.map((r, i) => (
                  <div key={i} className="review-item">
                    <div className="review-item-head">
                      <Stars value={r.rating} />
                      <strong>{r.customer_name}</strong>
                      <span className="muted small">
                        {r.service_name} · {new Date(r.created_at).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })}
                      </span>
                    </div>
                    {r.comment && <p className="review-comment">{r.comment}</p>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
