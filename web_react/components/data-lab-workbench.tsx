'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownAZ,
  ArrowUpAZ,
  BarChart3,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Database,
  Download,
  FileArchive,
  FileJson,
  Filter,
  History,
  LockKeyhole,
  Redo2,
  RotateCcw,
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  Table2,
  Undo2,
  Upload,
  WandSparkles,
} from 'lucide-react';
import { useLanguage } from '@/components/language-provider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiError } from '@/services/api/client';
import { toolApi, type WorkbenchJob, type WorkbenchProject } from '@/services/api/tools';

type DataValue = string | number | boolean | null;
type DataRow = Record<string, DataValue> & { _rowId: string };
type Dataset = { fields: string[]; rows: DataRow[]; source: Record<string, string | number> };
type Operation = { id: string; type: string; label: string; column?: string; actor?: string; createdAt?: string };
type ColumnProfile = {
  field: string; type: string; missing: number; completeness: number; unique: number; outliers: number;
  topValues: Array<{ value: string; count: number; ratio: number }>;
  min?: number | null; max?: number | null; mean?: number | null; median?: number | null;
  histogram: Array<{ min: number; max: number; count: number }>;
};
type Project = {
  schema: string; version: number; id: string; name: string; description: string; tags: string[];
  baseDataset: Dataset; dataset: Dataset; operations: Operation[]; cursor: number;
  view: { query: string; facets: Array<{ type: string; column: string; selected?: string[]; min?: number; max?: number }>; sorts: Array<{ column: string; direction: string }>; page: number; pageSize: number };
  selectedColumn: string; snapshots: Array<{ id: string; label: string; cursor: number; createdAt: string; actor: string }>;
  audit: Array<Record<string, string>>; createdAt: string; updatedAt: string;
};
type DataLabResult = {
  schema: string; version: number; stage: string; project: Project;
  analysis: {
    profile: { rows: number; columnCount: number; missingCells: number; duplicateRows: number; qualityScore: number; columns: ColumnProfile[] };
    history: Array<{ step: number; id: string; type: string; label: string; affected: number; errors: number; actor?: string }>;
    view: { total: number; page: number; pageCount: number; pageSize: number; rows: DataRow[] };
    selectedProfile: ColumnProfile; facets: Record<string, Array<{ value: string; count: number }>>;
    aggregation: { groupBy: string; valueColumn: string; method: string; rows: Array<{ group: string; count: number; numericCount: number; sum: number | null; mean: number | null; min: number | null; max: number | null }> };
    charts: { completeness: Array<{ field: string; value: number }>; selectedHistogram: Array<{ min: number; max: number; count: number }>; missingByRow: Array<{ rowId: string; missing: number }> };
    qualityChecks: Array<{ label: string; passed: boolean }>;
  };
  runtime: Record<string, { status?: string; engine?: string } | boolean>;
  exports: { currentCsv: string; allCsv: string; tsv: string; json: string; html: string; xlsxBase64: string; aggregationCsv: string; profileJson: string; operationsJson: string; projectJson: string; packageBase64: string };
};

const views = [
  ['data', '数据表', 'Data grid'],
  ['profile', '字段画像', 'Profiles'],
  ['facets', '分面与统计', 'Facets & stats'],
  ['history', '清洗历史', 'History'],
  ['quality', '质量与交付', 'Quality & delivery'],
] as const;

const operationOptions = [
  ['collapse-whitespace', '整理空白'], ['normalize-missing', '统一缺失值'], ['fill-missing', '填补缺失值'],
  ['transform', '安全表达式'], ['replace', '查找替换'], ['convert-number', '转换为数值'], ['convert-date', '转换为日期'],
  ['deduplicate', '删除重复行'], ['remove-empty-rows', '删除空行'], ['split-column', '拆分字段'],
  ['add-column', '派生新字段'], ['rename-column', '重命名字段'], ['remove-column', '删除字段'],
] as const;

function buildSampleRows(): DataRow[] {
  const regions = ['北区', '南区', '东区', '西区'];
  const hazards = ['滑坡', '崩塌', '泥石流', '地裂缝'];
  const statuses = ['待核验', '处置中', '已完成', ''];
  return Array.from({ length: 36 }, (_, offset) => {
    const index = offset + 1;
    return {
      _rowId: `row-${String(index).padStart(6, '0')}`,
      记录编号: index === 24 ? 'DR-2026-012' : `DR-2026-${String(index).padStart(3, '0')}`,
      区域: regions[offset % 4], 灾害类型: hazards[(index * 3) % 4], 风险等级: ['低', '中', '高', '极高'][(index * 5) % 4],
      隐患点名称: `${regions[offset % 4]}-${['采场', '排土场', '边坡', '沟谷'][index % 4]} ${String(index).padStart(2, '0')}`,
      '位移速率(mm/d)': [7, 19].includes(index) ? null : Number((0.42 + (index % 9) * 0.31 + (index === 31 ? 8.6 : 0)).toFixed(2)),
      '累计降雨(mm)': index === 13 ? null : Number((18 + (index * 13) % 126 + index * 0.37).toFixed(1)),
      监测日期: `2026-${String(8 + Number(index > 23)).padStart(2, '0')}-${String((index % 23) + 1).padStart(2, '0')}`,
      责任单位: ['地测中心', '安监部', '矿山一队', '第三方监测'][offset % 4], 处置状态: statuses[offset % 4],
    };
  });
}

function frontendProfile(fields: string[], rows: DataRow[]): ColumnProfile[] {
  return fields.map((field) => {
    const values = rows.map((row) => row[field]);
    const present = values.filter((value) => value !== null && String(value).trim() !== '');
    const numbers = present.map(Number).filter(Number.isFinite);
    const counts = new Map<string, number>();
    present.forEach((value) => counts.set(String(value), (counts.get(String(value)) ?? 0) + 1));
    return {
      field, type: numbers.length / Math.max(1, present.length) >= 0.9 ? 'number' : /^监测日期$/.test(field) ? 'date' : 'string',
      missing: rows.length - present.length, completeness: Number((present.length / Math.max(1, rows.length) * 100).toFixed(1)), unique: counts.size,
      outliers: field === '位移速率(mm/d)' ? 1 : 0,
      topValues: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([value, count]) => ({ value, count, ratio: count / rows.length })),
      min: numbers.length ? Math.min(...numbers) : null, max: numbers.length ? Math.max(...numbers) : null,
      mean: numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null,
      median: numbers.length ? [...numbers].sort((a, b) => a - b)[Math.floor(numbers.length / 2)] : null,
      histogram: numbers.length ? Array.from({ length: 12 }, (_, index) => ({ min: index, max: index + 1, count: [9, 8, 7, 5, 3, 1, 0, 1, 2, 3, 2, 1][index] })) : [],
    };
  });
}

function sampleResult(): DataLabResult {
  const fields = ['记录编号', '区域', '灾害类型', '风险等级', '隐患点名称', '位移速率(mm/d)', '累计降雨(mm)', '监测日期', '责任单位', '处置状态'];
  const rows = buildSampleRows();
  const columns = frontendProfile(fields, rows);
  const project: Project = {
    schema: 'skyview-data-refine-project', version: 4, id: 'data-project-disaster-ledger', name: '灾害风险台账治理',
    description: '清洗多源巡查与监测台账，保留可复核操作历史并交付标准数据。', tags: ['灾害台账', '质量治理', '教学基准'],
    baseDataset: { fields, rows, source: { fileName: 'disaster-risk-ledger-benchmark.csv', format: 'CSV', bytes: 4892, checksum: 'sha256:skyview-data-refine-benchmark' } },
    dataset: { fields, rows, source: { fileName: 'disaster-risk-ledger-benchmark.csv', format: 'CSV', bytes: 4892, checksum: 'sha256:skyview-data-refine-benchmark' } },
    operations: [
      { id: 'op-001', type: 'collapse-whitespace', column: '责任单位', label: '整理责任单位空白', actor: '数据管理员' },
      { id: 'op-002', type: 'collapse-whitespace', column: '处置状态', label: '整理处置状态空白', actor: '数据管理员' },
      { id: 'op-003', type: 'normalize-missing', column: '累计降雨(mm)', label: '统一缺失值标记', actor: '数据管理员' },
    ], cursor: 3, view: { query: '', facets: [{ type: 'text', column: '风险等级', selected: [] }], sorts: [], page: 1, pageSize: 15 }, selectedColumn: '位移速率(mm/d)',
    snapshots: [{ id: 'snapshot-import', label: '原始导入', cursor: 0, createdAt: '2026-09-12T02:30:00Z', actor: '数据管理员' }], audit: [], createdAt: '2026-09-12T02:30:00Z', updatedAt: '2026-09-12T02:30:00Z',
  };
  return {
    schema: 'skyview-data-refine-results', version: 2, stage: 'load-sample', project,
    analysis: {
      profile: { rows: 36, columnCount: 10, missingCells: 12, duplicateRows: 1, qualityScore: 96.8, columns },
      history: project.operations.map((item, index) => ({ step: index + 1, ...item, affected: [2, 9, 1][index], errors: 0 })),
      view: { total: 36, page: 1, pageCount: 3, pageSize: 15, rows: rows.slice(0, 15) },
      selectedProfile: columns[5], facets: Object.fromEntries(columns.map((column) => [column.field, column.topValues.map(({ value, count }) => ({ value, count }))])),
      aggregation: { groupBy: '区域', valueColumn: '累计降雨(mm)', method: 'count,sum,mean,min,max', rows: ['北区', '南区', '东区', '西区'].map((group) => { const values = rows.filter((row) => row['区域'] === group).map((row) => Number(row['累计降雨(mm)'])).filter(Number.isFinite); return { group, count: rows.filter((row) => row['区域'] === group).length, numericCount: values.length, sum: values.reduce((total, value) => total + value, 0), mean: values.reduce((total, value) => total + value, 0) / Math.max(1, values.length), min: Math.min(...values), max: Math.max(...values) }; }) },
      charts: { completeness: columns.map((column) => ({ field: column.field, value: column.completeness })), selectedHistogram: columns[5].histogram, missingByRow: rows.map((row) => ({ rowId: row._rowId, missing: fields.filter((field) => row[field] === null || row[field] === '').length })) },
      qualityChecks: ['数据规模在安全限制内', '字段名称唯一且非空', '重复行比例低于 5%', '缺失单元格比例低于 10%', '数值异常值均已可定位', '历史游标与操作链一致'].map((label) => ({ label, passed: true })),
    },
    runtime: { pythonEngine: { status: 'enabled' }, goControlPlane: { status: 'enabled' }, browserGrid: { status: 'enabled' }, openRefineServer: { status: 'not-configured' }, reconciliationService: { status: 'not-configured' }, arbitraryCodeExecution: false },
    exports: { currentCsv: '', allCsv: '', tsv: '', json: '', html: '', xlsxBase64: '', aggregationCsv: '', profileJson: '', operationsJson: '', projectJson: '', packageBase64: '' },
  };
}

async function waitForJob(id: string): Promise<WorkbenchJob | null> {
  for (let index = 0; index < 90; index += 1) {
    const job = await toolApi.getJob(id);
    if (['succeeded', 'failed', 'canceled'].includes(job.status)) return job;
    await new Promise((resolve) => window.setTimeout(resolve, 350));
  }
  return null;
}

function downloadText(content: string, name: string, type: string) {
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(new Blob([content], { type }));
  anchor.download = name; anchor.click(); URL.revokeObjectURL(anchor.href);
}

function downloadBase64(content: string, name: string, type: string) {
  const bytes = Uint8Array.from(atob(content), (value) => value.charCodeAt(0));
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(new Blob([bytes], { type }));
  anchor.download = name; anchor.click(); URL.revokeObjectURL(anchor.href);
}

function fileBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result.split(',')[1] ?? '' : '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function shortValue(value: DataValue) {
  if (value === null || value === '') return '—';
  return typeof value === 'number' ? value.toLocaleString('zh-CN', { maximumFractionDigits: 3 }) : String(value);
}

function typeLabel(type: string, text: (zh: string, en: string) => string) {
  return ({ number: text('数值', 'Number'), date: text('日期', 'Date'), boolean: text('布尔', 'Boolean'), blank: text('空值', 'Blank') } as Record<string, string>)[type] ?? text('文本', 'Text');
}

export function DataLabWorkbench({ executionAllowed }: { executionAllowed: boolean }) {
  const { text, locale } = useLanguage();
  const [result, setResult] = useState<DataLabResult>(() => sampleResult());
  const [view, setView] = useState<(typeof views)[number][0]>('data');
  const [projects, setProjects] = useState<WorkbenchProject[]>([]);
  const [projectId, setProjectId] = useState('');
  const [projectTitle, setProjectTitle] = useState('灾害风险台账治理');
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('完整清洗基准已载入，可直接分面、编辑、回退和导出。');
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [operationType, setOperationType] = useState('collapse-whitespace');
  const [operationArgument, setOperationArgument] = useState('');
  const [selectedCell, setSelectedCell] = useState<{ rowId: string; column: string; value: string } | null>(null);
  const importDataInput = useRef<HTMLInputElement>(null);
  const importProjectInput = useRef<HTMLInputElement>(null);

  const dataset = result.project.dataset;
  const profile = result.analysis.profile;
  const selectedProfile = result.analysis.selectedProfile;
  const facetValues = result.analysis.facets[result.project.selectedColumn] ?? [];
  const maxFacet = Math.max(1, ...facetValues.map((item) => item.count));
  const maxHistogram = Math.max(1, ...selectedProfile.histogram.map((item) => item.count));
  const visibleFields = dataset.fields;
  const currentFacet = result.project.view.facets.find((item) => item.column === result.project.selectedColumn);
  const qualityPassed = result.analysis.qualityChecks.filter((item) => item.passed).length;
  const activeRows = result.analysis.view.rows;

  useEffect(() => {
    let active = true;
    toolApi.listProjects('data-lab').then((items) => {
      if (!active) return;
      setProjects(items);
      const first = items[0];
      const saved = first?.state.dataLab as { result?: DataLabResult } | undefined;
      if (first && saved?.result?.schema === 'skyview-data-refine-results') {
        setProjectId(first.id); setProjectTitle(first.title); setResult(saved.result); setQuery(saved.result.project.view.query);
      }
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  const projectState = (next = result) => ({ dataLab: { result: next } });
  const ensureProject = async () => {
    const existing = projects.find((item) => item.id === projectId);
    if (existing) return existing;
    const created = await toolApi.createProject('data-lab', projectTitle, projectState());
    setProjects((items) => [created, ...items]); setProjectId(created.id); return created;
  };
  const storeResult = async (project: WorkbenchProject, output: DataLabResult) => {
    setResult(output); setQuery(output.project.view.query);
    const saved = await toolApi.updateProject(project.id, projectTitle, projectState(output));
    setProjects((items) => [saved, ...items.filter((item) => item.id !== saved.id)]);
  };
  const execute = async (action: string, extra: Record<string, unknown> = {}) => {
    if (!executionAllowed) { setError(text('数据计算服务当前不可用。', 'Data compute service is unavailable.')); return null; }
    setRunning(true); setError(''); setMessage(text('Go 已登记作业，Python 正在重放操作链并刷新画像…', 'Job registered; replaying operations and refreshing profiles…'));
    try {
      const project = await ensureProject();
      const created = await toolApi.createJob(project.id, 'data-lab', action, { state: result, actor: '当前数据管理员', actorRole: 'owner', ...extra }, crypto.randomUUID());
      const job = await waitForJob(created.job.id);
      if (!job) throw new Error(text('作业仍在后台运行。', 'The job is still running.'));
      if (job.status !== 'succeeded') throw new Error(job.error || text('数据作业失败。', 'Data job failed.'));
      const output = job.result as DataLabResult;
      if (output.schema !== 'skyview-data-refine-results') throw new Error(text('服务端结果不兼容。', 'Incompatible result.'));
      await storeResult(project, output);
      setMessage(text('数据、画像、历史与审计已同步。', 'Data, profiles, history and audit synchronized.'));
      return output;
    } catch (caught) {
      setError(caught instanceof ApiError || caught instanceof Error ? caught.message : text('操作失败。', 'Operation failed.')); setMessage(''); return null;
    } finally { setRunning(false); }
  };
  const saveProject = async () => {
    setSaving(true); setError('');
    try {
      const existing = projects.find((item) => item.id === projectId);
      const saved = existing ? await toolApi.updateProject(existing.id, projectTitle, projectState()) : await toolApi.createProject('data-lab', projectTitle, projectState());
      setProjects((items) => [saved, ...items.filter((item) => item.id !== saved.id)]); setProjectId(saved.id);
      setMessage(text('数据项目已保存。', 'Data project saved.'));
    } catch (caught) { setError(caught instanceof Error ? caught.message : text('保存失败。', 'Save failed.')); }
    finally { setSaving(false); }
  };
  const createVersion = async () => {
    try {
      const project = await ensureProject();
      await toolApi.createVersion(project.id, `清洗版本 ${result.project.version} · ${new Date().toLocaleString(locale)}`, projectState());
      await execute('create-snapshot', { label: `清洗快照 ${result.project.version}` });
    } catch (caught) { setError(caught instanceof Error ? caught.message : text('固化版本失败。', 'Snapshot failed.')); }
  };
  const selectStored = (id: string) => {
    setProjectId(id);
    const stored = projects.find((item) => item.id === id);
    if (!stored) { const sample = sampleResult(); setResult(sample); setProjectTitle(sample.project.name); return; }
    const saved = stored.state.dataLab as { result?: DataLabResult } | undefined;
    if (saved?.result?.schema === 'skyview-data-refine-results') { setResult(saved.result); setProjectTitle(stored.title); setQuery(saved.result.project.view.query); }
  };
  const importData = async (file?: File) => {
    if (!file) return;
    if (file.size > 4_000_000) { setError(text('导入文件不能超过 4 MB。', 'Import must not exceed 4 MB.')); return; }
    await execute('import-data', { fileName: file.name, contentBase64: await fileBase64(file) });
    if (importDataInput.current) importDataInput.current.value = '';
  };
  const importProject = async (file?: File) => {
    if (!file) return;
    if (file.size > 4_000_000) { setError(text('项目包不能超过 4 MB。', 'Project package must not exceed 4 MB.')); return; }
    await execute('import-project', { fileName: file.name, contentBase64: await fileBase64(file) });
    if (importProjectInput.current) importProjectInput.current.value = '';
  };
  const selectColumn = async (column: string) => {
    setSelectedCell(null);
    await execute('set-view', { selectedColumn: column });
  };
  const setTextFacet = async (value: string) => {
    const normalized = value === '(空值)' ? '' : value;
    const selected = currentFacet?.selected?.includes(normalized) ? [] : [normalized];
    await execute('set-facet', { facet: { type: 'text', column: result.project.selectedColumn, selected } });
  };
  const runOperation = async () => {
    const operation: Record<string, unknown> = { type: operationType, column: result.project.selectedColumn, label: operationOptions.find(([id]) => id === operationType)?.[1] };
    if (operationType === 'transform') operation.expression = operationArgument || 'value.trim()';
    if (operationType === 'replace') { operation.find = operationArgument.split('→')[0] ?? ''; operation.replacement = operationArgument.split('→')[1] ?? ''; }
    if (operationType === 'fill-missing') operation.strategy = operationArgument || 'median';
    if (operationType === 'split-column') { operation.separator = operationArgument || ','; operation.maxParts = 2; }
    if (operationType === 'add-column') { operation.name = `${result.project.selectedColumn} 派生`; operation.expression = operationArgument || 'value.trim()'; }
    if (operationType === 'rename-column') operation.name = operationArgument || `${result.project.selectedColumn}（整理）`;
    if (operationType === 'deduplicate') operation.columns = [result.project.selectedColumn];
    await execute('apply-operation', { operation });
  };
  const editCell = async () => {
    if (!selectedCell) return;
    await execute('edit-cell', { rowId: selectedCell.rowId, column: selectedCell.column, value: selectedCell.value }); setSelectedCell(null);
  };
  const exportArtifact = async (kind: keyof DataLabResult['exports'], name: string, mime: string, base64Output = false) => {
    const output = await execute('export'); const content = output?.exports[kind]; if (!content) return;
    if (base64Output) downloadBase64(content, name, mime); else downloadText(content, name, mime);
  };

  const metrics = [
    [text('当前行', 'Current rows'), result.analysis.view.total], [text('字段', 'Columns'), profile.columnCount],
    [text('缺失单元格', 'Missing cells'), profile.missingCells], [text('重复行', 'Duplicates'), profile.duplicateRows],
    [text('历史位置', 'History'), `${result.project.cursor}/${result.project.operations.length}`], [text('质量分', 'Quality'), profile.qualityScore],
  ];
  const operationHint = useMemo(() => ({
    transform: 'value.trim()', replace: '旧值→新值', 'fill-missing': 'median', 'split-column': ',', 'add-column': 'value.trim()', 'rename-column': '新字段名',
  } as Record<string, string>)[operationType] ?? '', [operationType]);

  return (
    <section className="refinex-shell" aria-label={text('数据清洗工作台', 'Data refinement workbench')}>
      <header className="refinex-commandbar">
        <div className="refinex-brand"><span><Database /></span><div><strong>{text('数据清洗工作台', 'Data refinement workbench')}</strong><small>{text('项目 · 分面 · 历史 · 交付', 'Projects · facets · history · delivery')}</small></div></div>
        <select aria-label={text('已保存项目', 'Saved projects')} value={projectId} onChange={(event) => selectStored(event.target.value)}>
          <option value="">{text('当前基准项目', 'Current benchmark')}</option>{projects.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select>
        <Input aria-label={text('项目名称', 'Project title')} value={projectTitle} onChange={(event) => setProjectTitle(event.target.value)} />
        <input ref={importDataInput} hidden type="file" accept=".csv,.tsv,.txt,.json,.xml,.xlsx" onChange={(event) => void importData(event.target.files?.[0])} />
        <input ref={importProjectInput} hidden type="file" accept=".json,.zip,application/json,application/zip" onChange={(event) => void importProject(event.target.files?.[0])} />
        <Button variant="outline" onClick={() => importDataInput.current?.click()}><Upload />{text('导入数据', 'Import data')}</Button>
        <Button variant="outline" disabled={saving} onClick={() => void saveProject()}><Save />{saving ? text('保存中', 'Saving') : text('保存', 'Save')}</Button>
        <Button variant="outline" disabled={running} onClick={() => void createVersion()}><LockKeyhole />{text('固化版本', 'Snapshot')}</Button>
        <Button disabled={running} onClick={() => void execute('validate')}>{running ? <RotateCcw className="refinex-spin" /> : <ShieldCheck />}{text('质量检查', 'Validate')}</Button>
      </header>

      <div className="refinex-metrics">{metrics.map(([label, value]) => <div key={String(label)}><span>{label}</span><strong>{value}</strong></div>)}</div>
      <nav className="refinex-tabs" aria-label={text('数据工作区', 'Data workspace')}>
        {views.map(([id, zh, en]) => <button key={id} type="button" className={view === id ? 'active' : ''} onClick={() => setView(id)}>{text(zh, en)}</button>)}
        <div className={`refinex-status ${error ? 'error' : ''}`}>{error ? <CircleAlert /> : <CheckCircle2 />}{error || message}</div>
      </nav>

      <div className="refinex-content">
        {view === 'data' && (
          <div className="refinex-data-view">
            <aside className="refinex-panel refinex-facet-rail">
              <div className="refinex-panel-head"><div><strong>{text('分面筛选', 'Facet filters')}</strong><small>{text('基于当前字段探索分布', 'Explore selected column')}</small></div><button type="button" aria-label={text('清除全部分面', 'Clear all facets')} onClick={() => void execute('clear-facets')}><RotateCcw /></button></div>
              <label className="refinex-search"><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void execute('set-view', { query, page: 1 }); }} placeholder={text('搜索全部字段', 'Search all columns')} /><button type="button" onClick={() => void execute('set-view', { query, page: 1 })}>{text('筛选', 'Filter')}</button></label>
              <div className="refinex-column-select"><span>{text('当前字段', 'Selected column')}</span><select value={result.project.selectedColumn} onChange={(event) => void selectColumn(event.target.value)}>{dataset.fields.map((field) => <option key={field}>{field}</option>)}</select></div>
              <div className="refinex-profile-mini"><b>{typeLabel(selectedProfile.type, text)}</b><span>{selectedProfile.unique} {text('个唯一值', 'unique')}</span><span>{selectedProfile.missing} {text('个缺失', 'missing')}</span></div>
              <div className="refinex-facet-list">{facetValues.map((item) => {
                const selected = currentFacet?.selected?.includes(item.value === '(空值)' ? '' : item.value);
                return <button type="button" key={item.value} className={selected ? 'active' : ''} onClick={() => void setTextFacet(item.value)}><span><i style={{ width: `${Math.max(6, item.count / maxFacet * 100)}%` }} />{item.value || text('(空值)', '(blank)')}</span><b>{item.count}</b></button>;
              })}</div>
            </aside>

            <section className="refinex-panel refinex-grid-panel">
              <div className="refinex-grid-toolbar"><div><strong>{text('当前数据视图', 'Current data view')}</strong><span>{result.analysis.view.total} / {profile.rows} {text('行', 'rows')}</span></div><div><button type="button" onClick={() => void execute('undo')} disabled={result.project.cursor === 0}><Undo2 />{text('撤销', 'Undo')}</button><button type="button" onClick={() => void execute('redo')} disabled={result.project.cursor >= result.project.operations.length}><Redo2 />{text('重做', 'Redo')}</button><button type="button" onClick={() => void execute('set-sort', { column: result.project.selectedColumn, direction: 'asc' })}><ArrowDownAZ />{text('升序', 'Asc')}</button><button type="button" onClick={() => void execute('set-sort', { column: result.project.selectedColumn, direction: 'desc' })}><ArrowUpAZ />{text('降序', 'Desc')}</button></div></div>
              <div className="refinex-table-wrap"><table><thead><tr><th className="row-number">#</th>{visibleFields.map((field) => <th key={field} className={field === result.project.selectedColumn ? 'selected' : ''}><button type="button" aria-label={`${text('选择字段', 'Select column')} ${field}`} onClick={() => void selectColumn(field)}><span>{field}</span><small>{typeLabel(profile.columns.find((item) => item.field === field)?.type ?? 'string', text)}</small></button></th>)}</tr></thead><tbody>{activeRows.map((row, rowIndex) => <tr key={row._rowId}><td className="row-number">{(result.analysis.view.page - 1) * result.analysis.view.pageSize + rowIndex + 1}</td>{visibleFields.map((field) => <td key={field} className={`${field === result.project.selectedColumn ? 'selected' : ''} ${row[field] === null || row[field] === '' ? 'missing' : ''}`}><button type="button" aria-label={`${text('编辑', 'Edit')} ${field}: ${shortValue(row[field])}`} title={shortValue(row[field])} onClick={() => { void selectColumn(field); setSelectedCell({ rowId: row._rowId, column: field, value: row[field] === null ? '' : String(row[field]) }); }}>{shortValue(row[field])}</button></td>)}</tr>)}</tbody></table></div>
              <footer className="refinex-pager"><span>{text('每页', 'Per page')} {result.analysis.view.pageSize} · {text('第', 'Page')} {result.analysis.view.page}/{result.analysis.view.pageCount}</span><div><button type="button" aria-label={text('上一页', 'Previous page')} disabled={result.analysis.view.page <= 1} onClick={() => void execute('set-view', { page: result.analysis.view.page - 1 })}><ChevronLeft /></button><button type="button" aria-label={text('下一页', 'Next page')} disabled={result.analysis.view.page >= result.analysis.view.pageCount} onClick={() => void execute('set-view', { page: result.analysis.view.page + 1 })}><ChevronRight /></button></div></footer>
            </section>

            <aside className="refinex-panel refinex-operation-panel">
              <div className="refinex-panel-head"><div><strong>{text('字段操作', 'Column operations')}</strong><small>{result.project.selectedColumn}</small></div><WandSparkles /></div>
              <div className="refinex-column-score"><span><b>{selectedProfile.completeness}%</b>{text('完整度', 'complete')}</span><span><b>{selectedProfile.unique}</b>{text('唯一值', 'unique')}</span><span><b>{selectedProfile.outliers}</b>{text('异常值', 'outliers')}</span></div>
              {selectedCell && <div className="refinex-cell-editor"><label>{text('编辑单元格', 'Edit cell')}<small>{selectedCell.column} · {selectedCell.rowId}</small></label><Input value={selectedCell.value} onChange={(event) => setSelectedCell({ ...selectedCell, value: event.target.value })} /><div><Button size="sm" onClick={() => void editCell()}>{text('保存单元格', 'Save cell')}</Button><button type="button" onClick={() => setSelectedCell(null)}>{text('取消', 'Cancel')}</button></div></div>}
              <div className="refinex-operation-form"><label>{text('清洗动作', 'Operation')}<select value={operationType} onChange={(event) => { setOperationType(event.target.value); setOperationArgument(''); }}>{operationOptions.map(([id, label]) => <option value={id} key={id}>{text(label, id)}</option>)}</select></label>{operationHint && <label>{text('参数', 'Argument')}<Input value={operationArgument} onChange={(event) => setOperationArgument(event.target.value)} placeholder={operationHint} /></label>}<Button onClick={() => void runOperation()} disabled={running}><Sparkles />{text('应用并记录历史', 'Apply and record')}</Button></div>
              <div className="refinex-quick-ops"><strong>{text('常用操作', 'Quick actions')}</strong>{operationOptions.slice(0, 7).map(([id, label]) => <button type="button" key={id} onClick={() => setOperationType(id)} className={operationType === id ? 'active' : ''}>{text(label, id)}</button>)}</div>
            </aside>
          </div>
        )}

        {view === 'profile' && (
          <div className="refinex-profile-view">
            <section className="refinex-panel refinex-profile-cards"><div className="refinex-view-head"><div><strong>{text('字段画像', 'Column profiles')}</strong><small>{text('类型、缺失、基数与异常值同步计算', 'Types, missingness, cardinality and outliers')}</small></div><b>{profile.columnCount} {text('字段', 'columns')}</b></div><div>{profile.columns.map((column) => <button type="button" key={column.field} className={column.field === result.project.selectedColumn ? 'active' : ''} onClick={() => void selectColumn(column.field)}><span><strong>{column.field}</strong><small>{typeLabel(column.type, text)} · {column.unique} {text('唯一值', 'unique')}</small></span><b>{column.completeness}%</b><i><em style={{ width: `${column.completeness}%` }} /></i><small>{column.missing} {text('缺失', 'missing')} · {column.outliers} {text('异常', 'outliers')}</small></button>)}</div></section>
            <section className="refinex-panel refinex-profile-detail"><div className="refinex-view-head"><div><strong>{selectedProfile.field}</strong><small>{text('统计摘要与数值分布', 'Summary and distribution')}</small></div><b>{typeLabel(selectedProfile.type, text)}</b></div><div className="refinex-stat-grid"><span><small>{text('最小值', 'Minimum')}</small><b>{selectedProfile.min ?? '—'}</b></span><span><small>{text('最大值', 'Maximum')}</small><b>{selectedProfile.max ?? '—'}</b></span><span><small>{text('平均值', 'Mean')}</small><b>{selectedProfile.mean?.toFixed(2) ?? '—'}</b></span><span><small>{text('中位数', 'Median')}</small><b>{selectedProfile.median ?? '—'}</b></span></div><div className="refinex-histogram">{selectedProfile.histogram.length ? selectedProfile.histogram.map((item, index) => <i key={`${item.min}-${index}`} style={{ height: `${Math.max(5, item.count / maxHistogram * 100)}%` }} title={`${item.min}–${item.max}: ${item.count}`} />) : <p>{text('文本字段使用频次分布', 'Text fields use frequency distribution')}</p>}</div><div className="refinex-top-values">{selectedProfile.topValues.slice(0, 8).map((item) => <span key={item.value}><b>{item.value || text('(空值)', '(blank)')}</b><i><em style={{ width: `${Math.max(4, item.ratio * 100)}%` }} /></i><small>{item.count}</small></span>)}</div></section>
          </div>
        )}

        {view === 'facets' && (
          <div className="refinex-analysis-view">
            <section className="refinex-panel refinex-completeness"><div className="refinex-view-head"><div><strong>{text('字段完整度', 'Column completeness')}</strong><small>{text('定位缺失集中字段', 'Locate missingness hotspots')}</small></div><BarChart3 /></div><div>{result.analysis.charts.completeness.map((item) => <article key={item.field}><span><b>{item.field}</b><small>{item.value}%</small></span><i><em style={{ width: `${item.value}%` }} /></i></article>)}</div></section>
            <section className="refinex-panel refinex-cross-facets"><div className="refinex-view-head"><div><strong>{text('字段分面矩阵', 'Facet matrix')}</strong><small>{text('选择字段后可立即筛选当前数据视图', 'Choose a column to filter the current view')}</small></div><Filter /></div><div>{dataset.fields.slice(0, 8).map((field) => <article key={field}><button type="button" onClick={() => void selectColumn(field)}><b>{field}</b><small>{profile.columns.find((item) => item.field === field)?.unique} {text('类', 'values')}</small></button><div>{(result.analysis.facets[field] ?? []).slice(0, 5).map((item) => <span key={item.value}>{item.value || text('(空值)', '(blank)')}<b>{item.count}</b></span>)}</div></article>)}</div></section>
            <section className="refinex-panel refinex-aggregation"><div className="refinex-view-head"><div><strong>{text('分组聚合', 'Grouped aggregation')}</strong><small>{result.analysis.aggregation.groupBy} × {result.analysis.aggregation.valueColumn || text('记录数', 'row count')}</small></div><button type="button" onClick={() => void exportArtifact('aggregationCsv', 'aggregation.csv', 'text/csv')}><Download />CSV</button></div><div>{result.analysis.aggregation.rows.map((item) => <article key={item.group}><span><b>{item.group}</b><small>{item.count} {text('行', 'rows')}</small></span><i><em style={{ width: `${Math.max(6, item.count / Math.max(1, ...result.analysis.aggregation.rows.map((row) => row.count)) * 100)}%` }} /></i><strong>{item.mean?.toFixed(2) ?? '—'}</strong></article>)}</div></section>
          </div>
        )}

        {view === 'history' && (
          <div className="refinex-history-view">
            <section className="refinex-panel refinex-timeline"><div className="refinex-view-head"><div><strong>{text('无限撤销 / 重做', 'Undo / redo history')}</strong><small>{text('点击任意节点重建当时数据状态', 'Rebuild data at any history cursor')}</small></div><span><Button variant="outline" size="sm" onClick={() => void execute('undo')}><Undo2 />{text('撤销', 'Undo')}</Button><Button variant="outline" size="sm" onClick={() => void execute('redo')}><Redo2 />{text('重做', 'Redo')}</Button></span></div><div className="refinex-history-list"><button type="button" className={result.project.cursor === 0 ? 'active' : ''} onClick={() => void execute('jump-history', { cursor: 0 })}><b>00</b><span><strong>{text('创建项目', 'Create project')}</strong><small>{result.project.baseDataset.rows.length} {text('行原始数据', 'source rows')}</small></span></button>{result.project.operations.map((operation, index) => { const entry = result.analysis.history.find((item) => item.id === operation.id); const enabled = index < result.project.cursor; return <button type="button" key={operation.id} className={`${result.project.cursor === index + 1 ? 'active' : ''} ${enabled ? '' : 'future'}`} onClick={() => void execute('jump-history', { cursor: index + 1 })}><b>{String(index + 1).padStart(2, '0')}</b><span><strong>{operation.label}</strong><small>{operation.actor ?? text('当前用户', 'Current user')} · {entry ? `${entry.affected} ${text('处变化', 'changes')}` : text('已撤销', 'Undone')}</small></span></button>; })}</div></section>
            <aside className="refinex-panel refinex-recipe"><div className="refinex-view-head"><div><strong>{text('配方复用', 'Reusable recipe')}</strong><small>{text('在其他同构数据上重放操作', 'Replay on compatible data')}</small></div><FileJson /></div><pre>{result.exports.operationsJson || JSON.stringify({ schema: 'skyview-openrefine-operations', operations: result.project.operations.slice(0, result.project.cursor) }, null, 2)}</pre><div><Button variant="outline" onClick={() => void exportArtifact('operationsJson', 'data-cleaning-operations.json', 'application/json')}><Download />{text('导出配方', 'Export recipe')}</Button><Button onClick={() => importProjectInput.current?.click()}><Upload />{text('导入项目', 'Import project')}</Button></div><section><strong>{text('命名快照', 'Named snapshots')}</strong>{result.project.snapshots.map((item) => <button type="button" key={item.id} onClick={() => void execute('restore-snapshot', { snapshotId: item.id })}><span>{item.label}<small>{item.actor}</small></span><b>{text('第', 'Step')} {item.cursor} {text('步', '')}</b></button>)}</section></aside>
          </div>
        )}

        {view === 'quality' && (
          <div className="refinex-quality-view">
            <section className="refinex-panel refinex-quality-main"><div className="refinex-quality-score"><span><ShieldCheck /></span><div><small>{text('当前质量分', 'Current quality score')}</small><strong>{profile.qualityScore}</strong><p>{text('质量门禁', 'Quality gates')} {qualityPassed}/{result.analysis.qualityChecks.length}</p></div></div><div className="refinex-quality-list">{result.analysis.qualityChecks.map((item) => <article className={item.passed ? 'passed' : ''} key={item.label}>{item.passed ? <CheckCircle2 /> : <CircleAlert />}<span>{item.label}</span><b>{item.passed ? text('通过', 'Passed') : text('待处理', 'Action')}</b></article>)}</div><div className="refinex-runtime"><strong>{text('运行边界', 'Runtime boundaries')}</strong>{Object.entries(result.runtime).map(([key, item]) => { if (!item || typeof item !== 'object') return null; return <span key={key}><i className={item.status === 'enabled' ? 'enabled' : ''} /><b>{key}</b><small>{item.status === 'enabled' ? text('已连接', 'Connected') : text('未配置', 'Not configured')}</small></span>; })}</div></section>
            <section className="refinex-panel refinex-delivery"><div className="refinex-view-head"><div><strong>{text('成果交付', 'Delivery')}</strong><small>{text('当前视图、全量数据、画像、聚合、配方与完整项目包', 'Current view, full data, profile, aggregation, recipe and project package')}</small></div><FileArchive /></div><div><button type="button" onClick={() => void exportArtifact('currentCsv', 'current-view.csv', 'text/csv')}><Table2 /><span><b>{text('当前视图 CSV', 'Current view CSV')}</b><small>{result.analysis.view.total} {text('行，保留筛选条件', 'rows with filters')}</small></span><Download /></button><button type="button" onClick={() => void exportArtifact('xlsxBase64', 'cleaned-data.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', true)}><Table2 /><span><b>{text('Excel 工作簿', 'Excel workbook')}</b><small>{text('真实 XLSX 文件', 'Real XLSX file')}</small></span><Download /></button><button type="button" onClick={() => void exportArtifact('aggregationCsv', 'aggregation.csv', 'text/csv')}><BarChart3 /><span><b>{text('分组聚合 CSV', 'Aggregation CSV')}</b><small>{result.analysis.aggregation.groupBy} × {result.analysis.aggregation.valueColumn}</small></span><Download /></button><button type="button" onClick={() => void exportArtifact('profileJson', 'data-profile.json', 'application/json')}><BarChart3 /><span><b>{text('字段画像', 'Data profile')}</b><small>{text('类型、缺失、分布与异常值', 'Types, missingness and outliers')}</small></span><Download /></button><button type="button" onClick={() => void exportArtifact('operationsJson', 'cleaning-recipe.json', 'application/json')}><History /><span><b>{text('操作配方', 'Operation recipe')}</b><small>{result.project.cursor} {text('步可重放操作', 'replayable steps')}</small></span><Download /></button><button type="button" className="primary" onClick={() => void exportArtifact('packageBase64', 'data-refine-project.zip', 'application/zip', true)}><FileArchive /><span><b>{text('完整项目交换包', 'Complete project package')}</b><small>{text('原始数据、当前数据、历史、审计与说明', 'Source, current data, history, audit and README')}</small></span><Download /></button></div><p><CircleAlert />{text('完整项目包包含原始数据与历史；涉及敏感数据时请仅导出清洗结果。', 'The complete project package contains source data and history; export only cleaned data when handling sensitive data.')}</p></section>
          </div>
        )}
      </div>
    </section>
  );
}
