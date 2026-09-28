'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Activity, Box, CheckCircle2, CircleAlert, CloudCog, Download, FileArchive,
  FileUp, Gauge, HardDrive, Layers3, LoaderCircle, Play, RotateCcw, Save,
  ServerCog, ShieldCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLanguage } from '@/components/language-provider';
import { toolApi, type WorkbenchJob, type WorkbenchProject } from '@/services/api/tools';

type SolverId = 'screening' | 'sweep2d' | 'spatial3d' | 'ogs3d';
type PlotMode = 'state' | 'displacement' | 'stress';
type ViewId = 'overview' | 'model' | 'compute' | 'delivery';
type Zone = { id: number; x: number; y: number; z: number; state: string; ux: number; uz: number; displacement: number; verticalStress: number };
type Model = {
  geometry: { slopeHeight: number; slopeAngle: number; totalLength: number; totalHeight: number; width: number; crestX: number; toeX: number };
  mesh: { xZones: number; yZones: number; zZones: number; zoneCount: number; gridpointCount: number };
  material: { model: string; density: number; youngModulus: number; poissonRatio: number; bulkModulus: number; shearModulus: number; cohesion: number; friction: number; tension: number; dilation: number };
  boundary: { base: string; sides: string; gravity: number };
  reduction: { lower: number; upper: number; resolution: number; ratioLocal: number };
  screening: { slipDepth: number; porePressureRatio: number };
};
type SolverState = { id: SolverId; name: string; engine: string; dimension: string; status: 'ready' | 'busy' | 'offline'; available: boolean; detail: string };
type Workspace = {
  schema: string; version: number; updatedAt: string;
  project: { id: string; name: string; solver: string }; model: Model;
  validation: { passed: boolean; checks: Array<{ id: string; label: string; passed: boolean }>; failed: string[] };
  screening: { method: string; factorOfSafety: number; classification: string; boundary: string; criticalSurface?: { depth: number; inclination: number }; candidateCount?: number };
  result: {
    source: { kind: string; fileName: string; sha256: string | null; rowCount: number };
    metrics: { factorOfSafety: number; stableFactor: number; unstableFactor: number; zoneCount: number; gridpointCount: number | null; maxDisplacement: number; minVerticalStress: number; maxVerticalStress: number; activeYieldRatio: number; elasticRatio: number };
    stateDistribution: Array<{ state: string; count: number; ratio: number }>;
    categoryDistribution: Array<{ category: string; count: number; ratio: number }>;
    bounds: { x: [number, number]; y: [number, number]; z: [number, number] };
    section: { axis: string; value: number; zones: Zone[]; grid?: { xZones: number; zZones: number } }; interpretation: string[];
  };
  runtime: { adapter: string; configured: boolean; available: boolean; executionEnabled: boolean; executable: string | null; mode: string; requirements: string[]; solvers?: SolverState[] };
  sourceFiles: Array<{ name: string; bytes: number; sha256: string }>;
  audit: Array<{ at: string; action: string; detail: string }>;
  exports: { reportMarkdown: string; modelJson: string; runScript: string; callFile: string; manifestJson: string; packageBase64: string };
};

const defaultModel: Model = {
  geometry: { slopeHeight: 10, slopeAngle: 45, totalLength: 30, totalHeight: 20, width: 5, crestX: 10, toeX: 20 },
  mesh: { xZones: 30, yZones: 5, zZones: 20, zoneCount: 3000, gridpointCount: 3906 },
  material: { model: 'mohr-coulomb', density: 1750, youngModulus: 35_000_000, poissonRatio: 0.3, bulkModulus: 29_166_666.67, shearModulus: 13_461_538.46, cohesion: 24_000, friction: 25, tension: 10_000, dilation: 0 },
  boundary: { base: 'fixed', sides: 'normal-roller', gravity: 9.81 },
  reduction: { lower: 0.8, upper: 2.2, resolution: 0.01, ratioLocal: 0.0001 }, screening: { slipDepth: 2, porePressureRatio: 0 },
};
const defaultSolvers: SolverState[] = [
  { id: 'screening', name: '快速验算', engine: 'Python 极限平衡筛查', dimension: '2D', status: 'ready', available: true, detail: '服务端内置，无需安装' },
  { id: 'sweep2d', name: '二维滑面搜索', engine: 'Python 参数化滑面搜索', dimension: '2D', status: 'ready', available: true, detail: '服务端内置，多深度与倾角搜索' },
  { id: 'spatial3d', name: '三维空间校核', engine: 'Python 多剖面空间修正', dimension: '3D 估算', status: 'ready', available: true, detail: '服务端内置，考虑坡体宽高比' },
  { id: 'ogs3d', name: '三维有限元', engine: 'OpenGeoSys', dimension: '3D FEM', status: 'offline', available: false, detail: '等待接入计算节点' },
];
const initialWorkspace: Workspace = {
  schema: 'skyview-open-slope-workspace', version: 2, updatedAt: '2026-09-10T00:00:00+08:00',
  project: { id: 'SLOPE-001', name: '黄土边坡强度折减分析', solver: '开放求解服务' }, model: defaultModel,
  validation: { passed: true, failed: [], checks: [
    { id: 'geometry', label: '坡顶、坡脚与模型边界关系', passed: true }, { id: 'height', label: '坡高位于模型高度内', passed: true },
    { id: 'mesh', label: '网格规模位于受控范围', passed: true }, { id: 'elastic', label: '弹性参数物理有效', passed: true },
    { id: 'strength', label: '强度参数非负', passed: true }, { id: 'bracket', label: '强度折减搜索区间有效', passed: true },
  ] },
  screening: { method: 'infinite-slope-screening', factorOfSafety: 1.865, classification: 'stable', boundary: '快速验算用于方案筛查；正式结论应由二维或三维有限元复核。' },
  result: {
    source: { kind: 'archived-zone-results', fileName: 'slope_zones_fos_results.csv', sha256: null, rowCount: 3000 },
    metrics: { factorOfSafety: 1.81, stableFactor: 1.81, unstableFactor: 1.82, zoneCount: 3000, gridpointCount: 3906, maxDisplacement: 0.250496, minVerticalStress: -315442.36, maxVerticalStress: -2756.94, activeYieldRatio: 1261 / 3000, elasticRatio: 585 / 3000 },
    stateDistribution: [{ state: 'shear-n tension-n', count: 1261, ratio: 1261 / 3000 }, { state: 'tension-p', count: 1125, ratio: 1125 / 3000 }, { state: 'elastic', count: 585, ratio: 585 / 3000 }, { state: 'shear-p tension-p', count: 29, ratio: 29 / 3000 }],
    categoryDistribution: [{ category: 'active', count: 1261, ratio: 1261 / 3000 }, { category: 'history', count: 1154, ratio: 1154 / 3000 }, { category: 'elastic', count: 585, ratio: 585 / 3000 }],
    bounds: { x: [0.5, 29.5], y: [0.5, 4.5], z: [0.25, 19.5] }, section: { axis: 'y', value: 2.5, zones: [] },
    interpretation: ['坡顶至坡脚之间形成连续的剪切—拉伸屈服带。', '最大位移集中于坡体上部和坡面附近。', '稳定与失稳状态构成 0.01 精度的安全系数包络。'],
  },
  runtime: { adapter: 'open-geotechnical-solver-orchestrator', configured: true, available: true, executionEnabled: true, executable: null, mode: 'hybrid-web-compute', requirements: ['三种网页算法已内置', '有限元在隔离计算节点运行', '客户端无需安装求解器'], solvers: defaultSolvers },
  sourceFiles: [], audit: [], exports: { reportMarkdown: '', modelJson: '', runScript: '', callFile: '', manifestJson: '', packageBase64: '' },
};
const terminalStatuses = new Set(['succeeded', 'failed', 'canceled']);

async function waitForJob(id: string): Promise<WorkbenchJob | null> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const job = await toolApi.getJob(id);
    if (terminalStatuses.has(job.status)) return job;
    await new Promise((resolve) => window.setTimeout(resolve, 400));
  }
  return null;
}
function numberValue(value: string, fallback: number) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
function geometryAfterEdit(current: Model['geometry'], key: keyof Model['geometry'], rawValue: string): Model['geometry'] {
  const next = { ...current, [key]: numberValue(rawValue, current[key]) };
  next.slopeHeight = Math.max(1, next.slopeHeight); next.slopeAngle = Math.max(5, Math.min(85, next.slopeAngle));
  if (key === 'toeX') {
    const requestedRun = Math.max(0.01, next.toeX - next.crestX); const requestedAngle = Math.atan2(next.slopeHeight, requestedRun) * 180 / Math.PI;
    next.slopeAngle = Math.max(5, Math.min(85, requestedAngle));
  }
  if (key === 'slopeAngle' || key === 'slopeHeight' || key === 'crestX' || key === 'toeX') {
    next.toeX = next.crestX + next.slopeHeight / Math.tan(next.slopeAngle * Math.PI / 180);
    if (next.toeX >= next.totalLength) next.totalLength = next.toeX + Math.max(1, Math.min(next.slopeHeight, next.totalLength * 0.15));
  }
  if (next.totalHeight <= next.slopeHeight) next.totalHeight = next.slopeHeight + 1;
  return next;
}
function downloadText(content: string, fileName: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type })); const anchor = document.createElement('a');
  anchor.href = url; anchor.download = fileName; anchor.click(); URL.revokeObjectURL(url);
}
function downloadBase64(content: string, fileName: string) {
  const bytes = Uint8Array.from(atob(content), (character) => character.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' })); const anchor = document.createElement('a');
  anchor.href = url; anchor.download = fileName; anchor.click(); URL.revokeObjectURL(url);
}
function parseReferenceCsv(source: string): Zone[] {
  const lines = source.trim().split(/\r?\n/); const headers = lines.shift()?.split(',') ?? [];
  const field = (row: string[], name: string) => row[headers.indexOf(name)] ?? '';
  const rows = lines.map((line) => { const row = line.split(','); return { id: Number(field(row, 'id')), x: Number(field(row, 'x')), y: Number(field(row, 'y')), z: Number(field(row, 'z')), state: field(row, 'state_name'), ux: Number(field(row, 'disp_x')), uz: Number(field(row, 'disp_z')), displacement: Number(field(row, 'disp_mag')), verticalStress: Number(field(row, 'szz')) }; });
  const sectionY = [...new Set(rows.map((row) => row.y))].sort((a, b) => Math.abs(a - 2.5) - Math.abs(b - 2.5))[0] ?? 2.5;
  return rows.filter((row) => Math.abs(row.y - sectionY) < 0.0001);
}
function colorForZone(zone: Zone, mode: PlotMode, workspace: Workspace) {
  if (mode === 'state') { if (zone.state === 'elastic') return '#d6deea'; if (zone.state.includes('-n')) return '#c74a3a'; if (zone.state.includes('shear')) return '#79549a'; return '#df942f'; }
  if (mode === 'displacement') { const ratio = Math.max(0, Math.min(1, zone.displacement / workspace.result.metrics.maxDisplacement)); return `hsl(${205 - ratio * 182} 72% ${73 - ratio * 26}%)`; }
  const minimum = workspace.result.metrics.minVerticalStress; const maximum = workspace.result.metrics.maxVerticalStress;
  const ratio = Math.max(0, Math.min(1, (zone.verticalStress - minimum) / Math.max(1, maximum - minimum))); return `hsl(${12 + ratio * 208} 64% ${48 + ratio * 20}%)`;
}
function SlopeSection({ workspace, mode }: { workspace: Workspace; mode: PlotMode }) {
  const zones = workspace.result.section.zones; const geometry = workspace.model.geometry;
  const mapX = (value: number) => 48 + value / geometry.totalLength * 664; const mapZ = (value: number) => 360 - value / geometry.totalHeight * 306;
  const xCount = workspace.result.section.grid?.xZones ?? (new Set(zones.map((zone) => zone.x)).size || workspace.model.mesh.xZones);
  const zCount = workspace.result.section.grid?.zZones ?? (new Set(zones.map((zone) => zone.z)).size || workspace.model.mesh.zZones);
  const cellWidth = Math.max(3, 664 / xCount - 2); const cellHeight = Math.max(3, 306 / zCount - 2);
  const boundary = `M ${mapX(0)} ${mapZ(0)} L ${mapX(geometry.totalLength)} ${mapZ(0)} L ${mapX(geometry.totalLength)} ${mapZ(geometry.totalHeight - geometry.slopeHeight)} L ${mapX(geometry.toeX)} ${mapZ(geometry.totalHeight - geometry.slopeHeight)} L ${mapX(geometry.crestX)} ${mapZ(geometry.totalHeight)} L ${mapX(0)} ${mapZ(geometry.totalHeight)} Z`;
  const slipDepth = workspace.screening.criticalSurface?.depth ?? workspace.model.screening.slipDepth;
  const slipPoints = Array.from({ length: 17 }, (_, index) => { const progress = index / 16; const x = geometry.crestX + (geometry.toeX - geometry.crestX) * progress; const z = geometry.totalHeight - geometry.slopeHeight * progress - slipDepth * Math.sin(Math.PI * progress); return `${index ? 'L' : 'M'} ${mapX(x).toFixed(1)} ${mapZ(z).toFixed(1)}`; }).join(' ');
  const xTicks = Array.from({ length: 7 }, (_, index) => geometry.totalLength * index / 6); const zTicks = Array.from({ length: 5 }, (_, index) => geometry.totalHeight * index / 4);
  return <svg className="flac-section" viewBox="0 0 760 400" aria-label="边坡临界状态剖面"><title>边坡临界状态剖面</title><g className="flac-grid-lines">{xTicks.map((value) => <line key={`x-${value}`} x1={mapX(value)} x2={mapX(value)} y1="42" y2="362" />)}{zTicks.map((value) => <line key={`z-${value}`} x1="46" x2="714" y1={mapZ(value)} y2={mapZ(value)} />)}</g><path className="flac-slope-fill" d={boundary} />{zones.map((zone) => <rect key={zone.id} x={mapX(zone.x) - cellWidth / 2} y={mapZ(zone.z) - cellHeight / 2} width={cellWidth} height={cellHeight} rx="1.5" fill={colorForZone(zone, mode, workspace)}><title>{`单元 ${zone.id} · ${zone.state} · 位移 ${zone.displacement.toFixed(5)} m`}</title></rect>)}<path className="flac-slip-line" d={slipPoints} /><path className="flac-slope-outline" d={boundary} /><g className="flac-axis-labels"><text x="48" y="385">0 m</text><text x="680" y="385">{geometry.totalLength.toFixed(0)} m</text><text x="14" y="362">0</text><text x="8" y="62">{geometry.totalHeight.toFixed(0)} m</text><text x={mapX(geometry.crestX) - 18} y={mapZ(geometry.totalHeight) - 12}>坡顶</text><text x={mapX(geometry.toeX) + 8} y={mapZ(geometry.totalHeight - geometry.slopeHeight) - 8}>坡脚</text></g>{!zones.length && <text className="flac-loading-label" x="380" y="205" textAnchor="middle">正在载入基准图层…</text>}</svg>;
}
function ReductionCurve({ factor, stable, unstable }: { factor: number; stable: number; unstable: number }) {
  const peakIndex = Math.max(4, Math.min(8, Math.round(3 + factor * 2))); const peakY = Math.max(27, 50 - factor * 9);
  const points = Array.from({ length: 10 }, (_, index) => { const x = 48 + index * 57; const y = index <= peakIndex ? 112 - (112 - peakY) * Math.pow(index / peakIndex, 1.18) : peakY + (113 - peakY) * Math.pow((index - peakIndex) / (9 - peakIndex), .78); return { x, y }; });
  const smoothPath = points.map((point, index) => { if (!index) return `M ${point.x} ${point.y.toFixed(1)}`; const previous = points[index - 1]; const controlX = (previous.x + point.x) / 2; return `C ${controlX.toFixed(1)} ${previous.y.toFixed(1)}, ${controlX.toFixed(1)} ${point.y.toFixed(1)}, ${point.x} ${point.y.toFixed(1)}`; }).join(' ');
  const peak = points[peakIndex]; const labelX = Math.max(16, Math.min(450, peak.x - 82));
  return <svg className="flac-curve" viewBox="0 0 620 142" aria-label={`强度折减响应，临界区间 ${stable.toFixed(2)} 至 ${unstable.toFixed(2)}`}><title>强度折减响应曲线</title><defs><linearGradient id="flac-curve-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#0b8d9d" stopOpacity=".28" /><stop offset="100%" stopColor="#0b8d9d" stopOpacity=".015" /></linearGradient><linearGradient id="flac-critical-band" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stopColor="#d6654f" stopOpacity="0" /><stop offset="50%" stopColor="#d6654f" stopOpacity=".14" /><stop offset="100%" stopColor="#d6654f" stopOpacity="0" /></linearGradient></defs><g className="flac-curve-grid">{[31, 58, 85, 112].map((y) => <line key={`y-${y}`} x1="36" x2="588" y1={y} y2={y} />)}{points.map(({ x }) => <line key={`x-${x}`} x1={x} x2={x} y1="18" y2="116" />)}</g><rect className="flac-critical-band" x={peak.x - 34} y="18" width="68" height="98" rx="12" /><path className="flac-curve-area" d={`${smoothPath} L ${points.at(-1)?.x} 116 L ${points[0].x} 116 Z`} /><path className="flac-curve-line" d={smoothPath} />{points.map((point, index) => <circle key={`point-${point.x}`} className={index === peakIndex ? 'critical' : 'sample'} cx={point.x} cy={point.y} r={index === peakIndex ? 5.5 : 2.4} />)}<g className="flac-critical-label" transform={`translate(${labelX} 5)`}><rect width="164" height="25" rx="12.5" /><text x="82" y="16.5" textAnchor="middle">临界区间 {stable.toFixed(2)}–{unstable.toFixed(2)}</text></g><g className="flac-curve-phases"><text x="40" y="135">稳定收敛</text><text x={peak.x} y="135" textAnchor="middle">临界阈值</text><text x="584" y="135" textAnchor="end">失稳响应</text></g></svg>;
}

export function Flac3dSlopeWorkbench({ executionAllowed = true }: { executionAllowed?: boolean }) {
  const { text } = useLanguage(); const [workspace, setWorkspace] = useState<Workspace>(initialWorkspace); const [model, setModel] = useState<Model>(defaultModel);
  const [projects, setProjects] = useState<WorkbenchProject[]>([]); const [projectId, setProjectId] = useState(''); const [selectedEngine, setSelectedEngine] = useState<SolverId>('screening');
  const [view, setView] = useState<ViewId>('overview'); const [mode, setMode] = useState<PlotMode>('state'); const [running, setRunning] = useState(false); const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('基准图层已载入，可直接运行快速验算。'); const [error, setError] = useState(''); const uploadRef = useRef<HTMLInputElement>(null);
  useEffect(() => { let active = true; fetch('/assets/data/flac3d/slope_zones_fos_results.csv').then((response) => response.ok ? response.text() : Promise.reject(new Error('基准数据不可用'))).then((source) => active && setWorkspace((current) => ({ ...current, result: { ...current.result, section: { ...current.result.section, zones: parseReferenceCsv(source) } } }))).catch(() => setMessage('基准摘要已载入；图层数据可从交付页重新导入。')); toolApi.listProjects('flac3d-slope-stability').then((items) => active && setProjects(items)).catch(() => undefined); return () => { active = false; }; }, []);
  const solvers = workspace.runtime.solvers?.length ? workspace.runtime.solvers : defaultSolvers; const activeSolver = solvers.find((item) => item.id === selectedEngine) ?? solvers[0]; const metrics = workspace.result.metrics;
  const resultFactor = selectedEngine === 'ogs3d' ? metrics.factorOfSafety : workspace.screening.factorOfSafety; const classification = resultFactor >= 1.3 ? 'stable' : resultFactor >= 1.05 ? 'attention' : 'unstable';
  const projectState = (current = workspace) => ({ slopeAnalysis: { model, selectedEngine, workspace: { ...current, exports: { ...current.exports, packageBase64: '' } } } });
  const ensureProject = async () => { const existing = projects.find((item) => item.id === projectId); if (existing) return existing; const created = await toolApi.createProject('flac3d-slope-stability', workspace.project.name, projectState()); setProjects((items) => [created, ...items]); setProjectId(created.id); return created; };
  const run = async (action: string, extra: Record<string, unknown> = {}) => {
    if (!executionAllowed) { setError('计算服务暂未连接。'); return null; } setRunning(true); setError(''); setMessage(action === 'execute-open-source' ? `正在向 ${activeSolver.engine} 提交任务…` : '正在计算并校验结果…');
    try { const project = await ensureProject(); const created = await toolApi.createJob(project.id, 'flac3d-slope-stability', action, { model, engine: selectedEngine, ...extra }, crypto.randomUUID()); const job = await waitForJob(created.job.id); if (!job) { await toolApi.cancelJob(created.job.id).catch(() => undefined); throw new Error('计算节点在 20 秒内没有响应，本次任务已取消，请重新提交。'); } if (job.status !== 'succeeded') throw new Error(job.error || '任务执行失败。'); if (action === 'solver-status' || action === 'runtime-status') { const result = job.result as { runtime?: Workspace['runtime'] }; if (result.runtime) setWorkspace((current) => ({ ...current, runtime: result.runtime! })); setMessage('计算服务状态已更新。'); return job.result; } const next = job.result as unknown as Workspace; setWorkspace(next); setModel(next.model); setMessage(selectedEngine === 'ogs3d' ? '精细计算完成，结果和审计记录已更新。' : `${activeSolver.name}完成，安全系数 ${next.screening.factorOfSafety.toFixed(2)}，结果图层已重建。`); return next; }
    catch (caught) { setError(caught instanceof Error ? caught.message : '任务执行失败。'); setMessage('已保留当前参数和基准图层。'); return null; } finally { setRunning(false); }
  };
  const save = async () => { setSaving(true); setError(''); try { const record = await ensureProject(); const updated = await toolApi.updateProject(record.id, workspace.project.name, projectState()); await toolApi.createVersion(updated.id, `边坡分析快照 ${new Date().toLocaleString('zh-CN')}`, updated.state); setProjects((items) => [updated, ...items.filter((item) => item.id !== updated.id)]); setMessage('项目参数、结果和版本记录已保存。'); } catch (caught) { setError(caught instanceof Error ? caught.message : '保存失败。'); } finally { setSaving(false); } };
  const setGeometry = (key: keyof Model['geometry'], value: string) => setModel((current) => ({ ...current, geometry: geometryAfterEdit(current.geometry, key, value) }));
  const setMaterial = (key: keyof Model['material'], value: string) => { if (key !== 'model') setModel((current) => ({ ...current, material: { ...current.material, [key]: numberValue(value, Number(current.material[key])) } })); };
  const setMesh = (key: 'xZones' | 'yZones' | 'zZones', value: string) => setModel((current) => ({ ...current, mesh: { ...current.mesh, [key]: numberValue(value, current.mesh[key]) } }));
  const setScreening = (key: keyof Model['screening'], value: string) => setModel((current) => ({ ...current, screening: { ...current.screening, [key]: numberValue(value, current.screening[key]) } }));
  const importResults = async (file: File | undefined) => { if (!file) return; if (file.size > 8_000_000) { setError('分区结果 CSV 不得超过 8 MB。'); return; } await run('import-results', { csv: await file.text() }); };
  const prepareAndDownload = async () => { const next = (await run('prepare-run')) as Workspace | null; if (next?.exports.packageBase64) downloadBase64(next.exports.packageBase64, 'slope-analysis-run-package.zip'); };
  const executeSelected = () => run(selectedEngine === 'ogs3d' ? 'execute-open-source' : 'screen-stability', { engine: selectedEngine });
  const tabs: Array<[ViewId, string]> = [['overview', text('分析总览', 'Overview')], ['model', text('模型参数', 'Model')], ['compute', text('计算服务', 'Compute')], ['delivery', text('成果交付', 'Delivery')]];
  const plotModes: Array<[PlotMode, string]> = [['state', text('塑性状态', 'Plastic state')], ['displacement', text('位移场', 'Displacement')], ['stress', text('竖向应力', 'Vertical stress')]];
  const isAnalyticalField = workspace.result.source.kind === 'web-analytical-field';
  return <section className="flac-workbench" aria-label={text('边坡数值分析工作台', 'Slope numerical analysis workbench')}>
    <header className="flac-topbar"><div className="flac-identity"><span><Layers3 />{text('岩土计算', 'Geotechnical compute')}</span><strong>{text('边坡数值分析', 'Slope numerical analysis')}</strong><small>{workspace.project.name}</small></div><nav className="flac-tabs">{tabs.map(([id, label]) => <button key={id} type="button" className={view === id ? 'active' : ''} onClick={() => setView(id)}>{label}</button>)}</nav><div className="flac-actions"><select value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">{text('当前基准项目', 'Current benchmark')}</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}</select><Button variant="outline" onClick={save} disabled={saving || running}>{saving ? <LoaderCircle className="spin" /> : <Save />}{text('保存', 'Save')}</Button><Button onClick={executeSelected} disabled={running || !activeSolver.available}>{running ? <LoaderCircle className="spin" /> : <Play />}{selectedEngine === 'ogs3d' ? text('提交有限元', 'Submit FEM') : text('立即计算', 'Calculate')}</Button></div></header>
    <div className="flac-kpis"><article className="primary"><span>{selectedEngine === 'screening' ? text('快速安全系数', 'Screening factor') : text('强度折减安全系数', 'Strength reduction factor')}</span><strong>{resultFactor.toFixed(2)}</strong><small data-level={classification}>{classification === 'stable' ? text('稳定', 'Stable') : classification === 'attention' ? text('需关注', 'Attention') : text('不稳定', 'Unstable')}</small></article><article><span>{text('稳定 / 失稳包络', 'Stable / unstable')}</span><strong>{metrics.stableFactor.toFixed(2)} / {metrics.unstableFactor.toFixed(2)}</strong><small>{text('搜索精度 0.01', 'Resolution 0.01')}</small></article><article><span>{text('网格规模', 'Mesh')}</span><strong>{metrics.zoneCount.toLocaleString()}</strong><small>{(metrics.gridpointCount ?? 0).toLocaleString()} {text('节点', 'gridpoints')}</small></article><article><span>{text('最大位移', 'Max displacement')}</span><strong>{metrics.maxDisplacement.toFixed(3)} m</strong><small>{text('临界状态', 'Critical state')}</small></article><article><span>{text('当前屈服区', 'Active yield')}</span><strong>{(metrics.activeYieldRatio * 100).toFixed(1)}%</strong><small>{Math.round(metrics.activeYieldRatio * metrics.zoneCount)} {text('个单元', 'zones')}</small></article></div>
    <div className="flac-stage">
      {view === 'overview' && <><aside className="flac-panel flac-input-dock"><header><div><span>{text('模型与工况', 'Model & conditions')}</span><small>Mohr–Coulomb</small></div><button type="button" onClick={() => run('run-all')} title={text('恢复基准', 'Reset')}><RotateCcw /></button></header><div className="flac-quick-fields"><label><span>{text('坡高', 'Height')}</span><div><input type="number" value={model.geometry.slopeHeight} onChange={(e) => setGeometry('slopeHeight', e.target.value)} /><em>m</em></div></label><label><span>{text('坡角', 'Angle')}</span><div><input type="number" value={model.geometry.slopeAngle} onChange={(e) => setGeometry('slopeAngle', e.target.value)} /><em>°</em></div></label><label><span>{text('黏聚力', 'Cohesion')}</span><div><input type="number" value={model.material.cohesion / 1000} onChange={(e) => setMaterial('cohesion', String(numberValue(e.target.value, 24) * 1000))} /><em>kPa</em></div></label><label><span>{text('摩擦角', 'Friction')}</span><div><input type="number" value={model.material.friction} onChange={(e) => setMaterial('friction', e.target.value)} /><em>°</em></div></label><label><span>{text('滑面深度', 'Slip depth')}</span><div><input type="number" value={model.screening.slipDepth} onChange={(e) => setScreening('slipDepth', e.target.value)} /><em>m</em></div></label><label><span>{text('孔压比', 'Pore ratio')}</span><div><input type="number" step="0.05" value={model.screening.porePressureRatio} onChange={(e) => setScreening('porePressureRatio', e.target.value)} /><em>ru</em></div></label></div><div className="flac-engine-list"><span>{text('计算方法', 'Calculation method')}</span>{solvers.map((solver) => <button key={solver.id} type="button" className={selectedEngine === solver.id ? 'active' : ''} data-ready={solver.available} onClick={() => setSelectedEngine(solver.id)}><i>{solver.id === 'screening' ? <Gauge /> : solver.id === 'sweep2d' ? <Box /> : solver.id === 'spatial3d' ? <CloudCog /> : <ServerCog />}</i><span><strong>{solver.name}</strong><small>{solver.engine} · {solver.dimension}</small></span><em>{solver.available ? text('网页直算', 'Web ready') : text('待接入', 'Offline')}</em></button>)}</div><Button className="flac-run-wide" onClick={executeSelected} disabled={running || !activeSolver.available}>{running ? <LoaderCircle className="spin" /> : <Play />}{selectedEngine === 'ogs3d' ? text('提交有限元计算', 'Submit FEM run') : text('直接网页计算', 'Calculate on web')}</Button></aside>
      <main className="flac-visual-stack"><article className="flac-panel flac-plot-card"><header><div><span>{text('临界状态剖面', 'Critical state section')}</span><small>Y = {workspace.result.section.value.toFixed(1)} m · {isAnalyticalField ? text('本次网页解析计算场', 'Current analytical field') : text('有限元 / 归档结果图层', 'FEM / archived result layer')}</small></div><div className="flac-segmented">{plotModes.map(([id, label]) => <button key={id} type="button" className={mode === id ? 'active' : ''} onClick={() => setMode(id)}>{label}</button>)}</div></header><SlopeSection workspace={workspace} mode={mode} /><footer><span><i className="active" />{text('当前屈服', 'Active yield')}</span><span><i className="history" />{text('历史屈服', 'Yield history')}</span><span><i className="elastic" />{text('弹性区', 'Elastic')}</span><b>{isAnalyticalField ? text('虚线：本次临界滑移带', 'Dashed: current critical slip band') : text('虚线：结果临界滑移带', 'Dashed: result slip band')}</b></footer></article><article className="flac-panel flac-curve-card"><header><div><span>{text('强度折减响应', 'Strength reduction response')}</span><small>{text('迭代残差与失稳判定', 'Iteration residual and failure threshold')}</small></div><strong>{metrics.stableFactor.toFixed(2)} <em>FOS</em></strong></header><ReductionCurve factor={resultFactor} stable={metrics.stableFactor} unstable={metrics.unstableFactor} /></article></main>
      <aside className="flac-panel flac-decision-dock"><header><div><span>{text('计算判读', 'Result review')}</span><small>{activeSolver.engine}</small></div><ShieldCheck /></header><section className="flac-result-hero" data-level={classification}><span>{text('安全系数', 'Factor of safety')}</span><strong>{resultFactor.toFixed(2)}</strong><em>{classification === 'stable' ? text('稳定', 'Stable') : classification === 'attention' ? text('需关注', 'Attention') : text('不稳定', 'Unstable')}</em></section><div className="flac-validation-strip"><CheckCircle2 /><span><strong>{workspace.validation.checks.filter((item) => item.passed).length}/{workspace.validation.checks.length} {text('项检查通过', 'checks passed')}</strong><small>{workspace.validation.passed ? text('允许提交计算', 'Ready to submit') : text('存在阻断项', 'Blocked')}</small></span></div><div className="flac-distribution">{workspace.result.categoryDistribution.map((item) => <div key={item.category}><span>{item.category === 'active' ? text('当前屈服', 'Active') : item.category === 'history' ? text('历史屈服', 'History') : text('弹性区', 'Elastic')}<b>{item.count}</b></span><i><em style={{ width: `${item.ratio * 100}%` }} data-category={item.category} /></i></div>)}</div><ul>{workspace.result.interpretation.map((item) => <li key={item}>{item}</li>)}</ul><div className="flac-source-proof"><HardDrive /><span><strong>{text('结果来源可追溯', 'Traceable result source')}</strong><small>{workspace.result.source.fileName} · {workspace.result.source.rowCount.toLocaleString()} {text('行', 'rows')}</small></span></div></aside></>}
      {view === 'model' && <div className="flac-parameter-layout"><ParameterCard title={text('几何与网格', 'Geometry & mesh')} hint={`${model.mesh.xZones * model.mesh.yZones * model.mesh.zZones} ${text('单元', 'zones')}`} fields={([['slopeHeight', text('坡高（m）', 'Slope height (m)')], ['slopeAngle', text('坡角（°）', 'Slope angle (°)')], ['totalLength', text('模型长度（m）', 'Length (m)')], ['totalHeight', text('模型高度（m）', 'Height (m)')], ['width', text('模型宽度（m）', 'Width (m)')], ['crestX', text('坡顶 X（m）', 'Crest X (m)')], ['toeX', text('坡脚 X（m）', 'Toe X (m)')]] as Array<[keyof Model['geometry'], string]>).map(([key, label]) => ({ key, label, value: model.geometry[key], set: (value: string) => setGeometry(key, value) }))} /><ParameterCard title={text('材料与强度折减', 'Material & reduction')} hint="SI" fields={([['density', text('密度（kg/m³）', 'Density (kg/m³)')], ['youngModulus', text('杨氏模量（Pa）', 'Young modulus (Pa)')], ['poissonRatio', text('泊松比', 'Poisson ratio')], ['cohesion', text('黏聚力（Pa）', 'Cohesion (Pa)')], ['friction', text('摩擦角（°）', 'Friction (°)')], ['tension', text('抗拉强度（Pa）', 'Tension (Pa)')], ['dilation', text('剪胀角（°）', 'Dilation (°)')]] as Array<[keyof Model['material'], string]>).map(([key, label]) => ({ key, label, value: Number(model.material[key]), set: (value: string) => setMaterial(key, value) }))} /><aside className="flac-panel flac-validation-list"><header><span>{text('计算前门禁', 'Pre-run gates')}</span></header>{workspace.validation.checks.map((check) => <div key={check.id} data-passed={check.passed}>{check.passed ? <CheckCircle2 /> : <CircleAlert />}<span>{check.label}</span></div>)}<Button onClick={() => run('validate-model')} disabled={running}><ShieldCheck />{text('校验并更新', 'Validate & update')}</Button></aside></div>}
      {view === 'compute' && <div className="flac-compute-layout"><article className="flac-panel flac-service-card"><header><div><span>{text('网页计算服务', 'Web compute services')}</span><small>{text('客户端零安装', 'Zero client installation')}</small></div><button type="button" onClick={() => run('solver-status')}>{text('刷新状态', 'Refresh')}</button></header><div className="flac-service-grid">{solvers.map((solver) => <button key={solver.id} className={selectedEngine === solver.id ? 'active' : ''} type="button" onClick={() => setSelectedEngine(solver.id)}><i data-ready={solver.available}>{solver.available ? <CheckCircle2 /> : <ServerCog />}</i><span><strong>{solver.name}</strong><small>{solver.engine}</small></span><em>{solver.dimension}</em><p>{solver.detail}</p></button>)}</div></article><article className="flac-panel flac-pipeline-card"><header><span>{text('受控计算链', 'Controlled compute pipeline')}</span><small>Go + Python</small></header><ol>{[['01', '输入校验', '单位、边界与网格门禁'], ['02', '任务编排', '权限、配额、队列和幂等控制'], ['03', '隔离求解', activeSolver.engine], ['04', '结果归档', '图层、指标、日志与校验摘要']].map(([n, title, note]) => <li key={n}><b>{n}</b><span><strong>{title}</strong><small>{note}</small></span></li>)}</ol><Button onClick={executeSelected} disabled={running || !activeSolver.available}><Play />{activeSolver.available ? text('提交当前计算', 'Submit current run') : text('计算节点待接入', 'Node unavailable')}</Button></article><article className="flac-panel flac-audit-card"><header><span>{text('运行审计', 'Run audit')}</span><small>{workspace.audit.length} {text('条', 'items')}</small></header><div>{(workspace.audit.length ? workspace.audit : [{ at: workspace.updatedAt, action: 'benchmark.loaded', detail: '基准数据与结果图层载入完成' }]).map((item, index) => <section key={`${item.at}-${index}`}><i /><span><strong>{item.detail}</strong><small>{new Date(item.at).toLocaleString('zh-CN')} · {item.action}</small></span></section>)}</div></article></div>}
      {view === 'delivery' && <div className="flac-delivery-layout"><article className="flac-panel flac-files-card"><header><span>{text('可复核输入', 'Verifiable inputs')}</span><small>{workspace.sourceFiles.length || 4} {text('项', 'items')}</small></header>{(workspace.sourceFiles.length ? workspace.sourceFiles : [{ name: 'slope_initial.sav', bytes: 6_952_066, sha256: '' }, { name: 'fos_calc-Stable.sav', bytes: 7_303_131, sha256: '' }, { name: 'fos_calc-Unstable.sav', bytes: 7_272_699, sha256: '' }, { name: 'slope_zones_fos_results.csv', bytes: 261_580, sha256: '' }]).map((file) => <div key={file.name}><FileArchive /><span><strong>{file.name}</strong><small>{(file.bytes / 1024 / 1024).toFixed(2)} MB</small></span></div>)}</article><article className="flac-panel flac-export-card"><header><span>{text('成果交付', 'Deliverables')}</span><small>{text('可追溯', 'Traceable')}</small></header><button type="button" onClick={prepareAndDownload}><FileArchive /><span><strong>{text('完整计算包', 'Complete run package')}</strong><small>{text('模型、参数、清单与报告', 'Model, parameters, manifest and report')}</small></span><Download /></button><button type="button" onClick={async () => { const next = (await run('export')) as Workspace | null; if (next) downloadText(next.exports.reportMarkdown, 'slope-analysis-report.md', 'text/markdown;charset=utf-8'); }}><Download /><span><strong>{text('分析报告', 'Analysis report')}</strong><small>Markdown</small></span></button><button type="button" onClick={() => uploadRef.current?.click()}><FileUp /><span><strong>{text('导入计算结果', 'Import results')}</strong><small>CSV · 8 MB {text('以内', 'max')}</small></span></button><input ref={uploadRef} type="file" accept=".csv,text/csv" hidden onChange={(event) => importResults(event.target.files?.[0])} /></article><article className="flac-panel flac-delivery-note"><header><span>{text('交付清单', 'Delivery manifest')}</span><Activity /></header><dl><div><dt>{text('求解模式', 'Solver mode')}</dt><dd>{activeSolver.name}</dd></div><div><dt>{text('本构模型', 'Constitutive')}</dt><dd>Mohr–Coulomb</dd></div><div><dt>{text('结果图层', 'Result layers')}</dt><dd>{text('塑性、位移、应力', 'Plasticity, displacement, stress')}</dd></div><div><dt>{text('完整性校验', 'Integrity')}</dt><dd>SHA-256</dd></div></dl><p>{text('每次计算保存输入、引擎版本、结果摘要和审计记录，客户端无需安装任何求解软件。', 'Every run stores inputs, engine version, result summary and audit records. No solver installation is required on the client.')}</p></article></div>}
    </div><footer className="flac-statusbar"><span className={error ? 'error' : ''}>{error || message}</span><span>{activeSolver.engine}</span><span>{text('数据源', 'Source')}：{workspace.result.source.fileName}</span></footer>
  </section>;
}

function ParameterCard({ title, hint, fields }: { title: string; hint: string; fields: Array<{ key: string; label: string; value: number; set: (value: string) => void }> }) {
  return <article className="flac-panel flac-parameter-card"><header><span>{title}</span><small>{hint}</small></header><div className="flac-field-grid">{fields.map((field) => <label key={field.key}><span>{field.label}</span><input type="number" value={field.value} onChange={(event) => field.set(event.target.value)} /></label>)}</div></article>;
}
