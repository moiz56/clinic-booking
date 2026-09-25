import { useEffect, useState } from 'react';
import { api } from '../api';
import { fmtDate } from '../format';
import { Stars } from '../components/Stars';

interface AdminReview {
  id: number;
  booking_id: number;
  booking_code: string;
  customer_name: string;
  customer_email: string;
  service_name: string;
  rating: number;
  comment: string;
  hidden: boolean;
  created_at: string;
}

export default function Reviews() {
  const [reviews, setReviews] = useState<AdminReview[]>([]);
  const [busyId, setBusyId] = useState<number | null>(null);

  useEffect(() => {
    api.get<AdminReview[]>('/api/admin/reviews').then(setReviews);
  }, []);

  async function toggle(r: AdminReview) {
    setBusyId(r.id);
    try {
      const updated = await api.patch<AdminReview>(`/api/admin/reviews/${r.id}`, { hidden: !r.hidden });
      setReviews((list) => list.map((x) => (x.id === r.id ? { ...x, hidden: updated.hidden } : x)));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <h1 className="admin-title">Reviews</h1>

      <div className="panel">
        {reviews.length === 0 && <p className="muted">No reviews yet.</p>}
        <table className="table table-stack">
          {reviews.length > 0 && (
            <thead>
              <tr>
                <th>Rating</th><th>Comment</th><th>Customer</th><th>Service</th><th>Booking</th><th>Date</th><th></th>
              </tr>
            </thead>
          )}
          <tbody>
            {reviews.map((r) => (
              <tr key={r.id} className={r.hidden ? 'row-hidden' : ''}>
                <td data-label="Rating"><Stars value={r.rating} /></td>
                <td className="review-cell" data-label="Comment">{r.comment || <span className="muted">—</span>}</td>
                <td data-label="Customer">{r.customer_name}<br /><span className="muted small">{r.customer_email}</span></td>
                <td data-label="Service">{r.service_name}</td>
                <td className="mono" data-label="Booking">{r.booking_code}</td>
                <td className="small" data-label="Date">{fmtDate(r.created_at)}</td>
                <td className="row-actions">
                  <button
                    className={`btn btn-xs ${r.hidden ? 'btn-ghost' : 'btn-danger-ghost'}`}
                    disabled={busyId === r.id}
                    onClick={() => toggle(r)}
                  >
                    {r.hidden ? 'Unhide' : 'Hide'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
