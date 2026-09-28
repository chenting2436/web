'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Archive, Check, Clock3, Download, FolderOpen, LoaderCircle, Play, Plus, RotateCcw, Save, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { getToolDefinition, type ToolAction } from '@/lib/tool-definitions';
import { ApiError } from '@/services/api/client';
import {
  toolApi,
  type ProjectVersion,
  type ToolResult,
  type WorkbenchJob,
  type WorkbenchProject,
  type WorkbenchRun,
} from '@/services/api/tools';

type Draft = { action?: unknown; fields?: unknown };

const resultLabels: Record<string, string> = {
  score: '评分', passed: '是否通过', valid: '是否有效', status: '状态', title: '标题',
  researchQuestion: '研究问题', sections: '章节', next: '下一步', stats: '统计', issues: '问题',
  characters: '字符数', words: '词数', headings: '标题数', citations: '引用数', pixels: '像元数',
  threshold: '阈值', changedPixels: '变化像元', changeRate: '变化率', increased: '增加', decreased: '减少',
  meanDifference: '平均差值', changedIndexes: '变化位置', samples: '采样数', duration: '时长',
  mean: '平均值', standardDeviation: '标准差', peak: '峰值', triggers: '触发事件', deltaTime: '到时差',
  hypocentralKm: '震源距离（km）', vpVs: 'Vp/Vs', npv: '净现值', cashflows: '现金流', claims: '权利要求数',
  features: '技术特征数', coverageRate: '覆盖率', uncoveredFeatures: '未覆盖特征', metadata: '元数据',
  findings: '发现', order: '执行顺序', nodes: '节点数', trace: '运行轨迹', finishedAt: '完成时间',
  chunks: '材料分段', topTerms: '高频词', answer: '回答', evidenceCount: '证据数', records: '文献',
  categories: '分类', readiness: '就绪度', rows: '数据行', fields: '字段', schema: '字段类型',
  quality: '质量', output: '输出', peakLag: '峰值延迟', peakCorrelation: '峰值相关系数', correlation: '相关序列',
  maximum: '最大值', average: '平均值', events: '事件', total: '总数', reviewFirst: '优先复核', all: '全部',
  windowSeconds: '窗口（秒）', groups: '对齐分组', rejected: '拒绝数据', incident: '事件', severity: '等级',
  tasks: '任务', unassigned: '未分配', createdAt: '创建时间', exitCode: '退出码', stdout: '标准输出',
  stderr: '错误输出', durationMs: '运行时间（ms）', runtime: '运行环境', sandbox: '运行限制', correct: '正确数',
  percent: '正确率', details: '详情', completed: '已完成', progress: '进度', byStatus: '状态分布',
  duplicates: '重复项', inputRows: '输入行', outputRows: '输出行', audit: '操作记录', csv: 'CSV 结果',
  report: '报告', evidence: '证据', mode: '生成方式', invalid: '无效引用', lines: '代码行', manifest: '文件清单',
  files: '文件数', totalBytes: '总字节数', level: '等级', message: '说明', id: '编号', name: '名称',
  value: '值', index: '位置', time: '时间', ratio: '比值', year: '年份', nominal: '名义金额',
  presentValue: '现值', text: '文本', term: '词语', count: '数量', source: '来源', owner: '负责人',
  priority: '优先级', priorityScore: '优先分', path: '路径', size: '大小', sha256: 'SHA-256',
};

function resultLabel(key: string) {
  return resultLabels[key] ?? key;
}

function initialFields(action: ToolAction) {
  return Object.fromEntries(action.fields.map((field) => [field.key, field.defaultValue ?? '']));
}

function displayValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'object') return JSON.stringify(value) ?? '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return `${value}`;
  return typeof value === 'symbol' ? value.description ?? 'Symbol' : '—';
}

function fieldValue(value: unknown, fallback: string) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return `${value}`;
  return JSON.stringify(value) ?? fallback;
}

function ResultValue({ value }: { value: unknown }) {
  if (Array.isArray(value)) {
    if (!value.length) return <span className="result-empty">暂无</span>;
    const rows = value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
    if (rows.length === value.length) {
      const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row)))).slice(0, 8);
      return (
        <div className="result-table-wrap">
          <table className="result-table">
            <thead><tr>{columns.map((column) => <th key={column}>{resultLabel(column)}</th>)}</tr></thead>
            <tbody>{rows.slice(0, 50).map((row, index) => (
              <tr key={index}>{columns.map((column) => <td key={column}>{displayValue(row[column])}</td>)}</tr>
            ))}</tbody>
          </table>
        </div>
      );
    }
    return <div className="result-list">{value.map((item, index) => <span key={index}>{displayValue(item)}</span>)}</div>;
  }
  if (value && typeof value === 'object') {
    return (
      <dl className="result-object">
        {Object.entries(value as Record<string, unknown>).map(([key, item]) => (
          <div key={key}><dt>{resultLabel(key)}</dt><dd><ResultValue value={item} /></dd></div>
        ))}
      </dl>
    );
  }
  return <span className={typeof value === 'string' && value.includes('\n') ? 'result-pre' : undefined}>{displayValue(value)}</span>;
}

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

const terminalJobStatuses = new Set(['succeeded', 'failed', 'canceled']);

const runStatusLabels: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  succeeded: '完成',
  completed: '完成',
  failed: '失败',
  canceled: '已取消',
};

function wait(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(resolve, milliseconds);
    signal.addEventListener('abort', () => {
      window.clearTimeout(timer);
      reject(new DOMException('Polling aborted', 'AbortError'));
    }, { once: true });
  });
}

async function waitForTerminalJob(id: string, signal: AbortSignal): Promise<WorkbenchJob | null> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const job = await toolApi.getJob(id, signal);
    if (terminalJobStatuses.has(job.status)) return job;
    await wait(1_000, signal);
  }
  return null;
}

export function ToolWorkbench({
  slug,
  title,
  executionAllowed = true,
}: {
  slug: string;
  title: string;
  executionAllowed?: boolean;
}) {
  const definition = getToolDefinition(slug);
  const [actionId, setActionId] = useState(definition?.actions[0]?.id ?? '');
  const action = useMemo(
    () => definition?.actions.find((item) => item.id === actionId) ?? definition?.actions[0],
    [actionId, definition],
  );
  const [fields, setFields] = useState<Record<string, string>>(() => action ? initialFields(action) : {});
  const [result, setResult] = useState<ToolResult | null>(null);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [projects, setProjects] = useState<WorkbenchProject[]>([]);
  const [projectId, setProjectId] = useState('');
  const [projectTitle, setProjectTitle] = useState(`${title}项目`);
  const [versions, setVersions] = useState<ProjectVersion[]>([]);
  const [runs, setRuns] = useState<WorkbenchRun[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [activeJobId, setActiveJobId] = useState('');
  const pollController = useRef<AbortController | null>(null);

  const applySavedState = useCallback((saved: Draft) => {
    if (!definition || typeof saved.action !== 'string' || !saved.fields || typeof saved.fields !== 'object') return;
    const restoredAction = definition.actions.find((item) => item.id === saved.action);
    if (!restoredAction) return;
    setActionId(restoredAction.id);
    setFields(Object.fromEntries(
      restoredAction.fields.map((field) => [field.key, fieldValue((saved.fields as Record<string, unknown>)[field.key], field.defaultValue ?? '')]),
    ));
    if (saved && 'result' in saved && saved.result && typeof saved.result === 'object' && !Array.isArray(saved.result)) {
      setResult(saved.result as ToolResult);
    } else {
      setResult(null);
    }
  }, [definition]);

  const loadProject = useCallback(async (project: WorkbenchProject) => {
    setProjectId(project.id);
    setProjectTitle(project.title);
    applySavedState(project.state);
    const [savedVersions, savedRuns] = await Promise.all([
      toolApi.listVersions(project.id),
      toolApi.listRuns(project.id),
    ]);
    setVersions(savedVersions);
    setRuns(savedRuns);
  }, [applySavedState]);

  useEffect(() => {
    let active = true;
    toolApi.listProjects(slug).then(async (items) => {
      if (!active) return;
      setProjects(items);
      if (items[0]) {
        await loadProject(items[0]);
        if (active) setMessage('已打开最近项目');
      } else {
        const legacy = await toolApi.getState(slug).catch(() => ({}));
        if (active) applySavedState(legacy);
      }
    }).catch((caught) => {
      if (active) setError(caught instanceof Error ? caught.message : '无法读取项目。');
    }).finally(() => {
      if (active) setLoadingProjects(false);
    });
    return () => { active = false; };
  }, [applySavedState, loadProject, slug]);

  useEffect(() => () => pollController.current?.abort(), []);

  if (!definition || !action) return null;

  const chooseAction = (next: ToolAction) => {
    setActionId(next.id);
    setFields(initialFields(next));
    setResult(null);
    setError('');
    setMessage('');
  };

  const currentState = (nextResult: ToolResult | null = result) => ({ action: action.id, fields, result: nextResult });

  const ensureProject = async () => {
    const existing = projects.find((project) => project.id === projectId);
    if (existing) return existing;
    const created = await toolApi.createProject(slug, projectTitle.trim() || `${title}项目`, currentState());
    setProjects((items) => [created, ...items]);
    setProjectId(created.id);
    setProjectTitle(created.title);
    return created;
  };

  const execute = async () => {
    if (!executionAllowed) {
      setError('该运行入口正在按生产安全标准重建，当前不可执行。');
      return;
    }
    setRunning(true);
    setError('');
    setMessage('');
    setResult(null);
    const controller = new AbortController();
    pollController.current?.abort();
    pollController.current = controller;
    try {
      const activeProject = await ensureProject();
      const idempotencyKey = crypto.randomUUID();
      const created = await toolApi.createJob(activeProject.id, slug, action.id, fields, idempotencyKey);
      setActiveJobId(created.job.id);
      setRuns((items) => [created.run, ...items.filter((item) => item.id !== created.run.id)]);
      setMessage('作业已进入后台队列');

      const job = await waitForTerminalJob(created.job.id, controller.signal);
      const latestRuns = await toolApi.listRuns(activeProject.id);
      setRuns(latestRuns);
      if (!job) {
        setMessage('作业仍在后台处理，可稍后重新打开项目查看结果。');
        return;
      }
      if (job.status === 'failed') throw new Error(job.error || '后台作业执行失败。');
      if (job.status === 'canceled') {
        setMessage('作业已取消');
        return;
      }

      const output = job.result;
      setResult(output);
      const saved = await toolApi.updateProject(activeProject.id, projectTitle.trim() || activeProject.title, currentState(output));
      setProjects((items) => [saved, ...items.filter((item) => item.id !== saved.id)]);
      setMessage('后台作业完成，结果和运行记录已保存');
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      const errorMessage = caught instanceof ApiError || caught instanceof Error ? caught.message : '执行失败，请稍后再试。';
      setError(errorMessage);
    } finally {
      if (pollController.current === controller) pollController.current = null;
      setActiveJobId('');
      setRunning(false);
    }
  };

  const cancelActiveJob = async () => {
    if (!activeJobId) return;
    setError('');
    try {
      const canceled = await toolApi.cancelJob(activeJobId);
      pollController.current?.abort();
      if (projectId) setRuns(await toolApi.listRuns(projectId));
      setMessage(canceled.status === 'canceled' ? '作业已取消' : '已提交取消请求');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '取消作业失败。');
    }
  };

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const existing = projects.find((project) => project.id === projectId);
      const saved = existing
        ? await toolApi.updateProject(existing.id, projectTitle.trim() || existing.title, currentState())
        : await toolApi.createProject(slug, projectTitle.trim() || `${title}项目`, currentState());
      setProjects((items) => [saved, ...items.filter((item) => item.id !== saved.id)]);
      setProjectId(saved.id);
      setProjectTitle(saved.title);
      setMessage('项目已保存');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '保存失败。');
    } finally {
      setSaving(false);
    }
  };

  const snapshot = async () => {
    setSaving(true);
    setError('');
    try {
      const project = await ensureProject();
      const label = `版本 ${new Date().toLocaleString('zh-CN')}`;
      const version = await toolApi.createVersion(project.id, label, currentState());
      setVersions((items) => [version, ...items]);
      setMessage('版本已创建');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '创建版本失败。');
    } finally {
      setSaving(false);
    }
  };

  const newProject = () => {
    setProjectId('');
    setProjectTitle(`${title}项目`);
    setActionId(definition.actions[0].id);
    setFields(initialFields(definition.actions[0]));
    setResult(null);
    setRuns([]);
    setVersions([]);
    setMessage('已建立未保存项目');
    setError('');
  };

  const selectProject = async (id: string) => {
    const project = projects.find((item) => item.id === id);
    if (!project) {
      newProject();
      return;
    }
    setError('');
    try {
      await loadProject(project);
      setMessage('项目已切换');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '无法打开项目。');
    }
  };

  const reset = () => {
    setFields(initialFields(action));
    setResult(null);
    setMessage('');
    setError('');
  };

  const downloadResult = () => {
    if (!result) return;
    let blob: Blob;
    let fileName = `${slug}-result.json`;
    if (typeof result.base64 === 'string') {
      const binary = atob(result.base64);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      blob = new Blob([bytes], { type: 'application/zip' });
      fileName = typeof result.fileName === 'string' ? result.fileName : `${slug}.zip`;
    } else {
      blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json;charset=utf-8' });
    }
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="tool-workbench">
      <header className="workbench-commandbar">
        <div className="project-picker">
          <FolderOpen size={17} />
          <NativeSelect value={projectId} onChange={(event) => void selectProject(event.target.value)} disabled={loadingProjects || running}>
            <NativeSelectOption value="">未保存项目</NativeSelectOption>
            {projects.map((project) => <NativeSelectOption key={project.id} value={project.id}>{project.title}</NativeSelectOption>)}
          </NativeSelect>
          <Input aria-label="项目名称" value={projectTitle} onChange={(event) => setProjectTitle(event.target.value)} />
        </div>
        <div className="command-actions">
          <Button variant="ghost" onClick={newProject} disabled={running}><Plus />新建</Button>
          <Button variant="outline" onClick={save} disabled={saving}>{saving ? <LoaderCircle className="spin" /> : <Save />}保存</Button>
          <Button variant="outline" onClick={snapshot} disabled={saving}><Archive />创建版本</Button>
        </div>
      </header>

      <div className="tool-workbench-grid">
        <nav className="tool-module-rail" aria-label="工作台功能">
          <span>功能</span>
          {definition.actions.map((item, index) => (
            <button
              key={item.id}
              type="button"
              aria-current={item.id === action.id ? 'page' : undefined}
              className={item.id === action.id ? 'is-active' : undefined}
              onClick={() => chooseAction(item)}
              disabled={running}
            >
              <b>{String(index + 1).padStart(2, '0')}</b>{item.label}
            </button>
          ))}
          <div className="rail-summary">
            <span>项目</span>
            <strong>{projects.length}</strong>
            <span>版本</span>
            <strong>{versions.length}</strong>
            <span>运行</span>
            <strong>{runs.length}</strong>
          </div>
        </nav>

        <div className="tool-input-panel">
          <header className="tool-panel-heading"><span>当前步骤</span><h2>{action.label}</h2></header>
          <div className="tool-form-grid">
            {action.fields.map((field) => (
              <label className="tool-field" key={field.key}>
                <span>{field.label}</span>
                {field.type === 'textarea' ? (
                  <Textarea
                    value={fields[field.key] ?? ''}
                    placeholder={field.placeholder}
                    onChange={(event) => setFields((current) => ({ ...current, [field.key]: event.target.value }))}
                  />
                ) : field.type === 'select' ? (
                  <NativeSelect
                    className="tool-select"
                    value={fields[field.key] ?? ''}
                    onChange={(event) => setFields((current) => ({ ...current, [field.key]: event.target.value }))}
                  >
                    {field.options?.map((option) => <NativeSelectOption key={option.value} value={option.value}>{option.label}</NativeSelectOption>)}
                  </NativeSelect>
                ) : (
                  <Input
                    type={field.type === 'number' ? 'number' : 'text'}
                    value={fields[field.key] ?? ''}
                    placeholder={field.placeholder}
                    onChange={(event) => setFields((current) => ({ ...current, [field.key]: event.target.value }))}
                  />
                )}
              </label>
            ))}
          </div>

          <div className="tool-actions">
            <Button size="lg" onClick={execute} disabled={running || !executionAllowed}>
              {running ? <LoaderCircle className="spin" /> : <Play />}
              {running ? '处理中' : executionAllowed ? action.submitLabel : '暂未开放'}
            </Button>
            {running && (
              <Button size="lg" variant="outline" onClick={cancelActiveJob} disabled={!activeJobId}>
                <Square />取消作业
              </Button>
            )}
            <Button size="lg" variant="outline" onClick={save} disabled={saving}>
              {saving ? <LoaderCircle className="spin" /> : <Save />}保存项目
            </Button>
            <Button size="lg" variant="ghost" onClick={reset}><RotateCcw />重置</Button>
          </div>
          {message && <p className="tool-message"><Check size={15} />{message}</p>}
          {error && <p className="tool-error" role="alert">{error}</p>}
        </div>

        <section className="tool-result-panel" aria-live="polite">
          <Tabs defaultValue="result" className="workbench-tabs">
            <TabsList variant="line">
              <TabsTrigger value="result">结果</TabsTrigger>
              <TabsTrigger value="runs">运行记录</TabsTrigger>
              <TabsTrigger value="versions">版本</TabsTrigger>
            </TabsList>
            <TabsContent value="result">
              {result ? (
                <>
                  <div className="result-toolbar"><Button variant="outline" onClick={downloadResult}><Download />{typeof result.base64 === 'string' ? '下载压缩包' : '导出 JSON'}</Button></div>
                  <dl className="result-root">
                    {Object.entries(result).filter(([key]) => key !== 'base64').map(([key, value]) => (
                      <div key={key}><dt>{resultLabel(key)}</dt><dd><ResultValue value={value} /></dd></div>
                    ))}
                  </dl>
                </>
              ) : <p className="result-placeholder">填写输入后运行。</p>}
            </TabsContent>
            <TabsContent value="runs">
              <div className="activity-list">
                {runs.map((run) => (
                  <article key={run.id}>
                    <span className={`run-status ${run.status}`}>{runStatusLabels[run.status] ?? run.status}</span>
                    <div><strong>{definition.actions.find((item) => item.id === run.action)?.label ?? run.action}</strong><small><Clock3 />{formatTime(run.createdAt)} · {run.durationMs} ms</small></div>
                  </article>
                ))}
                {!runs.length && <p className="result-placeholder">暂无运行记录。</p>}
              </div>
            </TabsContent>
            <TabsContent value="versions">
              <div className="activity-list">
                {versions.map((version) => (
                  <button className="version-row" key={version.id} type="button" onClick={() => { applySavedState(version.state); setMessage(`已恢复 ${version.label}`); }}>
                    <Archive /><span><strong>{version.label}</strong><small>{formatTime(version.createdAt)}</small></span>
                  </button>
                ))}
                {!versions.length && <p className="result-placeholder">暂无版本。</p>}
              </div>
            </TabsContent>
          </Tabs>
        </section>
      </div>
    </section>
  );
}
