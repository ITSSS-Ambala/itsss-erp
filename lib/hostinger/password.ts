import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
const options = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const pattern = /^scrypt\$32768\$8\$1\$([A-Za-z0-9+/]{22}==)\$([A-Za-z0-9+/]{86}==)$/;
function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 64, options, (error, key) => error ? reject(error) : resolve(key)));
}
export function validPasswordHash(value: string): boolean {
  const match = pattern.exec(value);
  return Boolean(match && Buffer.from(match[1], 'base64').toString('base64') === match[1] && Buffer.from(match[2], 'base64').toString('base64') === match[2]);
}
export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password) > 256) throw new Error('Use a password of at least 12 characters and at most 256 bytes.');
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$32768$8$1$${salt.toString('base64')}$${key.toString('base64')}`;
}
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (typeof password !== 'string' || Buffer.byteLength(password) > 256 || !validPasswordHash(hash)) return false;
  const match = pattern.exec(hash)!;
  const actual = await derive(password, Buffer.from(match[1], 'base64'));
  return timingSafeEqual(actual, Buffer.from(match[2], 'base64'));
}
