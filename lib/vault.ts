import type { ERPRecord, Store } from './schema.ts';

type VaultEnvelope = ERPRecord & { encrypted: { iv: string; ciphertext: string } };
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || !value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('Invalid base64 encoding.');
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  if (toBase64(bytes) !== value) throw new Error('Invalid base64 encoding.');
  return bytes;
}

function toBase64(bytes: Uint8Array<ArrayBuffer>): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function importKey(secret: string | undefined): Promise<CryptoKey> {
  if (typeof secret !== 'string' || !secret.trim()) throw new Error('Vault encryption key is not configured. Set ERP_VAULT_KEY to a base64-encoded 32-byte secret.');
  let bytes: Uint8Array<ArrayBuffer>;
  try { bytes = fromBase64(typeof secret === 'string' ? secret.trim() : ''); } catch { throw new Error('Vault encryption key must be a base64-encoded 32-byte secret.'); }
  if (bytes.byteLength !== 32) throw new Error('Vault encryption key must be a base64-encoded 32-byte secret.');
  try { return await crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); }
  finally { bytes.fill(0); }
}

function validateId(record: ERPRecord): string {
  if (!record || typeof record.id !== 'string' || !record.id.trim()) throw new Error('Vault record must have a non-empty string ID.');
  return record.id;
}

function authenticationData(id: string): Uint8Array<ArrayBuffer> { return encoder.encode(`ITSSS:credential-vault:v1:${id}`); }

function redactVaultHistory(store: Store): void {
  for (const moduleId of ['auditLogs', 'audit']) for (const event of store[moduleId] || []) {
    if (event.module !== 'vault' && event.moduleId !== 'vault' && event.sourceModule !== 'vault') continue;
    event.name = 'Credential reference changed';
    const redacted = JSON.stringify({ id: event.recordId || event.sourceId || '', redacted: true });
    if (event.oldValue) event.oldValue = redacted;
    if (event.newValue) event.newValue = redacted;
    if (event.details) event.details = 'Credential values omitted from audit history.';
  }
  for (const event of store.activities || []) {
    if (event.module !== 'vault' && event.moduleId !== 'vault' && event.sourceModule !== 'vault') continue;
    event.name = 'Credential reference changed';
    event.details = 'Credential values omitted from activity history.';
  }
}

async function decryptRecord(record: VaultEnvelope, key: CryptoKey): Promise<ERPRecord> {
  const id = validateId(record);
  try {
    const envelope = record.encrypted;
    if (!envelope || typeof envelope.iv !== 'string' || typeof envelope.ciphertext !== 'string') throw new Error('Invalid envelope.');
    const iv = fromBase64(envelope.iv), ciphertext = fromBase64(envelope.ciphertext);
    if (iv.byteLength !== 12 || ciphertext.byteLength < 16) throw new Error('Invalid envelope.');
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: authenticationData(id), tagLength: 128 }, key, ciphertext);
    const bytes = new Uint8Array(plaintext);
    try {
      const decoded = JSON.parse(decoder.decode(bytes));
      if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded) || decoded.id !== id) throw new Error('Invalid decrypted record.');
      return decoded;
    } finally { bytes.fill(0); }
  } catch {
    // Never include ciphertext, decrypted content, or underlying parser errors.
    throw new Error(`Unable to decrypt credential vault record ${id}. Check the encryption key and stored ciphertext.`);
  }
}

/** Encrypt every complete credential reference; the input remains untouched. */
export async function sealVault(store: Store, secret: string | undefined): Promise<Store> {
  const key = await importKey(secret);
  const sealed = structuredClone(store);
  // Generated change history must not become a second plaintext credential store.
  redactVaultHistory(sealed);
  if (!sealed.vault) return sealed;
  if (!Array.isArray(sealed.vault)) throw new Error('Credential vault must be an array of records.');
  sealed.vault = await Promise.all(sealed.vault.map(async storedRecord => {
    const record = Object.prototype.hasOwnProperty.call(storedRecord, 'encrypted') ? await decryptRecord(storedRecord as VaultEnvelope, key) : storedRecord;
    const id = validateId(record);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    let plaintext: Uint8Array<ArrayBuffer> | undefined;
    try {
      plaintext = encoder.encode(JSON.stringify(record));
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: authenticationData(id), tagLength: 128 }, key, plaintext);
      return { id, encrypted: { iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)) } };
    } catch { throw new Error(`Unable to encrypt credential vault record ${id}.`); }
    finally { plaintext?.fill(0); }
  }));
  return sealed;
}

/** Open encrypted references and accept legacy plaintext for migration on the next save. */
export async function openVault(store: Store, secret: string | undefined): Promise<Store> {
  const key = await importKey(secret);
  const opened = structuredClone(store);
  // Also sanitize legacy snapshots before they reach user-visible audit records.
  redactVaultHistory(opened);
  if (!opened.vault) return opened;
  if (!Array.isArray(opened.vault)) throw new Error('Credential vault must be an array of records.');
  opened.vault = await Promise.all(opened.vault.map(async record => {
    validateId(record);
    return Object.prototype.hasOwnProperty.call(record, 'encrypted') ? decryptRecord(record as VaultEnvelope, key) : record;
  }));
  return opened;
}
