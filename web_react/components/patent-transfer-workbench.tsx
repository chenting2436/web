'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive, BookOpenCheck, CheckCircle2, CircleAlert, Download, FileSearch,
  FileUp, FolderOpen, Landmark, LoaderCircle, Network, Play, Save, Scale,
  ShieldCheck, TrendingUp,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { ApiError } from '@/services/api/client';
import { toolApi, type WorkbenchJob, type WorkbenchProject } from '@/services/api/tools';

type Feature = { id: string; name: string; essential: boolean; effect: string; support: string };
type PatentRecord = { id: string; publicationNumber: string; title: string; applicant: string; familyId: string; priorityDate: string; jurisdiction: string; status: string; cpc: string[]; citations: number; source: string; verifiedAt: string | null };
type Claim = { id: string; number: number; type: string; parentId: string | null; text: string; supportFeatureIds: string[] };
type PatentResult = {
  schema: 'skyview-patent-transfer-results'; version: number; stage: string;
  project: { name: string; code: string; manager: string; organization: string; confidentiality: string; targetJurisdictions: string[]; stage: string };
  disclosure: { title: string; inventors: string[]; applicant: string; field: string; problem: string; solution: string; effects: string; implementation: string; publicDisclosureDate: string; firstDisclosureChannel: string };
  features: Feature[]; patents: PatentRecord[]; matrix: Record<string, Record<string, string>>; claims: Claim[];
  search: { genericQuery: string; epoCql: string; rounds: Array<{ id: string; source: string; queryHash: string; records: number; executedAt: string; status: string }> };
  landscape: { records: number; families: number; citations: number; familySizes: Array<{ name: string; value: number }>; classifications: Array<{ name: string; value: number }>; years: Array<{ name: string; value: number }> };
  novelty: Array<{ patentId: string; publicationNumber: string; full: number; partial: number; coverageRate: number; noveltyRisk: boolean }>;
  claimLint: { issues: Array<{ level: string; claimId: string | null; message: string }>; errors: number; warnings: number; passed: boolean; independent: number; dependent: number; coverageRate: number };
  fto: { rows: Array<{ id: string; publicationNumber: string; productFeature: string; claimCoverage: number; relevance: string; legalStatus: string; score: number; level: string; notes: string }>; high: number; medium: number; low: number };
  trl: { selected: number; backed: number; gap: number; verified: number };
  trlEvidence: Array<{ id: string; level: number; title: string; reference: string; verified: boolean }>;
  valuation: { annualRevenue: number; growthRate: number; royaltyRate: number; successProbability: number; discountRate: number; years: number; annualCost: number; upfront: number; milestones: number };
  valuationResult: { npv: number; cashflows: Array<{ year: number; revenue: number; grossRoyalty: number; riskAdjusted: number; presentValue: number }> };
  riskRegister: Array<{ id: string; category: string; description: string; probability: number; impact: number; owner: string; status: string; score: number; level: string }>;
  deadlineAlerts: Array<{ id: string; name: string; date: string; owner: string; status: string; days: number | null; level: string }>;
  evidence: Array<{ id: string; title: string; type: string; fingerprint: string; verified: boolean }>;
  readiness: { total: number; dimensions: Array<{ id: string; name: string; score: number }>; blockers: string[] };
  qualityChecks: Array<{ label: string; passed: boolean }>;
  runtime: { compute: string; orchestration: string; epoOpsConfigured: boolean; patentsViewConfigured: boolean; officialLegalStatusConfigured: boolean };
  limitations: string[];
  exports: { patentsCsv: string; matrixCsv: string; ftoCsv: string; deadlinesCsv: string; evidenceJson: string; reportMarkdown: string; reportHtml: string; packageBase64: string };
};

const views = [
  ['overview', '项目总览'], ['disclosure', '技术交底'], ['search', '检索情报'],
  ['novelty', '新颖性与创造性'], ['claims', '权利要求'], ['fto', '自由实施初筛'],
  ['transfer', '转化评估'], ['docket', '期限与证据'], ['archive', '报告归档'],
] as const;

const terminalStatuses = new Set(['succeeded', 'failed', 'canceled']);
const wait = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));
async function waitForJob(id: string): Promise<WorkbenchJob | null> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const job = await toolApi.getJob(id);
    if (terminalStatuses.has(job.status)) return job;
    await wait(750);
  }
  return null;
}

function money(value: number) { return `¥${Math.round(value).toLocaleString('zh-CN')}`; }
function percent(value: number) { return `${Math.round(value * 100)}%`; }
function escapeCsv(value: unknown) {
  const text = value == null ? '' : typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
function toCsv(rows: Array<Record<string, unknown>>, fields: string[]) { return `${fields.join(',')}\r\n${rows.map((row) => fields.map((field) => escapeCsv(row[field])).join(',')).join('\r\n')}`; }

function createBenchmarkResult(): PatentResult {
  const patents: PatentRecord[] = [
    ['P1', 'LOCAL-CN-001', '多源边坡监测数据融合方法', '示例申请人甲', 'FAM-A', '2020-06-18', 'CN', ['G06F18/20', 'G08B21/10'], 18],
    ['P2', 'LOCAL-CN-002', '基于遥感与位移的地质灾害预警', '示例申请人乙', 'FAM-B', '2019-11-02', 'CN', ['G01S19/14', 'G08B21/10'], 11],
    ['P3', 'LOCAL-WO-003', '可追溯的工业风险判定系统', '示例申请人丙', 'FAM-C', '2021-03-27', 'PCT', ['G06Q10/0635'], 9],
    ['P4', 'LOCAL-CN-004', '监测数据质量评价与隔离方法', '示例申请人丁', 'FAM-A', '2018-08-14', 'CN', ['G06F18/10'], 7],
    ['P5', 'LOCAL-US-005', 'Evidence-linked sensor analytics', '示例申请人戊', 'FAM-D', '2022-01-09', 'US', ['G06F16/27'], 4],
    ['P6', 'LOCAL-EP-006', 'Configurable hazard classification', '示例申请人己', 'FAM-E', '2020-10-30', 'EP', ['G06N20/00'], 6],
  ].map(([id, publicationNumber, title, applicant, familyId, priorityDate, jurisdiction, cpc, citations]) => ({ id: String(id), publicationNumber: String(publicationNumber), title: String(title), applicant: String(applicant), familyId: String(familyId), priorityDate: String(priorityDate), jurisdiction: String(jurisdiction), status: '待核验', cpc: cpc as string[], citations: Number(citations), source: '本地示例语料', verifiedAt: null }));
  const features: Feature[] = [
    { id: 'F1', name: '多源监测数据时空对齐', essential: true, effect: '统一分析基准', support: '实施例 S1-S2' },
    { id: 'F2', name: '对齐质量标记与异常隔离', essential: true, effect: '控制低质量输入', support: '实施例 S2' },
    { id: 'F3', name: '跨来源风险特征与可配置分级', essential: true, effect: '形成可解释风险等级', support: '实施例 S3-S4' },
    { id: 'F4', name: '输入参数结果复核证据链', essential: true, effect: '支持审计追溯', support: '实施例 S5' },
  ];
  const matrix = {
    F1: { P1: 'full', P2: 'partial', P3: 'none', P4: 'partial', P5: 'partial', P6: 'none' },
    F2: { P1: 'partial', P2: 'none', P3: 'none', P4: 'full', P5: 'partial', P6: 'none' },
    F3: { P1: 'partial', P2: 'full', P3: 'partial', P4: 'none', P5: 'partial', P6: 'full' },
    F4: { P1: 'none', P2: 'none', P3: 'full', P4: 'partial', P5: 'full', P6: 'none' },
  };
  const claims: Claim[] = [
    { id: 'C1', number: 1, type: 'independent', parentId: null, text: '一种面向矿山边坡的多源风险识别方法，其特征在于，包括：获取多源监测数据；执行时空对齐并输出质量标记；构建跨来源风险特征；执行风险分级；关联输入、参数、结果和复核记录形成证据链。', supportFeatureIds: ['F1', 'F2', 'F3', 'F4'] },
    { id: 'C2', number: 2, type: 'dependent', parentId: 'C1', text: '根据权利要求1所述的方法，其中，所述多源监测数据至少包括遥感影像和位移监测信号。', supportFeatureIds: ['F1'] },
    { id: 'C3', number: 3, type: 'dependent', parentId: 'C1', text: '根据权利要求1所述的方法，其中，质量标记用于隔离缺失率超过阈值的数据段。', supportFeatureIds: ['F2'] },
    { id: 'C4', number: 4, type: 'dependent', parentId: 'C1', text: '根据权利要求1所述的方法，其中，证据链记录输入摘要、参数版本和复核签名。', supportFeatureIds: ['F4'] },
  ];
  const patentsCsv = toCsv(patents, ['publicationNumber', 'title', 'applicant', 'familyId', 'priorityDate', 'jurisdiction', 'status', 'source', 'verifiedAt']);
  const reportMarkdown = '# 矿山边坡多源风险识别技术转化项目\n\n转化准备度：66/100\n\n- 本地专利记录：6\n- 记录组：5\n- 权利要求：4\n- 连续证据支持：TRL 3\n- 所有法律状态仍待官方来源核验。\n';
  return {
    schema: 'skyview-patent-transfer-results', version: 2, stage: 'run-all',
    project: { name: '矿山边坡多源风险识别技术转化项目', code: 'SVL-IP-2026-014', manager: '知识产权与技术转移组', organization: 'SkyViewLab', confidentiality: '内部保密', targetJurisdictions: ['CN', 'PCT'], stage: '检索评估' },
    disclosure: { title: '一种面向矿山边坡的多源风险识别方法', inventors: ['陈研究员', '周工程师', '林同学'], applicant: 'SkyViewLab', field: '矿山安全监测与智能预警', problem: '多源监测数据时间尺度和空间基准不一致，风险判断缺少可复核的来源与参数记录。', solution: '执行时空对齐和质量标记，构建跨来源风险特征，按可配置规则分级并保存证据链。', effects: '降低来源偏差对风险判断的影响，并使输入、参数、结果和复核过程可追溯。', implementation: '采集遥感、位移和环境数据；完成时空对齐；提取跨来源特征；分级；写入证据链。', publicDisclosureDate: '', firstDisclosureChannel: '' },
    features, patents, matrix, claims,
    search: { genericQuery: '(矿山边坡 OR 边坡稳定性) AND (多源数据融合 OR 时空对齐) AND (风险分级 OR 证据链)', epoCql: '(ta="矿山边坡" OR ta="边坡稳定性") AND (cl="G06F18/20" OR cl="G08B21/10")', rounds: [{ id: 'S1', source: '本地示例语料', queryHash: 'e6d2d904ef12', records: 6, executedAt: '2026-09-09T00:00:00Z', status: 'completed' }] },
    landscape: { records: 6, families: 5, citations: 55, familySizes: [{ name: 'FAM-A', value: 2 }, { name: 'FAM-B', value: 1 }, { name: 'FAM-C', value: 1 }, { name: 'FAM-D', value: 1 }, { name: 'FAM-E', value: 1 }], classifications: [{ name: 'G08B21/10', value: 2 }, { name: 'G06F18/20', value: 1 }, { name: 'G06F18/10', value: 1 }, { name: 'G06F16/27', value: 1 }, { name: 'G06N20/00', value: 1 }], years: [{ name: '2018', value: 1 }, { name: '2019', value: 1 }, { name: '2020', value: 2 }, { name: '2021', value: 1 }, { name: '2022', value: 1 }] },
    novelty: [
      { patentId: 'P1', publicationNumber: 'LOCAL-CN-001', full: 1, partial: 2, coverageRate: 0.5, noveltyRisk: false },
      { patentId: 'P5', publicationNumber: 'LOCAL-US-005', full: 1, partial: 3, coverageRate: 0.625, noveltyRisk: false },
      { patentId: 'P3', publicationNumber: 'LOCAL-WO-003', full: 1, partial: 1, coverageRate: 0.375, noveltyRisk: false },
    ],
    claimLint: { issues: [{ level: 'warning', claimId: 'C2', message: '从属项中的数据来源范围需结合实施例继续收敛' }], errors: 0, warnings: 1, passed: true, independent: 1, dependent: 3, coverageRate: 1 },
    fto: { rows: [
      { id: 'R1', publicationNumber: 'LOCAL-CN-001', productFeature: '时空对齐', claimCoverage: 68, relevance: 'high', legalStatus: '待核验', score: 67, level: 'medium', notes: '需取得独立权利要求全文并核验有效性' },
      { id: 'R2', publicationNumber: 'LOCAL-WO-003', productFeature: '证据链', claimCoverage: 55, relevance: 'medium', legalStatus: '待核验', score: 52, level: 'medium', notes: '需核对目标产品实施方式与地域' },
      { id: 'R3', publicationNumber: 'LOCAL-CN-004', productFeature: '质量隔离', claimCoverage: 42, relevance: 'medium', legalStatus: '待核验', score: 45, level: 'medium', notes: '当前仅基于本地摘要初筛' },
    ], high: 0, medium: 3, low: 0 },
    trl: { selected: 4, backed: 3, gap: 1, verified: 3 },
    trlEvidence: [
      { id: 'T1', level: 1, title: '基础机理与指标定义', reference: 'LAB-2026-011', verified: true },
      { id: 'T2', level: 2, title: '应用概念与场景边界', reference: 'REQ-2026-022', verified: true },
      { id: 'T3', level: 3, title: '关键算法离线概念验证', reference: 'EXP-2026-031', verified: true },
      { id: 'T4', level: 4, title: '实验室端到端集成', reference: '待补充', verified: false },
    ],
    valuation: { annualRevenue: 12000000, growthRate: 12, royaltyRate: 3.5, successProbability: 55, discountRate: 15, years: 5, annualCost: 180000, upfront: 600000, milestones: 900000 },
    valuationResult: { npv: 1324327, cashflows: [
      { year: 1, revenue: 12000000, grossRoyalty: 420000, riskAdjusted: 132000, presentValue: 114783 },
      { year: 2, revenue: 13440000, grossRoyalty: 470400, riskAdjusted: 159720, presentValue: 120771 },
      { year: 3, revenue: 15052800, grossRoyalty: 526848, riskAdjusted: 190766, presentValue: 125436 },
      { year: 4, revenue: 16859136, grossRoyalty: 590070, riskAdjusted: 225539, presentValue: 128954 },
      { year: 5, revenue: 18882232, grossRoyalty: 660878, riskAdjusted: 264483, presentValue: 131516 },
    ] },
    riskRegister: [
      { id: 'K1', category: '自由实施', description: '高相关本地记录尚未完成权利要求和法律状态核验', probability: 4, impact: 5, owner: '知识产权经理', status: 'open', score: 20, level: 'high' },
      { id: 'K2', category: '权属', description: '三名发明人贡献说明待签署', probability: 3, impact: 4, owner: '项目负责人', status: 'open', score: 12, level: 'medium' },
      { id: 'K3', category: '市场', description: '许可费率尚缺少可比交易校准', probability: 3, impact: 3, owner: '财务审核', status: 'open', score: 9, level: 'medium' },
    ],
    deadlineAlerts: [
      { id: 'D1', name: '发明人贡献确认', date: '2026-09-17', owner: '项目负责人', status: 'open', days: 8, level: 'urgent' },
      { id: 'D2', name: '检索式与结果复核', date: '2026-09-30', owner: '知识产权经理', status: 'open', days: 21, level: 'soon' },
      { id: 'D3', name: '申请前公开风险检查', date: '2026-10-24', owner: '代理人', status: 'planned', days: 45, level: 'soon' },
      { id: 'D4', name: '许可估值财务复核', date: '2026-11-11', owner: '财务审核', status: 'planned', days: 63, level: 'planned' },
    ],
    evidence: [
      { id: 'E1', title: '技术方案评审纪要', type: '评审记录', fingerprint: 'a189b3d4e910cd21', verified: true },
      { id: 'E2', title: '算法实验记录', type: '试验数据', fingerprint: '550f4072c832db8a', verified: true },
      { id: 'E3', title: '发明人贡献说明', type: '权属文件', fingerprint: '72dca8105514be60', verified: false },
      { id: 'E4', title: '本地现有技术语料', type: '检索快照', fingerprint: '61653cc844ea018d', verified: true },
    ],
    readiness: { total: 66, dimensions: [{ id: 'disclosure', name: '技术交底', score: 94 }, { id: 'search', name: '检索证据', score: 72 }, { id: 'claims', name: '权利要求', score: 94 }, { id: 'technical', name: '技术成熟度', score: 33 }, { id: 'evidence', name: '证据完整性', score: 75 }, { id: 'governance', name: '权属与合规', score: 58 }, { id: 'market', name: '商业化准备', score: 64 }], blockers: ['全部专利记录的法律状态尚待官方来源核验', '发明人贡献说明尚未完成签署', '许可费率缺少可比交易校准'] },
    qualityChecks: [{ label: '技术问题、方案与效果已结构化', passed: true }, { label: '必要技术特征均有关联说明书位置', passed: true }, { label: '权利要求从属关系无断链', passed: true }, { label: '要素覆盖矩阵已建立', passed: true }, { label: 'FTO 高相关项已登记复核说明', passed: true }, { label: 'TRL 有连续证据支持', passed: true }, { label: '法律状态具有官方核验时间', passed: false }, { label: '关键权属文件已签署', passed: false }],
    runtime: { compute: 'Python 专利分析作业', orchestration: 'Go 项目、队列与审计', epoOpsConfigured: false, patentsViewConfigured: false, officialLegalStatusConfigured: false },
    limitations: ['本地示例记录不对应真实专利，不得作为现有技术或法律状态结论。', 'FTO 分数用于筛查排序，正式意见需要代理人或法律顾问复核签署。', '估值结果依赖输入假设，需由财务审核人校准。'],
    exports: { patentsCsv, matrixCsv: 'feature,LOCAL-CN-001,LOCAL-CN-002,LOCAL-WO-003\r\n多源监测数据时空对齐,full,partial,none', ftoCsv: 'publicationNumber,feature,score,legalStatus\r\nLOCAL-CN-001,时空对齐,67,待核验', deadlinesCsv: 'name,date,owner,status\r\n发明人贡献确认,2026-09-17,项目负责人,open', evidenceJson: '[]', reportMarkdown, reportHtml: `<pre>${reportMarkdown}</pre>`, packageBase64: '' },
  };
}

function downloadText(content: string, fileName: string, type: string) {
  const url = URL.createObjectURL(new Blob(['\ufeff', content], { type }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = fileName;
  document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
}
function downloadBase64(content: string, fileName: string) {
  const bytes = Uint8Array.from(atob(content), (character) => character.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = fileName;
  document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
}

function ReadinessRadar({ result }: { result: PatentResult }) {
  const center = 120; const radius = 86; const dimensions = result.readiness.dimensions;
  const points = dimensions.map((item, index) => { const angle = -Math.PI / 2 + index * Math.PI * 2 / dimensions.length; const length = radius * item.score / 100; return `${center + Math.cos(angle) * length},${center + Math.sin(angle) * length}`; }).join(' ');
  return <svg className="transfer-radar" viewBox="0 0 240 240" aria-label="七维转化准备度雷达图"><title>七维转化准备度雷达图</title>{[0.25, 0.5, 0.75, 1].map((scale) => <polygon key={scale} points={dimensions.map((_, index) => { const angle = -Math.PI / 2 + index * Math.PI * 2 / dimensions.length; return `${center + Math.cos(angle) * radius * scale},${center + Math.sin(angle) * radius * scale}`; }).join(' ')} />)}{dimensions.map((item, index) => { const angle = -Math.PI / 2 + index * Math.PI * 2 / dimensions.length; return <g key={item.id}><line x1={center} y1={center} x2={center + Math.cos(angle) * radius} y2={center + Math.sin(angle) * radius} /><text x={center + Math.cos(angle) * 108} y={center + Math.sin(angle) * 105}>{item.name}</text></g>; })}<polygon className="value" points={points} /><circle cx={center} cy={center} r="33" /><text className="score" x={center} y={center + 7}>{result.readiness.total}</text></svg>;
}

function ValuationChart({ result }: { result: PatentResult }) {
  const rows = result.valuationResult.cashflows; const maximum = Math.max(...rows.map((item) => item.presentValue), 1);
  return <svg className="transfer-valuation-chart" viewBox="0 0 720 250" aria-label="风险调整现金流估值图"><title>风险调整现金流估值图</title>{rows.map((item, index) => { const height = item.presentValue / maximum * 150; const x = 70 + index * 122; return <g key={item.year}><rect x={x} y={200 - height} width="68" height={height} rx="5" /><text x={x + 34} y={220}>第 {item.year} 年</text><text className="amount" x={x + 34} y={190 - height}>{money(item.presentValue)}</text></g>; })}<line x1="38" x2="690" y1="200" y2="200" /></svg>;
}

export function PatentTransferWorkbench({ executionAllowed = true }: { executionAllowed?: boolean }) {
  const [selectedView, setSelectedView] = useState<(typeof views)[number][0]>('overview');
  const [result, setResult] = useState<PatentResult>(() => createBenchmarkResult());
  const [projects, setProjects] = useState<WorkbenchProject[]>([]);
  const [projectId, setProjectId] = useState('');
  const [projectTitle, setProjectTitle] = useState('矿山边坡多源风险识别技术转化项目');
  const [running, setRunning] = useState(false); const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('完整本地项目模板已载入；法律状态保持待核验。'); const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    toolApi.listProjects('patent-transfer').then((items) => {
      if (!active) return; setProjects(items); const project = items[0];
      const saved = project?.state.patentTransfer as { result?: PatentResult } | undefined;
      if (project && saved?.result?.schema === 'skyview-patent-transfer-results') { setProjectId(project.id); setProjectTitle(project.title); setResult(saved.result); setMessage('已打开最近的专利转化项目。'); }
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  const projectState = (nextResult: PatentResult = result) => ({ patentTransfer: { result: nextResult } });
  const ensureProject = async () => {
    const existing = projects.find((project) => project.id === projectId); if (existing) return existing;
    const created = await toolApi.createProject('patent-transfer', projectTitle, projectState());
    setProjects((items) => [created, ...items]); setProjectId(created.id); return created;
  };
  const execute = async (action: string) => {
    if (!executionAllowed) return; setRunning(true); setError(''); setMessage('Python 正在计算矩阵、风险、成熟度和估值…');
    try {
      const project = await ensureProject();
      const created = await toolApi.createJob(project.id, 'patent-transfer', action, { project: result }, crypto.randomUUID());
      const job = await waitForJob(created.job.id); if (!job) throw new Error('作业仍在后台运行，请稍后重新打开项目。');
      if (job.status === 'failed') throw new Error(job.error || '计算失败。'); if (job.status === 'canceled') throw new Error('计算已取消。');
      const output = job.result as PatentResult; if (output.schema !== 'skyview-patent-transfer-results') throw new Error('服务端返回了不兼容的结果。');
      setResult(output); const saved = await toolApi.updateProject(project.id, projectTitle, projectState(output));
      setProjects((items) => [saved, ...items.filter((item) => item.id !== saved.id)]); setMessage(action === 'run-all' ? '九个工作区已完成联动分析，交付包已更新。' : '当前分析阶段已更新。');
    } catch (caught) { setError(caught instanceof ApiError || caught instanceof Error ? caught.message : '计算失败。'); setMessage(''); } finally { setRunning(false); }
  };
  const saveProject = async () => {
    setSaving(true); setError(''); try { const existing = projects.find((project) => project.id === projectId); const saved = existing ? await toolApi.updateProject(existing.id, projectTitle, projectState()) : await toolApi.createProject('patent-transfer', projectTitle, projectState()); setProjects((items) => [saved, ...items.filter((item) => item.id !== saved.id)]); setProjectId(saved.id); setMessage('项目已保存。'); } catch (caught) { setError(caught instanceof Error ? caught.message : '保存失败。'); } finally { setSaving(false); }
  };
  const createVersion = async () => { setSaving(true); setError(''); try { const project = await ensureProject(); await toolApi.createVersion(project.id, `转化评估 ${new Date().toLocaleString('zh-CN')}`, projectState()); setMessage('已创建不可变项目版本。'); } catch (caught) { setError(caught instanceof Error ? caught.message : '创建版本失败。'); } finally { setSaving(false); } };
  const selectProject = (id: string) => { const project = projects.find((item) => item.id === id); setProjectId(id); if (!project) { const benchmark = createBenchmarkResult(); setResult(benchmark); setProjectTitle(benchmark.project.name); return; } const saved = project.state.patentTransfer as { result?: PatentResult } | undefined; if (saved?.result?.schema === 'skyview-patent-transfer-results') { setResult(saved.result); setProjectTitle(project.title); } };
  const updateDisclosure = (field: keyof PatentResult['disclosure'], value: string) => setResult((current) => ({ ...current, disclosure: { ...current.disclosure, [field]: value } }));
  const passCount = result.qualityChecks.filter((item) => item.passed).length;
  const selectedPatent = useMemo(() => result.patents[0], [result.patents]);

  return <section className="transfer-workbench">
    <header className="transfer-commandbar">
      <div className="transfer-project-picker"><FolderOpen /><NativeSelect aria-label="选择项目" value={projectId} onChange={(event) => selectProject(event.target.value)}><NativeSelectOption value="">未保存项目</NativeSelectOption>{projects.map((project) => <NativeSelectOption key={project.id} value={project.id}>{project.title}</NativeSelectOption>)}</NativeSelect><Input aria-label="项目名称" value={projectTitle} onChange={(event) => setProjectTitle(event.target.value)} /><span className="transfer-confidentiality"><ShieldCheck />{result.project.confidentiality}</span></div>
      <div className="transfer-command-actions"><Button variant="outline" onClick={() => void saveProject()} disabled={saving || running}>{saving ? <LoaderCircle className="spin" /> : <Save />}保存</Button><Button variant="outline" onClick={() => void createVersion()} disabled={saving || running}><Archive />创建版本</Button><input ref={fileInput} hidden type="file" accept=".json,application/json" onChange={(event) => { const file = event.target.files?.[0]; if (!file) return; file.text().then((text) => { const parsed = JSON.parse(text) as PatentResult; if (parsed.schema !== 'skyview-patent-transfer-results') throw new Error('项目文件格式不兼容'); setResult(parsed); setProjectTitle(parsed.project.name); setMessage(`已导入 ${file.name}。`); }).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : '导入失败。')); }} /><Button variant="outline" onClick={() => fileInput.current?.click()} disabled={running}><FileUp />导入项目</Button><Button onClick={() => void execute('run-all')} disabled={running}>{running ? <LoaderCircle className="spin" /> : <Play />}执行完整评估</Button></div>
    </header>
    <section className="transfer-kpi-rail" aria-label="专利转化摘要">
      <article><TrendingUp /><span>转化准备度</span><strong>{result.readiness.total}</strong><small>/100 · {result.readiness.blockers.length} 项阻断</small></article>
      <article><FileSearch /><span>专利记录</span><strong>{result.landscape.records}</strong><small>{result.landscape.families} 个记录组</small></article>
      <article><Network /><span>权利要求</span><strong>{result.claims.length}</strong><small>{result.claimLint.errors} 错误 · {result.claimLint.warnings} 提醒</small></article>
      <article><Scale /><span>自由实施初筛</span><strong>{result.fto.high}</strong><small>高风险 · {result.fto.medium} 中风险</small></article>
      <article><Landmark /><span>证据支持成熟度</span><strong>{result.trl.backed}</strong><small>/9 · 自评 {result.trl.selected}</small></article>
      <article><BookOpenCheck /><span>质量门禁</span><strong>{passCount}</strong><small>/{result.qualityChecks.length} 项通过</small></article>
    </section>
    <nav className="transfer-tabs" aria-label="专利转化工作区">{views.map(([id, label], index) => <button key={id} className={selectedView === id ? 'active' : ''} onClick={() => setSelectedView(id)}><b>{String(index + 1).padStart(2, '0')}</b><span>{label}</span></button>)}</nav>
    {(message || error) && <div className={`transfer-status ${error ? 'error' : ''}`}>{error || message}</div>}
    <main className="transfer-main" data-view={selectedView}>
      {selectedView === 'overview' && <div className="transfer-view transfer-overview">
        <section className="transfer-surface transfer-readiness"><header><span>七维转化准备度</span><strong>证据加权决策盘</strong></header><ReadinessRadar result={result} /><div className="transfer-dimensions">{result.readiness.dimensions.map((item) => <p key={item.id}><span>{item.name}</span><i><b style={{ width: `${item.score}%` }} /></i><strong>{item.score}</strong></p>)}</div></section>
        <section className="transfer-surface transfer-pipeline"><header><span>九区联动链</span><strong>从交底到归档</strong></header><div>{views.map(([id, label], index) => <button key={id} onClick={() => setSelectedView(id)}><b>{String(index + 1).padStart(2, '0')}</b><span>{label}</span><small>{index < 3 ? '材料已载入' : index < 7 ? '分析已生成' : '等待复核'}</small></button>)}</div></section>
        <section className="transfer-surface transfer-blockers"><header><span>当前阻断项</span><strong>{result.readiness.blockers.length} 项待关闭</strong></header><div>{result.readiness.blockers.map((item) => <p key={item}><CircleAlert /><span>{item}</span></p>)}</div></section>
        <section className="transfer-surface transfer-gates"><header><span>交付门禁</span><strong>{passCount}/{result.qualityChecks.length} 通过</strong></header><div>{result.qualityChecks.map((item) => <p key={item.label} className={item.passed ? 'pass' : 'warn'}>{item.passed ? <CheckCircle2 /> : <CircleAlert />}<span>{item.label}</span></p>)}</div></section>
      </div>}
      {selectedView === 'disclosure' && <div className="transfer-view transfer-disclosure-layout">
        <section className="transfer-surface transfer-disclosure"><header><span>发明披露</span><strong>{result.disclosure.title}</strong></header><div className="transfer-form"><label htmlFor="transfer-title"><span>发明名称</span><Input id="transfer-title" value={result.disclosure.title} onChange={(event) => updateDisclosure('title', event.target.value)} /></label><label htmlFor="transfer-field"><span>技术领域</span><Input id="transfer-field" value={result.disclosure.field} onChange={(event) => updateDisclosure('field', event.target.value)} /></label><label className="wide"><span>待解决问题</span><textarea value={result.disclosure.problem} onChange={(event) => updateDisclosure('problem', event.target.value)} /></label><label className="wide"><span>技术方案</span><textarea value={result.disclosure.solution} onChange={(event) => updateDisclosure('solution', event.target.value)} /></label><label className="wide"><span>技术效果</span><textarea value={result.disclosure.effects} onChange={(event) => updateDisclosure('effects', event.target.value)} /></label></div></section>
        <section className="transfer-surface transfer-feature-list"><header><span>必要技术特征</span><strong>{result.features.length} 项 · 全部已映射</strong></header><div>{result.features.map((feature, index) => <article key={feature.id}><b>{String(index + 1).padStart(2, '0')}</b><div><strong>{feature.name}</strong><span>{feature.effect}</span><small>{feature.support}</small></div><em>必要</em></article>)}</div></section>
      </div>}
      {selectedView === 'search' && <div className="transfer-view transfer-search-layout">
        <section className="transfer-surface transfer-query"><header><span>检索策略</span><strong>通用布尔式与 EPO CQL</strong><Button size="sm" onClick={() => void execute('search-landscape')} disabled={running}><Play />重新分析</Button></header><label><span>通用检索式</span><textarea value={result.search.genericQuery} readOnly /></label><label><span>EPO CQL 草案</span><textarea value={result.search.epoCql} readOnly /></label><div className="transfer-source-row"><span>当前来源：本地示例语料</span><strong>官方数据连接待配置</strong></div></section>
        <section className="transfer-surface transfer-landscape"><header><span>分类景观</span><strong>{result.landscape.records} 条 · {result.landscape.citations} 次引用</strong></header><div className="transfer-treemap">{result.landscape.classifications.map((item, index) => <article key={item.name} style={{ flex: item.value }} data-tone={index % 4}><strong>{item.name}</strong><span>{item.value} 条</span></article>)}</div><div className="transfer-years">{result.landscape.years.map((item) => <p key={item.name}><span>{item.name}</span><i><b style={{ height: `${24 + item.value * 26}px` }} /></i><strong>{item.value}</strong></p>)}</div></section>
        <section className="transfer-surface transfer-patent-table"><header><span>专利记录</span><strong>去重记录与核验状态</strong></header><div className="transfer-table"><table><thead><tr><th>公开标识</th><th>题名</th><th>法域</th><th>优先权日</th><th>记录组</th><th>法律状态</th></tr></thead><tbody>{result.patents.map((patent) => <tr key={patent.id}><td><b>{patent.publicationNumber}</b></td><td>{patent.title}<small>{patent.applicant}</small></td><td>{patent.jurisdiction}</td><td>{patent.priorityDate}</td><td>{patent.familyId}</td><td><em className="pending">{patent.status}</em></td></tr>)}</tbody></table></div></section>
      </div>}
      {selectedView === 'novelty' && <div className="transfer-view transfer-novelty-layout">
        <section className="transfer-surface transfer-matrix"><header><span>必要特征矩阵</span><strong>{result.features.length} × {result.patents.length}</strong><small>完整 / 部分 / 未披露 / 待核验</small></header><div className="transfer-table"><table><thead><tr><th>必要技术特征</th>{result.patents.map((patent) => <th key={patent.id}>{patent.publicationNumber.replace('LOCAL-', '')}</th>)}</tr></thead><tbody>{result.features.map((feature) => <tr key={feature.id}><td><b>{feature.id}</b> {feature.name}</td>{result.patents.map((patent) => { const value = result.matrix[feature.id]?.[patent.id] ?? 'none'; return <td key={patent.id}><span className={`matrix-cell ${value}`}>{value === 'full' ? '完整' : value === 'partial' ? '部分' : value === 'uncertain' ? '待核验' : '—'}</span></td>; })}</tr>)}</tbody></table></div></section>
        <section className="transfer-surface transfer-novelty-rank"><header><span>单篇覆盖排序</span><strong>未发现完整覆盖全部要素的记录</strong></header><div>{result.novelty.map((item) => <article key={item.patentId}><b>{item.publicationNumber}</b><i><span style={{ width: `${item.coverageRate * 100}%` }} /></i><strong>{percent(item.coverageRate)}</strong><small>{item.full} 完整 · {item.partial} 部分</small></article>)}</div></section>
        <section className="transfer-surface transfer-could-would"><header><span>创造性分析</span><strong>问题—区别—效果—动机</strong></header><ol><li><b>最接近记录</b><span>{selectedPatent.publicationNumber} · {selectedPatent.title}</span></li><li><b>区别特征</b><span>质量标记与跨步骤证据链组合</span></li><li><b>技术效果</b><span>减少低质量输入干扰并保留决策可追溯性</span></li><li><b>客观技术问题</b><span>如何在异构监测条件下形成可复核风险结论</span></li><li><b>结合动机</b><span>待检索文献与技术审核共同确认</span></li></ol></section>
      </div>}
      {selectedView === 'claims' && <div className="transfer-view transfer-claims-layout">
        <section className="transfer-surface transfer-claim-tree"><header><span>权利要求树</span><strong>{result.claimLint.independent} 独立 · {result.claimLint.dependent} 从属</strong></header><div>{result.claims.map((claim) => <article key={claim.id} className={claim.type}><b>{claim.number}</b><div><strong>{claim.type === 'independent' ? '独立权利要求' : `从属于 ${claim.parentId?.replace('C', '')}`}</strong><p>{claim.text}</p><small>支持特征：{claim.supportFeatureIds.join('、')}</small></div></article>)}</div></section>
        <section className="transfer-surface transfer-lint"><header><span>结构化质检</span><strong>{result.claimLint.errors} 错误 · {result.claimLint.warnings} 提醒</strong><Button size="sm" onClick={() => void execute('claim-workbench')} disabled={running}><Play />重新检查</Button></header><div className="transfer-lint-score"><CheckCircle2 /><strong>{percent(result.claimLint.coverageRate)}</strong><span>必要特征支持映射</span></div><div>{result.claimLint.issues.map((item, index) => <p key={`${item.claimId}-${index}`} className={item.level}><CircleAlert /><span>{item.message}</span></p>)}</div></section>
      </div>}
      {selectedView === 'fto' && <div className="transfer-view transfer-fto-layout">
        <section className="transfer-surface transfer-risk-matrix"><header><span>风险矩阵</span><strong>概率 × 影响</strong></header><div className="risk-grid">{Array.from({ length: 25 }, (_, index) => <i key={index} data-risk={Math.floor(index / 5) + index % 5 >= 6 ? 'high' : Math.floor(index / 5) + index % 5 >= 3 ? 'medium' : 'low'} />)}{result.riskRegister.map((risk) => <button key={risk.id} style={{ left: `${(risk.impact - 0.5) * 20}%`, bottom: `${(risk.probability - 0.5) * 20}%` }} title={risk.description}>{risk.id}</button>)}</div><div className="risk-legend"><span>低</span><span>中</span><span>高</span></div></section>
        <section className="transfer-surface transfer-fto-table"><header><span>自由实施初筛</span><strong>要素相关性、法域与状态复核</strong><Button size="sm" onClick={() => void execute('fto-assess')} disabled={running}><Play />更新初筛</Button></header><div className="transfer-table"><table><thead><tr><th>记录</th><th>产品特征</th><th>覆盖</th><th>分数</th><th>法律状态</th><th>复核动作</th></tr></thead><tbody>{result.fto.rows.map((row) => <tr key={row.id}><td><b>{row.publicationNumber}</b></td><td>{row.productFeature}</td><td>{row.claimCoverage}%</td><td><em className={`risk ${row.level}`}>{row.score}</em></td><td><em className="pending">{row.legalStatus}</em></td><td>{row.notes}</td></tr>)}</tbody></table></div></section>
        <section className="transfer-surface transfer-risk-register"><header><span>风险登记簿</span><strong>{result.riskRegister.length} 项</strong></header><div>{result.riskRegister.map((risk) => <article key={risk.id}><b className={risk.level}>{risk.score}</b><div><strong>{risk.category}</strong><span>{risk.description}</span></div><small>{risk.owner}</small></article>)}</div></section>
      </div>}
      {selectedView === 'transfer' && <div className="transfer-view transfer-assessment-layout">
        <section className="transfer-surface transfer-trl"><header><span>技术成熟度路线</span><strong>自评 {result.trl.selected} · 连续证据支持 {result.trl.backed}</strong></header><div className="transfer-trl-line">{Array.from({ length: 9 }, (_, index) => { const level = index + 1; const evidence = result.trlEvidence.find((item) => item.level === level); return <article key={level} className={level <= result.trl.backed ? 'backed' : level === result.trl.selected ? 'selected' : ''}><b>{level}</b><span>TRL {level}</span><small>{evidence?.title ?? '待建立证据'}</small></article>; })}</div></section>
        <section className="transfer-surface transfer-valuation"><header><span>许可现金流估值</span><strong>风险调整现值 {money(result.valuationResult.npv)}</strong><Button size="sm" onClick={() => void execute('transfer-assess')} disabled={running}><Play />重新估值</Button></header><ValuationChart result={result} /></section>
        <section className="transfer-surface transfer-assumptions"><header><span>估值假设</span><strong>收益法 · 版税节省法</strong></header><dl><div><dt>首年收入</dt><dd>{money(result.valuation.annualRevenue)}</dd></div><div><dt>增长率</dt><dd>{result.valuation.growthRate}%</dd></div><div><dt>许可费率</dt><dd>{result.valuation.royaltyRate}%</dd></div><div><dt>成功概率</dt><dd>{result.valuation.successProbability}%</dd></div><div><dt>折现率</dt><dd>{result.valuation.discountRate}%</dd></div><div><dt>预测期</dt><dd>{result.valuation.years} 年</dd></div></dl></section>
      </div>}
      {selectedView === 'docket' && <div className="transfer-view transfer-docket-layout">
        <section className="transfer-surface transfer-deadlines"><header><span>期限时间线</span><strong>{result.deadlineAlerts.length} 个事项</strong><Button size="sm" onClick={() => void execute('deadline-check')} disabled={running}><Play />更新期限</Button></header><div>{result.deadlineAlerts.map((item) => <article key={item.id} className={item.level}><time>{item.date}<b>{item.days === null ? '—' : item.days < 0 ? `逾期 ${Math.abs(item.days)} 天` : `${item.days} 天后`}</b></time><i /><div><strong>{item.name}</strong><span>{item.owner}</span></div><em>{item.status === 'open' ? '待处理' : '已计划'}</em></article>)}</div></section>
        <section className="transfer-surface transfer-evidence"><header><span>证据与指纹</span><strong>{result.evidence.filter((item) => item.verified).length}/{result.evidence.length} 已复核</strong></header><div>{result.evidence.map((item) => <article key={item.id}>{item.verified ? <CheckCircle2 /> : <CircleAlert />}<div><strong>{item.title}</strong><span>{item.type}</span></div><code>{item.fingerprint}</code><em>{item.verified ? '已复核' : '待签署'}</em></article>)}</div></section>
      </div>}
      {selectedView === 'archive' && <div className="transfer-view transfer-archive-layout">
        <section className="transfer-surface transfer-deliverables"><header><span>完整交付包</span><strong>项目、矩阵、初筛、期限和证据指纹</strong></header><div className="transfer-export-grid"><button onClick={() => downloadText(result.exports.reportMarkdown, 'patent-transfer-assessment.md', 'text/markdown;charset=utf-8')}><Download /><strong>转化评估报告</strong><small>Markdown</small></button><button onClick={() => downloadText(result.exports.reportHtml, 'patent-transfer-assessment.html', 'text/html;charset=utf-8')}><Download /><strong>打印版报告</strong><small>HTML</small></button><button onClick={() => downloadText(result.exports.patentsCsv, 'patent-records.csv', 'text/csv;charset=utf-8')}><Download /><strong>专利记录</strong><small>CSV</small></button><button onClick={() => downloadText(result.exports.matrixCsv, 'patent-feature-matrix.csv', 'text/csv;charset=utf-8')}><Download /><strong>特征矩阵</strong><small>CSV</small></button><button onClick={() => downloadText(result.exports.ftoCsv, 'patent-fto-screening.csv', 'text/csv;charset=utf-8')}><Download /><strong>自由实施初筛</strong><small>CSV</small></button><button onClick={() => downloadText(result.exports.deadlinesCsv, 'patent-deadlines.csv', 'text/csv;charset=utf-8')}><Download /><strong>期限清单</strong><small>CSV</small></button><button className="primary" disabled={!result.exports.packageBase64} onClick={() => result.exports.packageBase64 && downloadBase64(result.exports.packageBase64, 'patent-transfer-package.zip')}><Archive /><strong>完整项目包</strong><small>{result.exports.packageBase64 ? 'ZIP' : '执行完整评估后生成'}</small></button></div></section>
        <section className="transfer-surface transfer-runtime"><header><span>外部运行时</span><strong>连接与核验边界</strong></header><dl><div><dt>Python 计算</dt><dd className="ready">已连接</dd><small>{result.runtime.compute}</small></div><div><dt>Go 项目与审计</dt><dd className="ready">已连接</dd><small>{result.runtime.orchestration}</small></div><div><dt>EPO OPS</dt><dd>待配置</dd><small>检索、家族与法律事件</small></div><div><dt>PatentsView</dt><dd>待配置</dd><small>美国专利查询适配器</small></div><div><dt>官方法律状态</dt><dd>待配置</dd><small>来源、时间和人工签名</small></div></dl></section>
        <section className="transfer-surface transfer-boundary"><header><span>交付边界</span><strong>复核职责</strong></header><div>{result.limitations.map((item) => <p key={item}><CircleAlert /><span>{item}</span></p>)}</div></section>
      </div>}
    </main>
  </section>;
}
