import { Hono } from 'hono';
import { authMiddleware } from '../middleware.js';
import { listAuditEvents as listAuditEventsV2 } from '../audit-log.js';
import { listAuditEvents as listLegacyAuditEvents } from '../audit.js';

const auditEvents = new Hono();

auditEvents.use('*', authMiddleware);

/**
 * GET /api/audit-events
 * List recent audit timeline entries for the authenticated operator.
 */
auditEvents.get('/', async (c) => {
  const { userId, role } = c.get('user');

  if (role !== 'operator') {
    return c.json({ error: 'Only operators can access audit events' }, 403);
  }

  const limitParam = c.req.query('limit');
  const entityType = c.req.query('entity_type')?.trim();
  const entityId = c.req.query('entity_id')?.trim();
  const action = c.req.query('action')?.trim() || c.req.query('event_type')?.trim();

  if (limitParam && !/^\d+$/.test(limitParam)) {
    return c.json({ error: 'limit must be a positive integer' }, 400);
  }

  const limit = limitParam ? Number.parseInt(limitParam, 10) : 100;
  const fetchLimit = Math.min(Math.max(limit, 1), 300);

  const [eventsV2, legacyEvents] = await Promise.all([
    listAuditEventsV2(userId, {
      limit: fetchLimit,
      entityType: entityType || undefined,
      entityId: entityId || undefined,
      action: action || undefined,
    }),
    listLegacyAuditEvents(userId, {
      limit: fetchLimit,
      entityType: entityType || undefined,
      entityId: entityId || undefined,
      eventType: action || undefined,
    }),
  ]);

  const normalized = [
    ...eventsV2.map((event) => ({
      ...event,
      event_type: event.action,
      message: event.summary,
      metadata: event.details,
    })),
    ...legacyEvents.map((event) => ({
      id: event.id,
      owner_id: event.owner_id,
      actor_id: event.actor_user_id,
      actor_role: event.actor_role,
      action: event.event_type,
      event_type: event.event_type,
      entity_type: event.entity_type,
      entity_id: event.entity_id,
      summary: event.message,
      message: event.message,
      details: event.metadata,
      metadata: event.metadata,
      created_at: event.created_at,
    })),
  ];

  normalized.sort((a, b) => b.created_at.localeCompare(a.created_at));

  const deduped = new Map<string, (typeof normalized)[number]>();
  for (const event of normalized) {
    if (!deduped.has(event.id)) {
      deduped.set(event.id, event);
    }
  }

  const events = Array.from(deduped.values()).slice(0, fetchLimit);

  return c.json({ events });
});

export default auditEvents;
