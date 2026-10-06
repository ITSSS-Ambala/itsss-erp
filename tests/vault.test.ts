import test from 'node:test';
import assert from 'node:assert/strict';
import { sealVault, openVault } from '../lib/vault.ts';
import type { Store } from '../lib/schema.ts';

const randomKey = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
function fixture(): Store {
  return {
    vault: [
      { id: 'VAULT-TEST-1', name: 'Router administration', reference: 'Secure password manager / Office / Router', username: 'network-admin', allowedRoles: 'Admin,Technician', site: 'SITE-TEST-1', notes: 'Restricted access reference.', metadata: { owner: 'ITSSS', tags: ['router', 'office'] } },
      { id: 'VAULT-TEST-2', name: 'Archived hosting reference', reference: 'Secure password manager / Hosting', deletedAt: '2026-10-06T09:00:00Z', deletedBy: 'Administrator', deletionReason: 'Retired hosting plan' }
    ],
    projects: [{ id: 'PRJ-TEST-1', name: 'Example project', value: 125000 }]
  };
}

test('vault roundtrip encrypts entire records and preserves deletion metadata', async () => {
  const source = fixture(), snapshot = structuredClone(source), secret = randomKey();
  const sealed = await sealVault(source, secret);
  assert.deepEqual(source, snapshot);
  assert.deepEqual(sealed.projects, source.projects);
  assert.notEqual(sealed.projects, source.projects);
  for (const record of sealed.vault) {
    assert.deepEqual(Object.keys(record).sort(), ['encrypted', 'id']);
    assert.deepEqual(Object.keys(record.encrypted).sort(), ['ciphertext', 'iv']);
    assert.equal(Buffer.from(record.encrypted.iv, 'base64').byteLength, 12);
    assert.ok(Buffer.from(record.encrypted.ciphertext, 'base64').byteLength > 16);
  }
  const persisted = JSON.stringify(sealed.vault);
  for (const content of ['Secure password manager', 'network-admin', 'Restricted access', 'deletedAt', 'Retired hosting plan', 'allowedRoles']) assert.ok(!persisted.includes(content));
  const sealedSnapshot = structuredClone(sealed), opened = await openVault(sealed, secret);
  assert.deepEqual(opened, source);
  assert.deepEqual(sealed, sealedSnapshot);
  assert.notEqual(opened.vault[0], source.vault[0]);
});

test('each record and save receives an independent random nonce and ciphertext', async () => {
  const secret = randomKey(), first = await sealVault(fixture(), secret), second = await sealVault(fixture(), secret);
  assert.notEqual(first.vault[0].encrypted.iv, first.vault[1].encrypted.iv);
  assert.notEqual(first.vault[0].encrypted.iv, second.vault[0].encrypted.iv);
  assert.notEqual(first.vault[0].encrypted.ciphertext, second.vault[0].encrypted.ciphertext);
});

test('a wrong valid-length key cannot decrypt and errors reveal no credential content', async () => {
  const sealed = await sealVault(fixture(), randomKey());
  await assert.rejects(openVault(sealed, randomKey()), error => error instanceof Error && /Unable to decrypt credential vault record/.test(error.message) && !/password manager|network-admin|Restricted access/.test(error.message));
});

test('ciphertext, IV and record-ID tampering fail authentication', async () => {
  const secret = randomKey(), sealed = await sealVault(fixture(), secret);
  const alteredCiphertext = structuredClone(sealed);
  const bytes = Buffer.from(alteredCiphertext.vault[0].encrypted.ciphertext, 'base64'); bytes[0] ^= 1;
  alteredCiphertext.vault[0].encrypted.ciphertext = bytes.toString('base64');
  await assert.rejects(openVault(alteredCiphertext, secret), /Unable to decrypt/);
  const alteredIv = structuredClone(sealed);
  const iv = Buffer.from(alteredIv.vault[0].encrypted.iv, 'base64'); iv[0] ^= 1;
  alteredIv.vault[0].encrypted.iv = iv.toString('base64');
  await assert.rejects(openVault(alteredIv, secret), /Unable to decrypt/);
  const alteredId = structuredClone(sealed); alteredId.vault[0].id = 'ANOTHER-RECORD';
  await assert.rejects(openVault(alteredId, secret), /Unable to decrypt/);
});

test('legacy plaintext references are cloned on read and upgraded to encrypted envelopes on save', async () => {
  const source = fixture(), secret = randomKey(), opened = await openVault(source, secret);
  assert.deepEqual(opened, source); assert.notEqual(opened.vault[0], source.vault[0]);
  opened.vault[0].notes = 'Updated in memory';
  assert.equal(source.vault[0].notes, 'Restricted access reference.');
  const sealed = await sealVault(opened, secret);
  assert.ok(sealed.vault.every(record => record.encrypted && !record.reference));
  assert.equal((await openVault(sealed, secret)).vault[0].notes, 'Updated in memory');
});

test('sealed stores can be resealed without nesting encrypted envelopes', async () => {
  const secret = randomKey(), sealed = await sealVault(fixture(), secret), resealed = await sealVault(sealed, secret);
  assert.deepEqual(await openVault(resealed, secret), fixture());
  assert.notEqual(sealed.vault[0].encrypted.iv, resealed.vault[0].encrypted.iv);
});

test('invalid keys and malformed envelopes fail with controlled errors', async () => {
  await assert.rejects(sealVault(fixture(), undefined), /not configured.*ERP_VAULT_KEY/);
  await assert.rejects(openVault(fixture(), undefined), /not configured.*ERP_VAULT_KEY/);
  for (const secret of ['', 'not-a-key', Buffer.alloc(16).toString('base64'), Buffer.alloc(33).toString('base64')]) {
    await assert.rejects(sealVault(fixture(), secret), /base64-encoded 32-byte secret/);
    await assert.rejects(openVault(fixture(), secret), /base64-encoded 32-byte secret/);
  }
  const secret = randomKey();
  for (const encrypted of [{}, { iv: 'bad', ciphertext: 'bad' }, { iv: Buffer.alloc(4).toString('base64'), ciphertext: Buffer.alloc(16).toString('base64') }]) await assert.rejects(openVault({ vault: [{ id: 'BAD-ENVELOPE', encrypted }] }, secret), /Unable to decrypt/);
  await assert.rejects(sealVault({ vault: [{ id: '' }] }, secret), /non-empty string ID/);
  const circular = fixture(); circular.vault[0].metadata.loop = circular.vault[0];
  await assert.rejects(sealVault(circular, secret), /Unable to encrypt credential vault record VAULT-TEST-1/);
});

test('empty stores retain their shape and returned data shares no live references', async () => {
  const secret = randomKey();
  assert.deepEqual(await sealVault({}, secret), {});
  assert.deepEqual(await openVault({}, secret), {});
  assert.deepEqual(await sealVault({ vault: [] }, secret), { vault: [] });
  assert.deepEqual(await openVault({ vault: [] }, secret), { vault: [] });
});

test('vault audit and activity history never persist copied credential values', async () => {
  const source = fixture(), secret = randomKey();
  source.auditLogs = [{ id: 'AUD-TEST-1', name: 'Router reference changed', module: 'vault', recordId: 'VAULT-TEST-1', actor: 'Administrator', action: 'update', date: '2026-10-06T09:30:00Z', oldValue: JSON.stringify(source.vault[0]), newValue: JSON.stringify({ ...source.vault[0], reference: 'NEW-SENSITIVE-REFERENCE' }) }];
  source.activities = [{ id: 'ACT-TEST-1', module: 'vault', recordId: 'VAULT-TEST-1', name: 'network-admin · update', details: 'NEW-SENSITIVE-REFERENCE', actor: 'Administrator', action: 'update', date: '2026-10-06T09:30:00Z' }];
  const snapshot = structuredClone(source), sealed = await sealVault(source, secret), persisted = JSON.stringify(sealed);
  for (const sensitive of ['NEW-SENSITIVE-REFERENCE', 'Secure password manager', 'network-admin', 'Restricted access']) assert.ok(!persisted.includes(sensitive));
  assert.deepEqual(source, snapshot);
  for (const event of [...sealed.auditLogs, ...sealed.activities]) {
    assert.equal(event.actor, 'Administrator'); assert.equal(event.action, 'update'); assert.equal(event.date, '2026-10-06T09:30:00Z'); assert.equal(event.recordId, 'VAULT-TEST-1');
  }
  assert.deepEqual(JSON.parse(sealed.auditLogs[0].newValue), { id: 'VAULT-TEST-1', redacted: true });
  const opened = await openVault(sealed, secret);
  assert.deepEqual(opened.vault, source.vault);
  assert.ok(!JSON.stringify(opened.auditLogs).includes('NEW-SENSITIVE-REFERENCE'));
  const legacyOpened = await openVault(source, secret);
  assert.ok(!JSON.stringify(legacyOpened.auditLogs).includes('Secure password manager'));
});
