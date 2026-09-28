import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const componentUrl = new URL('../components/python-lab-workbench.tsx', import.meta.url);
const monacoUrl = new URL('../components/python-lab/monaco-code-editor.tsx', import.meta.url);
const xtermUrl = new URL('../components/python-lab/xterm-console.tsx', import.meta.url);
const availabilityUrl = new URL('../components/workbench-availability.tsx', import.meta.url);
const cssUrl = new URL('../app/globals.css', import.meta.url);
const packageUrl = new URL('../package.json', import.meta.url);

test('python lab route uses a dedicated layered React IDE', async () => {
  const availability = await readFile(availabilityUrl, 'utf8');
  assert.match(availability, /PythonLabWorkbench/);
  assert.match(availability, /data-workbench="python-lab"/);
});

test('complete legacy workspace and four templates are present on first render', async () => {
  const source = await readFile(componentUrl, 'utf8');
  for (const value of ['main.py', 'utils/math_tools.py', 'data/data.txt', 'requirements.txt', 'README.md', '.vscode/settings.json']) assert.match(source, new RegExp(value.replace(/[./]/g, '\\$&')));
  for (const value of ['数据统计', '算法与函数', '文件处理', '文本可视化']) assert.match(source, new RegExp(value));
});

test('browser runtime restores terminal semantics and true worker stop', async () => {
  const source = await readFile(componentUrl, 'utf8');
  assert.match(source, /pyodide\/v0\.28\.3/);
  assert.match(source, /new Worker/);
  assert.match(source, /workerRef\.current\?\.terminate\(\)/);
  for (const command of ['python -m unittest', 'python -c', 'pip install', "name === 'ls'", "name === 'tree'", "name === 'cat'", "name === 'touch'", "name === 'mkdir'", "name === 'rm'", "name === 'pwd'"]) assert.ok(source.includes(command), `missing terminal capability: ${command}`);
  assert.match(source, /Ctrl \+ Enter/);
  assert.match(source, /Ctrl \+ S/);
});

test('workspace mutations cross Go while server arbitrary code stays disabled', async () => {
  const source = await readFile(componentUrl, 'utf8');
  assert.match(source, /toolApi\.createJob/);
  assert.match(source, /toolApi\.createVersion/);
  for (const action of ['save-file', 'create-file', 'create-folder', 'rename-path', 'delete-path', 'apply-template', 'save-notebook', 'record-cell-run', 'update-run-config', 'record-run', 'create-snapshot', 'restore-snapshot', 'import-workspace']) assert.match(source, new RegExp(`['"]${action}['"]`));
  assert.match(source, /服务端不执行工作区代码/);
  assert.doesNotMatch(source, /127\.0\.0\.1:8000|\/tools\/python-lab\/run/);
  assert.doesNotMatch(source, /原型|当前仅用于流程和交互评审/);
});

test('Jupyter-style studio keeps notebook, script, data, terminal and delivery in bounded panels', async () => {
  const source = await readFile(componentUrl, 'utf8');
  const css = await readFile(cssUrl, 'utf8');
  for (const label of ['实验任务', '文件管理', '环境与依赖', '笔记本', '脚本', '数据', '变量检查器', '运行记录', '实验验收', 'Notebook', 'IPYNB', '完整备份']) assert.match(source, new RegExp(label));
  assert.match(css, /\.pylab-studio[\s\S]*height: calc\(100svh/);
  assert.match(css, /\.pylab-shell[\s\S]*grid-template-columns/);
  assert.match(css, /\.pylab-workspace[\s\S]*grid-template-rows/);
  assert.match(css, /@container pylab/);
});

test('open-source editor and terminal are real integrations rather than styled textareas', async () => {
  const [component, monaco, xterm, packageText] = await Promise.all([
    readFile(componentUrl, 'utf8'), readFile(monacoUrl, 'utf8'), readFile(xtermUrl, 'utf8'), readFile(packageUrl, 'utf8'),
  ]);
  assert.match(component, /MonacoCodeEditor/);
  assert.match(component, /XtermConsole/);
  assert.match(component, /run-notebook|run-cell/);
  assert.match(monaco, /monaco-editor/);
  assert.match(monaco, /CtrlCmd/);
  assert.match(xterm, /@xterm\/xterm/);
  assert.match(xterm, /FitAddon/);
  assert.match(packageText, /"monaco-editor": "0\.56\.0"/);
  assert.match(packageText, /"@xterm\/xterm": "5\.5\.0"/);
});
