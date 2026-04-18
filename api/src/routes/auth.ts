import { Hono } from 'hono';
import { prisma } from '../db.js';
import { hashPassword, verifyPassword, signToken } from '../auth.js';
import { authMiddleware } from '../middleware.js';
import {
  checkLoginRateLimit,
  checkRegisterRateLimit,
  clearLoginFailures,
  getClientIp,
  recordLoginFailure,
} from '../security.js';
import {
  isOptionalString,
  isValidEmail,
  normalizeEmail,
  parseJsonObjectBody,
  validationError,
  type ValidationIssue,
} from '../validation.js';
import { safeLogAuditEvent } from '../audit-log.js';

const auth = new Hono();

/**
 * POST /api/auth/register
 * Create a new user account and return a JWT.
 */
auth.post('/register', async (c) => {
  const parsed = await parseJsonObjectBody(c);
  if (!parsed.ok) return parsed.response;

  const body = parsed.body;
  const issues: ValidationIssue[] = [];

  const email = normalizeEmail(body.email);
  if (!email || !isValidEmail(email)) {
    issues.push({ field: 'email', message: 'A valid email is required' });
  }

  if (typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 256) {
    issues.push({ field: 'password', message: 'Password must be between 8 and 256 characters' });
  }

  if (!isOptionalString(body.name)) {
    issues.push({ field: 'name', message: 'Name must be a string when provided' });
  }

  if (!isOptionalString(body.wallet_address)) {
    issues.push({ field: 'wallet_address', message: 'wallet_address must be a string when provided' });
  }

  const validRoles = ['operator', 'client'] as const;
  if (!isOptionalString(body.role)) {
    issues.push({ field: 'role', message: "role must be 'operator' or 'client'" });
  }

  const requestedRole = typeof body.role === 'string' ? body.role.trim().toLowerCase() : '';
  if (requestedRole && !validRoles.includes(requestedRole as (typeof validRoles)[number])) {
    issues.push({ field: 'role', message: "role must be 'operator' or 'client'" });
  }

  if (issues.length > 0 || !email || typeof body.password !== 'string') {
    return validationError(c, issues);
  }

  const ip = getClientIp(c);
  const registerLimit = checkRegisterRateLimit(ip, email);
  if (!registerLimit.allowed) {
    return c.json({
      error: 'Too many registration attempts. Please try again later.',
      retry_after_seconds: registerLimit.retryAfterSeconds ?? 60,
    }, 429);
  }

  // Check for existing user
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return c.json({ error: 'Email already registered' }, 409);
  }

  const userRole = requestedRole || 'operator';

  const user = await prisma.user.create({
    data: {
      name: typeof body.name === 'string' ? body.name.trim() || null : null,
      email,
      password_hash: hashPassword(body.password),
      role: userRole,
      wallet_address: typeof body.wallet_address === 'string' ? body.wallet_address.trim() || null : null,
    },
  });

  await safeLogAuditEvent({
    ownerId: user.id,
    actorId: user.id,
    actorRole: user.role,
    action: 'auth.register',
    entityType: 'user',
    entityId: user.id,
    summary: 'User account created',
    details: { email: user.email },
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
  const parsed = await parseJsonObjectBody(c);
  if (!parsed.ok) return parsed.response;

  const body = parsed.body;
  const issues: ValidationIssue[] = [];

  const email = normalizeEmail(body.email);
  if (!email || !isValidEmail(email)) {
    issues.push({ field: 'email', message: 'A valid email is required' });
  }

  if (typeof body.password !== 'string' || body.password.length === 0) {
    issues.push({ field: 'password', message: 'Password is required' });
  }

  if (issues.length > 0 || !email || typeof body.password !== 'string') {
    return validationError(c, issues);
  }

  const ip = getClientIp(c);
  const loginLimit = checkLoginRateLimit(ip, email);
  if (!loginLimit.allowed) {
    return c.json({
      error: 'Too many login attempts. Please slow down and retry.',
      retry_after_seconds: loginLimit.retryAfterSeconds ?? 1,
    }, 429);
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.password_hash) {
    const retryAfter = recordLoginFailure(ip, email);
    return c.json({
      error: 'Invalid email or password',
      retry_after_seconds: retryAfter || undefined,
    }, 401);
  }

  if (user.auth_status !== 'active') {
    const retryAfter = recordLoginFailure(ip, email);
    return c.json({
      error: 'Account is not active',
      retry_after_seconds: retryAfter || undefined,
    }, 403);
  }

  const valid = verifyPassword(body.password, user.password_hash);
  if (!valid) {
    const retryAfter = recordLoginFailure(ip, email);
    return c.json({
      error: 'Invalid email or password',
      retry_after_seconds: retryAfter || undefined,
    }, 401);
  }

  clearLoginFailures(ip, email);

  // Update last login
  await prisma.user.update({
    where: { id: user.id },
    data: { last_login_at: new Date() },
  });

  await safeLogAuditEvent({
    ownerId: user.id,
    actorId: user.id,
    actorRole: user.role,
    action: 'auth.login',
    entityType: 'user',
    entityId: user.id,
    summary: 'User logged in',
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
