import { access, cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

// Next.js traces the server dependencies; these assets must accompany it.
const standalone = resolve('.next/standalone');
await access(resolve(standalone, 'server.js'));
await mkdir(resolve(standalone, '.next'), { recursive: true });
await cp(resolve('public'), resolve(standalone, 'public'), { recursive: true });
await cp(resolve('.next/static'), resolve(standalone, '.next/static'), { recursive: true });
console.log('Hostinger server ready: .next/standalone/server.js (including public and static assets).');
