import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../components/skill-evolution-workbench.tsx', import.meta.url), 'utf8');
const availability = await readFile(new URL('../components/workbench-availability.tsx', import.meta.url), 'utf8');
const styles = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');

test('skill evolution route uses a dedicated layered React workbench', () => {
  assert.match(availability, /workbench\.slug === 'skill-evolution'/);
  assert.match(availability, /<SkillEvolutionWorkbench/);
  assert.match(availability, /data-workbench="skill-evolution"/);
  assert.match(styles, /Skill evolution: evidence-led layered capability studio/);
});

test('complete deterministic benchmark is present on the first render', () => {
  assert.match(source, /useState<SkillEvolutionResult>\(\(\) => createBenchmarkResult\(\)\)/);
  assert.match(source, /科研证据提取器/);
  assert.match(source, /stage: 'run-all'/);
  assert.match(source, /test-injection/);
  assert.match(source, /stepCoverage: 1/);
  assert.doesNotMatch(source, />载入示例/);
});

test('all eight card-version work areas and evidence views are present', () => {
  for (const label of ['能力总览', '规范与契约', '流程编排', '测试数据集', '运行与追踪', '评测回归', '安全与溯源', '版本发布']) {
    assert.match(source, new RegExp(label));
  }
  for (const capability of ['能力成熟度', '输入契约', '输出契约', '安全流程图', '声明式测试数据集', '步骤追踪', '无能力对照', '静态供应链扫描', '语义版本发布', '差异与回滚']) {
    assert.match(source, new RegExp(capability));
  }
});

test('execution, import, release, persistence and exports cross the Go boundary', () => {
  assert.match(source, /toolApi\.createJob/);
  assert.match(source, /'skill-evolution', action/);
  assert.match(source, /toolApi\.createVersion/);
  assert.match(source, /'import-package'/);
  assert.match(source, /'import-dataset'/);
  assert.match(source, /'publish'/);
  assert.doesNotMatch(source, /127\.0\.0\.1:8000|localhost:8000/);
  for (const fileName of ['SKILL.md', 'evals.json', 'BENCHMARK.md', 'manifest.json', 'skill-registry.json', '完整 Skill 包']) {
    assert.match(source, new RegExp(fileName.replaceAll('.', '\\.')));
  }
});

test('workflow types, assertions and benchmark tags use Chinese display labels', () => {
  for (const label of ['输入验证', '内容标准化', '结构提取', '人工复核', '严格相等', '忽略大小写包含', '路径存在', '数组数量下限']) {
    assert.match(source, new RegExp(label));
  }
  assert.match(source, /core: '核心'/);
  assert.match(source, /assertionTypeLabel\(assertion\.type\)/);
});

test('dense layered layout uses one-screen internal scrolling and responsive reflow', () => {
  assert.match(styles, /\.skillx-workbench \{[\s\S]*?height: 100%[\s\S]*?overflow: hidden/);
  assert.match(styles, /\.skillx-kpis \{[\s\S]*?repeat\(6, minmax\(128px, 1fr\)\)/);
  assert.match(styles, /\.skillx-view \{[\s\S]*?overflow: auto/);
  assert.match(styles, /@container skillx-workbench \(max-width: 860px\)/);
  assert.match(styles, /--skillx-ink: #17213a/);
  assert.match(styles, /--skillx-accent: #4553a4/);
});
