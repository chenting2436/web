import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const component = fs.readFileSync(path.join(root, 'components', 'scientific-animation-workbench.tsx'), 'utf8');
const availability = fs.readFileSync(path.join(root, 'components', 'workbench-availability.tsx'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'app', 'globals.css'), 'utf8');
const backend = fs.readFileSync(path.join(root, '..', 'backend_python', 'app', 'tools', 'scientific_animation_full.py'), 'utf8');
const dispatcher = fs.readFileSync(path.join(root, '..', 'backend_python', 'app', 'tools', 'dispatcher.py'), 'utf8');

test('scientific animation uses a dedicated React workbench', () => {
  assert.match(availability, /ScientificAnimationWorkbench/);
  assert.match(availability, /data-workbench="scientific-animation-studio"/);
  assert.match(component, /skyview-scientific-animation-results/);
  assert.doesNotMatch(component, /当前仅用于流程|原型/);
});

test('first render contains real scenes, objects, keyframes and data bindings', () => {
  for (const term of ['面波传播与频散', '层析反演过程', '结果与方法总结', '短周期波列', '频散曲线', '频散拾取结果']) assert.match(component, new RegExp(term));
  assert.match(component, /useState<AnimationResult>\(\(\) => sampleResult\(\)\)/);
  assert.match(component, /requestAnimationFrame/);
  assert.match(component, /interpolated/);
});

test('editor restores the full animation workflow and factual runtime boundaries', () => {
  for (const term of ['场景编排', '时间轴', '数据驱动', '分镜审查', '成果交付', '属性检查器', '多轨时间轴', '字段到视觉通道', '质量门禁', '完整工程包']) assert.match(component, new RegExp(term));
  for (const action of ['create-scene', 'add-object', 'update-object', 'delete-object', 'add-keyframe', 'update-camera', 'create-snapshot', 'import-project', 'prepare-render', 'record-render', 'render-preview', 'validate-scene', 'create-storyboard', 'runtime-status', 'export']) assert.match(backend, new RegExp(action));
  assert.match(dispatcher, /scientific_animation_full\.run_scientific_animation/);
  assert.match(component, /toolApi\.createJob\(project\.id, 'scientific-animation-studio'/);
  assert.match(backend, /"manimGL": \{"status": "not-configured"/);
  assert.match(backend, /"arbitraryCodeExecution": False/);
});

test('animation desk is one-screen, high contrast and responsive', () => {
  assert.match(styles, /\.animx-shell[\s\S]*height: calc\(100dvh - 78px\)/);
  assert.match(styles, /\.animx-compose[\s\S]*grid-template-columns/);
  assert.match(styles, /\.animx-stage-panel[\s\S]*background: #0a1728/);
  assert.match(styles, /@container \(max-width: 900px\)/);
});
