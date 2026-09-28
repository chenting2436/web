import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const component = fs.readFileSync(path.join(root, 'components', 'ai-report-workbench.tsx'), 'utf8');
const availability = fs.readFileSync(path.join(root, 'components', 'workbench-availability.tsx'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'app', 'globals.css'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'public', 'workers', 'webllm-report-worker.mjs'), 'utf8');
const backend = fs.readFileSync(path.join(root, '..', 'backend_python', 'app', 'tools', 'ai_report_full.py'), 'utf8');
const dispatcher = fs.readFileSync(path.join(root, '..', 'backend_python', 'app', 'tools', 'dispatcher.py'), 'utf8');

test('AI report has a dedicated React workbench and a full first-screen benchmark', () => {
  assert.match(availability, /AiReportWorkbench/);
  assert.match(availability, /data-workbench="ai-report"/);
  assert.match(component, /useState<AiReportResult>\(\(\) => sampleResult\(\)\)/);
  for (const term of ['边坡监测证据解释与课程报告', '完整证据报告基准已载入', '报告流水线', '高相关证据']) assert.ok(component.includes(term), term);
  assert.doesNotMatch(component, /当前仅用于流程|原型|载入合成基准/);
});

test('all eight card-version report workflows are restored and enriched', () => {
  for (const term of ['总览', '材料与证据', '证据问答', '完整报告', '报告核验', '不可变版本', '完整交付包', '浏览器本地模型']) assert.match(component, new RegExp(term));
  for (const reportType of ['explain', 'lab', 'code', 'paper', 'lesson', 'analysis', 'project', 'custom']) assert.match(backend, new RegExp(`"${reportType}"`));
  for (const action of ['import-material', 'register-url', 'generate-extractive', 'record-local-generation', 'ask-extractive', 'record-local-chat', 'audit-report', 'create-version', 'restore-version', 'import-project', 'export']) assert.match(backend, new RegExp(action));
});

test('Go and Python boundaries, stable evidence, and real deliveries are explicit', () => {
  assert.match(component, /toolApi\.createJob\(project\.id, 'ai-report'/);
  assert.match(component, /toolApi\.createVersion/);
  assert.match(dispatcher, /ai_report_full\.run_ai_report/);
  for (const term of ['MAX_FILE_BYTES', 'MAX_EXPANDED_BYTES', 'MAX_CHUNKS', '_safe_zip', '_audit_report', '_source_index', '_docx']) assert.match(backend, new RegExp(term));
  assert.match(backend, /"arbitraryCodeExecution": False/);
  assert.doesNotMatch(component, /127\.0\.0\.1:8000|localhost:8000|apiKey\s*[:=]|endpoint\s*[:=]/i);
});

test('browser WebLLM is fixed-version, opt-in, interruptible, and releasable', () => {
  assert.match(worker, /@mlc-ai\/web-llm@0\.2\.85/);
  assert.match(component, /@mlc-ai\/web-llm@0\.2\.85/);
  assert.match(component, /'gpu' in navigator/);
  assert.match(component, /interruptGenerate/);
  assert.match(component, /unload/);
  assert.match(component, /模型仅在用户主动启用|仅在你点击启用后下载模型/);
});

test('evidence studio is dense, high-contrast, one-screen, and responsive', () => {
  assert.match(styles, /\.airx-shell[\s\S]*height: max\(690px, calc\(100dvh - 82px\)\)/);
  assert.match(styles, /\.airx-dashboard[\s\S]*grid-template-columns: 270px minmax\(470px, 1fr\) 275px/);
  assert.match(styles, /--airx-ink: #132946/);
  assert.match(styles, /@container \(max-width: 900px\)[\s\S]*\.airx-shell/);
});
