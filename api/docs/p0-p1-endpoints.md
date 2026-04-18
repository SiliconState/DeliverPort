# DeliverPort API — P0/P1 endpoint reference

This document covers the additive routes introduced in the P0/P1 backend milestones.

- Base URL (local): `http://localhost:3000`
- Auth: `Authorization: Bearer <jwt>` unless explicitly noted
- JWT is issued by `POST /api/auth/register` or `POST /api/auth/login`

---

## P0 routes (tenant-safe state + bootstrap)

### `GET /api/bootstrap`
Return startup data in one request for the authenticated user.

**Includes**:
- `clients`, `projects`, `invoices`, `payout_runs`, `users`, `meta`
- `server_time`

**Notes**:
- Requires auth
- Uses tenant scoping by authenticated user (`owner_id`)

---

### `GET /api/meta`
List tenant-scoped meta entries.

**Response**:
```json
{ "meta": [{ "key": "default_due_days", "value": 14 }] }
```

---

### `PUT /api/meta/:key`
Upsert one tenant-scoped meta key.

**Body**:
```json
{ "value": { "theme": "dark" } }
```

**Behavior**:
- Key is normalized and scoped to the current user
- Returns normalized logical key + stored value

---

### `POST /api/meta/delete`
Delete multiple tenant-scoped meta keys.

**Body**:
```json
{ "keys": ["default_due_days", "display_currency"] }
```

**Response**:
```json
{ "success": true, "deleted": 2 }
```

---

## P1 routes (workflow automation + ops visibility)

### Deliverable approvals

### `POST /api/projects/:id/deliverables/:deliverable/approval`
### `PUT /api/projects/:id/deliverables/:deliverable/approval`
Approve/reject a delivered item.

**Body**:
```json
{
  "decision": "approved",
  "note": "Looks good"
}
```

**Rules**:
- `decision`: `approved | rejected`
- Operator can act for owned project
- Client can act only for their linked client project

**Response (shape)**:
```json
{
  "project_id": "proj_123",
  "deliverable_index": 0,
  "deliverable": { "approval_status": "approved" },
  "deliverables": []
}
```

---

### Invoice reminders

### `GET /api/invoices/reminders`
Return due/overdue reminder candidates for `sent` invoices.

**Response (shape)**:
```json
{
  "reminders": [
    {
      "invoice_id": "inv_123",
      "due_at": "2026-04-20T00:00:00.000Z",
      "is_overdue": false,
      "last_reminded_at": null,
      "reason": "Due reminder candidate",
      "invoice": { "id": "inv_123", "status": "sent" }
    }
  ]
}
```

### `POST /api/invoices/:id/reminders/mark-sent`
Log that outreach was sent for a `sent` invoice.

### `POST /api/invoices/:id/remind`
Legacy alias to `.../reminders/mark-sent`.

**Body (optional fields)**:
```json
{
  "channel": "email",
  "recipient": "client@example.com",
  "note": "Followed up with payment reminder"
}
```

**Valid channels**: `email | sms | whatsapp | manual`

### `GET /api/invoices/:id/reminders`
List reminder history entries for one invoice.

---

### Invoice reconciliation

### `POST /api/invoices/:id/reconcile`
Mark a sent invoice as paid by:
1. verified tx hash (`tx_hash` / `external_ref`), or
2. automatic Base transfer scan (USDC/USDT) when no tx hash is provided.

**Body (all optional)**:
```json
{
  "tx_hash": "0x...",
  "external_ref": "0x...",
  "paid_at": "2026-04-18T15:20:00.000Z",
  "lookback_blocks": 120000,
  "min_confirmations": 1,
  "require_verification": true,
  "allow_unverified_tx_hash": false
}
```

**Verification policy**:
- `require_verification` defaults to `true` (or env `RECONCILE_REQUIRE_TX_VERIFICATION=false` to relax).
- With verification enabled, provided `tx_hash` is checked via Base RPC receipt/log inspection.
- If verification fails, API returns `409` and does not mark invoice paid (unless `allow_unverified_tx_hash=true`).

**Response (shape)**:
```json
{
  "invoice": { "id": "inv_123", "status": "paid" },
  "reconciled": true,
  "reconciliation": {
    "mode": "tx_hash_verified"
  }
}
```

Common reconciliation modes:
- `tx_hash_verified`
- `manual_tx_hash_unverified`
- `rpc_scan`

When no matching transfer is found in scan mode, response returns `reconciled: false` with scan details.

---

### Audit feed

### `GET /api/audit-events`
Operator-only audit timeline from the dedicated `audit_events` table.

**Query params**:
- `limit` (1–300)
- `entity_type`
- `entity_id`
- `action` (alias: `event_type`)

**Response**:
```json
{ "events": [] }
```

---

## Storage note (audit + reminders)

Audit events and invoice reminders are now stored in dedicated tables:
- `audit_events`
- `invoice_reminders`

Apply migration SQL:
- `api/prisma/migrations/20260418_audit_and_reminders_tables/migration.sql`

## Frontend compatibility note

If a backend is missing any P1 route, the frontend treats 404/405 as **unsupported** and falls back where possible (e.g., local reminder candidates). UX warnings are shown once per session to reduce repetition.
