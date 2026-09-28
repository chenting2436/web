import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const workspace = path.resolve(import.meta.dirname, '..');
const component = fs.readFileSync(
  path.join(workspace, 'components', 'daily-practice-workbench.tsx'),
  'utf8',
);
const availability = fs.readFileSync(
  path.join(workspace, 'components', 'workbench-availability.tsx'),
  'utf8',
);

test('daily practice uses a dedicated React workbench', () => {
  assert.match(availability, /DailyPracticeWorkbench/);
  assert.match(availability, /workbench\.slug === 'daily-practice'/);
  assert.doesNotMatch(component, /当前仅用于流程|原型/);
});

test('daily practice exposes the complete card-edition learning flow', () => {
  for (const action of [
    'answer-practice',
    'build-adaptive-session',
    'toggle-favorite',
    'start-exam',
    'save-exam-answer',
    'submit-exam',
    'export',
  ]) {
    assert.match(component, new RegExp(action));
  }
  for (const view of ['practice', 'adaptive', 'exam', 'analytics', 'history', 'bank']) {
    assert.match(component, new RegExp(`'${view}'`));
  }
});

test('question filters and advanced question types are represented', () => {
  for (const mode of ['unanswered', 'wrong', 'favorites', 'adaptive']) {
    assert.match(component, new RegExp(`'${mode}'`));
  }
  for (const type of ['single', 'multiple', 'boolean', 'fill', 'ordering', 'case']) {
    assert.match(component, new RegExp(type));
  }
});

test('professional assessment features are visible and exportable', () => {
  for (const capability of [
    '能力自适应',
    '弱项突破',
    '到期复习',
    '高阶挑战',
    '能力点诊断',
    'qtiXml',
    'skillCsv',
  ]) {
    assert.match(component, new RegExp(capability));
  }
  assert.match(component, /6 × 120 = 720/);
  assert.match(component, /100/);
});

test('exam UI communicates server timing and answer isolation', () => {
  assert.match(component, /签名试卷凭证/);
  assert.match(component, /服务端时间/);
  assert.match(component, /考试模式不会即时公布答案/);
  assert.match(component, /考试进行期间，答案和解析不会发送到浏览器/);
});
