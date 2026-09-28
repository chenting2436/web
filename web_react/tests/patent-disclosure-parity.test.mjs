import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const patentSource = await readFile(
  new URL('../components/patent-disclosure-workbench.tsx', import.meta.url),
  'utf8',
);
const availabilitySource = await readFile(
  new URL('../components/workbench-availability.tsx', import.meta.url),
  'utf8',
);
const definitionsSource = await readFile(
  new URL('../lib/tool-definitions.ts', import.meta.url),
  'utf8',
);
const noticeSource = await readFile(
  new URL('../OPEN_SOURCE_NOTICES.md', import.meta.url),
  'utf8',
);
const attributionSource = await readFile(
  new URL('../vendor/patent-assistant/SOURCE.md', import.meta.url),
  'utf8',
);
const licenseSource = await readFile(
  new URL('../vendor/patent-assistant/LICENSE.txt', import.meta.url),
  'utf8',
);

test('patent-disclosure route uses the dedicated React workbench', () => {
  assert.match(availabilitySource, /workbench\.slug === 'patent-disclosure'/);
  assert.match(availabilitySource, /<PatentDisclosureWorkbench/);
});

test('dedicated workbench preserves the exact ten-chapter disclosure structure', () => {
  for (const chapter of [
    '发明名称',
    '技术领域',
    '背景技术',
    '发明目的',
    '技术方案',
    '有益效果',
    '附图说明',
    '具体实施方式',
    '替代方案',
    '关键点与保护点',
  ]) {
    assert.match(patentSource, new RegExp(chapter));
  }
  assert.match(patentSource, /\['alternative_embodiments', '替代方案', false/);
});

test('project, analysis, editing, figure, quality and version workflows remain present', () => {
  for (const label of [
    '项目列表',
    '新建项目',
    '分析技术特征',
    '生成十章节',
    '附图清单',
    '质量检查',
    '历史版本',
    '恢复前会保存当前正文',
  ]) {
    assert.match(patentSource, new RegExp(label));
  }
  assert.match(patentSource, /slice\(0, 20\)/);
  assert.match(patentSource, /toolApi\.createJob/);
  assert.match(patentSource, /toolApi\.createVersion/);
  assert.doesNotMatch(patentSource, /127\.0\.0\.1:8000|localhost:8000/);
});

test('DOCX, Markdown and project JSON export and import remain present', () => {
  for (const label of ['导入项目', '导出 DOCX', '导出 Markdown', '导出项目']) {
    assert.match(patentSource, new RegExp(label));
  }
  for (const action of ['create', 'analyze', 'generate-chapter', 'generate-all', 'audit', 'export']) {
    assert.match(definitionsSource, new RegExp(`id: '${action}'`));
  }
  assert.match(patentSource, /schema: 'skyview-patent-assistant'/);
});

test('upstream commit, attribution and MIT license ship with the React project', () => {
  for (const source of [patentSource, noticeSource, attributionSource]) {
    assert.match(source, /Dyp130\/Patent-assistant/);
    assert.match(source, /7123187a1e071b402c4e87ff6d2ce8d1aff825e4|7123187/);
  }
  assert.match(licenseSource, /MIT License/);
  assert.match(licenseSource, /Copyright \(c\) 2025 Patent Drafting Assistant Contributors/);
});

test('customer-facing patent workbench has no prototype disclaimer', () => {
  assert.doesNotMatch(patentSource, /原型|仅用于流程|不作为正式科研/);
});
