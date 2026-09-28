import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const componentUrl = new URL('../components/ai-assessment-workbench.tsx', import.meta.url);
const routeUrl = new URL('../components/workbench-availability.tsx', import.meta.url);
const cssUrl = new URL('../app/globals.css', import.meta.url);
const dispatcherUrl = new URL('../../backend_python/app/tools/dispatcher.py', import.meta.url);
const backendUrl = new URL('../../backend_python/app/tools/ai_assessment_full.py', import.meta.url);

test('AI assessment uses a dedicated layered React judge console', async () => {
  const [component, route] = await Promise.all([
    readFile(componentUrl, 'utf8'),
    readFile(routeUrl, 'utf8'),
  ]);
  assert.match(route, /AiAssessmentWorkbench/);
  assert.match(route, /data-workbench="ai-assessment"/);
  assert.match(component, /MonacoCodeEditor/);
  assert.match(component, /题目与代码/);
  assert.match(component, /提交记录/);
  assert.match(component, /题库管理/);
  assert.match(component, /运行节点/);
  assert.match(component, /交付与审计/);
});

test('the complete card-version bank and judging model are available on first load', async () => {
  const backend = await readFile(backendUrl, 'utf8');
  for (const id of [
    'stream-sum', 'station-deduplicate', 'coordinate-validator', 'moving-average',
    'missing-intervals', 'run-length', 'severity-routing', 'merge-alert-windows',
    'grid-hotspots', 'zonal-damage', 'shortest-evacuation', 'dependency-order',
    'rolling-anomaly', 'earthquake-classifier', 'frequency-table',
  ]) assert.match(backend, new RegExp(id));
  assert.match(backend, /verified-benchmark-replay/);
  assert.match(backend, /hiddenDataRedacted/);
  assert.match(backend, /testCases/);
});

test('projects, submissions, validation and delivery cross the Go job boundary', async () => {
  const [component, dispatcher] = await Promise.all([
    readFile(componentUrl, 'utf8'),
    readFile(dispatcherUrl, 'utf8'),
  ]);
  assert.match(component, /toolApi\.createJob/);
  assert.match(component, /toolApi\.updateProject/);
  assert.match(component, /'save-draft'/);
  assert.match(component, /'review-source'/);
  assert.match(component, /'submit'/);
  assert.match(component, /'validate-bank'/);
  assert.match(component, /'import-problems'/);
  assert.match(component, /'export'/);
  assert.match(dispatcher, /ai_assessment_full\.run_ai_assessment/);
});

test('untrusted code execution is delegated to a configurable isolated runner', async () => {
  const backend = await readFile(backendUrl, 'utf8');
  assert.match(backend, /JUDGE0_API_URL/);
  assert.match(backend, /submissions\/batch/);
  assert.match(backend, /Judge0-compatible/);
  assert.match(backend, /go-judge/);
  assert.match(backend, /production.*HTTPS|生产地址必须使用 HTTPS/);
  assert.doesNotMatch(backend, /subprocess\.(run|Popen)/);
});

test('the dense judge layout remains bounded and responsive', async () => {
  const css = await readFile(cssUrl, 'utf8');
  assert.match(css, /\.aa-workbench[\s\S]*height:\s*clamp/);
  assert.match(css, /\.aa-coding-layout[\s\S]*grid-template-columns/);
  assert.match(css, /@container assessment \(max-width: 940px\)/);
  assert.match(css, /@container assessment \(max-width: 620px\)/);
  assert.match(css, /\.aa-verdict\.accepted/);
  assert.match(css, /\.aa-verdict\.wrong-answer/);
});
