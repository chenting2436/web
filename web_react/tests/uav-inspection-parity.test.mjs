import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const component = await readFile(new URL('../components/uav-inspection-workbench.tsx', import.meta.url), 'utf8');
const route = await readFile(new URL('../components/workbench-availability.tsx', import.meta.url), 'utf8');
const backend = await readFile(new URL('../../backend_python/app/tools/uav_inspection_full.py', import.meta.url), 'utf8');
const dispatcher = await readFile(new URL('../../backend_python/app/tools/dispatcher.py', import.meta.url), 'utf8');
const capabilities = await readFile(new URL('../../verification/build-dev-worker-capabilities.mjs', import.meta.url), 'utf8');
const store = await readFile(new URL('../../backend_go/internal/store/store.go', import.meta.url), 'utf8');
const css = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');

test('UAV route uses a dedicated layered React inspection desk', () => {
  assert.match(route, /UavInspectionWorkbench/);
  assert.match(route, /data-workbench="uav-inspection"/);
  for (const label of ['航线任务', '影像与成果', '缺陷复核', '复核工单', '对比与交付']) assert.match(component, new RegExp(label));
  for (const capability of ['MissionMap', '禁飞区', '摄影测量成果', '人工复核画布', '完整交付包']) assert.match(component, new RegExp(capability));
  assert.match(component, /useLanguage/);
});

test('UAV backend restores the full project and evidence lifecycle', () => {
  assert.match(dispatcher, /uav_inspection_full\.run_uav_inspection/);
  for (const action of ['update-flight-plan', 'validate-flight-plan', 'import-image-manifest', 'prepare-photogrammetry', 'run-defect-analysis', 'review-detection', 'update-annotation', 'create-work-order', 'update-work-order', 'compare-missions', 'runtime-status', 'export']) {
    assert.match(backend, new RegExp(action));
    assert.match(capabilities, new RegExp(action));
  }
  for (const model of ['flightPlans', 'missions', 'imageAssets', 'odmJobs', 'orthomosaics', 'pointClouds', 'detections', 'annotations', 'workOrders']) assert.match(backend, new RegExp(model));
  assert.match(backend, /zipfile\.ZipFile/);
  assert.match(store, /"uav-inspection"[^\n]+"prototype", true/);
});

test('external runtime boundaries are factual and imports are bounded', () => {
  assert.match(backend, /"photogrammetry": \{"status": "not-configured"/);
  assert.match(backend, /MAX_MANIFEST_ROWS = 10_000/);
  assert.match(component, /真实连接状态/);
  assert.match(component, /未配置/);
});

test('UAV workbench is dense, high contrast and responsive', () => {
  assert.match(css, /\.uavx-workbench[\s\S]*height: calc\(100dvh - 78px\)/);
  assert.match(css, /\.uavx-mission[\s\S]*grid-template-columns/);
  assert.match(css, /@container uavx \(max-width: 1120px\)/);
  assert.match(css, /@container uavx \(max-width: 820px\)/);
});
