import { Context } from 'hono';
import Redis from 'ioredis';

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
const REDIS_KEY_PREFIX = process.env.RATE_LIMIT_KEY_PREFIX || 'deliverport:auth';

let redisClient: Redis | null = null;
let redisInitAttempted = false;
let redisDisabled = false;

function identityKey(ip: string, email: string): string {
  return `${ip}:${email.trim().toLowerCase()}`;
}

function useRedisRateLimit(): boolean {
  return Boolean(process.env.REDIS_URL) && !redisDisabled;
}

function getRedisClient(): Redis | null {
  if (!useRedisRateLimit()) return null;
  if (redisClient) return redisClient;
  if (redisInitAttempted) return null;

  redisInitAttempted = true;

  try {
    redisClient = new Redis(process.env.REDIS_URL as string, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
      lazyConnect: true,
    });

    redisClient.on('error', (err) => {
      // Fail open to in-memory limiter if Redis is unavailable.
      console.warn('[security] redis rate-limit backend unavailable, using in-memory fallback', err.message);
      redisDisabled = true;
      if (redisClient) {
        redisClient.disconnect();
        redisClient = null;
      }
    });

    return redisClient;
  } catch (err) {
    console.warn('[security] failed to initialize redis rate-limit backend, using in-memory fallback', err);
    redisDisabled = true;
    redisClient = null;
    return null;
  }
}

async function withRedis<T>(work: (redis: Redis) => Promise<T>): Promise<T | null> {
  const redis = getRedisClient();
  if (!redis) return null;

  try {
    if (redis.status === 'wait') {
      await redis.connect();
    }
    return await work(redis);
  } catch (err) {
    console.warn('[security] redis command failed, using in-memory fallback', err);
    redisDisabled = true;
    redis.disconnect();
    redisClient = null;
    return null;
  }
}

function consumeWindowMemory(key: string, limit: number, windowMs: number): RateLimitResult {
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

async function consumeWindowRedis(key: string, limit: number, windowMs: number): Promise<RateLimitResult | null> {
  return withRedis(async (redis) => {
    const now = Date.now();
    const bucket = Math.floor(now / windowMs);
    const redisKey = `${REDIS_KEY_PREFIX}:window:${key}:${bucket}`;

    const count = await redis.incr(redisKey);
    if (count === 1) {
      await redis.pexpire(redisKey, windowMs + 1_000);
    }

    if (count > limit) {
      const ttlMs = await redis.pttl(redisKey);
      const retryAfterSeconds = Math.max(1, Math.ceil((ttlMs > 0 ? ttlMs : windowMs) / 1000));
      return {
        allowed: false,
        retryAfterSeconds,
        reason: 'rate_limited',
      };
    }

    return { allowed: true };
  });
}

async function consumeWindow(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
  const redisResult = await consumeWindowRedis(key, limit, windowMs);
  if (redisResult) return redisResult;
  return consumeWindowMemory(key, limit, windowMs);
}

function checkLoginBackoffMemory(key: string): RateLimitResult {
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

async function checkLoginBackoffRedis(key: string): Promise<RateLimitResult | null> {
  return withRedis(async (redis) => {
    const redisKey = `${REDIS_KEY_PREFIX}:backoff:${key}`;
    const [lockedUntilRaw] = await redis.hmget(redisKey, 'locked_until');

    if (!lockedUntilRaw) {
      return { allowed: true };
    }

    const lockedUntil = Number.parseInt(lockedUntilRaw, 10);
    if (!Number.isFinite(lockedUntil) || lockedUntil <= Date.now()) {
      return { allowed: true };
    }

    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((lockedUntil - Date.now()) / 1000)),
      reason: 'backoff',
    };
  });
}

async function checkLoginBackoff(key: string): Promise<RateLimitResult> {
  const redisResult = await checkLoginBackoffRedis(key);
  if (redisResult) return redisResult;
  return checkLoginBackoffMemory(key);
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

export async function checkRegisterRateLimit(ip: string, email: string): Promise<RateLimitResult> {
  const ipLimit = await consumeWindow(`register:ip:${ip}`, REGISTER_PER_IP_LIMIT, REGISTER_WINDOW_MS);
  if (!ipLimit.allowed) return ipLimit;

  if (email) {
    const identityLimit = await consumeWindow(
      `register:id:${identityKey(ip, email)}`,
      REGISTER_PER_IDENTITY_LIMIT,
      REGISTER_WINDOW_MS,
    );
    if (!identityLimit.allowed) return identityLimit;
  }

  return { allowed: true };
}

export async function checkLoginRateLimit(ip: string, email: string): Promise<RateLimitResult> {
  const ipLimit = await consumeWindow(`login:ip:${ip}`, LOGIN_PER_IP_LIMIT, LOGIN_WINDOW_MS);
  if (!ipLimit.allowed) return ipLimit;

  if (email) {
    const identity = identityKey(ip, email);

    const identityLimit = await consumeWindow(
      `login:id:${identity}`,
      LOGIN_PER_IDENTITY_LIMIT,
      LOGIN_WINDOW_MS,
    );
    if (!identityLimit.allowed) return identityLimit;

    const backoffLimit = await checkLoginBackoff(identity);
    if (!backoffLimit.allowed) return backoffLimit;
  }

  return { allowed: true };
}

/** Record failed login and return applied backoff in seconds. */
export async function recordLoginFailure(ip: string, email: string): Promise<number> {
  const key = identityKey(ip, email);
  const now = Date.now();

  const redisSeconds = await withRedis(async (redis) => {
    const redisKey = `${REDIS_KEY_PREFIX}:backoff:${key}`;
    const [failuresRaw, lastFailureAtRaw] = await redis.hmget(redisKey, 'failures', 'last_failure_at');

    const previousFailures = Number.parseInt(failuresRaw || '', 10);
    const previousLastFailureAt = Number.parseInt(lastFailureAtRaw || '', 10);

    const failures = Number.isFinite(previousFailures)
      && Number.isFinite(previousLastFailureAt)
      && now - previousLastFailureAt <= LOGIN_FAILURE_RESET_MS
      ? previousFailures + 1
      : 1;

    let backoffMs = 0;
    if (failures >= 3) {
      backoffMs = Math.min(
        LOGIN_BACKOFF_MAX_MS,
        LOGIN_BACKOFF_BASE_MS * 2 ** (failures - 3),
      );
    }

    const lockedUntil = now + backoffMs;

    await redis.hset(redisKey, {
      failures: String(failures),
      last_failure_at: String(now),
      locked_until: String(lockedUntil),
    });
    await redis.pexpire(redisKey, LOGIN_FAILURE_RESET_MS * 2);

    return Math.max(0, Math.ceil(backoffMs / 1000));
  });

  if (typeof redisSeconds === 'number') {
    return redisSeconds;
  }

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

export async function clearLoginFailures(ip: string, email: string): Promise<void> {
  const key = identityKey(ip, email);

  const redisCleared = await withRedis(async (redis) => {
    const redisKey = `${REDIS_KEY_PREFIX}:backoff:${key}`;
    await redis.del(redisKey);
    return true;
  });

  if (redisCleared) return;
  loginBackoff.delete(key);
}
