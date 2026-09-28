import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { resolveWorkbenchReadiness } from '../lib/capability-state.ts';
import { getWorkbenchReadiness } from '../lib/platform-data.ts';

test('capability failures close execution instead of trusting stale browser state', () => {
  const local = getWorkbenchReadiness('paper-writing');
  const resolved = resolveWorkbenchReadiness(local, undefined, 'error');
  assert.equal(resolved.executionAllowed, false);
  assert.equal(resolved.status, 'security-blocked');
});

test('remote capability can restrict an available assessment route', () => {
  const remote = {
    slug: 'ai-assessment',
    status: 'security-blocked',
    executionAllowed: false,
    productionReady: false,
  };
  const resolved = resolveWorkbenchReadiness(
    getWorkbenchReadiness('ai-assessment'),
    remote,
    'ready',
  );
  assert.equal(resolved.executionAllowed, false);
  assert.equal(resolved.status, 'security-blocked');
});

test('workbench routes obtain execution state from the Go catalog', async () => {
  const availability = await readFile(
    new URL('../components/workbench-availability.tsx', import.meta.url),
    'utf8',
  );
  const catalogApi = await readFile(
    new URL('../services/api/capabilities.ts', import.meta.url),
    'utf8',
  );
  assert.match(availability, /capabilityApi\.list\(\)/);
  assert.match(catalogApi, /\/tools\/catalog/);
});
