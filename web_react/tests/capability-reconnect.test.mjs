import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'components', 'workbench-availability.tsx'), 'utf8');

test('workbench capability automatically recovers after a backend restart', () => {
  assert.match(source, /setInterval\(loadCapability, 10_000\)/);
  assert.match(source, /addEventListener\('focus', loadCapability\)/);
  assert.match(source, /addEventListener\('online', loadCapability\)/);
  assert.match(source, /clearInterval\(retryTimer\)/);
});
