import { Hono } from 'hono';
import { prisma } from '../db.js';
import { authMiddleware } from '../middleware.js';

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
  const { userId } = c.get('user');
  const body = await c.req.json();

  const client = await prisma.client.create({
    data: {
      id: body.id || undefined,
      name: body.name,
      company: body.company || null,
      email: body.email || null,
      country: body.country || '',
      billing_currency: body.billing_currency || 'USD',
      status: body.status || 'active',
      notes: body.notes || '',
      owner_id: userId,
    },
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
  const { userId } = c.get('user');
  const id = c.req.param('id');
  const body = await c.req.json();

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
      name: body.name ?? existing.name,
      company: body.company ?? existing.company,
      email: body.email ?? existing.email,
      country: body.country ?? existing.country,
      billing_currency: body.billing_currency ?? existing.billing_currency,
      status: body.status ?? existing.status,
      notes: body.notes ?? existing.notes,
    },
  });

  return c.json({ client });
});

/**
 * DELETE /api/clients/:id
 * Delete a client (must be owned by current user).
 */
clients.delete('/:id', async (c) => {
  const { userId } = c.get('user');
  const id = c.req.param('id');

  const existing = await prisma.client.findFirst({
    where: { id, owner_id: userId },
  });

  if (!existing) {
    return c.json({ error: 'Client not found' }, 404);
  }

  await prisma.client.delete({ where: { id } });

  return c.json({ success: true });
});

export default clients;
