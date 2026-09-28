import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(
  new URL('../components/remote-sensing-workbench.tsx', import.meta.url),
  'utf8',
);
const availability = await readFile(
  new URL('../components/workbench-availability.tsx', import.meta.url),
  'utf8',
);

test('disaster route uses a dedicated React workbench', () => {
  assert.match(availability, /workbench\.slug === 'disaster-remote-sensing'/);
  assert.match(availability, /<RemoteSensingWorkbench/);
});

test('six card-version views and direct benchmark are preserved', () => {
  for (const label of [
    '事件总览',
    '变化检测',
    '损毁筛查',
    '综合评估',
    '质量验证',
    '报告归档',
  ])
    assert.match(source, new RegExp(label));
  assert.match(source, /useState<RemoteResult>/);
  assert.match(source, /benchmarkResult\(initial\)/);
  assert.doesNotMatch(source, />载入合成基准</);
  assert.match(source, /4×4 分区损毁矩阵/);
});

test('algorithms, QA, validation, and complete exports are present', () => {
  for (const marker of [
    'ndvi-loss',
    'dnbr',
    'ndwi-gain',
    'rgb-cva',
    'brightness',
    'band-abs',
    'Otsu 自动阈值',
    'Precision',
    'Recall',
    'F1',
    'IoU',
  ])
    assert.match(source, new RegExp(marker));
  for (const name of [
    'remote-sensing-report.md',
    'remote-sensing-report.html',
    'remote-sensing-regions.csv',
    'remote-sensing-zones.csv',
    'remote-sensing-regions.geojson',
    'remote-sensing-change-mask.png',
    'remote-sensing-change-mask.tif',
    'remote-sensing-analysis-package.zip',
  ])
    assert.match(source, new RegExp(name.replaceAll('.', '\\.')));
  assert.match(source, /toolApi\.createJob/);
  assert.doesNotMatch(source, /127\.0\.0\.1:8000|localhost:8000/);
  assert.doesNotMatch(source, /当前仅用于流程|结果不作为正式|原型/);
});
