import { Hono } from 'hono';
import { prisma } from '../db.js';
import { hashPassword, verifyPassword, signToken } from '../auth.js';
import { authMiddleware } from '../middleware.js';

const auth = new Hono();

/**
 * POST /api/auth/register
 * Create a new user account and return a JWT.
 */
auth.post('/register', async (c) => {
  const body = await c.req.json();
  const { name, email, password, role, wallet_address } = body;

  if (!email || !password) {
    return c.json({ error: 'Email and password are required' }, 400);
  }

  // Check for existing user
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return c.json({ error: 'Email already registered' }, 409);
  }

  const validRoles = ['operator', 'client'];
  const userRole = validRoles.includes(role) ? role : 'operator';

  const user = await prisma.user.create({
    data: {
      name: name || null,
      email,
      password_hash: hashPassword(password),
      role: userRole,
      wallet_address: wallet_address || null,
    },
  });

  const token = signToken({ userId: user.id, email: user.email, role: user.role });

  return c.json({
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      wallet_address: user.wallet_address,
      joined_at: user.joined_at,
    },
  }, 201);
});

/**
 * POST /api/auth/login
 * Authenticate with email/password and return a JWT.
 */
auth.post('/login', async (c) => {
  const body = await c.req.json();
  const { email, password } = body;

  if (!email || !password) {
    return c.json({ error: 'Email and password are required' }, 400);
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.password_hash) {
    return c.json({ error: 'Invalid email or password' }, 401);
  }

  if (user.auth_status !== 'active') {
    return c.json({ error: 'Account is not active' }, 403);
  }

  const valid = verifyPassword(password, user.password_hash);
  if (!valid) {
    return c.json({ error: 'Invalid email or password' }, 401);
  }

  // Update last login
  await prisma.user.update({
    where: { id: user.id },
    data: { last_login_at: new Date() },
  });

  const token = signToken({ userId: user.id, email: user.email, role: user.role });

  return c.json({
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      wallet_address: user.wallet_address,
      joined_at: user.joined_at,
    },
  });
});

/**
 * GET /api/auth/me
 * Return the current authenticated user's profile.
 */
auth.get('/me', authMiddleware, async (c) => {
  const { userId } = c.get('user');

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      wallet_address: true,
      phone: true,
      auth_status: true,
      joined_at: true,
      last_login_at: true,
      client_id: true,
    },
  });

  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }

  return c.json({ user });
});

export default auth;
