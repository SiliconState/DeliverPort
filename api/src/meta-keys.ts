import {
  TENANT_NAMESPACES,
  stripTenantScopedKey,
  tenantNamespacePrefix,
  tenantScopedKey,
} from './tenant.js';

const LEGACY_USER_META_SEPARATOR = ':';

/**
 * Normalize a user-facing meta key to a safe trimmed identifier.
 */
export function normalizeUserMetaKey(rawKey: string): string {
  return rawKey.trim();
}

/**
 * Primary (namespaced) storage key used for new writes.
 */
export function toUserMetaStorageKey(userId: string, rawKey: string): string {
  const key = normalizeUserMetaKey(rawKey);
  return tenantScopedKey(userId, TENANT_NAMESPACES.meta, key);
}

/**
 * Legacy storage key format kept for backward-compatible reads/cleanup.
 */
export function toLegacyUserMetaStorageKey(userId: string, rawKey: string): string {
  const key = normalizeUserMetaKey(rawKey);
  return `${userId}${LEGACY_USER_META_SEPARATOR}${key}`;
}

/**
 * True when the key is in the primary namespaced format.
 */
export function isPrimaryUserMetaStorageKey(userId: string, storageKey: string): boolean {
  return storageKey.startsWith(userMetaPrefix(userId));
}

/**
 * Remove tenant prefix before returning a meta key to the caller.
 */
export function fromUserMetaStorageKey(userId: string, storageKey: string): string {
  const scoped = stripTenantScopedKey(userId, TENANT_NAMESPACES.meta, storageKey);
  if (scoped !== null) return scoped;

  const legacyPrefix = `${userId}${LEGACY_USER_META_SEPARATOR}`;
  if (storageKey.startsWith(legacyPrefix)) {
    return storageKey.slice(legacyPrefix.length);
  }

  return storageKey;
}

/**
 * Primary prefix used to query current user's namespaced meta records.
 */
export function userMetaPrefix(userId: string): string {
  return tenantNamespacePrefix(userId, TENANT_NAMESPACES.meta);
}

/**
 * All compatible prefixes to support both new and legacy keys.
 */
export function userMetaPrefixes(userId: string): string[] {
  return [
    userMetaPrefix(userId),
    `${userId}${LEGACY_USER_META_SEPARATOR}`,
  ];
}
