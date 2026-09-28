import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const component = fs.readFileSync(path.join(root, 'components', 'project-workspace-workbench.tsx'), 'utf8');
const availability = fs.readFileSync(path.join(root, 'components', 'workbench-availability.tsx'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'app', 'globals.css'), 'utf8');
const backend = fs.readFileSync(path.join(root, '..', 'backend_python', 'app', 'tools', 'project_workspace_full.py'), 'utf8');
const dispatcher = fs.readFileSync(path.join(root, '..', 'backend_python', 'app', 'tools', 'dispatcher.py'), 'utf8');

test('project workspace route uses a dedicated layered React workbench', () => {
  assert.match(availability, /ProjectWorkspaceWorkbench/);
  assert.match(availability, /data-workbench="project-workspace"/);
  assert.match(component, /skyview-project-workspace-results/);
  assert.doesNotMatch(component, /当前仅用于流程|原型/);
});

test('first render includes a complete deterministic project portfolio', () => {
  for (const term of ['北岭边坡风险研究', '矿山安全数据课程项目', '历史裂缝编目', '训练位移趋势风险模型', '数据基线冻结', '模型独立验证']) assert.match(component, new RegExp(term));
  assert.match(component, /useState<ProjectResult>\(\(\) => sampleResult\(\)\)/);
});

test('card-version features and production-shaped models are restored', () => {
  for (const term of ['项目总览', '任务看板', '列表与时间线', '团队与协作', '里程碑与交付', '故事点燃尽', '阶段笔记', '最近活动与审计', '完整交付包']) assert.match(component, new RegExp(term));
  for (const model of ['projects', 'members', 'statuses', 'labels', 'cycles', 'milestones', 'tasks', 'comments', 'attachments', 'noteRevisions', 'activities', 'notifications', 'snapshots', 'importJobs', 'audit']) assert.match(backend, new RegExp(model));
});

test('mutations cross the Go boundary and integrations remain factual', () => {
  for (const action of ['create-project', 'archive-project', 'create-task', 'move-task', 'archive-task', 'add-dependency', 'add-comment', 'add-attachment', 'add-member', 'create-cycle', 'create-milestone', 'update-note', 'create-snapshot', 'restore-snapshot', 'import-project', 'runtime-status', 'validate', 'export']) assert.match(backend, new RegExp(action));
  assert.match(dispatcher, /project_workspace_full\.run_project_workspace/);
  assert.match(component, /toolApi\.createJob\([\s\S]*project\.id,[\s\S]*'project-workspace'/);
  assert.match(backend, /"objectStorage": \{"status": "not-configured"/);
  assert.match(backend, /"webhook": \{"status": "not-configured"/);
  assert.match(backend, /"arbitraryCodeExecution": False/);
});

test('project desk is dense, high contrast, one-screen and responsive', () => {
  assert.match(styles, /\.projectx-workbench[\s\S]*height: calc\(100dvh - 78px\)/);
  assert.match(styles, /\.projectx-overview-grid[\s\S]*grid-template-columns/);
  assert.match(styles, /\.projectx-board[\s\S]*grid-template-columns: repeat\(6/);
  assert.match(styles, /\.projectx-team-grid[\s\S]*grid-template-columns/);
  assert.match(styles, /@container \(max-width: 850px\)/);
});
