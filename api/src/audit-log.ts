import { randomBytes } from 'crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from './db.js';
import { TENANT_NAMESPACES, tenantNamespacePrefix, tenantScopedKey } from './tenant.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function randomId(): string {
  return randomBytes(6).toString('hex');
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

/** Persist one audit event in tenant-scoped Meta storage. */
export async function logAuditEvent(input: LogAuditEventInput): Promise<AuditEvent> {
  const createdAt = new Date().toISOString();
  const event: AuditEvent = {
    id: `${createdAt}-${randomId()}`,
    owner_id: input.ownerId,
    actor_id: input.actorId ?? null,
    actor_role: input.actorRole ?? null,
    action: input.action,
    entity_type: input.entityType,
    entity_id: input.entityId ?? null,
    summary: input.summary ?? null,
    details: input.details ?? null,
    created_at: createdAt,
  };

  const key = tenantScopedKey(input.ownerId, TENANT_NAMESPACES.audit, event.id);
  await prisma.meta.create({
    data: {
      key,
      value: event as unknown as Prisma.InputJsonValue,
    },
  });

  return event;
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
  const prefix = tenantNamespacePrefix(ownerId, TENANT_NAMESPACES.audit);
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 300);

  const rows = await prisma.meta.findMany({
    where: {
      key: { startsWith: prefix },
    },
    orderBy: { key: 'desc' },
    take: limit,
  });

  const events: AuditEvent[] = [];
  for (const row of rows) {
    if (!isRecord(row.value)) continue;

    const event = row.value as Record<string, unknown>;
    const normalized: AuditEvent = {
      id: typeof event.id === 'string' ? event.id : row.key.slice(prefix.length),
      owner_id: typeof event.owner_id === 'string' ? event.owner_id : ownerId,
      actor_id: typeof event.actor_id === 'string' ? event.actor_id : null,
      actor_role: typeof event.actor_role === 'string' ? event.actor_role : null,
      action: typeof event.action === 'string' ? event.action : 'unknown',
      entity_type: typeof event.entity_type === 'string' ? event.entity_type : 'unknown',
      entity_id: typeof event.entity_id === 'string' ? event.entity_id : null,
      summary: typeof event.summary === 'string' ? event.summary : null,
      details: isRecord(event.details) ? event.details : null,
      created_at: typeof event.created_at === 'string' ? event.created_at : new Date(0).toISOString(),
    };

    if (options.entityType && normalized.entity_type !== options.entityType) continue;
    if (options.entityId && normalized.entity_id !== options.entityId) continue;
    if (options.action && normalized.action !== options.action) continue;

    events.push(normalized);
  }

  return events;
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
  const createdAt = new Date().toISOString();
  const reminder: InvoiceReminder = {
    id: `${createdAt}-${randomId()}`,
    invoice_id: input.invoiceId,
    owner_id: input.ownerId,
    actor_user_id: input.actorUserId,
    channel: input.channel,
    recipient: input.recipient ?? null,
    note: input.note ?? null,
    status: input.status ?? 'sent',
    sent_at: (input.status ?? 'sent') === 'sent' ? createdAt : null,
    created_at: createdAt,
  };

  const localKey = `${input.invoiceId}:${reminder.id}`;
  const key = tenantScopedKey(input.ownerId, TENANT_NAMESPACES.reminder, localKey);

  await prisma.meta.create({
    data: {
      key,
      value: reminder as unknown as Prisma.InputJsonValue,
    },
  });

  return reminder;
}

export async function listInvoiceReminders(ownerId: string, invoiceId?: string): Promise<InvoiceReminder[]> {
  const prefix = invoiceId
    ? tenantScopedKey(ownerId, TENANT_NAMESPACES.reminder, `${invoiceId}:`)
    : tenantNamespacePrefix(ownerId, TENANT_NAMESPACES.reminder);

  const rows = await prisma.meta.findMany({
    where: {
      key: { startsWith: prefix },
    },
    orderBy: { key: 'desc' },
    take: 500,
  });

  const reminders: InvoiceReminder[] = [];

  for (const row of rows) {
    if (!isRecord(row.value)) continue;
    const record = row.value as Record<string, unknown>;

    const invoiceIdFromRecord = typeof record.invoice_id === 'string' ? record.invoice_id : null;
    if (!invoiceIdFromRecord) continue;

    reminders.push({
      id: typeof record.id === 'string' ? record.id : row.key,
      invoice_id: invoiceIdFromRecord,
      owner_id: typeof record.owner_id === 'string' ? record.owner_id : ownerId,
      actor_user_id: typeof record.actor_user_id === 'string' ? record.actor_user_id : '',
      channel: typeof record.channel === 'string' ? record.channel : 'email',
      recipient: typeof record.recipient === 'string' ? record.recipient : null,
      note: typeof record.note === 'string' ? record.note : null,
      status: record.status === 'pending' || record.status === 'cancelled' ? record.status : 'sent',
      sent_at: typeof record.sent_at === 'string' ? record.sent_at : null,
      created_at: typeof record.created_at === 'string' ? record.created_at : new Date(0).toISOString(),
    });
  }

  return reminders;
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
