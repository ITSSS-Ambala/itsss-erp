import { emitKeypressEvents } from 'node:readline';
import { hashPassword } from '../lib/hostinger/password.ts';

if (!process.stdin.isTTY) {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const password = input.replace(/\r?\n$/, '');
  console.log(await hashPassword(password));
} else {
  async function hiddenPrompt(label) {
    process.stdout.write(label);
    process.stdin.setRawMode(true); process.stdin.resume();
    emitKeypressEvents(process.stdin);
    return new Promise(resolve => {
      let value = '';
      function keypress(text, key) {
        if (key?.ctrl && key.name === 'c') process.exit(130);
        if (key?.name === 'return' || key?.name === 'enter') {
          process.stdin.off('keypress', keypress); process.stdin.setRawMode(false); process.stdin.pause();
          process.stdout.write('\n'); resolve(value);
        } else if (key?.name === 'backspace') value = Array.from(value).slice(0, -1).join('');
        else if (text && !key?.ctrl && !key?.meta && !/[\x00-\x1f\x7f]/.test(text)) value += text;
      }
      process.stdin.on('keypress', keypress);
    });
  }
  const password = await hiddenPrompt('New administrator password (at least 12 characters; input hidden): ');
  const confirmation = await hiddenPrompt('Confirm password: ');
  if (password !== confirmation) throw new Error('Passwords do not match.');
  console.log('Set ERP_ADMIN_PASSWORD_HASH to the following value in Hostinger environment settings:');
  console.log(await hashPassword(password));
}
