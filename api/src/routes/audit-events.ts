import { Hono } from 'hono';
import { authMiddleware } from '../middleware.js';
import { listAuditEvents } from '../audit-log.js';

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

  const events = await listAuditEvents(userId, {
    limit: fetchLimit,
    entityType: entityType || undefined,
    entityId: entityId || undefined,
    action: action || undefined,
  });

  return c.json({
    events: events.map((event) => ({
      ...event,
      event_type: event.action,
      message: event.summary,
      metadata: event.details,
    })),
  });
});

export default auditEvents;
