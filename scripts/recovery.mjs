import { emitKeypressEvents } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRecoveryBackup, restoreRecoveryBackup } from '../lib/hostinger/recovery.ts';
import { closeRuntimeDatabase } from '../lib/hostinger/database.ts';

const [command, ...args] = process.argv.slice(2);
function option(name) { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; }
async function passwordPrompt() {
  if (!process.stdin.isTTY) {
    let input = ''; for await (const chunk of process.stdin) input += chunk;
    return input.replace(/\r?\n$/, '');
  }
  process.stdout.write('Recovery archive password (input hidden): ');
  process.stdin.setRawMode(true); process.stdin.resume(); emitKeypressEvents(process.stdin);
  return new Promise(resolvePassword => {
    let value = '';
    function keypress(text, key) {
      if (key?.ctrl && key.name === 'c') process.exit(130);
      if (key?.name === 'return' || key?.name === 'enter') {
        process.stdin.off('keypress', keypress); process.stdin.setRawMode(false); process.stdin.pause();
        process.stdout.write('\n'); resolvePassword(value);
      } else if (key?.name === 'backspace') value = Array.from(value).slice(0, -1).join('');
      else if (text && !key?.ctrl && !key?.meta && !/[\x00-\x1f\x7f]/.test(text)) value += text;
    }
    process.stdin.on('keypress', keypress);
  });
}
try {
  if (!['backup', 'restore'].includes(command)) throw new Error('Usage: node scripts/recovery.mjs backup [--config private-config.json] OR restore --file archive.itsss-backup --data-dir /private/data --confirm RESTORE [--app-dir /new/app/directory]');
  const configFile = option('--config');
  if (configFile) {
    const configuration = JSON.parse(await readFile(resolve(configFile), 'utf8'));
    for (const key of ['ERP_PUBLIC_URL', 'ERP_DATA_DIR', 'ERP_ADMIN_EMAIL', 'ERP_ADMIN_NAME', 'ERP_ADMIN_PASSWORD_HASH', 'ERP_VAULT_KEY', 'ERP_SESSION_HOURS', 'ERP_AUTH_USERS']) if (typeof configuration[key] === 'string') process.env[key] = configuration[key];
  }
  if (command === 'restore' && (option('--confirm') !== 'RESTORE' || !option('--file') || !option('--data-dir'))) throw new Error('Stop the app, then supply --file, --data-dir and --confirm RESTORE. App files require a new --app-dir directory.');
  const password = await passwordPrompt();
  const result = command === 'backup' ? await createRecoveryBackup(password) : await restoreRecoveryBackup(resolve(option('--file')), password, { offline: true, dataDirectory: resolve(option('--data-dir')), applicationDirectory: option('--app-dir') });
  console.log(JSON.stringify(result, null, 2));
  if (command === 'restore') console.log('Recovery complete. Set the private environment values from recovery-config.json before restarting. Keep this file private. Rebuild source snapshots with Node.js 24, npm ci and npm run build; runtime snapshots require the same operating system and Node.js 24.');
} catch (error) { console.error(error instanceof Error ? error.message : 'Recovery failed.'); process.exitCode = 1; }
finally { closeRuntimeDatabase(); }
