import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const gatewaySource = await readFile(
  new URL('../components/data-gateway-workbench.tsx', import.meta.url),
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

test('data-gateway route uses the dedicated React workbench', () => {
  assert.match(availabilitySource, /workbench\.slug === 'data-gateway'/);
  assert.match(availabilitySource, /<DataGatewayWorkbench/);
});

test('dedicated gateway preserves all 26 card-version processor types', () => {
  for (const processor of [
    'ListenHTTP', 'GetFile', 'ConsumeKafka', 'QueryDatabaseTableRecord',
    'CaptureChangeMySQL', 'ConsumeMQTT', 'FetchSFTP', 'GenerateFlowFile',
    'ConvertRecord', 'UpdateRecord', 'JoltTransformJSON', 'QueryRecord',
    'EvaluateJsonPath', 'ValidateRecord', 'DetectDuplicate', 'MonitorActivity',
    'RouteOnAttribute', 'RouteOnContent', 'SplitRecord', 'MergeRecord',
    'PutDatabaseRecord', 'PublishKafka', 'PutS3Object', 'PutFile',
    'InvokeHTTP', 'LogAttribute',
  ]) {
    assert.match(gatewaySource, new RegExp(`'${processor}'`));
  }
});

test('NiFi canvas, queue, configuration and governance workflows remain present', () => {
  for (const marker of [
    '组件工具栏', '操作面板', '状态栏', '鸟瞰视图',
    '根流程组', '添加处理器', '设置', '调度',
    '属性', '关系', '控制器服务', '参数上下文',
    '访问策略', '反压', '查看队列', 'FlowFile',
    '数据溯源', '数据谱系', '重放到接入队列', '运行历史',
  ]) {
    assert.match(gatewaySource, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(gatewaySource, /onPointerMove/);
  assert.match(gatewaySource, /event\.key\.toLowerCase\(\) === 's'/);
  assert.match(gatewaySource, /event\.key\.toLowerCase\(\) === 'c'/);
  assert.match(gatewaySource, /event\.key\.toLowerCase\(\) === 'v'/);
});

test('flow and provenance import/export use the Go job boundary', () => {
  for (const action of ['catalog', 'preview', 'run', 'replay', 'export', 'validate-flow', 'process']) {
    assert.match(definitionsSource, new RegExp(`id: '${action}'`));
  }
  assert.match(gatewaySource, /skyview-nifi-flow/);
  assert.match(gatewaySource, /toolApi\.createJob/);
  assert.match(gatewaySource, /toolApi\.createVersion/);
  assert.doesNotMatch(gatewaySource, /127\.0\.0\.1:8000|localhost:8000/);
});

test('gateway is clean and does not show prototype disclaimers', () => {
  assert.doesNotMatch(gatewaySource, /原型|仅用于流程和交互评审|不作为正式/);
  assert.match(gatewaySource, /CSV \/ TSV \/ JSON 最多 10,000 行/);
  assert.match(gatewaySource, /外部连接只保存 credentialRef/);
});
