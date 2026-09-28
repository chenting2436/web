'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, AlertTriangle, Archive, BellRing, CheckCircle2, CircleAlert,
  Clock3, Database, Download, FileArchive, FileInput, Gauge, History,
  LoaderCircle, MapPinned, Play, RadioTower, RefreshCw, Save, Server,
  ShieldCheck, Siren, SlidersHorizontal, UserCheck, Wrench, X,
} from 'lucide-react';
import { useLanguage } from '@/components/language-provider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiError } from '@/services/api/client';
import { toolApi, type WorkbenchJob, type WorkbenchProject } from '@/services/api/tools';

type Site = { id: string; name: string; region: string; x: number; y: number; risk: string };
type Device = { id: string; code: string; siteId: string; type: string; status: string; availability: number; lastSeen: string; firmware: string; calibratedAt: string };
type Sensor = { id: string; deviceId: string; name: string; unit: string; warning: number; critical: number; precision: number; enabled: boolean };
type Observation = { id: string; sensorId: string; time: string; value: number | null; quality: string; source: string };
type Rule = { id: string; name: string; sensorId: string; warning: number; critical: number; durationMinutes: number; status: string; version: number; approvals: Array<{ actor: string; time: string }>; publishedAt?: string; publishedBy?: string };
type Alarm = { id: string; ruleId: string; sensorId: string; siteId: string; level: string; status: string; value: number; threshold: number; startedAt: string; updatedAt: string; closedAt?: string; assignee: string; summary: string; resolution?: string; suppressedUntil?: string; suppressionReason?: string; dedupeKey: string };
type Connector = { id: string; name: string; protocol: string; status: string; throughput: number; lagSeconds: number; lastCheckedAt: string | null };
type WarningWorkspace = {
  id: string; name: string; version: number; selectedSiteId: string; selectedSensorId: string;
  rules: Rule[]; alarms: Alarm[];
  incidents: Array<{ id: string; title: string; status: string; alarmIds: string[]; commander: string; startedAt: string }>;
  acknowledgements: Array<{ id: string; alarmId: string; actor: string; time: string; note: string }>;
  maintenanceWindows: Array<{ id: string; deviceIds: string[]; startsAt: string; endsAt: string; reason: string; approvedBy: string }>;
  notifications: Array<{ id: string; alarmId: string; channel: string; recipient: string; status: string; sentAt: string }>;
  duty: { shift: string; lead: string; members: string[]; handoverAt: string };
  audit: Array<{ id: string; time: string; action: string; actor: string; target: string; detail: string }>;
  createdAt: string; updatedAt: string;
};
type WarningAnalysis = {
  metrics: { devices: number; onlineDevices: number; availability: number; openAlarms: number; criticalAlarms: number; acknowledgedAlarms: number; closedAlarms: number; dataCompleteness: number; activeRules: number; pendingRules: number };
  timeSeries: Array<{ sensorId: string; name: string; unit: string; warning: number; critical: number; points: Observation[] }>;
  latest: Record<string, Observation>;
  gaps: Array<{ sensorId: string; sensorName: string; missing: number; deviceId: string }>;
  siteHeat: Array<Site & { score: number; level: string }>;
  availability: Array<{ deviceId: string; code: string; value: number; status: string }>;
  alarmTimeline: Alarm[];
  sla: { ackTargetMinutes: number; closeTargetMinutes: number; ackWithinTarget: number; closeWithinTarget: number };
  qualityChecks: Array<{ label: string; passed: boolean }>;
};
type WarningResult = {
  schema: 'skyview-warning-platform-results'; version: number; stage: string;
  workspace: WarningWorkspace; sites: Site[]; devices: Device[]; sensors: Sensor[]; observations: Observation[]; connectors: Connector[];
  analysis: WarningAnalysis;
  exports: { reportMarkdown: string; alarmsCsv: string; observationsCsv: string; auditCsv: string; backupJson: string; packageBase64: string };
  runtime: { controlPlane: string; computePlane: string; ingestion: Record<string, string>; notifications: Record<string, string>; arbitraryCodeExecution: boolean };
  importSummary?: { accepted: number; rejected: number; violations: Array<{ line: number; reason: string }> };
};

const views = [
  ['overview', '实时监测', 'Live monitoring'],
  ['alarms', '告警处置', 'Alarm response'],
  ['rules', '规则中心', 'Rule center'],
  ['devices', '设备与接入', 'Devices & ingestion'],
  ['delivery', '运行交付', 'Operations & delivery'],
] as const;
const terminal = new Set(['succeeded', 'failed', 'canceled']);
const wait = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

async function waitForJob(id: string): Promise<WorkbenchJob | null> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const job = await toolApi.getJob(id);
    if (terminal.has(job.status)) return job;
    await wait(750);
  }
  return null;
}

function sampleResult(): WarningResult {
  const hours = Array.from({ length: 12 }, (_, index) => `2026-09-10T${String(index).padStart(2, '0')}:00:00Z`);
  const sites: Site[] = [
    { id: 'site-north', name: '北岭露天矿', region: '北部采区', x: 32, y: 34, risk: 'high' },
    { id: 'site-tailings', name: '青石尾矿库', region: '东部库区', x: 69, y: 62, risk: 'warning' },
    { id: 'site-tunnel', name: '云岭隧道', region: '南部工程区', x: 48, y: 79, risk: 'normal' },
  ];
  const devices: Device[] = [
    ['dev-gnss-01', 'GNSS-01', 'site-north', 'GNSS 位移站', 'online', 99.4],
    ['dev-crack-02', 'CRACK-02', 'site-north', '裂缝计', 'online', 98.8],
    ['dev-rain-01', 'RAIN-01', 'site-north', '雨量计', 'online', 99.9],
    ['dev-pore-03', 'PORE-03', 'site-tailings', '孔压计', 'online', 97.6],
    ['dev-level-01', 'LEVEL-01', 'site-tailings', '水位计', 'offline', 82.1],
    ['dev-vib-04', 'VIB-04', 'site-tunnel', '振动监测仪', 'maintenance', 94.3],
  ].map((item) => ({ id: String(item[0]), code: String(item[1]), siteId: String(item[2]), type: String(item[3]), status: String(item[4]), availability: Number(item[5]), lastSeen: '2026-09-10T11:00:00Z', firmware: '2.4.1', calibratedAt: '2026-08-18' }));
  const specs: Array<[string, string, string, string, Array<number | null>, number, number]> = [
    ['sensor-disp', 'dev-gnss-01', '坡体位移', 'mm', [7.8, 8.2, 8.8, 9.4, 10.2, 11.6, 13.4, 15.7, 18.9, 22.8, 28.6, 34.2], 24, 32],
    ['sensor-crack', 'dev-crack-02', '裂缝宽度', 'mm', [4, 4.1, 4.2, 4.5, 4.8, 5.1, 5.5, 6, 6.8, 7.6, 8.7, 10.1], 8, 10],
    ['sensor-rain', 'dev-rain-01', '小时雨量', 'mm', [0, 2, 4, 7, 13, 21, 32, 45, 58, 72, 63, 41], 50, 70],
    ['sensor-pore', 'dev-pore-03', '孔隙水压力', 'kPa', [82, 83, 84, 87, 91, 96, 103, 111, 120, 128, 135, 139], 120, 140],
    ['sensor-level', 'dev-level-01', '库水位', 'm', [438.1, 438.2, 438.3, 438.5, 438.8, 439, 439.2, 439.3, 439.4, null, null, null], 439.2, 439.7],
    ['sensor-vib', 'dev-vib-04', '峰值振速', 'mm/s', [.7, .8, .9, 1.1, 1, 1.2, 1.4, 1.3, 1.6, 1.5, 1.7, 1.8], 2, 3],
  ];
  const sensors = specs.map(([id, deviceId, name, unit, , warning, critical]) => ({ id, deviceId, name, unit, warning, critical, precision: 2, enabled: true }));
  const observations = specs.flatMap(([sensorId, , , , values]) => values.map((value, index) => ({ id: `obs-${sensorId}-${index}`, sensorId, time: hours[index], value, quality: value === null ? 'missing' : 'good', source: 'deterministic-benchmark' })));
  const rules: Rule[] = [
    { id: 'rule-disp', name: '北岭位移分级预警', sensorId: 'sensor-disp', warning: 24, critical: 32, durationMinutes: 10, status: 'active', version: 4, approvals: [{ actor: '规则管理员', time: hours[8] }, { actor: '值班负责人', time: hours[8] }] },
    { id: 'rule-crack', name: '裂缝扩展预警', sensorId: 'sensor-crack', warning: 8, critical: 10, durationMinutes: 15, status: 'active', version: 2, approvals: [{ actor: '规则管理员', time: hours[8] }, { actor: '现场负责人', time: hours[8] }] },
    { id: 'rule-rain', name: '短时强降雨预警', sensorId: 'sensor-rain', warning: 50, critical: 70, durationMinutes: 5, status: 'active', version: 7, approvals: [{ actor: '规则管理员', time: hours[8] }, { actor: '值班负责人', time: hours[8] }] },
    { id: 'rule-pore', name: '尾矿库孔压预警', sensorId: 'sensor-pore', warning: 120, critical: 140, durationMinutes: 20, status: 'review', version: 3, approvals: [{ actor: '规则管理员', time: hours[7] }] },
  ];
  const alarms: Alarm[] = [
    { id: 'alarm-20260910-001', ruleId: 'rule-disp', sensorId: 'sensor-disp', siteId: 'site-north', level: 'critical', status: 'open', value: 34.2, threshold: 32, startedAt: hours[11], updatedAt: hours[11], assignee: '地测值班组', summary: '坡体位移连续上升并越过严重阈值', dedupeKey: 'site-north:sensor-disp:critical' },
    { id: 'alarm-20260910-002', ruleId: 'rule-crack', sensorId: 'sensor-crack', siteId: 'site-north', level: 'critical', status: 'acknowledged', value: 10.1, threshold: 10, startedAt: hours[11], updatedAt: hours[11], assignee: '现场一组', summary: '裂缝宽度到达严重阈值', dedupeKey: 'site-north:sensor-crack:critical' },
    { id: 'alarm-20260910-003', ruleId: 'rule-pore', sensorId: 'sensor-pore', siteId: 'site-tailings', level: 'warning', status: 'open', value: 139, threshold: 120, startedAt: hours[9], updatedAt: hours[11], assignee: '', summary: '孔隙水压力持续处于预警区间', dedupeKey: 'site-tailings:sensor-pore:warning' },
    { id: 'alarm-20260909-018', ruleId: 'rule-rain', sensorId: 'sensor-rain', siteId: 'site-north', level: 'critical', status: 'closed', value: 72, threshold: 70, startedAt: hours[9], updatedAt: hours[10], closedAt: hours[10], assignee: '应急值班组', summary: '短时雨量越过严重阈值', resolution: '完成排水沟巡查，雨量回落后关闭', dedupeKey: 'site-north:sensor-rain:critical' },
  ];
  const latest = Object.fromEntries(sensors.map((sensor) => [sensor.id, observations.filter((item) => item.sensorId === sensor.id && item.value !== null).at(-1)!]));
  const timeSeries = sensors.map((sensor) => ({ sensorId: sensor.id, name: sensor.name, unit: sensor.unit, warning: sensor.warning, critical: sensor.critical, points: observations.filter((item) => item.sensorId === sensor.id) }));
  return {
    schema: 'skyview-warning-platform-results', version: 2, stage: 'load-sample', sites, devices, sensors, observations,
    workspace: { id: 'warning-north-cluster', name: '北部矿区综合监测', version: 6, selectedSiteId: 'site-north', selectedSensorId: 'sensor-disp', rules, alarms, incidents: [{ id: 'incident-01', title: '北岭边坡联合处置', status: 'active', alarmIds: ['alarm-20260910-001', 'alarm-20260910-002'], commander: '李值班长', startedAt: hours[11] }], acknowledgements: [{ id: 'ack-01', alarmId: 'alarm-20260910-002', actor: '张工', time: hours[11], note: '已通知现场一组复测' }], maintenanceWindows: [{ id: 'mw-01', deviceIds: ['dev-vib-04'], startsAt: hours[8], endsAt: '2026-09-10T16:00:00Z', reason: '传感器标定', approvedBy: '设备管理员' }], notifications: [{ id: 'notice-01', alarmId: 'alarm-20260910-001', channel: '站内通知', recipient: '地测值班组', status: 'delivered', sentAt: hours[11] }], duty: { shift: '白班', lead: '李值班长', members: ['张工', '王工', '现场一组'], handoverAt: '2026-09-10T20:00:00Z' }, audit: [{ id: 'audit-seed', time: hours[11], action: 'acknowledge', actor: '张工', target: 'alarm-20260910-002', detail: '已确认告警并通知现场复测' }], createdAt: hours[0], updatedAt: hours[11] },
    connectors: [{ id: 'mqtt-primary', name: 'MQTT 主接入', protocol: 'MQTT', status: 'healthy', throughput: 126, lagSeconds: 2, lastCheckedAt: hours[11] }, { id: 'http-field', name: '现场 HTTP 网关', protocol: 'HTTP', status: 'healthy', throughput: 38, lagSeconds: 4, lastCheckedAt: hours[11] }, { id: 'opc-tunnel', name: '隧道 OPC-UA', protocol: 'OPC-UA', status: 'maintenance', throughput: 0, lagSeconds: 0, lastCheckedAt: hours[10] }, { id: 'kafka-event', name: '告警事件流', protocol: 'Kafka', status: 'not-configured', throughput: 0, lagSeconds: 0, lastCheckedAt: null }],
    analysis: { metrics: { devices: 6, onlineDevices: 4, availability: 95.35, openAlarms: 3, criticalAlarms: 2, acknowledgedAlarms: 1, closedAlarms: 1, dataCompleteness: 95.8, activeRules: 3, pendingRules: 1 }, timeSeries, latest, gaps: [{ sensorId: 'sensor-level', sensorName: '库水位', missing: 3, deviceId: 'dev-level-01' }], siteHeat: [{ ...sites[0], score: 100, level: 'critical' }, { ...sites[1], score: 98, level: 'warning' }, { ...sites[2], score: 54, level: 'normal' }], availability: devices.map((item) => ({ deviceId: item.id, code: item.code, value: item.availability, status: item.status })), alarmTimeline: alarms, sla: { ackTargetMinutes: 10, closeTargetMinutes: 120, ackWithinTarget: 92.3, closeWithinTarget: 88 }, qualityChecks: [{ label: '设备注册关系完整', passed: true }, { label: '传感器阈值顺序有效', passed: true }, { label: '告警均可追溯至传感器', passed: true }, { label: '规则发布双人复核', passed: true }] },
    exports: { reportMarkdown: '# 灾害监测预警运行报告', alarmsCsv: '告警ID,等级,状态\n', observationsCsv: '观测ID,传感器ID,时间,数值\n', auditCsv: '审计ID,时间,动作\n', backupJson: '{}', packageBase64: '' },
    runtime: { controlPlane: 'Go 项目、版本、作业、权限与审计', computePlane: 'Python 观测校验、规则计算、图表数据与交付', ingestion: { mqtt: 'adapter-ready', http: 'adapter-ready', kafka: 'not-configured', opcUa: 'maintenance' }, notifications: { inApp: 'enabled', sms: 'not-configured', email: 'not-configured' }, arbitraryCodeExecution: false },
  };
}

function downloadText(content: string, fileName: string, type = 'text/plain;charset=utf-8') {
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

function TrendChart({ series }: { series: WarningAnalysis['timeSeries'][number] }) {
  const points = series.points.filter((item): item is Observation & { value: number } => item.value !== null);
  const values = [...points.map((item) => item.value), series.warning, series.critical];
  const min = Math.min(...values); const max = Math.max(...values); const span = Math.max(.001, max - min);
  const x = (index: number) => 42 + index * (610 / Math.max(1, points.length - 1));
  const y = (value: number) => 188 - (value - min) / span * 142;
  const polyline = points.map((item, index) => `${x(index)},${y(item.value)}`).join(' ');
  return <svg className="warnx-trend" viewBox="0 0 700 220" role="img" aria-label={`${series.name}变化趋势`}>
    <defs><linearGradient id="warnx-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#078a9a" stopOpacity=".28"/><stop offset="1" stopColor="#078a9a" stopOpacity=".02"/></linearGradient></defs>
    <rect x="42" y={y(series.critical)} width="610" height={Math.max(0, y(series.warning) - y(series.critical))} className="warning-band" />
    {[0, 1, 2, 3, 4].map((item) => <line key={item} x1="42" x2="652" y1={46 + item * 35.5} y2={46 + item * 35.5} />)}
    <line className="critical-line" x1="42" x2="652" y1={y(series.critical)} y2={y(series.critical)} /><line className="warning-line" x1="42" x2="652" y1={y(series.warning)} y2={y(series.warning)} />
    <path className="area" d={`M${x(0)},188 L${polyline.replaceAll(' ', ' L')} L${x(points.length - 1)},188 Z`} />
    <polyline className="data-line" points={polyline} />
    {points.map((item, index) => <circle key={item.id} cx={x(index)} cy={y(item.value)} r={index === points.length - 1 ? 5 : 3} />)}
    <text x="658" y={y(series.critical) + 4}>严重 {series.critical}</text><text x="658" y={y(series.warning) + 4}>预警 {series.warning}</text>
    {points.filter((_, index) => index % 2 === 0 || index === points.length - 1).map((item, index) => <text key={`time-${item.id}`} className="time" x={x(points.indexOf(item))} y="211">{item.time.slice(11, 16)}</text>)}
  </svg>;
}

const statusName: Record<string, string> = { open: '待响应', acknowledged: '已确认', closed: '已关闭', suppressed: '已抑制', active: '已发布', review: '待复核', approved: '待发布', draft: '草案', online: '在线', offline: '离线', maintenance: '维护中', healthy: '正常', 'not-configured': '未配置' };

export function WarningPlatformWorkbench({ executionAllowed = true }: { executionAllowed?: boolean }) {
  const { text } = useLanguage();
  const [view, setView] = useState<(typeof views)[number][0]>('overview');
  const [result, setResult] = useState<WarningResult>(() => sampleResult());
  const [projects, setProjects] = useState<WorkbenchProject[]>([]); const [projectId, setProjectId] = useState('');
  const [projectTitle, setProjectTitle] = useState('北部矿区综合监测项目');
  const [selectedSensorId, setSelectedSensorId] = useState('sensor-disp'); const [selectedAlarmId, setSelectedAlarmId] = useState('alarm-20260910-001');
  const [actor, setActor] = useState('当前值班员'); const [running, setRunning] = useState(false); const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(''); const [error, setError] = useState(''); const importInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    toolApi.listProjects('warning-platform').then((items) => {
      if (!active) return; setProjects(items); const project = items[0]; const saved = project?.state.warningPlatform as { result?: WarningResult } | undefined;
      if (project && saved?.result?.schema === 'skyview-warning-platform-results') { setProjectId(project.id); setProjectTitle(project.title); setResult(saved.result); setSelectedSensorId(saved.result.workspace.selectedSensorId || saved.result.sensors[0]?.id); }
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  const projectState = (next = result) => ({ warningPlatform: { result: next } });
  const ensureProject = async () => {
    const existing = projects.find((item) => item.id === projectId); if (existing) return existing;
    const created = await toolApi.createProject('warning-platform', projectTitle, projectState()); setProjects((items) => [created, ...items]); setProjectId(created.id); return created;
  };
  const storeResult = async (project: WorkbenchProject, output: WarningResult) => {
    setResult(output); const saved = await toolApi.updateProject(project.id, projectTitle, projectState(output)); setProjects((items) => [saved, ...items.filter((item) => item.id !== saved.id)]);
  };
  const execute = async (action: string, extra: Record<string, unknown> = {}) => {
    if (!executionAllowed) { setError(text('预警计算服务当前不可用', 'Warning compute service is unavailable')); return null; }
    setRunning(true); setError(''); setMessage(text('Go 已登记作业，Python 正在校验数据并更新告警…', 'The job is registered; observations and alarms are being updated…'));
    try {
      const project = await ensureProject(); const created = await toolApi.createJob(project.id, 'warning-platform', action, { state: result, actor, ...extra }, crypto.randomUUID()); const job = await waitForJob(created.job.id);
      if (!job) throw new Error(text('作业仍在后台运行，请稍后重试。', 'The job is still running.'));
      if (job.status === 'failed') throw new Error(job.error || text('预警计算失败。', 'Warning calculation failed.'));
      if (job.status === 'canceled') throw new Error(text('作业已取消。', 'The job was canceled.'));
      const output = job.result as WarningResult; if (output.schema !== 'skyview-warning-platform-results') throw new Error(text('服务端返回了不兼容的预警结果。', 'The service returned an incompatible result.'));
      await storeResult(project, output); setMessage(text('监测状态、图表与审计记录已更新。', 'Monitoring, charts, and audit records were updated.')); return output;
    } catch (caught) { setError(caught instanceof ApiError || caught instanceof Error ? caught.message : text('操作失败。', 'Operation failed.')); setMessage(''); return null; } finally { setRunning(false); }
  };
  const saveProject = async () => {
    setSaving(true); setError(''); try { const existing = projects.find((item) => item.id === projectId); const saved = existing ? await toolApi.updateProject(existing.id, projectTitle, projectState()) : await toolApi.createProject('warning-platform', projectTitle, projectState()); setProjects((items) => [saved, ...items.filter((item) => item.id !== saved.id)]); setProjectId(saved.id); setMessage(text('项目已保存。', 'Project saved.')); } catch (caught) { setError(caught instanceof Error ? caught.message : text('保存失败。', 'Save failed.')); } finally { setSaving(false); }
  };
  const createVersion = async () => { try { const project = await ensureProject(); await toolApi.createVersion(project.id, `监测预警 v${result.workspace.version} · ${new Date().toLocaleString('zh-CN')}`, projectState()); setMessage(text('已创建不可变版本。', 'Immutable version created.')); } catch (caught) { setError(caught instanceof Error ? caught.message : text('版本创建失败。', 'Version creation failed.')); } };
  const importObservations = async (file?: File) => { if (!file) return; if (file.size > 2_000_000) { setError(text('观测文件不能超过 2 MB。', 'Observation file must not exceed 2 MB.')); return; } await execute('ingest-observations', { fileName: file.name, content: await file.text() }); if (importInput.current) importInput.current.value = ''; };
  const selectProject = (id: string) => { setProjectId(id); const project = projects.find((item) => item.id === id); if (!project) { setResult(sampleResult()); setProjectTitle('北部矿区综合监测项目'); return; } const saved = project.state.warningPlatform as { result?: WarningResult } | undefined; if (saved?.result?.schema === 'skyview-warning-platform-results') { setResult(saved.result); setProjectTitle(project.title); setSelectedSensorId(saved.result.workspace.selectedSensorId); } };

  const series = result.analysis.timeSeries.find((item) => item.sensorId === selectedSensorId) ?? result.analysis.timeSeries[0];
  const sensor = result.sensors.find((item) => item.id === series.sensorId)!; const sensorDevice = result.devices.find((item) => item.id === sensor.deviceId);
  const latest = result.analysis.latest[series.sensorId]; const activeAlarms = result.workspace.alarms.filter((item) => item.status !== 'closed' && item.status !== 'suppressed');
  const selectedAlarm = result.workspace.alarms.find((item) => item.id === selectedAlarmId) ?? activeAlarms[0] ?? result.workspace.alarms[0];
  const selectedSite = result.sites.find((item) => item.id === selectedAlarm?.siteId);
  const ruleForAlarm = result.workspace.rules.find((item) => item.id === selectedAlarm?.ruleId);
  const siteMap = useMemo(() => new Map(result.sites.map((item) => [item.id, item])), [result.sites]);

  return <div className="warnx-workbench">
    <header className="warnx-commandbar">
      <div className="warnx-project"><Siren /><NativeSelect aria-label={text('选择监测项目', 'Select monitoring project')} value={projectId} onChange={(event) => selectProject(event.target.value)}><NativeSelectOption value="">{text('当前本地项目', 'Current local project')}</NativeSelectOption>{projects.map((project) => <NativeSelectOption key={project.id} value={project.id}>{project.title}</NativeSelectOption>)}</NativeSelect><Input aria-label={text('项目名称', 'Project name')} value={projectTitle} onChange={(event) => setProjectTitle(event.target.value)} /><span><i />{text('连续监测中', 'Continuous monitoring')}</span></div>
      <div className="warnx-actions"><input ref={importInput} hidden type="file" accept=".csv,.json,text/csv,application/json" onChange={(event) => void importObservations(event.target.files?.[0])} /><Button size="sm" variant="outline" onClick={() => importInput.current?.click()}><FileInput />{text('导入观测', 'Import')}</Button><Button size="sm" variant="outline" onClick={() => void saveProject()} disabled={saving}>{saving ? <LoaderCircle className="spin" /> : <Save />}{text('保存', 'Save')}</Button><Button size="sm" variant="outline" onClick={() => void createVersion()}><Archive />{text('版本', 'Version')}</Button><Button size="sm" onClick={() => void execute('evaluate-rules')} disabled={running}>{running ? <LoaderCircle className="spin" /> : <Play />}{text('执行规则研判', 'Evaluate rules')}</Button></div>
    </header>

    <section className="warnx-kpis">
      <article><RadioTower /><span>{text('在线设备', 'Online devices')}</span><strong>{result.analysis.metrics.onlineDevices}<small>/{result.analysis.metrics.devices}</small></strong><em>{result.analysis.metrics.availability}% {text('可用', 'available')}</em></article>
      <article className="danger"><Siren /><span>{text('活跃告警', 'Active alarms')}</span><strong>{result.analysis.metrics.openAlarms}</strong><em>{result.analysis.metrics.criticalAlarms} {text('条严重', 'critical')}</em></article>
      <article><Database /><span>{text('数据完整率', 'Data completeness')}</span><strong>{result.analysis.metrics.dataCompleteness}%</strong><em>{result.analysis.gaps.length} {text('个缺口', 'gaps')}</em></article>
      <article><SlidersHorizontal /><span>{text('已发布规则', 'Published rules')}</span><strong>{result.analysis.metrics.activeRules}</strong><em>{result.analysis.metrics.pendingRules} {text('条待复核', 'pending')}</em></article>
      <article><Clock3 /><span>{text('确认时效', 'Ack SLA')}</span><strong>{result.analysis.sla.ackWithinTarget}%</strong><em>≤ {result.analysis.sla.ackTargetMinutes} min</em></article>
      <article><ShieldCheck /><span>{text('质量门禁', 'Quality gates')}</span><strong>{result.analysis.qualityChecks.filter((item) => item.passed).length}<small>/{result.analysis.qualityChecks.length}</small></strong><em>{text('当前通过', 'passing')}</em></article>
    </section>

    <Tabs value={view} onValueChange={(value) => setView(value as typeof view)} className="warnx-tabs-shell"><TabsList className="warnx-tabs" variant="line">{views.map(([id, zh, en], index) => <TabsTrigger key={id} value={id}><b>{String(index + 1).padStart(2, '0')}</b>{text(zh, en)}</TabsTrigger>)}</TabsList></Tabs>
    {(message || error) && <div className={`warnx-status ${error ? 'error' : ''}`}>{error ? <CircleAlert /> : <CheckCircle2 />}<span>{error || message}</span><button aria-label={text('关闭状态', 'Dismiss')} onClick={() => { setMessage(''); setError(''); }}><X /></button></div>}

    <main className="warnx-stage">
      {view === 'overview' && <div className="warnx-view warnx-overview">
        <aside className="warnx-surface warnx-sensor-rail"><header><RadioTower /><div><span>{text('监测对象', 'Monitored assets')}</span><strong>{text('站点与传感器', 'Sites & sensors')}</strong></div></header><div className="warnx-site-list">{result.sites.map((site) => <section key={site.id}><button className={site.id === sensorDevice?.siteId ? 'active' : ''}><i className={site.risk} /><span><strong>{site.name}</strong><small>{site.region}</small></span><b>{result.devices.filter((item) => item.siteId === site.id && item.status === 'online').length}/{result.devices.filter((item) => item.siteId === site.id).length}</b></button><div>{result.sensors.filter((item) => result.devices.find((device) => device.id === item.deviceId)?.siteId === site.id).map((item) => { const value = result.analysis.latest[item.id]?.value; const level = value !== null && value !== undefined ? value >= item.critical ? 'critical' : value >= item.warning ? 'warning' : 'normal' : 'missing'; return <button key={item.id} className={`${item.id === selectedSensorId ? 'active' : ''} ${level}`} onClick={() => setSelectedSensorId(item.id)}><span>{item.name}</span><strong>{value ?? '—'} <small>{item.unit}</small></strong></button>; })}</div></section>)}</div></aside>
        <section className="warnx-surface warnx-chart-card"><header><div><span>{text('连续趋势与阈值带', 'Continuous trend & thresholds')}</span><strong>{series.name}</strong><small>{sensorDevice?.code} · {sensorDevice?.type} · {text('最近采样', 'latest')} {latest?.time.slice(11, 16) ?? '—'}</small></div><div className="warnx-chart-value"><b>{latest?.value ?? '—'}</b><span>{series.unit}</span><em className={latest?.value !== null && latest?.value !== undefined && latest.value >= series.critical ? 'critical' : latest?.value !== null && latest?.value !== undefined && latest.value >= series.warning ? 'warning' : 'normal'}>{latest?.value !== null && latest?.value !== undefined && latest.value >= series.critical ? text('严重', 'Critical') : latest?.value !== null && latest?.value !== undefined && latest.value >= series.warning ? text('预警', 'Warning') : text('正常', 'Normal')}</em></div></header><TrendChart series={series} /><footer><span><i className="data" />{text('观测值', 'Value')}</span><span><i className="warn" />{text('预警阈值', 'Warning')}</span><span><i className="critical" />{text('严重阈值', 'Critical')}</span><strong>{series.points.filter((item) => item.value !== null).length}/{series.points.length} {text('个有效点', 'valid points')}</strong></footer></section>
        <section className="warnx-surface warnx-risk-map"><header><MapPinned /><div><span>{text('空间风险', 'Spatial risk')}</span><strong>{text('站点风险分布', 'Site risk map')}</strong></div></header><div className="warnx-map-canvas">{result.analysis.siteHeat.map((site) => <button key={site.id} className={site.level} style={{ left: `${site.x}%`, top: `${site.y}%` }}><i /><span><strong>{site.name}</strong><small>{text('风险分', 'Risk')} {site.score}</small></span></button>)}</div><footer>{result.analysis.siteHeat.map((site) => <span key={site.id}><i className={site.level} />{site.name}<b>{site.score}</b></span>)}</footer></section>
        <section className="warnx-surface warnx-alarm-stack"><header><BellRing /><div><span>{text('需要处理', 'Action required')}</span><strong>{text('活跃告警队列', 'Active alarm queue')}</strong></div><button onClick={() => setView('alarms')}>{text('处置中心', 'Response center')}</button></header><div>{activeAlarms.map((alarm) => <button key={alarm.id} className={`${alarm.level} ${selectedAlarmId === alarm.id ? 'active' : ''}`} onClick={() => { setSelectedAlarmId(alarm.id); setView('alarms'); }}><em>{alarm.level === 'critical' ? text('严重', 'Critical') : text('预警', 'Warning')}</em><span><strong>{alarm.summary}</strong><small>{siteMap.get(alarm.siteId)?.name} · {alarm.startedAt.slice(11, 16)} · {alarm.assignee || text('待分配', 'Unassigned')}</small></span><b>{statusName[alarm.status] ?? alarm.status}</b></button>)}</div></section>
      </div>}

      {view === 'alarms' && <div className="warnx-view warnx-alarms">
        <aside className="warnx-surface warnx-alarm-list"><header><Siren /><span>{text('告警队列', 'Alarm queue')}</span><strong>{result.workspace.alarms.length}</strong></header>{result.workspace.alarms.map((alarm) => <button key={alarm.id} className={`${alarm.level} ${alarm.id === selectedAlarm?.id ? 'active' : ''}`} onClick={() => setSelectedAlarmId(alarm.id)}><em>{alarm.level === 'critical' ? text('严重', 'Critical') : text('预警', 'Warning')}</em><span><strong>{alarm.summary}</strong><small>{siteMap.get(alarm.siteId)?.name} · {alarm.assignee || text('待分配', 'Unassigned')}</small></span><b>{statusName[alarm.status] ?? alarm.status}</b></button>)}</aside>
        {selectedAlarm && <section className="warnx-surface warnx-alarm-detail"><header><div><span>{selectedAlarm.id}</span><strong>{selectedAlarm.summary}</strong><small>{selectedSite?.name} · {result.sensors.find((item) => item.id === selectedAlarm.sensorId)?.name}</small></div><em className={selectedAlarm.level}>{selectedAlarm.level === 'critical' ? text('严重告警', 'Critical alarm') : text('预警', 'Warning')}</em></header><div className="warnx-alarm-facts"><article><span>{text('观测值', 'Observed')}</span><strong>{selectedAlarm.value}</strong><small>{text('阈值', 'Threshold')} {selectedAlarm.threshold}</small></article><article><span>{text('当前状态', 'Status')}</span><strong>{statusName[selectedAlarm.status] ?? selectedAlarm.status}</strong><small>{selectedAlarm.updatedAt.slice(0, 16).replace('T', ' ')}</small></article><article><span>{text('责任人', 'Assignee')}</span><strong>{selectedAlarm.assignee || text('待分配', 'Unassigned')}</strong><small>{result.workspace.duty.shift}</small></article><article><span>{text('规则版本', 'Rule version')}</span><strong>v{ruleForAlarm?.version ?? '—'}</strong><small>{ruleForAlarm?.name}</small></article></div><div className="warnx-response-actions"><div><label><span>{text('当前操作人', 'Current actor')}</span><Input value={actor} onChange={(event) => setActor(event.target.value)} /></label><label><span>{text('分配责任人', 'Assign to')}</span><Input id="warnx-assignee" defaultValue={selectedAlarm.assignee || '现场一组'} /></label><Button variant="outline" disabled={running || selectedAlarm.status === 'closed'} onClick={() => void execute('assign-alarm', { alarmId: selectedAlarm.id, assignee: (document.getElementById('warnx-assignee') as HTMLInputElement)?.value })}><UserCheck />{text('分配', 'Assign')}</Button><Button disabled={running || selectedAlarm.status !== 'open'} onClick={() => void execute('acknowledge-alarm', { alarmId: selectedAlarm.id, note: '已在告警中心确认并启动现场核查' })}><CheckCircle2 />{text('确认告警', 'Acknowledge')}</Button></div><div><label><span>{text('处置结论', 'Resolution')}</span><textarea id="warnx-resolution" defaultValue={selectedAlarm.resolution || '已完成现场复核，监测指标恢复到可接受区间。'} /></label><Button variant="outline" disabled={running || selectedAlarm.status === 'closed'} onClick={() => void execute('suppress-alarm', { alarmId: selectedAlarm.id, reason: '计划维护期间抑制重复通知', until: '2026-09-10T18:00:00Z' })}><Clock3 />{text('限时抑制', 'Suppress')}</Button><Button disabled={running || selectedAlarm.status === 'closed'} onClick={() => void execute('close-alarm', { alarmId: selectedAlarm.id, resolution: (document.getElementById('warnx-resolution') as HTMLTextAreaElement)?.value })}><ShieldCheck />{text('关闭告警', 'Close alarm')}</Button></div></div></section>}
        <section className="warnx-surface warnx-incident"><header><AlertTriangle /><span>{text('关联事件', 'Linked incidents')}</span></header>{result.workspace.incidents.map((incident) => <article key={incident.id}><em>{statusName[incident.status] ?? incident.status}</em><span><strong>{incident.title}</strong><small>{text('指挥', 'Commander')}：{incident.commander} · {incident.alarmIds.length} {text('条告警', 'alarms')}</small></span><b>{incident.startedAt.slice(11, 16)}</b></article>)}</section>
        <section className="warnx-surface warnx-timeline"><header><History /><span>{text('处置与审计时间线', 'Response & audit timeline')}</span></header>{result.workspace.audit.slice(0, 8).map((item) => <article key={item.id}><i /><time>{item.time.slice(5, 16).replace('T', ' ')}</time><span><strong>{item.actor}</strong><small>{item.detail}</small></span><em>{item.action}</em></article>)}</section>
      </div>}

      {view === 'rules' && <div className="warnx-view warnx-rules">
        <section className="warnx-surface warnx-rule-board"><header><SlidersHorizontal /><div><span>{text('动态阈值与版本', 'Dynamic thresholds & versions')}</span><strong>{text('规则发布必须双人复核', 'Two-person approval is required')}</strong></div><Button size="sm" variant="outline" onClick={() => void execute('evaluate-rules')} disabled={running}><Play />{text('运行全部规则', 'Run all rules')}</Button></header><div>{result.workspace.rules.map((rule) => { const linkedSensor = result.sensors.find((item) => item.id === rule.sensorId); return <article key={rule.id}><header><span className={rule.status}>{statusName[rule.status] ?? rule.status}</span><strong>{rule.name}</strong><em>v{rule.version}</em></header><div><label><span>{text('预警阈值', 'Warning threshold')}</span><Input id={`warn-${rule.id}`} type="number" defaultValue={rule.warning} /></label><label><span>{text('严重阈值', 'Critical threshold')}</span><Input id={`critical-${rule.id}`} type="number" defaultValue={rule.critical} /></label><label><span>{text('持续时间', 'Duration')}</span><Input type="number" value={rule.durationMinutes} readOnly /></label></div><p><span>{linkedSensor?.name}</span><span>{rule.approvals.length}/2 {text('人复核', 'approvals')}</span>{rule.approvals.map((approval) => <em key={approval.actor}>{approval.actor}</em>)}</p><footer><Button size="sm" variant="outline" disabled={running || rule.approvals.some((item) => item.actor === actor)} onClick={() => void execute('approve-rule', { ruleId: rule.id })}><UserCheck />{text('提交复核', 'Approve')}</Button><Button size="sm" disabled={running || new Set(rule.approvals.map((item) => item.actor)).size < 2} onClick={() => void execute('publish-rule', { ruleId: rule.id, warning: Number((document.getElementById(`warn-${rule.id}`) as HTMLInputElement)?.value), critical: Number((document.getElementById(`critical-${rule.id}`) as HTMLInputElement)?.value) })}><ShieldCheck />{text('发布新版本', 'Publish')}</Button></footer></article>; })}</div></section>
        <aside className="warnx-surface warnx-rule-gate"><header><ShieldCheck /><span>{text('规则质量门禁', 'Rule quality gates')}</span></header>{result.analysis.qualityChecks.map((item) => <p key={item.label} className={item.passed ? 'pass' : 'fail'}>{item.passed ? <CheckCircle2 /> : <CircleAlert />}<span>{item.label}</span><b>{item.passed ? text('通过', 'Pass') : text('阻断', 'Blocked')}</b></p>)}<div><strong>{result.analysis.metrics.activeRules}</strong><span>{text('条规则已发布', 'published rules')}</span><small>{result.analysis.metrics.pendingRules} {text('条处于复核流程', 'in review')}</small></div></aside>
      </div>}

      {view === 'devices' && <div className="warnx-view warnx-devices">
        <section className="warnx-surface warnx-device-table"><header><Server /><div><span>{text('设备资产', 'Device assets')}</span><strong>{result.devices.length} {text('台注册设备', 'registered devices')}</strong></div><Button size="sm" variant="outline" onClick={() => void execute('connector-status')} disabled={running}><RefreshCw />{text('检查接入', 'Check ingestion')}</Button></header><div className="warnx-device-head"><b>{text('设备', 'Device')}</b><b>{text('站点', 'Site')}</b><b>{text('状态', 'Status')}</b><b>{text('可用率', 'Availability')}</b><b>{text('最后在线', 'Last seen')}</b><b>{text('标定', 'Calibration')}</b></div>{result.devices.map((device) => <article key={device.id}><span><i className={device.status} /><strong>{device.code}</strong><small>{device.type}</small></span><span>{siteMap.get(device.siteId)?.name}</span><em className={device.status}>{statusName[device.status] ?? device.status}</em><span className="availability"><i><b style={{ width: `${device.availability}%` }} /></i><strong>{device.availability}%</strong></span><time>{device.lastSeen.slice(5, 16).replace('T', ' ')}</time><span>{device.calibratedAt}</span></article>)}</section>
        <aside className="warnx-surface warnx-connectors"><header><Database /><span>{text('协议接入', 'Protocol ingestion')}</span></header>{result.connectors.map((connector) => <article key={connector.id}><i className={connector.status}><RadioTower /></i><span><strong>{connector.name}</strong><small>{connector.protocol} · {connector.lagSeconds ? `${connector.lagSeconds}s ${text('延迟', 'lag')}` : statusName[connector.status]}</small></span><b>{connector.throughput}<small>/s</small></b></article>)}</aside>
        <section className="warnx-surface warnx-maintenance"><header><Wrench /><div><span>{text('维护窗口', 'Maintenance windows')}</span><strong>{text('抑制计划作业产生的重复告警', 'Suppress alarms during planned work')}</strong></div></header><div>{result.workspace.maintenanceWindows.map((window) => <article key={window.id}><span><strong>{result.devices.find((item) => item.id === window.deviceIds[0])?.code}</strong><small>{window.reason}</small></span><time>{window.startsAt.slice(5, 16).replace('T', ' ')} → {window.endsAt.slice(5, 16).replace('T', ' ')}</time><em>{window.approvedBy}</em></article>)}</div><Button size="sm" variant="outline" onClick={() => void execute('create-maintenance-window', { deviceId: 'dev-level-01', startsAt: '2026-09-10T12:00:00Z', endsAt: '2026-09-10T14:00:00Z', reason: '水位计通讯检修' })}><Wrench />{text('登记两小时检修', 'Register 2h maintenance')}</Button></section>
      </div>}

      {view === 'delivery' && <div className="warnx-view warnx-delivery">
        <section className="warnx-surface warnx-runtime"><header><Gauge /><div><span>{text('运行边界', 'Runtime boundary')}</span><strong>{text('控制面、计算面与外部接入状态', 'Control, compute, and external ingestion')}</strong></div></header><div><article><Server /><span><strong>Go {text('控制面', 'control plane')}</strong><small>{result.runtime.controlPlane}</small></span><em className="pass">{text('已连接', 'Connected')}</em></article><article><Activity /><span><strong>Python {text('计算面', 'compute plane')}</strong><small>{result.runtime.computePlane}</small></span><em className="pass">{text('已连接', 'Connected')}</em></article><article><BellRing /><span><strong>{text('通知网关', 'Notification gateway')}</strong><small>{text('站内启用；短信、邮件按配置接入', 'In-app enabled; SMS/email require configuration')}</small></span><em>{text('部分配置', 'Partial')}</em></article><article><ShieldCheck /><span><strong>{text('执行隔离', 'Execution isolation')}</strong><small>{text('导入数据只解析，不执行脚本', 'Imported data is parsed, never executed')}</small></span><em className="pass">{text('已启用', 'Enabled')}</em></article></div></section>
        <section className="warnx-surface warnx-deliveries"><header><FileArchive /><div><span>{text('交付与交换', 'Delivery & exchange')}</span><strong>{text('报告、观测、告警、审计与完整备份', 'Reports, observations, alarms, audit, and backup')}</strong></div><Button size="sm" onClick={() => void execute('export')} disabled={running}><RefreshCw />{text('刷新交付包', 'Refresh package')}</Button></header><div><button onClick={() => downloadText(result.exports.reportMarkdown, '灾害监测预警运行报告.md')}><Download /><strong>{text('运行报告', 'Operations report')}</strong><small>Markdown</small></button><button onClick={() => downloadText(result.exports.observationsCsv, '监测观测数据.csv', 'text/csv;charset=utf-8')}><Database /><strong>{text('观测数据', 'Observations')}</strong><small>CSV</small></button><button onClick={() => downloadText(result.exports.alarmsCsv, '告警处置记录.csv', 'text/csv;charset=utf-8')}><Siren /><strong>{text('告警记录', 'Alarm records')}</strong><small>CSV</small></button><button onClick={() => downloadText(result.exports.auditCsv, '操作审计记录.csv', 'text/csv;charset=utf-8')}><History /><strong>{text('审计日志', 'Audit log')}</strong><small>CSV</small></button><button onClick={() => downloadText(result.exports.backupJson, '预警平台完整备份.json', 'application/json;charset=utf-8')}><Archive /><strong>{text('完整备份', 'Full backup')}</strong><small>JSON</small></button><button className="primary" disabled={!result.exports.packageBase64} onClick={() => downloadBase64(result.exports.packageBase64, '灾害监测预警交付包.zip')}><FileArchive /><strong>{text('完整交付包', 'Delivery package')}</strong><small>{result.exports.packageBase64 ? 'ZIP' : text('刷新后生成', 'Refresh to generate')}</small></button></div></section>
        <section className="warnx-surface warnx-audit-table"><header><History /><span>{text('审计记录', 'Audit records')}</span><strong>{result.workspace.audit.length}</strong></header>{result.workspace.audit.slice(0, 12).map((item) => <article key={item.id}><time>{item.time.slice(0, 19).replace('T', ' ')}</time><span><strong>{item.actor}</strong><small>{item.detail}</small></span><em>{item.action}</em><code>{item.target}</code></article>)}</section>
      </div>}
    </main>
  </div>;
}
