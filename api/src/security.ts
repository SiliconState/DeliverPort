import { Context } from 'hono';

interface WindowCounter {
  count: number;
  windowStart: number;
}

interface LoginBackoffState {
  failures: number;
  lastFailureAt: number;
  lockedUntil: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
  reason?: string;
}

const requestWindows = new Map<string, WindowCounter>();
const loginBackoff = new Map<string, LoginBackoffState>();

const LOGIN_WINDOW_MS = 60_000;
const LOGIN_PER_IP_LIMIT = 25;
const LOGIN_PER_IDENTITY_LIMIT = 10;

const REGISTER_WINDOW_MS = 10 * 60_000;
const REGISTER_PER_IP_LIMIT = 8;
const REGISTER_PER_IDENTITY_LIMIT = 4;

const LOGIN_FAILURE_RESET_MS = 15 * 60_000;
const LOGIN_BACKOFF_BASE_MS = 1_000;
const LOGIN_BACKOFF_MAX_MS = 10 * 60_000;

const MAX_STATE_ENTRIES = 20_000;

function identityKey(ip: string, email: string): string {
  return `${ip}:${email.trim().toLowerCase()}`;
}

function consumeWindow(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const current = requestWindows.get(key);

  if (!current || now - current.windowStart >= windowMs) {
    requestWindows.set(key, { count: 1, windowStart: now });
    cleanupState(now);
    return { allowed: true };
  }

  if (current.count >= limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((windowMs - (now - current.windowStart)) / 1000));
    return {
      allowed: false,
      retryAfterSeconds,
      reason: 'rate_limited',
    };
  }

  current.count += 1;
  requestWindows.set(key, current);
  return { allowed: true };
}

function checkLoginBackoff(key: string): RateLimitResult {
  const now = Date.now();
  const state = loginBackoff.get(key);
  if (!state) return { allowed: true };

  if (now < state.lockedUntil) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((state.lockedUntil - now) / 1000)),
      reason: 'backoff',
    };
  }

  return { allowed: true };
}

function cleanupState(now: number): void {
  if (requestWindows.size > MAX_STATE_ENTRIES) {
    for (const [key, state] of requestWindows.entries()) {
      if (now - state.windowStart > REGISTER_WINDOW_MS * 2) {
        requestWindows.delete(key);
      }
      if (requestWindows.size <= MAX_STATE_ENTRIES * 0.8) break;
    }
  }

  if (loginBackoff.size > MAX_STATE_ENTRIES) {
    for (const [key, state] of loginBackoff.entries()) {
      if (now - state.lastFailureAt > LOGIN_FAILURE_RESET_MS * 2) {
        loginBackoff.delete(key);
      }
      if (loginBackoff.size <= MAX_STATE_ENTRIES * 0.8) break;
    }
  }
}

/** Best-effort client IP extraction for rate limiting. */
export function getClientIp(c: Context): string {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }

  const realIp = c.req.header('x-real-ip')?.trim();
  if (realIp) return realIp;

  const connectingIp = c.req.header('cf-connecting-ip')?.trim();
  if (connectingIp) return connectingIp;

  return 'unknown';
}

export function checkRegisterRateLimit(ip: string, email: string): RateLimitResult {
  const ipLimit = consumeWindow(`register:ip:${ip}`, REGISTER_PER_IP_LIMIT, REGISTER_WINDOW_MS);
  if (!ipLimit.allowed) return ipLimit;

  if (email) {
    const identityLimit = consumeWindow(
      `register:id:${identityKey(ip, email)}`,
      REGISTER_PER_IDENTITY_LIMIT,
      REGISTER_WINDOW_MS,
    );
    if (!identityLimit.allowed) return identityLimit;
  }

  return { allowed: true };
}

export function checkLoginRateLimit(ip: string, email: string): RateLimitResult {
  const ipLimit = consumeWindow(`login:ip:${ip}`, LOGIN_PER_IP_LIMIT, LOGIN_WINDOW_MS);
  if (!ipLimit.allowed) return ipLimit;

  if (email) {
    const identityLimit = consumeWindow(
      `login:id:${identityKey(ip, email)}`,
      LOGIN_PER_IDENTITY_LIMIT,
      LOGIN_WINDOW_MS,
    );
    if (!identityLimit.allowed) return identityLimit;

    const backoffLimit = checkLoginBackoff(identityKey(ip, email));
    if (!backoffLimit.allowed) return backoffLimit;
  }

  return { allowed: true };
}

/** Record failed login and return applied backoff in seconds. */
export function recordLoginFailure(ip: string, email: string): number {
  const key = identityKey(ip, email);
  const now = Date.now();
  const previous = loginBackoff.get(key);

  const failures = previous && now - previous.lastFailureAt <= LOGIN_FAILURE_RESET_MS
    ? previous.failures + 1
    : 1;

  let backoffMs = 0;
  if (failures >= 3) {
    backoffMs = Math.min(
      LOGIN_BACKOFF_MAX_MS,
      LOGIN_BACKOFF_BASE_MS * 2 ** (failures - 3),
    );
  }

  loginBackoff.set(key, {
    failures,
    lastFailureAt: now,
    lockedUntil: now + backoffMs,
  });

  cleanupState(now);
  return Math.max(0, Math.ceil(backoffMs / 1000));
}

export function clearLoginFailures(ip: string, email: string): void {
  loginBackoff.delete(identityKey(ip, email));
}
