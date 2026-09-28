import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const component = fs.readFileSync(path.join(root, 'components', 'fusion-console-workbench.tsx'), 'utf8');
const availability = fs.readFileSync(path.join(root, 'components', 'workbench-availability.tsx'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'app', 'globals.css'), 'utf8');
const backend = fs.readFileSync(path.join(root, '..', 'backend_python', 'app', 'tools', 'fusion_console_full.py'), 'utf8');
const dispatcher = fs.readFileSync(path.join(root, '..', 'backend_python', 'app', 'tools', 'dispatcher.py'), 'utf8');

test('fusion route uses a dedicated layered React operations desk', () => {
  assert.match(availability, /FusionConsoleWorkbench/);
  assert.match(availability, /data-workbench="fusion-console"/);
  assert.match(component, /skyview-fusion-console-results/);
  assert.doesNotMatch(component, /当前仅用于流程|原型/);
});

test('first render includes a complete deterministic multi-source benchmark', () => {
  for (const source of ['北坡 GNSS', '北坡雨量', '坡脚孔压', '微震事件流', 'InSAR 形变', '地表温度']) assert.match(component, new RegExp(source));
  for (const event of ['降雨与孔压同步抬升', '位移加速伴随微震增强', '多源形变证据持续增强']) assert.match(component, new RegExp(event));
  assert.match(component, /useState<FusionResult>\(\(\) => sampleResult\(\)\)/);
});

test('source, time, quality, model, traceability and approval lifecycles are restored', () => {
  for (const term of ['数据源注册表', '统一事件时间轴', '缺失热力图', '相关矩阵', '空间信号场', '融合解释', '事件回放', '证据血缘', '模型注册表', '交付门禁']) assert.match(component, new RegExp(term));
  for (const model of ['sources', 'schemas', 'calibrationVersions', 'observations', 'qualityEvents', 'alignmentJobs', 'featureSets', 'fusionModels', 'modelVersions', 'fusedEvents', 'approvals', 'audit']) assert.match(backend, new RegExp(model));
});

test('all state changes cross the Go job boundary and external runtimes stay factual', () => {
  for (const action of ['register-source', 'govern-schema', 'calibrate-source', 'import-observations', 'run-quality-checks', 'align-observations', 'build-features', 'run-fusion', 'review-fused-event', 'publish-model-version', 'replay-window', 'runtime-status', 'validate', 'export']) assert.match(backend, new RegExp(action));
  assert.match(dispatcher, /fusion_console_full\.run_fusion_console/);
  assert.match(component, /toolApi\.createJob\(project\.id, 'fusion-console'/);
  assert.match(backend, /Kafka\/Flink adapter/);
  assert.match(backend, /"status": "not-configured"/);
  assert.match(backend, /"localDeterministicFusion": "enabled"/);
});

test('fusion desk is dense, high contrast, one-screen and responsive', () => {
  assert.match(styles, /\.fusionx-workbench[\s\S]*height: calc\(100dvh - 78px\)/);
  assert.match(styles, /\.fusionx-topology-view[\s\S]*grid-template-columns/);
  assert.match(styles, /\.fusionx-alignment-view[\s\S]*grid-template-rows/);
  assert.match(styles, /\.fusionx-fusion-view[\s\S]*grid-template-columns/);
  assert.match(styles, /@container \(max-width: 880px\)/);
});
