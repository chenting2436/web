import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../components/research-automation-workbench.tsx', import.meta.url), 'utf8');
const availability = await readFile(new URL('../components/workbench-availability.tsx', import.meta.url), 'utf8');
const styles = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');
const workerCapabilities = await readFile(new URL('../../verification/build-dev-worker-capabilities.mjs', import.meta.url), 'utf8');

test('research automation route uses a dedicated layered React workbench', () => {
  assert.match(availability, /workbench\.slug === 'research-automation'/);
  assert.match(availability, /<ResearchAutomationWorkbench/);
  assert.match(availability, /data-workbench="research-automation"/);
  assert.match(styles, /Research automation: durable-workflow inspired orchestration studio/);
});

test('complete deterministic workflow is available on first render', () => {
  assert.match(source, /useState<AutomationResult>\(\(\) => createBenchmarkResult\(\)\)/);
  assert.match(source, /AI\+矿山安全研究雷达/);
  for (const label of ['定时触发', '读取材料清单', '质量与重复检查', '主题与方法分析', '人工复核', '生成研究雷达摘要']) assert.match(source, new RegExp(label));
  assert.match(source, /stage: 'run-all'/);
  assert.match(source, /deterministic-preview/);
  assert.doesNotMatch(source, />载入示例/);
});

test('legacy templates, node types and eight production-oriented areas are restored', () => {
  for (const label of ['系统综述材料流水线', '遥感证据日报', '可复现实验流水线']) assert.match(source, new RegExp(label));
  for (const label of ['运行总览', '流程设计', '流程配置', '变量与密钥', '运行追踪', '审批与恢复', '产物血缘', '版本交付']) assert.match(source, new RegExp(label));
  for (const label of ['trigger', 'source', 'transform', 'analysis', 'review', 'output']) assert.match(source, new RegExp(`'${label}'`));
  for (const capability of ['节点依赖画布', '节点级执行轨迹', '结构化日志', '人工审批队列', '数据血缘', '流程版本']) assert.match(source, new RegExp(capability));
});

test('all state changes cross the Go job boundary and preserve safety constraints', () => {
  assert.match(source, /toolApi\.createJob/);
  assert.match(source, /'research-automation', action/);
  assert.match(source, /toolApi\.createVersion/);
  for (const action of ['validate-workflow', 'update-workflow', 'apply-template', 'add-node', 'update-node', 'add-variable', 'run-preview', 'retry-step', 'approve', 'cancel-run', 'publish', 'import-workflow']) {
    assert.match(workerCapabilities, new RegExp(`'${action}'`));
  }
  assert.match(source, /arbitraryCodeExecution: false/);
  assert.match(source, /secretValuesStored: false/);
  assert.match(source, /previewResultsPublishable: false/);
  assert.doesNotMatch(source, /127\.0\.0\.1:8000|localhost:8000/);
});

test('legacy workflow export plus operational evidence and compact responsive layout are present', () => {
  for (const label of ['流程 JSON v1', '运行 CSV', '日志 NDJSON', '血缘 JSON', '运行报告 MD', '完整备份']) assert.match(source, new RegExp(label));
  assert.match(source, /skyview-research-workflow/);
  assert.match(styles, /\.auto-workbench \{[\s\S]*?height: 100%[\s\S]*?overflow: hidden/);
  assert.match(styles, /\.auto-kpis \{[\s\S]*?repeat\(6, minmax\(7rem, 1fr\)\)/);
  assert.match(styles, /\.auto-view \{[\s\S]*?overflow: auto/);
  assert.match(styles, /@container auto-workbench \(max-width: 780px\)/);
  assert.match(styles, /--auto-ink: #142238/);
  assert.doesNotMatch(source, /原型|当前仅用于流程和交互评审/);
});
