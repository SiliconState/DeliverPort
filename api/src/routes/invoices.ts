import { Hono } from 'hono';
import { prisma } from '../db.js';
import { authMiddleware } from '../middleware.js';

const invoices = new Hono();

invoices.use('*', authMiddleware);

/**
 * GET /api/invoices
 * List all invoices owned by the current user.
 * Optional query params: ?client_id=&project_id=&status=
 */
invoices.get('/', async (c) => {
  const { userId } = c.get('user');
  const clientId = c.req.query('client_id');
  const projectId = c.req.query('project_id');
  const status = c.req.query('status');

  const where: Record<string, unknown> = { owner_id: userId };
  if (clientId) where.client_id = clientId;
  if (projectId) where.project_id = projectId;
  if (status) where.status = status;

  const records = await prisma.invoice.findMany({
    where,
    include: {
      client: { select: { id: true, name: true, company: true } },
      project: { select: { id: true, name: true } },
    },
    orderBy: { issued_at: 'desc' },
  });

  return c.json({ invoices: records });
});

/**
 * POST /api/invoices
 * Create a new invoice.
 */
invoices.post('/', async (c) => {
  const { userId } = c.get('user');
  const body = await c.req.json();

  const invoice = await prisma.invoice.create({
    data: {
      id: body.id || undefined,
      client_id: body.client_id || null,
      project_id: body.project_id || null,
      status: body.status || 'draft',
      line_items: body.line_items || [],
      total: body.total || 0,
      currency: body.currency || 'USD',
      payment_rail: body.payment_rail || 'USDC (Base)',
      payment_address: body.payment_address || null,
      chain: body.chain || 'base',
      token: body.token || 'USDC',
      tx_hash: body.tx_hash || null,
      due_days: body.due_days ?? 14,
      notes: body.notes || '',
      owner_id: userId,
    },
  });

  return c.json({ invoice }, 201);
});

/**
 * GET /api/invoices/:id
 */
invoices.get('/:id', async (c) => {
  const { userId } = c.get('user');
  const id = c.req.param('id');

  const invoice = await prisma.invoice.findFirst({
    where: { id, owner_id: userId },
    include: {
      client: { select: { id: true, name: true, company: true, email: true } },
      project: { select: { id: true, name: true } },
    },
  });

  if (!invoice) {
    return c.json({ error: 'Invoice not found' }, 404);
  }

  return c.json({ invoice });
});

/**
 * PUT /api/invoices/:id
 */
invoices.put('/:id', async (c) => {
  const { userId } = c.get('user');
  const id = c.req.param('id');
  const body = await c.req.json();

  const existing = await prisma.invoice.findFirst({
    where: { id, owner_id: userId },
  });

  if (!existing) {
    return c.json({ error: 'Invoice not found' }, 404);
  }

  const invoice = await prisma.invoice.update({
    where: { id },
    data: {
      client_id: body.client_id ?? existing.client_id,
      project_id: body.project_id ?? existing.project_id,
      line_items: body.line_items ?? existing.line_items,
      total: body.total ?? existing.total,
      currency: body.currency ?? existing.currency,
      payment_rail: body.payment_rail ?? existing.payment_rail,
      payment_address: body.payment_address ?? existing.payment_address,
      chain: body.chain ?? existing.chain,
      token: body.token ?? existing.token,
      tx_hash: body.tx_hash ?? existing.tx_hash,
      due_days: body.due_days ?? existing.due_days,
      notes: body.notes ?? existing.notes,
    },
  });

  return c.json({ invoice });
});

/**
 * PUT /api/invoices/:id/status
 * Change invoice status: draft → sent → paid
 */
invoices.put('/:id/status', async (c) => {
  const { userId } = c.get('user');
  const id = c.req.param('id');
  const body = await c.req.json();
  const { status, tx_hash } = body;

  const existing = await prisma.invoice.findFirst({
    where: { id, owner_id: userId },
  });

  if (!existing) {
    return c.json({ error: 'Invoice not found' }, 404);
  }

  // Validate status transitions
  const validTransitions: Record<string, string[]> = {
    draft: ['sent', 'cancelled'],
    sent: ['paid', 'cancelled', 'draft'],
    paid: [],
    cancelled: ['draft'],
  };

  const allowed = validTransitions[existing.status] || [];
  if (!allowed.includes(status)) {
    return c.json({
      error: `Cannot transition from '${existing.status}' to '${status}'`,
    }, 400);
  }

  const updateData: Record<string, unknown> = { status };
  if (status === 'paid') {
    updateData.paid_at = new Date();
    if (tx_hash) updateData.tx_hash = tx_hash;
  }

  const invoice = await prisma.invoice.update({
    where: { id },
    data: updateData,
  });

  return c.json({ invoice });
});

/**
 * DELETE /api/invoices/:id
 */
invoices.delete('/:id', async (c) => {
  const { userId } = c.get('user');
  const id = c.req.param('id');

  const existing = await prisma.invoice.findFirst({
    where: { id, owner_id: userId },
  });

  if (!existing) {
    return c.json({ error: 'Invoice not found' }, 404);
  }

  if (existing.status === 'paid') {
    return c.json({ error: 'Cannot delete a paid invoice' }, 400);
  }

  await prisma.invoice.delete({ where: { id } });

  return c.json({ success: true });
});

export default invoices;
