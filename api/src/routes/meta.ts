import { Hono } from 'hono';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { authMiddleware } from '../middleware.js';
import { safeLogAuditEvent } from '../audit-log.js';
import {
  parseJsonBody,
  readStringArrayField,
  validationError,
  type ValidationIssue,
} from '../validation.js';
import {
  fromUserMetaStorageKey,
  isPrimaryUserMetaStorageKey,
  normalizeUserMetaKey,
  toLegacyUserMetaStorageKey,
  toUserMetaStorageKey,
  userMetaPrefixes,
} from '../meta-keys.js';

const meta = new Hono();
meta.use('*', authMiddleware);

function asInputJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function collapseMetaRows(userId: string, rows: Array<{ key: string; value: Prisma.JsonValue }>): Array<{ key: string; value: Prisma.JsonValue }> {
  const merged = new Map<string, { key: string; value: Prisma.JsonValue; primary: boolean }>();

  for (const row of rows) {
    const logicalKey = fromUserMetaStorageKey(userId, row.key);
    const current = merged.get(logicalKey);
    const primary = isPrimaryUserMetaStorageKey(userId, row.key);

    if (!current || (primary && !current.primary)) {
      merged.set(logicalKey, {
        key: logicalKey,
        value: row.value,
        primary,
      });
    }
  }

  return Array.from(merged.values())
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((entry) => ({ key: entry.key, value: entry.value }));
}

/**
 * GET /api/meta — list tenant-scoped meta entries for the current user.
 */
meta.get('/', async (c) => {
  const { userId } = c.get('user');
  const prefixes = userMetaPrefixes(userId);

  const records = await prisma.meta.findMany({
    where: {
      OR: prefixes.map((prefix) => ({
        key: {
          startsWith: prefix,
        },
      })),
    },
    orderBy: {
      key: 'asc',
    },
  });

  const metaRows = collapseMetaRows(userId, records);

  return c.json({
    meta: metaRows,
  });
});

/**
 * PUT /api/meta/:key — upsert a tenant-scoped meta entry.
 */
meta.put('/:key', async (c) => {
  const auth = c.get('user');
  const { userId } = auth;
  const rawKey = decodeURIComponent(c.req.param('key'));
  const key = normalizeUserMetaKey(rawKey);

  if (!key || key.length > 200) {
    return c.json({ error: 'Meta key must be between 1 and 200 characters' }, 400);
  }

  const parsed = await parseJsonBody(c);
  if (!parsed.ok) return parsed.response;

  if (!Object.prototype.hasOwnProperty.call(parsed.body, 'value')) {
    return c.json({ error: 'value is required' }, 400);
  }

  const storageKey = toUserMetaStorageKey(userId, key);
  const legacyStorageKey = toLegacyUserMetaStorageKey(userId, key);

  const entry = await prisma.$transaction(async (tx) => {
    const upserted = await tx.meta.upsert({
      where: { key: storageKey },
      create: {
        key: storageKey,
        value: asInputJson(parsed.body.value),
      },
      update: {
        value: asInputJson(parsed.body.value),
      },
    });

    if (legacyStorageKey !== storageKey) {
      await tx.meta.deleteMany({
        where: {
          key: legacyStorageKey,
        },
      });
    }

    return upserted;
  });

  await safeLogAuditEvent({
    ownerId: userId,
    actorId: userId,
    actorRole: auth.role,
    action: 'meta.updated',
    entityType: 'meta',
    entityId: key,
    summary: `Updated meta key ${key}`,
  });

  return c.json({
    meta: {
      key,
      value: entry.value,
    },
  });
});

/**
 * POST /api/meta/delete — delete multiple tenant-scoped meta keys.
 */
meta.post('/delete', async (c) => {
  const auth = c.get('user');
  const { userId } = auth;
  const parsed = await parseJsonBody(c);
  if (!parsed.ok) return parsed.response;

  const issues: ValidationIssue[] = [];
  const keys = readStringArrayField(parsed.body, 'keys', issues, {
    required: true,
    maxItems: 250,
    itemMaxLength: 200,
    allowEmptyItems: false,
  });

  if (issues.length > 0) {
    return validationError(c, issues);
  }

  const normalizedKeys = Array.from(
    new Set(
      (keys || [])
        .map((key) => normalizeUserMetaKey(key))
        .filter((key) => key.length > 0),
    ),
  );

  if (normalizedKeys.length === 0) {
    return c.json({ success: true, deleted: 0 });
  }

  const scopedKeys = Array.from(new Set(normalizedKeys.flatMap((key) => [
    toUserMetaStorageKey(userId, key),
    toLegacyUserMetaStorageKey(userId, key),
  ])));

  const result = await prisma.meta.deleteMany({
    where: {
      key: {
        in: scopedKeys,
      },
    },
  });

  await safeLogAuditEvent({
    ownerId: userId,
    actorId: userId,
    actorRole: auth.role,
    action: 'meta.deleted',
    entityType: 'meta',
    entityId: null,
    summary: `Deleted ${result.count} meta keys`,
    details: {
      deleted_keys: normalizedKeys,
    },
  });

  return c.json({ success: true, deleted: result.count });
});

export default meta;
