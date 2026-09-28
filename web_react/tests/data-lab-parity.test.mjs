import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const component = fs.readFileSync(path.join(root, 'components', 'data-lab-workbench.tsx'), 'utf8');
const availability = fs.readFileSync(path.join(root, 'components', 'workbench-availability.tsx'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'app', 'globals.css'), 'utf8');
const backend = fs.readFileSync(path.join(root, '..', 'backend_python', 'app', 'tools', 'data_lab_full.py'), 'utf8');
const dispatcher = fs.readFileSync(path.join(root, '..', 'backend_python', 'app', 'tools', 'dispatcher.py'), 'utf8');

test('data lab uses a dedicated React workbench with a full first-screen benchmark', () => {
  assert.match(availability, /DataLabWorkbench/);
  assert.match(availability, /data-workbench="data-lab"/);
  assert.match(component, /useState<DataLabResult>\(\(\) => sampleResult\(\)\)/);
  for (const term of ['灾害风险台账治理', '分面筛选', '当前数据视图', '字段操作', '位移速率(mm/d)']) assert.ok(component.includes(term), term);
  assert.doesNotMatch(component, /当前仅用于流程|原型|载入合成基准/);
});

test('card-version cleaning parity and enriched governance flows are present', () => {
  for (const term of ['数据表', '字段画像', '分面与统计', '分组聚合', '聚合 CSV', '清洗历史', '质量与交付', '无限撤销 / 重做', '配方复用', '完整项目交换包']) assert.match(component, new RegExp(term));
  for (const operation of ['collapse-whitespace', 'normalize-missing', 'fill-missing', 'transform', 'replace', 'convert-number', 'convert-date', 'deduplicate', 'remove-empty-rows', 'split-column', 'add-column', 'rename-column', 'remove-column']) assert.match(component, new RegExp(operation));
  for (const action of ['import-data', 'apply-operation', 'edit-cell', 'undo', 'redo', 'jump-history', 'set-facet', 'set-sort', 'replay-operations', 'create-snapshot', 'restore-snapshot', 'import-project', 'validate', 'export']) assert.match(backend, new RegExp(action));
});

test('data jobs use Go control plane and Python enforces safe runtime boundaries', () => {
  assert.match(component, /toolApi\.createJob\(project\.id, 'data-lab'/);
  assert.match(component, /toolApi\.createVersion/);
  assert.match(dispatcher, /data_lab_full\.run_data_lab/);
  assert.match(backend, /MAX_CELLS = 2_000_000/);
  assert.match(backend, /"arbitraryCodeExecution": False/);
  assert.match(backend, /_escape_csv_cell/);
  assert.doesNotMatch(component, /127\.0\.0\.1:8000|localhost:8000/);
});

test('data desk is one-screen, high contrast and responsive', () => {
  assert.match(styles, /\.refinex-shell[\s\S]*height: calc\(100dvh - 78px\)/);
  assert.match(styles, /\.refinex-data-view[\s\S]*grid-template-columns: 230px minmax\(620px, 1fr\) 255px/);
  assert.match(styles, /\.refinex-table-wrap th[\s\S]*position: sticky/);
  assert.match(styles, /@container \(max-width: 900px\)[\s\S]*\.refinex-shell/);
});
