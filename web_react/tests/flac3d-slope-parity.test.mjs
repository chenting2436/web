import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../components/flac3d-slope-workbench.tsx', import.meta.url), 'utf8');
const availability = await readFile(new URL('../components/workbench-availability.tsx', import.meta.url), 'utf8');
const styles = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');
const dispatcher = await readFile(new URL('../../backend_python/app/tools/dispatcher.py', import.meta.url), 'utf8');
const store = await readFile(new URL('../../backend_go/internal/store/store.go', import.meta.url), 'utf8');

test('FLAC3D slope route uses a dedicated layered React workbench', () => {
  assert.match(availability, /workbench\.slug === 'flac3d-slope-stability'/);
  assert.match(availability, /<Flac3dSlopeWorkbench/);
  assert.match(availability, /data-workbench="flac3d-slope-stability"/);
});

test('the supplied 3000-zone benchmark is available on first render', () => {
  assert.match(source, /slope_zones_fos_results\.csv/);
  assert.match(source, /zoneCount: 3000/);
  assert.match(source, /factorOfSafety: 1\.81/);
  assert.match(source, /maxDisplacement: 0\.250496/);
  assert.match(source, /fetch\('\/assets\/data\/flac3d\/slope_zones_fos_results\.csv'\)/);
});

test('a completed web calculation replaces the fixed benchmark picture with a parameter-linked field', () => {
  assert.match(source, /web-analytical-field/);
  assert.match(source, /本次网页解析计算场/);
  assert.match(source, /criticalSurface\?\.depth/);
  assert.match(source, /slipPoints/);
  assert.match(source, /结果图层已重建/);
  assert.match(source, /engine: selectedEngine/);
  assert.doesNotMatch(source, /d="M 267 85 C 350 128, 413 220, 488 274"/);
});

test('slope angle is the single geometric source for steep and shallow section outlines', () => {
  assert.match(source, /function geometryAfterEdit/);
  assert.match(source, /slopeHeight \/ Math\.tan/);
  assert.match(source, /next\.toeX = next\.crestX/);
});

test('strength reduction response uses a polished readable critical-state chart', () => {
  assert.match(source, /flac-curve-area/);
  assert.match(source, /flac-critical-band/);
  assert.match(source, /flac-critical-label/);
  assert.match(source, /稳定收敛/);
  assert.match(source, /临界阈值/);
  assert.match(source, /失稳响应/);
  assert.match(styles, /\.flac-curve-line \{[\s\S]*?stroke-width: 3\.2/);
  assert.match(styles, /\.flac-critical-label rect \{/);
});

test('model, open solver gate, result import, audit and delivery cross the Go-Python boundary', () => {
  assert.match(source, /toolApi\.createJob/);
  assert.match(source, /'flac3d-slope-stability', action/);
  assert.match(source, /toolApi\.createVersion/);
  for (const action of ['validate-model', 'screen-stability', 'prepare-run', 'import-results', 'solver-status', 'execute-open-source', 'export']) {
    assert.match(dispatcher, new RegExp(`"${action}"`));
  }
  assert.match(store, /"flac3d-slope-stability"/);
  assert.match(source, /selectedEngine === 'ogs3d' \? 'execute-open-source' : 'screen-stability'/);
  assert.match(source, /toolApi\.cancelJob\(created\.job\.id\)/);
  assert.doesNotMatch(source, /127\.0\.0\.1:8000|localhost:8000/);
});

test('compact high-contrast layout exposes the hybrid web calculation service without a prototype disclaimer', () => {
  for (const label of ['安全系数', '稳定 / 失稳', '网格规模', '最大位移', '当前屈服区', '塑性状态', '位移场', '竖向应力', '快速验算', '二维滑面搜索', '三维空间校核', 'OpenGeoSys', '完整计算包']) {
    assert.match(source, new RegExp(label.replaceAll('/', '\\/')));
  }
  assert.match(styles, /\.flac-workbench \{[\s\S]*?height: 100%[\s\S]*?overflow: hidden/);
  assert.match(styles, /\.flac-kpis \{[\s\S]*?grid-template-columns:/);
  assert.match(styles, /--flac-ink: #10233f/);
  assert.doesNotMatch(source, /原型|当前仅用于流程和交互评审/);
});
