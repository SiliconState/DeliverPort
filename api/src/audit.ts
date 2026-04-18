import { randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from './db.js';

const AUDIT_KEY_PREFIX = 'audit:';
const LEGACY_AUDIT_KEY_PREFIX = 'u:';
const DEFAULT_TIMELINE_LIMIT = 100;
const MAX_TIMELINE_LIMIT = 500;

export interface AuditEvent {
  id: string;
  owner_id: string;
  actor_user_id: string;
  actor_role: string;
  event_type: string;
  entity_type: string;
  entity_id: string | null;
  message: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface LogAuditEventInput {
  ownerId: string;
  actorUserId: string;
  actorRole: string;
  eventType: string;
  entityType: string;
  entityId?: string | null;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface AuditTimelineOptions {
  limit?: number;
  eventType?: string;
  entityType?: string;
  entityId?: string;
}

function isJsonObject(value: Prisma.JsonValue): value is Prisma.JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toStringField(value: Prisma.JsonValue | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

function toObjectField(value: Prisma.JsonValue | undefined): Record<string, unknown> {
  if (!value || !isJsonObject(value)) return {};
  return value as Record<string, unknown>;
}

function toAuditEvent(value: Prisma.JsonValue): AuditEvent | null {
  if (!isJsonObject(value)) return null;

  const id = toStringField(value.id);
  const ownerId = toStringField(value.owner_id);
  const actorUserId = toStringField(value.actor_user_id) ?? toStringField(value.actor_id);
  const actorRole = toStringField(value.actor_role);
  const eventType = toStringField(value.event_type) ?? toStringField(value.action);
  const entityType = toStringField(value.entity_type);
  const message = toStringField(value.message) ?? toStringField(value.summary) ?? eventType;
  const createdAt = toStringField(value.created_at);

  if (!id || !ownerId || !eventType || !entityType || !createdAt) {
    return null;
  }

  const entityIdValue = value.entity_id;
  const entityId = typeof entityIdValue === 'string' ? entityIdValue : null;

  return {
    id,
    owner_id: ownerId,
    actor_user_id: actorUserId ?? ownerId,
    actor_role: actorRole ?? 'unknown',
    event_type: eventType,
    entity_type: entityType,
    entity_id: entityId,
    message: message ?? eventType,
    metadata: toObjectField(value.metadata ?? value.details),
    created_at: createdAt,
  };
}

/**
 * Persist an immutable audit event in Meta storage without schema migration.
 */
export async function logAuditEvent(input: LogAuditEventInput): Promise<AuditEvent> {
  const createdAt = new Date().toISOString();
  const event: AuditEvent = {
    id: randomUUID(),
    owner_id: input.ownerId,
    actor_user_id: input.actorUserId,
    actor_role: input.actorRole,
    event_type: input.eventType,
    entity_type: input.entityType,
    entity_id: input.entityId ?? null,
    message: input.message,
    metadata: input.metadata || {},
    created_at: createdAt,
  };

  const key = `${AUDIT_KEY_PREFIX}${input.ownerId}:${createdAt}:${event.id}`;

  await prisma.meta.create({
    data: {
      key,
      value: event as unknown as Prisma.InputJsonValue,
    },
  });

  return event;
}

/**
 * Read audit timeline for an owner with basic filtering.
 */
export async function listAuditEvents(ownerId: string, options: AuditTimelineOptions = {}): Promise<AuditEvent[]> {
  const requestedLimit = options.limit ?? DEFAULT_TIMELINE_LIMIT;
  const limit = Math.min(MAX_TIMELINE_LIMIT, Math.max(1, requestedLimit));
  const primaryPrefix = `${AUDIT_KEY_PREFIX}${ownerId}:`;
  const legacyPrefix = `${LEGACY_AUDIT_KEY_PREFIX}${ownerId}:audit:`;

  const records = await prisma.meta.findMany({
    where: {
      OR: [
        {
          key: {
            startsWith: primaryPrefix,
          },
        },
        {
          key: {
            startsWith: legacyPrefix,
          },
        },
      ],
    },
    orderBy: {
      key: 'desc',
    },
    take: Math.min(MAX_TIMELINE_LIMIT, Math.max(limit, limit * 8)),
  });

  const events = records
    .map((record) => toAuditEvent(record.value))
    .filter((event): event is AuditEvent => Boolean(event))
    .sort((left, right) => right.created_at.localeCompare(left.created_at))
    .filter((event) => {
      if (options.eventType && event.event_type !== options.eventType) return false;
      if (options.entityType && event.entity_type !== options.entityType) return false;
      if (options.entityId && event.entity_id !== options.entityId) return false;
      return true;
    })
    .slice(0, limit);

  return events;
}
