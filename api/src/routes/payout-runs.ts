import { Hono } from 'hono';
import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { authMiddleware } from '../middleware.js';
import {
  isOptionalString,
  parseJsonObjectBody,
  toFiniteNumber,
  validationError,
  type ValidationIssue,
} from '../validation.js';
import { safeLogAuditEvent } from '../audit-log.js';

const payoutRuns = new Hono();

payoutRuns.use('*', authMiddleware);

/**
 * GET /api/payout-runs
 * List all payout runs owned by the current user.
 */
payoutRuns.get('/', async (c) => {
  const { userId } = c.get('user');

  const records = await prisma.payoutRun.findMany({
    where: { owner_id: userId },
    orderBy: { created_at: 'desc' },
  });

  return c.json({ payout_runs: records });
});

/**
 * POST /api/payout-runs
 * Create a new payout run.
 */
payoutRuns.post('/', async (c) => {
  const { userId, role } = c.get('user');
  const parsed = await parseJsonObjectBody(c);
  if (!parsed.ok) return parsed.response;

  const body = parsed.body;
  const issues: ValidationIssue[] = [];

  for (const field of ['id', 'status', 'currency', 'payment_rail', 'notes'] as const) {
    if (!isOptionalString(body[field])) {
      issues.push({ field, message: `${field} must be a string when provided` });
    }
  }

  if (body.entries !== undefined && !Array.isArray(body.entries)) {
    issues.push({ field: 'entries', message: 'entries must be an array when provided' });
  }

  const total = body.total === undefined ? null : toFiniteNumber(body.total);
  if (body.total !== undefined && total === null) {
    issues.push({ field: 'total', message: 'total must be a finite number when provided' });
  }

  if (issues.length > 0) {
    return validationError(c, issues);
  }

  const run = await prisma.payoutRun.create({
    data: {
      id: typeof body.id === 'string' && body.id.trim() ? body.id.trim() : undefined,
      status: typeof body.status === 'string' && body.status.trim() ? body.status.trim() : 'draft',
      entries: ((body.entries as unknown[]) ?? []) as Prisma.InputJsonValue,
      total: total ?? 0,
      currency: typeof body.currency === 'string' && body.currency.trim() ? body.currency.trim() : 'USD',
      payment_rail: typeof body.payment_rail === 'string' && body.payment_rail.trim()
        ? body.payment_rail.trim()
        : 'USDC (Base)',
      notes: typeof body.notes === 'string' ? body.notes : '',
      owner_id: userId,
    },
  });

  await safeLogAuditEvent({
    ownerId: userId,
    actorId: userId,
    actorRole: role,
    action: 'payout_run.create',
    entityType: 'payout_run',
    entityId: run.id,
    summary: 'Payout run created',
  });

  return c.json({ payout_run: run }, 201);
});

/**
 * GET /api/payout-runs/:id
 */
payoutRuns.get('/:id', async (c) => {
  const { userId } = c.get('user');
  const id = c.req.param('id');

  const run = await prisma.payoutRun.findFirst({
    where: { id, owner_id: userId },
  });

  if (!run) {
    return c.json({ error: 'Payout run not found' }, 404);
  }

  return c.json({ payout_run: run });
});

/**
 * PUT /api/payout-runs/:id
 */
payoutRuns.put('/:id', async (c) => {
  const { userId, role } = c.get('user');
  const id = c.req.param('id');
  const parsed = await parseJsonObjectBody(c);
  if (!parsed.ok) return parsed.response;

  const body = parsed.body;
  const issues: ValidationIssue[] = [];

  for (const field of ['status', 'currency', 'payment_rail', 'notes'] as const) {
    if (!isOptionalString(body[field])) {
      issues.push({ field, message: `${field} must be a string when provided` });
    }
  }

  if (body.entries !== undefined && !Array.isArray(body.entries)) {
    issues.push({ field: 'entries', message: 'entries must be an array when provided' });
  }

  const total = body.total === undefined ? null : toFiniteNumber(body.total);
  if (body.total !== undefined && total === null) {
    issues.push({ field: 'total', message: 'total must be a finite number when provided' });
  }

  if (issues.length > 0) {
    return validationError(c, issues);
  }

  const existing = await prisma.payoutRun.findFirst({
    where: { id, owner_id: userId },
  });

  if (!existing) {
    return c.json({ error: 'Payout run not found' }, 404);
  }

  const run = await prisma.payoutRun.update({
    where: { id },
    data: {
      status: typeof body.status === 'string' && body.status.trim() ? body.status.trim() : existing.status,
      entries: body.entries !== undefined
        ? (body.entries as Prisma.InputJsonValue)
        : (existing.entries === null ? Prisma.JsonNull : (existing.entries as Prisma.InputJsonValue)),
      total: total ?? existing.total,
      currency: typeof body.currency === 'string' && body.currency.trim() ? body.currency.trim() : existing.currency,
      payment_rail: typeof body.payment_rail === 'string' && body.payment_rail.trim()
        ? body.payment_rail.trim()
        : existing.payment_rail,
      notes: typeof body.notes === 'string' ? body.notes : existing.notes,
      completed_at: body.status === 'completed' ? new Date() : existing.completed_at,
    },
  });

  await safeLogAuditEvent({
    ownerId: userId,
    actorId: userId,
    actorRole: role,
    action: 'payout_run.update',
    entityType: 'payout_run',
    entityId: run.id,
    summary: 'Payout run updated',
  });

  return c.json({ payout_run: run });
});

/**
 * DELETE /api/payout-runs/:id
 */
payoutRuns.delete('/:id', async (c) => {
  const { userId, role } = c.get('user');
  const id = c.req.param('id');

  const existing = await prisma.payoutRun.findFirst({
    where: { id, owner_id: userId },
  });

  if (!existing) {
    return c.json({ error: 'Payout run not found' }, 404);
  }

  if (existing.status === 'completed') {
    return c.json({ error: 'Cannot delete a completed payout run' }, 400);
  }

  await prisma.payoutRun.delete({ where: { id } });

  await safeLogAuditEvent({
    ownerId: userId,
    actorId: userId,
    actorRole: role,
    action: 'payout_run.delete',
    entityType: 'payout_run',
    entityId: id,
    summary: 'Payout run deleted',
  });

  return c.json({ success: true });
});

export default payoutRuns;
