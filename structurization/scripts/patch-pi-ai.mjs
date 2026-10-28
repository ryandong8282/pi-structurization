// Preserve the application's existing Pi 1.2.0 OAuth identity contract.
// The patch lives with this package so consumers need no patch-package setup.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-ai')));
const manifest = JSON.parse(await readFile(join(dist, '..', 'package.json'), 'utf8'));
if (manifest.version !== '1.2.0') {
  throw new Error(`pi-structurization requires Pi OAuth compatibility reviewed for 1.2.0; found ${manifest.version}`);
}
const path = join(dist, 'auth', 'oauth', 'openai-chatgpt.js');
const original = await readFile(path, 'utf8');
const newline = original.includes('\r\n') ? '\r\n' : '\n';
let updated = original.replaceAll('\r\n', '\n');
const replacements = [
  ['async function exchangeAuthorizationCode(code, verifier, clientId, signal)',
    'async function exchangeAuthorizationCode(code, verifier, clientId, nonce, signal)'],
  ['    return credentialFromTokenResponse(token, clientId);\n}\nasync function refreshAccessToken',
    '    // Let the application verify and retain basic identity before storing the credential.\n    return { ...credentialFromTokenResponse(token, clientId), idToken: token.id_token, nonce };\n}\nasync function refreshAccessToken'],
  ['    return credentialFromTokenResponse(token, clientId);\n}\n/** OpenAI identifies',
    '    // Keep the application\'s verified account profile across token rotation.\n    return { ...credential, ...credentialFromTokenResponse(token, clientId) };\n}\n/** OpenAI identifies'],
  ['return await exchangeAuthorizationCode(result.code, verifier, result.clientId, interaction.signal);',
    'return await exchangeAuthorizationCode(result.code, verifier, result.clientId, nonce, interaction.signal);'],
];
for (const [before, after] of replacements) {
  if (updated.includes(after)) continue;
  if (!updated.includes(before)) throw new Error('Unsupported Pi OAuth source; refusing a partial compatibility patch.');
  updated = updated.replace(before, after);
}
updated = updated.replaceAll('\n', newline);
if (updated !== original) await writeFile(path, updated, 'utf8');
