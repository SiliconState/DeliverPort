import { Hono } from 'hono';
import { prisma } from '../db.js';
import { authMiddleware } from '../middleware.js';
import {
  isOptionalString,
  parseJsonObjectBody,
  validationError,
  type ValidationIssue,
} from '../validation.js';
import { safeLogAuditEvent } from '../audit-log.js';

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
  const { userId, role } = c.get('user');
  const id = c.req.param('id');

  const parsed = await parseJsonObjectBody(c);
  if (!parsed.ok) return parsed.response;

  const body = parsed.body;
  const issues: ValidationIssue[] = [];

  for (const field of ['name', 'wallet_address', 'phone'] as const) {
    if (!isOptionalString(body[field])) {
      issues.push({ field, message: `${field} must be a string when provided` });
    }
  }

  if (issues.length > 0) {
    return validationError(c, issues);
  }

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
      name: body.name === null
        ? null
        : (typeof body.name === 'string' ? body.name.trim() || null : target.name),
      wallet_address: body.wallet_address === null
        ? null
        : (typeof body.wallet_address === 'string' ? body.wallet_address.trim() || null : target.wallet_address),
      phone: body.phone === null
        ? null
        : (typeof body.phone === 'string' ? body.phone.trim() || null : target.phone),
    },
    select: {
      id: true, name: true, email: true, role: true,
      wallet_address: true, phone: true, auth_status: true,
      client_id: true, joined_at: true, last_login_at: true,
    },
  });

  await safeLogAuditEvent({
    ownerId: userId,
    actorId: userId,
    actorRole: role,
    action: 'user.update',
    entityType: 'user',
    entityId: user.id,
    summary: 'User profile updated',
  });

  return c.json({ user });
});

export default users;
