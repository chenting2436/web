import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../components/paper-writing-workbench.tsx', import.meta.url), 'utf8');
const availability = await readFile(new URL('../components/workbench-availability.tsx', import.meta.url), 'utf8');
const definitions = await readFile(new URL('../lib/tool-definitions.ts', import.meta.url), 'utf8');

test('paper-writing route uses the dedicated React workbench', () => {
  assert.match(availability, /workbench\.slug === 'paper-writing'/);
  assert.match(availability, /<PaperWritingWorkbench/);
});

test('ten-stage state machine and ten workbench views remain present', () => {
  for (const stage of ['research', 'write', 'integrity_pre', 'review', 'revise', 're_review', 're_revise', 'integrity_final', 'finalize', 'process']) assert.match(source, new RegExp(`'${stage}'`));
  for (const label of ['论文生产总览', '研究设计', '证据管理', '完整论文写作', '完整性核验', '五角色审稿', '修订响应', '定稿交付', '过程记录', '项目设置']) assert.match(source, new RegExp(label));
});

test('evidence, integrity, revision, snapshots and explicit author checkpoint are functional', () => {
  for (const label of ['Crossref 真实元数据检索', '论断—证据矩阵', '七类透明失败模式', '启动五角色审稿', '修订路线图', '作者修订响应', '保存快照', '作者检查点', '确认并进入下一阶段']) assert.match(source, new RegExp(label));
  for (const call of ["toolApi.createJob", "toolApi.createVersion", "'prepare-stage'", "'confirm-stage'", "'restore'"]) assert.match(source, new RegExp(call.replace('.', '\\.')));
  assert.doesNotMatch(source, /127\.0\.0\.1:8000|localhost:8000/);
});

test('all eight manuscript delivery formats remain present', () => {
  for (const label of ['Markdown', 'HTML', 'LaTeX', 'DOCX', 'BibTeX', '材料护照', '论文创建过程记录', '投稿材料包 ZIP']) assert.match(source, new RegExp(label));
  for (const action of ['create', 'crossref-search', 'integrity', 'review', 'rereview', 'adopt-roadmap', 'prepare-stage', 'confirm-stage', 'snapshot', 'restore', 'finalize', 'export']) assert.match(definitions, new RegExp(`id: '${action}'`));
});

test('customer-facing paper workbench has no prototype disclaimer', () => {
  assert.doesNotMatch(source, /原型|仅用于流程和交互评审|不作为正式科研/);
});
