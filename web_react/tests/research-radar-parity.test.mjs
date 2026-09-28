import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../components/research-radar-workbench.tsx', import.meta.url), 'utf8');
const availability = await readFile(new URL('../components/workbench-availability.tsx', import.meta.url), 'utf8');
const styles = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');
const workerCapabilities = await readFile(new URL('../../verification/build-dev-worker-capabilities.mjs', import.meta.url), 'utf8');

test('research radar route uses a dedicated layered React workbench', () => {
  assert.match(availability, /workbench\.slug === 'research-radar'/);
  assert.match(availability, /<ResearchRadarWorkbench/);
  assert.match(availability, /data-workbench="research-radar"/);
  assert.match(styles, /Research radar: compact layered evidence intelligence desk/);
});

test('complete deterministic baseline is visible on the first render', () => {
  assert.match(source, /useState<RadarResult>\(\(\) => createBenchmarkResult\(\)\)/);
  assert.match(source, /背景噪声层析成像的可复现处理链/);
  assert.match(source, /开放地球物理数据的证据溯源规范/);
  assert.match(source, /stage: 'run-all'/);
  assert.match(source, /source: '离线基准'/);
  assert.doesNotMatch(source, />载入示例/);
});

test('all eight card-version areas, charts, evidence and source boundaries are restored', () => {
  for (const label of ['雷达总览', '实时发现', '文献库', '主题图谱', '证据矩阵', '监测任务', '成果联动', '数据源']) assert.match(source, new RegExp(label));
  for (const capability of ['年度趋势', '开放获取', '主题分布', '主题共现图', '证据等级分布', '人工使用边界', '运行与通知记录', '来源与运行边界']) assert.match(source, new RegExp(capability));
  assert.match(source, /离线基准与真实检索结果始终分别标识/);
  assert.match(source, /生产定时调度和外部通知通道尚未配置/);
});

test('complete actions cross the Go job boundary and imports never execute content', () => {
  assert.match(source, /toolApi\.createJob/);
  assert.match(source, /'research-radar', action/);
  assert.match(source, /toolApi\.createVersion/);
  for (const action of ['search-live', 'import-records', 'dedupe', 'update-library', 'update-evidence', 'run-monitor', 'transfer']) {
    assert.match(source, new RegExp(`'${action}'`));
    assert.match(workerCapabilities, new RegExp(`'${action}'`));
  }
  assert.match(source, /BibTeX、RIS、JSON 只解析数据，不执行上传内容/);
  assert.doesNotMatch(source, /127\.0\.0\.1:8000|localhost:8000/);
});

test('full delivery set and compact high-contrast layout are present', () => {
  for (const label of ['BibTeX', 'RIS', '馆藏 CSV', '知识库 MD', '联动 JSON', '完整备份']) assert.match(source, new RegExp(label));
  assert.match(styles, /\.rrx-workbench \{[\s\S]*?height: 100%[\s\S]*?overflow: hidden/);
  assert.match(styles, /\.rrx-kpis \{[\s\S]*?repeat\(6, minmax\(110px, 1fr\)\)/);
  assert.match(styles, /\.rrx-view \{[\s\S]*?overflow: auto/);
  assert.match(styles, /@container rrx-workbench \(max-width: 760px\)/);
  assert.match(styles, /--rrx-ink: #14213a/);
  assert.doesNotMatch(source, /原型|当前仅用于流程和交互评审/);
});
