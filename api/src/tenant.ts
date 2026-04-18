/**
 * Shared helpers for tenant-scoped key/value storage in the Meta table.
 * Key format: u:<ownerUserId>:<namespace>:<localKey>
 */
const TENANT_KEY_PREFIX = 'u';

export const TENANT_NAMESPACES = {
  meta: 'meta',
  audit: 'audit',
  reminder: 'reminder',
} as const;

export type TenantNamespace = (typeof TENANT_NAMESPACES)[keyof typeof TENANT_NAMESPACES];

export function tenantNamespacePrefix(userId: string, namespace: TenantNamespace): string {
  return `${TENANT_KEY_PREFIX}:${userId}:${namespace}:`;
}

export function tenantScopedKey(userId: string, namespace: TenantNamespace, localKey: string): string {
  return `${tenantNamespacePrefix(userId, namespace)}${localKey}`;
}

export function stripTenantScopedKey(
  userId: string,
  namespace: TenantNamespace,
  scopedKey: string,
): string | null {
  const prefix = tenantNamespacePrefix(userId, namespace);
  if (!scopedKey.startsWith(prefix)) return null;
  return scopedKey.slice(prefix.length);
}
