import { access, cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

// Next.js traces the server dependencies; these assets must accompany it.
const standalone = resolve('.next/standalone');
await access(resolve(standalone, 'server.js'));
await mkdir(resolve(standalone, '.next'), { recursive: true });
await cp(resolve('public'), resolve(standalone, 'public'), { recursive: true });
await cp(resolve('.next/static'), resolve(standalone, '.next/static'), { recursive: true });
// Ship a source recovery command that runs even when the Next.js server is broken.
const recovery = resolve(standalone, 'recovery-tool');
await mkdir(resolve(recovery, 'scripts'), { recursive: true });
await cp(resolve('scripts/recovery.mjs'), resolve(recovery, 'scripts/recovery.mjs'));
await cp(resolve('lib'), resolve(recovery, 'lib'), { recursive: true });
await cp(resolve('docs/RECOVERY.md'), resolve(recovery, 'RECOVERY.md'));
console.log('Hostinger server ready: .next/standalone/server.js (including public and static assets).');
