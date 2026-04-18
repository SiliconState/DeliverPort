import { randomBytes } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from './db.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function randomId(): string {
  return randomBytes(6).toString('hex');
}

function makeEventId(timestampIso: string): string {
  return `${timestampIso}-${randomId()}`;
}

function toDetailsObject(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  if (!value || !isRecord(value)) return null;
  return value;
}

export interface AuditEvent {
  id: string;
  owner_id: string;
  actor_id: string | null;
  actor_role: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  summary: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
}

export interface LogAuditEventInput {
  ownerId: string;
  actorId?: string | null;
  actorRole?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  summary?: string | null;
  details?: Record<string, unknown> | null;
}

/** Persist one audit event in the dedicated audit_events table. */
export async function logAuditEvent(input: LogAuditEventInput): Promise<AuditEvent> {
  const createdAt = new Date();
  const createdAtIso = createdAt.toISOString();
  const id = makeEventId(createdAtIso);

  const row = await prisma.auditEvent.create({
    data: {
      id,
      owner_id: input.ownerId,
      actor_id: input.actorId ?? null,
      actor_role: input.actorRole ?? null,
      action: input.action,
      entity_type: input.entityType,
      entity_id: input.entityId ?? null,
      summary: input.summary ?? null,
      details: input.details === undefined || input.details === null
        ? Prisma.JsonNull
        : (input.details as Prisma.InputJsonValue),
      created_at: createdAt,
    },
  });

  return {
    id: row.id,
    owner_id: row.owner_id,
    actor_id: row.actor_id,
    actor_role: row.actor_role,
    action: row.action,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    summary: row.summary,
    details: toDetailsObject(row.details),
    created_at: row.created_at.toISOString(),
  };
}

/** Best-effort audit logging wrapper; write failures should not fail requests. */
export async function safeLogAuditEvent(input: LogAuditEventInput): Promise<void> {
  try {
    await logAuditEvent(input);
  } catch (err) {
    console.warn('[AUDIT] Failed to persist audit event', err);
  }
}

export interface ListAuditEventsOptions {
  limit?: number;
  entityType?: string;
  entityId?: string;
  action?: string;
}

export async function listAuditEvents(ownerId: string, options: ListAuditEventsOptions = {}): Promise<AuditEvent[]> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 300);

  const rows = await prisma.auditEvent.findMany({
    where: {
      owner_id: ownerId,
      ...(options.entityType ? { entity_type: options.entityType } : {}),
      ...(options.entityId ? { entity_id: options.entityId } : {}),
      ...(options.action ? { action: options.action } : {}),
    },
    orderBy: [
      { created_at: 'desc' },
      { id: 'desc' },
    ],
    take: limit,
  });

  return rows.map((row) => ({
    id: row.id,
    owner_id: row.owner_id,
    actor_id: row.actor_id,
    actor_role: row.actor_role,
    action: row.action,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    summary: row.summary,
    details: toDetailsObject(row.details),
    created_at: row.created_at.toISOString(),
  }));
}

export interface InvoiceReminder {
  id: string;
  invoice_id: string;
  owner_id: string;
  actor_user_id: string;
  channel: string;
  recipient: string | null;
  note: string | null;
  status: 'sent' | 'pending' | 'cancelled';
  sent_at: string | null;
  created_at: string;
}

export interface CreateInvoiceReminderInput {
  ownerId: string;
  invoiceId: string;
  actorUserId: string;
  channel: string;
  recipient?: string | null;
  note?: string | null;
  status?: 'sent' | 'pending' | 'cancelled';
}

export async function createInvoiceReminder(input: CreateInvoiceReminderInput): Promise<InvoiceReminder> {
  const createdAt = new Date();
  const status = input.status ?? 'sent';
  const sentAt = status === 'sent' ? createdAt : null;
  const id = makeEventId(createdAt.toISOString());

  const row = await prisma.invoiceReminder.create({
    data: {
      id,
      invoice_id: input.invoiceId,
      owner_id: input.ownerId,
      actor_user_id: input.actorUserId,
      channel: input.channel,
      recipient: input.recipient ?? null,
      note: input.note ?? null,
      status,
      sent_at: sentAt,
      created_at: createdAt,
    },
  });

  return {
    id: row.id,
    invoice_id: row.invoice_id,
    owner_id: row.owner_id,
    actor_user_id: row.actor_user_id,
    channel: row.channel,
    recipient: row.recipient,
    note: row.note,
    status: row.status === 'pending' || row.status === 'cancelled' ? row.status : 'sent',
    sent_at: row.sent_at ? row.sent_at.toISOString() : null,
    created_at: row.created_at.toISOString(),
  };
}

export async function listInvoiceReminders(ownerId: string, invoiceId?: string): Promise<InvoiceReminder[]> {
  const rows = await prisma.invoiceReminder.findMany({
    where: {
      owner_id: ownerId,
      ...(invoiceId ? { invoice_id: invoiceId } : {}),
    },
    orderBy: [
      { created_at: 'desc' },
      { id: 'desc' },
    ],
    take: 500,
  });

  return rows.map((row) => ({
    id: row.id,
    invoice_id: row.invoice_id,
    owner_id: row.owner_id,
    actor_user_id: row.actor_user_id,
    channel: row.channel,
    recipient: row.recipient,
    note: row.note,
    status: row.status === 'pending' || row.status === 'cancelled' ? row.status : 'sent',
    sent_at: row.sent_at ? row.sent_at.toISOString() : null,
    created_at: row.created_at.toISOString(),
  }));
}

export function latestSentReminderByInvoice(reminders: InvoiceReminder[]): Map<string, string> {
  const latest = new Map<string, string>();

  for (const reminder of reminders) {
    if (reminder.status !== 'sent' || !reminder.sent_at) continue;

    const existing = latest.get(reminder.invoice_id);
    if (!existing || reminder.sent_at > existing) {
      latest.set(reminder.invoice_id, reminder.sent_at);
    }
  }

  return latest;
}
