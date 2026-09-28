import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('production login uses the Go OIDC start endpoint', async () => {
  const authApi = await readFile(
    new URL('../services/api/auth.ts', import.meta.url),
    'utf8',
  );
  const loginForm = await readFile(
    new URL('../components/login-form.tsx', import.meta.url),
    'utf8',
  );
  assert.match(authApi, /\/auth\/oidc\/start/);
  assert.match(loginForm, /使用组织账号登录/);
  assert.match(loginForm, /NEXT_PUBLIC_ENABLE_DEV_LOGIN === 'true'/);
});

test('environment template keeps password login disabled', async () => {
  const environment = await readFile(
    new URL('../.env.example', import.meta.url),
    'utf8',
  );
  assert.match(environment, /NEXT_PUBLIC_OIDC_ENABLED=true/);
  assert.match(environment, /NEXT_PUBLIC_ENABLE_DEV_LOGIN=false/);
  assert.doesNotMatch(environment, /PASSWORD=/);
});
