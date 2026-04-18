import { Hono } from 'hono';
import { prisma } from '../db.js';
import { authMiddleware } from '../middleware.js';
import {
  isOptionalString,
  isValidEmail,
  normalizeEmail,
  parseJsonObjectBody,
  validationError,
  type ValidationIssue,
} from '../validation.js';
import { safeLogAuditEvent } from '../audit-log.js';

const clients = new Hono();

// All routes require authentication
clients.use('*', authMiddleware);

/**
 * GET /api/clients
 * List all clients owned by the current user.
 */
clients.get('/', async (c) => {
  const { userId } = c.get('user');

  const records = await prisma.client.findMany({
    where: { owner_id: userId },
    orderBy: { created_at: 'desc' },
  });

  return c.json({ clients: records });
});

/**
 * POST /api/clients
 * Create a new client.
 */
clients.post('/', async (c) => {
  const { userId, role } = c.get('user');
  const parsed = await parseJsonObjectBody(c);
  if (!parsed.ok) return parsed.response;

  const body = parsed.body;
  const issues: ValidationIssue[] = [];

  if (typeof body.name !== 'string' || body.name.trim().length === 0 || body.name.trim().length > 160) {
    issues.push({ field: 'name', message: 'name is required (1-160 characters)' });
  }

  const email = normalizeEmail(body.email);
  if (body.email !== undefined && body.email !== null && (!email || !isValidEmail(email))) {
    issues.push({ field: 'email', message: 'email must be valid when provided' });
  }

  for (const field of ['id', 'company', 'country', 'billing_currency', 'status', 'notes'] as const) {
    if (!isOptionalString(body[field])) {
      issues.push({ field, message: `${field} must be a string when provided` });
    }
  }

  if (issues.length > 0 || typeof body.name !== 'string') {
    return validationError(c, issues);
  }

  const client = await prisma.client.create({
    data: {
      id: typeof body.id === 'string' && body.id.trim() ? body.id.trim() : undefined,
      name: body.name.trim(),
      company: typeof body.company === 'string' ? body.company.trim() || null : null,
      email,
      country: typeof body.country === 'string' ? body.country.trim() : '',
      billing_currency: typeof body.billing_currency === 'string' && body.billing_currency.trim()
        ? body.billing_currency.trim()
        : 'USD',
      status: typeof body.status === 'string' && body.status.trim() ? body.status.trim() : 'active',
      notes: typeof body.notes === 'string' ? body.notes : '',
      owner_id: userId,
    },
  });

  await safeLogAuditEvent({
    ownerId: userId,
    actorId: userId,
    actorRole: role,
    action: 'client.create',
    entityType: 'client',
    entityId: client.id,
    summary: 'Client created',
  });

  return c.json({ client }, 201);
});

/**
 * GET /api/clients/:id
 * Get a single client by ID (must be owned by current user).
 */
clients.get('/:id', async (c) => {
  const { userId } = c.get('user');
  const id = c.req.param('id');

  const client = await prisma.client.findFirst({
    where: { id, owner_id: userId },
  });

  if (!client) {
    return c.json({ error: 'Client not found' }, 404);
  }

  return c.json({ client });
});

/**
 * PUT /api/clients/:id
 * Update a client.
 */
clients.put('/:id', async (c) => {
  const { userId, role } = c.get('user');
  const id = c.req.param('id');
  const parsed = await parseJsonObjectBody(c);
  if (!parsed.ok) return parsed.response;

  const body = parsed.body;
  const issues: ValidationIssue[] = [];

  if (body.name !== undefined && (typeof body.name !== 'string' || body.name.trim().length === 0 || body.name.trim().length > 160)) {
    issues.push({ field: 'name', message: 'name must be 1-160 characters when provided' });
  }

  const email = normalizeEmail(body.email);
  if (body.email !== undefined && body.email !== null && (!email || !isValidEmail(email))) {
    issues.push({ field: 'email', message: 'email must be valid when provided' });
  }

  for (const field of ['company', 'country', 'billing_currency', 'status', 'notes'] as const) {
    if (!isOptionalString(body[field])) {
      issues.push({ field, message: `${field} must be a string when provided` });
    }
  }

  if (issues.length > 0) {
    return validationError(c, issues);
  }

  // Verify ownership
  const existing = await prisma.client.findFirst({
    where: { id, owner_id: userId },
  });

  if (!existing) {
    return c.json({ error: 'Client not found' }, 404);
  }

  const client = await prisma.client.update({
    where: { id },
    data: {
      name: typeof body.name === 'string' ? body.name.trim() : existing.name,
      company: body.company === null ? null : (typeof body.company === 'string' ? body.company.trim() || null : existing.company),
      email: body.email === null ? null : (body.email === undefined ? existing.email : email),
      country: typeof body.country === 'string' ? body.country.trim() : existing.country,
      billing_currency: typeof body.billing_currency === 'string'
        ? (body.billing_currency.trim() || existing.billing_currency)
        : existing.billing_currency,
      status: typeof body.status === 'string' ? (body.status.trim() || existing.status) : existing.status,
      notes: typeof body.notes === 'string' ? body.notes : existing.notes,
    },
  });

  await safeLogAuditEvent({
    ownerId: userId,
    actorId: userId,
    actorRole: role,
    action: 'client.update',
    entityType: 'client',
    entityId: client.id,
    summary: 'Client updated',
  });

  return c.json({ client });
});

/**
 * DELETE /api/clients/:id
 * Delete a client (must be owned by current user).
 */
clients.delete('/:id', async (c) => {
  const { userId, role } = c.get('user');
  const id = c.req.param('id');

  const existing = await prisma.client.findFirst({
    where: { id, owner_id: userId },
  });

  if (!existing) {
    return c.json({ error: 'Client not found' }, 404);
  }

  await prisma.client.delete({ where: { id } });

  await safeLogAuditEvent({
    ownerId: userId,
    actorId: userId,
    actorRole: role,
    action: 'client.delete',
    entityType: 'client',
    entityId: id,
    summary: 'Client deleted',
  });

  return c.json({ success: true });
});

export default clients;
