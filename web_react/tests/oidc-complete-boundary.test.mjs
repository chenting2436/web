import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('OIDC callback landing confirms the server session before entering profile', async () => {
  const page = await readFile(new URL('../app/auth/complete/page.tsx', import.meta.url), 'utf8');
  const completion = await readFile(new URL('../components/oidc-complete.tsx', import.meta.url), 'utf8');

  assert.match(page, /OIDCComplete/);
  assert.match(completion, /authApi\.currentUser\(\)/);
  assert.match(completion, /router\.replace\('\/profile'\)/);
  assert.doesNotMatch(completion, /return_to|redirect_uri|URLSearchParams/);
});
