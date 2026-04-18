import { Hono } from 'hono';
import { authMiddleware } from '../middleware.js';
import { listAuditEvents } from '../audit-log.js';
import { clampInt } from '../validation.js';

const audit = new Hono();

audit.use('*', authMiddleware);

/**
 * GET /api/audit/timeline
 * Operator-only audit timeline for the authenticated workspace owner.
 */
audit.get('/timeline', async (c) => {
  const auth = c.get('user');

  if (auth.role !== 'operator') {
    return c.json({ error: 'Operator access required' }, 403);
  }

  const limit = clampInt(c.req.query('limit'), 100, 1, 500);
  const eventType = c.req.query('event_type')?.trim() || undefined;
  const entityType = c.req.query('entity_type')?.trim() || undefined;
  const entityId = c.req.query('entity_id')?.trim() || undefined;

  const events = await listAuditEvents(auth.userId, {
    limit,
    action: eventType,
    entityType,
    entityId,
  });

  const timeline = events.map((event) => ({
    id: event.id,
    owner_id: event.owner_id,
    actor_user_id: event.actor_id ?? auth.userId,
    actor_role: event.actor_role,
    event_type: event.action,
    entity_type: event.entity_type,
    entity_id: event.entity_id,
    message: event.summary ?? event.action,
    metadata: event.details ?? {},
    created_at: event.created_at,
  }));

  return c.json({
    events: timeline,
    count: timeline.length,
    filters: {
      limit,
      event_type: eventType ?? null,
      entity_type: entityType ?? null,
      entity_id: entityId ?? null,
    },
  });
});

export default audit;
