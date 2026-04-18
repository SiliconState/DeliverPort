import { Hono } from 'hono';
import { prisma } from '../db.js';
import { authMiddleware } from '../middleware.js';

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
  const { userId } = c.get('user');
  const body = await c.req.json();

  const run = await prisma.payoutRun.create({
    data: {
      id: body.id || undefined,
      status: body.status || 'draft',
      entries: body.entries || [],
      total: body.total || 0,
      currency: body.currency || 'USD',
      payment_rail: body.payment_rail || 'USDC (Base)',
      notes: body.notes || '',
      owner_id: userId,
    },
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
  const { userId } = c.get('user');
  const id = c.req.param('id');
  const body = await c.req.json();

  const existing = await prisma.payoutRun.findFirst({
    where: { id, owner_id: userId },
  });

  if (!existing) {
    return c.json({ error: 'Payout run not found' }, 404);
  }

  const run = await prisma.payoutRun.update({
    where: { id },
    data: {
      status: body.status ?? existing.status,
      entries: body.entries ?? existing.entries,
      total: body.total ?? existing.total,
      currency: body.currency ?? existing.currency,
      payment_rail: body.payment_rail ?? existing.payment_rail,
      notes: body.notes ?? existing.notes,
      completed_at: body.status === 'completed' ? new Date() : existing.completed_at,
    },
  });

  return c.json({ payout_run: run });
});

/**
 * DELETE /api/payout-runs/:id
 */
payoutRuns.delete('/:id', async (c) => {
  const { userId } = c.get('user');
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

  return c.json({ success: true });
});

export default payoutRuns;
