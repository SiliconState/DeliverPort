-- Create dedicated audit and invoice reminder tables.
-- This replaces Meta keyspace storage for these domains.

CREATE TABLE IF NOT EXISTS "audit_events" (
  "id" TEXT NOT NULL,
  "owner_id" TEXT NOT NULL,
  "actor_id" TEXT,
  "actor_role" TEXT,
  "action" TEXT NOT NULL,
  "entity_type" TEXT NOT NULL,
  "entity_id" TEXT,
  "summary" TEXT,
  "details" JSONB,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "audit_events_owner_created_idx"
  ON "audit_events" ("owner_id", "created_at");

CREATE INDEX IF NOT EXISTS "audit_events_owner_entity_created_idx"
  ON "audit_events" ("owner_id", "entity_type", "created_at");

CREATE INDEX IF NOT EXISTS "audit_events_owner_action_created_idx"
  ON "audit_events" ("owner_id", "action", "created_at");

CREATE TABLE IF NOT EXISTS "invoice_reminders" (
  "id" TEXT NOT NULL,
  "invoice_id" TEXT NOT NULL,
  "owner_id" TEXT NOT NULL,
  "actor_user_id" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "recipient" TEXT,
  "note" TEXT,
  "status" TEXT NOT NULL,
  "sent_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "invoice_reminders_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "invoice_reminders_owner_created_idx"
  ON "invoice_reminders" ("owner_id", "created_at");

CREATE INDEX IF NOT EXISTS "invoice_reminders_owner_invoice_created_idx"
  ON "invoice_reminders" ("owner_id", "invoice_id", "created_at");
