# WedPlan — Wedding Planning Platform (Backend API)

WedPlan Backend is an Express.js REST API servicing the WedPlan wedding planning platform. It manages role-based access control (Customer, Vendor, Admin), MongoDB Atlas business collections (`services`, `bookings`, `transactions`), Stripe Checkout session generation, and verified Stripe webhook handlers for Premium subscription upgrades and downgrades.

- **Live Backend API:** [https://wedplan-backend.vercel.app/](https://wedplan-backend.vercel.app/)
- **Live Client Web App:** [https://wedplan-ice.vercel.app/](https://wedplan-ice.vercel.app/)
- **Server Repository:** [https://github.com/tahxin/wedplan-backend](https://github.com/tahxin/wedplan-backend)
- **Client Repository:** [https://github.com/tahxin/wedplan](https://github.com/tahxin/wedplan)

---

## Important Features & Endpoints

### 1. Public & Discovery
- `GET /` — Service health check
- `GET /categories` — Six official categories with approved service counts
- `GET /services/featured` — Top 6 featured services with vendor details
- `GET /services` — Search by service name, category filter, location filter, and price sort (`price_asc` | `price_desc`)
- `GET /services/:id` — Single service package details with vendor profile

### 2. User & Auth
- `GET /me` — Current authenticated user profile
- `PATCH /me` — Whitelisted profile update (name, image, businessName)

### 3. Vendor Management
- `GET /vendor/overview` — Studio stats (total, active, pending inquiries, accepted bookings, subscription tier)
- `GET /vendor/services` — Vendor's catalog listings
- `POST /vendor/services` — Create listing with Free tier limit enforcement (maximum 3 active)
- `PATCH /vendor/services/:id` — Update listing details (ownership enforced)
- `DELETE /vendor/services/:id` — Delete listing (ownership enforced)
- `PATCH /vendor/services/:id/availability` — Toggle service availability (`isActive`)
- `GET /vendor/bookings` — Inquiries received from couples
- `PATCH /vendor/bookings/:id/accept` — Accept pending booking
- `PATCH /vendor/bookings/:id/reject` — Reject pending booking
- `POST /payments/create-checkout-session` — Generate Stripe Checkout session for $20 Premium upgrade
- `GET /vendor/subscription` — Current subscription tier and expiration

### 4. Customer Bookings
- `POST /bookings` — Create booking request (with duplicate date protection and vendor self-booking prevention)
- `GET /customer/overview` — Counts of total, pending, accepted, declined, and cancelled bookings
- `GET /customer/bookings` — Inquiries submitted by customer
- `GET /customer/bookings/:id` — Detailed inquiry record
- `PATCH /customer/bookings/:id/cancel` — Cancel pending booking

### 5. Administration
- `GET /admin/overview` — Platform-wide metrics (users, vendors, customers, services, pending review queue, transactions)
- `GET /admin/users` — User directory with search and role filtering
- `PATCH /admin/users/:id/block` — Block user account and invalidate active sessions
- `PATCH /admin/users/:id/unblock` — Restore user account
- `GET /admin/services` — Review queue with status filtering
- `PATCH /admin/services/:id/approve` — Approve pending service
- `PATCH /admin/services/:id/reject` — Decline service
- `DELETE /admin/services/:id` — Delete service
- `GET /admin/transactions` — Read-only ledger of Stripe payments

### 6. Stripe Webhooks
- `POST /webhooks/stripe` — Cryptographically verified webhook handling `checkout.session.completed` (idempotent recording + premium grant) and `customer.subscription.deleted` (downgrade to free + automatic deactivation of services above 3).

---

## Technology Stack

- **Runtime**: Node.js (ES Modules)
- **Framework**: Express.js
- **Database**: MongoDB Atlas with native connection pooling and compound indexes
- **Authentication**: JWT & Better Auth session verification (`jose`)
- **Payments**: Stripe Node SDK (Test Mode)
- **Deployment**: Vercel

---

## Environment Variables

Create a `.env` file based on `.env.example`:

```env
PORT=5000
NODE_ENV=development
MONGODB_URI=
CLIENT_URL=http://localhost:3000
BETTER_AUTH_SECRET=
BETTER_AUTH_URL=http://localhost:3000
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PREMIUM_PRICE_ID=
IMGBB_API_KEY=
ADMIN_EMAIL=
```

---

## Installation & Local Development

1. **Clone the repository:**
   ```bash
   git clone https://github.com/tahxin/wedplan-backend.git
   cd wedplan-backend
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure environment:**
   Create `.env` and fill in `MONGODB_URI`, `PORT`, and other configuration variables.

4. **Start local server:**
   ```bash
   npm run dev
   # or
   npm start
   ```

5. **Run test suite:**
   ```bash
   npm test
   ```

6. **Database Utilities:**
   ```bash
   npm run seed          # Seed sample approved wedding packages
   npm run verify:db     # Verify MongoDB Atlas collection connectivity
   npm run summary:db    # Inspect collection shapes and aggregate counts
   npm run make:admin    # Promote a user to platform admin
   ```

Server will run on `http://localhost:5000` with automatic MongoDB Atlas connection and index verification.
