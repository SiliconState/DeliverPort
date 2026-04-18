import { pbkdf2Sync, randomBytes } from 'crypto';
import jwt from 'jsonwebtoken';

/**
 * Password hashing that matches the frontend's AuthCrypto.
 * Format: pbkdf2$<iterations>$<base64salt>$<base64hash>
 * Uses SHA-256, 256-bit output, 120k iterations — same as the browser Web Crypto API version.
 */
const PBKDF2_ITERATIONS = 120_000;
const KEY_LENGTH = 32; // 256 bits
const DIGEST = 'sha256';

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, DIGEST);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = parseInt(parts[1], 10);
  const salt = Buffer.from(parts[2], 'base64');
  const expectedHash = parts[3];
  const derived = pbkdf2Sync(password, salt, iterations, KEY_LENGTH, DIGEST);
  return derived.toString('base64') === expectedHash;
}

export interface JWTPayload {
  userId: string;
  email: string;
  role: string;
}

export function signToken(payload: JWTPayload): string {
  const secret = getJWTSecret();
  return jwt.sign(payload, secret, { expiresIn: '7d' });
}

export function verifyToken(token: string): JWTPayload {
  const secret = getJWTSecret();
  return jwt.verify(token, secret) as JWTPayload;
}

function getJWTSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET environment variable is required');
  return secret;
}
