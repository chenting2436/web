import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../components/knowledge-system-workbench.tsx', import.meta.url), 'utf8');
const availability = await readFile(new URL('../components/workbench-availability.tsx', import.meta.url), 'utf8');
const styles = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');
const workerCapabilities = await readFile(new URL('../../verification/build-dev-worker-capabilities.mjs', import.meta.url), 'utf8');

test('knowledge system route uses a dedicated layered React workbench', () => {
  assert.match(availability, /workbench\.slug === 'knowledge-system'/);
  assert.match(availability, /<KnowledgeSystemWorkbench/);
  assert.match(availability, /data-workbench="knowledge-system"/);
  assert.match(styles, /Personal knowledge system: compact layered research vault/);
});

test('complete knowledge benchmark is present on the first render', () => {
  assert.match(source, /useState<KnowledgeResult>\(\(\) => createBenchmarkResult\(\)\)/);
  assert.match(source, /地球科学研究知识库/);
  assert.match(source, /边坡多源监测记录\.md/);
  assert.match(source, /台站环境噪声成像说明\.txt/);
  assert.match(source, /stage: 'run-all'/);
  assert.match(source, /hitAtK: 1, mrr: 1/);
  assert.doesNotMatch(source, />载入示例/);
});

test('all eight card-version work areas and real evidence views are present', () => {
  for (const label of ['知识总览', '资料入库', '文档与分块', '混合检索', '证据问答', '概念关系', '质量评测', '数据库管理']) {
    assert.match(source, new RegExp(label));
  }
  for (const capability of ['知识构建流水线', 'SHA-256', '原文件', '重建索引', 'BM25', '字符特征', '引用原文', '可解释概念图', 'Hit@K', 'MRR', '版本与修改记录']) {
    assert.match(source, new RegExp(capability));
  }
});

test('execution, document import, backup and versions cross the Go boundary', () => {
  assert.match(source, /toolApi\.createJob/);
  assert.match(source, /'knowledge-system', action/);
  assert.match(source, /toolApi\.createVersion/);
  for (const action of ['ingest-file', 'ingest-text', 'search', 'ask', 'update-chunk', 'reindex-document', 'delete-document', 'evaluate', 'import-backup', 'run-all']) {
    assert.match(source, new RegExp(`'${action}'`));
    assert.match(workerCapabilities, new RegExp(`'${action}'`));
  }
  assert.doesNotMatch(source, /127\.0\.0\.1:8000|localhost:8000/);
});

test('full delivery set and safe upload boundary are visible', () => {
  for (const label of ['完整数据库备份', '文档目录', '检索分块', '质量评测', '交付清单', '恢复数据库']) {
    assert.match(source, new RegExp(label));
  }
  assert.match(source, /上传内容不执行/);
  assert.match(source, /扫描 PDF 需要 OCR/);
  assert.doesNotMatch(source, /原型|当前仅用于流程和交互评审/);
});

test('knowledge layout uses a six-metric rail, internal scrolling and responsive reflow', () => {
  assert.match(styles, /\.know-workbench \{[\s\S]*?height: 100%[\s\S]*?overflow: hidden/);
  assert.match(styles, /\.know-kpis \{[\s\S]*?repeat\(6, minmax\(118px, 1fr\)\)/);
  assert.match(styles, /\.know-documents \{[\s\S]*?grid-template-columns/);
  assert.match(styles, /\.know-view \{[\s\S]*?overflow: auto/);
  assert.match(styles, /@container know-workbench \(max-width: 860px\)/);
  assert.match(styles, /--know-ink: #17213a/);
  assert.match(styles, /--know-accent: #176f6c/);
});
