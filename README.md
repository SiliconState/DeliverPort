# DeliverPort

**Share work. Get paid on-chain.**

DeliverPort is a client delivery + billing portal for freelancers, agencies, and studios who invoice in stablecoins on Base.

It runs in two modes:

- **Local mode**: single `index.html`, browser storage (PGlite), no backend required.
- **API mode**: same frontend + Hono/Prisma/Postgres API for authenticated multi-device workflows.

## Capabilities

- **Operator workspace**: clients, projects, deliverables, invoices, payout runs, portal links
- **Client portal**: progress visibility, deliverable review, invoice/payment details
- **Billing flow**: draft → sent → paid lifecycle with explicit confirmations
- **On-chain rails**: USDC/USDT on Base + wallet/deep-link payment support
- **Live FX display**: show invoice amounts in local currency while settling in stablecoins
- **API-mode extras**:
  - bootstrap payload (`/api/bootstrap`) for faster startup
  - tenant-scoped settings/meta isolation (`/api/meta*`)
  - deliverable approvals
  - invoice reminders + reminder history logging
  - on-chain reconciliation for sent invoices
  - operator audit event feed

## Architecture

| Layer | Local mode | API mode |
|---|---|---|
| Frontend | `index.html` + Tailwind + vanilla JS | same |
| Data | PGlite (Postgres WASM in browser) | PostgreSQL via Prisma |
| Auth | Local session in browser | JWT auth (`/api/auth/*`) |
| API | none | Hono (`api/src`) |
| Deploy target | static host (GitHub Pages) | Node service + DB |

## Quick start (local mode)

```bash
cd deliverport
python3 -m http.server 8080
# open http://localhost:8080/index.html?local=1
```

`?local=1` forces local mode for the session and clears any persisted API URL.

## Quick start (API mode)

1) Start the backend:

```bash
cd deliverport/api
cp .env.example .env
npm install
npm run db:push
npm run dev
```

Optional production-oriented env flags:
- `REDIS_URL=redis://...` to use Redis-backed auth throttling/rate-limits
- `RECONCILE_REQUIRE_TX_VERIFICATION=true|false` (default `true`) to control strict tx-hash verification

2) Start the frontend from repo root:

```bash
cd deliverport
python3 -m http.server 8080
```

3) Open the app and point it to the API:

- `http://localhost:8080/index.html?api=http://localhost:3000`

The frontend persists the API URL in `localStorage` until you disconnect in **Settings → Data backend** (or force local mode with `?local=1`).

## API route docs (P0/P1)

See: **[`api/docs/p0-p1-endpoints.md`](api/docs/p0-p1-endpoints.md)**

## Live

[siliconstate.github.io/DeliverPort](https://siliconstate.github.io/DeliverPort/)

## License

Proprietary. All rights reserved.
