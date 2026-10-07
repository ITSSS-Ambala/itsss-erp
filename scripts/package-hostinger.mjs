import { deflateRawSync } from 'node:zlib';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';

const root = resolve('.');
const entries = [];
async function addFile(source, destination = source) {
  entries.push({ name: destination.replaceAll('\\', '/'), bytes: await readFile(join(root, source)) });
}
async function addDirectory(directory) {
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`Unexpected source symlink: ${directory}/${entry.name}`);
    if (entry.isDirectory()) await addDirectory(`${directory}/${entry.name}`);
    else if (entry.isFile()) await addFile(`${directory}/${entry.name}`);
  }
}
for (const directory of ['app', 'components', 'hooks', 'lib', 'public', 'tests']) await addDirectory(directory);
for (const filename of ['package.json', 'package-lock.json', 'next.config.ts', 'tsconfig.json', 'postcss.config.mjs', 'eslint.config.mjs', '.npmrc', '.gitignore', '.env.example']) await addFile(filename);
for (const filename of ['start-hostinger.mjs', 'prepare-hostinger.mjs', 'hash-password.mjs', 'generate-vault-key.mjs', 'verify-hostinger.mjs', 'package-hostinger.mjs']) await addFile(`scripts/${filename}`);
await addFile('docs/HOSTINGER_DEPLOYMENT.md', 'DEPLOYMENT.md');
await addFile('docs/HOSTINGER_DEPLOYMENT.md');
await addFile('docs/FEATURE_AUDIT.md');
await addFile('README.md');
entries.push({ name: 'READ_ME_FIRST.txt', bytes: Buffer.from('HOSTINGER NODE.JS WEB APP UPLOAD PACKAGE\nTarget: https://crm.itsss.co.in\nUpload this ZIP using Websites > Create Website > Node.js Web App.\nNode: 24.x | Framework: Next.js | Build: npm run build | Output: .next\nThe build generates .next/standalone/server.js and includes public/static assets.\nFor GitHub deployments, publish these sources to the connected branch first.\nSet the private environment variables listed in DEPLOYMENT.md.\nHostinger rebuilds these sources on Linux.\nThis is NOT a static public_html upload and does not run on PHP-only hosting.\n') });
entries.sort((a, b) => a.name.localeCompare(b.name));
const packageJson = JSON.parse(entries.find(entry => entry.name === 'package.json').bytes.toString());
const lock = JSON.parse(entries.find(entry => entry.name === 'package-lock.json').bytes.toString());
for (const group of ['dependencies', 'devDependencies']) {
  if (JSON.stringify(packageJson[group]) !== JSON.stringify(lock.packages[''][group])) throw new Error(`Manifest/lockfile mismatch in ${group}.`);
}
if (packageJson.engines.node !== '24.x' || packageJson.scripts.build !== 'next build --webpack') throw new Error('Unexpected deployment runtime.');
if (packageJson.scripts.postbuild !== 'node scripts/prepare-hostinger.mjs' || !/output:\s*['"]standalone['"]/.test(entries.find(entry => entry.name === 'next.config.ts').bytes.toString())) throw new Error('Hostinger requires Next.js standalone output with its public/static assets.');
// Never package private environment files, business data or Windows dependencies.
for (const entry of entries) if (/(^|\/)(node_modules|\.git|\.next|\.wrangler|\.sites-runtime|outputs|\.dev\.vars[^/]*)(\/|$)/.test(entry.name) || /(^|\/)\.env/.test(entry.name) && entry.name !== '.env.example') throw new Error('Private or platform-specific file in package.');
let localVaultKey = '';
try { localVaultKey = (await readFile(join(root, '.dev.vars'), 'utf8')).match(/^ERP_VAULT_KEY=(.*)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '') || ''; } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (localVaultKey.length > 20 && entries.some(entry => entry.bytes.includes(Buffer.from(localVaultKey)))) throw new Error('Local vault key must not be included in the upload package.');

// A small standards-compliant ZIP writer avoids an extra packaging dependency.
const table = Uint32Array.from({ length: 256 }, (_, value) => { for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; return value >>> 0; });
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
const chunks = [], central = [];
let offset = 0;
for (const entry of entries) {
  const name = Buffer.from(entry.name, 'utf8');
  const compressed = deflateRawSync(entry.bytes);
  const crc = crc32(entry.bytes);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8); local.writeUInt16LE(33, 12);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(entry.bytes.length, 22); local.writeUInt16LE(name.length, 26);
  chunks.push(local, name, compressed);
  const record = Buffer.alloc(46);
  record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE((3 << 8) | 20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x0800, 8); record.writeUInt16LE(8, 10); record.writeUInt16LE(33, 14);
  record.writeUInt32LE(crc, 16); record.writeUInt32LE(compressed.length, 20); record.writeUInt32LE(entry.bytes.length, 24); record.writeUInt16LE(name.length, 28);
  record.writeUInt32LE((0o100644 << 16) >>> 0, 38); record.writeUInt32LE(offset, 42);
  central.push(record, name); offset += local.length + name.length + compressed.length;
}
const directory = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
const zip = Buffer.concat([...chunks, directory, end]);
await mkdir(join(root, 'outputs'), { recursive: true });
const filename = 'hostinger-crm-upload.zip';
await writeFile(join(root, 'outputs', filename), zip);
await writeFile(join(root, 'outputs/hostinger-package-verification.json'), JSON.stringify({ archive: filename, sha256: createHash('sha256').update(zip).digest('hex'), files: entries.length, bytes: zip.length, deploymentUrl: 'https://crm.itsss.co.in', runtime: 'Next.js / Node.js 24', outputDirectory: '.next', entryFile: '.next/standalone/server.js', standaloneAssetsIncludedByPostbuild: true, packageAndLockMatch: true, secretsAndLocalDataExcluded: true, includesWindowsDependencies: false, uploadMethod: 'Hostinger Node.js Web App source ZIP; build on Linux', publicHtmlCompatible: false, deployed: false }, null, 2));
console.log(`Created outputs/${filename} (${entries.length} files, ${(zip.length / 1024 / 1024).toFixed(2)} MB).`);
