# 🏗️ BookIt — Architecture

How the pieces fit together, from the browser down to the Postgres exclusion
constraint that makes double-booking impossible.

BookIt is a **single-doctor** appointment booking site: one provider, guest-only
booking (no customer accounts), no payments or coupons. Everything below
reflects that scope.

---

## 1. The big picture

BookIt is an npm-workspaces monorepo with two deployable pieces that talk over a
small JSON/REST API:

```
┌──────────────────────────┐        HTTP / JSON        ┌───────────────────────────┐
│  client  (React + Vite)  │  ───────────────────────▶ │  server  (Express + TS)   │
│                          │                            │                           │
│  • booking site (guest)  │      /api/*  (public)      │  • routes  (public/admin) │
│  • admin panel (JWT)     │ ◀───────────────────────── │  • services (slots,       │
│                          │      /api/admin/* (JWT)    │     booking, notify)      │
└──────────────────────────┘                            └────────────┬──────────────┘
                                                                      │  pg (SQL)
                                                                      ▼
                                                         ┌───────────────────────────┐
                                                         │  PostgreSQL               │
                                                         │  • GiST exclusion         │
                                                         │    constraints            │
                                                         │  • advisory locks         │
                                                         └───────────────────────────┘
```

- **client** — a Vite + React + TypeScript SPA (React Router). Two areas share one
  build: the public booking site and the JWT-guarded `/admin` panel.
- **server** — an Express + TypeScript API. No ORM: raw parameterised SQL through
  `pg`, Zod validation on every request body/query.
- **PostgreSQL** — not just a store. The database itself is the final guarantor of
  correctness through GiST exclusion constraints and advisory locks.

---

## 2. Server layout

```
server/src/
├── index.ts              # app bootstrap, CORS, JSON, /api/health, routers
├── config.ts             # typed env config (DATABASE_URL, JWT_SECRET, SMTP…)
├── db/
│   ├── pool.ts           # shared pg Pool
│   ├── schema.sql        # full schema incl. exclusion constraints & types
│   ├── migrate.ts        # creates the DB if absent + applies schema (idempotent)
│   └── seed.ts           # demo data: the doctor, services, schedule, sample bookings
├── middleware/
│   ├── auth.ts           # admin JWT sign/verify (requireAdmin)
│   └── errors.ts         # central error handler (maps 23P01 → 409, Zod → 400)
├── routes/
│   ├── public.ts         # doctor profile/reviews, slots, create/lookup/cancel/
│   │                     #   reschedule/review booking, admin login
│   └── admin.ts          # stats, bookings admin, doctor/services/schedule/
│                         #   time-off, reviews moderation, day/week views
└── services/
    ├── slots.ts          # the availability engine
    ├── booking.ts        # transactional booking (locks + re-validation)
    ├── reviews.ts        # one review per completed booking
    ├── ics.ts            # calendar-invite (.ics) generation for emails
    └── notify/           # notification outbox + background dispatcher
        ├── outbox.ts     #   enqueue confirmation/cancellation/reminder rows
        ├── dispatcher.ts #   30s-tick worker: claims + sends due notifications
        ├── channels.ts   #   delivery channels (email via nodemailer/dev-outbox)
        └── templates.ts  #   HTML email renderers
```

Everything routes through `services/` — no route handler touches booking logic or
the slot engine directly except by calling into these modules. There is no
`routes/customer.ts` or payment/coupon service layer — booking is guest-only and
free of pricing extras by design.

---

## 3. Data model

| Table | Purpose |
|-------|---------|
| `users` | Admin accounts (bcrypt password hash). |
| `providers` | The doctor's profile and booking policy (slot step, min lead time, booking horizon, reschedule cutoff). Schema-wise the table can hold multiple rows, but the app only ever creates and reads one — resolved via `SELECT id FROM providers ORDER BY id LIMIT 1`, never a hardcoded id. |
| `services` | The doctor's offerings: name, duration, buffer, price. |
| `schedules` | Weekly working windows (guarded by an exclusion constraint so windows can't overlap). |
| `breaks` | Recurring in-day breaks (e.g. lunch). |
| `time_off` | One-off closures (vacation, conference). |
| `customers` | Guest records keyed by email — no accounts, no password. |
| `bookings` | The core record. Carries the `bookings_no_overlap` exclusion constraint. Status is one of `confirmed`, `completed`, `cancelled`, `no_show`. |
| `reviews` | One review (rating + comment) per completed booking; admin can hide/unhide. |
| `notifications` | Outbox for confirmation/cancellation/rescheduled/reminder emails — claimed and delivered by the background dispatcher. |
| `booking_events` | Audit trail: created, status changes, emails sent, reviews hidden. |

A custom `timerange` range type backs the GiST exclusion constraints.

---

## 4. Request flow: creating a booking

```
POST /api/bookings
  │
  ├─ 1. Zod validates the body (serviceId, start, customer{name,email,phone}, notes)
  │       (providerId is resolved server-side — there is only one doctor)
  │
  ├─ 2. BEGIN transaction
  │       └─ pg_advisory_xact_lock(42, provider_id)     ← serialises booking attempts
  │
  ├─ 3. Re-run the slot engine INSIDE the txn against live schedule/breaks/
  │      time-off/existing bookings. Requested start must still be a valid slot.
  │
  ├─ 4. Upsert the guest customer row by email
  │
  ├─ 5. INSERT booking (status = 'confirmed')
  │       └─ bookings_no_overlap EXCLUDE constraint is the last line of defence
  │
  ├─ 6. Write a booking_events row + enqueue the confirmation email
  │
  └─ 7. COMMIT  →  201 with booking detail
          on overlap: Postgres raises 23P01 → mapped to 409 Conflict
```

This is the heart of the project — see [§6](#6-zero-double-booking-three-layers).

---

## 5. The slot engine (`services/slots.ts`)

Given a service and date, the engine walks each working window in
`slot_step_min` increments and keeps a candidate start time only if — after
padding with the service's `buffer` — it clears **all** of:

- recurring **breaks**,
- one-off **time-off** periods,
- **existing bookings** (confirmed/completed),
- the doctor's **minimum lead time**, and
- the **booking horizon** (how far ahead booking is allowed).

The same function runs both when rendering the grid *and* inside the booking
transaction, so what the customer sees and what the server accepts can never
drift apart.

---

## 6. Zero double-booking: three layers

Two people must never hold the same slot — even under a race between concurrent
requests. BookIt enforces this with three independent layers:

1. **Advisory lock** — `pg_advisory_xact_lock(42, provider_id)` serialises
   concurrent booking attempts. Auto-released at commit/rollback.

2. **In-transaction re-validation** — the requested start must still be a slot
   the engine would generate *right now*. A hand-crafted API call can't book a
   closed day or a break.

3. **Postgres exclusion constraint** — the final guarantee. Even raw SQL cannot
   persist an overlap:

   ```sql
   CONSTRAINT bookings_no_overlap EXCLUDE USING gist (
     provider_id WITH =,
     tstzrange(starts_at, ends_at) WITH &&
   ) WHERE (status IN ('confirmed', 'completed'))
   ```

   The partial `WHERE` means cancelled/no-show bookings automatically free their
   slot. A conflicting insert fails with SQLSTATE `23P01`, which the error
   handler maps to `409 Conflict`, and the UI refreshes the slot grid.

---

## 7. Client layout

```
client/src/
├── App.tsx                     # React Router route table (public + /admin)
├── api.ts                      # typed fetch wrapper (attaches admin JWT)
├── format.ts                   # currency (Rs / PKR) / date helpers
├── types.ts                    # shared TS interfaces
├── components/
│   ├── Layout.tsx              # public shell (nav + footer)
│   ├── SlotPicker.tsx          # date strip + slot grid (booking & reschedule)
│   ├── RescheduleDialog.tsx    # reschedule flow wrapper around SlotPicker
│   ├── ReviewForm.tsx          # star rating + comment submission
│   ├── Stars.tsx               # star display / rating badge
│   └── ThemeToggle.tsx         # light/dark toggle
├── pages/
│   ├── Booking.tsx             # the whole booking flow: service → slot →
│   │                           #   guest details → confirm, plus reviews
│   ├── Confirmation.tsx        # post-booking success screen
│   └── Manage.tsx              # guest lookup by code + email: cancel/
│                               #   reschedule/review
└── admin/
    ├── AdminLogin.tsx, AdminLayout.tsx
    ├── Dashboard.tsx           # simple stat cards + recent bookings
    ├── Bookings.tsx            # filterable table, status actions, CSV export
    ├── DayView.tsx, WeekView.tsx  # calendar timelines
    ├── Settings.tsx            # doctor profile, services, schedule, time-off
    └── Reviews.tsx             # review moderation (hide/unhide)
```

**Public routes:** `/` (booking), `/confirmation`, `/manage`
**Admin routes:** `/admin/login`, `/admin` (dashboard), `/admin/bookings`,
`/admin/day`, `/admin/week`, `/admin/settings`, `/admin/reviews`.

The admin JWT is stored client-side and attached by `api.ts`; the server verifies
it in `middleware/auth.ts` for every `/api/admin/*` request. There is no customer
JWT — booking and managing a booking only ever require a code + email.

---

## 8. Notifications

`services/notify/` is a small outbox pattern, not a direct send-on-request:

1. `outbox.ts` enqueues a `notifications` row (confirmation, cancellation,
   rescheduled, or a 24h/1h reminder) inside the same transaction as the
   booking change, so a notification only ever exists if its booking committed.
2. `dispatcher.ts` runs a 30-second background tick, claiming due rows with
   `FOR UPDATE SKIP LOCKED` (safe under multiple processes) and retrying failed
   sends with exponential backoff.
3. `channels.ts` delivers over email via nodemailer if `SMTP_HOST` is configured;
   otherwise the rendered HTML (plus a `.ics` calendar invite) is written to
   `server/outbox/*.html` so the whole flow works end-to-end with **no mail
   provider** during development.
4. `templates.ts` renders the HTML for each of the five templates.
