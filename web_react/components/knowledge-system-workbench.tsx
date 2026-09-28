'use client';

import { useMemo, useRef, useState, useEffect } from 'react';
import {
  Archive, BookOpenCheck, Boxes, CheckCircle2, ChevronRight, CircleAlert, Copy,
  Database, Download, FileArchive, FilePlus2, FileSearch, FileText, FolderOpen,
  GitBranch, HardDrive, Link2, LoaderCircle, Network, Play, Plus, RefreshCw,
  Save, Search, ShieldCheck, Sparkles, Trash2, Upload, X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiError } from '@/services/api/client';
import { toolApi, type WorkbenchJob, type WorkbenchProject } from '@/services/api/tools';

type Settings = { chunkSize: number; chunkOverlap: number; bm25Weight: number; threshold: number; topK: number; maxAnswerSentences: number };
type Benchmark = { id: string; query: string; expectedDocumentId: string; createdAt: string };
type Workspace = { id: string; name: string; description: string; version: number; createdAt: string; updatedAt: string; settings: Settings; savedQueries: Array<{ id: string; query: string; documentId: string; tag: string; createdAt: string }>; ingestionHistory: Array<{ id: string; name: string; message: string; status: string; createdAt: string }>; benchmarks: Benchmark[] };
type KnowledgeDocument = { id: string; workspaceId: string; name: string; originalName: string; mimeType: string; extension: string; size: number; hash: string; status: string; error: string; parser: string; pageCount: number; recordCount: number; textLength: number; keywords: string[]; language: string; warnings: string[]; tags: string[]; category: string; source: string; license: string; authors: string; year: string; createdAt: string; updatedAt: string; version: number; contentBase64: string; extractedText: string };
type Chunk = { id: string; workspaceId: string; documentId: string; documentName: string; order: number; heading: string; text: string; charCount: number; tokenCount: number; sourceLocation: string; page?: number | null; keywords: string[]; version: number; updatedAt: string };
type Citation = { index: number; chunkId: string; documentId: string; documentName: string; heading: string; sourceLocation: string; page?: number | null; score: number; excerpt: string };
type Answer = { id: string; query: string; answer: string; citations: Citation[]; confidence: number; evidenceCount: number; sourceCount: number; mode: string; createdAt: string; retrieval: { settings: Settings; resultCount: number } };
type SearchResult = Chunk & { score: number; bm25Score: number; vectorScore: number; phraseMatch: boolean; matchedTerms: string[] };
type GraphNode = { id: string; name: string; count: number; documentIds: string[]; chunkIds: string[] };
type GraphEdge = { id: string; source: string; target: string; weight: number; chunkIds: string[] };
type Revision = { id: string; type: string; documentId: string; documentName: string; note: string; fromVersion: number; toVersion: number; createdAt: string };
type KnowledgeResult = {
  schema: 'skyview-knowledge-system-results'; version: number; stage: string;
  bundle: { workspace: Workspace; documents: KnowledgeDocument[]; chunks: Chunk[]; conversations: Answer[]; revisions: Revision[] };
  search: { query: string; documentId: string; tag: string; results: SearchResult[]; executedAt: string };
  answer: Answer; graph: { nodes: GraphNode[]; edges: GraphEdge[] };
  quality: { score: number; issues: Array<{ severity: string; documentId: string; message: string }>; indexedDocuments: number; totalDocuments: number; chunkCount: number; averageChunk: number; taggedRate: number; duplicateGroups: number };
  evaluation: { total: number; hitAtK: number; mrr: number; topK: number; details: Array<Benchmark & { rank: number; hit: boolean; reciprocalRank: number; resultIds: string[] }> };
  storage: { originalBytes: number; documents: number; chunks: number; persistence: string };
  runtime: { compute: string; orchestration: string; embedding: string; externalAi: boolean; uploadedCodeExecution: boolean; databaseAclPushdown: boolean; objectStorageConfigured: boolean; ocrConfigured: boolean; supportedExtensions: string[]; singleFileLimitBytes: number };
  exports: { answerMarkdown: string; documentsCsv: string; chunksJson: string; graphJson: string; qualityJson: string; manifestJson: string; backupBase64: string; backupBytes: number };
};

const views = [
  ['dashboard', '知识总览'], ['ingest', '资料入库'], ['documents', '文档与分块'], ['retrieval', '混合检索'],
  ['qa', '证据问答'], ['graph', '概念关系'], ['quality', '质量评测'], ['archive', '数据库管理'],
] as const;
const terminalStatuses = new Set(['succeeded', 'failed', 'canceled']);
const wait = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));
const percent = (value: number) => `${(value * 100).toFixed(value === 1 ? 0 : 1)}%`;
const formatBytes = (value: number) => value < 1024 ? `${value} B` : value < 1048576 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1048576).toFixed(1)} MB`;
const formatTime = (value: string) => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
const textFileTypes = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'html', 'htm', 'xml', 'rtf', 'log', 'tex', 'bib', 'py', 'js', 'ts', 'css', 'yaml', 'yml', 'ini', 'conf', 'sql', 'eml']);

async function waitForJob(id: string): Promise<WorkbenchJob | null> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const job = await toolApi.getJob(id);
    if (terminalStatuses.has(job.status)) return job;
    await wait(750);
  }
  return null;
}

function downloadText(content: string, fileName: string, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob(['\ufeff', content], { type }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = fileName;
  document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
}

function downloadBase64(content: string, fileName: string, type = 'application/zip') {
  const bytes = Uint8Array.from(atob(content), (character) => character.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = fileName;
  document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
}

async function fileBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer()); let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function createBenchmarkResult(): KnowledgeResult {
  const now = '2026-09-09T00:00:00Z';
  const settings: Settings = { chunkSize: 420, chunkOverlap: 60, bm25Weight: 0.72, threshold: 0.08, topK: 8, maxAnswerSentences: 5 };
  const workspace: Workspace = {
    id: 'kb-research-evidence', name: '地球科学研究知识库', description: '多源监测、成像、工程判断与成果转化资料。', version: 7, createdAt: now, updatedAt: now, settings,
    savedQueries: [{ id: 'query-1', query: '哪些证据支持边坡风险升高', documentId: 'all', tag: '边坡', createdAt: now }],
    ingestionHistory: [{ id: 'activity-1', name: '边坡多源监测记录.md', message: '解析、分块和索引完成', status: 'success', createdAt: now }, { id: 'activity-2', name: '台站环境噪声成像说明.txt', message: '解析、分块和索引完成', status: 'success', createdAt: now }],
    benchmarks: [{ id: 'benchmark-1', query: '哪些证据说明边坡风险升高', expectedDocumentId: 'doc-slope', createdAt: now }, { id: 'benchmark-2', query: '背景噪声成像的有效频散点有多少', expectedDocumentId: 'doc-imaging', createdAt: now }, { id: 'benchmark-3', query: '技术成果转化前需要核查什么', expectedDocumentId: 'doc-transfer', createdAt: now }],
  };
  const raw = [
    ['doc-slope', '边坡多源监测记录.md', 'md', '遥感影像显示坡脚区域出现新增形变，位移传感器连续三日记录到加速趋势。同期降雨量超过历史九十分位阈值，现场复核发现坡脚排水不畅。', ['边坡', '监测', '风险'], '监测记录'],
    ['doc-imaging', '台站环境噪声成像说明.txt', 'txt', '面波背景噪声成像采用九个有效台站和十八对台站组合，获得九十六个有效频散点，并在四秒到十五秒周期进行层析反演。', ['面波', '成像', '台站'], '方法说明'],
    ['doc-transfer', '成果转化核查清单.json', 'json', '技术成果转化前需要核查权利要求支持、现有技术与自由实施风险、技术成熟度证据、许可现金流假设，以及法律状态与期限。', ['专利', '转化', '核查'], '核查清单'],
    ['doc-stations', '台站质量观测.csv', 'csv', 'SV01 可用率 99.2%，SV02 可用率 97.2%，SV03 可用率 95.2%，采样率均为 100 Hz。', ['台站', '质量', '观测'], '数据表'],
  ] as const;
  const documents: KnowledgeDocument[] = raw.map(([id, name, extension, content, tags, category]) => ({ id, workspaceId: workspace.id, name, originalName: name, mimeType: extension === 'json' ? 'application/json' : extension === 'csv' ? 'text/csv' : 'text/plain', extension, size: new TextEncoder().encode(content).length, hash: `${id.replace('doc-', '')}7f96cdb7250a23f8f20d8b5e05231b0d6b5d3029c79a275cf2`, status: 'ready', error: '', parser: extension === 'json' ? 'JSON 结构展平器' : extension === 'csv' ? '结构化表格解析器' : '安全文本解码器', pageCount: 0, recordCount: extension === 'csv' ? 3 : 0, textLength: content.length, keywords: [...tags, '证据'], language: '中文/多语言', warnings: [], tags: [...tags], category, source: '确定性合成基准', license: '当前工作区内部使用', authors: 'SkyViewLab', year: '2026', createdAt: now, updatedAt: now, version: 1, contentBase64: '', extractedText: content }));
  const chunks: Chunk[] = documents.map((document, index) => ({ id: `chunk-${document.id}-1`, workspaceId: workspace.id, documentId: document.id, documentName: document.name, order: 0, heading: document.category, text: document.extractedText, charCount: document.textLength, tokenCount: 22 + index * 3, sourceLocation: 'L1 · S1-3', page: null, keywords: document.keywords, version: 1, updatedAt: now }));
  const searchResults: SearchResult[] = [
    { ...chunks[0], score: .948, bm25Score: 1, vectorScore: .671, phraseMatch: false, matchedTerms: ['边坡', '风险', '证据'] },
    { ...chunks[3], score: .426, bm25Score: .392, vectorScore: .514, phraseMatch: false, matchedTerms: ['台站', '观测'] },
  ];
  const citations: Citation[] = searchResults.map((item, index) => ({ index: index + 1, chunkId: item.id, documentId: item.documentId, documentName: item.documentName, heading: item.heading, sourceLocation: item.sourceLocation, page: null, score: item.score, excerpt: item.text }));
  const answer: Answer = { id: 'qa-benchmark', query: '哪些证据支持边坡风险升高', answer: '- 遥感影像显示坡脚区域出现新增形变。[1]\n- 位移传感器连续三日记录到加速趋势。[1]\n- 同期降雨量超过历史九十分位阈值，现场复核发现坡脚排水不畅。[1]', citations, confidence: .919, evidenceCount: 3, sourceCount: 1, mode: 'extractive', createdAt: now, retrieval: { settings, resultCount: 2 } };
  const nodes: GraphNode[] = ['边坡', '监测', '风险', '台站', '面波', '成像', '转化', '核查', '降雨', '位移'].map((name, index) => ({ id: name, name, count: index < 4 ? 3 : 2, documentIds: [documents[index % documents.length].id], chunkIds: [chunks[index % chunks.length].id] }));
  const edges: GraphEdge[] = [['边坡', '监测'], ['边坡', '风险'], ['监测', '位移'], ['风险', '降雨'], ['台站', '面波'], ['面波', '成像'], ['转化', '核查']].map(([source, target], index) => ({ id: `${source}::${target}`, source, target, weight: index < 3 ? 2 : 1, chunkIds: [chunks[index % chunks.length].id] }));
  const quality = { score: 100, issues: [] as Array<{ severity: string; documentId: string; message: string }>, indexedDocuments: 4, totalDocuments: 4, chunkCount: 4, averageChunk: 70, taggedRate: 1, duplicateGroups: 0 };
  const details = workspace.benchmarks.map((item) => ({ ...item, rank: 1, hit: true, reciprocalRank: 1, resultIds: [chunks.find((chunk) => chunk.documentId === item.expectedDocumentId)!.id] }));
  return {
    schema: 'skyview-knowledge-system-results', version: 2, stage: 'run-all', bundle: { workspace, documents, chunks, conversations: [answer], revisions: [] },
    search: { query: answer.query, documentId: 'all', tag: '', results: searchResults, executedAt: now }, answer,
    graph: { nodes, edges }, quality, evaluation: { total: 3, hitAtK: 1, mrr: 1, topK: 8, details },
    storage: { originalBytes: documents.reduce((sum, item) => sum + item.size, 0), documents: 4, chunks: 4, persistence: 'Go 项目状态与不可变版本' },
    runtime: { compute: 'Python 确定性混合检索', orchestration: 'Go 项目、作业、版本与审计', embedding: '192 维可解释字符哈希特征', externalAi: false, uploadedCodeExecution: false, databaseAclPushdown: false, objectStorageConfigured: false, ocrConfigured: false, supportedExtensions: ['pdf', 'docx', 'txt', 'md', 'csv', 'json', 'html', 'xml', 'rtf'], singleFileLimitBytes: 31457280 },
    exports: { answerMarkdown: `# ${answer.query}\n\n${answer.answer}`, documentsCsv: '文档ID,名称,类型,版本,状态\n', chunksJson: JSON.stringify({ chunks }, null, 2), graphJson: JSON.stringify({ nodes, edges }, null, 2), qualityJson: JSON.stringify({ quality }, null, 2), manifestJson: JSON.stringify({ schema: 'skyview-personal-knowledge-database', workspace, documents: 4 }, null, 2), backupBase64: '', backupBytes: 0 },
  };
}

function ScoreRing({ score }: { score: number }) {
  return <div className="know-score" style={{ '--know-score': `${score * 3.6}deg` } as React.CSSProperties}><span><strong>{score}</strong><small>/100</small></span></div>;
}

export function KnowledgeSystemWorkbench({ executionAllowed = true }: { executionAllowed?: boolean }) {
  const [view, setView] = useState<(typeof views)[number][0]>('dashboard');
  const [result, setResult] = useState<KnowledgeResult>(() => createBenchmarkResult());
  const [projects, setProjects] = useState<WorkbenchProject[]>([]); const [projectId, setProjectId] = useState('');
  const [projectTitle, setProjectTitle] = useState('地球科学研究知识库项目');
  const [selectedDocumentId, setSelectedDocumentId] = useState('doc-slope'); const [selectedChunkId, setSelectedChunkId] = useState('chunk-doc-slope-1');
  const [query, setQuery] = useState('哪些证据支持边坡风险升高'); const [documentFilter, setDocumentFilter] = useState('all'); const [tagFilter, setTagFilter] = useState('');
  const [documentQuery, setDocumentQuery] = useState(''); const [graphQuery, setGraphQuery] = useState('');
  const [noteName, setNoteName] = useState('新的研究笔记.md'); const [noteText, setNoteText] = useState('# 研究笔记\n'); const [ingestTags, setIngestTags] = useState('研究,证据');
  const [benchmarkQuery, setBenchmarkQuery] = useState(''); const [benchmarkDocument, setBenchmarkDocument] = useState('doc-slope');
  const [chunkDrafts, setChunkDrafts] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false); const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('完整知识库、检索结果、引用问答和质量评测已载入。'); const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null); const backupInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    toolApi.listProjects('knowledge-system').then((items) => {
      if (!active) return;
      setProjects(items); const project = items[0]; const saved = project?.state.knowledgeSystem as { result?: KnowledgeResult } | undefined;
      if (project && saved?.result?.schema === 'skyview-knowledge-system-results') {
        setProjectId(project.id); setProjectTitle(project.title); setResult(saved.result);
        setSelectedDocumentId(saved.result.bundle.documents[0]?.id ?? ''); setSelectedChunkId(saved.result.bundle.chunks[0]?.id ?? '');
        setMessage('已打开最近的个人知识库项目。');
      }
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  const projectState = (next: KnowledgeResult = result) => ({ knowledgeSystem: { result: next } });
  const ensureProject = async () => {
    const existing = projects.find((project) => project.id === projectId);
    if (existing) return existing;
    const created = await toolApi.createProject('knowledge-system', projectTitle, projectState());
    setProjects((items) => [created, ...items]); setProjectId(created.id); return created;
  };
  const storeResult = async (project: WorkbenchProject, output: KnowledgeResult) => {
    setResult(output);
    if (!output.bundle.documents.some((item) => item.id === selectedDocumentId)) setSelectedDocumentId(output.bundle.documents[0]?.id ?? '');
    if (!output.bundle.chunks.some((item) => item.id === selectedChunkId)) setSelectedChunkId(output.bundle.chunks[0]?.id ?? '');
    const saved = await toolApi.updateProject(project.id, projectTitle, projectState(output));
    setProjects((items) => [saved, ...items.filter((item) => item.id !== saved.id)]);
  };
  const execute = async (action: string, extra: Record<string, unknown> = {}, bundleOverride = result.bundle): Promise<KnowledgeResult | null> => {
    if (!executionAllowed) return null;
    setRunning(true); setError(''); setMessage('Go 已登记作业，Python 正在更新知识索引与证据…');
    try {
      const project = await ensureProject();
      const input = action === 'import-backup' ? extra : { bundle: bundleOverride, ...extra };
      const created = await toolApi.createJob(project.id, 'knowledge-system', action, input, crypto.randomUUID());
      const job = await waitForJob(created.job.id);
      if (!job) throw new Error('作业仍在后台运行，请稍后重新打开项目。');
      if (job.status === 'failed') throw new Error(job.error || '知识计算失败。');
      if (job.status === 'canceled') throw new Error('作业已取消。');
      const output = job.result as KnowledgeResult;
      if (output.schema !== 'skyview-knowledge-system-results') throw new Error('服务端返回了不兼容的知识库结果。');
      await storeResult(project, output);
      setQuery(output.search.query); setMessage(action === 'run-all' ? '八个工作区已完成重建，检索、引用和备份均已更新。' : '知识库证据已更新。');
      return output;
    } catch (caught) {
      setError(caught instanceof ApiError || caught instanceof Error ? caught.message : '操作失败。'); setMessage(''); return null;
    } finally { setRunning(false); }
  };
  const saveProject = async () => {
    setSaving(true); setError('');
    try {
      const existing = projects.find((project) => project.id === projectId);
      const saved = existing ? await toolApi.updateProject(existing.id, projectTitle, projectState()) : await toolApi.createProject('knowledge-system', projectTitle, projectState());
      setProjects((items) => [saved, ...items.filter((item) => item.id !== saved.id)]); setProjectId(saved.id); setMessage('知识库项目已保存。');
    } catch (caught) { setError(caught instanceof Error ? caught.message : '保存失败。'); } finally { setSaving(false); }
  };
  const createVersion = async () => {
    setSaving(true); setError('');
    try { const project = await ensureProject(); await toolApi.createVersion(project.id, `知识库 v${result.bundle.workspace.version} · ${new Date().toLocaleString('zh-CN')}`, projectState()); setMessage('已创建不可变知识库版本。'); }
    catch (caught) { setError(caught instanceof Error ? caught.message : '创建版本失败。'); } finally { setSaving(false); }
  };
  const selectProject = (id: string) => {
    const project = projects.find((item) => item.id === id); setProjectId(id);
    if (!project) { const benchmark = createBenchmarkResult(); setResult(benchmark); setProjectTitle('地球科学研究知识库项目'); return; }
    const saved = project.state.knowledgeSystem as { result?: KnowledgeResult } | undefined;
    if (saved?.result?.schema === 'skyview-knowledge-system-results') { setResult(saved.result); setProjectTitle(project.title); setSelectedDocumentId(saved.result.bundle.documents[0]?.id ?? ''); setSelectedChunkId(saved.result.bundle.chunks[0]?.id ?? ''); }
  };
  const updateBundle = (change: (bundle: KnowledgeResult['bundle']) => void) => setResult((current) => { const next = structuredClone(current); change(next.bundle); next.bundle.workspace.updatedAt = new Date().toISOString(); return next; });
  const importFile = async (file?: File) => {
    if (!file) return;
    const extension = file.name.toLowerCase().split('.').pop() ?? '';
    if (file.size > 900_000) { setError('当前直传链路只接收小于 900 KB 的文件；大文件需等待对象存储接入。'); return; }
    if (!textFileTypes.has(extension) && !['pdf', 'docx'].includes(extension)) { setError(`暂不支持 .${extension} 文件。`); return; }
    await execute('ingest-file', { file: { name: file.name, mimeType: file.type, base64: await fileBase64(file) }, metadata: { tags: ingestTags.split(/[,，]/).map((item) => item.trim()).filter(Boolean), category: '研究资料', source: '文件上传' } });
    if (fileInput.current) fileInput.current.value = '';
  };
  const importBackup = async (file?: File) => { if (!file) return; await execute('import-backup', { backupBase64: await fileBase64(file) }); if (backupInput.current) backupInput.current.value = ''; };
  const exportBackup = async () => { const output = result.exports.backupBase64 ? result : await execute('export'); if (output?.exports.backupBase64) downloadBase64(output.exports.backupBase64, `${output.bundle.workspace.name}.zip`); };
  const downloadOriginal = (document: KnowledgeDocument) => document.contentBase64 ? downloadBase64(document.contentBase64, document.originalName, document.mimeType) : downloadText(document.extractedText, document.originalName, document.mimeType || 'text/plain;charset=utf-8');

  const documents = result.bundle.documents;
  const tags = [...new Set(documents.flatMap((document) => document.tags))].sort((left, right) => left.localeCompare(right, 'zh-CN'));
  const selectedDocument = documents.find((item) => item.id === selectedDocumentId) ?? documents[0];
  const documentChunks = result.bundle.chunks.filter((item) => item.documentId === selectedDocument?.id).sort((left, right) => left.order - right.order);
  const selectedChunk = result.bundle.chunks.find((item) => item.id === selectedChunkId) ?? documentChunks[0];
  const filteredDocuments = documents.filter((item) => !documentQuery || `${item.name} ${item.tags.join(' ')}`.toLowerCase().includes(documentQuery.toLowerCase()));
  const filteredNodes = result.graph.nodes.filter((node) => !graphQuery || node.name.toLowerCase().includes(graphQuery.toLowerCase()));
  const graphLayout = useMemo(() => {
    const positions = new Map<string, { x: number; y: number }>();
    filteredNodes.forEach((node, index) => { const angle = -Math.PI / 2 + index * Math.PI * 2 / Math.max(1, filteredNodes.length); const radius = 120 + (index % 3) * 38; positions.set(node.id, { x: 250 + Math.cos(angle) * radius, y: 190 + Math.sin(angle) * radius }); });
    return positions;
  }, [filteredNodes]);

  const addBenchmark = async () => {
    if (!benchmarkQuery.trim() || !benchmarkDocument) { setError('请填写评测问题并选择期望文档。'); return; }
    const bundle = structuredClone(result.bundle);
    bundle.workspace.benchmarks.push({ id: `benchmark-${Date.now()}`, query: benchmarkQuery.trim(), expectedDocumentId: benchmarkDocument, createdAt: new Date().toISOString() });
    setBenchmarkQuery(''); await execute('evaluate', {}, bundle);
  };
  const saveChunk = async (chunk: Chunk) => { const text = chunkDrafts[chunk.id] ?? chunk.text; const output = await execute('update-chunk', { chunkId: chunk.id, text }); if (output) setChunkDrafts((items) => { const next = { ...items }; delete next[chunk.id]; return next; }); };
  const removeDocument = async (id: string) => { await execute('delete-document', { documentId: id }); };

  return <div className="know-workbench">
    <header className="know-commandbar">
      <div className="know-project-switcher"><Database /><NativeSelect aria-label="选择知识库项目" value={projectId} onChange={(event) => selectProject(event.target.value)}><NativeSelectOption value="">当前本地项目</NativeSelectOption>{projects.map((project) => <NativeSelectOption key={project.id} value={project.id}>{project.title}</NativeSelectOption>)}</NativeSelect><Input aria-label="项目名称" value={projectTitle} onChange={(event) => setProjectTitle(event.target.value)} /></div>
      <div className="know-actions"><input ref={backupInput} hidden type="file" accept=".zip,application/zip" onChange={(event) => void importBackup(event.target.files?.[0])} /><Button size="sm" variant="outline" onClick={() => backupInput.current?.click()}><Upload />导入数据库</Button><Button size="sm" variant="outline" onClick={() => void exportBackup()}><Download />完整备份</Button><Button size="sm" variant="outline" onClick={() => void saveProject()} disabled={saving}>{saving ? <LoaderCircle className="spin" /> : <Save />}保存</Button><Button size="sm" variant="outline" onClick={() => void createVersion()}><Archive />建立版本</Button><Button size="sm" onClick={() => void execute('run-all')} disabled={running}>{running ? <LoaderCircle className="spin" /> : <Play />}重建全部</Button></div>
    </header>
    <section className="know-kpis">
      <article><FileText /><span>已入库资料</span><strong>{documents.length}</strong><small>{result.quality.indexedDocuments} 份可检索</small></article>
      <article><Boxes /><span>可引用分块</span><strong>{result.bundle.chunks.length}</strong><small>平均 {result.quality.averageChunk} 字</small></article>
      <article><ShieldCheck /><span>知识质量</span><strong>{result.quality.score}</strong><small>{result.quality.issues.length} 项待处理</small></article>
      <article><BookOpenCheck /><span>检索命中</span><strong>{percent(result.evaluation.hitAtK)}</strong><small>Top {result.evaluation.topK}</small></article>
      <article><Network /><span>平均倒数排名</span><strong>{result.evaluation.mrr.toFixed(3)}</strong><small>{result.evaluation.total} 条评测</small></article>
      <article><HardDrive /><span>原文件</span><strong>{formatBytes(result.storage.originalBytes)}</strong><small>SHA-256 去重</small></article>
    </section>
    <Tabs value={view} onValueChange={(value) => setView(value as typeof view)} className="know-tabs-shell"><TabsList className="know-tabs" variant="line">{views.map(([id, label], index) => <TabsTrigger key={id} value={id}><b>{String(index + 1).padStart(2, '0')}</b>{label}</TabsTrigger>)}</TabsList></Tabs>
    {(message || error) && <div className={`know-status ${error ? 'error' : ''}`}>{error ? <CircleAlert /> : <CheckCircle2 />}<span>{error || message}</span>{error && <button aria-label="关闭错误" onClick={() => setError('')}><X /></button>}</div>}
    <main className="know-stage">
      {view === 'dashboard' && <div className="know-view know-dashboard">
        <section className="know-surface know-health"><header><div><span>知识库健康</span><strong>{result.bundle.workspace.name}</strong><small>解析覆盖、标签完整度与重复片段综合评分</small></div><ScoreRing score={result.quality.score} /></header><div>{[['可检索资料', `${result.quality.indexedDocuments}/${result.quality.totalDocuments}`], ['平均分块', `${result.quality.averageChunk} 字`], ['标签覆盖', percent(result.quality.taggedRate)], ['重复片段', `${result.quality.duplicateGroups} 组`]].map(([label, value]) => <article key={label}><span>{label}</span><strong>{value}</strong></article>)}</div></section>
        <section className="know-surface know-boundary"><header><span>数据边界</span><strong>当前账号与项目隔离</strong></header><div><ShieldCheck /><p><b>Go 控制面</b><span>项目、会话、版本与审计</span></p></div><div><Database /><p><b>Python 计算面</b><span>固定解析、检索和评测</span></p></div><small>上传内容不执行，问答不调用外部 AI。</small></section>
        <section className="know-surface know-pipeline"><header><span>知识构建流水线</span><Button size="sm" onClick={() => setView('ingest')}><FilePlus2 />添加资料</Button></header><div>{[['01', '安全读取', '格式与 SHA'], ['02', '隔离解析', '文本与结构'], ['03', '结构分块', '标题与位置'], ['04', '混合索引', 'BM25 + 特征'], ['05', '引用问答', '原文回链']].map(([id, label, note], index) => <article key={id}><b>{id}</b><strong>{label}</strong><small>{note}</small>{index < 4 && <ChevronRight />}</article>)}</div></section>
        <section className="know-surface know-recent"><header><span>最近入库</span><button onClick={() => setView('documents')}>查看全部</button></header><div>{documents.slice(0, 4).map((document) => <button key={document.id} onClick={() => { setSelectedDocumentId(document.id); setSelectedChunkId(result.bundle.chunks.find((item) => item.documentId === document.id)?.id ?? ''); setView('documents'); }}><b>{document.extension.toUpperCase()}</b><span><strong>{document.name}</strong><small>{document.category} · v{document.version}</small></span><em>{result.bundle.chunks.filter((item) => item.documentId === document.id).length} 块</em></button>)}</div></section>
        <section className="know-surface know-concepts"><header><span>高频概念</span><button onClick={() => setView('graph')}>查看关系</button></header><div>{result.graph.nodes.slice(0, 12).map((node) => <button key={node.id} onClick={() => { setQuery(node.name); setView('retrieval'); }}>{node.name}<small>{node.count}</small></button>)}</div></section>
        <section className="know-surface know-activity"><header><span>构建记录</span><strong>最近 {result.bundle.workspace.ingestionHistory.length} 条</strong></header><div>{result.bundle.workspace.ingestionHistory.slice(0, 5).map((item) => <article key={item.id}><CheckCircle2 /><span><strong>{item.name}</strong><small>{item.message}</small></span><time>{formatTime(item.createdAt)}</time></article>)}</div></section>
      </div>}

      {view === 'ingest' && <div className="know-view know-ingest">
        <section className="know-surface know-drop"><header><span>文件入库</span><strong>解析、去重、分块和索引一次完成</strong></header><input ref={fileInput} hidden type="file" accept=".pdf,.docx,.txt,.md,.markdown,.csv,.tsv,.json,.jsonl,.html,.htm,.xml,.rtf,.log,.tex,.bib,.py,.js,.ts,.css,.yaml,.yml,.sql,text/*" onChange={(event) => void importFile(event.target.files?.[0])} /><button className="know-dropzone" onClick={() => fileInput.current?.click()}><Upload /><strong>选择研究文件</strong><span>PDF、DOCX、表格、JSON、HTML/XML、RTF 与纯文本</span></button><div className="know-field"><span>入库标签</span><Input aria-label="入库标签" value={ingestTags} onChange={(event) => setIngestTags(event.target.value)} /></div><div className="know-format-list">{['PDF', 'DOCX', 'CSV/TSV', 'JSON/JSONL', 'HTML/XML', 'RTF', 'Markdown', '代码/文本'].map((item) => <span key={item}>{item}</span>)}</div><small className="know-runtime-note">扫描 PDF 需要 OCR；大文件将在对象存储接入后开放直传。</small></section>
        <section className="know-surface know-note"><header><span>新建研究笔记</span><strong>直接进入同一检索与版本流程</strong></header><div className="know-field"><span>文件名称</span><Input aria-label="笔记文件名称" value={noteName} onChange={(event) => setNoteName(event.target.value)} /></div><label><span>笔记正文</span><textarea value={noteText} onChange={(event) => setNoteText(event.target.value)} /></label><Button onClick={() => void execute('ingest-text', { name: noteName, text: noteText, metadata: { tags: ingestTags.split(/[,，]/).map((item) => item.trim()).filter(Boolean), category: '研究笔记', source: '在线编辑' } })} disabled={running}><FilePlus2 />保存并建立索引</Button></section>
        <section className="know-surface know-ingest-history"><header><span>入库记录</span><strong>成功与失败均保留证据</strong></header><div>{result.bundle.workspace.ingestionHistory.map((item) => <article key={item.id}><span className={item.status}>{item.status === 'success' ? '完成' : '失败'}</span><div><strong>{item.name}</strong><small>{item.message}</small></div><time>{formatTime(item.createdAt)}</time></article>)}</div></section>
      </div>}

      {view === 'documents' && <div className="know-view know-documents">
        <aside className="know-surface know-doc-rail"><header><span>文档目录</span><strong>{documents.length} 份资料</strong></header><div className="know-filter"><Search /><Input aria-label="筛选文档" placeholder="名称或标签" value={documentQuery} onChange={(event) => setDocumentQuery(event.target.value)} /></div><nav>{filteredDocuments.map((document) => <button className={document.id === selectedDocument?.id ? 'active' : ''} key={document.id} onClick={() => { setSelectedDocumentId(document.id); setSelectedChunkId(result.bundle.chunks.find((item) => item.documentId === document.id)?.id ?? ''); }}><b>{document.extension.toUpperCase()}</b><span><strong>{document.name}</strong><small>{document.tags.join(' · ')}</small></span><em>v{document.version}</em></button>)}</nav></aside>
        {selectedDocument && <section className="know-surface know-doc-main"><header><div><span>{selectedDocument.category}</span><strong>{selectedDocument.name}</strong><small>{selectedDocument.parser} · {formatBytes(selectedDocument.size)} · {selectedDocument.hash.slice(0, 12)}…</small></div><div><Button size="sm" variant="outline" onClick={() => downloadOriginal(selectedDocument)}><Download />原文件</Button><Button size="sm" variant="outline" onClick={() => void execute('reindex-document', { documentId: selectedDocument.id })}><RefreshCw />重建索引</Button><Button size="sm" variant="outline" className="danger" onClick={() => void removeDocument(selectedDocument.id)}><Trash2 />删除</Button></div></header><div className="know-doc-meta">{[['状态', '可检索'], ['版本', `v${selectedDocument.version}`], ['字符', selectedDocument.textLength.toLocaleString('zh-CN')], ['分块', String(documentChunks.length)], ['语言', selectedDocument.language], ['来源', selectedDocument.source]].map(([label, value]) => <article key={label}><span>{label}</span><strong>{value}</strong></article>)}</div><div className="know-chunk-tabs">{documentChunks.map((chunk) => <button className={chunk.id === selectedChunk?.id ? 'active' : ''} key={chunk.id} onClick={() => setSelectedChunkId(chunk.id)}><b>{String(chunk.order + 1).padStart(2, '0')}</b><span>{chunk.heading}</span><small>{chunk.charCount} 字</small></button>)}</div>{selectedChunk && <div className="know-chunk-editor"><header><span>{selectedChunk.sourceLocation}</span><strong>{selectedChunk.heading}</strong><small>{selectedChunk.tokenCount} 个检索特征 · 文档 v{selectedChunk.version}</small></header><textarea value={chunkDrafts[selectedChunk.id] ?? selectedChunk.text} onChange={(event) => setChunkDrafts((items) => ({ ...items, [selectedChunk.id]: event.target.value }))} /><footer><div>{selectedChunk.keywords.map((item) => <span key={item}>{item}</span>)}</div><Button size="sm" onClick={() => void saveChunk(selectedChunk)}><Save />保存分块版本</Button></footer></div>}</section>}
      </div>}

      {view === 'retrieval' && <div className="know-view know-retrieval">
        <section className="know-surface know-searchbar"><header><span>混合检索</span><strong>BM25、标题短语与可解释字符特征共同排序</strong></header><div><Input aria-label="检索问题" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void execute('search', { query, documentId: documentFilter, tag: tagFilter }); }} /><NativeSelect aria-label="筛选文档" value={documentFilter} onChange={(event) => setDocumentFilter(event.target.value)}><NativeSelectOption value="all">全部文档</NativeSelectOption>{documents.map((document) => <NativeSelectOption key={document.id} value={document.id}>{document.name}</NativeSelectOption>)}</NativeSelect><NativeSelect aria-label="筛选标签" value={tagFilter} onChange={(event) => setTagFilter(event.target.value)}><NativeSelectOption value="">全部标签</NativeSelectOption>{tags.map((tag) => <NativeSelectOption key={tag} value={tag}>{tag}</NativeSelectOption>)}</NativeSelect><Button onClick={() => void execute('search', { query, documentId: documentFilter, tag: tagFilter })}><Search />检索</Button></div><footer>{[['Top K', result.bundle.workspace.settings.topK], ['BM25 权重', percent(result.bundle.workspace.settings.bm25Weight)], ['字符特征', percent(1 - result.bundle.workspace.settings.bm25Weight)], ['最低分', result.bundle.workspace.settings.threshold.toFixed(2)], ['当前命中', result.search.results.length]].map(([label, value]) => <span key={label}>{label}<b>{value}</b></span>)}</footer></section>
        <section className="know-surface know-ranked"><header><div><span>排序证据</span><strong>{result.search.results.length} 个可引用分块</strong></div><Button size="sm" onClick={() => { setView('qa'); void execute('ask', { query, documentId: documentFilter, tag: tagFilter }); }}><Sparkles />用证据回答</Button></header><div>{result.search.results.map((item, index) => <article key={item.id}><header><b>[{index + 1}]</b><span><strong>{item.documentName}</strong><small>{item.heading} · {item.sourceLocation}</small></span><em>{percent(item.score)}</em></header><p>{item.text}</p><div className="know-score-bars"><span>BM25<i><b style={{ width: percent(item.bm25Score) }} /></i><strong>{percent(item.bm25Score)}</strong></span><span>字符特征<i><b style={{ width: percent(item.vectorScore) }} /></i><strong>{percent(item.vectorScore)}</strong></span></div><footer><div>{item.matchedTerms.map((term) => <span key={term}>{term}</span>)}</div><button onClick={() => { setSelectedDocumentId(item.documentId); setSelectedChunkId(item.id); setView('documents'); }}>打开原分块</button><button onClick={() => void navigator.clipboard.writeText(`[${item.documentName}，${item.heading}，${item.sourceLocation}] ${item.text}`)}><Copy />复制引用</button></footer></article>)}</div></section>
        <aside className="know-surface know-saved"><header><span>已保存检索</span><strong>{result.bundle.workspace.savedQueries.length}</strong></header>{result.bundle.workspace.savedQueries.map((item) => <button key={item.id} onClick={() => setQuery(item.query)}><Search /><span><strong>{item.query}</strong><small>{item.tag || '全部标签'}</small></span></button>)}<div><b>排序说明</b><span>分数来自文本统计和确定性特征，不调用远程嵌入模型。</span></div></aside>
      </div>}

      {view === 'qa' && <div className="know-view know-qa">
        <aside className="know-surface know-question"><header><span>证据问答</span><strong>只从命中原文抽取</strong></header><label><span>你的问题</span><textarea value={query} onChange={(event) => setQuery(event.target.value)} /></label><Button onClick={() => void execute('ask', { query, documentId: documentFilter, tag: tagFilter })}><Search />检索并回答</Button><div className="know-history"><strong>历史问答</strong>{result.bundle.conversations.map((item) => <button key={item.id} onClick={() => setQuery(item.query)}><span>{item.query}</span><small>{item.citations.length} 条引用 · {formatTime(item.createdAt)}</small></button>)}</div></aside>
        <section className="know-surface know-answer"><header><div><span>基于原文的回答</span><strong>{result.answer.query}</strong><small>置信度 {percent(result.answer.confidence)} · {result.answer.evidenceCount} 条证据句 · {result.answer.sourceCount} 份来源</small></div><Button size="sm" variant="outline" onClick={() => downloadText(result.exports.answerMarkdown, '知识库问答.md', 'text/markdown;charset=utf-8')}><Download />导出回答</Button></header><div className="know-answer-body">{result.answer.answer.split('\n').map((line, index) => <p key={`${line}-${index}`}>{line}</p>)}</div><div className="know-citations"><strong>引用原文</strong>{result.answer.citations.map((citation) => <article key={citation.chunkId}><b>[{citation.index}]</b><div><strong>{citation.documentName}</strong><small>{citation.heading} · {citation.sourceLocation} · 相关度 {percent(citation.score)}</small><p>{citation.excerpt}</p></div><button onClick={() => { setSelectedDocumentId(citation.documentId); setSelectedChunkId(citation.chunkId); setView('documents'); }}>打开</button></article>)}</div></section>
      </div>}

      {view === 'graph' && <div className="know-view know-graph">
        <section className="know-surface know-graph-main"><header><div><span>可解释概念图</span><strong>节点来自高频词，连线表示同一分块共现</strong></div><div><Input aria-label="筛选概念" placeholder="筛选概念" value={graphQuery} onChange={(event) => setGraphQuery(event.target.value)} /><Button size="sm" variant="outline" onClick={() => downloadText(result.exports.graphJson, '知识概念图.json', 'application/json;charset=utf-8')}><Download />导出图谱</Button></div></header><div className="know-graph-canvas"><svg viewBox="0 0 500 380" aria-label="知识概念关系图">{result.graph.edges.map((edge) => { const left = graphLayout.get(edge.source); const right = graphLayout.get(edge.target); return left && right ? <line key={edge.id} x1={left.x} y1={left.y} x2={right.x} y2={right.y} style={{ strokeWidth: 1 + edge.weight }} /> : null; })}{filteredNodes.map((node) => { const point = graphLayout.get(node.id)!; return <g key={node.id} transform={`translate(${point.x} ${point.y})`} onClick={() => { setQuery(node.name); setView('retrieval'); }}><circle r={18 + Math.min(12, node.count * 3)} /><text y="4">{node.name}</text></g>; })}</svg></div></section>
        <aside className="know-surface know-edge-list"><header><span>最强共现关系</span><strong>{result.graph.edges.length} 条</strong></header><div>{result.graph.edges.slice(0, 18).map((edge) => <button key={edge.id} onClick={() => { setQuery(`${edge.source} ${edge.target}`); setView('retrieval'); }}><span>{edge.source}</span><GitBranch /><span>{edge.target}</span><b>{edge.weight}</b></button>)}</div></aside>
      </div>}

      {view === 'quality' && <div className="know-view know-quality">
        <section className="know-surface know-quality-score"><header><div><span>知识库质量</span><strong>解析、覆盖、标签、重复与检索效果</strong></div><ScoreRing score={result.quality.score} /></header><div>{[['可检索覆盖', `${result.quality.indexedDocuments}/${result.quality.totalDocuments}`], ['平均分块', result.quality.averageChunk], ['标签覆盖', percent(result.quality.taggedRate)], ['重复组', result.quality.duplicateGroups]].map(([label, value]) => <article key={label}><span>{label}</span><strong>{value}</strong></article>)}</div><section>{result.quality.issues.length ? result.quality.issues.map((item) => <p key={`${item.documentId}-${item.message}`} className={item.severity}><CircleAlert />{item.message}</p>) : <p className="success"><CheckCircle2 />未发现知识质量问题</p>}</section></section>
        <section className="know-surface know-settings"><header><span>分块与检索策略</span><strong>修改后对文档重建索引</strong></header><div>{([['chunkSize', '目标分块字符数', 200, 6000, 50], ['chunkOverlap', '重叠字符数', 0, 2500, 10], ['bm25Weight', 'BM25 权重', 0, 1, .05], ['threshold', '最低相关度', 0, 1, .01], ['topK', '返回数量', 1, 50, 1], ['maxAnswerSentences', '回答证据句', 1, 10, 1]] as const).map(([key, label, min, max, step]) => <div className="know-field" key={key}><span>{label}</span><Input aria-label={label} type="number" min={min} max={max} step={step} value={result.bundle.workspace.settings[key]} onChange={(event) => updateBundle((bundle) => { bundle.workspace.settings[key] = Number(event.target.value); })} /></div>)}</div><small>字符特征是可解释的本地近似检索，不标记为神经网络语义嵌入。</small></section>
        <section className="know-surface know-benchmark"><header><div><span>检索评测集</span><strong>Hit@K {percent(result.evaluation.hitAtK)} · MRR {result.evaluation.mrr.toFixed(3)}</strong></div><Button size="sm" onClick={() => void execute('evaluate')}><Play />重新评测</Button></header><div className="know-benchmark-form"><Input aria-label="评测问题" placeholder="评测问题" value={benchmarkQuery} onChange={(event) => setBenchmarkQuery(event.target.value)} /><NativeSelect aria-label="期望文档" value={benchmarkDocument} onChange={(event) => setBenchmarkDocument(event.target.value)}>{documents.map((document) => <NativeSelectOption key={document.id} value={document.id}>{document.name}</NativeSelectOption>)}</NativeSelect><Button onClick={() => void addBenchmark()}><Plus />添加评测</Button></div><div className="know-benchmark-list">{result.evaluation.details.map((item) => <article key={item.id}><b className={item.hit ? 'pass' : 'fail'}>{item.hit ? `排名 ${item.rank}` : '未命中'}</b><span><strong>{item.query}</strong><small>期望：{documents.find((document) => document.id === item.expectedDocumentId)?.name ?? '文档已删除'}</small></span><em>RR {item.reciprocalRank.toFixed(3)}</em><button onClick={() => { setQuery(item.query); setView('retrieval'); }}>查看结果</button></article>)}</div></section>
      </div>}

      {view === 'archive' && <div className="know-view know-archive">
        <section className="know-surface know-profile"><header><span>知识库信息</span><strong>当前项目的数据与版本边界</strong></header><div className="know-field"><span>知识库名称</span><Input aria-label="知识库名称" value={result.bundle.workspace.name} onChange={(event) => updateBundle((bundle) => { bundle.workspace.name = event.target.value; })} /></div><label><span>用途说明</span><textarea value={result.bundle.workspace.description} onChange={(event) => updateBundle((bundle) => { bundle.workspace.description = event.target.value; })} /></label><div><Button onClick={() => void saveProject()}><Save />保存资料库</Button><Button variant="outline" onClick={() => void createVersion()}><Archive />不可变版本</Button></div></section>
        <section className="know-surface know-storage"><header><span>存储与完整性</span><strong>{formatBytes(result.storage.originalBytes)} 原文件</strong></header><div>{[['文档', result.storage.documents], ['分块', result.storage.chunks], ['版本', `v${result.bundle.workspace.version}`], ['备份包', result.exports.backupBytes ? formatBytes(result.exports.backupBytes) : '待生成']].map(([label, value]) => <article key={label}><span>{label}</span><strong>{value}</strong></article>)}</div><p><ShieldCheck /><span><b>每份原件 SHA-256 去重</b><small>完整备份为每个条目生成校验和。</small></span></p><p><Link2 /><span><b>导入重新绑定当前项目</b><small>文档、分块与引用全部生成新的标识。</small></span></p></section>
        <section className="know-surface know-revisions"><header><span>版本与修改记录</span><strong>{result.bundle.revisions.length} 条</strong></header><div>{result.bundle.revisions.length ? result.bundle.revisions.map((revision) => <article key={revision.id}><b>{revision.type === 'reindex' ? '重建' : '编辑'}</b><span><strong>{revision.documentName}</strong><small>{revision.note}</small></span><em>v{revision.fromVersion} → v{revision.toVersion}</em><time>{formatTime(revision.createdAt)}</time></article>) : <div className="know-empty">尚无人工修改版本。</div>}</div></section>
        <section className="know-surface know-delivery"><header><span>数据库交付</span><strong>原件、索引、问答、版本和校验和</strong></header><div><button className="primary" onClick={() => void exportBackup()}><FileArchive /><strong>完整数据库备份</strong><small>ZIP + SHA-256</small></button><button onClick={() => downloadText(result.exports.documentsCsv, '知识库文档目录.csv', 'text/csv;charset=utf-8')}><FileText /><strong>文档目录</strong><small>CSV</small></button><button onClick={() => downloadText(result.exports.chunksJson, '知识库分块.json', 'application/json;charset=utf-8')}><Boxes /><strong>检索分块</strong><small>JSON</small></button><button onClick={() => downloadText(result.exports.qualityJson, '知识库质量评测.json', 'application/json;charset=utf-8')}><BookOpenCheck /><strong>质量评测</strong><small>JSON</small></button><button onClick={() => downloadText(result.exports.manifestJson, '知识库清单.json', 'application/json;charset=utf-8')}><FileSearch /><strong>交付清单</strong><small>JSON</small></button><button onClick={() => backupInput.current?.click()}><FolderOpen /><strong>恢复数据库</strong><small>校验后导入</small></button></div></section>
      </div>}
    </main>
  </div>;
}
