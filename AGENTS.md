# AGENTS.md — WedPlan (Wedding Planning Platform)

This file is the single source of truth for any AI agent working on WedPlan.
Read it fully before writing code. Copy this same file into the **root of both repositories** (client and server). Sections marked **[CLIENT]** apply to the client repo, **[SERVER]** to the server repo, everything else to both.

---

## 0. Golden rules for agents

1. **Keep the current structure and systems.** Before adding anything, look at the repo as it is now (folders, naming, libraries, patterns) and follow it. Do not reorganize folders, rename files, swap libraries, change the auth approach, change the DB schema, or introduce new tools/collections on your own.
2. **If a change to the structure or system seems necessary, STOP and ask the human first.** State: what you want to change, why it is needed, and what the alternative is. Wait for an answer. Small additive work inside the existing structure (a new component, a new route file following the same pattern) does not need asking.
3. **If something is unclear or missing, ask.** Never invent business rules, credentials, URLs, or data. Use the "Open decisions" list (section 14) as the starting point.
4. **Never commit secrets.** No `.env`, keys, tokens, or service-account files in Git. Only `.env.example` with empty/placeholder values.
5. **Server is the authority.** Every permission, role, ownership, limit, and payment rule is enforced on the server. Frontend checks are only for UX.
6. **Make small, meaningful commits** (see section 13). One logical change per commit.
7. **Do not mark a task done until it was tested** (happy path + at least one failure path) and does not break reload/refresh on any route.
8. **Update the "Project state" section (section 15) at the end of every task** so the next agent knows what exists.

---

## 1. Project overview

**WedPlan** is a role-based wedding planning platform.

- **Customers** discover wedding services, filter/search them, submit booking requests, and track/cancel them.
- **Vendors** create a profile, publish services (max 3 active on Free, unlimited on Premium), manage booking requests, and upgrade to Premium via Stripe Checkout.
- **Admins** manage users (block/unblock), review/approve/reject/delete services, and view platform transactions.

Reference platforms: The Knot, Zola. Goal: a *functional* platform, not static pages. This is an assessment project — "no copied projects", professional UI/UX, security, and clean commits all matter.

---

## 2. Tech stack

| Layer | Choice |
|---|---|
| Client | Next.js (App Router), ShadCN UI, Tailwind, Framer Motion / Motion |
| Language | Follow what the repo already uses (TypeScript or JavaScript). If the repo is empty, **ask**. |
| Server | Express.js (separate repo) |
| Database | MongoDB Atlas |
| Auth | Better Auth (email+password and Google OAuth) |
| API auth | JWT, verified in Express middleware |
| Payments | Stripe Checkout (test mode) + Stripe webhooks |
| Images | ImgBB (file upload, not URL paste) |
| Notifications | Toast (e.g. sonner via ShadCN). **Never `alert()`** for normal feedback. |

Two **separate GitHub repositories**: `wedplan` (client: `https://github.com/tahxin/wedplan`) and `wedplan-backend` (server: `https://github.com/tahxin/wedplan-backend`).

---

## 3. High-level architecture

```
Browser ──► Next.js client (Better Auth lives here, session cookie)
               │  gets a JWT for the logged-in user
               ▼
          Express server ──► MongoDB Atlas (shared with Better Auth collections)
               ▲
Stripe ────────┘  (webhook → the only thing that activates Premium)
```

- Better Auth manages `user`, `session`, `account`, `verification` collections itself. Do **not** create duplicate collections for the same data.
- The client sends the JWT in `Authorization: Bearer <token>` to Express.
- Express middleware verifies the JWT, then **loads the user from the DB** to read the real `role` and `isBlocked`. Never trust a role/user id coming from the request body, query, or an unverified token claim.
- Business collections (only these three): `services`, `bookings`, `transactions`.
- If the repo already implements the JWT flow differently (e.g. JWKS verification, shared secret), **keep it** and just follow it. If it is not implemented yet and the approach is unclear, ask.

---

## 4. Database design

Use MongoDB with proper references (ObjectId or string ids — keep consistent with what Better Auth produces; check before writing queries).

### 4.1 `user` (Better Auth — extended with additional fields)
| Field | Notes |
|---|---|
| name, email, image | standard Better Auth fields |
| role | `"customer"` \| `"vendor"` \| `"admin"`. Set on sign-up for customer/vendor only. **Never writable via profile update.** `input: false` on the Better Auth additional field so the client cannot send it for admin. |
| isBlocked | boolean, default `false`. Admin-only change. |
| businessName | vendor only, editable by the vendor |
| subscriptionPlan | `"free"` \| `"premium"`, default `"free"`. **Only changed by the webhook handler / expiry logic.** |
| subscriptionExpiresAt | Date or null. Set/refreshed by webhook. |

- Admin accounts are **never** created by public sign-up. Seed/assign the admin securely (e.g. a one-off script or direct DB update using env-provided email). Ask the human how they want to seed it if not done.

### 4.2 `services`
`vendorId, serviceName, category, description, price, location, images[], status, createdAt`

- `status`: `"pending"` (default) \| `"approved"` \| `"rejected"`.
- Vendor "availability" toggle: the spec needs both "approved and active" and "manage availability". Proposed: an extra boolean `isActive` (default `true`) on the service. **Confirm with the human before adding it** (see section 14).
- Public visibility rule (everywhere customers can see services): `status === "approved"` **and** `isActive === true`. Rejected services are never visible to customers.
- `category` must be one of the fixed list in section 5.
- `price` is a positive number. `images` is an array of ImgBB URLs.

### 4.3 `bookings`
`serviceId, vendorId, customerId, eventDate, eventLocation, message, status, createdAt`

- `status`: `"pending"` (default) \| `"accepted"` \| `"rejected"` \| `"cancelled"`.
- `vendorId` is copied from the service on the server (never from the client). `customerId` comes from the verified token.
- Duplicate protection: no second **active** (pending/accepted) booking for the same `customerId + serviceId + eventDate`. Enforce in code and, if possible, with a partial unique index.

### 4.4 `transactions`
`vendorId, plan, amount, currency, stripeSessionId, stripeSubscriptionId, status, createdAt`

- Written **only** by the Stripe webhook handler (and optionally an initial `pending` row at session creation — ask if unsure).
- `stripeSessionId` is unique (idempotency: the same webhook event processed twice must not create duplicates).
- There is **no** admin/API route that edits a transaction's status.

---

## 5. Constants (keep identical on client and server)

**Roles:** `customer`, `vendor`, `admin`
**Categories:**
1. Photography & Videography
2. Wedding Venues
3. Decoration & Florist
4. Catering Services
5. Makeup & Styling
6. Wedding Fashion

**Booking statuses:** `pending`, `accepted`, `rejected`, `cancelled`
**Service statuses:** `pending`, `approved`, `rejected`
**Plans:** `free` (max 3 active services), `premium` (unlimited)
**Password rule:** min 6 chars, at least one uppercase, at least one lowercase.

---

## 6. Business rules (must be enforced on the server)

**Services**
- New service is created with `status: "pending"`.
- Free vendor: max **3 active services**. Check on create **and** whenever a service is re-activated. Premium: unlimited.
- Vendor can only update/delete/toggle **their own** services (ownership check).
- Admin can approve, reject, change status of published services, and delete any service.

**Bookings**
- Only authenticated **customers** can create bookings. Vendors cannot book their own services; admins cannot book.
- Service must exist and be approved + active; otherwise return a clear error (invalid ID → 404 with message).
- Vendor can accept/reject only bookings for their own services, and only while `pending`. Once accepted/rejected it cannot be processed again.
- Customer can cancel only their own bookings, and only while `pending`.

**Users**
- Blocked users (`isBlocked: true`) are rejected (403) by the auth middleware on every protected route, and the client must sign them out / show a blocked message.
- Profile update allows only name, image, businessName (vendor) and similar harmless fields. Whitelist fields on the server; ignore `role`, `subscriptionPlan`, `subscriptionExpiresAt`, `isBlocked`, `email`.

**Payments**
- Premium is activated **only** after a verified Stripe webhook event. The success page is just a confirmation UI and must never grant Premium.
- A vendor can only create a checkout session for **themselves** (vendor id from the verified token).
- Handle cancellation and expiry: when the subscription ends (webhook) or `subscriptionExpiresAt` has passed, treat the vendor as `free`. Decide how to treat services above the free limit after downgrade — **ask the human**.

---

## 7. [SERVER] Express structure & conventions

> Keep whatever folder layout already exists. If starting from zero, **ask** whether to use a single `index.js` or a folder structure (routes/controllers/middleware).

Required pieces (names are indicative):
- `config` — env loading, Mongo client (reuse a single connection, serverless-friendly if deploying to Vercel).
- `middleware/verifyJWT` — verifies token (401 on missing/invalid/expired), loads user, attaches `req.user = { id, role, ... }`, returns 403 if `isBlocked`.
- `middleware/requireRole(...roles)` — 403 if role not allowed.
- `middleware/validate` — server-side request validation (required fields, types, enums, ObjectId validity, date validity).
- Central **error handler** returning consistent JSON: `{ success: false, message }` with proper status codes (400, 401, 403, 404, 409, 500).
- **CORS**: allow only the client origin(s) from env, with credentials/headers needed for `Authorization`. No wildcard in production.
- **Stripe webhook** route must receive the **raw body** (`express.raw({ type: "application/json" })`) and be registered **before** `express.json()`. Verify the signature with the webhook secret.

### API surface (follow this; add nothing new without asking)

**Public / general**
- `GET /` — health check
- `GET /services` — approved+active only. Query: `search` (name), `category`, `location`, `sort` (`price_asc` | `price_desc`), pagination optional
- `GET /services/featured` — latest/featured approved+active (at least 6)
- `GET /categories` — the six categories (optionally with counts)
- `GET /services/:id` — see service details rules (Customers/Vendors/Admins need to be signed in per the client rule; confirm with the human whether this endpoint requires JWT)

**Auth / user (JWT required)**
- `GET /me` — current user (role, plan, blocked state)
- `PATCH /me` — update profile (whitelisted fields)

**Vendor (role: vendor)**
- `GET /vendor/overview` — total services, active services, pending requests, accepted bookings, current plan
- `GET /vendor/services`, `POST /vendor/services`, `PATCH /vendor/services/:id`, `DELETE /vendor/services/:id`, `PATCH /vendor/services/:id/availability`
- `GET /vendor/bookings`, `PATCH /vendor/bookings/:id/accept`, `PATCH /vendor/bookings/:id/reject`
- `POST /payments/create-checkout-session` — creates Stripe Checkout session for the logged-in vendor
- `GET /vendor/subscription` — plan + expiry

**Customer (role: customer)**
- `POST /bookings`
- `GET /customer/overview` — total, pending, accepted, rejected
- `GET /customer/bookings`, `GET /customer/bookings/:id`, `PATCH /customer/bookings/:id/cancel`

**Admin (role: admin)**
- `GET /admin/overview` — total users, vendors, customers, services, pending services, total transactions
- `GET /admin/users` (search by name/email, filter by role), `GET /admin/users/:id`, `PATCH /admin/users/:id/block`, `PATCH /admin/users/:id/unblock`
- `GET /admin/services` (search/filter), `PATCH /admin/services/:id/approve`, `PATCH /admin/services/:id/reject`, `PATCH /admin/services/:id/status`, `DELETE /admin/services/:id`
- `GET /admin/transactions` — read-only

**Stripe**
- `POST /webhooks/stripe` — raw body, signature verified. Handle at least: `checkout.session.completed` (activate premium + save transaction), subscription cancelled/expired (revert to free), payment failed (record status). Must be idempotent.

Status codes: **401** = not authenticated / bad or expired token; **403** = authenticated but not allowed (wrong role, blocked, not owner).

---

## 8. [CLIENT] Next.js structure & conventions

> Keep the existing folder layout, naming, and component patterns. If the project is fresh, use the standard App Router layout and **ask** before adding extra libraries beyond the stack above.

### Routes

**Public:** `/` (Home), `/services` (Browse), `/sign-in`, `/sign-up`
**Private:** `/services/[id]`, `/dashboard` (redirects by role), `/payment/success`, `/payment/cancel`
**Customer dashboard:** overview, my bookings, profile settings
**Vendor dashboard:** overview, my services, add service, booking requests, subscription, profile settings
**Admin dashboard:** overview, manage users, manage services, transactions
Also: a custom `not-found` page, `error` boundary, and `loading` states.

Suggested URL shape (follow the repo if it already differs): `/dashboard/customer/...`, `/dashboard/vendor/...`, `/dashboard/admin/...`.

### Access control (client)
- Route protection via Next.js middleware and/or a client guard using the Better Auth session. Unauthenticated → `/sign-in` (preserve the intended destination so the user returns after login).
- A user visiting another role's dashboard URL is redirected to their own dashboard (or a 403 page). The server still rejects the API calls regardless.
- Blocked users: sign out and show a clear message.
- Navbar updates **immediately** after login/logout (use the Better Auth session hook / refresh the router; no manual reload).
- All private routes must survive a hard refresh (session restored from cookie, no flash redirect to sign-in).

### Layout
- **Navbar:** "WedPlan" logo/name. Public: Home, Browse Services, Sign In, Sign Up. Authenticated: Home, Browse Services, profile dropdown (name + image, Dashboard, Profile Settings, Logout).
- **Footer:** logo + short description, navigation links, contact info, social links, copyright.
- **Dashboard layout:** separate layout with role-based sidebar + main content, responsive (sidebar collapses on mobile).

### Pages (key requirements)
- **Home:** Banner (headline, description, CTA "Explore Wedding Services", wedding-themed image); Featured Services (≥6 approved+active from DB with image, name, category, price, location, vendor info, View Details); Categories (6, each links to `/services?category=...`); "Why Choose WedPlan?"; one of How It Works / Destinations / Testimonials / Tips; Motion animations on suitable sections (smooth, subtle, respect reduced motion).
- **Browse Services:** responsive cards, search by name, category filter, location filter, **sort by price asc/desc**, loading state, empty state. Clicking View Details while logged out → `/sign-in`.
- **Service Details:** name, multiple images (gallery/carousel), category, description, price, location, vendor info, booking button/form (Event Date, Event Location, Additional Message). Hide/disable booking for vendors and admins. Invalid ID → friendly error/not-found.
- **Sign Up:** full name, email, password (rules above), optional profile image (file → ImgBB), role select (Vendor/Customer only), Google sign-up, toast success/error, role-based redirect.
- **Sign In:** email, password, Google login, toasts, role-based redirect.
- **Vendor / Customer / Admin dashboards:** as listed in the assignment (stat cards on overview, tables/cards with actions, confirmation dialogs for destructive actions).
- **Subscription page:** Free vs Premium comparison, "Upgrade to Premium" button, current plan/expiry, Premium badge.
- **Payment success/cancel:** informational only; success page re-fetches the user's plan from the server and shows "processing" if the webhook has not landed yet. It never sets Premium itself.

### UI/UX standards
- ShadCN components, reusable components, consistent spacing/typography/colors, **wedding-themed** professional look (soft, elegant palette; do not reuse a template).
- Fully responsive (mobile, tablet, desktop).
- Loading states for: fetching services, dashboards, form submits, booking processing, payment processing.
- Error states for: invalid routes, failed API calls, invalid forms, unauthorized access, missing records, failed image uploads.
- Use toasts, not `alert()`. Every button and link must work. Avoid animation clutter.

### Data fetching
- One API helper that attaches the Bearer token and handles 401/403 centrally. Do not scatter raw `fetch` calls with duplicated headers.
- API base URL from `NEXT_PUBLIC_API_URL` (no hard-coded localhost in committed code).

---

## 9. Authentication details

- Better Auth with email+password and Google OAuth, configured entirely via env vars.
- Extra user fields: `role`, `isBlocked`, `businessName`, `subscriptionPlan`, `subscriptionExpiresAt` (server-controlled where noted in section 4.1).
- Role selection on sign-up is limited to `vendor` and `customer`. Reject `admin` server-side even if sent.
- Profile image upload: file → ImgBB (API key kept out of the client bundle if possible — upload via the server or a server action; **ask** if the existing approach differs).
- After sign-in/sign-up redirect by role: admin → admin overview, vendor → vendor overview, customer → customer overview.

---

## 10. Stripe flow (Test Mode)

1. Vendor clicks **Upgrade to Premium** → client calls `POST /payments/create-checkout-session`.
2. Server verifies JWT + role `vendor`, creates the Stripe Checkout Session for that vendor (store `vendorId` in session metadata), returns the URL.
3. Client redirects to Stripe. Success → `/payment/success`, cancel → `/payment/cancel`.
4. Stripe calls `POST /webhooks/stripe`. Server verifies the signature, then (idempotently) saves the transaction and sets `subscriptionPlan = "premium"` and `subscriptionExpiresAt`.
5. Cancel/expire events revert the vendor to `free`.

Local testing: Stripe CLI `stripe listen --forward-to localhost:<port>/webhooks/stripe` (the CLI prints the local webhook secret). Live site: register the production webhook endpoint in the Stripe dashboard.

---

## 11. Environment variables

Never commit real values. Keep `.env.example` files up to date.

**[SERVER]**
```
PORT=
NODE_ENV=
MONGODB_URI=
CLIENT_URL=                  # allowed CORS origin(s)
BETTER_AUTH_SECRET=          # if the server needs it to verify tokens
BETTER_AUTH_URL=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PREMIUM_PRICE_ID=     # or amount config, ask which approach
IMGBB_API_KEY=               # only if uploads go through the server
ADMIN_EMAIL=                 # only if used for secure admin seeding
```

**[CLIENT]**
```
NEXT_PUBLIC_API_URL=
NEXT_PUBLIC_APP_URL=
BETTER_AUTH_SECRET=
BETTER_AUTH_URL=
MONGODB_URI=                 # Better Auth DB adapter (server-side only, never NEXT_PUBLIC_)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
IMGBB_API_KEY=               # server-side only if uploads go through a Next.js route/action
```

Rule: anything secret must **never** have the `NEXT_PUBLIC_` prefix.

---

## 12. Deployment checklist (must all pass on the live site)

- No CORS errors, no 404 on refresh of any route, no 504s.
- Reloading any route (including private ones and dynamic `/services/[id]`) works; logged-in users stay logged in.
- Google OAuth redirect URIs include the production URL.
- Stripe Checkout and the webhook work in production (production webhook endpoint + secret set).
- The admin credentials given for evaluation work on the live site.
- No secrets exposed in the client bundle, repo history, or README.
- If deployed on Vercel, make sure the server handles a cold start and a single reused Mongo connection.

---

## 13. Git & commit rules

- Minimum **20 meaningful client commits** and **12 meaningful server commits**. Commit as you build; do not squash everything at the end. Commit frequently for every logical feature and improvement.
- Message format: `type: short description of the actual work`, e.g. `feat: add price sorting to browse services`, `fix: block cancelled bookings from being accepted`, `chore: add .env.example`.
- No "update", "fix", "changes", "wip" style messages.
- One logical change per commit. Never commit `.env`, `node_modules`, build output.
- **README.md** (in both repos) must include: project name & description, important features, tech stack, installation instructions, how to run locally, live website link, client & server repo links, environment variables (names only), required application URLs.

---

## 14. Architecture & Design Decisions

1. **Languages**: TypeScript for Client (`wedplan`), JavaScript (ES Modules) for Server (`wedplan-backend`).
2. **Server Architecture**: Single `index.js` Express file with modular verification scripts (`seed.js`, `verify-db.js`, `make-admin.js`) and Vercel routing (`vercel.json`).
3. **Availability vs Status**: Added `isActive` boolean (default `true`) on services for vendor availability toggling alongside admin approval `status` (`"pending"` | `"approved"` | `"rejected"`).
4. **Active Service Definition**: A service counts toward the Free tier limit if `status !== "rejected" && isActive === true`.
5. **Service Details Route**: Public API endpoint with vendor profile lookup; client route requires authentication.
6. **Subscription & Downgrade Rules**: $20 one-time payment for Premium Partner. Upon subscription expiry/cancellation, vendor reverts to Free and any active services beyond 3 are automatically deactivated.
7. **Admin Seeding**: Seeded securely via CLI utility (`npm run make:admin <email>`) or direct MongoDB update. Admin email assigned: `tahxin@nishat.com`.
8. **Deployment Target**:
   - Client: `https://wedplan-ice.vercel.app/`
   - Server: `https://wedplan-backend.vercel.app/`
9. **Image Hosting**: ImgBB API key stored securely in server env and proxied via Next.js `/api/upload` endpoint.
10. **Design & Animation**: Soft, elegant wedding palette (rose, blush, champagne, gold) with clean typography, ShadCN UI primitives, and subtle Framer Motion / Motion animations.

---

## 15. Project state (agents: keep this updated)

**Current structure:**
- **Frontend (`wedplan`)**: Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS v4, Motion (Framer Motion), Lucide icons, ShadCN UI primitives, Sonner toasts, Better Auth with MongoDB adapter.
- **Backend (`wedplan-backend`)**: Express.js (ESM), MongoDB driver with connection pooling & compound indexes, Stripe SDK, Jose JWT & session verification, Vercel serverless routing (`vercel.json`).

**Done:**
- [x] Backend baseline setup with ESM, MongoDB Atlas connection, and automatic compound/partial database indexes.
- [x] Complete Express REST API:
  - Public: Health (`/`), Categories with live counts (`/categories`), Featured services (`/services/featured`), Browse services with search/filter/price-sort (`/services`), Single service details with vendor lookup (`/services/:id`).
  - Auth/User: Profile fetching & whitelisted updating (`/me`).
  - Vendor: Overview metrics (`/vendor/overview`), Service CRUD with editing modal & availability toggle (`/vendor/services`), Booking review accept/reject (`/vendor/bookings`), Stripe Checkout session generator (`/payments/create-checkout-session`), Free plan limit of 3 active services enforced on server.
  - Customer: Inquiries creation with duplicate-date prevention (`/bookings`), Customer overview metrics (`/customer/overview`), Bookings listing, detailed modal inspector, and cancellation (`/customer/bookings`).
  - Admin: Platform metrics (`/admin/overview`), User directory & block/unblock with session invalidation (`/admin/users`), Service review queue approve/reject/delete (`/admin/services`), Stripe transactions ledger (`/admin/transactions`).
  - Stripe Webhook: Signature verification, idempotent transaction recording on `checkout.session.completed`, automatic plan downgrades on cancellation/expiry.
- [x] Dual-token Auth Middleware supporting both Better Auth session tokens and JWTs via secret or JWKS.
- [x] Better Auth extended user schema (`role`, `isBlocked`, `businessName`, `subscriptionPlan`, `subscriptionExpiresAt`), Google OAuth provider, and JWT/Bearer plugins.
- [x] Server-side ImgBB upload proxy endpoint (`/api/upload`) keeping the API key hidden from client bundles.
- [x] Frontend Core Layout: Responsive `Navbar` with role-aware avatar dropdown and `Footer` with wedding branding.
- [x] Home page with Hero banner, 6 service categories, popular packages, value propositions, interactive steps, and Framer Motion animations.
- [x] Browse Services page with dynamic search, category pills, location filter, and price ascending/descending sorting.
- [x] Service Details page with image gallery, package investment details, and customer direct booking inquiry modal.
- [x] Customer Dashboard with booking statistics, request status indicators, detailed modal inspector, and cancellation actions.
- [x] Vendor Dashboard with metrics, service management, package edit modal, availability toggles, client request responses (Accept/Decline), and Stripe Premium upgrade.
- [x] Admin Dashboard with metrics overview, user blocking/unblocking, service review queue, and transaction logs.
- [x] Role-based Profile Settings page (`/dashboard/settings` and role subpaths) with avatar uploading.
- [x] Custom 404 Not Found page and global Error boundary.
- [x] Stripe payment success/cancel feedback pages.
- [x] Next.js 16 Route Protection Proxy (`src/proxy.ts`).
- [x] Database seeded with 6 sample verified wedding packages across all categories with real imagery and vendor links.
- [x] Admin CLI promotion utility (`Backend/scripts/make-admin.js`) with `tahxin@nishat.com` promoted.
- [x] Both repositories equipped with `.env.example` and complete professional `README.md` files.
- [x] Minimum commit counts exceeded: 36 Client Commits & 14 Server Commits on `origin/main`.

**In progress:**
- None (All functional, architectural, design, and deployment deliverables are complete).

**Known issues / decisions made:**
- Database: MongoDB Atlas (shared between Better Auth and business collections).
- Admin account: Promoted `tahxin@nishat.com` to `role: "admin"`.
- Next.js 16: Uses official `proxy.ts` convention for route protection.

---

## 16. Definition of done (per task)

- [x] Follows the existing structure and patterns
- [x] Server-side validation, role check, and ownership check in place
- [x] Loading, empty, and error states handled; toast feedback shown
- [x] Responsive on mobile/tablet/desktop
- [x] Works after a hard refresh on its route
- [x] No secrets committed; `.env.example` updated
- [x] Meaningful commit(s) made
- [x] "Project state" section updated

---

## 17. Manual User Checklist (Deployment & External Services)

1. **Vercel Frontend Environment Variables (`wedplan-ice`)**:
   - `NEXT_PUBLIC_API_URL`: `https://wedplan-backend.vercel.app`
   - `NEXT_PUBLIC_APP_URL`: `https://wedplan-ice.vercel.app`
   - `BETTER_AUTH_SECRET`: *(Secret from local `.env`)*
   - `BETTER_AUTH_URL`: `https://wedplan-ice.vercel.app`
   - `MONGODB_URI`: *(MongoDB Atlas connection string)*
   - `GOOGLE_CLIENT_ID`: *(Google OAuth client ID)*
   - `GOOGLE_CLIENT_SECRET`: *(Google OAuth client secret)*
   - `IMAGEBB_API_KEY`: *(ImgBB API key)*
   - `STRIPE_API_KEY`: *(Stripe test secret key)*

2. **Vercel Backend Environment Variables (`wedplan-backend`)**:
   - `PORT`: `5000`
   - `NODE_ENV`: `production`
   - `MONGODB_URI`: *(MongoDB Atlas connection string)*
   - `CLIENT_URL`: `https://wedplan-ice.vercel.app`
   - `BETTER_AUTH_SECRET`: *(Same secret as frontend)*
   - `BETTER_AUTH_URL`: `https://wedplan-ice.vercel.app`
   - `STRIPE_SECRET_KEY`: *(Stripe test secret key)*
   - `STRIPE_WEBHOOK_SECRET`: *(Signing secret from Stripe webhook dashboard)*

3. **Google Cloud Console**:
   - Add `https://wedplan-ice.vercel.app/api/auth/callback/google` to Authorized redirect URIs.
   - Add `https://wedplan-ice.vercel.app` to Authorized JavaScript origins.

4. **Stripe Webhook Registration**:
   - Add endpoint `https://wedplan-backend.vercel.app/webhooks/stripe` listening for `checkout.session.completed` and `customer.subscription.deleted`.
 