'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive, BellRing, BookMarked, Check, CheckCircle2, CircleAlert, Database,
  Download, ExternalLink, FileDown, FileInput, Filter, FolderKanban, GitMerge,
  Library, LoaderCircle, Play, Radar, RefreshCw, Save, Search,
  Send, Settings2, ShieldCheck, Tags, X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiError } from '@/services/api/client';
import { toolApi, type WorkbenchJob, type WorkbenchProject } from '@/services/api/tools';

type RadarRecord = {
  id: string; title: string; doi: string; year: number; authors: string[]; venue: string;
  abstract: string; topics: string[]; citations: number; references: number;
  openAccess: boolean; url: string; provider: string; providers: string[]; source: string;
  isDemo: boolean; datasetMode: 'demo' | 'live' | 'imported'; verifiedAt: string;
  relevance: number; novelty: number; evidenceGrade: string;
  evidenceProfile: { data: boolean; code: boolean; validation: boolean };
};
type LibraryEntry = { recordId: string; collectionId: string; status: string; priority: string; tags: string[]; note: string };
type RadarWorkspace = {
  id: string; name: string; version: number;
  query: { main: string; must: string; exact: string; exclude: string; startYear: number; endYear: number; sort: string; oaOnly: boolean; providers: string[]; page: number; perPage: number };
  collections: Array<{ id: string; name: string; color: string }>;
  library: LibraryEntry[]; evidenceNotes: { use: string; limitations: string };
  monitors: Array<{ id: string; name: string; query: string; frequency: string; enabled: boolean; lastRunAt: string; lastStatus: string; baselineIds: string[]; newIds: string[]; delivery: string; nextRunAt: string | null }>;
  monitorRuns?: Array<{ id: string; monitorId: string; status: string; startedAt: string; newIds: string[]; notificationStatus: string }>;
  transfer: { selectedIds: string[]; history: Array<{ id: string; destination: string; recordIds: string[]; createdAt: string; status: string }> };
  createdAt: string; updatedAt: string;
};
type RadarResult = {
  schema: 'skyview-research-radar-results'; version: number; stage: string; workspace: RadarWorkspace; records: RadarRecord[];
  analysis: { yearlyTrend: Array<{ year: number; count: number }>; openAccess: { open: number; closed: number; rate: number }; topics: Array<{ name: string; count: number }>; evidenceGrades: Array<{ grade: string; count: number }>; graph: { nodes: Array<{ id: string; label: string; type: string; weight: number }>; edges: Array<{ id: string; source: string; target: string; weight: number }> }; duplicateCount: number; averageRelevance: number; synthesis: string[] };
  sources: Array<{ id: string; name: string; configured: boolean; enabled: boolean; status: string; endpoint: string; timeoutSeconds: number; rateLimit: string; lastCheckedAt: string | null; lastError: string; latencyMs?: number; records?: number }>;
  runtime: { controlPlane: string; computePlane: string; defaultDataMode: string; liveSearchRequiresExplicitAction: boolean; backgroundSchedulerConfigured: boolean; persistentNotificationConfigured: boolean; arbitraryCodeExecution: boolean };
  exports: { bibtex: string; ris: string; libraryCsv: string; alertsMarkdown: string; knowledgeMarkdown: string; knowledgeJson: string; backupJson: string };
  liveSearch?: { requested: boolean; query: string; page: number; providers: string[]; returned: number; fallbackUsed: boolean; message: string };
};

const views = [
  ['overview', '雷达总览'], ['discover', '实时发现'], ['library', '文献库'], ['graph', '主题图谱'],
  ['evidence', '证据矩阵'], ['alerts', '监测任务'], ['transfer', '成果联动'], ['sources', '数据源'],
] as const;
const terminal = new Set(['succeeded', 'failed', 'canceled']);
const wait = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));
const pct = (value: number) => `${(value * 100).toFixed(0)}%`;
const statusLabel: Record<string, string> = { included: '纳入', maybe: '待定', excluded: '排除', high: '高', medium: '中', low: '低', healthy: '正常', failed: '异常', 'not-checked': '待检查', 'not-configured': '未配置', succeeded: '完成' };

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
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = fileName;
  document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
}

function sampleRecord(index: number, title: string, year: number, topic: string, citations: number, openAccess: boolean, grade: string): RadarRecord {
  const id = `radar-${String(index).padStart(2, '0')}`;
  const doi = `10.9000/skyview.radar.${String(index).padStart(2, '0')}`;
  return { id, title, doi, year, authors: index % 2 ? ['陈星', '赵岚'] : ['李峻', '周宁'], venue: '地球科学研究方法', abstract: `围绕${topic}构建可复核的方法、数据与验证链路，并报告来源和局限。`, topics: [topic, index % 3 === 0 ? '可复现研究' : '证据综合'], citations, references: 28 + index * 2, openAccess, url: `https://doi.org/${doi}`, provider: 'demo', providers: ['demo'], source: '离线基准', isDemo: true, datasetMode: 'demo', verifiedAt: '2026-09-09T00:00:00Z', relevance: Math.max(.55, .96 - index * .025), novelty: .62 + (index % 5) * .06, evidenceGrade: grade, evidenceProfile: { data: index % 3 !== 1, code: index % 4 === 0, validation: index % 2 === 0 } };
}

function createBenchmarkResult(): RadarResult {
  const rows: Array<[string, number, string, number, boolean, string]> = [
    ['背景噪声层析成像的可复现处理链', 2026, '环境噪声', 48, true, 'A'],
    ['面波频散自动拾取与不确定性评估', 2026, '层析成像', 31, true, 'A'],
    ['多台站连续波形质量控制基准', 2025, '地震监测', 65, false, 'B'],
    ['开放地球物理数据的证据溯源规范', 2025, '开放数据', 76, true, 'A'],
    ['研究证据矩阵在地学综述中的应用', 2024, '证据综合', 89, true, 'B'],
    ['跨来源文献实体消歧与 DOI 去重', 2024, '可复现研究', 54, false, 'B'],
    ['环境噪声互相关的稳定性检验', 2023, '环境噪声', 123, true, 'A'],
    ['稀疏台网条件下的面波反演', 2023, '层析成像', 112, false, 'B'],
    ['地震监测数据质量门禁与审计', 2022, '地震监测', 98, true, 'B'],
    ['科学知识图谱的主题演化分析', 2022, '证据综合', 147, true, 'C'],
    ['科研软件与数据的长期可复现性', 2021, '可复现研究', 205, true, 'A'],
    ['开放获取政策对地学成果传播的影响', 2021, '开放数据', 178, false, 'C'],
  ];
  const records = rows.map((item, index) => sampleRecord(index + 1, ...item));
  const workspace: RadarWorkspace = {
    id: 'radar-research-frontier', name: '地球科学研究前沿', version: 3,
    query: { main: '环境噪声 层析成像 可复现研究', must: '证据', exact: '', exclude: '', startYear: 2021, endYear: 2026, sort: 'relevance', oaOnly: false, providers: ['crossref', 'openalex'], page: 1, perPage: 12 },
    collections: [{ id: 'inbox', name: '待筛选', color: '#3156a6' }, { id: 'core', name: '核心证据', color: '#087f73' }, { id: 'methods', name: '方法与工具', color: '#b56a14' }],
    library: [
      { recordId: 'radar-01', collectionId: 'core', status: 'included', priority: 'high', tags: ['主证据', '方法'], note: '方法链完整，可作为复现基线。' },
      { recordId: 'radar-02', collectionId: 'methods', status: 'included', priority: 'high', tags: ['频散', '不确定性'], note: '补充自动拾取评价。' },
      { recordId: 'radar-04', collectionId: 'core', status: 'maybe', priority: 'medium', tags: ['开放数据'], note: '需核验适用范围。' },
      { recordId: 'radar-07', collectionId: 'methods', status: 'included', priority: 'medium', tags: ['互相关'], note: '用于稳定性讨论。' },
      { recordId: 'radar-11', collectionId: 'core', status: 'included', priority: 'medium', tags: ['可复现'], note: '支撑研究治理部分。' },
    ],
    evidenceNotes: { use: '优先使用 A/B 级、可核验 DOI 与明确验证信息的研究。', limitations: '离线基准仅用于功能校验；正式结论必须重新运行公开来源检索并人工复核。' },
    monitors: [{ id: 'monitor-weekly', name: '环境噪声成像周报', query: 'ambient noise tomography reproducibility', frequency: 'weekly', enabled: true, lastRunAt: '2026-09-09T00:00:00Z', lastStatus: 'succeeded', baselineIds: ['radar-01', 'radar-02', 'radar-07'], newIds: ['radar-01'], delivery: '站内运行记录', nextRunAt: null }],
    transfer: { selectedIds: ['radar-01', 'radar-02', 'radar-04'], history: [] }, createdAt: '2026-09-09T00:00:00Z', updatedAt: '2026-09-09T00:00:00Z',
  };
  const topics = ['环境噪声', '层析成像', '证据综合', '可复现研究', '开放数据', '地震监测'].map((name) => ({ name, count: records.filter((item) => item.topics.includes(name)).length }));
  const nodes = topics.map((item, index) => ({ id: `topic-${index + 1}`, label: item.name, type: 'topic', weight: item.count }));
  records.slice(0, 8).forEach((item) => nodes.push({ id: `record-${item.id}`, label: item.title, type: 'record', weight: 1 }));
  const edges = nodes.slice(1).map((item, index) => ({ id: `edge-${index}`, source: nodes[Math.min(Math.floor(index / 2), 5)].id, target: item.id, weight: 1 + index % 3 }));
  const analysis = { yearlyTrend: [2021, 2022, 2023, 2024, 2025, 2026].map((year) => ({ year, count: records.filter((item) => item.year === year).length })), openAccess: { open: 8, closed: 4, rate: 2 / 3 }, topics, evidenceGrades: ['A', 'B', 'C', 'D'].map((grade) => ({ grade, count: records.filter((item) => item.evidenceGrade === grade).length })), graph: { nodes, edges }, duplicateCount: 0, averageRelevance: .798, synthesis: ['环境噪声与层析成像构成当前主题主线。', '开放获取记录可优先进入全文复核。', '证据等级不替代人工质量评价。'] };
  const sources = [{ id: 'crossref', name: 'Crossref', configured: true, enabled: true, status: 'not-checked', endpoint: 'https://api.crossref.org/works', timeoutSeconds: 12, rateLimit: '公开 API 限额', lastCheckedAt: null, lastError: '' }, { id: 'openalex', name: 'OpenAlex', configured: true, enabled: true, status: 'not-checked', endpoint: 'https://api.openalex.org/works', timeoutSeconds: 12, rateLimit: '公开 API 限额', lastCheckedAt: null, lastError: '' }, { id: 'semantic-scholar', name: 'Semantic Scholar', configured: false, enabled: false, status: 'not-configured', endpoint: '', timeoutSeconds: 12, rateLimit: '需要单独配置', lastCheckedAt: null, lastError: '尚未配置' }];
  const bibtex = records.map((item, index) => `@article{Radar${item.year}${index + 1},\n  title = {${item.title}},\n  year = {${item.year}},\n  doi = {${item.doi}}\n}`).join('\n\n');
  const ris = records.map((item) => `TY  - JOUR\nTI  - ${item.title}\nPY  - ${item.year}\nDO  - ${item.doi}\nER  - `).join('\n\n');
  const libraryCsv = `记录ID,标题,年份,DOI,来源\n${records.map((item) => `${item.id},${item.title},${item.year},${item.doi},${item.source}`).join('\n')}`;
  const knowledgeMarkdown = `# 研究雷达证据包\n\n${records.slice(0, 3).map((item) => `## ${item.title}\n\n${item.abstract}`).join('\n\n')}`;
  return { schema: 'skyview-research-radar-results', version: 2, stage: 'run-all', workspace, records, analysis, sources, runtime: { controlPlane: 'Go 项目、作业、版本、权限与审计', computePlane: 'Python 文献适配、去重、分析与导出', defaultDataMode: 'demo', liveSearchRequiresExplicitAction: true, backgroundSchedulerConfigured: false, persistentNotificationConfigured: false, arbitraryCodeExecution: false }, exports: { bibtex, ris, libraryCsv, alertsMarkdown: '# 科研雷达监测任务\n\n- 环境噪声成像周报：完成', knowledgeMarkdown, knowledgeJson: JSON.stringify({ schema: 'skyview-radar-evidence-transfer', records: records.slice(0, 3) }, null, 2), backupJson: JSON.stringify({ schema: 'skyview-research-radar-backup', version: 2, workspace, records, sources, analysis }, null, 2) } };
}

function MiniTrend({ values }: { values: Array<{ year: number; count: number }> }) {
  const max = Math.max(1, ...values.map((item) => item.count));
  const points = values.map((item, index) => `${20 + index * (300 / Math.max(1, values.length - 1))},${105 - item.count / max * 72}`).join(' ');
  return <svg className="rrx-trend" viewBox="0 0 340 126" aria-label="年度文献趋势"><path d="M20 105H325" /><polyline points={points} />{values.map((item, index) => <g key={item.year}><circle cx={20 + index * (300 / Math.max(1, values.length - 1))} cy={105 - item.count / max * 72} r="4" /><text x={20 + index * (300 / Math.max(1, values.length - 1))} y="121">{String(item.year).slice(2)}</text></g>)}</svg>;
}

export function ResearchRadarWorkbench({ executionAllowed = true }: { executionAllowed?: boolean }) {
  const [view, setView] = useState<(typeof views)[number][0]>('overview');
  const [result, setResult] = useState<RadarResult>(() => createBenchmarkResult());
  const [projects, setProjects] = useState<WorkbenchProject[]>([]); const [projectId, setProjectId] = useState('');
  const [projectTitle, setProjectTitle] = useState('地球科学研究前沿项目');
  const [query, setQuery] = useState(result.workspace.query.main); const [filter, setFilter] = useState('');
  const [selectedId, setSelectedId] = useState(result.records[0].id); const [collectionId, setCollectionId] = useState('all');
  const [running, setRunning] = useState(false); const [saving, setSaving] = useState(false); const [message, setMessage] = useState(''); const [error, setError] = useState('');
  const importInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    toolApi.listProjects('research-radar').then((items) => { if (!active) return; setProjects(items); const project = items[0]; const saved = project?.state.researchRadar as { result?: RadarResult } | undefined; if (project && saved?.result?.schema === 'skyview-research-radar-results') { setProjectId(project.id); setProjectTitle(project.title); setResult(saved.result); setQuery(saved.result.workspace.query.main); } }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  const projectState = (next: RadarResult = result) => ({ researchRadar: { result: next } });
  const ensureProject = async () => {
    const existing = projects.find((item) => item.id === projectId); if (existing) return existing;
    const created = await toolApi.createProject('research-radar', projectTitle, projectState()); setProjects((items) => [created, ...items]); setProjectId(created.id); return created;
  };
  const storeResult = async (project: WorkbenchProject, output: RadarResult) => {
    setResult(output); setQuery(output.workspace.query.main); if (!output.records.some((item) => item.id === selectedId)) setSelectedId(output.records[0]?.id ?? '');
    const saved = await toolApi.updateProject(project.id, projectTitle, projectState(output)); setProjects((items) => [saved, ...items.filter((item) => item.id !== saved.id)]);
  };
  const execute = async (action: string, extra: Record<string, unknown> = {}) => {
    if (!executionAllowed) return null; setRunning(true); setError(''); setMessage('Go 已登记作业，Python 正在更新文献、证据与图表…');
    try {
      const project = await ensureProject(); const created = await toolApi.createJob(project.id, 'research-radar', action, { state: { workspace: result.workspace, records: result.records, sources: result.sources }, ...extra }, crypto.randomUUID()); const job = await waitForJob(created.job.id);
      if (!job) throw new Error('作业仍在后台运行，请稍后重试。'); if (job.status === 'failed') throw new Error(job.error || '科研雷达计算失败。'); if (job.status === 'canceled') throw new Error('作业已取消。');
      const output = job.result as RadarResult; if (output.schema !== 'skyview-research-radar-results') throw new Error('服务端返回了不兼容的科研雷达结果。'); await storeResult(project, output);
      setMessage(action === 'search-live' ? output.liveSearch?.message || '公开来源检索完成。' : '科研雷达已更新并保存。'); return output;
    } catch (caught) { setError(caught instanceof ApiError || caught instanceof Error ? caught.message : '操作失败。'); setMessage(''); return null; } finally { setRunning(false); }
  };
  const saveProject = async () => { setSaving(true); setError(''); try { const existing = projects.find((item) => item.id === projectId); const saved = existing ? await toolApi.updateProject(existing.id, projectTitle, projectState()) : await toolApi.createProject('research-radar', projectTitle, projectState()); setProjects((items) => [saved, ...items.filter((item) => item.id !== saved.id)]); setProjectId(saved.id); setMessage('科研雷达项目已保存。'); } catch (caught) { setError(caught instanceof Error ? caught.message : '保存失败。'); } finally { setSaving(false); } };
  const createVersion = async () => { try { const project = await ensureProject(); await toolApi.createVersion(project.id, `科研雷达 v${result.workspace.version} · ${new Date().toLocaleString('zh-CN')}`, projectState()); setMessage('已创建不可变版本。'); } catch (caught) { setError(caught instanceof Error ? caught.message : '创建版本失败。'); } };
  const selectProject = (id: string) => { setProjectId(id); const project = projects.find((item) => item.id === id); if (!project) { const baseline = createBenchmarkResult(); setResult(baseline); setProjectTitle('地球科学研究前沿项目'); setQuery(baseline.workspace.query.main); return; } const saved = project.state.researchRadar as { result?: RadarResult } | undefined; if (saved?.result?.schema === 'skyview-research-radar-results') { setResult(saved.result); setProjectTitle(project.title); setQuery(saved.result.workspace.query.main); } };
  const importRecords = async (file?: File) => { if (!file) return; if (file.size > 2_000_000) { setError('导入文件不能超过 2 MB。'); return; } await execute('import-records', { fileName: file.name, content: await file.text() }); if (importInput.current) importInput.current.value = ''; };
  const updateLocalWorkspace = (change: (workspace: RadarWorkspace) => void) => setResult((current) => { const next = structuredClone(current); change(next.workspace); next.workspace.updatedAt = new Date().toISOString(); return next; });

  const libraryIds = new Set(result.workspace.library.map((item) => item.recordId));
  const filtered = result.records.filter((item) => (!filter || `${item.title} ${item.abstract} ${item.topics.join(' ')}`.toLowerCase().includes(filter.toLowerCase())) && (!result.workspace.query.oaOnly || item.openAccess));
  const libraryRecords = result.workspace.library.filter((item) => collectionId === 'all' || item.collectionId === collectionId).map((entry) => ({ entry, record: result.records.find((item) => item.id === entry.recordId) })).filter((item) => item.record);
  const selected = result.records.find((item) => item.id === selectedId) ?? result.records[0];
  const graphPositions = useMemo(() => { const map = new Map<string, { x: number; y: number }>(); result.analysis.graph.nodes.slice(0, 20).forEach((node, index) => { const ring = node.type === 'topic' ? 92 : 175; const angle = index * Math.PI * 2 / Math.max(1, result.analysis.graph.nodes.slice(0, 20).length); map.set(node.id, { x: 270 + Math.cos(angle) * ring, y: 180 + Math.sin(angle) * ring }); }); return map; }, [result.analysis.graph.nodes]);
  const sourceBadge = result.records.some((item) => item.datasetMode === 'live') ? '公开来源实查' : result.records.some((item) => item.datasetMode === 'imported') ? '导入记录' : '离线基准';

  return <div className="rrx-workbench">
    <header className="rrx-commandbar">
      <div className="rrx-project"><Radar /><NativeSelect aria-label="选择科研雷达项目" value={projectId} onChange={(event) => selectProject(event.target.value)}><NativeSelectOption value="">当前本地项目</NativeSelectOption>{projects.map((project) => <NativeSelectOption key={project.id} value={project.id}>{project.title}</NativeSelectOption>)}</NativeSelect><Input aria-label="项目名称" value={projectTitle} onChange={(event) => setProjectTitle(event.target.value)} /><span className={sourceBadge === '公开来源实查' ? 'live' : ''}>{sourceBadge}</span></div>
      <div className="rrx-actions"><input ref={importInput} hidden type="file" accept=".bib,.ris,.json,text/plain,application/json" onChange={(event) => void importRecords(event.target.files?.[0])} /><Button size="sm" variant="outline" onClick={() => importInput.current?.click()}><FileInput />导入文献</Button><Button size="sm" variant="outline" onClick={() => void saveProject()} disabled={saving}>{saving ? <LoaderCircle className="spin" /> : <Save />}保存</Button><Button size="sm" variant="outline" onClick={() => void createVersion()}><Archive />建立版本</Button><Button size="sm" onClick={() => void execute('search-live', { query, providers: result.workspace.query.providers, limit: 12 })} disabled={running}>{running ? <LoaderCircle className="spin" /> : <Search />}公开来源检索</Button></div>
    </header>
    <section className="rrx-kpis">
      <article><Radar /><span>发现记录</span><strong>{result.records.length}</strong><small>{sourceBadge}</small></article>
      <article><BookMarked /><span>已入文献库</span><strong>{result.workspace.library.length}</strong><small>{result.workspace.library.filter((item) => item.status === 'included').length} 条纳入</small></article>
      <article><ShieldCheck /><span>高等级证据</span><strong>{result.records.filter((item) => item.evidenceGrade === 'A').length}</strong><small>A 级记录</small></article>
      <article><ExternalLink /><span>开放获取</span><strong>{pct(result.analysis.openAccess.rate)}</strong><small>{result.analysis.openAccess.open} 条可开放访问</small></article>
      <article><GitMerge /><span>主题关系</span><strong>{result.analysis.graph.edges.length}</strong><small>{result.analysis.graph.nodes.length} 个节点</small></article>
      <article><BellRing /><span>监测任务</span><strong>{result.workspace.monitors.length}</strong><small>当前按需执行</small></article>
    </section>
    <Tabs value={view} onValueChange={(value) => setView(value as typeof view)} className="rrx-tabs-shell"><TabsList className="rrx-tabs" variant="line">{views.map(([id, label], index) => <TabsTrigger key={id} value={id}><b>{String(index + 1).padStart(2, '0')}</b>{label}</TabsTrigger>)}</TabsList></Tabs>
    {(message || error) && <div className={`rrx-status ${error ? 'error' : ''}`}>{error ? <CircleAlert /> : <CheckCircle2 />}<span>{error || message}</span><button aria-label="关闭状态" onClick={() => { setMessage(''); setError(''); }}><X /></button></div>}
    <main className="rrx-stage">
      {view === 'overview' && <div className="rrx-view rrx-overview">
        <section className="rrx-surface rrx-signal"><header><div><span>研究信号</span><strong>{result.workspace.name}</strong><small>离线基准已直接载入；点击公开来源检索才会访问真实数据源</small></div><button onClick={() => setView('discover')}>进入发现 <ExternalLink /></button></header><div className="rrx-signal-grid">{result.analysis.synthesis.map((item, index) => <article key={item}><b>{String(index + 1).padStart(2, '0')}</b><span>{item}</span></article>)}</div></section>
        <section className="rrx-surface rrx-trend-card"><header><span>年度趋势</span><strong>{result.analysis.yearlyTrend.reduce((sum, item) => sum + item.count, 0)} 条记录</strong></header><MiniTrend values={result.analysis.yearlyTrend} /></section>
        <section className="rrx-surface rrx-access"><header><span>开放获取</span><strong>{pct(result.analysis.openAccess.rate)}</strong></header><div className="rrx-donut" style={{ '--rrx-open': `${result.analysis.openAccess.rate * 360}deg` } as React.CSSProperties}><span><b>{result.analysis.openAccess.open}</b><small>开放记录</small></span></div><footer><span><i className="open" />开放 {result.analysis.openAccess.open}</span><span><i />受限 {result.analysis.openAccess.closed}</span></footer></section>
        <section className="rrx-surface rrx-topics"><header><span>主题分布</span><button onClick={() => setView('graph')}>查看图谱</button></header><div>{result.analysis.topics.slice(0, 7).map((item) => <article key={item.name}><span>{item.name}</span><i><b style={{ width: `${Math.max(16, item.count / Math.max(...result.analysis.topics.map((topic) => topic.count)) * 100)}%` }} /></i><strong>{item.count}</strong></article>)}</div></section>
        <section className="rrx-surface rrx-recent"><header><span>高相关记录</span><button onClick={() => setView('library')}>查看文献库</button></header><div>{result.records.slice().sort((a, b) => b.relevance - a.relevance).slice(0, 5).map((item) => <button key={item.id} onClick={() => { setSelectedId(item.id); setView('discover'); }}><em>{item.evidenceGrade}</em><span><strong>{item.title}</strong><small>{item.year} · {item.providers.join(' + ')} · 引用 {item.citations}</small></span><b>{pct(item.relevance)}</b></button>)}</div></section>
      </div>}

      {view === 'discover' && <div className="rrx-view rrx-discover">
        <section className="rrx-surface rrx-query"><div className="rrx-searchbox"><Search /><Input aria-label="研究主题" value={query} onChange={(event) => setQuery(event.target.value)} /><Button onClick={() => void execute('search-live', { query, providers: result.workspace.query.providers, limit: 12 })} disabled={running}>运行公开检索</Button></div><div className="rrx-query-options"><div className="rrx-query-field"><span>必须包含</span><Input aria-label="必须包含" value={result.workspace.query.must} onChange={(event) => updateLocalWorkspace((workspace) => { workspace.query.must = event.target.value; })} /></div><div className="rrx-query-field"><span>排除词</span><Input aria-label="排除词" value={result.workspace.query.exclude} onChange={(event) => updateLocalWorkspace((workspace) => { workspace.query.exclude = event.target.value; })} /></div><div className="rrx-query-field"><span>起始年份</span><Input aria-label="起始年份" type="number" value={result.workspace.query.startYear} onChange={(event) => updateLocalWorkspace((workspace) => { workspace.query.startYear = Number(event.target.value); })} /></div><div className="rrx-query-field"><span>排序</span><NativeSelect aria-label="排序" value={result.workspace.query.sort} onChange={(event) => updateLocalWorkspace((workspace) => { workspace.query.sort = event.target.value; })}><NativeSelectOption value="relevance">相关度</NativeSelectOption><NativeSelectOption value="year">年份</NativeSelectOption><NativeSelectOption value="citations">引用量</NativeSelectOption></NativeSelect></div><button className={result.workspace.query.oaOnly ? 'active' : ''} onClick={() => updateLocalWorkspace((workspace) => { workspace.query.oaOnly = !workspace.query.oaOnly; })}><Check />仅开放获取</button>{['crossref', 'openalex'].map((provider) => <button key={provider} className={result.workspace.query.providers.includes(provider) ? 'active' : ''} onClick={() => updateLocalWorkspace((workspace) => { workspace.query.providers = workspace.query.providers.includes(provider) ? workspace.query.providers.filter((item) => item !== provider) : [...workspace.query.providers, provider]; })}><Database />{provider === 'crossref' ? 'Crossref' : 'OpenAlex'}</button>)}</div></section>
        <aside className="rrx-surface rrx-filter"><header><Filter /><span>结果筛选</span><strong>{filtered.length}</strong></header><Input aria-label="筛选结果" placeholder="标题、摘要或主题" value={filter} onChange={(event) => setFilter(event.target.value)} /><div className="rrx-filter-groups"><span>证据等级</span>{['A', 'B', 'C'].map((grade) => <button key={grade} onClick={() => setFilter(grade === filter ? '' : grade)}>等级 {grade}<b>{result.records.filter((item) => item.evidenceGrade === grade).length}</b></button>)}<span>记录边界</span><p><ShieldCheck />离线基准与真实检索结果始终分别标识。</p></div></aside>
        <section className="rrx-results">{filtered.map((item) => <article className={`rrx-paper ${selectedId === item.id ? 'selected' : ''}`} key={item.id}><header><span className={`grade grade-${item.evidenceGrade.toLowerCase()}`}>{item.evidenceGrade} 级</span><span className={item.datasetMode}>{item.datasetMode === 'demo' ? '离线基准' : item.datasetMode === 'live' ? '公开来源' : '导入记录'}</span><em>{pct(item.relevance)} 相关</em></header><strong>{item.title}</strong><small>{item.authors.join('、')} · {item.year} · {item.venue}</small><p>{item.abstract}</p><footer><span>引用 {item.citations}</span><span>参考 {item.references}</span>{item.openAccess && <span className="oa">开放获取</span>}<span>{item.providers.join(' + ')}</span><button onClick={() => setSelectedId(item.id)}>查看</button><button onClick={() => { void navigator.clipboard?.writeText(item.doi).then(() => setMessage('DOI 已复制。')); }}>复制 DOI</button><button className={libraryIds.has(item.id) ? 'saved' : ''} onClick={() => { void execute('update-library', { recordId: item.id, collectionId: 'inbox', status: 'maybe', priority: 'medium', tags: item.topics, note: '' }); }}>{libraryIds.has(item.id) ? '已入库' : '加入文献库'}</button></footer></article>)}</section>
      </div>}

      {view === 'library' && <div className="rrx-view rrx-library">
        <aside className="rrx-surface rrx-collections"><header><Library /><span>文献集合</span><strong>{result.workspace.library.length}</strong></header><button className={collectionId === 'all' ? 'active' : ''} onClick={() => setCollectionId('all')}><span>全部文献</span><b>{result.workspace.library.length}</b></button>{result.workspace.collections.map((item) => <button className={collectionId === item.id ? 'active' : ''} key={item.id} onClick={() => setCollectionId(item.id)}><i style={{ background: item.color }} /><span>{item.name}</span><b>{result.workspace.library.filter((entry) => entry.collectionId === item.id).length}</b></button>)}<Button variant="outline" onClick={() => void execute('dedupe')}><GitMerge />重新去重</Button><Button variant="outline" onClick={() => downloadText(result.exports.libraryCsv, '科研雷达文献库.csv', 'text/csv;charset=utf-8')}><Download />导出目录</Button></aside>
        <section className="rrx-library-list">{libraryRecords.map(({ entry, record }) => record && <article className={selectedId === record.id ? 'selected' : ''} key={record.id}><header><span className={`grade grade-${record.evidenceGrade.toLowerCase()}`}>{record.evidenceGrade}</span><strong>{record.title}</strong><em>{record.year}</em></header><p>{record.abstract}</p><div><span>{statusLabel[entry.status] || entry.status}</span><span>优先级 {statusLabel[entry.priority] || entry.priority}</span>{entry.tags.map((tag) => <span key={tag}>#{tag}</span>)}</div><footer><small>{entry.note || '尚未填写筛选备注'}</small><button onClick={() => setSelectedId(record.id)}>查看详情</button><button onClick={() => { void execute('update-library', { ...entry, recordId: record.id, status: entry.status === 'included' ? 'maybe' : 'included' }); }}>{entry.status === 'included' ? '改为待定' : '纳入证据'}</button></footer></article>)}</section>
        {selected && <aside className="rrx-surface rrx-detail"><header><span>文献详情</span><strong>{selected.evidenceGrade} 级证据</strong></header><h3>{selected.title}</h3><p>{selected.abstract}</p><dl><div><dt>DOI</dt><dd>{selected.doi}</dd></div><div><dt>来源</dt><dd>{selected.providers.join(' + ')}</dd></div><div><dt>核验时间</dt><dd>{selected.verifiedAt.slice(0, 10)}</dd></div><div><dt>复现线索</dt><dd>{Object.values(selected.evidenceProfile).filter(Boolean).length}/3</dd></div></dl><a href={selected.url} target="_blank" rel="noreferrer">打开来源 <ExternalLink /></a></aside>}
      </div>}

      {view === 'graph' && <div className="rrx-view rrx-graph-view"><section className="rrx-surface rrx-network"><header><div><span>主题共现图</span><strong>{result.analysis.graph.nodes.length} 节点 · {result.analysis.graph.edges.length} 关系</strong></div><small>主题与文献记录均可追溯到当前数据集</small></header><svg viewBox="0 0 540 360" aria-label="科研主题图谱">{result.analysis.graph.edges.slice(0, 28).map((edge) => { const source = graphPositions.get(edge.source); const target = graphPositions.get(edge.target); return source && target ? <line key={edge.id} x1={source.x} y1={source.y} x2={target.x} y2={target.y} strokeWidth={edge.weight} /> : null; })}{result.analysis.graph.nodes.slice(0, 20).map((node) => { const point = graphPositions.get(node.id); return point ? <g key={node.id} className={node.type}><circle cx={point.x} cy={point.y} r={node.type === 'topic' ? 15 + node.weight * 3 : 7} /><text x={point.x} y={point.y + (node.type === 'topic' ? 34 : 20)}>{node.label.slice(0, node.type === 'topic' ? 8 : 10)}</text></g> : null; })}</svg></section><section className="rrx-surface rrx-topic-table"><header><Tags /><span>主题强度</span></header>{result.analysis.topics.map((item, index) => <button key={item.name} onClick={() => { setFilter(item.name); setView('discover'); }}><b>{String(index + 1).padStart(2, '0')}</b><span>{item.name}</span><i><em style={{ width: `${item.count / Math.max(...result.analysis.topics.map((topic) => topic.count)) * 100}%` }} /></i><strong>{item.count}</strong></button>)}</section></div>}

      {view === 'evidence' && <div className="rrx-view rrx-evidence"><section className="rrx-surface rrx-grade-summary"><header><ShieldCheck /><span>证据等级分布</span><strong>{result.records.length} 条</strong></header><div>{result.analysis.evidenceGrades.map((item) => <article key={item.grade}><b className={`grade-${item.grade.toLowerCase()}`}>{item.grade}</b><span><strong>{item.count}</strong><small>{item.grade === 'A' ? '强复现线索' : item.grade === 'B' ? '方法较完整' : item.grade === 'C' ? '需要补充核验' : '证据不足'}</small></span></article>)}</div></section><section className="rrx-surface rrx-evidence-notes"><header><span>人工使用边界</span><Button size="sm" onClick={() => void execute('update-evidence', { use: result.workspace.evidenceNotes.use, limitations: result.workspace.evidenceNotes.limitations })}><Save />保存说明</Button></header><label><span>纳入原则</span><textarea value={result.workspace.evidenceNotes.use} onChange={(event) => updateLocalWorkspace((workspace) => { workspace.evidenceNotes.use = event.target.value; })} /></label><label><span>局限与复核</span><textarea value={result.workspace.evidenceNotes.limitations} onChange={(event) => updateLocalWorkspace((workspace) => { workspace.evidenceNotes.limitations = event.target.value; })} /></label></section><section className="rrx-surface rrx-matrix"><header><span>逐条证据矩阵</span><strong>数据、代码、验证与使用状态</strong></header><div className="rrx-matrix-head"><b>等级</b><b>研究记录</b><b>数据</b><b>代码</b><b>验证</b><b>相关度</b><b>馆藏</b></div>{result.records.map((item) => <button key={item.id} onClick={() => { setSelectedId(item.id); setView('library'); }}><b className={`grade-${item.evidenceGrade.toLowerCase()}`}>{item.evidenceGrade}</b><span>{item.title}<small>{item.year} · {item.providers.join(' + ')}</small></span><i className={item.evidenceProfile.data ? 'yes' : ''}>{item.evidenceProfile.data ? '有' : '无'}</i><i className={item.evidenceProfile.code ? 'yes' : ''}>{item.evidenceProfile.code ? '有' : '无'}</i><i className={item.evidenceProfile.validation ? 'yes' : ''}>{item.evidenceProfile.validation ? '有' : '无'}</i><em>{pct(item.relevance)}</em><strong>{libraryIds.has(item.id) ? '已入库' : '未入库'}</strong></button>)}</section></div>}

      {view === 'alerts' && <div className="rrx-view rrx-alerts"><section className="rrx-surface rrx-monitor-state"><header><BellRing /><div><span>监测执行边界</span><strong>规则已保存，当前按需运行</strong></div></header><p>每次运行都记录基线、新增记录、状态与去重键。生产定时调度和外部通知通道尚未配置，因此不显示虚构的下次运行时间。</p><div><span>后台调度<strong>未配置</strong></span><span>外部通知<strong>未配置</strong></span><span>站内记录<strong>已启用</strong></span></div></section><section className="rrx-monitor-list">{result.workspace.monitors.map((monitor) => <article key={monitor.id}><header><span className={monitor.enabled ? 'enabled' : ''}><BellRing /></span><div><strong>{monitor.name}</strong><small>{monitor.query}</small></div><em>{monitor.frequency === 'weekly' ? '每周规则' : monitor.frequency}</em></header><div><span>最近运行<b>{monitor.lastRunAt.slice(0, 10)}</b></span><span>状态<b>{statusLabel[monitor.lastStatus] || monitor.lastStatus}</b></span><span>基线<b>{monitor.baselineIds.length} 条</b></span><span>新增<b>{monitor.newIds.length} 条</b></span></div><footer><span>交付：{monitor.delivery}</span><Button size="sm" onClick={() => void execute('run-monitor', { monitorId: monitor.id })} disabled={running}><Play />立即运行</Button></footer></article>)}</section><section className="rrx-surface rrx-monitor-runs"><header><span>运行与通知记录</span><Button variant="outline" size="sm" onClick={() => downloadText(result.exports.alertsMarkdown, '科研雷达监测记录.md')}><Download />导出记录</Button></header>{result.workspace.monitorRuns?.length ? result.workspace.monitorRuns.map((run) => <article key={run.id}><CheckCircle2 /><span><strong>运行完成</strong><small>{run.startedAt} · 新增 {run.newIds.length} 条</small></span><em>站内已记录</em></article>) : <div className="rrx-empty">运行任务后，这里将保留可审计的监测记录。</div>}</section></div>}

      {view === 'transfer' && <div className="rrx-view rrx-transfer"><section className="rrx-surface rrx-transfer-intro"><header><Send /><div><span>成果联动</span><strong>把已筛选证据打包到下一工作台</strong></div></header><p>当前选择 {result.workspace.transfer.selectedIds.length} 条记录。联动包保留 DOI、来源、证据等级、摘要和人工使用边界。</p><div>{result.workspace.transfer.selectedIds.map((id) => { const item = result.records.find((record) => record.id === id); return item ? <span key={id}>{item.evidenceGrade} · {item.title}</span> : null; })}</div></section><section className="rrx-transfer-destinations">{[['paper-writing', '论文研究与写作', '主张、引用与证据链'], ['knowledge-system', '个人知识系统', 'Markdown 与结构化记录'], ['patent-transfer', '专利转化', '现有技术证据包']].map(([id, title, note]) => <article key={id}><div><FolderKanban /><span><strong>{title}</strong><small>{note}</small></span></div><Button onClick={() => void execute('transfer', { destination: id, recordIds: result.workspace.transfer.selectedIds })}><Send />生成联动包</Button></article>)}</section><section className="rrx-surface rrx-deliveries"><header><FileDown /><span>交付与交换</span></header><div><button onClick={() => downloadText(result.exports.bibtex, '科研雷达文献.bib')}><strong>BibTeX</strong><small>引文管理</small></button><button onClick={() => downloadText(result.exports.ris, '科研雷达文献.ris')}><strong>RIS</strong><small>通用交换</small></button><button onClick={() => downloadText(result.exports.libraryCsv, '科研雷达文献库.csv', 'text/csv;charset=utf-8')}><strong>馆藏 CSV</strong><small>筛选与备注</small></button><button onClick={() => downloadText(result.exports.knowledgeMarkdown, '研究证据包.md')}><strong>知识库 MD</strong><small>可读证据包</small></button><button onClick={() => downloadText(result.exports.knowledgeJson, '研究证据包.json', 'application/json;charset=utf-8')}><strong>联动 JSON</strong><small>结构化交换</small></button><button onClick={() => downloadText(result.exports.backupJson, '科研雷达完整备份.json', 'application/json;charset=utf-8')}><strong>完整备份</strong><small>项目与分析</small></button></div></section></div>}

      {view === 'sources' && <div className="rrx-view rrx-sources"><section className="rrx-source-grid">{result.sources.map((source) => <article className="rrx-surface" key={source.id}><header><Database /><div><span>{source.configured ? '公开文献来源' : '待配置来源'}</span><strong>{source.name}</strong></div><em className={source.status}>{statusLabel[source.status] || source.status}</em></header><dl><div><dt>启用状态</dt><dd>{source.enabled ? '已启用' : '未启用'}</dd></div><div><dt>最近检查</dt><dd>{source.lastCheckedAt ? source.lastCheckedAt.slice(0, 19).replace('T', ' ') : '尚未实查'}</dd></div><div><dt>响应记录</dt><dd>{source.records ?? '—'}</dd></div><div><dt>耗时</dt><dd>{source.latencyMs ? `${source.latencyMs} ms` : '—'}</dd></div></dl><p>{source.lastError || source.rateLimit}</p><Button variant="outline" disabled={!source.configured || running} onClick={() => void execute('search-live', { query, providers: [source.id], limit: 5 })}><RefreshCw />检查来源</Button></article>)}</section><section className="rrx-surface rrx-provenance"><header><Settings2 /><div><span>来源与运行边界</span><strong>真实状态，不用离线记录冒充公开检索结果</strong></div></header><div><article><b>Go 控制面</b><span>项目、版本、作业、权限与审计</span></article><article><b>Python 计算面</b><span>来源适配、归一化、DOI/标题去重、图表与导出</span></article><article><b>导入边界</b><span>BibTeX、RIS、JSON 只解析数据，不执行上传内容</span></article><article><b>来源健康</b><span>只有明确运行公开检索后才更新检查状态</span></article></div></section></div>}
    </main>
  </div>;
}
