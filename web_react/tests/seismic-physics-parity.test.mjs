import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(
  new URL('../components/seismic-physics-workbench.tsx', import.meta.url),
  'utf8',
);
const availability = await readFile(
  new URL('../components/workbench-availability.tsx', import.meta.url),
  'utf8',
);
const styles = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');

test('seismic route uses a dedicated layered React workbench', () => {
  assert.match(availability, /workbench\.slug === 'seismic-physics'/);
  assert.match(availability, /<SeismicPhysicsWorkbench/);
  assert.match(availability, /data-workbench="seismic-physics"/);
  assert.match(styles, /Seismic physics: dense layered task desk/);
});

test('first render includes a complete deterministic three-component benchmark', () => {
  assert.match(source, /useState<SeismicResult>\(\(\) => createBenchmarkResult\(\)\)/);
  assert.match(source, /SC\.SVL1\.\.BHZ/);
  assert.match(source, /SC\.SVL1\.\.BHN/);
  assert.match(source, /SC\.SVL1\.\.BHE/);
  assert.match(source, /stage: 'run-all'/);
  assert.doesNotMatch(source, />载入合成基准</);
});

test('dedicated workbench preserves the card-version analysis stages', () => {
  for (const label of [
    '项目总览', '波形与预处理', '检测与拾取', '频谱与时频',
    '信号与物理', '验证与证据', '成果交付',
  ]) {
    assert.match(source, new RegExp(label));
  }
  for (const capability of [
    'STA/LTA', 'AIC 窗口拾取', 'Welch PSD', '短时傅里叶谱',
    '粒子运动', '质量门禁', '证据链',
  ]) {
    assert.match(source, new RegExp(capability));
  }
});

test('all compute operations cross the Go job boundary', () => {
  assert.match(source, /toolApi\.createJob/);
  assert.match(source, /'seismic-physics', action/);
  assert.doesNotMatch(source, /127\.0\.0\.1:8000|localhost:8000/);
});

test('workbench exposes the full reproducible export set', () => {
  for (const fileName of [
    'seismic-analysis-report.md',
    'seismic-analysis-report.html',
    'seismic-processed-waveform.csv',
    'seismic-welch-psd.csv',
    'seismic-event-catalog.csv',
    'seismic-phase-picks.csv',
    'seismic-analysis-package.zip',
  ]) {
    assert.match(source, new RegExp(fileName.replaceAll('.', '\\.')));
  }
});

test('seismic layout uses compact one-line metrics and internal scrolling', () => {
  assert.match(styles, /\.seismic-kpi-rail \{[\s\S]*?repeat\(5, minmax\(132px, 1fr\)\)/);
  assert.match(styles, /\.seismic-view \{[\s\S]*?overflow: auto/);
  assert.match(styles, /@container seismic-workbench \(max-width: 900px\)/);
  assert.match(styles, /--seismic-ink: #17213a/);
  assert.match(styles, /--seismic-accent: #3f52a0/);
});
