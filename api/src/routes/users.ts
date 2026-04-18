import { Hono } from 'hono';
import { prisma } from '../db.js';
import { authMiddleware } from '../middleware.js';

const users = new Hono();
users.use('*', authMiddleware);

/**
 * GET /api/users — list users visible to current operator
 * Returns the operator themselves + any client users linked to their clients
 */
users.get('/', async (c) => {
  const { userId } = c.get('user');

  const records = await prisma.user.findMany({
    where: {
      OR: [
        { id: userId },
        { client: { owner_id: userId } },
      ],
    },
    select: {
      id: true, name: true, email: true, role: true,
      wallet_address: true, phone: true, auth_status: true,
      client_id: true, joined_at: true, last_login_at: true,
    },
  });

  return c.json({ users: records });
});

/**
 * PUT /api/users/:id — update user profile (self only or own client users)
 */
users.put('/:id', async (c) => {
  const { userId } = c.get('user');
  const id = c.req.param('id');
  const body = await c.req.json();

  // Can only update self or users linked to own clients
  const target = await prisma.user.findFirst({
    where: {
      id,
      OR: [
        { id: userId },
        { client: { owner_id: userId } },
      ],
    },
  });

  if (!target) return c.json({ error: 'User not found' }, 404);

  const user = await prisma.user.update({
    where: { id },
    data: {
      name: body.name ?? target.name,
      wallet_address: body.wallet_address ?? target.wallet_address,
      phone: body.phone ?? target.phone,
    },
    select: {
      id: true, name: true, email: true, role: true,
      wallet_address: true, phone: true, auth_status: true,
      client_id: true, joined_at: true, last_login_at: true,
    },
  });

  return c.json({ user });
});

export default users;
