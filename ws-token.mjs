// One-time: decode a Moodle mobile launch URL into MOODLE_WS_TOKEN in .env.
// Usage:  node ws-token.mjs "moodlemobile://token=...."   (quote it)
// The token blob is base64 of  passport:::token:::privatetoken  — we keep the middle field.
import fs from 'node:fs';

const arg = process.argv[2] || '';
const b64 = (arg.match(/token=([A-Za-z0-9+/=]+)/) || [])[1];
if (!b64) { console.error('No token= found. Paste the whole moodlemobile://token=... string in quotes.'); process.exit(1); }

const token = Buffer.from(b64, 'base64').toString('utf8').split(':::')[1];
if (!token || token.length < 20) { console.error('Decoded but no plausible token inside.'); process.exit(1); }

let env = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : '';
env = /^MOODLE_WS_TOKEN=/m.test(env)
  ? env.replace(/^MOODLE_WS_TOKEN=.*$/m, `MOODLE_WS_TOKEN=${token}`)
  : env.replace(/\n?$/, '\n') + `MOODLE_WS_TOKEN=${token}\n`;
fs.writeFileSync('.env', env, { mode: 0o600 });
console.log(`MOODLE_WS_TOKEN written to .env (${token.length} chars). Delete this file when done.`);
