import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ambientSource = await readFile(
  new URL('../components/ambient-noise-workbench.tsx', import.meta.url),
  'utf8',
);
const availabilitySource = await readFile(
  new URL('../components/workbench-availability.tsx', import.meta.url),
  'utf8',
);
const cardSource = await readFile(
  new URL('../components/workbench-card.tsx', import.meta.url),
  'utf8',
);

test('ambient-noise route uses the dedicated React workbench', () => {
  assert.match(availabilitySource, /workbench\.slug === 'ambient-noise-imaging'/);
  assert.match(availabilitySource, /<AmbientNoiseWorkbench/);
});

test('dedicated workbench preserves all eight card-version stages', () => {
  for (const label of [
    '项目总览',
    '台站与数据',
    '预处理',
    '互相关',
    '频散拾取',
    '层析成像',
    '质量验证',
    '成果交付',
  ]) {
    assert.match(ambientSource, new RegExp(label));
  }
});

test('dedicated workbench preserves the card-version export set', () => {
  for (const fileName of [
    'ambient-noise-results.json',
    'ambient-noise-dispersion.csv',
    'ambient-noise-stations.csv',
    'ambient-noise-methods.txt',
    'ambient-noise-project.json',
  ]) {
    assert.match(ambientSource, new RegExp(fileName.replace('.', '\\.')));
  }
  assert.match(ambientSource, /toolApi\.createJob/);
  assert.doesNotMatch(ambientSource, /127\.0\.0\.1:8000|localhost:8000/);
});

test('benchmark content is present on first render without a load click', () => {
  assert.match(ambientSource, /useState<AmbientResult>\(\(\) => createBenchmarkResult\(\)\)/);
  assert.doesNotMatch(ambientSource, />载入合成基准</);
  assert.match(ambientSource, /stage: 'run-all'/);
  assert.match(ambientSource, /pairResults, dispersion/);
  assert.match(ambientSource, /checkerboard:/);
});

test('customer-facing workbench surfaces do not render prototype banners', () => {
  assert.doesNotMatch(availabilitySource, /delivery-notice|readiness\.summary/);
  assert.match(cardSource, /readiness\.status !== 'prototype'/);
  assert.doesNotMatch(cardSource, /\{readiness\.label\}/);
});
