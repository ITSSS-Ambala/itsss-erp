import { existsSync } from 'node:fs';
import { getHostingerConfig } from '../lib/hostinger/config.ts';
import { runtimeDatabase } from '../lib/hostinger/database.ts';

if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Use Node.js 24 for this application.');
process.env.NODE_ENV = 'production';
// Local configuration is optional; Hostinger injects environment variables.
for (const filename of ['.env', '.env.local']) if (existsSync(filename)) process.loadEnvFile(filename);
try { getHostingerConfig(); runtimeDatabase(); }
catch (error) { console.error(error instanceof Error ? error.message : 'Invalid server configuration.'); process.exit(1); }
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid port number.');
process.env.PORT = String(port);
process.env.HOSTNAME = '0.0.0.0';
const standaloneServer = new URL('../.next/standalone/server.js', import.meta.url);
if (!existsSync(standaloneServer)) throw new Error('Production server is missing. Run npm run build first.');
await import(standaloneServer.href);
