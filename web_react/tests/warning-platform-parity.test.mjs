import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const component = await readFile(new URL('../components/warning-platform-workbench.tsx', import.meta.url), 'utf8');
const route = await readFile(new URL('../components/workbench-availability.tsx', import.meta.url), 'utf8');
const backend = await readFile(new URL('../../backend_python/app/tools/warning_platform_full.py', import.meta.url), 'utf8');
const dispatcher = await readFile(new URL('../../backend_python/app/tools/dispatcher.py', import.meta.url), 'utf8');
const capabilities = await readFile(new URL('../../verification/build-dev-worker-capabilities.mjs', import.meta.url), 'utf8');
const store = await readFile(new URL('../../backend_go/internal/store/store.go', import.meta.url), 'utf8');
const css = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');

test('warning platform uses a dedicated layered React operations console', () => {
  assert.match(route, /WarningPlatformWorkbench/);
  assert.match(route, /data-workbench="warning-platform"/);
  for (const label of ['实时监测', '告警处置', '规则中心', '设备与接入', '运行交付']) assert.match(component, new RegExp(label));
  for (const capability of ['TrendChart', '站点风险分布', '双人复核', '维护窗口', '完整交付包']) assert.match(component, new RegExp(capability));
  assert.match(component, /useLanguage/);
});

test('warning platform backend covers lifecycle, governance, import, audit and export', () => {
  assert.match(dispatcher, /warning_platform_full\.run_warning_platform/);
  for (const action of ['ingest-observations', 'evaluate-rules', 'acknowledge-alarm', 'assign-alarm', 'close-alarm', 'suppress-alarm', 'approve-rule', 'publish-rule', 'create-maintenance-window', 'connector-status', 'export']) {
    assert.match(backend, new RegExp(action));
    assert.match(capabilities, new RegExp(action));
  }
  assert.match(backend, /MAX_IMPORT_ROWS = 10_000/);
  assert.match(backend, /dedupeKey/);
  assert.match(backend, /zipfile\.ZipFile/);
  assert.match(store, /"warning-platform"[^\n]+"prototype", true/);
});

test('warning console has dense one-screen layout and responsive safeguards', () => {
  assert.match(css, /\.warnx-workbench[\s\S]*height: calc\(100dvh - 78px\)/);
  assert.match(css, /\.warnx-overview[\s\S]*grid-template-columns/);
  assert.match(css, /@container warnx \(max-width: 1120px\)/);
  assert.match(css, /@container warnx \(max-width: 820px\)/);
});
