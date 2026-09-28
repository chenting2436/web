import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../components/patent-transfer-workbench.tsx', import.meta.url), 'utf8');
const availability = await readFile(new URL('../components/workbench-availability.tsx', import.meta.url), 'utf8');
const styles = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');

test('patent transfer route uses a dedicated layered React workbench', () => {
  assert.match(availability, /workbench\.slug === 'patent-transfer'/);
  assert.match(availability, /<PatentTransferWorkbench/);
  assert.match(availability, /data-workbench="patent-transfer"/);
  assert.match(styles, /Patent transfer: evidence-led layered task desk/);
});

test('first render includes a complete local transfer project', () => {
  assert.match(source, /useState<PatentResult>\(\(\) => createBenchmarkResult\(\)\)/);
  assert.match(source, /LOCAL-CN-001/);
  assert.match(source, /stage: 'run-all'/);
  assert.match(source, /法律状态保持待核验/);
  assert.doesNotMatch(source, />载入示例/);
});

test('all nine card-version work areas are present', () => {
  for (const label of ['项目总览', '技术交底', '检索情报', '新颖性与创造性', '权利要求', '自由实施初筛', '转化评估', '期限与证据', '报告归档']) {
    assert.match(source, new RegExp(label));
  }
  for (const capability of ['EPO CQL', '必要特征矩阵', '权利要求树', '风险矩阵', '技术成熟度路线', '许可现金流估值', '证据与指纹']) {
    assert.match(source, new RegExp(capability));
  }
});

test('compute crosses the Go job boundary and exports the full work package', () => {
  assert.match(source, /toolApi\.createJob/);
  assert.match(source, /'patent-transfer', action/);
  assert.doesNotMatch(source, /127\.0\.0\.1:8000|localhost:8000/);
  for (const fileName of ['patent-transfer-assessment.md', 'patent-transfer-assessment.html', 'patent-records.csv', 'patent-feature-matrix.csv', 'patent-fto-screening.csv', 'patent-deadlines.csv', 'patent-transfer-package.zip']) {
    assert.match(source, new RegExp(fileName.replaceAll('.', '\\.')));
  }
});

test('dense transfer layout uses a six-metric rail and internal scrolling', () => {
  assert.match(styles, /\.transfer-kpi-rail \{[\s\S]*?repeat\(6, minmax\(145px, 1fr\)\)/);
  assert.match(styles, /\.transfer-view \{[\s\S]*?overflow: auto/);
  assert.match(styles, /@container transfer-workbench \(max-width: 900px\)/);
  assert.match(styles, /--transfer-ink: #17213a/);
  assert.match(styles, /--transfer-accent: #3e4e9a/);
});
