import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const component = fs.readFileSync(path.join(root, 'components', 'emergency-console-workbench.tsx'), 'utf8');
const availability = fs.readFileSync(path.join(root, 'components', 'workbench-availability.tsx'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'app', 'globals.css'), 'utf8');
const backend = fs.readFileSync(path.join(root, '..', 'backend_python', 'app', 'tools', 'emergency_console_full.py'), 'utf8');
const dispatcher = fs.readFileSync(path.join(root, '..', 'backend_python', 'app', 'tools', 'dispatcher.py'), 'utf8');

test('emergency route uses a dedicated layered React operations desk', () => {
  assert.match(availability, /EmergencyConsoleWorkbench/);
  assert.match(availability, /data-workbench="emergency-console"/);
  assert.match(component, /skyview-emergency-console-results/);
  assert.doesNotMatch(component, /当前仅用于流程|原型/);
});

test('first render includes a complete deterministic emergency benchmark', () => {
  for (const term of ['北侧边坡多源异常事件', 'GNSS 监测', '无人机巡检', '现场二组', '公众热线', '南侧临时安置点', '启动红色响应']) assert.match(component, new RegExp(term));
  assert.match(component, /useState<EmergencyResult>\(\(\) => sampleResult\(\)\)/);
});

test('incident, verification, tasks, resources, decisions and handover lifecycles are restored', () => {
  for (const term of ['事件态势图', '处置时间线', '风险矩阵', '多源线索队列', '任务依赖图', '通信日志', '决策证据链', '班次交接', '态势报告与交付']) assert.match(component, new RegExp(term));
  for (const model of ['incident', 'reports', 'verifications', 'mapLayers', 'resources', 'teams', 'shelters', 'tasks', 'dependencies', 'decisions', 'communications', 'shifts', 'situationReports', 'afterActionReviews', 'audit']) assert.match(backend, new RegExp(model));
});

test('all state changes cross the Go boundary and external services stay factual', () => {
  for (const action of ['verify-report', 'create-task', 'update-task', 'assign-resource', 'record-decision', 'send-communication', 'handover-shift', 'publish-situation-report', 'close-incident', 'after-action-review', 'runtime-status', 'validate', 'export']) assert.match(backend, new RegExp(action));
  assert.match(dispatcher, /emergency_console_full\.run_emergency_console/);
  assert.match(component, /toolApi\.createJob\([\s\S]*project\.id,[\s\S]*'emergency-console'/);
  assert.match(backend, /"sms": "not-configured"/);
  assert.match(backend, /"email": "not-configured"/);
  assert.match(backend, /"arbitraryCodeExecution": False/);
});

test('emergency desk is dense, high contrast, one-screen and responsive', () => {
  assert.match(styles, /\.emergencyx-workbench[\s\S]*height: calc\(100dvh - 78px\)/);
  assert.match(styles, /\.emergencyx-situation-view[\s\S]*grid-template-columns/);
  assert.match(styles, /\.emergencyx-dispatch-view[\s\S]*grid-template-columns/);
  assert.match(styles, /\.emergencyx-decision-view[\s\S]*grid-template-columns/);
  assert.match(styles, /@container \(max-width: 880px\)/);
});
