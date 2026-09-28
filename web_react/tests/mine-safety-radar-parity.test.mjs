import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../components/mine-safety-radar-workbench.tsx', import.meta.url), 'utf8');
const availability = await readFile(new URL('../components/workbench-availability.tsx', import.meta.url), 'utf8');
const styles = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');
const workerCapabilities = await readFile(new URL('../../verification/build-dev-worker-capabilities.mjs', import.meta.url), 'utf8');

test('mine safety radar route uses an isolated layered React workbench', () => {
  assert.match(availability, /workbench\.slug === 'mine-safety-radar'/);
  assert.match(availability, /<MineSafetyRadarWorkbench/);
  assert.match(availability, /data-workbench="mine-safety-radar"/);
  assert.match(styles, /Mine safety radar: isolated high-contrast industrial evidence desk/);
});

test('complete mine benchmark and taxonomy are available on first render', () => {
  assert.match(source, /useState<MineResult>\(\(\) => createBenchmarkResult\(\)\)/);
  assert.match(source, /露天矿边坡 InSAR 与 GNSS 形变融合/);
  assert.match(source, /矿山灾害多模态基础模型评测/);
  assert.match(source, /stage: 'run-all'/);
  assert.match(source, /namespace: 'mine-safety'/);
  assert.match(source, /64 个组合/);
  assert.doesNotMatch(source, />载入示例/);
});

test('all eight card-version areas and full domain capacities are restored', () => {
  for (const label of ['安全态势', '文献发现', '专业证据库', '灾种技术图谱', '工程证据', '前沿监测', '转化管线', '数据源']) assert.match(source, new RegExp(label));
  for (const label of ['边坡与滑坡', '岩爆与冲击地压', '瓦斯与通风', '矿井水害', '火灾与自燃', '粉尘与职业健康', '尾矿库安全', '设备与人员安全']) assert.match(source, new RegExp(label));
  for (const label of ['遥感 / InSAR / UAV', '微震与地球物理', '机器视觉', '时序预测', '多源融合', '数字孪生', '知识图谱 / 大模型', '物理与数值模拟']) assert.match(source, new RegExp(label.replaceAll('/', '\\/')));
  for (const label of ['影像', '波形信号', '位移监测', '环境传感', '点云 / 三维', '文本与规程']) assert.match(source, new RegExp(label.replaceAll('/', '\\/')));
});

test('Go job boundary, isolated state, transparent safety boundary and actions are explicit', () => {
  assert.match(source, /toolApi\.createJob/);
  assert.match(source, /'mine-safety-radar', action/);
  assert.match(source, /toolApi\.createVersion/);
  assert.match(source, /dataSpaceIsolated: true/);
  assert.match(source, /crossModeReuseRequiresTransfer: true/);
  assert.match(source, /safetyDecisionAutomation: false/);
  assert.match(source, /研究信号不自动形成预警、停产或人员安全决策/);
  for (const action of ['search-live', 'classify', 'import-records', 'dedupe', 'update-library', 'update-evidence', 'run-monitor', 'transfer']) {
    assert.match(workerCapabilities, new RegExp(`'${action}'`));
  }
  assert.doesNotMatch(source, /127\.0\.0\.1:8000|localhost:8000/);
});

test('delivery formats and compact high-contrast responsive layout are present', () => {
  for (const label of ['BibTeX', 'RIS', '证据库 CSV', '知识资料 MD', '联动 JSON', '完整备份']) assert.match(source, new RegExp(label));
  assert.match(styles, /\.mine-workbench \{[\s\S]*?height: 100%[\s\S]*?overflow: hidden/);
  assert.match(styles, /\.mine-kpis \{[\s\S]*?repeat\(6, minmax\(110px, 1fr\)\)/);
  assert.match(styles, /\.mine-view \{[\s\S]*?overflow: auto/);
  assert.match(styles, /@container mine-workbench \(max-width: 760px\)/);
  assert.match(styles, /--mine-ink: #172238/);
  assert.doesNotMatch(source, /原型|当前仅用于流程和交互评审/);
});
