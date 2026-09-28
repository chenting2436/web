import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('profile identity is sourced from the Go session and supports server logout', async () => {
  const profile = await readFile(new URL('../components/profile-identity.tsx', import.meta.url), 'utf8');

  assert.match(profile, /authApi\.currentUser\(\)/);
  assert.match(profile, /await authApi\.logout\(\)/);
  assert.doesNotMatch(profile, /localStorage|sessionStorage|document\.cookie/);
});
