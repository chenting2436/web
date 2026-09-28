'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArchiveRestore,
  Bot,
  CheckCircle2,
  CircleAlert,
  Database,
  Download,
  FileArchive,
  FileCheck2,
  FileSearch,
  FileText,
  Gauge,
  History,
  LoaderCircle,
  MessageSquareText,
  Play,
  RotateCcw,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  Upload,
  WandSparkles,
} from 'lucide-react';
import { useLanguage } from '@/components/language-provider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toolApi, type WorkbenchJob, type WorkbenchProject } from '@/services/api/tools';

type MaterialChunk = {
  id: string; label: string; text: string; words: number; locator: string; checksum: string;
  enabled: boolean; materialId: string;
};
type Material = {
  id: string; sequence: number; name: string; type: string; bytes: number; status: string;
  checksum: string; selected: boolean; warnings: string[]; chunks: MaterialChunk[];
};
type ReportVersion = {
  id: string; number: number; label: string; kind: string; actor: string; createdAt: string;
  content: string; reportChecksum: string; model: string; mode: string;
};
type ChatMessage = {
  id: string; role: 'user' | 'assistant'; content: string; createdAt: string;
  evidenceChunkIds: string[]; model?: string; mode?: string;
};
type AuditIssue = { id: string; severity: string; category: string; message: string; action: string; evidence: string };
type AiReportProject = {
  schema: string; version: number; id: string; title: string; course: string; status: string;
  config: {
    reportType: string; audience: string; tone: string; language: string; length: string;
    objective: string; instruction: string; sections: string[]; retrievalLimit: number; chunkChars: number;
  };
  settings: { mode: string; localModel: string; temperature: number; topP: number; maxTokens: number };
  materials: Material[]; selectedMaterialIds: string[]; activeMaterialId: string; chats: ChatMessage[];
  report: { content: string; status: string; model: string; mode: string; evidenceChunkIds: string[]; evidenceChecksum: string };
  versions: ReportVersion[]; activities: Array<{ id: string; type: string; message: string; actor: string; createdAt: string }>;
};
type ReportType = { id: string; name: string; sections: string[] };
type Evidence = MaterialChunk & { materialName: string; score: number };
type AiReportResult = {
  schema: string; version: number; stage: string; project: AiReportProject;
  analysis: {
    metrics: { materials: number; selectedMaterials: number; chunks: number; reportWords: number; citations: number; coverage: number; versions: number; qualityScore: number };
    audit: { id: string; passed: boolean; score: number; issues: AuditIssue[]; stats: Record<string, number> };
    qualityChecks: Array<{ label: string; passed: boolean }>;
    coverageByMaterial: Array<{ materialId: string; name: string; chunks: number; used: number; coverage: number }>;
    sourceIndex: Array<{ label: string; chunkId: string; materialName: string; locator: string; checksum: string; used: boolean; excerpt: string }>;
    evidence: Evidence[];
    localPrompt: { system: string; user: string; evidenceChunkIds: string[]; promptChecksum: string; evidenceChecksum: string };
    reportTypes: ReportType[];
    localModels: Array<{ id: string; name: string; memory: string; licenseStatus: string }>;
  };
  runtime: Record<string, { status?: string; engine?: string; downloadsModelOnConsent?: boolean } | boolean>;
  exports: { markdown: string; html: string; text: string; sourceIndexJson: string; auditJson: string; projectJson: string; docxBase64: string; packageBase64: string };
};

const views = [
  ['dashboard', '总览', 'Overview', Gauge],
  ['materials', '材料与证据', 'Sources', Database],
  ['chat', '证据问答', 'Evidence chat', MessageSquareText],
  ['report', '完整报告', 'Report', FileText],
  ['audit', '报告核验', 'Audit', ShieldCheck],
  ['versions', '版本', 'Versions', History],
  ['export', '交付', 'Delivery', FileArchive],
  ['settings', '设置', 'Settings', Settings2],
] as const;

function sampleResult(): AiReportResult {
  const now = '2026-09-15T02:30:00Z';
  const sourceTexts = [
    ['现场巡查记录.md', '2026年8月18日，北区边坡排水沟局部淤堵，坡脚可见持续渗水。裂缝测点 F-03 宽度为 18 mm，较上次巡查增加 3 mm。'],
    ['监测摘要.csv', '2026-08-16 至 2026-08-19，72 小时累计降雨由 42 mm 增至 126 mm；F-03 位移速率由 0.8 mm/d 增至 3.4 mm/d。'],
    ['分析方法说明.md', '位移速率采用24小时滑动差分，累计降雨窗口为72小时。位移速率超过 3.0 mm/d 时进入人工复核，不直接触发工程安全决策。'],
    ['教师核验记录.txt', '材料支持降雨与位移加速同期出现，但不足以证明单一因果关系。处置建议必须保留现场工程师复核入口。'],
  ] as const;
  const materials: Material[] = sourceTexts.map(([name, text], index) => {
    const id = `material-${index + 1}`;
    return {
      id, sequence: index + 1, name, type: name.endsWith('.csv') ? 'text/csv' : 'text/markdown', bytes: text.length * 3,
      status: 'ready', checksum: `sample-${index + 1}-sha256`, selected: true, warnings: [],
      chunks: [{ id: `${id}-chunk-1`, materialId: id, label: `S${index + 1}.1`, text, words: text.length, locator: '文本片段 1', checksum: `chunk-${index + 1}-sha256`, enabled: true }],
    };
  });
  const report = `# 边坡监测证据解释与课程报告

## 分析目标

解释连续降雨、位移加速与现场排水条件之间的证据关系，并区分材料事实与分析推断。 [S4.1]

## 数据说明

材料包括现场巡查、连续监测、分析方法和教师核验记录。 [S1.1] [S2.1]

## 质量检查

位移采用 24 小时滑动差分，降雨采用 72 小时窗口；数值需与原始记录复核。 [S3.1]

## 分析方法

使用时间对齐和多源交叉核验，不把同期变化直接解释为因果关系。 [S3.1] [S4.1]

## 核心结果

累计降雨由 42 mm 增至 126 mm，位移速率由 0.8 mm/d 增至 3.4 mm/d。 [S2.1]

## 可视化解读

时间序列显示降雨累积与位移加速同期出现，现场同时存在排水沟淤堵和坡脚渗水。 [S1.1] [S2.1]

## 不确定性

现有材料不足以证明单一因果关系；施工扰动、仪器状态和缺测仍需人工复核。 [S3.1] [S4.1]

## 结论与建议

先疏通排水沟、复核渗水点和监测设备，并由工程师确认是否升级响应。 [S1.1] [S4.1]

## 来源索引

${materials.map((item) => `- [S${item.sequence}.1] ${item.name} · 文本片段 1`).join('\n')}`;
  const sections = ['分析目标', '数据说明', '质量检查', '分析方法', '核心结果', '可视化解读', '不确定性', '结论与建议', '来源索引'];
  const project: AiReportProject = {
    schema: 'skyview-ai-report-project', version: 3, id: 'report-project-slope-monitoring', title: '边坡监测证据解释与课程报告',
    course: '工程地质与灾害监测', status: 'active',
    config: { reportType: 'analysis', audience: '工程地质课程学生', tone: '严谨、清晰、证据优先', language: 'zh-CN', length: 'detailed', objective: '解释连续降雨、位移加速与现场排水条件之间的证据关系', instruction: '区分事实与推断；数值、时序和因果陈述必须引用证据。', sections, retrievalLimit: 12, chunkChars: 1200 },
    settings: { mode: 'extractive', localModel: 'Qwen3-1.7B-q4f16_1-MLC', temperature: 0.2, topP: 0.9, maxTokens: 2048 },
    materials, selectedMaterialIds: materials.map((item) => item.id), activeMaterialId: materials[0].id,
    chats: [
      { id: 'chat-1', role: 'user', content: '材料是否能证明降雨导致边坡失稳？', createdAt: now, evidenceChunkIds: [] },
      { id: 'chat-2', role: 'assistant', content: '只能支持同期出现，尚不足以证明单一因果关系。 [S4.1]', createdAt: now, evidenceChunkIds: ['material-4-chunk-1'], model: '证据整理引擎', mode: 'extractive-server' },
    ],
    report: { content: report, status: 'ready', model: '证据整理引擎', mode: 'extractive-server', evidenceChunkIds: materials.map((item) => item.chunks[0].id), evidenceChecksum: 'sample-evidence' },
    versions: [{ id: 'version-1', number: 1, label: '首轮证据报告', kind: 'generation', actor: '课程教师', createdAt: now, content: report, reportChecksum: 'sample-report', model: '证据整理引擎', mode: 'extractive-server' }],
    activities: [{ id: 'activity-1', type: 'generation', message: '生成首轮证据报告', actor: '课程教师', createdAt: now }, { id: 'activity-2', type: 'material', message: '4 份课程材料完成索引', actor: '课程教师', createdAt: now }],
  };
  const reportTypes = [
    ['explain', '概念解释'], ['lab', '实验报告'], ['code', '代码解释'], ['paper', '论文精读'],
    ['lesson', '课程讲义'], ['analysis', '数据分析报告'], ['project', '项目复盘'], ['custom', '自定义报告'],
  ].map(([id, name]) => ({ id, name, sections }));
  const evidence = materials.map((material) => ({ ...material.chunks[0], materialName: material.name, score: 18 - material.sequence }));
  return {
    schema: 'skyview-ai-report-results', version: 3, stage: 'load-sample', project,
    analysis: {
      metrics: { materials: 4, selectedMaterials: 4, chunks: 4, reportWords: 432, citations: 4, coverage: 100, versions: 1, qualityScore: 100 },
      audit: { id: 'audit-1', passed: true, score: 100, issues: [], stats: { words: 432, citations: 4, validCitations: 4, invalidCitations: 0, coverage: 100, missingSections: 0, uncitedNumericLines: 0 } },
      qualityChecks: ['已选择至少一份可用材料', '报告正文已形成', '所有片段引用均可解析', '数值陈述均有片段引用', '目标章节结构完整', '报告包含局限与不确定性', '至少保留一个不可变报告版本'].map((label) => ({ label, passed: true })),
      coverageByMaterial: materials.map((item) => ({ materialId: item.id, name: item.name, chunks: 1, used: 1, coverage: 100 })),
      sourceIndex: evidence.map((item) => ({ label: item.label, chunkId: item.id, materialName: item.materialName, locator: item.locator, checksum: item.checksum, used: true, excerpt: item.text })),
      evidence,
      localPrompt: { system: '仅根据提供的证据生成报告，事实与数值必须标注片段编号。', user: `生成完整《${project.title}》。`, evidenceChunkIds: evidence.map((item) => item.id), promptChecksum: 'sample-prompt', evidenceChecksum: 'sample-evidence' },
      reportTypes,
      localModels: [
        { id: 'Qwen3-0.6B-q4f16_1-MLC', name: 'Qwen3 0.6B · 快速', memory: '约 1–2 GB 显存', licenseStatus: '模型许可证需部署方核验' },
        { id: 'Qwen3-1.7B-q4f16_1-MLC', name: 'Qwen3 1.7B · 均衡', memory: '约 2–4 GB 显存', licenseStatus: '模型许可证需部署方核验' },
      ],
    },
    runtime: {
      serverEvidenceEngine: { status: 'enabled', engine: 'Python 确定性证据检索与核验' },
      goControlPlane: { status: 'enabled', engine: 'Go 项目、作业、版本与审计边界' },
      browserWebLLM: { status: 'browser-opt-in', engine: 'WebLLM 0.2.85 Web Worker / WebGPU', downloadsModelOnConsent: true },
      enterpriseAiGateway: { status: 'not-configured', engine: '仅允许服务端凭据' },
      ocrLayoutParser: { status: 'not-configured', engine: '扫描 PDF 与复杂版面解析' },
      arbitraryCodeExecution: false,
    },
    exports: { markdown: report, html: '', text: '', sourceIndexJson: '', auditJson: '', projectJson: '', docxBase64: '', packageBase64: '' },
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

function timeLabel(value: string, locale: string) {
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? value : time.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function AiReportWorkbench({ executionAllowed }: { executionAllowed: boolean }) {
  const { text, locale } = useLanguage();
  const [result, setResult] = useState<AiReportResult>(() => sampleResult());
  const [view, setView] = useState<(typeof views)[number][0]>('dashboard');
  const [projects, setProjects] = useState<WorkbenchProject[]>([]);
  const [projectId, setProjectId] = useState('');
  const projectIdRef = useRef('');
  const [projectTitle, setProjectTitle] = useState('边坡监测证据解释与课程报告');
  const [reportDraft, setReportDraft] = useState(result.project.report.content);
  const [question, setQuestion] = useState('材料是否足以支持当前结论？');
  const [pasteText, setPasteText] = useState('');
  const [url, setUrl] = useState('');
  const [activeVersion, setActiveVersion] = useState(result.project.versions[0]?.id ?? '');
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState('完整证据报告基准已载入，可直接核验、编辑、问答和导出。');
  const [error, setError] = useState('');
  const [localState, setLocalState] = useState<'idle' | 'loading' | 'ready' | 'generating' | 'stopped'>('idle');
  const [localProgress, setLocalProgress] = useState('');
  const importMaterialRef = useRef<HTMLInputElement>(null);
  const importProjectRef = useRef<HTMLInputElement>(null);
  const localEngineRef = useRef<{ chat: { completions: { create: (input: Record<string, unknown>) => Promise<unknown> } }; interruptGenerate?: () => void; unload?: () => Promise<void> } | null>(null);
  const localWorkerRef = useRef<Worker | null>(null);

  const activeMaterial = result.project.materials.find((item) => item.id === result.project.activeMaterialId) ?? result.project.materials[0];
  const selectedVersion = result.project.versions.find((item) => item.id === activeVersion) ?? result.project.versions.at(-1);
  const qualityPassed = result.analysis.qualityChecks.filter((item) => item.passed).length;
  const reportSections = useMemo(() => result.project.config.sections.map((name) => ({ name, present: new RegExp(`^##\\s+.*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm').test(reportDraft) })), [reportDraft, result.project.config.sections]);

  useEffect(() => {
    let active = true;
    toolApi.listProjects('ai-report').then((items) => {
      if (!active) return;
      setProjects(items);
      const first = items[0];
      const saved = first?.state.aiReport as { result?: AiReportResult } | undefined;
      if (first && saved?.result?.schema === 'skyview-ai-report-results') {
        projectIdRef.current = first.id; setProjectId(first.id); setProjectTitle(first.title); setResult(saved.result); setReportDraft(saved.result.project.report.content);
        setActiveVersion(saved.result.project.versions.at(-1)?.id ?? '');
      }
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  useEffect(() => () => { localEngineRef.current?.interruptGenerate?.(); localWorkerRef.current?.terminate(); }, []);

  const projectState = (next = result) => ({ aiReport: { result: next } });
  const ensureProject = async () => {
    const existing = projects.find((item) => item.id === projectIdRef.current || item.id === projectId);
    if (existing) return existing;
    const created = await toolApi.createProject('ai-report', projectTitle, projectState());
    projectIdRef.current = created.id; setProjects((items) => [created, ...items]); setProjectId(created.id); return created;
  };
  const storeResult = async (project: WorkbenchProject, output: AiReportResult) => {
    setResult(output); setReportDraft(output.project.report.content); setActiveVersion(output.project.versions.at(-1)?.id ?? '');
    const saved = await toolApi.updateProject(project.id, projectTitle, projectState(output));
    setProjects((items) => [saved, ...items.filter((item) => item.id !== saved.id)]);
  };
  const execute = async (action: string, extra: Record<string, unknown> = {}) => {
    if (!executionAllowed) { setError(text('AI 报告计算服务当前不可用。', 'AI report service is unavailable.')); return null; }
    setRunning(true); setError(''); setMessage(text('Go 已登记作业，Python 正在整理证据并刷新核验结果…', 'Job registered; refreshing evidence and audit…'));
    try {
      const project = await ensureProject();
      const created = await toolApi.createJob(project.id, 'ai-report', action, { state: result, actor: '当前报告编辑', actorRole: 'owner', ...extra }, crypto.randomUUID());
      const job = await waitForJob(created.job.id);
      if (!job) throw new Error(text('作业仍在后台运行。', 'The job is still running.'));
      if (job.status !== 'succeeded') throw new Error(job.error || text('AI 报告作业失败。', 'AI report job failed.'));
      const output = job.result as AiReportResult;
      if (output.schema !== 'skyview-ai-report-results') throw new Error(text('服务端结果不兼容。', 'Incompatible server result.'));
      await storeResult(project, output);
      setMessage(text('已保存项目状态、证据索引、核验结果和交付文件。', 'Project, evidence, audit, and delivery files saved.'));
      return output;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : text('操作失败。', 'Operation failed.'));
      return null;
    } finally { setRunning(false); }
  };
  const createSnapshot = async () => {
    const label = `人工快照 ${result.project.versions.length + 1}`;
    const output = await execute('create-version', { label });
    if (output && projectIdRef.current) await toolApi.createVersion(projectIdRef.current, label, projectState(output));
  };

  const importMaterial = async (file?: File) => {
    if (!file) return;
    await execute('import-material', { fileName: file.name, contentBase64: await fileBase64(file) });
  };
  const importProject = async (file?: File) => {
    if (!file) return;
    await execute('import-project', { project: await file.text() });
  };
  const switchProject = (id: string) => {
    const item = projects.find((project) => project.id === id);
    const saved = item?.state.aiReport as { result?: AiReportResult } | undefined;
    if (!item || saved?.result?.schema !== 'skyview-ai-report-results') return;
    projectIdRef.current = item.id; setProjectId(item.id); setProjectTitle(item.title); setResult(saved.result); setReportDraft(saved.result.project.report.content);
  };

  const loadLocalModel = async () => {
    if (!('gpu' in navigator)) { setError(text('当前浏览器没有可用 WebGPU，仍可使用服务端证据整理引擎。', 'WebGPU is unavailable; use the server evidence engine.')); return; }
    setLocalState('loading'); setError(''); setLocalProgress(text('准备下载所选模型；文件将进入浏览器缓存…', 'Preparing the selected model…'));
    try {
      const worker = new Worker('/workers/webllm-report-worker.mjs', { type: 'module' });
      localWorkerRef.current = worker;
      const moduleUrl = 'https://esm.run/@mlc-ai/web-llm@0.2.85';
      const webllm = await import(/* webpackIgnore: true */ moduleUrl) as {
        CreateWebWorkerMLCEngine: (worker: Worker, model: string, options: Record<string, unknown>) => Promise<typeof localEngineRef.current>;
      };
      localEngineRef.current = await webllm.CreateWebWorkerMLCEngine(worker, result.project.settings.localModel, {
        initProgressCallback: (progress: { text?: string; progress?: number }) => setLocalProgress(progress.text || `${Math.round((progress.progress ?? 0) * 100)}%`),
      });
      setLocalState('ready'); setLocalProgress(text('本地模型已就绪，材料和提示词不会发送到服务器模型。', 'Local model ready; prompts stay in this browser runtime.'));
    } catch (cause) {
      localWorkerRef.current?.terminate(); localWorkerRef.current = null; localEngineRef.current = null; setLocalState('idle');
      setError(cause instanceof Error ? cause.message : text('本地模型加载失败。', 'Local model loading failed.'));
    }
  };

  const completeLocal = async (system: string, user: string) => {
    const engine = localEngineRef.current;
    if (!engine) throw new Error(text('请先启用浏览器本地模型。', 'Load the browser-local model first.'));
    const response = await engine.chat.completions.create({ messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: result.project.settings.temperature, top_p: result.project.settings.topP, max_tokens: result.project.settings.maxTokens });
    const body = response as { choices?: Array<{ message?: { content?: string } }> };
    return body.choices?.[0]?.message?.content?.trim() ?? '';
  };
  const generateLocal = async () => {
    setLocalState('generating'); setError('');
    try {
      const content = await completeLocal(result.analysis.localPrompt.system, result.analysis.localPrompt.user);
      if (!content) throw new Error(text('本地模型没有返回正文。', 'The local model returned no content.'));
      setReportDraft(content);
      await execute('record-local-generation', { content, model: result.project.settings.localModel, evidenceChunkIds: result.analysis.localPrompt.evidenceChunkIds, promptChecksum: result.analysis.localPrompt.promptChecksum, evidenceChecksum: result.analysis.localPrompt.evidenceChecksum });
      setLocalState('ready');
    } catch (cause) { setLocalState('ready'); setError(cause instanceof Error ? cause.message : text('本地生成失败。', 'Local generation failed.')); }
  };
  const askLocal = async () => {
    if (!question.trim()) return;
    setLocalState('generating');
    try {
      const evidence = result.analysis.evidence.map((item) => `[${item.label}] ${item.materialName}\n${item.text}`).join('\n\n');
      const answer = await completeLocal('只根据证据回答；每条事实必须引用真实的 [Sx.y] 编号，材料不足时明确说明。', `问题：${question}\n\n证据：\n${evidence}`);
      await execute('record-local-chat', { question, answer, model: result.project.settings.localModel, evidenceChunkIds: result.analysis.localPrompt.evidenceChunkIds });
      setQuestion(''); setLocalState('ready');
    } catch (cause) { setLocalState('ready'); setError(cause instanceof Error ? cause.message : text('本地问答失败。', 'Local chat failed.')); }
  };
  const releaseLocal = async () => {
    localEngineRef.current?.interruptGenerate?.(); await localEngineRef.current?.unload?.(); localWorkerRef.current?.terminate();
    localEngineRef.current = null; localWorkerRef.current = null; setLocalState('stopped'); setLocalProgress(text('本地模型已释放。', 'Local model released.'));
  };

  const metrics = [
    [text('材料', 'Sources'), result.analysis.metrics.materials, `${result.analysis.metrics.selectedMaterials} ${text('份启用', 'selected')}`],
    [text('证据片段', 'Evidence'), result.analysis.metrics.chunks, `${result.analysis.metrics.citations} ${text('个引用', 'citations')}`],
    [text('正文', 'Report'), result.analysis.metrics.reportWords, text('字词', 'tokens')],
    [text('证据覆盖', 'Coverage'), `${result.analysis.metrics.coverage}%`, `${qualityPassed}/7 ${text('门禁', 'gates')}`],
    [text('报告版本', 'Versions'), result.analysis.metrics.versions, text('不可变快照', 'snapshots')],
    [text('核验质量', 'Quality'), result.analysis.metrics.qualityScore, result.analysis.audit.passed ? text('通过', 'Passed') : text('待修订', 'Review')],
  ];

  return (
    <section className="airx-shell" aria-label={text('AI 证据报告工作台', 'AI evidence report workbench')}>
      <header className="airx-commandbar">
        <div className="airx-brand"><span><Sparkles /></span><div><small>{text('证据编辑舱', 'Evidence studio')}</small><strong>AI {text('解释与报告', 'reporting')}</strong></div></div>
        <select value={projectId} onChange={(event) => switchProject(event.target.value)} aria-label={text('当前报告项目', 'Current report project')}>
          <option value="">{projectTitle}</option>{projects.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select>
        <Input value={projectTitle} onChange={(event) => setProjectTitle(event.target.value)} onBlur={() => void execute('update-project', { title: projectTitle })} aria-label={text('项目名称', 'Project name')} />
        <Button variant="outline" onClick={() => importMaterialRef.current?.click()}><Upload />{text('导入材料', 'Import')}</Button>
        <Button variant="outline" onClick={() => void execute('audit-report')} disabled={running}><ShieldCheck />{text('核验', 'Audit')}</Button>
        <Button onClick={() => void execute('generate-extractive')} disabled={running}>{running ? <LoaderCircle className="airx-spin" /> : <WandSparkles />}{text('生成完整报告', 'Generate report')}</Button>
        <input ref={importMaterialRef} hidden type="file" accept=".pdf,.docx,.xlsx,.pptx,.html,.htm,.xml,.json,.csv,.tsv,.md,.txt,.py,.js,.ts" onChange={(event) => { void importMaterial(event.target.files?.[0]); event.currentTarget.value = ''; }} />
        <input ref={importProjectRef} hidden type="file" accept=".json" onChange={(event) => { void importProject(event.target.files?.[0]); event.currentTarget.value = ''; }} />
      </header>

      <div className="airx-metrics">{metrics.map(([label, value, note]) => <article key={String(label)}><span>{label}</span><strong>{value}</strong><small>{note}</small></article>)}</div>
      <nav className="airx-tabs" aria-label={text('AI 报告功能', 'AI report views')}>
        {views.map(([id, zh, en, Icon], index) => <button key={id} className={view === id ? 'active' : ''} onClick={() => setView(id)}><b>{String(index + 1).padStart(2, '0')}</b><Icon />{text(zh, en)}</button>)}
      </nav>
      <output className={`airx-status ${error ? 'error' : ''}`}>{error ? <CircleAlert /> : running ? <LoaderCircle className="airx-spin" /> : <CheckCircle2 />}{error || message}</output>

      <main className="airx-content">
        {view === 'dashboard' && <div className="airx-dashboard">
          <section className="airx-panel airx-flow"><div className="airx-panel-head"><span><FileSearch />{text('报告流水线', 'Report pipeline')}</span><b>{qualityPassed}/7</b></div>
            <div className="airx-flow-list">{['材料接入', '结构提取', '证据检索', '报告生成', '引用核验', '版本固化', '交付归档'].map((name, index) => <article key={name} className={result.analysis.qualityChecks[index]?.passed ? 'done' : ''}><b>{String(index + 1).padStart(2, '0')}</b><span><strong>{name}</strong><small>{result.analysis.qualityChecks[index]?.label}</small></span>{result.analysis.qualityChecks[index]?.passed ? <CheckCircle2 /> : <CircleAlert />}</article>)}</div>
          </section>
          <section className="airx-panel airx-coverage"><div className="airx-panel-head"><span><Database />{text('证据覆盖', 'Evidence coverage')}</span><b>{result.analysis.metrics.coverage}%</b></div>
            <div className="airx-coverage-chart">{result.analysis.coverageByMaterial.map((item) => <article key={item.materialId}><div><strong>{item.name}</strong><small>{item.used}/{item.chunks} {text('片段被引用', 'chunks used')}</small></div><span><i style={{ width: `${item.coverage}%` }} /></span><b>{item.coverage}%</b></article>)}</div>
            <div className="airx-evidence-preview"><strong>{text('高相关证据', 'Top evidence')}</strong>{result.analysis.evidence.slice(0, 3).map((item) => <button key={item.id} onClick={() => { setView('materials'); void execute('set-active-material', { materialId: item.materialId }); }}><b>{item.label}</b><span>{item.text}</span><small>{item.score.toFixed(1)}</small></button>)}</div>
          </section>
          <section className="airx-panel airx-activity"><div className="airx-panel-head"><span><History />{text('最近活动', 'Recent activity')}</span></div>
            <div>{result.project.activities.map((item) => <article key={item.id}><i /><span><strong>{item.message}</strong><small>{item.actor} · {timeLabel(item.createdAt, locale)}</small></span></article>)}</div>
            <aside><ShieldCheck /><span><strong>{result.analysis.audit.passed ? text('当前报告可交付', 'Ready for delivery') : text('当前报告需要修订', 'Revision needed')}</strong><small>{result.analysis.audit.issues.length ? result.analysis.audit.issues[0].message : text('结构、引用、数值和局限性检查均已通过', 'Structure, citations, numbers, and limitations passed')}</small></span></aside>
          </section>
        </div>}

        {view === 'materials' && <div className="airx-materials-view">
          <section className="airx-panel airx-material-list"><div className="airx-panel-head"><span><Database />{text('材料库', 'Source library')}</span><button onClick={() => importMaterialRef.current?.click()}>+ {text('添加', 'Add')}</button></div>
            <div>{result.project.materials.map((item) => <article key={item.id} className={activeMaterial?.id === item.id ? 'active' : ''}><button className="airx-material-open" aria-label={text(`查看材料：${item.name}`, `Open source: ${item.name}`)} onClick={() => void execute('set-active-material', { materialId: item.id })}><i className={item.status} /><span><strong>{item.name}</strong><small>{item.chunks.length} {text('片段', 'chunks')} · {item.status === 'ready' ? text('可用', 'Ready') : text('待处理', 'Pending')}</small></span></button><button className="airx-material-toggle" aria-label={text(`${item.name}：切换材料选择`, `${item.name}: toggle source selection`)} aria-pressed={result.project.selectedMaterialIds.includes(item.id)} onClick={() => void execute('toggle-material', { materialId: item.id })}>{result.project.selectedMaterialIds.includes(item.id) ? '✓' : '○'}</button></article>)}</div>
            <footer><Button size="sm" variant="outline" onClick={() => importProjectRef.current?.click()}><Upload />{text('导入项目 JSON', 'Import project JSON')}</Button></footer>
          </section>
          <section className="airx-panel airx-chunk-list"><div className="airx-panel-head"><span><FileSearch />{text('稳定证据片段', 'Stable evidence chunks')}</span><b>{activeMaterial?.checksum.slice(0, 10)}</b></div>
            <div>{activeMaterial?.chunks.map((chunk) => <article key={chunk.id} className={chunk.enabled ? '' : 'disabled'}><header><b>{chunk.label}</b><small>{chunk.locator} · {chunk.words} {text('字词', 'words')}</small><button onClick={() => void execute('toggle-chunk', { chunkId: chunk.id })}>{chunk.enabled ? text('启用', 'On') : text('停用', 'Off')}</button></header><p>{chunk.text}</p><code>{chunk.checksum.slice(0, 18)}</code></article>)}</div>
          </section>
          <section className="airx-panel airx-material-detail"><div className="airx-panel-head"><span><FileCheck2 />{text('材料详情', 'Source detail')}</span>{activeMaterial && <button className="danger" onClick={() => void execute('delete-material', { materialId: activeMaterial.id })}><Trash2 /></button>}</div>
            {activeMaterial && <div className="airx-detail-grid"><span><small>{text('文件', 'File')}</small><b>{activeMaterial.name}</b></span><span><small>{text('类型', 'Type')}</small><b>{activeMaterial.type}</b></span><span><small>SHA-256</small><code>{activeMaterial.checksum}</code></span><span><small>{text('提取状态', 'Extraction')}</small><b>{activeMaterial.status}</b></span></div>}
            <label>{text('粘贴一份新材料', 'Paste a new source')}<textarea value={pasteText} onChange={(event) => setPasteText(event.target.value)} placeholder={text('输入 Markdown、记录或代码文本…', 'Paste Markdown, notes, or source code…')} /></label>
            <Button size="sm" disabled={!pasteText.trim()} onClick={() => void execute('import-text', { fileName: '粘贴材料.md', content: pasteText }).then(() => setPasteText(''))}>{text('建立证据索引', 'Index source')}</Button>
            <label>{text('登记 HTTPS 材料地址', 'Register HTTPS source')}<div><Input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://" /><Button size="sm" variant="outline" disabled={!url.trim()} onClick={() => void execute('register-url', { url }).then(() => setUrl(''))}>{text('登记', 'Register')}</Button></div></label>
            <p><CircleAlert />{text('外部地址只登记、不在浏览器直接抓取；扫描 PDF 会明确标记为待 OCR。', 'URLs are registered only; scanned PDFs are explicitly marked for OCR.')}</p>
          </section>
        </div>}

        {view === 'chat' && <div className="airx-chat-view">
          <section className="airx-panel airx-chat"><div className="airx-panel-head"><span><MessageSquareText />{text('基于材料问答', 'Evidence-grounded chat')}</span><button onClick={() => void execute('clear-chat')}>{text('清空', 'Clear')}</button></div>
            <div className="airx-chat-messages">{result.project.chats.map((item) => <article key={item.id} className={item.role}><div><b>{item.role === 'user' ? text('你', 'You') : item.model || text('证据助手', 'Evidence assistant')}</b><small>{timeLabel(item.createdAt, locale)}</small></div><p>{item.content}</p>{item.evidenceChunkIds.length > 0 && <footer>{item.evidenceChunkIds.map((id) => <span key={id}>{result.analysis.sourceIndex.find((source) => source.chunkId === id)?.label ?? id}</span>)}</footer>}</article>)}</div>
            <footer><Input value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void execute('ask-extractive', { question }).then(() => setQuestion('')); }} placeholder={text('询问材料中的事实、数值、矛盾或不足…', 'Ask about facts, numbers, conflicts, or gaps…')} /><Button onClick={() => void execute('ask-extractive', { question }).then(() => setQuestion(''))} disabled={!question.trim() || running}><Search />{text('证据回答', 'Answer')}</Button><Button variant="outline" onClick={() => void askLocal()} disabled={!question.trim() || localState !== 'ready'}><Bot />{text('本地模型回答', 'Local answer')}</Button></footer>
          </section>
          <section className="airx-panel airx-evidence-rail"><div className="airx-panel-head"><span><FileSearch />{text('回答证据', 'Answer evidence')}</span><b>{result.analysis.evidence.length}</b></div><div>{result.analysis.evidence.map((item) => <article key={item.id}><b>{item.label}</b><span><strong>{item.materialName}</strong><p>{item.text}</p></span><small>{item.score.toFixed(1)}</small></article>)}</div></section>
        </div>}

        {view === 'report' && <div className="airx-report-view">
          <section className="airx-panel airx-outline"><div className="airx-panel-head"><span><FileText />{text('报告结构', 'Outline')}</span><b>{reportSections.filter((item) => item.present).length}/{reportSections.length}</b></div><div>{reportSections.map((item, index) => <button key={item.name} className={item.present ? 'done' : ''}><b>{String(index + 1).padStart(2, '0')}</b><span>{item.name}</span>{item.present ? <CheckCircle2 /> : <CircleAlert />}</button>)}</div></section>
          <section className="airx-panel airx-editor"><div className="airx-panel-head"><span><FileText />{text('Markdown 正文', 'Markdown report')}</span><span><small>{result.project.report.model}</small><b>{result.project.report.mode}</b></span></div><textarea value={reportDraft} onChange={(event) => setReportDraft(event.target.value)} spellCheck={false} /><footer><Button variant="outline" onClick={() => setReportDraft(result.project.report.content)}><RotateCcw />{text('放弃更改', 'Discard')}</Button><Button onClick={() => void execute('update-report', { content: reportDraft })}><Save />{text('保存修订', 'Save revision')}</Button></footer></section>
          <section className="airx-panel airx-citation-rail"><div className="airx-panel-head"><span><FileCheck2 />{text('来源索引', 'Source index')}</span><b>{result.analysis.metrics.citations}</b></div><div>{result.analysis.sourceIndex.filter((item) => item.used).map((item) => <article key={item.chunkId}><header><b>{item.label}</b><small>{item.materialName}</small></header><p>{item.excerpt}</p><code>{item.checksum.slice(0, 14)}</code></article>)}</div></section>
        </div>}

        {view === 'audit' && <div className="airx-audit-view">
          <section className="airx-panel airx-audit-score"><div><ShieldCheck /><span><small>{text('核验质量分', 'Audit score')}</small><strong>{result.analysis.audit.score}</strong><b>{result.analysis.audit.passed ? text('通过交付门禁', 'Delivery gates passed') : text('需要修订', 'Revision required')}</b></span></div><Button onClick={() => void execute('audit-report')}><ShieldCheck />{text('重新核验', 'Run audit')}</Button></section>
          <section className="airx-panel airx-gates"><div className="airx-panel-head"><span><CheckCircle2 />{text('质量门禁', 'Quality gates')}</span><b>{qualityPassed}/7</b></div><div>{result.analysis.qualityChecks.map((item) => <article key={item.label} className={item.passed ? 'passed' : ''}>{item.passed ? <CheckCircle2 /> : <CircleAlert />}<span>{item.label}</span><b>{item.passed ? text('通过', 'Pass') : text('未通过', 'Fail')}</b></article>)}</div></section>
          <section className="airx-panel airx-issues"><div className="airx-panel-head"><span><CircleAlert />{text('问题清单', 'Findings')}</span><b>{result.analysis.audit.issues.length}</b></div><div>{result.analysis.audit.issues.length === 0 ? <div className="airx-empty"><CheckCircle2 /><strong>{text('没有阻断性交付问题', 'No blocking delivery issue')}</strong><small>{text('仍建议结合原始材料进行最终人工复核。', 'A final human review against original sources is still recommended.')}</small></div> : result.analysis.audit.issues.map((item) => <article key={item.id} className={item.severity}><b>{item.severity}</b><span><strong>{item.message}</strong><small>{item.action}</small><p>{item.evidence}</p></span></article>)}</div></section>
        </div>}

        {view === 'versions' && <div className="airx-versions-view">
          <section className="airx-panel airx-version-list"><div className="airx-panel-head"><span><History />{text('不可变版本', 'Immutable versions')}</span><button onClick={() => void createSnapshot()}>+ {text('固化', 'Snapshot')}</button></div><div>{[...result.project.versions].reverse().map((item) => <button key={item.id} className={selectedVersion?.id === item.id ? 'active' : ''} onClick={() => setActiveVersion(item.id)}><b>V{item.number}</b><span><strong>{item.label}</strong><small>{item.actor} · {timeLabel(item.createdAt, locale)}</small></span><i>{item.kind}</i></button>)}</div></section>
          <section className="airx-panel airx-version-preview"><div className="airx-panel-head"><span><FileSearch />{text('版本预览', 'Version preview')}</span><code>{selectedVersion?.reportChecksum.slice(0, 16)}</code></div><pre>{selectedVersion?.content}</pre><footer><Button variant="outline" disabled={!selectedVersion} onClick={() => selectedVersion && void execute('restore-version', { versionId: selectedVersion.id })}><ArchiveRestore />{text('恢复为新版本', 'Restore as new version')}</Button></footer></section>
          <section className="airx-panel airx-diff"><div className="airx-panel-head"><span><FileCheck2 />{text('变更摘要', 'Change summary')}</span></div><div><article><small>{text('选中版本', 'Selected')}</small><strong>{selectedVersion?.content.length ?? 0}</strong><span>{text('字符', 'characters')}</span></article><article><small>{text('当前报告', 'Current')}</small><strong>{reportDraft.length}</strong><span>{text('字符', 'characters')}</span></article><article><small>{text('长度差异', 'Difference')}</small><strong>{reportDraft.length - (selectedVersion?.content.length ?? 0)}</strong><span>{text('字符', 'characters')}</span></article></div><p>{text('恢复不会覆盖历史版本，而是先保存恢复前状态，再创建一个新的恢复版本。', 'Restore never overwrites history; it creates pre-restore and restored snapshots.')}</p></section>
        </div>}

        {view === 'export' && <div className="airx-export-view">
          <section className="airx-panel airx-delivery-summary"><div><FileArchive /><span><small>{text('完整交付包', 'Complete delivery package')}</small><strong>{projectTitle}</strong><p>{text('报告、材料、证据索引、核验记录、版本清单与可追溯清单。', 'Report, sources, evidence, audits, versions, and manifest.')}</p></span></div><Button disabled={!result.exports.packageBase64} onClick={() => downloadBase64(result.exports.packageBase64, 'ai-report-delivery.zip', 'application/zip')}><Download />{text('下载 ZIP', 'Download ZIP')}</Button></section>
          <section className="airx-panel airx-export-grid"><div className="airx-panel-head"><span><Download />{text('交付格式', 'Delivery formats')}</span><b>8</b></div><div>{[
            ['Markdown', 'report.md', () => downloadText(result.exports.markdown, 'report.md', 'text/markdown')],
            ['HTML', 'report.html', () => downloadText(result.exports.html, 'report.html', 'text/html')],
            [text('纯文本', 'Plain text'), 'report.txt', () => downloadText(result.exports.text, 'report.txt', 'text/plain')],
            ['DOCX', 'report.docx', () => downloadBase64(result.exports.docxBase64, 'report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')],
            [text('来源索引', 'Source index'), 'source-index.json', () => downloadText(result.exports.sourceIndexJson, 'source-index.json', 'application/json')],
            [text('核验记录', 'Audit record'), 'audit.json', () => downloadText(result.exports.auditJson, 'audit.json', 'application/json')],
            [text('项目副本', 'Project copy'), 'project.json', () => downloadText(result.exports.projectJson, 'project.json', 'application/json')],
            [text('完整归档', 'Full archive'), 'delivery.zip', () => downloadBase64(result.exports.packageBase64, 'ai-report-delivery.zip', 'application/zip')],
          ].map(([label, file, action]) => <button key={String(file)} onClick={action as () => void} disabled={!result.exports.packageBase64}><FileText /><span><strong>{String(label)}</strong><small>{String(file)}</small></span><Download /></button>)}</div></section>
          <section className="airx-panel airx-manifest"><div className="airx-panel-head"><span><ShieldCheck />{text('可追溯清单', 'Traceability')}</span></div><div>{result.project.materials.map((item) => <article key={item.id}><b>S{item.sequence}</b><span><strong>{item.name}</strong><code>{item.checksum.slice(0, 24)}</code></span><small>{item.chunks.length} {text('片段', 'chunks')}</small></article>)}</div></section>
        </div>}

        {view === 'settings' && <div className="airx-settings-view">
          <section className="airx-panel airx-template-settings"><div className="airx-panel-head"><span><Settings2 />{text('报告模板', 'Report template')}</span></div><div className="airx-form-grid">
            <label>{text('报告类型', 'Report type')}<select value={result.project.config.reportType} onChange={(event) => void execute('update-config', { config: { reportType: event.target.value } })}>{result.analysis.reportTypes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <label>{text('目标读者', 'Audience')}<Input defaultValue={result.project.config.audience} onBlur={(event) => void execute('update-config', { config: { audience: event.target.value } })} /></label>
            <label className="wide">{text('报告目标', 'Objective')}<textarea defaultValue={result.project.config.objective} onBlur={(event) => void execute('update-config', { config: { objective: event.target.value } })} /></label>
            <label className="wide">{text('特别要求', 'Instructions')}<textarea defaultValue={result.project.config.instruction} onBlur={(event) => void execute('update-config', { config: { instruction: event.target.value } })} /></label>
          </div></section>
          <section className="airx-panel airx-local-runtime"><div className="airx-panel-head"><span><Bot />{text('浏览器本地模型', 'Browser-local model')}</span><b className={localState}>{localState}</b></div><div className="airx-form-grid"><label className="wide">{text('模型', 'Model')}<select value={result.project.settings.localModel} onChange={(event) => void execute('update-config', { settings: { localModel: event.target.value } })}>{result.analysis.localModels.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.memory}</option>)}</select></label><label>{text('温度', 'Temperature')}<Input type="number" min="0" max="1.5" step="0.1" defaultValue={result.project.settings.temperature} onBlur={(event) => void execute('update-config', { settings: { temperature: Number(event.target.value) } })} /></label><label>{text('最大输出', 'Max tokens')}<Input type="number" min="256" max="8192" defaultValue={result.project.settings.maxTokens} onBlur={(event) => void execute('update-config', { settings: { maxTokens: Number(event.target.value) } })} /></label></div><p>{localProgress || text('仅在你点击启用后下载模型；材料不会发送给第三方模型服务。', 'The model downloads only after consent; sources stay out of third-party AI services.')}</p><footer>{localState === 'idle' || localState === 'stopped' ? <Button onClick={() => void loadLocalModel()}><Play />{text('启用本地模型', 'Load local model')}</Button> : <><Button disabled={localState !== 'ready'} onClick={() => void generateLocal()}><WandSparkles />{text('本地生成报告', 'Generate locally')}</Button><Button variant="outline" onClick={() => localEngineRef.current?.interruptGenerate?.()} disabled={localState !== 'generating'}><Square />{text('停止', 'Stop')}</Button><Button variant="outline" onClick={() => void releaseLocal()}><Trash2 />{text('释放模型', 'Unload')}</Button></>}</footer></section>
          <section className="airx-panel airx-runtime-grid"><div className="airx-panel-head"><span><Gauge />{text('运行时边界', 'Runtime boundary')}</span></div><div>{Object.entries(result.runtime).filter(([, value]) => typeof value === 'object').map(([key, value]) => { const item = value as { status?: string; engine?: string }; return <article key={key}><i className={item.status === 'enabled' ? 'enabled' : item.status === 'browser-opt-in' ? 'optional' : ''} /><span><strong>{({ serverEvidenceEngine: text('证据引擎', 'Evidence engine'), goControlPlane: text('控制平面', 'Control plane'), browserWebLLM: text('本地模型', 'Local model'), enterpriseAiGateway: text('企业模型网关', 'AI gateway'), ocrLayoutParser: 'OCR', objectStorage: text('对象存储', 'Object storage') } as Record<string, string>)[key] ?? key}</strong><small>{item.engine}</small></span><b>{item.status === 'enabled' ? text('可用', 'Ready') : item.status === 'browser-opt-in' ? text('按需', 'Opt-in') : text('未配置', 'Not configured')}</b></article>})}</div><p><CircleAlert />{text('企业模型密钥只能由 Go 网关在服务端托管；页面不提供端点或密钥输入框。', 'Provider credentials belong only in the server-side Go gateway; this page never accepts endpoints or keys.')}</p></section>
        </div>}
      </main>
    </section>
  );
}
