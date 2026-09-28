import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const component = fs.readFileSync(path.join(root, 'components', 'python-english-workbench.tsx'), 'utf8');
const availability = fs.readFileSync(path.join(root, 'components', 'workbench-availability.tsx'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'app', 'globals.css'), 'utf8');
const backend = fs.readFileSync(path.join(root, '..', 'backend_python', 'app', 'tools', 'python_english_full.py'), 'utf8');
const dispatcher = fs.readFileSync(path.join(root, '..', 'backend_python', 'app', 'tools', 'dispatcher.py'), 'utf8');

test('Python English has a dedicated React workbench and a ready first screen', () => {
  assert.match(availability, /PythonEnglishWorkbench/);
  assert.match(availability, /data-workbench="python-english"/);
  assert.match(component, /useState<PythonEnglishResult>\(\(\) => sampleResult\(\)\)/);
  for (const term of ['完整课程基准已载入', '64 个术语', '32 道考题', '8 篇指南']) assert.ok(component.includes(term), term);
  assert.doesNotMatch(component, /当前仅用于流程|载入合成基准|该功能暂未开放/);
});

test('all card-version learning areas and modes are present', () => {
  for (const term of ['学习总览', '词汇训练', '考试中心', '参考指南', '排行榜', '课程管理']) assert.match(component, new RegExp(term));
  for (const term of ['学习', '卡片', '测验', '朗读', '拼写']) assert.match(component, new RegExp(term));
  for (const action of ['record-learn', 'record-card', 'record-quiz', 'record-typing', 'record-pronunciation', 'start-exam', 'submit-exam', 'mark-reference-read', 'import-vocabulary', 'import-exam']) assert.match(backend, new RegExp(action));
});

test('catalog counts, mastery, privacy, and server-side exam boundary are explicit', () => {
  assert.match(backend, /CATALOG_VERSION = "2026\.09-card-parity-v1"/);
  assert.match(backend, /len\(current\["evidence"\]\) >= 3/);
  assert.match(backend, /"leaderboardOptIn": False/);
  assert.match(backend, /"pronunciationScoring": \{"status": "not-configured"/);
  assert.match(backend, /hmac\.compare_digest/);
  assert.match(component, /正确答案仅在提交后由 Python 服务返回/);
  assert.match(component, /toolApi\.createJob\(project\.id, 'python-english'/);
  assert.match(dispatcher, /python_english_full\.run_python_english/);
  assert.doesNotMatch(component, /127\.0\.0\.1:8000|localhost:8000|apiKey\s*[:=]/i);
});

test('learning cockpit is dense, high contrast, and responsive', () => {
  assert.match(styles, /\.pyeng-shell[\s\S]*height: calc\(100vh - 76px\)/);
  assert.match(styles, /--pyeng-ink: #172b4d/);
  assert.match(styles, /\.pyeng-training-layout[\s\S]*grid-template-columns: minmax\(210px, \.68fr\) minmax\(520px, 1\.65fr\) minmax\(220px, \.7fr\)/);
  assert.match(styles, /@container \(max-width: 900px\)[\s\S]*\.pyeng-shell/);
});
