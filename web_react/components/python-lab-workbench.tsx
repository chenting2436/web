'use client';

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import Image from 'next/image';
import {
  BookOpen,
  Box,
  Braces,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleDot,
  Clock3,
  Database,
  Download,
  File,
  FileCode2,
  FileInput,
  FilePlus2,
  Files,
  Folder,
  FolderOpen,
  FolderPlus,
  History,
  Keyboard,
  Layers3,
  Package,
  Play,
  Plus,
  RefreshCw,
  Save,
  Settings2,
  Square,
  TerminalSquare,
  Trash2,
  Upload,
  Variable,
  X,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { MonacoCodeEditor } from '@/components/python-lab/monaco-code-editor';
import { XtermConsole } from '@/components/python-lab/xterm-console';
import { ApiError } from '@/services/api/client';
import {
  toolApi,
  type WorkbenchJob,
  type WorkbenchProject,
} from '@/services/api/tools';

type RunConfig = {
  entryPath: string;
  stdin: string;
  argv: string[];
  env: Record<string, string>;
};
type SnapshotPayload = {
  files: Record<string, string>;
  folders: string[];
  openFiles: string[];
  activePath: string;
  expandedFolders: string[];
  runConfig: RunConfig;
  layout: {
    sidebarWidth: number;
    terminalHeight: number;
    rightPanelWidth: number;
  };
};
type BrowserRun = {
  id: string;
  entryPath: string;
  command: string;
  status: string;
  exitCode: number;
  durationMs: number;
  stdoutPreview: string;
  stderrPreview: string;
  runtime: string;
  evidenceSource: string;
  verified: boolean;
  createdAt: string;
};
type NotebookOutput = {
  kind: 'text' | 'table' | 'image' | 'value';
  text?: string;
  columns?: string[];
  rows?: Array<Array<string | number | null>>;
  dataUrl?: string;
};
type NotebookCell = {
  id: string;
  type: 'markdown' | 'code';
  source: string;
  executionCount: number | null;
  status: 'idle' | 'running' | 'succeeded' | 'failed';
  outputs: NotebookOutput[];
};
type LabNotebook = {
  id: string;
  title: string;
  cells: NotebookCell[];
  updatedAt: string;
};
type LabCourse = {
  title: string;
  section: string;
  objectives: string[];
  steps: Array<{ id: string; title: string; detail: string }>;
  checks: Array<{ id: string; label: string; passed: boolean }>;
};
type PythonWorkspace = {
  id: string;
  title: string;
  revision: number;
  files: Record<string, string>;
  folders: string[];
  openFiles: string[];
  activePath: string;
  expandedFolders: string[];
  fileRevisions: Record<
    string,
    { revision: number; checksum: string; updatedAt: string }
  >;
  runConfig: RunConfig;
  installedPackages: string[];
  layout: {
    sidebarWidth: number;
    terminalHeight: number;
    rightPanelWidth: number;
  };
  snapshots: Array<{
    id: string;
    label: string;
    checksum: string;
    createdAt: string;
    immutable: boolean;
    payload: SnapshotPayload;
  }>;
  notebooks: LabNotebook[];
  activeNotebookId: string;
  course: LabCourse;
  runs: BrowserRun[];
  quotas: {
    maxFiles: number;
    maxFolders: number;
    maxFileChars: number;
    maxWorkspaceBytes: number;
    maxRuns: number;
  };
  updatedAt: string;
};
type PythonLabResult = {
  schema: 'skyview-python-lab-results';
  version: number;
  stage: string;
  workspace: PythonWorkspace;
  templates: Array<{
    id: string;
    name: string;
    description: string;
    content: string;
  }>;
  analysis: {
    metrics: {
      files: number;
      folders: number;
      pythonFiles: number;
      openFiles: number;
      totalBytes: number;
      runs: number;
      snapshots: number;
    };
    syntax: Array<{
      path: string;
      status: string;
      message: string;
      line: number | null;
    }>;
    valid: boolean;
    imports: string[];
    requirements: string[];
    tree: Array<{
      path: string;
      type: string;
      bytes?: number;
      checksum?: string;
    }>;
  };
  runtime: {
    browserRuntime: string;
    browserExecutionEnabled: boolean;
    workerTerminationStopsExecution: boolean;
    serverCodeExecutionEnabled: boolean;
    serverArbitraryCodeExecution: boolean;
    packageInstallMode: string;
    persistentPythonFileSystem: boolean;
    browserRunEvidenceVerified: boolean;
  };
  exports: {
    workspaceJson: string;
    manifestCsv: string;
    runHistoryCsv: string;
    analysisMarkdown: string;
    backupJson: string;
    notebookIpynb: string;
  };
  recordedRun?: BrowserRun;
  createdSnapshot?: PythonWorkspace['snapshots'][number];
  restoredSnapshotId?: string;
  importSummary?: {
    files: number;
    executionStarted: boolean;
    runHistoryImported: boolean;
  };
};
type TreeNode = {
  path: string;
  name: string;
  type: 'file' | 'folder';
  depth: number;
};
type WorkerResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  elapsedMs: number;
  executionCount?: number;
  outputs?: NotebookOutput[];
  variables?: Array<{ name: string; type: string; value: string }>;
};
type WorkerPyodide = {
  FS: {
    stat: (path: string) => { mode: number };
    isDir: (mode: number) => boolean;
    readdir: (path: string) => string[];
    rmdir: (path: string) => void;
    unlink: (path: string) => void;
    mkdir: (path: string) => void;
    writeFile: (
      path: string,
      content: string,
      options: { encoding: string },
    ) => void;
    chdir: (path: string) => void;
  };
  loadPackage: (name: string) => Promise<void>;
  pyimport: (name: string) => {
    install: (packageName: string) => Promise<void>;
  };
  runPython: (source: string) => string;
  runPythonAsync: (source: string) => Promise<void>;
  globals: {
    set: (name: string, value: string) => void;
    get: (name: string) => {
      toJs: (options: {
        dict_converter: typeof Object.fromEntries;
      }) => WorkerResult;
      destroy?: () => void;
    };
  };
};
type WorkerRunMessage = {
  packages?: string[];
  files?: Record<string, string>;
  entryPath?: string;
  stdin?: string;
  env?: Record<string, string>;
  argv?: string[];
  command?: string;
};

const fixed = '2026-09-09T00:00:00Z';
const templates = [
  {
    id: 'data',
    name: '数据统计',
    description: '列表、聚合和条件筛选',
    content:
      'records = [{"site": "A", "risk": 0.42}, {"site": "B", "risk": 0.81}, {"site": "C", "risk": 0.63}]\nvalues = [item["risk"] for item in records]\nprint("样本数:", len(values))\nprint("平均风险:", round(sum(values) / len(values), 3))\nprint("高风险:", [item["site"] for item in records if item["risk"] >= 0.8])\n',
  },
  {
    id: 'algorithm',
    name: '算法与函数',
    description: '滑动平均与参数校验',
    content:
      'def moving_average(values, window):\n    if window <= 0 or len(values) < window:\n        return []\n    return [sum(values[i:i + window]) / window for i in range(len(values) - window + 1)]\n\nseries = [2, 5, 4, 8, 9, 7]\nprint(moving_average(series, 3))\n',
  },
  {
    id: 'files',
    name: '文件处理',
    description: 'Pathlib 文件读写',
    content:
      'from pathlib import Path\n\npath = Path("data/report.txt")\npath.parent.mkdir(parents=True, exist_ok=True)\npath.write_text("SkyViewLab\\nstatus=ready\\n", encoding="utf-8")\nprint(path.read_text(encoding="utf-8"))\n',
  },
  {
    id: 'visual',
    name: '文本可视化',
    description: '在终端输出条形图',
    content:
      'values = [3, 7, 5, 9, 6]\nscale = max(values)\nfor index, value in enumerate(values, start=1):\n    bar = "█" * round(value / scale * 24)\n    print(f"{index:02d} | {bar:<24} {value}")\n',
  },
];

const defaultFiles = {
  'main.py':
    'from utils.math_tools import square_sum\nimport os\nimport sys\n\nprint("Hello, Python Lab!")\nprint("环境变量 COURSE =", os.environ.get("COURSE"))\nprint("命令行参数 =", sys.argv[1:])\ntry:\n    print("标准输入第一行 =", input())\nexcept EOFError:\n    print("标准输入第一行 = <empty>")\n\nnumbers = [1, 2, 3, 4, 5]\nprint("平方和 =", square_sum(numbers))\n\nwith open("data/data.txt", "r", encoding="utf-8") as file:\n    print("data/data.txt 第一行 =", file.readline().strip())\n',
  'utils/math_tools.py':
    'def square_sum(values):\n    return sum(x * x for x in values)\n',
  'data/data.txt': '10,20,30\n40,50,60\n',
  'requirements.txt': '# 每行一个包名，运行前会在浏览器运行时安装\n# numpy\n',
  'README.md':
    '# Python Lab\n\n课程实验工作区支持多文件、浏览器 Python、运行参数和受限终端。\n',
  '.vscode/settings.json':
    '{\n  "python.defaultInterpreterPath": "pyodide",\n  "python.terminal.activateEnvironment": true,\n  "editor.tabSize": 4\n}\n',
};

const baselineNotebook: LabNotebook = {
  id: 'notebook-data-basics',
  title: '数据统计入门',
  updatedAt: fixed,
  cells: [
    {
      id: 'cell-intro',
      type: 'markdown',
      source: '## 实验目标\n读取监测数据，完成均值计算与高风险站点筛选。',
      executionCount: null,
      status: 'idle',
      outputs: [],
    },
    {
      id: 'cell-load',
      type: 'code',
      source:
        'records = [\n    {"site": "A", "risk": 0.42},\n    {"site": "B", "risk": 0.81},\n    {"site": "C", "risk": 0.63},\n]\nrecords',
      executionCount: null,
      status: 'idle',
      outputs: [],
    },
    {
      id: 'cell-analyse',
      type: 'code',
      source:
        'values = [item["risk"] for item in records]\naverage = round(sum(values) / len(values), 3)\nhigh_risk = [item["site"] for item in records if item["risk"] >= 0.8]\nprint("平均风险:", average)\nprint("高风险站点:", high_risk)',
      executionCount: null,
      status: 'idle',
      outputs: [],
    },
  ],
};

const baselineCourse: LabCourse = {
  title: 'Python 数据处理实验',
  section: '第 03 节 · 列表、字典与统计',
  objectives: ['读取结构化记录', '计算汇总指标', '筛选风险对象'],
  steps: [
    {
      id: 'prepare',
      title: '认识数据',
      detail: '运行第一个代码单元，检查 records 的结构。',
    },
    {
      id: 'analyse',
      title: '完成分析',
      detail: '计算平均值并筛选风险值不低于 0.8 的站点。',
    },
    {
      id: 'deliver',
      title: '保存结果',
      detail: '保存工作区并创建快照，形成可复核记录。',
    },
  ],
  checks: [
    { id: 'records', label: '已生成 3 条记录', passed: false },
    { id: 'average', label: '平均风险为 0.62', passed: false },
    { id: 'high-risk', label: '识别站点 B', passed: false },
  ],
};

function createBenchmark(): PythonLabResult {
  const layout = {
    sidebarWidth: 252,
    terminalHeight: 228,
    rightPanelWidth: 276,
  };
  const runConfig = {
    entryPath: 'main.py',
    stdin: '42\n',
    argv: ['--mode', 'practice'],
    env: { COURSE: 'PythonLab' },
  };
  const snapshotPayload: SnapshotPayload = {
    files: { ...defaultFiles },
    folders: ['.vscode', 'data', 'utils'],
    openFiles: ['main.py', 'utils/math_tools.py'],
    activePath: 'main.py',
    expandedFolders: ['.vscode', 'data', 'utils'],
    runConfig,
    layout,
  };
  const run: BrowserRun = {
    id: 'run-browser-001',
    entryPath: 'main.py',
    command: 'COURSE=PythonLab python main.py --mode practice',
    status: 'succeeded',
    exitCode: 0,
    durationMs: 84.2,
    stdoutPreview:
      'Hello, Python Lab!\n环境变量 COURSE = PythonLab\n平方和 = 55',
    stderrPreview: '',
    runtime: 'Pyodide 0.28.3',
    evidenceSource: 'browser-local',
    verified: false,
    createdAt: fixed,
  };
  const workspace: PythonWorkspace = {
    id: 'python-workspace-main',
    title: 'Python 课程实验',
    revision: 1,
    files: { ...defaultFiles },
    folders: ['.vscode', 'data', 'utils'],
    openFiles: ['main.py', 'utils/math_tools.py'],
    activePath: 'main.py',
    expandedFolders: ['.vscode', 'data', 'utils'],
    fileRevisions: Object.fromEntries(
      Object.keys(defaultFiles).map((path) => [
        path,
        { revision: 1, checksum: 'sha256:pending', updatedAt: fixed },
      ]),
    ),
    runConfig,
    installedPackages: ['micropip'],
    layout,
    snapshots: [
      {
        id: 'snapshot-initial',
        label: '初始课程基准',
        checksum: 'sha256:baseline',
        createdAt: fixed,
        immutable: true,
        payload: snapshotPayload,
      },
    ],
    notebooks: [
      {
        ...baselineNotebook,
        cells: baselineNotebook.cells.map((cell) => ({ ...cell, outputs: [] })),
      },
    ],
    activeNotebookId: baselineNotebook.id,
    course: {
      ...baselineCourse,
      objectives: [...baselineCourse.objectives],
      steps: baselineCourse.steps.map((step) => ({ ...step })),
      checks: baselineCourse.checks.map((check) => ({ ...check })),
    },
    runs: [run],
    quotas: {
      maxFiles: 120,
      maxFolders: 60,
      maxFileChars: 100000,
      maxWorkspaceBytes: 900000,
      maxRuns: 100,
    },
    updatedAt: fixed,
  };
  const tree = [
    ...workspace.folders.map((path) => ({ path, type: 'folder' })),
    ...Object.entries(workspace.files).map(([path, content]) => ({
      path,
      type: 'file',
      bytes: new TextEncoder().encode(content).length,
      checksum: 'sha256:pending',
    })),
  ];
  const notebookIpynb = JSON.stringify(
    {
      cells: workspace.notebooks[0].cells.map((cell) => ({
        cell_type: cell.type,
        metadata: {},
        source: cell.source.split(/(?<=\n)/),
        execution_count: cell.executionCount,
        outputs: [],
      })),
      metadata: {
        kernelspec: {
          display_name: 'Python 3 (Pyodide)',
          language: 'python',
          name: 'python3',
        },
        language_info: { name: 'python', version: '3.13' },
      },
      nbformat: 4,
      nbformat_minor: 5,
    },
    null,
    2,
  );
  return {
    schema: 'skyview-python-lab-results',
    version: 4,
    stage: 'run-all',
    workspace,
    templates,
    analysis: {
      metrics: {
        files: 6,
        folders: 3,
        pythonFiles: 2,
        openFiles: 2,
        totalBytes: Object.values(defaultFiles).reduce(
          (sum, content) => sum + new TextEncoder().encode(content).length,
          0,
        ),
        runs: 1,
        snapshots: 1,
      },
      syntax: [
        {
          path: 'main.py',
          status: 'valid',
          message: '语法检查通过',
          line: null,
        },
        {
          path: 'utils/math_tools.py',
          status: 'valid',
          message: '语法检查通过',
          line: null,
        },
      ],
      valid: true,
      imports: ['os', 'sys', 'utils'],
      requirements: [],
      tree,
    },
    runtime: {
      browserRuntime: 'Pyodide 0.28.3',
      browserExecutionEnabled: true,
      workerTerminationStopsExecution: true,
      serverCodeExecutionEnabled: false,
      serverArbitraryCodeExecution: false,
      packageInstallMode: 'browser-micropip',
      persistentPythonFileSystem: false,
      browserRunEvidenceVerified: false,
    },
    exports: {
      workspaceJson: JSON.stringify(
        {
          schema: 'skyview-python-lab-workspace',
          version: 3,
          ...snapshotPayload,
          notebooks: workspace.notebooks,
          course: workspace.course,
        },
        null,
        2,
      ),
      manifestCsv: 'path,type,bytes,checksum\n',
      runHistoryCsv:
        'run_id,entry_path,status,exit_code,duration_ms,runtime,created_at,verified\n',
      analysisMarkdown: '# Python 课程实验\n\n- 语法检查：通过\n',
      backupJson: JSON.stringify(
        { schema: 'skyview-python-lab-backup', workspace },
        null,
        2,
      ),
      notebookIpynb,
    },
  };
}

function upgradeResult(raw: PythonLabResult): PythonLabResult {
  const fallback = createBenchmark();
  const workspace = raw.workspace || fallback.workspace;
  return {
    ...fallback,
    ...raw,
    version: Math.max(4, raw.version || 0),
    workspace: {
      ...fallback.workspace,
      ...workspace,
      notebooks: workspace.notebooks?.length
        ? workspace.notebooks
        : fallback.workspace.notebooks,
      activeNotebookId:
        workspace.activeNotebookId || fallback.workspace.activeNotebookId,
      course: workspace.course || fallback.workspace.course,
    },
    exports: { ...fallback.exports, ...raw.exports },
  };
}

const terminalStatuses = new Set(['succeeded', 'failed', 'canceled']);
const wait = (ms: number) =>
  new Promise((resolve) => window.setTimeout(resolve, ms));
async function waitForJob(id: string): Promise<WorkbenchJob | null> {
  for (let count = 0; count < 120; count += 1) {
    const job = await toolApi.getJob(id);
    if (terminalStatuses.has(job.status)) return job;
    await wait(500);
  }
  return null;
}
const normalizePath = (value: string) => {
  const parts: string[] = [];
  value
    .replace(/\\/g, '/')
    .split('/')
    .forEach((part) => {
      if (!part || part === '.') return;
      if (part === '..') parts.pop();
      else parts.push(part);
    });
  return parts.join('/');
};
const fileName = (path: string) => path.split('/').pop() || path;
const parentPath = (path: string) =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
const splitArgs = (value: string) =>
  (value.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((item) =>
    item.replace(/^["']|["']$/g, ''),
  );
const statusText = (status: string) =>
  ({ succeeded: '成功', failed: '失败', stopped: '已停止' })[status] || status;

function downloadText(
  content: string,
  name: string,
  type = 'text/plain;charset=utf-8',
) {
  const url = URL.createObjectURL(new Blob(['\ufeff', content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function buildVisibleTree(workspace: PythonWorkspace): TreeNode[] {
  const folders = new Set(workspace.folders);
  const children = new Map<string, TreeNode[]>();
  const add = (parent: string, node: TreeNode) =>
    children.set(parent, [...(children.get(parent) || []), node]);
  folders.forEach((path) =>
    add(parentPath(path), {
      path,
      name: fileName(path),
      type: 'folder',
      depth: path.split('/').length - 1,
    }),
  );
  Object.keys(workspace.files).forEach((path) =>
    add(parentPath(path), {
      path,
      name: fileName(path),
      type: 'file',
      depth: path.split('/').length - 1,
    }),
  );
  const output: TreeNode[] = [];
  const visit = (parent: string) =>
    (children.get(parent) || [])
      .sort((a, b) =>
        a.type === b.type
          ? a.name.localeCompare(b.name)
          : a.type === 'folder'
            ? -1
            : 1,
      )
      .forEach((node) => {
        output.push(node);
        if (
          node.type === 'folder' &&
          workspace.expandedFolders.includes(node.path)
        )
          visit(node.path);
      });
  visit('');
  return output;
}

function pyodideWorkerBootstrap() {
  const scope = globalThis as unknown as {
    postMessage: (value: unknown) => void;
    onmessage: ((event: MessageEvent) => void) | null;
    importScripts: (url: string) => void;
    loadPyodide: (options: { indexURL: string }) => Promise<WorkerPyodide>;
  };
  const base = 'https://cdn.jsdelivr.net/pyodide/v0.28.3/full/';
  const root = '/home/pyodide/workspace';
  let runtime: WorkerPyodide | null = null;
  let boot: Promise<WorkerPyodide> | null = null;
  let cellCount = 0;
  const installed = new Set(['micropip']);
  const post = (type: string, value: Record<string, unknown> = {}) =>
    scope.postMessage({ type, ...value });
  const ensure = async () => {
    if (runtime) return runtime;
    if (!boot)
      boot = (async () => {
        post('status', { message: '正在加载浏览器 Python', mode: 'loading' });
        scope.importScripts(base + 'pyodide.js');
        runtime = await scope.loadPyodide({ indexURL: base });
        await runtime.loadPackage('micropip');
        post('ready', {
          version: runtime.runPython('import sys; sys.version.split()[0]'),
        });
        return runtime;
      })();
    return boot;
  };
  const currentRuntime = () => {
    if (!runtime) throw new Error('浏览器 Python 尚未加载');
    return runtime;
  };
  const exists = (path: string) => {
    try {
      currentRuntime().FS.stat(path);
      return true;
    } catch {
      return false;
    }
  };
  const removeTree = (path: string) => {
    if (!exists(path)) return;
    const py = currentRuntime();
    const stat = py.FS.stat(path);
    if (py.FS.isDir(stat.mode)) {
      py.FS.readdir(path).forEach((name: string) => {
        if (!['.', '..'].includes(name)) removeTree(path + '/' + name);
      });
      py.FS.rmdir(path);
    } else py.FS.unlink(path);
  };
  const mkdirp = (path: string) => {
    const py = currentRuntime();
    let current = '';
    path
      .split('/')
      .filter(Boolean)
      .forEach((part) => {
        current += '/' + part;
        if (!exists(current)) py.FS.mkdir(current);
      });
  };
  const syncFiles = (files: Record<string, string>) => {
    const py = currentRuntime();
    // Never remove the virtual workspace while it is still the active cwd.
    py.FS.chdir('/');
    removeTree(root);
    mkdirp(root);
    Object.entries(files).forEach(([relative, content]) => {
      const safe = relative.replace(/\\/g, '/').replace(/^\/+/, '');
      if (!safe) return;
      const parent = safe.split('/').slice(0, -1).join('/');
      if (parent) mkdirp(root + '/' + parent);
      py.FS.writeFile(root + '/' + safe, String(content || ''), {
        encoding: 'utf8',
      });
    });
    py.FS.chdir(root);
  };
  const install = async (packages: string[]) => {
    const py = await ensure();
    const micropip = py.pyimport('micropip');
    for (const raw of packages) {
      const name = String(raw).trim();
      if (!name || installed.has(name)) continue;
      post('status', { message: '正在安装 ' + name, mode: 'loading' });
      try {
        await py.loadPackage(name);
      } catch {
        await micropip.install(name);
      }
      installed.add(name);
      post('package-installed', { name });
    }
  };
  const run = async (data: WorkerRunMessage) => {
    const py = await ensure();
    await install(data.packages || []);
    post('status', { message: '正在运行 ' + data.entryPath, mode: 'running' });
    syncFiles(data.files || {});
    py.globals.set('_lab_entry', data.entryPath || 'main.py');
    py.globals.set('_lab_stdin', data.stdin || '');
    py.globals.set('_lab_env', JSON.stringify(data.env || {}));
    py.globals.set('_lab_argv', JSON.stringify(data.argv || []));
    const wrapper = `
import contextlib, io, json, os, sys, time, traceback
_lab_stdout, _lab_stderr = io.StringIO(), io.StringIO()
_lab_started, _lab_exit = time.perf_counter(), 0
try:
    for _key, _value in json.loads(_lab_env or "{}").items(): os.environ[str(_key)] = str(_value)
    _absolute = os.path.abspath(_lab_entry)
    if os.path.dirname(_absolute) not in sys.path: sys.path.insert(0, os.path.dirname(_absolute))
    if os.getcwd() not in sys.path: sys.path.insert(0, os.getcwd())
    sys.argv, sys.stdin = [_lab_entry] + list(json.loads(_lab_argv or "[]")), io.StringIO(_lab_stdin or "")
    with open(_lab_entry, "r", encoding="utf-8") as _source: _code = _source.read()
    with contextlib.redirect_stdout(_lab_stdout), contextlib.redirect_stderr(_lab_stderr): exec(compile(_code, _lab_entry, "exec"), {"__name__": "__main__", "__file__": _lab_entry})
except SystemExit as _error: _lab_exit = _error.code if isinstance(_error.code, int) else 0
except BaseException:
    _lab_exit = 1
    traceback.print_exc(file=_lab_stderr)
_lab_result = {"stdout": _lab_stdout.getvalue(), "stderr": _lab_stderr.getvalue(), "exitCode": _lab_exit, "elapsedMs": round((time.perf_counter() - _lab_started) * 1000, 1)}
`;
    await py.runPythonAsync(wrapper);
    const proxy = py.globals.get('_lab_result');
    const result = proxy.toJs({ dict_converter: Object.fromEntries });
    proxy.destroy?.();
    post('result', {
      result,
      entryPath: data.entryPath,
      command: data.command,
    });
  };
  const runCell = async (
    data: WorkerRunMessage & { source?: string; cellId?: string },
  ) => {
    const py = await ensure();
    await install(data.packages || []);
    syncFiles(data.files || {});
    post('status', { message: '正在运行代码单元', mode: 'running' });
    py.globals.set('_lab_cell_source', data.source || '');
    py.globals.set('_lab_stdin', data.stdin || '');
    py.globals.set('_lab_env', JSON.stringify(data.env || {}));
    const wrapper = `
import ast, base64, contextlib, io, json, os, time, traceback, types
if "_lab_notebook_ns" not in globals():
    _lab_notebook_ns = {"__name__": "__main__"}
_cell_stdout, _cell_stderr = io.StringIO(), io.StringIO()
_cell_started, _cell_exit, _cell_value = time.perf_counter(), 0, None
_cell_outputs, _cell_variables = [], []
try:
    for _key, _value in json.loads(_lab_env or "{}").items(): os.environ[str(_key)] = str(_value)
    import sys
    sys.stdin = io.StringIO(_lab_stdin or "")
    _tree = ast.parse(_lab_cell_source, filename="<notebook-cell>", mode="exec")
    with contextlib.redirect_stdout(_cell_stdout), contextlib.redirect_stderr(_cell_stderr):
        if _tree.body and isinstance(_tree.body[-1], ast.Expr):
            _prefix = ast.Module(body=_tree.body[:-1], type_ignores=[])
            if _prefix.body: exec(compile(_prefix, "<notebook-cell>", "exec"), _lab_notebook_ns)
            _cell_value = eval(compile(ast.Expression(_tree.body[-1].value), "<notebook-cell>", "eval"), _lab_notebook_ns)
        else:
            exec(compile(_tree, "<notebook-cell>", "exec"), _lab_notebook_ns)
except SystemExit as _error:
    _cell_exit = _error.code if isinstance(_error.code, int) else 0
except BaseException:
    _cell_exit = 1
    traceback.print_exc(file=_cell_stderr)
_stdout_value, _stderr_value = _cell_stdout.getvalue(), _cell_stderr.getvalue()
if _stdout_value: _cell_outputs.append({"kind": "text", "text": _stdout_value})
if _cell_value is not None:
    if hasattr(_cell_value, "columns") and hasattr(_cell_value, "values"):
        _columns = [str(item) for item in list(_cell_value.columns)[:20]]
        _rows = [[str(value) for value in row[:20]] for row in _cell_value.head(100).values.tolist()]
        _cell_outputs.append({"kind": "table", "columns": _columns, "rows": _rows})
    else:
        _cell_outputs.append({"kind": "value", "text": repr(_cell_value)[:12000]})
try:
    import matplotlib.pyplot as _plt
    if _plt.get_fignums():
        _buffer = io.BytesIO()
        _plt.gcf().savefig(_buffer, format="png", dpi=120, bbox_inches="tight")
        _cell_outputs.append({"kind": "image", "dataUrl": "data:image/png;base64," + base64.b64encode(_buffer.getvalue()).decode("ascii")})
        _plt.close("all")
except Exception:
    pass
for _name, _value in sorted(_lab_notebook_ns.items()):
    if _name.startswith("_") or isinstance(_value, types.ModuleType): continue
    try: _preview = repr(_value)
    except Exception: _preview = "<无法显示>"
    _cell_variables.append({"name": _name, "type": type(_value).__name__, "value": _preview[:180]})
_lab_cell_result = {"stdout": _stdout_value, "stderr": _stderr_value, "exitCode": _cell_exit, "elapsedMs": round((time.perf_counter() - _cell_started) * 1000, 1), "outputs": _cell_outputs, "variables": _cell_variables[:40]}
`;
    await py.runPythonAsync(wrapper);
    const proxy = py.globals.get('_lab_cell_result');
    const result = proxy.toJs({ dict_converter: Object.fromEntries });
    proxy.destroy?.();
    cellCount += 1;
    post('cell-result', {
      result: { ...result, executionCount: cellCount },
      cellId: data.cellId,
    });
  };
  scope.onmessage = async (event: MessageEvent) => {
    const data = event.data || {};
    try {
      if (data.type === 'boot') await ensure();
      if (data.type === 'install') {
        await install(data.packages || []);
        post('status', { message: '浏览器 Python 已就绪', mode: 'ready' });
      }
      if (data.type === 'run') {
        await run(data);
        post('status', { message: '浏览器 Python 已就绪', mode: 'ready' });
      }
      if (data.type === 'run-cell') {
        await runCell(data);
        post('status', { message: '浏览器 Python 已就绪', mode: 'ready' });
      }
      if (data.type === 'run-notebook') {
        const py = await ensure();
        py.runPython('globals().pop("_lab_notebook_ns", None)');
        cellCount = 0;
        for (const cell of data.cells || [])
          await runCell({ ...data, ...cell });
        post('status', { message: '浏览器 Python 已就绪', mode: 'ready' });
      }
      if (data.type === 'reset-kernel') {
        const py = await ensure();
        py.runPython('globals().pop("_lab_notebook_ns", None)');
        cellCount = 0;
        post('kernel-reset');
        post('status', { message: '内核已重新启动', mode: 'ready' });
      }
    } catch (error) {
      const detail =
        error && typeof error === 'object' && 'message' in error
          ? error.message
          : error;
      let message: string;
      try {
        message = typeof detail === 'string' ? detail : JSON.stringify(detail);
      } catch {
        message = String(detail);
      }
      post('error', {
        message: message || String(detail),
      });
    }
  };
}

export function PythonLabWorkbench({
  executionAllowed = true,
}: {
  executionAllowed?: boolean;
}) {
  const [result, setResult] = useState<PythonLabResult>(() =>
    createBenchmark(),
  );
  const resultRef = useRef(result);
  const [projects, setProjects] = useState<WorkbenchProject[]>([]);
  const [projectId, setProjectId] = useState('');
  const projectsRef = useRef<WorkbenchProject[]>([]);
  const projectIdRef = useRef('');
  const [projectTitle, setProjectTitle] = useState('Python 课程实验');
  const [dirtyPaths, setDirtyPaths] = useState<Set<string>>(new Set());
  const [sidePanel, setSidePanel] = useState<'course' | 'files' | 'packages'>(
    'course',
  );
  const [rightPanel, setRightPanel] = useState<
    'guide' | 'variables' | 'run' | 'delivery'
  >('guide');
  const [workspaceMode, setWorkspaceMode] = useState<
    'notebook' | 'script' | 'data'
  >('notebook');
  const [bottomPanel, setBottomPanel] = useState<
    'terminal' | 'problems' | 'history'
  >('terminal');
  const [variables, setVariables] = useState<
    Array<{ name: string; type: string; value: string }>
  >([]);
  const [selectedCellId, setSelectedCellId] = useState('cell-load');
  const [templateId, setTemplateId] = useState('data');
  const [newPath, setNewPath] = useState('examples/new_script.py');
  const [output, setOutput] = useState(
    '准备就绪。运行代码时会加载浏览器 Python。\n',
  );
  const [runtimeStatus, setRuntimeStatus] = useState<
    'idle' | 'loading' | 'ready' | 'running' | 'error'
  >('idle');
  const [runtimeLabel, setRuntimeLabel] = useState('浏览器 Python 未加载');
  const [hasWorker, setHasWorker] = useState(false);
  const [argvText, setArgvText] = useState('--mode practice');
  const [envText, setEnvText] = useState('COURSE=PythonLab');
  const [stdinText, setStdinText] = useState('42\n');
  const [serverBusy, setServerBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const workerRef = useRef<Worker | null>(null);
  const workerUrlRef = useRef('');
  const cellRecordQueueRef = useRef<Promise<void>>(Promise.resolve());
  const lastRunRef = useRef({
    entryPath: 'main.py',
    command: 'python main.py',
  });
  const importRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    resultRef.current = result;
  }, [result]);
  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);
  useEffect(() => {
    projectIdRef.current = projectId;
  }, [projectId]);
  useEffect(() => {
    let active = true;
    toolApi
      .listProjects('python-lab')
      .then((items) => {
        if (!active) return;
        projectsRef.current = items;
        setProjects(items);
        const project = items[0];
        const saved = project?.state.pythonLab as
          | { result?: PythonLabResult }
          | undefined;
        if (project && saved?.result?.schema === 'skyview-python-lab-results') {
          const upgraded = upgradeResult(saved.result);
          projectIdRef.current = project.id;
          setProjectId(project.id);
          setProjectTitle(project.title);
          setResult(upgraded);
          resultRef.current = upgraded;
          setArgvText(upgraded.workspace.runConfig.argv.join(' '));
          setEnvText(
            Object.entries(upgraded.workspace.runConfig.env)
              .map(([key, value]) => `${key}=${value}`)
              .join('\n'),
          );
          setStdinText(upgraded.workspace.runConfig.stdin);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  useEffect(
    () => () => {
      workerRef.current?.terminate();
      if (workerUrlRef.current) URL.revokeObjectURL(workerUrlRef.current);
    },
    [],
  );

  const workspace = result.workspace;
  const activeContent = workspace.files[workspace.activePath] || '';
  const activeNotebook =
    workspace.notebooks.find(
      (item) => item.id === workspace.activeNotebookId,
    ) || workspace.notebooks[0];
  const visibleTree = useMemo(() => buildVisibleTree(workspace), [workspace]);
  const pyFiles = Object.keys(workspace.files).filter((path) =>
    path.endsWith('.py'),
  );
  const passedChecks = workspace.course.checks.filter(
    (item) => item.passed,
  ).length;
  const courseProgress = Math.round(
    (passedChecks / Math.max(1, workspace.course.checks.length)) * 100,
  );
  const dataRows = (workspace.files['data/data.txt'] || '')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split(',').map((value) => value.trim()));

  const ensureProject = async () => {
    const existing = projectsRef.current.find(
      (item) => item.id === projectIdRef.current,
    );
    if (existing) return existing;
    const created = await toolApi.createProject(
      'python-lab',
      projectTitle.trim() || 'Python 课程实验',
      { pythonLab: { result: resultRef.current } },
    );
    projectsRef.current = [created, ...projectsRef.current];
    projectIdRef.current = created.id;
    setProjects(projectsRef.current);
    setProjectId(created.id);
    return created;
  };
  const saveProjectResult = async (
    project: WorkbenchProject,
    next: PythonLabResult,
  ) => {
    const saved = await toolApi.updateProject(
      project.id,
      projectTitle.trim() || project.title,
      { ...project.state, pythonLab: { result: next } },
    );
    setProjects((items) => {
      const updated = items.map((item) =>
        item.id === saved.id ? saved : item,
      );
      projectsRef.current = updated;
      return updated;
    });
  };
  const execute = async (
    action: string,
    extra: Record<string, unknown> = {},
    quiet = false,
  ) => {
    if (!executionAllowed) {
      setError('控制服务当前未开放工作区写入。');
      return null;
    }
    setServerBusy(true);
    setError('');
    if (!quiet) setMessage('正在保存工作区变更…');
    try {
      const project = await ensureProject();
      const created = await toolApi.createJob(
        project.id,
        'python-lab',
        action,
        { state: { workspace: resultRef.current.workspace }, ...extra },
        crypto.randomUUID(),
      );
      const job = await waitForJob(created.job.id);
      if (!job) throw new Error('作业仍在后台运行。');
      if (job.status !== 'succeeded')
        throw new Error(job.error || '工作区操作失败。');
      const raw = job.result as PythonLabResult;
      if (raw.schema !== 'skyview-python-lab-results')
        throw new Error('服务端返回了不兼容的工作区。');
      const next = upgradeResult(raw);
      resultRef.current = next;
      setResult(next);
      await saveProjectResult(project, next);
      if (!quiet) setMessage('工作区已保存。');
      return next;
    } catch (caught) {
      setError(
        caught instanceof ApiError || caught instanceof Error
          ? caught.message
          : '操作失败。',
      );
      setMessage('');
      return null;
    } finally {
      setServerBusy(false);
    }
  };

  const appendOutput = (text: string) =>
    setOutput((current) => `${current}${text}`.slice(-100000));
  const recordRun = async (
    run: WorkerResult,
    entryPath: string,
    command: string,
  ) => {
    await execute(
      'record-run',
      {
        entryPath,
        command,
        status: run.exitCode === 0 ? 'succeeded' : 'failed',
        exitCode: run.exitCode,
        durationMs: run.elapsedMs,
        stdout: run.stdout,
        stderr: run.stderr,
        runtime: 'Pyodide 0.28.3',
      },
      true,
    );
  };
  const ensureWorker = () => {
    if (workerRef.current) return workerRef.current;
    const blob = new Blob([`(${pyodideWorkerBootstrap.toString()})()`], {
      type: 'text/javascript',
    });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);
    workerRef.current = worker;
    workerUrlRef.current = url;
    setHasWorker(true);
    setRuntimeStatus('loading');
    setRuntimeLabel('正在加载浏览器 Python');
    worker.onmessage = (event) => {
      const data = event.data || {};
      if (data.type === 'status') {
        setRuntimeStatus(
          data.mode === 'running'
            ? 'running'
            : data.mode === 'ready'
              ? 'ready'
              : 'loading',
        );
        setRuntimeLabel(data.message);
      }
      if (data.type === 'ready') {
        setRuntimeStatus('ready');
        setRuntimeLabel(`Python ${data.version} · Pyodide 0.28.3`);
      }
      if (data.type === 'package-installed') {
        appendOutput(`已安装 ${data.name}\n`);
        void execute('install-package', { package: data.name }, true);
      }
      if (data.type === 'result') {
        const run = data.result as WorkerResult;
        if (run.stdout) appendOutput(run.stdout);
        if (run.stderr) appendOutput(run.stderr);
        appendOutput(
          `进程已结束，退出代码 ${run.exitCode}，耗时 ${run.elapsedMs} ms\n`,
        );
        setRuntimeStatus('ready');
        void recordRun(
          run,
          data.entryPath || lastRunRef.current.entryPath,
          data.command || lastRunRef.current.command,
        );
      }
      if (data.type === 'cell-result') {
        const run = data.result as WorkerResult;
        setVariables(run.variables || []);
        if (run.stdout) appendOutput(run.stdout);
        if (run.stderr) appendOutput(run.stderr);
        appendOutput(`代码单元运行结束 · ${run.elapsedMs} ms\n`);
        setRuntimeStatus('ready');
        cellRecordQueueRef.current = cellRecordQueueRef.current.then(async () => {
          await execute(
            'record-cell-run',
            {
              notebookId: resultRef.current.workspace.activeNotebookId,
              cellId: data.cellId,
              status: run.exitCode === 0 ? 'succeeded' : 'failed',
              exitCode: run.exitCode,
              durationMs: run.elapsedMs,
              executionCount: run.executionCount,
              stdout: run.stdout,
              stderr: run.stderr,
              outputs: run.outputs || [],
              variables: run.variables || [],
            },
            true,
          );
        });
      }
      if (data.type === 'kernel-reset') {
        setVariables([]);
        appendOutput('Notebook 内核已重新启动。\n');
      }
      if (data.type === 'error') {
        setRuntimeStatus('error');
        setRuntimeLabel('浏览器 Python 运行异常');
        appendOutput(`${data.message}\n`);
      }
    };
    worker.onerror = (event) => {
      setRuntimeStatus('error');
      setRuntimeLabel('浏览器 Python 运行异常');
      appendOutput(`${event.message}\n`);
    };
    worker.postMessage({ type: 'boot' });
    return worker;
  };
  const stopWorker = (reset = false) => {
    workerRef.current?.terminate();
    workerRef.current = null;
    setHasWorker(false);
    if (workerUrlRef.current) URL.revokeObjectURL(workerUrlRef.current);
    workerUrlRef.current = '';
    setRuntimeStatus('idle');
    setRuntimeLabel('浏览器 Python 未加载');
    appendOutput(
      reset ? '\n运行时已重置。\n' : '\n运行已停止，Worker 已销毁。\n',
    );
  };

  const updateActiveContent = (content: string) => {
    const next = {
      ...resultRef.current,
      workspace: {
        ...resultRef.current.workspace,
        files: {
          ...resultRef.current.workspace.files,
          [resultRef.current.workspace.activePath]: content,
        },
      },
    };
    resultRef.current = next;
    setResult(next);
    setDirtyPaths((items) => new Set(items).add(workspace.activePath));
  };
  const openFile = (path: string) => {
    if (!(path in workspace.files)) return;
    const next = {
      ...resultRef.current,
      workspace: {
        ...workspace,
        activePath: path,
        openFiles: workspace.openFiles.includes(path)
          ? workspace.openFiles
          : [...workspace.openFiles, path].slice(-20),
      },
    };
    resultRef.current = next;
    setResult(next);
  };
  const toggleFolder = (path: string) => {
    const expanded = workspace.expandedFolders.includes(path)
      ? workspace.expandedFolders.filter((item) => item !== path)
      : [...workspace.expandedFolders, path];
    const next = {
      ...resultRef.current,
      workspace: { ...workspace, expandedFolders: expanded },
    };
    resultRef.current = next;
    setResult(next);
  };
  const closeFile = (path: string) => {
    if (workspace.openFiles.length <= 1) return;
    const openFiles = workspace.openFiles.filter((item) => item !== path);
    const next = {
      ...resultRef.current,
      workspace: {
        ...workspace,
        openFiles,
        activePath:
          workspace.activePath === path ? openFiles[0] : workspace.activePath,
      },
    };
    resultRef.current = next;
    setResult(next);
  };
  const saveActive = async () => {
    const next = await execute('save-file', {
      path: workspace.activePath,
      content: activeContent,
    });
    if (next)
      setDirtyPaths((items) => {
        const copy = new Set(items);
        copy.delete(workspace.activePath);
        return copy;
      });
  };
  const applyTemplate = async () => {
    const next = await execute('apply-template', { templateId });
    if (next)
      setDirtyPaths((items) => {
        const copy = new Set(items);
        copy.delete(next.workspace.activePath);
        return copy;
      });
  };
  const updateNotebookCell = (cellId: string, source: string) => {
    const current = resultRef.current;
    const next = {
      ...current,
      workspace: {
        ...current.workspace,
        notebooks: current.workspace.notebooks.map((notebook) =>
          notebook.id === current.workspace.activeNotebookId
            ? {
                ...notebook,
                updatedAt: new Date().toISOString(),
                cells: notebook.cells.map((cell) =>
                  cell.id === cellId
                    ? { ...cell, source, status: 'idle' as const, outputs: [] }
                    : cell,
                ),
              }
            : notebook,
        ),
      },
    };
    resultRef.current = next;
    setResult(next);
  };
  const saveNotebook = async () => {
    const notebook = resultRef.current.workspace.notebooks.find(
      (item) => item.id === resultRef.current.workspace.activeNotebookId,
    );
    if (notebook) await execute('save-notebook', { notebook }, true);
  };
  const setNotebookRunState = (cellIds: string[]) => {
    const current = resultRef.current;
    const next = {
      ...current,
      workspace: {
        ...current.workspace,
        notebooks: current.workspace.notebooks.map((notebook) =>
          notebook.id === current.workspace.activeNotebookId
            ? {
                ...notebook,
                cells: notebook.cells.map((cell) =>
                  cellIds.includes(cell.id)
                    ? { ...cell, status: 'running' as const, outputs: [] }
                    : cell,
                ),
              }
            : notebook,
        ),
      },
    };
    resultRef.current = next;
    setResult(next);
  };
  const runNotebookCell = async (cellId: string) => {
    const notebook = resultRef.current.workspace.notebooks.find(
      (item) => item.id === resultRef.current.workspace.activeNotebookId,
    );
    const cell = notebook?.cells.find((item) => item.id === cellId);
    if (!notebook || !cell || cell.type !== 'code') return;
    const saved = await execute('save-notebook', { notebook }, true);
    if (!saved) {
      appendOutput('运行已取消：Notebook 尚未成功保存。\n');
      return;
    }
    setNotebookRunState([cell.id]);
    setSelectedCellId(cell.id);
    ensureWorker().postMessage({
      type: 'run-cell',
      cellId: cell.id,
      source: cell.source,
      files: saved.workspace.files,
      stdin: saved.workspace.runConfig.stdin,
      env: saved.workspace.runConfig.env,
      packages: parseRequirements(saved.workspace.files),
    });
  };
  const runNotebookAll = async () => {
    const notebook = resultRef.current.workspace.notebooks.find(
      (item) => item.id === resultRef.current.workspace.activeNotebookId,
    );
    if (!notebook) return;
    const saved = await execute('save-notebook', { notebook }, true);
    if (!saved) {
      appendOutput('运行已取消：Notebook 尚未成功保存。\n');
      return;
    }
    const cells = notebook.cells.filter((cell) => cell.type === 'code');
    setNotebookRunState(cells.map((cell) => cell.id));
    ensureWorker().postMessage({
      type: 'run-notebook',
      cells: cells.map((cell) => ({ cellId: cell.id, source: cell.source })),
      files: saved.workspace.files,
      stdin: saved.workspace.runConfig.stdin,
      env: saved.workspace.runConfig.env,
      packages: parseRequirements(saved.workspace.files),
    });
  };
  const addNotebookCell = () => {
    if (!activeNotebook) return;
    const cell: NotebookCell = {
      id: `cell-${crypto.randomUUID().slice(0, 8)}`,
      type: 'code',
      source: '# 输入 Python 代码\n',
      executionCount: null,
      status: 'idle',
      outputs: [],
    };
    const nextNotebook = {
      ...activeNotebook,
      cells: [...activeNotebook.cells, cell],
      updatedAt: new Date().toISOString(),
    };
    const next = {
      ...resultRef.current,
      workspace: {
        ...resultRef.current.workspace,
        notebooks: resultRef.current.workspace.notebooks.map((item) =>
          item.id === nextNotebook.id ? nextNotebook : item,
        ),
      },
    };
    resultRef.current = next;
    setResult(next);
    setSelectedCellId(cell.id);
    void execute('save-notebook', { notebook: nextNotebook }, true);
  };
  const deleteNotebookCell = (cellId: string) => {
    if (
      !activeNotebook ||
      activeNotebook.cells.length <= 1 ||
      !window.confirm('确定删除这个代码单元？')
    )
      return;
    const nextNotebook = {
      ...activeNotebook,
      cells: activeNotebook.cells.filter((cell) => cell.id !== cellId),
      updatedAt: new Date().toISOString(),
    };
    const next = {
      ...resultRef.current,
      workspace: {
        ...resultRef.current.workspace,
        notebooks: resultRef.current.workspace.notebooks.map((item) =>
          item.id === nextNotebook.id ? nextNotebook : item,
        ),
      },
    };
    resultRef.current = next;
    setResult(next);
    void execute('save-notebook', { notebook: nextNotebook }, true);
  };
  const clearNotebookOutputs = () => {
    if (!activeNotebook) return;
    const nextNotebook = {
      ...activeNotebook,
      cells: activeNotebook.cells.map((cell) => ({
        ...cell,
        executionCount: null,
        status: 'idle' as const,
        outputs: [],
      })),
      updatedAt: new Date().toISOString(),
    };
    const next = {
      ...resultRef.current,
      workspace: {
        ...resultRef.current.workspace,
        notebooks: resultRef.current.workspace.notebooks.map((item) =>
          item.id === nextNotebook.id ? nextNotebook : item,
        ),
      },
    };
    resultRef.current = next;
    setResult(next);
    void execute('save-notebook', { notebook: nextNotebook }, true);
  };
  const createPath = async (kind: 'file' | 'folder') => {
    const action = kind === 'file' ? 'create-file' : 'create-folder';
    const next = await execute(action, {
      path: newPath,
      content:
        kind === 'file' && newPath.endsWith('.py')
          ? '# 新建 Python 文件\n'
          : '',
    });
    if (next)
      setNewPath(kind === 'file' ? 'examples/new_script.py' : 'examples');
  };
  const renamePath = async (path: string) => {
    const target = window.prompt('输入新路径', path);
    if (target && normalizePath(target) !== path)
      await execute('rename-path', { oldPath: path, newPath: target });
  };
  const deletePath = async (path: string) => {
    if (window.confirm(`确定删除 ${path}？`))
      await execute('delete-path', { path });
  };

  const parseRequirements = (files: Record<string, string>) =>
    (files['requirements.txt'] || '')
      .split(/\r?\n/)
      .map((line) => line.replace(/#.*/, '').trim())
      .filter(Boolean);
  const startRun = async (
    entryPath = workspace.runConfig.entryPath || workspace.activePath,
    options: Partial<RunConfig> = {},
    filesOverride?: Record<string, string>,
    command = '',
  ) => {
    const current = resultRef.current.workspace;
    const saved = await execute(
      'save-file',
      {
        path: current.activePath,
        content: current.files[current.activePath] || '',
      },
      true,
    );
    if (!saved) {
      appendOutput('\n运行已取消：工作区尚未成功保存。\n');
      return;
    }
    setDirtyPaths((items) => {
      const copy = new Set(items);
      copy.delete(current.activePath);
      return copy;
    });
    const transientFiles = filesOverride
      ? Object.fromEntries(
          Object.entries(filesOverride).filter(([path]) =>
            path.startsWith('.terminal/'),
          ),
        )
      : {};
    const files = { ...saved.workspace.files, ...transientFiles };
    const target = normalizePath(entryPath);
    if (!target.endsWith('.py') || !(target in files)) {
      appendOutput(`\n找不到可运行的 Python 文件：${target}\n`);
      return;
    }
    const config = { ...saved.workspace.runConfig, ...options };
    const runCommand =
      command || `python ${target} ${config.argv.join(' ')}`.trim();
    lastRunRef.current = { entryPath: target, command: runCommand };
    appendOutput(`\npython-lab $ ${runCommand}\n运行 ${target}...\n`);
    setRuntimeStatus('running');
    ensureWorker().postMessage({
      type: 'run',
      files,
      entryPath: target,
      stdin: config.stdin,
      argv: config.argv,
      env: config.env,
      packages: parseRequirements(files),
      command: runCommand,
    });
  };
  const saveRunConfig = async () => {
    const env: Record<string, string> = {};
    envText.split(/\r?\n/).forEach((line) => {
      const index = line.indexOf('=');
      if (index > 0) env[line.slice(0, index).trim()] = line.slice(index + 1);
    });
    await execute('update-run-config', {
      entryPath: workspace.runConfig.entryPath,
      stdin: stdinText,
      argv: splitArgs(argvText),
      env,
    });
  };

  const listDirectory = (path = '') => {
    const prefix = path ? `${normalizePath(path)}/` : '';
    const names = new Set<string>();
    workspace.folders.forEach((folder) => {
      if (folder.startsWith(prefix)) {
        const rest = folder.slice(prefix.length);
        if (rest && !rest.includes('/')) names.add(`${rest}/`);
      }
    });
    Object.keys(workspace.files).forEach((file) => {
      if (file.startsWith(prefix)) {
        const rest = file.slice(prefix.length);
        if (rest && !rest.includes('/')) names.add(rest);
      }
    });
    return [...names].sort();
  };
  const treeText = () =>
    [
      'PYTHON-LAB',
      ...visibleTree.map(
        (node) =>
          `${'  '.repeat(node.depth + 1)}- ${node.name}${node.type === 'folder' ? '/' : ''}`,
      ),
    ].join('\n') + '\n';
  const handleTerminal = async (raw: string) => {
    const command = raw.trim();
    if (!command) return;
    const tokens = splitArgs(command);
    let name = tokens[0];
    let args = tokens.slice(1);
    const env: Record<string, string> = {};
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(name || '')) {
      const index = name.indexOf('=');
      env[name.slice(0, index)] = name.slice(index + 1);
      name = args.shift() || '';
    }
    let stdin = '';
    const redirect = args.indexOf('<');
    if (redirect >= 0) {
      stdin = workspace.files[normalizePath(args[redirect + 1] || '')] || '';
      args = [...args.slice(0, redirect), ...args.slice(redirect + 2)];
    }
    const pipe = tokens.indexOf('|');
    if (pipe > 0 && ['echo', 'printf'].includes(tokens[0])) {
      stdin =
        tokens
          .slice(1, pipe)
          .join(' ')
          .replace(/\\n/g, '\n')
          .replace(/\\t/g, '\t') + (tokens[0] === 'echo' ? '\n' : '');
      const executable = tokens.slice(pipe + 1);
      name = executable[0];
      args = executable.slice(1);
    }
    appendOutput(`\npython-lab $ ${command}\n`);
    if (name === 'help') {
      appendOutput(
        '命令：python、python -m unittest、python -c、pip install、ls、tree、cat、open、touch、mkdir、rm、pwd、clear、reset\n',
      );
      return;
    }
    if (name === 'clear') {
      setOutput('');
      return;
    }
    if (name === 'pwd') {
      appendOutput('/home/pyodide/workspace\n');
      return;
    }
    if (name === 'ls') {
      appendOutput(listDirectory(args[0]).join('  ') + '\n');
      return;
    }
    if (name === 'tree') {
      appendOutput(treeText());
      return;
    }
    if (name === 'cat') {
      appendOutput(
        workspace.files[normalizePath(args[0] || '')] ??
          `cat: ${args[0]}: 没有这个文件\n`,
      );
      return;
    }
    if (name === 'open' || name === 'code') {
      openFile(normalizePath(args[0] || workspace.activePath));
      return;
    }
    if (name === 'touch') {
      await execute('create-file', {
        path: args[0] || 'untitled.py',
        content: '',
      });
      return;
    }
    if (name === 'mkdir') {
      await execute('create-folder', { path: args[0] || 'folder' });
      return;
    }
    if (name === 'rm') {
      await deletePath(args[0] || '');
      return;
    }
    if (name === 'reset') {
      stopWorker(true);
      return;
    }
    if (name === 'pip' && args[0] === 'install') {
      ensureWorker().postMessage({ type: 'install', packages: args.slice(1) });
      return;
    }
    if (name === 'run') {
      await startRun(workspace.activePath, { stdin, env }, undefined, command);
      return;
    }
    if (name === 'python') {
      if (args[0] === '-m' && args[1] === 'unittest') {
        const pattern = args[2] || 'test*.py';
        const file = '.terminal/run_unittest.py';
        const files = {
          ...workspace.files,
          [file]: `import sys\nimport unittest\npattern = ${JSON.stringify(pattern)}\nsuite = unittest.defaultTestLoader.discover(".", pattern=pattern)\nresult = unittest.TextTestRunner(verbosity=2).run(suite)\nraise SystemExit(0 if result.wasSuccessful() else 1)\n`,
        };
        await startRun(file, { stdin, env, argv: [] }, files, command);
        return;
      }
      if (args[0] === '-c') {
        const file = '.terminal/command.py';
        await startRun(
          file,
          { stdin, env, argv: args.slice(2) },
          { ...workspace.files, [file]: args[1] || '' },
          command,
        );
        return;
      }
      const target = args[0]?.endsWith('.py')
        ? normalizePath(args[0])
        : workspace.activePath;
      await startRun(
        target,
        { stdin, env, argv: target === args[0] ? args.slice(1) : args },
        undefined,
        command,
      );
      return;
    }
    appendOutput(`${name}: 未识别命令，输入 help 查看命令。\n`);
  };

  const selectProject = (id: string) => {
    projectIdRef.current = id;
    setProjectId(id);
    const project = projectsRef.current.find((item) => item.id === id);
    const saved = project?.state.pythonLab as
      | { result?: PythonLabResult }
      | undefined;
    if (project && saved?.result?.schema === 'skyview-python-lab-results') {
      const upgraded = upgradeResult(saved.result);
      setProjectTitle(project.title);
      setResult(upgraded);
      resultRef.current = upgraded;
      setDirtyPaths(new Set());
    }
  };
  const importWorkspace = async (file: globalThis.File) => {
    if (file.size > 900000) {
      setError('工作区文件不能超过 900 KB。');
      return;
    }
    await execute('import-workspace', {
      content: await file.text(),
      title: file.name.replace(/\.json$/i, ''),
    });
  };
  const createSnapshot = async () => {
    const next = await execute('create-snapshot', {
      label: `实验快照 ${workspace.snapshots.length + 1}`,
    });
    if (next) {
      const project = projects.find((item) => item.id === projectId);
      if (project)
        await toolApi.createVersion(
          project.id,
          next.createdSnapshot?.label || 'Python 实验快照',
          { pythonLab: { result: next } },
        );
    }
  };
  return (
    <section className="pylab-studio" aria-label="Python 实验室工作台">
      <header className="pylab-topbar">
        <div className="pylab-brand-block">
          <span>PYTHON LAB</span>
          <div>
            <NativeSelect
              aria-label="选择 Python 项目"
              value={projectId}
              onChange={(event) => selectProject(event.target.value)}
            >
              <option value="">新建实验项目</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.title}
                </option>
              ))}
            </NativeSelect>
            <Input
              aria-label="项目名称"
              value={projectTitle}
              onChange={(event) => setProjectTitle(event.target.value)}
            />
          </div>
        </div>
        <div className="pylab-mode-switch" role="tablist" aria-label="实验视图">
          <button
            className={workspaceMode === 'notebook' ? 'active' : ''}
            onClick={() => setWorkspaceMode('notebook')}
          >
            <BookOpen />
            笔记本
          </button>
          <button
            className={workspaceMode === 'script' ? 'active' : ''}
            onClick={() => setWorkspaceMode('script')}
          >
            <FileCode2 />
            脚本
          </button>
          <button
            className={workspaceMode === 'data' ? 'active' : ''}
            onClick={() => setWorkspaceMode('data')}
          >
            <Database />
            数据
          </button>
        </div>
        <div className={`pylab-kernel ${runtimeStatus}`}>
          <i />
          <span>{runtimeLabel}</span>
        </div>
        <div className="pylab-primary-actions">
          {workspaceMode === 'notebook' ? (
            <>
              <Button variant="outline" onClick={addNotebookCell}>
                <Plus />
                代码单元
              </Button>
              <Button
                variant="outline"
                onClick={() => void saveNotebook()}
                disabled={serverBusy}
              >
                <Save />
                保存
              </Button>
              <Button
                onClick={() => void runNotebookAll()}
                disabled={runtimeStatus === 'running'}
              >
                <Play />
                运行全部
              </Button>
              <Button
                variant="outline"
                onClick={() => stopWorker(false)}
                disabled={!hasWorker}
              >
                <Square />
                停止
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  ensureWorker().postMessage({ type: 'reset-kernel' })
                }
              >
                <RefreshCw />
                重启内核
              </Button>
            </>
          ) : workspaceMode === 'script' ? (
            <>
              <NativeSelect
                aria-label="示例模板"
                value={templateId}
                onChange={(event) => setTemplateId(event.target.value)}
              >
                {templates.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </NativeSelect>
              <Button
                variant="outline"
                onClick={() => void applyTemplate()}
                disabled={serverBusy}
              >
                载入示例
              </Button>
              <Button
                variant="outline"
                onClick={() => void saveActive()}
                disabled={serverBusy}
              >
                <Save />
                保存
              </Button>
              <Button
                onClick={() => void startRun()}
                disabled={runtimeStatus === 'running'}
              >
                <Play />
                运行
              </Button>
              <Button
                variant="outline"
                onClick={() => stopWorker(false)}
                disabled={!hasWorker}
              >
                <Square />
                停止
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={() => openFile('data/data.txt')}>
              <File />
              打开数据文件
            </Button>
          )}
        </div>
      </header>
      <div className="pylab-statusrail">
        <span>
          <Files />
          {result.analysis.metrics.files} 个文件
        </span>
        <span className={result.analysis.valid ? 'ok' : 'error'}>
          {result.analysis.valid ? <Check /> : <CircleAlert />}
          {result.analysis.valid ? '语法通过' : '存在语法错误'}
        </span>
        <span>
          <BookOpen />
          {activeNotebook?.cells.length || 0} 个单元
        </span>
        <span>
          <History />
          {workspace.runs.length} 次运行
        </span>
        <span>
          <Clock3 />
          修订 {workspace.revision}
        </span>
        {message && <em>{message}</em>}
        {error && <em className="error">{error}</em>}
      </div>
      <div className="pylab-shell">
        <nav className="pylab-activity" aria-label="实验资源">
          <button
            className={sidePanel === 'course' ? 'active' : ''}
            onClick={() => setSidePanel('course')}
            aria-label="实验任务"
          >
            <BookOpen />
          </button>
          <button
            className={sidePanel === 'files' ? 'active' : ''}
            onClick={() => setSidePanel('files')}
            aria-label="文件管理"
          >
            <Files />
          </button>
          <button
            className={sidePanel === 'packages' ? 'active' : ''}
            onClick={() => setSidePanel('packages')}
            aria-label="环境与依赖"
          >
            <Package />
          </button>
        </nav>
        <aside className="pylab-sidebar">
          {sidePanel === 'course' && (
            <div className="pylab-course">
              <header>
                <small>{workspace.course.section}</small>
                <strong>{workspace.course.title}</strong>
              </header>
              <div className="pylab-progress">
                <span>
                  <b>{courseProgress}%</b> 已完成
                </span>
                <i>
                  <b style={{ width: `${courseProgress}%` }} />
                </i>
              </div>
              <div className="pylab-objectives">
                {workspace.course.objectives.map((item) => (
                  <span key={item}>
                    <CheckCircle2 />
                    {item}
                  </span>
                ))}
              </div>
              <ol>
                {workspace.course.steps.map((step, index) => (
                  <li key={step.id}>
                    <i>{String(index + 1).padStart(2, '0')}</i>
                    <span>
                      <strong>{step.title}</strong>
                      <small>{step.detail}</small>
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}
          {sidePanel === 'files' && (
            <div className="pylab-files">
              <header>
                <span>课程文件</span>
                <b>
                  {workspace.files ? Object.keys(workspace.files).length : 0}
                </b>
              </header>
              <div className="pylab-create">
                <Input
                  aria-label="新路径"
                  value={newPath}
                  onChange={(event) => setNewPath(event.target.value)}
                />
                <button
                  onClick={() => void createPath('file')}
                  title="新建文件"
                >
                  <FilePlus2 />
                </button>
                <button
                  onClick={() => void createPath('folder')}
                  title="新建文件夹"
                >
                  <FolderPlus />
                </button>
              </div>
              <div className="pylab-tree">
                {visibleTree.map((node) => (
                  <article
                    key={`${node.type}:${node.path}`}
                    className={
                      workspace.activePath === node.path ? 'active' : ''
                    }
                    style={{ '--depth': node.depth } as CSSProperties}
                  >
                    <button
                      onClick={() => {
                        if (node.type === 'folder') toggleFolder(node.path);
                        else {
                          openFile(node.path);
                          setWorkspaceMode(
                            node.path === 'data/data.txt' ? 'data' : 'script',
                          );
                        }
                      }}
                    >
                      {node.type === 'folder' ? (
                        workspace.expandedFolders.includes(node.path) ? (
                          <ChevronDown />
                        ) : (
                          <ChevronRight />
                        )
                      ) : (
                        <span />
                      )}
                      {node.type === 'folder' ? (
                        workspace.expandedFolders.includes(node.path) ? (
                          <FolderOpen />
                        ) : (
                          <Folder />
                        )
                      ) : node.path.endsWith('.py') ? (
                        <FileCode2 />
                      ) : (
                        <File />
                      )}
                      <strong>{node.name}</strong>
                      {dirtyPaths.has(node.path) && <i />}
                    </button>
                    <div>
                      <button
                        onClick={() => void renamePath(node.path)}
                        title="重命名"
                      >
                        <Braces />
                      </button>
                      <button
                        onClick={() => void deletePath(node.path)}
                        title="删除"
                      >
                        <Trash2 />
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          )}
          {sidePanel === 'packages' && (
            <div className="pylab-packages">
              <header>
                <small>浏览器环境</small>
                <strong>Python 3 · Pyodide</strong>
              </header>
              <p>requirements.txt 中的兼容依赖会在浏览器内核启动时同步。</p>
              {workspace.installedPackages.map((item) => (
                <span key={item}>
                  <Box />
                  <b>{item}</b>
                  <small>已安装</small>
                </span>
              ))}
              {result.analysis.requirements.map((item) => (
                <span key={`required-${item}`}>
                  <Package />
                  <b>{item}</b>
                  <small>运行时同步</small>
                </span>
              ))}
            </div>
          )}
        </aside>
        <main className="pylab-workspace">
          {workspaceMode === 'notebook' && (
            <section className="pylab-notebook">
              <header>
                <div>
                  <BookOpen />
                  <span>
                    <strong>{activeNotebook?.title}</strong>
                    <small>Python 3 (Pyodide) · 自动保存到项目</small>
                  </span>
                </div>
                <div>
                  <button onClick={clearNotebookOutputs}>清除输出</button>
                  <button onClick={() => void runNotebookAll()}>
                    <Play />
                    运行全部
                  </button>
                </div>
              </header>
              <div className="pylab-cells">
                {activeNotebook?.cells.map((cell) =>
                  cell.type === 'markdown' ? (
                    <article key={cell.id} className="pylab-markdown-cell">
                      <span>说明</span>
                      <div>
                        {cell.source
                          .split('\n')
                          .map((line, index) =>
                            line.startsWith('## ') ? (
                              <h2 key={index}>{line.slice(3)}</h2>
                            ) : (
                              <p key={index}>{line}</p>
                            ),
                          )}
                      </div>
                    </article>
                  ) : (
                    <article
                      key={cell.id}
                      className={`pylab-code-cell ${selectedCellId === cell.id ? 'selected' : ''} ${cell.status}`}
                      onFocusCapture={() => setSelectedCellId(cell.id)}
                    >
                      <aside>
                        <button
                          onClick={() => void runNotebookCell(cell.id)}
                          aria-label="运行代码单元"
                        >
                          <Play />
                        </button>
                        <span>
                          {cell.executionCount
                            ? `[${cell.executionCount}]`
                            : '[ ]'}
                        </span>
                        <button
                          onClick={() => deleteNotebookCell(cell.id)}
                          aria-label="删除代码单元"
                        >
                          <Trash2 />
                        </button>
                      </aside>
                      <div>
                        <MonacoCodeEditor
                          compact
                          path={`notebook/${activeNotebook.id}/${cell.id}.py`}
                          value={cell.source}
                          onChange={(value) =>
                            updateNotebookCell(cell.id, value)
                          }
                          onRun={() => void runNotebookCell(cell.id)}
                          onSave={() => void saveNotebook()}
                        />
                        {cell.outputs.length > 0 && (
                          <div className="pylab-cell-output">
                            {cell.outputs.map((item, index) =>
                              item.kind === 'table' ? (
                                <div className="pylab-output-table" key={index}>
                                  <table>
                                    <thead>
                                      <tr>
                                        {item.columns?.map((column) => (
                                          <th key={column}>{column}</th>
                                        ))}
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {item.rows?.map((row, rowIndex) => (
                                        <tr key={rowIndex}>
                                          {row.map((value, valueIndex) => (
                                            <td key={valueIndex}>
                                              {String(value ?? '')}
                                            </td>
                                          ))}
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              ) : item.kind === 'image' && item.dataUrl ? (
                                <Image
                                  unoptimized
                                  width={960}
                                  height={540}
                                  key={index}
                                  src={item.dataUrl}
                                  alt="代码单元生成图表"
                                />
                              ) : (
                                <pre key={index}>{item.text}</pre>
                              ),
                            )}
                          </div>
                        )}
                      </div>
                    </article>
                  ),
                )}
              </div>
            </section>
          )}
          {workspaceMode === 'script' && (
            <section className="pylab-script">
              <div className="pylab-file-tabs">
                {workspace.openFiles
                  .filter((path) => path in workspace.files)
                  .map((path) => (
                    <article
                      key={path}
                      className={workspace.activePath === path ? 'active' : ''}
                    >
                      <button onClick={() => openFile(path)}>
                        <FileCode2 />
                        {fileName(path)}
                        {dirtyPaths.has(path) && <i />}
                      </button>
                      <button
                        onClick={() => closeFile(path)}
                        aria-label={`关闭 ${fileName(path)}`}
                      >
                        <X />
                      </button>
                    </article>
                  ))}
              </div>
              <MonacoCodeEditor
                path={workspace.activePath}
                value={activeContent}
                language={
                  workspace.activePath.endsWith('.py')
                    ? 'python'
                    : workspace.activePath.endsWith('.json')
                      ? 'json'
                      : 'plaintext'
                }
                onChange={updateActiveContent}
                onRun={() => void startRun(workspace.activePath)}
                onSave={() => void saveActive()}
              />
            </section>
          )}
          {workspaceMode === 'data' && (
            <section className="pylab-data">
              <header>
                <div>
                  <Database />
                  <span>
                    <strong>data/data.txt</strong>
                    <small>{dataRows.length} 行 · 逗号分隔</small>
                  </span>
                </div>
                <Button
                  variant="outline"
                  onClick={() => {
                    openFile('data/data.txt');
                    setWorkspaceMode('script');
                  }}
                >
                  <FileCode2 />
                  编辑原始数据
                </Button>
              </header>
              <div className="pylab-data-grid">
                <div className="pylab-data-table">
                  <table>
                    <thead>
                      <tr>
                        {dataRows[0]?.map((_, index) => (
                          <th key={index}>字段 {index + 1}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {dataRows.map((row, rowIndex) => (
                        <tr key={rowIndex}>
                          {row.map((value, valueIndex) => (
                            <td key={valueIndex}>{value}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <aside>
                  <strong>数值概览</strong>
                  {[0, 1, 2].map((column) => {
                    const values = dataRows
                      .map((row) => Number(row[column]))
                      .filter(Number.isFinite);
                    const maximum = Math.max(...values, 1);
                    return (
                      <article key={column}>
                        <span>字段 {column + 1}</span>
                        <div>
                          {values.map((value, index) => (
                            <i
                              key={index}
                              style={{
                                height: `${Math.max(8, (value / maximum) * 100)}%`,
                              }}
                            />
                          ))}
                        </div>
                        <small>
                          均值{' '}
                          {values.length
                            ? (
                                values.reduce((sum, value) => sum + value, 0) /
                                values.length
                              ).toFixed(1)
                            : '—'}
                        </small>
                      </article>
                    );
                  })}
                </aside>
              </div>
            </section>
          )}
          <section className="pylab-bottom">
            <header>
              <div>
                <button
                  className={bottomPanel === 'terminal' ? 'active' : ''}
                  onClick={() => setBottomPanel('terminal')}
                >
                  <TerminalSquare />
                  终端
                </button>
                <button
                  className={bottomPanel === 'problems' ? 'active' : ''}
                  onClick={() => setBottomPanel('problems')}
                >
                  <CircleAlert />
                  问题{' '}
                  {
                    result.analysis.syntax.filter(
                      (item) => item.status !== 'valid',
                    ).length
                  }
                </button>
                <button
                  className={bottomPanel === 'history' ? 'active' : ''}
                  onClick={() => setBottomPanel('history')}
                >
                  <History />
                  运行记录
                </button>
              </div>
              <button onClick={() => setOutput('')}>清空</button>
            </header>
            {bottomPanel === 'terminal' && (
              <XtermConsole
                output={output}
                running={runtimeStatus === 'running'}
                onCommand={handleTerminal}
              />
            )}
            {bottomPanel === 'problems' && (
              <div className="pylab-problems">
                {result.analysis.syntax.map((item) => (
                  <article key={item.path} className={item.status}>
                    <FileCode2 />
                    <span>
                      <strong>{item.path}</strong>
                      <small>
                        {item.message}
                        {item.line ? ` · 第 ${item.line} 行` : ''}
                      </small>
                    </span>
                    {item.status === 'valid' ? <Check /> : <CircleAlert />}
                  </article>
                ))}
              </div>
            )}
            {bottomPanel === 'history' && (
              <div className="pylab-run-history">
                {workspace.runs.map((run) => (
                  <article key={run.id}>
                    <span className={run.status}>{statusText(run.status)}</span>
                    <strong>{run.entryPath}</strong>
                    <code>{run.command}</code>
                    <time>{run.durationMs} ms</time>
                  </article>
                ))}
              </div>
            )}
          </section>
        </main>
        <aside className="pylab-context">
          <Tabs
            value={rightPanel}
            onValueChange={(value) => setRightPanel(value as typeof rightPanel)}
          >
            <TabsList>
              <TabsTrigger value="guide">
                <CheckCircle2 />
                验收
              </TabsTrigger>
              <TabsTrigger value="variables">
                <Variable />
                变量
              </TabsTrigger>
              <TabsTrigger value="run">
                <Settings2 />
                配置
              </TabsTrigger>
              <TabsTrigger value="delivery">
                <Download />
                交付
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="pylab-context-body">
            {rightPanel === 'guide' && (
              <div className="pylab-checks">
                <header>
                  <span>
                    <strong>实验验收</strong>
                    <small>
                      {passedChecks}/{workspace.course.checks.length} 项通过
                    </small>
                  </span>
                  <b>{courseProgress}%</b>
                </header>
                {workspace.course.checks.map((check) => (
                  <article
                    key={check.id}
                    className={check.passed ? 'passed' : ''}
                  >
                    {check.passed ? <CheckCircle2 /> : <CircleDot />}
                    <span>{check.label}</span>
                  </article>
                ))}
                <div className="pylab-runtime-card">
                  <strong>当前执行环境</strong>
                  <span>
                    <Zap />
                    浏览器独立 Worker
                  </span>
                  <span>
                    <Check />
                    服务端不执行工作区代码
                  </span>
                  <span>
                    <Check />
                    停止时销毁运行内核
                  </span>
                </div>
              </div>
            )}
            {rightPanel === 'variables' && (
              <div className="pylab-variables">
                <header>
                  <strong>变量检查器</strong>
                  <small>
                    {variables.length
                      ? `${variables.length} 个变量`
                      : '运行代码单元后显示'}
                  </small>
                </header>
                {variables.length ? (
                  variables.map((item) => (
                    <article key={item.name}>
                      <span>
                        <b>{item.name}</b>
                        <small>{item.type}</small>
                      </span>
                      <code>{item.value}</code>
                    </article>
                  ))
                ) : (
                  <div className="pylab-empty">
                    <Variable />
                    <span>尚无运行变量</span>
                  </div>
                )}
              </div>
            )}
            {rightPanel === 'run' && (
              <div className="pylab-run-config">
                <div className="pylab-field">
                  <span>入口文件</span>
                  <NativeSelect
                    aria-label="运行入口文件"
                    value={workspace.runConfig.entryPath}
                    onChange={(event) => {
                      const next = {
                        ...resultRef.current,
                        workspace: {
                          ...workspace,
                          runConfig: {
                            ...workspace.runConfig,
                            entryPath: event.target.value,
                          },
                        },
                      };
                      resultRef.current = next;
                      setResult(next);
                    }}
                  >
                    {pyFiles.map((path) => (
                      <option key={path}>{path}</option>
                    ))}
                  </NativeSelect>
                </div>
                <div className="pylab-field">
                  <span>命令行参数</span>
                  <Input
                    aria-label="命令行参数"
                    value={argvText}
                    onChange={(event) => setArgvText(event.target.value)}
                  />
                </div>
                <div className="pylab-field">
                  <span>环境变量</span>
                  <textarea
                    aria-label="环境变量"
                    value={envText}
                    onChange={(event) => setEnvText(event.target.value)}
                  />
                </div>
                <div className="pylab-field">
                  <span>标准输入</span>
                  <textarea
                    aria-label="标准输入"
                    value={stdinText}
                    onChange={(event) => setStdinText(event.target.value)}
                  />
                </div>
                <Button
                  onClick={() => void saveRunConfig()}
                  disabled={serverBusy}
                >
                  <Save />
                  保存运行配置
                </Button>
                <div className="pylab-shortcuts">
                  <span>
                    <Keyboard />
                    编辑器快捷键
                  </span>
                  <code>Ctrl + S</code>
                  <small>保存文件</small>
                  <code>Ctrl + Enter</code>
                  <small>运行文件或单元</small>
                </div>
              </div>
            )}
            {rightPanel === 'delivery' && (
              <div className="pylab-delivery">
                <button onClick={() => importRef.current?.click()}>
                  <FileInput />
                  <span>
                    <strong>导入工作区</strong>
                    <small>JSON</small>
                  </span>
                </button>
                <button
                  onClick={() =>
                    downloadText(
                      result.exports.notebookIpynb,
                      'python-lab.ipynb',
                      'application/x-ipynb+json;charset=utf-8',
                    )
                  }
                >
                  <BookOpen />
                  <span>
                    <strong>Notebook</strong>
                    <small>IPYNB</small>
                  </span>
                </button>
                <button
                  onClick={() =>
                    downloadText(
                      result.exports.workspaceJson,
                      'python-lab-workspace.json',
                      'application/json;charset=utf-8',
                    )
                  }
                >
                  <Download />
                  <span>
                    <strong>工作区</strong>
                    <small>JSON</small>
                  </span>
                </button>
                <button
                  onClick={() =>
                    downloadText(
                      result.exports.manifestCsv,
                      'python-lab-file-manifest.csv',
                      'text/csv;charset=utf-8',
                    )
                  }
                >
                  <Files />
                  <span>
                    <strong>文件清单</strong>
                    <small>CSV</small>
                  </span>
                </button>
                <button
                  onClick={() =>
                    downloadText(
                      result.exports.runHistoryCsv,
                      'python-lab-run-history.csv',
                      'text/csv;charset=utf-8',
                    )
                  }
                >
                  <History />
                  <span>
                    <strong>运行记录</strong>
                    <small>CSV</small>
                  </span>
                </button>
                <button
                  onClick={() =>
                    downloadText(
                      result.exports.analysisMarkdown,
                      'python-lab-analysis.md',
                    )
                  }
                >
                  <FileCode2 />
                  <span>
                    <strong>检查报告</strong>
                    <small>Markdown</small>
                  </span>
                </button>
                <button
                  onClick={() =>
                    downloadText(
                      result.exports.backupJson,
                      'python-lab-backup.json',
                      'application/json;charset=utf-8',
                    )
                  }
                >
                  <Upload />
                  <span>
                    <strong>完整备份</strong>
                    <small>JSON</small>
                  </span>
                </button>
                <Button
                  onClick={() => void createSnapshot()}
                  disabled={serverBusy}
                >
                  <Layers3 />
                  创建版本快照
                </Button>
                <div className="pylab-snapshots">
                  {workspace.snapshots.map((snapshot) => (
                    <article key={snapshot.id}>
                      <span>
                        <strong>{snapshot.label}</strong>
                        <small>{snapshot.checksum.slice(0, 18)}…</small>
                      </span>
                      <button
                        onClick={() =>
                          void execute('restore-snapshot', {
                            snapshotId: snapshot.id,
                          })
                        }
                      >
                        <RefreshCw />
                        恢复
                      </button>
                    </article>
                  ))}
                </div>
              </div>
            )}
          </div>
        </aside>
      </div>
      <input
        ref={importRef}
        hidden
        type="file"
        accept="application/json,.json"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void importWorkspace(file);
          event.currentTarget.value = '';
        }}
      />
    </section>
  );
}
