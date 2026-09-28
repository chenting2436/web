'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, Archive, Boxes, Braces, CheckCircle2, ChevronRight, CircleAlert,
  Clock3, Database, Download, FileInput, GitBranch, KeyRound,
  ListChecks, LoaderCircle, Network, PauseCircle, Play, Plus, RefreshCw,
  Save, ScrollText, Send, Settings2, ShieldCheck, Sparkles, TimerReset,
  Trash2, Workflow as WorkflowIcon, X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiError } from '@/services/api/client';
import { toolApi, type WorkbenchJob, type WorkbenchProject } from '@/services/api/tools';

type NodeType = 'trigger' | 'source' | 'transform' | 'analysis' | 'review' | 'output';
type AutomationNode = {
  id: string;
  type: NodeType;
  name: string;
  dependsOn: string[];
  enabled: boolean;
  config: Record<string, unknown>;
  position: { x: number; y: number };
  retryPolicy: { maxAttempts: number; backoffSeconds: number };
  timeoutSeconds: number;
  approvalRequired: boolean;
};
type Workflow = {
  id: string;
  name: string;
  description: string;
  status: string;
  schedule: { enabled: boolean; expression: string; timeZone: string };
  retries: number;
  timeoutSeconds: number;
  concurrencyPolicy: string;
  variables: Array<{ id: string; key: string; value: string; type: string }>;
  secretRefs: Array<{ id: string; key: string; provider: string; reference: string; configured: boolean }>;
  nodes: AutomationNode[];
  createdAt: string;
  updatedAt: string;
};
type StepRun = { id: string; nodeId: string; name: string; type: NodeType; status: string; attempts: number; durationMs: number; message: string; startedAt: string | null; finishedAt: string | null };
type AutomationRun = { id: string; workflowId: string; workflowVersion: number; mode: string; status: string; trigger: string; stepRuns: StepRun[]; durationMs: number; createdAt: string; finishedAt: string | null; cancelRequested: boolean };
type AutomationWorkspace = {
  id: string;
  name: string;
  currentWorkflowId: string;
  selectedNodeId: string;
  currentRunId: string;
  workflows: Workflow[];
  templates: Array<{ id: string; workflow: Workflow }>;
  versions: Array<{ id: string; workflowId: string; version: number; label: string; checksum: string; createdAt: string; immutable?: boolean }>;
  runs: AutomationRun[];
  logs: Array<{ id: string; runId: string; stepRunId: string; level: string; message: string; createdAt: string; redacted: boolean }>;
  approvals: Array<{ id: string; runId: string; nodeId: string; status: string; decision: string; actor: string; createdAt: string; decidedAt?: string }>;
  artifacts: Array<{ id: string; runId: string; nodeId: string; name: string; mediaType: string; size: number; checksum: string; createdAt: string }>;
  lineage: Array<{ id: string; from: string; to: string; relation: string; nodeId: string }>;
  createdAt: string;
  updatedAt: string;
};
type AutomationResult = {
  schema: 'skyview-research-automation-results';
  version: number;
  stage: string;
  workspace: AutomationWorkspace;
  analysis: {
    validation: { valid: boolean; order: string[]; messages: Array<{ type: string; message: string }> };
    metrics: { workflows: number; activeNodes: number; runs: number; successRate: number; averageDurationMs: number; pendingApprovals: number; artifacts: number };
    nodeTypeCounts: Array<{ id: NodeType; label: string; count: number }>;
    statusCounts: Array<{ status: string; count: number }>;
    durationSeries: Array<{ id: string; durationMs: number; status: string; createdAt: string }>;
    graph: { nodes: AutomationNode[]; edges: Array<{ id: string; source: string; target: string; condition: string }> };
  };
  runtime: { executionMode: string; orchestration: string; compute: string; arbitraryCodeExecution: boolean; networkConnectorsConfigured: boolean; persistentSchedulerConfigured: boolean; durableWorkflowEngineConfigured: boolean; secretValuesStored: boolean; previewResultsPublishable: boolean };
  exports: { workflowJson: string; runCsv: string; logsNdjson: string; lineageJson: string; reportMarkdown: string; backupJson: string };
  run?: AutomationRun;
  publishedVersion?: AutomationWorkspace['versions'][number];
  importSummary?: { nodes: number; historyDiscarded: boolean; secretValuesStripped: number; executionStarted: boolean };
};

const views = [
  ['overview', '运行总览'], ['designer', '流程设计'], ['settings', '流程配置'], ['variables', '变量与密钥'],
  ['runs', '运行追踪'], ['approvals', '审批与恢复'], ['lineage', '产物血缘'], ['delivery', '版本交付'],
] as const;
const nodeTypes: Array<[NodeType, string]> = [['trigger', '触发'], ['source', '数据源'], ['transform', '转换'], ['analysis', '分析'], ['review', '人工复核'], ['output', '输出']];
const terminal = new Set(['succeeded', 'failed', 'canceled']);
const wait = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));
const fixed = '2026-09-09T00:00:00Z';

function makeNode(id: string, type: NodeType, name: string, dependsOn: string[], x: number): AutomationNode {
  return { id, type, name, dependsOn, enabled: true, config: { summary: name }, position: { x, y: 88 }, retryPolicy: { maxAttempts: type === 'source' || type === 'analysis' ? 3 : 1, backoffSeconds: 5 }, timeoutSeconds: 120, approvalRequired: type === 'review' };
}

function createBenchmarkResult(): AutomationResult {
  const nodes = [
    makeNode('node-start', 'trigger', '定时触发', [], 35),
    makeNode('node-source', 'source', '读取材料清单', ['node-start'], 210),
    makeNode('node-quality', 'transform', '质量与重复检查', ['node-source'], 385),
    makeNode('node-analysis', 'analysis', '主题与方法分析', ['node-quality'], 560),
    makeNode('node-review', 'review', '人工复核', ['node-analysis'], 735),
    makeNode('node-output', 'output', '生成研究雷达摘要', ['node-review'], 910),
  ];
  const workflow: Workflow = {
    id: 'workflow-radar', name: 'AI+矿山安全研究雷达', description: '定期整理研究材料，完成质量检查、主题分析、人工复核和摘要输出。', status: 'draft',
    schedule: { enabled: false, expression: '每周一 09:00', timeZone: 'Asia/Shanghai' }, retries: 2, timeoutSeconds: 900, concurrencyPolicy: 'forbid-overlap',
    variables: [{ id: 'var-topic', key: 'TOPIC', value: 'mine safety AI', type: 'string' }, { id: 'var-limit', key: 'MAX_ITEMS', value: '20', type: 'number' }],
    secretRefs: [{ id: 'secret-source', key: 'LITERATURE_API', provider: 'environment', reference: 'research/literature-api', configured: false }], nodes, createdAt: fixed, updatedAt: fixed,
  };
  const template = (id: string, name: string, types: NodeType[]): { id: string; workflow: Workflow } => ({ id, workflow: { ...workflow, id: `workflow-${id}`, name, status: 'template', nodes: types.map((type, index) => makeNode(`${id}-${index + 1}`, type, `${nodeTypes.find(([key]) => key === type)?.[1]}步骤`, index ? [`${id}-${index}`] : [], 35 + index * 175)), variables: [], secretRefs: [] } });
  const successSteps = nodes.map((node, index): StepRun => ({ id: `step-${node.id}`, nodeId: node.id, name: node.name, type: node.type, status: 'succeeded', attempts: 1, durationMs: 34 + index * 17, message: '执行成功', startedAt: fixed, finishedAt: fixed }));
  const successRun: AutomationRun = { id: 'run-002', workflowId: workflow.id, workflowVersion: 1, mode: 'deterministic-preview', status: 'succeeded', trigger: 'manual', stepRuns: successSteps, durationMs: successSteps.reduce((sum, item) => sum + item.durationMs, 0), createdAt: fixed, finishedAt: fixed, cancelRequested: false };
  const failedSteps = nodes.map((node, index): StepRun => ({ id: `failed-${node.id}`, nodeId: node.id, name: node.name, type: node.type, status: index < 2 ? 'succeeded' : index === 2 ? 'failed' : 'skipped', attempts: index === 2 ? 3 : index > 2 ? 0 : 1, durationMs: index <= 2 ? 35 + index * 30 : 0, message: index === 2 ? '预览故障注入：重试后仍失败' : index > 2 ? '上游节点失败' : '执行成功', startedAt: fixed, finishedAt: fixed }));
  const failedRun: AutomationRun = { id: 'run-001', workflowId: workflow.id, workflowVersion: 1, mode: 'deterministic-preview', status: 'failed', trigger: 'manual', stepRuns: failedSteps, durationMs: failedSteps.reduce((sum, item) => sum + item.durationMs, 0), createdAt: '2026-09-08T08:30:00Z', finishedAt: '2026-09-08T08:30:01Z', cancelRequested: false };
  const workspace: AutomationWorkspace = {
    id: 'automation-workspace-main', name: '研究自动化流程库', currentWorkflowId: workflow.id, selectedNodeId: 'node-analysis', currentRunId: successRun.id, workflows: [workflow],
    templates: [template('literature', '系统综述材料流水线', ['trigger', 'source', 'transform', 'review', 'analysis', 'output']), template('remote', '遥感证据日报', ['trigger', 'source', 'transform', 'analysis', 'review', 'output']), template('experiment', '可复现实验流水线', ['trigger', 'source', 'transform', 'analysis', 'analysis', 'review', 'output'])],
    versions: [{ id: 'version-001', workflowId: workflow.id, version: 1, label: '初始流程基准', checksum: 'sha256:72b1b84f', createdAt: fixed, immutable: true }], runs: [successRun, failedRun],
    logs: [...successSteps.map((item, index) => ({ id: `log-ok-${index}`, runId: successRun.id, stepRunId: item.id, level: 'info', message: item.message, createdAt: fixed, redacted: true })), { id: 'log-failure', runId: failedRun.id, stepRunId: 'failed-node-quality', level: 'error', message: '预览故障注入：重试后仍失败', createdAt: failedRun.createdAt, redacted: true }],
    approvals: [{ id: 'approval-001', runId: successRun.id, nodeId: 'node-review', status: 'approved', decision: '通过', actor: '本地基准审核人', createdAt: fixed }],
    artifacts: [{ id: 'artifact-report', runId: successRun.id, nodeId: 'node-output', name: '研究雷达摘要.md', mediaType: 'text/markdown', size: 2468, checksum: 'sha256:6a8b27d0', createdAt: fixed }, { id: 'artifact-records', runId: successRun.id, nodeId: 'node-analysis', name: '主题方法矩阵.json', mediaType: 'application/json', size: 1834, checksum: 'sha256:291ed841', createdAt: fixed }, { id: 'artifact-evidence', runId: successRun.id, nodeId: 'node-review', name: '人工复核记录.json', mediaType: 'application/json', size: 778, checksum: 'sha256:3109a744', createdAt: fixed }],
    lineage: [{ id: 'lineage-01', from: 'input:literature-catalog', to: 'artifact-records', relation: 'generated-by', nodeId: 'node-analysis' }, { id: 'lineage-02', from: 'artifact-records', to: 'artifact-evidence', relation: 'reviewed-by', nodeId: 'node-review' }, { id: 'lineage-03', from: 'artifact-evidence', to: 'artifact-report', relation: 'summarized-by', nodeId: 'node-output' }], createdAt: fixed, updatedAt: fixed,
  };
  const edges = nodes.flatMap((node) => node.dependsOn.map((source) => ({ id: `edge:${source}:${node.id}`, source, target: node.id, condition: 'success' })));
  return {
    schema: 'skyview-research-automation-results', version: 2, stage: 'run-all', workspace,
    analysis: { validation: { valid: true, order: nodes.map((item) => item.id), messages: [{ type: 'pass', message: '节点、依赖与白名单类型检查通过' }] }, metrics: { workflows: 1, activeNodes: 6, runs: 2, successRate: 50, averageDurationMs: Math.round((successRun.durationMs + failedRun.durationMs) / 2), pendingApprovals: 0, artifacts: 3 }, nodeTypeCounts: nodeTypes.map(([id, label]) => ({ id, label, count: nodes.filter((item) => item.type === id).length })), statusCounts: [{ status: 'succeeded', count: 1 }, { status: 'failed', count: 1 }, { status: 'awaiting-approval', count: 0 }, { status: 'canceled', count: 0 }], durationSeries: [failedRun, successRun].map((item) => ({ id: item.id, durationMs: item.durationMs, status: item.status, createdAt: item.createdAt })), graph: { nodes, edges } },
    runtime: { executionMode: 'deterministic-preview', orchestration: 'Go 项目、作业、版本与审计', compute: 'Python 白名单节点预览引擎', arbitraryCodeExecution: false, networkConnectorsConfigured: false, persistentSchedulerConfigured: false, durableWorkflowEngineConfigured: false, secretValuesStored: false, previewResultsPublishable: false },
    exports: { workflowJson: JSON.stringify({ schema: 'skyview-research-workflow', version: 1, workflow }, null, 2), runCsv: 'run_id,status,duration_ms\nrun-002,succeeded,459', logsNdjson: '{"runId":"run-002","level":"info"}', lineageJson: JSON.stringify({ schema: 'skyview-workflow-lineage', artifacts: workspace.artifacts, lineage: workspace.lineage }, null, 2), reportMarkdown: '# AI+矿山安全研究雷达运行报告\n\n当前执行为确定性受控预览。', backupJson: JSON.stringify({ schema: 'skyview-research-automation-backup', workspace }, null, 2) },
  };
}

async function waitForJob(id: string): Promise<WorkbenchJob | null> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const job = await toolApi.getJob(id);
    if (terminal.has(job.status)) return job;
    await wait(750);
  }
  return null;
}

function downloadText(content: string, fileName: string, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob(['\ufeff', content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

const statusLabel = (status: string) => ({ succeeded: '成功', failed: '失败', 'awaiting-approval': '待审批', pending: '等待', skipped: '跳过', canceled: '已取消', rejected: '已退回' })[status] || status;
const typeLabel = (type: NodeType) => nodeTypes.find(([id]) => id === type)?.[1] || type;

export function ResearchAutomationWorkbench({ executionAllowed = true }: { executionAllowed?: boolean }) {
  const [view, setView] = useState<(typeof views)[number][0]>('overview');
  const [result, setResult] = useState<AutomationResult>(() => createBenchmarkResult());
  const [projects, setProjects] = useState<WorkbenchProject[]>([]);
  const [projectId, setProjectId] = useState('');
  const [projectTitle, setProjectTitle] = useState('研究自动化编排项目');
  const [selectedRunId, setSelectedRunId] = useState(result.workspace.currentRunId);
  const [newNodeType, setNewNodeType] = useState<NodeType>('analysis');
  const [newNodeName, setNewNodeName] = useState('新分析节点');
  const [variableKey, setVariableKey] = useState('');
  const [variableValue, setVariableValue] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [secretReference, setSecretReference] = useState('');
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const importInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    toolApi.listProjects('research-automation').then((items) => {
      if (!active) return;
      setProjects(items);
      const project = items[0];
      const saved = project?.state.researchAutomation as { result?: AutomationResult } | undefined;
      if (project && saved?.result?.schema === 'skyview-research-automation-results') {
        setProjectId(project.id);
        setProjectTitle(project.title);
        setResult(saved.result);
        setSelectedRunId(saved.result.workspace.currentRunId);
      }
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  const projectState = (next = result) => ({ researchAutomation: { schemaVersion: 2, result: next } });
  const ensureProject = async () => {
    const existing = projects.find((item) => item.id === projectId);
    if (existing) return existing;
    const created = await toolApi.createProject('research-automation', projectTitle, projectState());
    setProjects((items) => [created, ...items]);
    setProjectId(created.id);
    return created;
  };
  const storeResult = async (project: WorkbenchProject, output: AutomationResult) => {
    setResult(output);
    setSelectedRunId(output.workspace.currentRunId || output.workspace.runs[0]?.id || '');
    const saved = await toolApi.updateProject(project.id, projectTitle, projectState(output));
    setProjects((items) => [saved, ...items.filter((item) => item.id !== saved.id)]);
  };
  const execute = async (action: string, extra: Record<string, unknown> = {}) => {
    if (!executionAllowed) return null;
    setRunning(true);
    setError('');
    setMessage('Go 已登记研究自动化作业，Python 正在更新流程状态…');
    try {
      const project = await ensureProject();
      const created = await toolApi.createJob(project.id, 'research-automation', action, { state: { workspace: result.workspace }, ...extra }, crypto.randomUUID());
      const job = await waitForJob(created.job.id);
      if (!job) throw new Error('作业仍在后台运行。');
      if (job.status === 'failed') throw new Error(job.error || '研究自动化作业失败。');
      if (job.status === 'canceled') throw new Error('作业已取消。');
      const output = job.result as AutomationResult;
      if (output.schema !== 'skyview-research-automation-results') throw new Error('服务端返回了不兼容的流程结果。');
      await storeResult(project, output);
      setMessage(action === 'run-preview' ? '受控预览已完成或进入人工审批。' : '研究流程已更新。');
      return output;
    } catch (caught) {
      setError(caught instanceof ApiError || caught instanceof Error ? caught.message : '操作失败。');
      setMessage('');
      return null;
    } finally {
      setRunning(false);
    }
  };
  const saveProject = async () => {
    setSaving(true);
    try {
      const existing = projects.find((item) => item.id === projectId);
      const saved = existing ? await toolApi.updateProject(existing.id, projectTitle, projectState()) : await toolApi.createProject('research-automation', projectTitle, projectState());
      setProjects((items) => [saved, ...items.filter((item) => item.id !== saved.id)]);
      setProjectId(saved.id);
      setMessage('研究自动化项目已保存。');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '保存失败。');
    } finally {
      setSaving(false);
    }
  };
  const createVersion = async () => {
    try {
      const project = await ensureProject();
      await toolApi.createVersion(project.id, `研究自动化快照 v${result.workspace.versions.length + 1}`, projectState());
      setMessage('已建立 Go 控制面的不可变项目快照。');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '建立快照失败。');
    }
  };
  const selectProject = (id: string) => {
    setProjectId(id);
    const project = projects.find((item) => item.id === id);
    if (!project) { const baseline = createBenchmarkResult(); setResult(baseline); setProjectTitle('研究自动化编排项目'); return; }
    const saved = project.state.researchAutomation as { result?: AutomationResult } | undefined;
    if (saved?.result?.schema === 'skyview-research-automation-results') { setResult(saved.result); setProjectTitle(project.title); setSelectedRunId(saved.result.workspace.currentRunId); }
  };
  const updateLocal = (change: (draft: AutomationResult) => void) => setResult((current) => { const next = structuredClone(current); change(next); return next; });
  const importWorkflow = async (file?: File) => {
    if (!file) return;
    if (file.size > 900_000) { setError('流程文件不能超过 900 KB。'); return; }
    await execute('import-workflow', { fileName: file.name, content: await file.text() });
    if (importInput.current) importInput.current.value = '';
  };

  const workflow = result.workspace.workflows.find((item) => item.id === result.workspace.currentWorkflowId) || result.workspace.workflows[0];
  const selectedNode = workflow.nodes.find((item) => item.id === result.workspace.selectedNodeId) || workflow.nodes[0];
  const selectedNodeSummary = typeof selectedNode.config.summary === 'string' ? selectedNode.config.summary : '';
  const selectedRun = result.workspace.runs.find((item) => item.id === selectedRunId) || result.workspace.runs[0];
  const pendingApprovals = result.workspace.approvals.filter((item) => item.status === 'pending');
  const currentVersions = result.workspace.versions.filter((item) => item.workflowId === workflow.id);
  const maxDuration = Math.max(1, ...result.analysis.durationSeries.map((item) => item.durationMs));
  const nodeById = useMemo(() => new Map(workflow.nodes.map((item) => [item.id, item])), [workflow.nodes]);

  return <div className="auto-workbench">
    <header className="auto-commandbar">
      <div className="auto-project">
        <WorkflowIcon />
        <NativeSelect aria-label="选择研究自动化项目" value={projectId} onChange={(event) => selectProject(event.target.value)}>
          <NativeSelectOption value="">当前本地项目</NativeSelectOption>
          {projects.map((project) => <NativeSelectOption value={project.id} key={project.id}>{project.title}</NativeSelectOption>)}
        </NativeSelect>
        <Input aria-label="项目名称" value={projectTitle} onChange={(event) => setProjectTitle(event.target.value)} />
        <span>确定性受控预览</span><em>白名单节点</em>
      </div>
      <div className="auto-actions">
        <input ref={importInput} hidden type="file" accept="application/json,.json" onChange={(event) => void importWorkflow(event.target.files?.[0])} />
        <Button size="sm" variant="outline" onClick={() => importInput.current?.click()}><FileInput />导入流程</Button>
        <Button size="sm" variant="outline" disabled={saving} onClick={() => void saveProject()}>{saving ? <LoaderCircle className="spin" /> : <Save />}保存</Button>
        <Button size="sm" variant="outline" onClick={() => void createVersion()}><Archive />建立快照</Button>
        <Button size="sm" disabled={running || !result.analysis.validation.valid} onClick={() => void execute('run-preview')}>{running ? <LoaderCircle className="spin" /> : <Play />}运行受控预览</Button>
      </div>
    </header>

    <section className="auto-kpis">
      <article><WorkflowIcon /><span>工作流</span><strong>{result.workspace.workflows.length}</strong><small>{workflow.status === 'published' ? '已发布版本' : '当前草稿'}</small></article>
      <article><Boxes /><span>活动节点</span><strong>{result.analysis.metrics.activeNodes}</strong><small>六类白名单节点</small></article>
      <article><Activity /><span>累计运行</span><strong>{result.analysis.metrics.runs}</strong><small>最近 {result.workspace.runs.length} 条</small></article>
      <article><ShieldCheck /><span>成功率</span><strong>{result.analysis.metrics.successRate}%</strong><small>终态运行统计</small></article>
      <article><ListChecks /><span>待审批</span><strong>{result.analysis.metrics.pendingApprovals}</strong><small>必须人工处理</small></article>
      <article><Archive /><span>可追溯产物</span><strong>{result.analysis.metrics.artifacts}</strong><small>{result.workspace.lineage.length} 条血缘关系</small></article>
    </section>

    <Tabs value={view} onValueChange={(value) => setView(value as typeof view)} className="auto-tabs-shell">
      <TabsList className="auto-tabs" variant="line">{views.map(([id, label], index) => <TabsTrigger value={id} key={id}><b>{String(index + 1).padStart(2, '0')}</b>{label}</TabsTrigger>)}</TabsList>
    </Tabs>

    {(message || error) && <div className={`auto-status ${error ? 'error' : ''}`}>{error ? <CircleAlert /> : <CheckCircle2 />}<span>{error || message}</span><button aria-label="关闭状态" onClick={() => { setError(''); setMessage(''); }}><X /></button></div>}

    <main className="auto-stage">
      {view === 'overview' && <div className="auto-view auto-overview">
        <section className="auto-surface auto-pipeline">
          <header><div><span>当前流程链</span><strong>{workflow.name}</strong></div><small>{result.analysis.validation.valid ? '依赖关系有效' : '需要修复依赖'}</small></header>
          <div>{result.analysis.validation.order.map((id, index) => { const node = nodeById.get(id); return node ? <button key={id} onClick={() => { updateLocal((draft) => { draft.workspace.selectedNodeId = id; }); setView('designer'); }}><b>{String(index + 1).padStart(2, '0')}</b><span><strong>{node.name}</strong><small>{typeLabel(node.type)}</small></span>{index < workflow.nodes.length - 1 && <ChevronRight />}</button> : null; })}</div>
        </section>
        <section className="auto-surface auto-duration">
          <header><span>运行耗时</span><strong>{result.analysis.metrics.averageDurationMs} ms 平均</strong></header>
          <div>{result.analysis.durationSeries.map((item) => <article key={item.id}><span>{item.id.replace('run-', '#')}</span><i><b className={item.status} style={{ width: `${item.durationMs / maxDuration * 100}%` }} /></i><strong>{item.durationMs} ms</strong></article>)}</div>
        </section>
        <section className="auto-surface auto-types">
          <header><span>节点构成</span><strong>六类受控能力</strong></header>
          <div>{result.analysis.nodeTypeCounts.map((item) => <article key={item.id}><i className={item.id} /><span>{item.label}</span><strong>{item.count}</strong></article>)}</div>
        </section>
        <section className="auto-surface auto-templates">
          <header><div><span>标准流程模板</span><strong>从已知结构快速创建</strong></div><small>创建副本后再修改</small></header>
          <div>{result.workspace.templates.map(({ id, workflow: item }) => <article key={id}><Sparkles /><span><strong>{item.name}</strong><small>{item.description}</small></span><b>{item.nodes.length} 节点</b><Button size="sm" variant="outline" onClick={() => void execute('apply-template', { templateId: id })}>创建副本</Button></article>)}</div>
        </section>
        <section className="auto-surface auto-recent">
          <header><span>最近运行</span><button onClick={() => setView('runs')}>查看追踪</button></header>
          <div>{result.workspace.runs.slice(0, 5).map((run) => <button key={run.id} onClick={() => { setSelectedRunId(run.id); setView('runs'); }}><i className={run.status} /><span><strong>{run.id}</strong><small>{run.createdAt.slice(0, 19).replace('T', ' ')}</small></span><b>{statusLabel(run.status)}</b><em>{run.durationMs} ms</em></button>)}</div>
        </section>
      </div>}

      {view === 'designer' && <div className="auto-view auto-designer">
        <aside className="auto-surface auto-workflow-rail">
          <header><WorkflowIcon /><span>研究流程</span><strong>{result.workspace.workflows.length}</strong></header>
          <nav>{result.workspace.workflows.map((item) => <button className={item.id === workflow.id ? 'active' : ''} key={item.id} onClick={() => void execute('select-workflow', { workflowId: item.id })}><strong>{item.name}</strong><small>{item.nodes.length} 节点 · {item.schedule.expression}</small></button>)}</nav>
          <footer>{result.workspace.templates.map((item) => <button key={item.id} onClick={() => void execute('apply-template', { templateId: item.id })}><Plus />{item.workflow.name}</button>)}</footer>
        </aside>
        <section className="auto-surface auto-canvas-shell">
          <header><div><span>节点依赖画布</span><strong>{workflow.nodes.length} 节点 · {result.analysis.graph.edges.length} 条依赖</strong></div><div><NativeSelect aria-label="新增节点类型" value={newNodeType} onChange={(event) => setNewNodeType(event.target.value as NodeType)}>{nodeTypes.map(([id, label]) => <NativeSelectOption value={id} key={id}>{label}</NativeSelectOption>)}</NativeSelect><Input aria-label="新增节点名称" value={newNodeName} onChange={(event) => setNewNodeName(event.target.value)} /><Button size="sm" onClick={() => void execute('add-node', { type: newNodeType, name: newNodeName, dependsOn: workflow.nodes.length ? [workflow.nodes.at(-1)?.id] : [] })}><Plus />添加</Button></div></header>
          <div className="auto-canvas">
            <svg viewBox="0 0 1120 310" aria-label="研究自动化节点依赖图">{result.analysis.graph.edges.map((edge) => { const source = nodeById.get(edge.source); const target = nodeById.get(edge.target); return source && target ? <g key={edge.id}><path d={`M${source.position.x + 135} ${source.position.y + 43} C${source.position.x + 155} ${source.position.y + 43}, ${target.position.x - 20} ${target.position.y + 43}, ${target.position.x} ${target.position.y + 43}`} /><circle cx={target.position.x} cy={target.position.y + 43} r="3" /></g> : null; })}</svg>
            {workflow.nodes.map((node, index) => <button key={node.id} className={`auto-node ${node.type} ${node.id === selectedNode.id ? 'selected' : ''} ${node.enabled ? '' : 'disabled'}`} style={{ left: node.position.x, top: node.position.y }} onClick={() => updateLocal((draft) => { draft.workspace.selectedNodeId = node.id; })}><b>{String(index + 1).padStart(2, '0')}</b><span>{typeLabel(node.type)}</span><strong>{node.name}</strong><small>{node.dependsOn.length ? `依赖 ${node.dependsOn.length} 项` : '流程起点'}</small></button>)}
          </div>
        </section>
        <aside className="auto-surface auto-inspector">
          <header><Settings2 /><div><span>节点配置</span><strong>{selectedNode.name}</strong></div></header>
          <div className="auto-field"><span>节点名称</span><Input aria-label="节点名称" value={selectedNode.name} onChange={(event) => updateLocal((draft) => { const node = draft.workspace.workflows.find((item) => item.id === workflow.id)?.nodes.find((item) => item.id === selectedNode.id); if (node) node.name = event.target.value; })} /></div>
          <div className="auto-field"><span>配置摘要</span><textarea aria-label="配置摘要" value={selectedNodeSummary} onChange={(event) => updateLocal((draft) => { const node = draft.workspace.workflows.find((item) => item.id === workflow.id)?.nodes.find((item) => item.id === selectedNode.id); if (node) node.config.summary = event.target.value; })} /></div>
          <div className="auto-field"><span>前置依赖</span><NativeSelect aria-label="前置依赖" value={selectedNode.dependsOn[0] || ''} onChange={(event) => updateLocal((draft) => { const node = draft.workspace.workflows.find((item) => item.id === workflow.id)?.nodes.find((item) => item.id === selectedNode.id); if (node) node.dependsOn = event.target.value ? [event.target.value] : []; })}><NativeSelectOption value="">无依赖</NativeSelectOption>{workflow.nodes.filter((item) => item.id !== selectedNode.id).map((item) => <NativeSelectOption value={item.id} key={item.id}>{item.name}</NativeSelectOption>)}</NativeSelect></div>
          <div className="auto-inspector-row"><div className="auto-field"><span>最大尝试</span><Input aria-label="最大尝试" type="number" min="1" max="5" value={selectedNode.retryPolicy.maxAttempts} onChange={(event) => updateLocal((draft) => { const node = draft.workspace.workflows.find((item) => item.id === workflow.id)?.nodes.find((item) => item.id === selectedNode.id); if (node) node.retryPolicy.maxAttempts = Number(event.target.value); })} /></div><button className={selectedNode.enabled ? 'active' : ''} onClick={() => updateLocal((draft) => { const node = draft.workspace.workflows.find((item) => item.id === workflow.id)?.nodes.find((item) => item.id === selectedNode.id); if (node) node.enabled = !node.enabled; })}>{selectedNode.enabled ? '节点已启用' : '节点已停用'}</button></div>
          <footer><Button size="sm" variant="outline" onClick={() => void execute('delete-node', { nodeId: selectedNode.id })}><Trash2 />删除</Button><Button size="sm" onClick={() => void execute('update-node', { nodeId: selectedNode.id, name: selectedNode.name, enabled: selectedNode.enabled, dependsOn: selectedNode.dependsOn, config: selectedNode.config, maxAttempts: selectedNode.retryPolicy.maxAttempts, approvalRequired: selectedNode.approvalRequired })}><Save />保存节点</Button></footer>
        </aside>
      </div>}

      {view === 'settings' && <div className="auto-view auto-settings">
        <section className="auto-surface auto-workflow-form">
          <header><Settings2 /><div><span>流程基础配置</span><strong>{workflow.name}</strong></div><Button size="sm" onClick={() => void execute('update-workflow', { name: workflow.name, description: workflow.description, retries: workflow.retries, timeoutSeconds: workflow.timeoutSeconds, concurrencyPolicy: workflow.concurrencyPolicy, schedule: workflow.schedule })}><Save />保存配置</Button></header>
          <div><div className="auto-field"><span>流程名称</span><Input aria-label="流程名称" value={workflow.name} onChange={(event) => updateLocal((draft) => { const item = draft.workspace.workflows.find((entry) => entry.id === workflow.id); if (item) item.name = event.target.value; })} /></div><div className="auto-field"><span>失败重试次数</span><Input aria-label="失败重试次数" type="number" min="0" max="5" value={workflow.retries} onChange={(event) => updateLocal((draft) => { const item = draft.workspace.workflows.find((entry) => entry.id === workflow.id); if (item) item.retries = Number(event.target.value); })} /></div><div className="auto-field"><span>全流程超时（秒）</span><Input aria-label="全流程超时（秒）" type="number" min="30" max="7200" value={workflow.timeoutSeconds} onChange={(event) => updateLocal((draft) => { const item = draft.workspace.workflows.find((entry) => entry.id === workflow.id); if (item) item.timeoutSeconds = Number(event.target.value); })} /></div><div className="auto-field"><span>并发策略</span><NativeSelect aria-label="并发策略" value={workflow.concurrencyPolicy} onChange={(event) => updateLocal((draft) => { const item = draft.workspace.workflows.find((entry) => entry.id === workflow.id); if (item) item.concurrencyPolicy = event.target.value; })}><NativeSelectOption value="forbid-overlap">禁止重叠</NativeSelectOption><NativeSelectOption value="queue-one">排队一个</NativeSelectOption><NativeSelectOption value="cancel-previous">取消前次</NativeSelectOption></NativeSelect></div><div className="auto-field wide"><span>流程说明</span><textarea aria-label="流程说明" value={workflow.description} onChange={(event) => updateLocal((draft) => { const item = draft.workspace.workflows.find((entry) => entry.id === workflow.id); if (item) item.description = event.target.value; })} /></div></div>
        </section>
        <section className="auto-surface auto-schedule">
          <header><Clock3 /><div><span>计划规则</span><strong>{workflow.schedule.expression}</strong></div><em>尚未接入耐久调度</em></header>
          <div className="auto-field"><span>计划表达</span><Input aria-label="计划表达" value={workflow.schedule.expression} onChange={(event) => updateLocal((draft) => { const item = draft.workspace.workflows.find((entry) => entry.id === workflow.id); if (item) item.schedule.expression = event.target.value; })} /></div><div className="auto-field"><span>时区</span><Input aria-label="时区" value={workflow.schedule.timeZone} onChange={(event) => updateLocal((draft) => { const item = draft.workspace.workflows.find((entry) => entry.id === workflow.id); if (item) item.schedule.timeZone = event.target.value; })} /></div><p><PauseCircle />规则可保存、导入和版本化，但当前不会在后台自动触发；需要接入正式 Temporal 调度器后才能启用。</p>
        </section>
        <section className="auto-surface auto-validation">
          <header><ShieldCheck /><div><span>流程检查</span><strong>{result.analysis.validation.valid ? '依赖与类型检查通过' : '存在阻断问题'}</strong></div><Button size="sm" variant="outline" onClick={() => void execute('validate-workflow')}>重新检查</Button></header>
          <div>{result.analysis.validation.messages.map((item, index) => <article className={item.type} key={`${item.type}-${index}`}>{item.type === 'pass' ? <CheckCircle2 /> : <CircleAlert />}<span>{item.message}</span></article>)}</div>
        </section>
        <section className="auto-surface auto-boundary">
          <header><ShieldCheck /><span>执行边界</span></header>
          <div><article><b>任意代码</b><strong>禁用</strong><span>节点仅执行服务端白名单能力</span></article><article><b>外部连接器</b><strong>未配置</strong><span>不会伪造外部检索或消息</span></article><article><b>预览发布</b><strong>禁止</strong><span>预览产物不能作为正式成果</span></article><article><b>密钥值</b><strong>不保存</strong><span>项目仅保留 SecretRef</span></article></div>
        </section>
      </div>}

      {view === 'variables' && <div className="auto-view auto-variables">
        <section className="auto-surface auto-variable-panel">
          <header><Braces /><div><span>普通流程变量</span><strong>{workflow.variables.length} 项</strong></div></header>
          <form onSubmit={(event) => { event.preventDefault(); void execute('add-variable', { key: variableKey, value: variableValue, secret: false }); setVariableKey(''); setVariableValue(''); }}><Input aria-label="变量名称" placeholder="VARIABLE_NAME" value={variableKey} onChange={(event) => setVariableKey(event.target.value)} required /><Input aria-label="变量值" placeholder="变量值" value={variableValue} onChange={(event) => setVariableValue(event.target.value)} /><Button type="submit"><Plus />添加变量</Button></form>
          <div>{workflow.variables.map((item) => <article key={item.id}><Braces /><span><strong>{item.key}</strong><small>{item.type}</small></span><code>{item.value}</code><button aria-label={`删除 ${item.key}`} onClick={() => void execute('delete-variable', { itemId: item.id })}><Trash2 /></button></article>)}</div>
        </section>
        <section className="auto-surface auto-secret-panel">
          <header><KeyRound /><div><span>密钥引用</span><strong>{workflow.secretRefs.length} 项</strong></div><em>不接收密钥明文</em></header>
          <form onSubmit={(event) => { event.preventDefault(); void execute('add-variable', { key: secretKey || 'NEW_SECRET', secret: true, provider: 'environment', reference: secretReference }); setSecretKey(''); setSecretReference(''); }}><Input aria-label="密钥引用名称" placeholder="SECRET_NAME" value={secretKey} onChange={(event) => setSecretKey(event.target.value)} required /><Input aria-label="密钥引用路径" placeholder="research/provider-key" value={secretReference} onChange={(event) => setSecretReference(event.target.value)} /><Button type="submit"><KeyRound />添加引用</Button></form>
          <div>{workflow.secretRefs.map((item) => <article key={item.id}><KeyRound /><span><strong>{item.key}</strong><small>{item.provider} · {item.reference || '尚未绑定'}</small></span><em className={item.configured ? 'ready' : ''}>{item.configured ? '已配置' : '待绑定'}</em><button aria-label={`删除 ${item.key}`} onClick={() => void execute('delete-variable', { itemId: item.id })}><Trash2 /></button></article>)}</div>
          <p><ShieldCheck />导入流程会清除旧运行历史和敏感值；导出只保留引用元数据，不包含任何凭据内容。</p>
        </section>
      </div>}

      {view === 'runs' && <div className="auto-view auto-runs">
        <aside className="auto-run-list"><header><Activity /><span>运行记录</span><Button size="sm" onClick={() => void execute('run-preview')} disabled={running}><Play />新建预览</Button></header>{result.workspace.runs.map((run) => <button className={run.id === selectedRun.id ? 'active' : ''} key={run.id} onClick={() => setSelectedRunId(run.id)}><i className={run.status} /><span><strong>{run.id}</strong><small>{run.createdAt.slice(0, 19).replace('T', ' ')}</small></span><b>{statusLabel(run.status)}</b><em>{run.durationMs} ms</em></button>)}</aside>
        <section className="auto-surface auto-run-trace">
          <header><div><span>节点级执行轨迹</span><strong>{selectedRun.id} · {statusLabel(selectedRun.status)}</strong></div><small>{selectedRun.mode === 'deterministic-preview' ? '确定性受控预览' : selectedRun.mode}</small></header>
          <div>{selectedRun.stepRuns.map((step, index) => <article className={step.status} key={step.id}><b>{String(index + 1).padStart(2, '0')}</b><i>{step.status === 'succeeded' ? <CheckCircle2 /> : step.status === 'failed' ? <CircleAlert /> : step.status === 'awaiting-approval' ? <TimerReset /> : <PauseCircle />}</i><span><strong>{step.name}</strong><small>{typeLabel(step.type)} · {step.message}</small></span><em>{step.attempts ? `${step.attempts} 次` : '—'}</em><time>{step.durationMs} ms</time>{step.status === 'failed' && <Button size="sm" variant="outline" onClick={() => void execute('retry-step', { runId: selectedRun.id, nodeId: step.nodeId })}><RefreshCw />重试</Button>}</article>)}</div>
        </section>
        <section className="auto-surface auto-log-panel">
          <header><ScrollText /><div><span>结构化日志</span><strong>敏感字段已脱敏</strong></div><small>{result.workspace.logs.filter((item) => item.runId === selectedRun.id).length} 条</small></header>
          <div>{result.workspace.logs.filter((item) => item.runId === selectedRun.id).map((item) => <article className={item.level} key={item.id}><time>{item.createdAt.slice(11, 19)}</time><b>{item.level.toUpperCase()}</b><span>{item.message}</span><em>{item.redacted ? '已脱敏' : '需检查'}</em></article>)}</div>
        </section>
      </div>}

      {view === 'approvals' && <div className="auto-view auto-approvals">
        <section className="auto-surface auto-approval-queue">
          <header><ListChecks /><div><span>人工审批队列</span><strong>{pendingApprovals.length} 项待处理</strong></div></header>
          <div>{pendingApprovals.length ? pendingApprovals.map((approval) => { const run = result.workspace.runs.find((item) => item.id === approval.runId); const node = workflow.nodes.find((item) => item.id === approval.nodeId); return <article key={approval.id}><ListChecks /><span><strong>{node?.name || approval.nodeId}</strong><small>{run?.id} · 创建于 {approval.createdAt.slice(0, 19).replace('T', ' ')}</small></span><Button size="sm" variant="outline" onClick={() => void execute('approve', { runId: approval.runId, decision: 'rejected', note: '需要补充证据' })}>退回</Button><Button size="sm" onClick={() => void execute('approve', { runId: approval.runId, decision: 'approved', note: '人工复核通过' })}>批准并继续</Button></article>; }) : <div className="auto-empty"><CheckCircle2 /><strong>当前没有待审批任务</strong><span>运行到人工复核节点后会在这里暂停。</span></div>}</div>
        </section>
        <section className="auto-surface auto-approval-history">
          <header><Archive /><span>审批记录</span><strong>{result.workspace.approvals.length}</strong></header>
          <div>{result.workspace.approvals.filter((item) => item.status !== 'pending').map((item) => <article key={item.id}><i className={item.status} /><span><strong>{item.decision || statusLabel(item.status)}</strong><small>{item.runId} · {item.actor || '授权用户'}</small></span><time>{(item.decidedAt || item.createdAt).slice(0, 19).replace('T', ' ')}</time></article>)}</div>
        </section>
        <section className="auto-surface auto-recovery">
          <header><TimerReset /><div><span>失败与恢复</span><strong>重试、取消和审批均保留记录</strong></div></header>
          <div>{result.workspace.runs.filter((item) => item.status !== 'succeeded').map((run) => <article key={run.id}><i className={run.status} /><span><strong>{run.id}</strong><small>{run.stepRuns.filter((item) => item.status === 'failed').length} 个失败步骤 · {run.stepRuns.filter((item) => item.status === 'skipped').length} 个跳过步骤</small></span><b>{statusLabel(run.status)}</b>{run.status === 'awaiting-approval' && <Button size="sm" variant="outline" onClick={() => void execute('cancel-run', { runId: run.id })}>取消运行</Button>}</article>)}</div>
        </section>
      </div>}

      {view === 'lineage' && <div className="auto-view auto-lineage">
        <section className="auto-surface auto-artifacts">
          <header><Archive /><div><span>产物清单</span><strong>{result.workspace.artifacts.length} 个可追溯产物</strong></div></header>
          <div className="auto-artifact-head"><b>产物</b><b>来源节点</b><b>运行</b><b>格式</b><b>大小</b><b>校验摘要</b></div>{result.workspace.artifacts.map((artifact) => <article key={artifact.id}><Archive /><span><strong>{artifact.name}</strong><small>{artifact.createdAt.slice(0, 10)}</small></span><b>{workflow.nodes.find((item) => item.id === artifact.nodeId)?.name || artifact.nodeId}</b><em>{artifact.runId}</em><code>{artifact.mediaType}</code><strong>{artifact.size.toLocaleString()} B</strong><small>{artifact.checksum}</small></article>)}
        </section>
        <section className="auto-surface auto-lineage-map">
          <header><GitBranch /><div><span>数据血缘</span><strong>输入、处理、复核与输出</strong></div></header>
          <div>{['文献清单', '主题方法矩阵', '人工复核记录', '研究雷达摘要'].map((label, index) => <article key={label}><b>{String(index + 1).padStart(2, '0')}</b><span><strong>{label}</strong><small>{index === 0 ? '输入数据' : index === 1 ? '分析产物' : index === 2 ? '审批证据' : '最终输出'}</small></span>{index < 3 && <ChevronRight />}</article>)}</div>
          <footer>{result.workspace.lineage.map((item) => <span key={item.id}>{item.from}<ChevronRight />{item.to}<b>{item.relation}</b></span>)}</footer>
        </section>
      </div>}

      {view === 'delivery' && <div className="auto-view auto-delivery">
        <section className="auto-surface auto-version-panel">
          <header><Archive /><div><span>流程版本</span><strong>{currentVersions.length} 个不可变版本</strong></div><Button size="sm" onClick={() => void execute('publish', { label: `发布版本 ${currentVersions.length + 1}` })}><Send />发布版本</Button></header>
          <div>{currentVersions.map((version) => <article key={version.id}><b>v{version.version}</b><span><strong>{version.label}</strong><small>{version.createdAt.slice(0, 19).replace('T', ' ')}</small></span><code>{version.checksum}</code><em>{version.immutable === false ? '可变' : '不可变'}</em></article>)}</div>
        </section>
        <section className="auto-surface auto-export-panel">
          <header><Download /><div><span>流程交付</span><strong>定义、运行、日志、血缘与备份</strong></div></header>
          <div><button onClick={() => downloadText(result.exports.workflowJson, `${workflow.name}.json`, 'application/json;charset=utf-8')}><WorkflowIcon /><span><strong>流程 JSON v1</strong><small>兼容旧卡片版</small></span></button><button onClick={() => downloadText(result.exports.runCsv, '研究自动化运行记录.csv', 'text/csv;charset=utf-8')}><Activity /><span><strong>运行 CSV</strong><small>状态与耗时</small></span></button><button onClick={() => downloadText(result.exports.logsNdjson, '研究自动化日志.ndjson', 'application/x-ndjson;charset=utf-8')}><ScrollText /><span><strong>日志 NDJSON</strong><small>逐行结构化记录</small></span></button><button onClick={() => downloadText(result.exports.lineageJson, '研究自动化血缘.json', 'application/json;charset=utf-8')}><GitBranch /><span><strong>血缘 JSON</strong><small>产物与来源关系</small></span></button><button onClick={() => downloadText(result.exports.reportMarkdown, '研究自动化运行报告.md')}><Download /><span><strong>运行报告 MD</strong><small>流程与边界摘要</small></span></button><button onClick={() => downloadText(result.exports.backupJson, '研究自动化完整备份.json', 'application/json;charset=utf-8')}><Database /><span><strong>完整备份</strong><small>项目全量状态</small></span></button></div>
        </section>
        <section className="auto-surface auto-runtime">
          <header><Network /><div><span>运行时接入状态</span><strong>当前能力与生产缺口分开呈现</strong></div></header>
          <div><article><ShieldCheck /><span><strong>Go 控制面</strong><small>项目、作业、版本、权限与审计</small></span><b>已接入</b></article><article><ShieldCheck /><span><strong>Python 计算面</strong><small>白名单 DAG 校验与确定性预览</small></span><b>已接入</b></article><article><Clock3 /><span><strong>Temporal 耐久调度</strong><small>计划、恢复、长任务与补偿</small></span><b className="pending">未配置</b></article><article><Network /><span><strong>外部连接器</strong><small>检索、消息、对象存储和运行环境</small></span><b className="pending">未配置</b></article></div>
          <p><CircleAlert />预览运行不会访问外部系统、执行任意程序或自动发布成果；正式模式必须经过独立运行时、权限与恢复演练验收。</p>
        </section>
      </div>}
    </main>
  </div>;
}
