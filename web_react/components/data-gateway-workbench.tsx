'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  CheckCircle2,
  ChevronDown,
  CirclePlay,
  CircleStop,
  Clipboard,
  Copy,
  Database,
  Download,
  FileClock,
  FileUp,
  GitBranch,
  History,
  ListFilter,
  Maximize2,
  Network,
  Play,
  Plus,
  RotateCcw,
  Save,
  Search,
  Settings,
  ShieldCheck,
  Trash2,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/services/api/client';
import { toolApi, type WorkbenchJob, type WorkbenchProject } from '@/services/api/tools';

type ProcessorCatalogItem = {
  type: string;
  group: string;
  description: string;
  tags: string[];
  relationships: string[];
};

type FlowFile = {
  uuid: string;
  content: Record<string, unknown>;
  attributes: Record<string, string>;
  size: number;
  lineageStartDate: string;
  parentUuids: string[];
};

type Processor = {
  id: string;
  kind: 'processor';
  type: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  state: string;
  validation: string;
  scheduling: { strategy: string; period: string; concurrentTasks: number; penalty?: string; yield?: string };
  properties: Record<string, string>;
  relationships: Array<{ name: string; autoTerminate: boolean }>;
  comments: string;
  stats: { in: number; out: number; readBytes: number; writtenBytes: number; tasks: number; errors: number };
};

type Connection = {
  id: string;
  sourceId: string;
  destinationId: string;
  relationships: string[];
  name: string;
  bends: unknown[];
  queue: { flowFiles: FlowFile[]; objectThreshold: number; dataSizeThreshold: number; expiration: string; prioritizers: string[] };
};

type ProvenanceEvent = {
  id: string;
  eventType: string;
  timestamp: string;
  componentId: string;
  componentName: string;
  componentType: string;
  flowFileUuid: string;
  fileSize: number;
  attributes: Record<string, string>;
  parentUuids: string[];
  details: string;
  relationship: string;
  connectionId: string;
  durationMs: number;
  flowFileSnapshot?: FlowFile;
};

type FlowRun = {
  id: string;
  startedAt: string;
  completedAt: string;
  processed: number;
  cycles: number;
  queued: number;
  published: number;
  rejected: number;
  highRisk: number;
  provenanceEvents: number;
  qualityScore: number;
};

type DataFlow = {
  schema: 'skyview-nifi-flow';
  version: 2;
  flowId: string;
  name: string;
  revision: number;
  processors: Processor[];
  connections: Connection[];
  labels: Array<{ id: string; x: number; y: number; text: string }>;
  mappings: Array<Record<string, unknown>>;
  rules: Array<Record<string, unknown>>;
  routes: Array<Record<string, unknown>>;
  sourceRecords: Array<Record<string, unknown>>;
  inputLoaded: boolean;
  controllerServices: Array<{ id: string; name: string; type: string; state: string; properties: Record<string, string> }>;
  parameterContext: { id: string; name: string; parameters: Array<{ name: string; value: string; sensitive: boolean }> };
  policies: Array<{ id: string; resource: string; action: string; users: string[] }>;
  provenance: ProvenanceEvent[];
  bulletins: unknown[];
  outputArchive: Array<Record<string, unknown>>;
  runHistory: FlowRun[];
  selectedId: string;
  selectedKind: 'processor' | 'connection';
  viewport: { x: number; y: number; zoom: number };
  updatedAt: string;
};

type ValidationIssue = { level: string; componentId: string; code: string; message: string };

const catalogRows: Array<[string, string, string, string[], string[]]> = [
  ['ListenHTTP', '接入', '通过 HTTP 接收 FlowFile', ['http', 'ingest', 'listen'], ['success', 'failure']],
  ['GetFile', '接入', '从受控目录读取文件', ['file', 'local', 'batch'], ['success']],
  ['ConsumeKafka', '接入', '消费 Kafka 主题记录', ['kafka', 'stream', 'message'], ['success']],
  ['QueryDatabaseTableRecord', '接入', '增量查询数据库记录', ['sql', 'database', 'record'], ['success', 'failure', 'retry']],
  ['CaptureChangeMySQL', '接入', '捕获 MySQL CDC 变更', ['cdc', 'mysql', 'database'], ['success', 'failure']],
  ['ConsumeMQTT', '接入', '消费 MQTT 消息', ['mqtt', 'iot', 'stream'], ['success']],
  ['FetchSFTP', '接入', '提取 SFTP 远程内容', ['sftp', 'file', 'secure'], ['success', 'not.found', 'permission.denied', 'failure']],
  ['GenerateFlowFile', '接入', '生成测试 FlowFile', ['test', 'generate'], ['success']],
  ['ConvertRecord', '转换', '使用 Record Reader/Writer 转换记录', ['record', 'schema', 'convert'], ['success', 'failure']],
  ['UpdateRecord', '转换', '按字段路径更新记录', ['record', 'field', 'update'], ['success', 'failure']],
  ['JoltTransformJSON', '转换', '按 Jolt 规范转换 JSON', ['json', 'jolt', 'transform'], ['success', 'failure']],
  ['QueryRecord', '转换', '使用 SQL 查询并拆分记录集', ['record', 'sql', 'query'], ['matched', 'unmatched', 'failure']],
  ['EvaluateJsonPath', '转换', '提取 JSONPath 为 FlowFile 属性', ['json', 'attribute', 'extract'], ['matched', 'unmatched', 'failure']],
  ['ValidateRecord', '质量', '按 Schema 与显式规则校验记录', ['record', 'schema', 'quality'], ['valid', 'invalid', 'failure']],
  ['DetectDuplicate', '质量', '检测重复记录或内容', ['duplicate', 'cache', 'quality'], ['non-duplicate', 'duplicate', 'failure']],
  ['MonitorActivity', '质量', '监测数据流静默与恢复', ['monitor', 'alert', 'quality'], ['success', 'inactive']],
  ['RouteOnAttribute', '路由', '按 FlowFile 属性表达式路由', ['route', 'attribute', 'condition'], ['high', 'medium', 'unmatched']],
  ['RouteOnContent', '路由', '按内容正则表达式路由', ['route', 'content', 'regex'], ['matched', 'unmatched']],
  ['SplitRecord', '路由', '将记录集拆分为多个 FlowFile', ['split', 'record', 'fork'], ['splits', 'original', 'failure']],
  ['MergeRecord', '路由', '合并具有相关性的记录', ['merge', 'record', 'join'], ['merged', 'original', 'failure']],
  ['PutDatabaseRecord', '交付', '通过受控连接池写入数据库', ['database', 'sql', 'record'], ['success', 'retry', 'failure']],
  ['PublishKafka', '交付', '发布到 Kafka 主题', ['kafka', 'publish', 'stream'], ['success', 'failure']],
  ['PutS3Object', '交付', '写入兼容 S3 的对象存储', ['s3', 'object', 'cloud'], ['success', 'failure']],
  ['PutFile', '交付', '写入受控文件目录', ['file', 'archive', 'dead-letter'], ['success', 'failure']],
  ['InvokeHTTP', '交付', '调用远程 HTTP 服务', ['http', 'api', 'request'], ['response', 'retry', 'no.retry', 'failure']],
  ['LogAttribute', '交付', '记录 FlowFile 属性用于审查', ['log', 'debug', 'attribute'], ['success']],
];

const processorCatalog: ProcessorCatalogItem[] = catalogRows.map(([type, group, description, tags, relationships]) => ({ type, group, description, tags, relationships }));
const terminalTypes = new Set(['PutDatabaseRecord', 'PublishKafka', 'PutS3Object', 'PutFile', 'InvokeHTTP', 'LogAttribute']);
const terminalStatuses = new Set(['succeeded', 'failed', 'canceled']);

function processor(id: string, type: string, name: string, x: number, y: number, state = 'RUNNING', properties: Record<string, string> = {}): Processor {
  const definition = processorCatalog.find((item) => item.type === type) ?? processorCatalog[0];
  return { id, kind: 'processor', type, name, x, y, width: 190, height: 78, state, validation: 'VALID', scheduling: { strategy: 'TIMER_DRIVEN', period: '1 sec', concurrentTasks: 1, penalty: '30 sec', yield: '1 sec' }, properties, relationships: definition.relationships.map((relation) => ({ name: relation, autoTerminate: terminalTypes.has(type) })), comments: '', stats: { in: 0, out: 0, readBytes: 0, writtenBytes: 0, tasks: 0, errors: 0 } };
}

function connection(id: string, sourceId: string, destinationId: string, relationships: string | string[], name: string, objectThreshold = 10000): Connection {
  return { id, sourceId, destinationId, relationships: Array.isArray(relationships) ? relationships : [relationships], name, bends: [], queue: { flowFiles: [], objectThreshold, dataSizeThreshold: 1073741824, expiration: '0 sec', prioritizers: ['FirstInFirstOutPrioritizer'] } };
}

function sampleRecords() {
  return Array.from({ length: 24 }, (_, index) => ({ sensor_id: `MS-${String(index % 8 + 1).padStart(3, '0')}`, observed_at: new Date(Date.UTC(2026, 7, 9, 8, index * 5)).toISOString(), displacement_mm: index === 17 ? '' : (2.4 + Math.sin(index / 3) * 1.8 + index * 0.09).toFixed(3), velocity_mm_h: (0.18 + Math.cos(index / 4) * 0.11).toFixed(3), risk_level: index % 11 === 0 ? 'high' : index % 5 === 0 ? 'medium' : 'low', source: index % 2 ? 'edge-gateway-a' : 'edge-gateway-b' }));
}

function createDefaultFlow(): DataFlow {
  const processors = [
    processor('p-ingest', 'ListenHTTP', '现场监测接入', 80, 115, 'RUNNING', { 'Listening Port': '9443', 'Base Path': '/monitoring', 'SSL Context Service': 'StandardSSLContextService' }),
    processor('p-convert', 'ConvertRecord', '统一字段与单位', 350, 115, 'RUNNING', { 'Record Reader': 'JsonTreeReader', 'Record Writer': 'JsonRecordSetWriter' }),
    processor('p-validate', 'ValidateRecord', '质量与 Schema 门禁', 620, 115, 'RUNNING', { 'Record Reader': 'JsonTreeReader', 'Schema Registry': 'MonitoringSchemaRegistry' }),
    processor('p-route', 'RouteOnAttribute', '风险条件路由', 890, 115, 'RUNNING', { high: "${risk_level:equals('high')}", medium: "${risk_level:equals('medium')}" }),
    processor('p-publish', 'PutDatabaseRecord', '标准数据发布', 1180, 55, 'RUNNING', { 'Database Connection Pooling Service': 'MonitoringDBCP', 'Table Name': 'observation_standard' }),
    processor('p-warning', 'PublishKafka', '预警主题发布', 1180, 175, 'RUNNING', { 'Kafka Brokers': 'ref:gateway/kafka-brokers', 'Topic Name': 'monitoring-warning' }),
    processor('p-reject', 'PutFile', '脏数据隔离区', 890, 320, 'RUNNING', { Directory: 'ref:gateway/dead-letter-directory' }),
  ];
  return {
    schema: 'skyview-nifi-flow', version: 2, flowId: 'pg-root', name: '矿山多源监测数据网关', revision: 1, processors,
    connections: [connection('c-ingest-convert', 'p-ingest', 'p-convert', 'success', 'raw-monitoring'), connection('c-ingest-failure', 'p-ingest', 'p-reject', 'failure', 'ingest-failure', 2000), connection('c-convert-validate', 'p-convert', 'p-validate', 'success', 'normalized'), connection('c-convert-failure', 'p-convert', 'p-reject', 'failure', 'parse-failure', 2000), connection('c-valid-route', 'p-validate', 'p-route', 'valid', 'quality-passed'), connection('c-invalid-reject', 'p-validate', 'p-reject', ['invalid', 'failure'], 'quality-rejected', 2000), connection('c-route-publish', 'p-route', 'p-publish', ['medium', 'unmatched'], 'standard-output'), connection('c-route-warning', 'p-route', 'p-warning', 'high', 'warning-output', 1000)],
    labels: [{ id: 'label-1', x: 76, y: 35, text: 'MONITORING INGEST → STANDARDIZE → QUALITY → ROUTE → DELIVERY' }],
    mappings: [{ id: 'map-1', source: 'sensor_id', target: 'sensor_id', operation: 'trim', enabled: true }, { id: 'map-2', source: 'observed_at', target: 'observed_at', operation: 'cast', argument: 'datetime', enabled: true }, { id: 'map-3', source: 'displacement_mm', target: 'displacement_mm', operation: 'cast', argument: 'number', enabled: true }, { id: 'map-4', source: 'velocity_mm_h', target: 'velocity_mm_h', operation: 'cast', argument: 'number', enabled: true }, { id: 'map-5', source: 'risk_level', target: 'risk_level', operation: 'lowercase', enabled: true }, { id: 'map-6', source: 'source', target: 'source', operation: 'trim', enabled: true }, { id: 'map-7', source: 'sensor_id', target: 'record_key', operation: 'hash', enabled: true }],
    rules: [{ id: 'rule-id', name: '传感器编号完整', type: 'required', field: 'sensor_id', severity: 'error', enabled: true }, { id: 'rule-time', name: '观测时间完整', type: 'required', field: 'observed_at', severity: 'error', enabled: true }, { id: 'rule-value', name: '位移记录完整', type: 'required', field: 'displacement_mm', severity: 'error', enabled: true }, { id: 'rule-range', name: '位移合理范围', type: 'range', field: 'displacement_mm', min: -50, max: 200, severity: 'error', enabled: true }, { id: 'rule-risk', name: '风险等级枚举', type: 'enum', field: 'risk_level', values: 'low|medium|high', severity: 'warn', enabled: true }],
    routes: [{ id: 'route-high', name: 'high', field: 'risk_level', operator: 'eq', value: 'high', enabled: true }, { id: 'route-medium', name: 'medium', field: 'risk_level', operator: 'eq', value: 'medium', enabled: true }],
    sourceRecords: sampleRecords(), inputLoaded: false,
    controllerServices: [{ id: 'svc-json-reader', name: 'JsonTreeReader', type: 'JsonTreeReader', state: 'ENABLED', properties: { 'Schema Access Strategy': 'Infer Schema' } }, { id: 'svc-json-writer', name: 'JsonRecordSetWriter', type: 'JsonRecordSetWriter', state: 'ENABLED', properties: { 'Schema Write Strategy': "Set 'avro.schema' Attribute" } }, { id: 'svc-schema', name: 'MonitoringSchemaRegistry', type: 'AvroSchemaRegistry', state: 'ENABLED', properties: { 'Schema Name': 'monitoring-observation-v1' } }, { id: 'svc-dbcp', name: 'MonitoringDBCP', type: 'DBCPConnectionPool', state: 'DISABLED', properties: { 'Database URL': 'ref:gateway/monitoring-db', Password: 'ref:gateway/monitoring-db-password' } }, { id: 'svc-ssl', name: 'StandardSSLContextService', type: 'StandardRestrictedSSLContextService', state: 'ENABLED', properties: { Keystore: 'ref:gateway/tls-keystore', Truststore: 'ref:gateway/tls-truststore' } }],
    parameterContext: { id: 'params-review', name: 'review-environment', parameters: [{ name: 'kafka.topic.warning', value: 'monitoring-warning', sensitive: false }, { name: 'db.password', value: 'ref:gateway/monitoring-db-password', sensitive: true }, { name: 'dead.letter.path', value: 'ref:gateway/dead-letter-directory', sensitive: false }] },
    policies: [{ id: 'policy-view', resource: '/process-groups/pg-root', action: 'view', users: ['researcher', 'operator', 'administrator'] }, { id: 'policy-modify', resource: '/process-groups/pg-root', action: 'modify', users: ['operator', 'administrator'] }, { id: 'policy-provenance', resource: '/provenance-data', action: 'view_provenance', users: ['auditor', 'administrator'] }, { id: 'policy-data', resource: '/data/pg-root', action: 'view_data', users: ['operator', 'administrator'] }],
    provenance: [], bulletins: [], outputArchive: [], runHistory: [], selectedId: 'p-validate', selectedKind: 'processor', viewport: { x: 0, y: 0, zoom: 1 }, updatedAt: new Date().toISOString(),
  };
}

function wait(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function waitForJob(id: string): Promise<WorkbenchJob | null> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const job = await toolApi.getJob(id);
    if (terminalStatuses.has(job.status)) return job;
    await wait(500);
  }
  return null;
}

function bytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1048576) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1048576).toFixed(1)} MB`;
}

function downloadText(content: string, filename: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function formString(data: FormData, name: string, fallback = '') {
  const value = data.get(name);
  return typeof value === 'string' ? value : fallback;
}

function queueCount(flow: DataFlow) {
  return flow.connections.reduce((total, item) => total + item.queue.flowFiles.length, 0);
}

export function DataGatewayWorkbench({ executionAllowed = true }: { executionAllowed?: boolean }) {
  const [flow, setFlow] = useState<DataFlow>(() => createDefaultFlow());
  const [projects, setProjects] = useState<WorkbenchProject[]>([]);
  const [projectId, setProjectId] = useState('');
  const [selectedId, setSelectedId] = useState('p-validate');
  const [selectedKind, setSelectedKind] = useState<'processor' | 'connection'>('processor');
  const [dialog, setDialog] = useState<'catalog' | 'processor' | 'connection' | 'governance' | 'validation' | 'provenance' | 'history' | 'connect' | null>(null);
  const [configTab, setConfigTab] = useState('Settings');
  const [governanceTab, setGovernanceTab] = useState('Controller Services');
  const [catalogGroup, setCatalogGroup] = useState('全部');
  const [catalogQuery, setCatalogQuery] = useState('');
  const [catalogType, setCatalogType] = useState('ConvertRecord');
  const [search, setSearch] = useState('');
  const [provenanceQuery, setProvenanceQuery] = useState('');
  const [selectedEventId, setSelectedEventId] = useState('');
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [running, setRunning] = useState(false);
  const [runningLabel, setRunningLabel] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [zoom, setZoom] = useState(0.85);
  const [clipboard, setClipboard] = useState<Processor | null>(null);
  const [connectSource, setConnectSource] = useState('p-ingest');
  const [connectTarget, setConnectTarget] = useState('p-convert');
  const [drag, setDrag] = useState<{ id: string; startX: number; startY: number; x: number; y: number } | null>(null);
  const dataInput = useRef<HTMLInputElement>(null);
  const flowInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    toolApi.listProjects('data-gateway').then((items) => {
      if (!active) return;
      setProjects(items);
      const recent = items[0];
      const saved = (recent?.state.gateway as { flow?: DataFlow } | undefined)?.flow;
      if (recent && saved?.schema === 'skyview-nifi-flow') {
        setProjectId(recent.id);
        setFlow(saved);
        setSelectedId(saved.selectedId || 'p-validate');
        setSelectedKind(saved.selectedKind || 'processor');
      }
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  const selectedProcessor = flow.processors.find((item) => item.id === selectedId);
  const selectedConnection = flow.connections.find((item) => item.id === selectedId);
  const selectedEvent = flow.provenance.find((item) => item.id === selectedEventId);
  const groups = ['全部', '接入', '转换', '质量', '路由', '交付'];
  const filteredCatalog = processorCatalog.filter((item) => (catalogGroup === '全部' || item.group === catalogGroup) && `${item.type} ${item.description} ${item.tags.join(' ')}`.toLowerCase().includes(catalogQuery.toLowerCase()));
  const searchMatches = search.trim() ? flow.processors.filter((item) => `${item.name} ${item.type}`.toLowerCase().includes(search.toLowerCase())).slice(0, 6) : [];
  const filteredEvents = flow.provenance.filter((item) => `${item.id} ${item.eventType} ${item.componentName} ${item.flowFileUuid}`.toLowerCase().includes(provenanceQuery.toLowerCase())).slice(0, 300);
  const stats = useMemo(() => ({ running: flow.processors.filter((item) => item.state === 'RUNNING').length, stopped: flow.processors.filter((item) => item.state === 'STOPPED').length, disabled: flow.processors.filter((item) => item.state === 'DISABLED').length, queued: queueCount(flow), queuedBytes: flow.connections.reduce((total, item) => total + item.queue.flowFiles.reduce((subtotal, file) => subtotal + file.size, 0), 0) }), [flow]);

  const ensureProject = async (current: DataFlow) => {
    const existing = projects.find((item) => item.id === projectId);
    if (existing) return existing;
    const created = await toolApi.createProject('data-gateway', current.name, { gateway: { flow: current } });
    setProjects((items) => [created, ...items]);
    setProjectId(created.id);
    return created;
  };

  const persistFlow = async (current: DataFlow, record?: WorkbenchProject) => {
    const target = record ?? await ensureProject(current);
    const saved = await toolApi.updateProject(target.id, current.name, { gateway: { flow: current } });
    await toolApi.createVersion(saved.id, `DataFlow Revision ${current.revision}`, saved.state);
    setProjects((items) => [saved, ...items.filter((item) => item.id !== saved.id)]);
    setProjectId(saved.id);
    return saved;
  };

  const runJob = async (action: string, input: Record<string, unknown>, label: string, current = flow) => {
    if (!executionAllowed) throw new Error('服务暂未连接，请稍后重试。');
    setRunning(true); setRunningLabel(label); setError(''); setMessage('');
    try {
      const record = await ensureProject(current);
      const created = await toolApi.createJob(record.id, 'data-gateway', action, input, crypto.randomUUID());
      const job = await waitForJob(created.job.id);
      if (!job) throw new Error('任务仍在后台运行，请稍后查看。');
      if (job.status !== 'succeeded') throw new Error(job.error || '任务执行失败。');
      return { output: job.result, record };
    } finally { setRunning(false); setRunningLabel(''); }
  };

  const saveFlow = async () => {
    try { await persistFlow(flow); setMessage(`Revision ${flow.revision} 已保存并建立不可变快照。`); setError(''); }
    catch (caught) { setError(caught instanceof Error ? caught.message : '保存失败。'); }
  };

  const validate = async () => {
    try {
      const { output } = await runJob('validate-flow', { flow }, '正在校验处理器、连接与凭据引用');
      const nextIssues = (output.issues as ValidationIssue[]) ?? [];
      setIssues(nextIssues); setDialog('validation');
      setMessage(output.valid ? '流程校验通过。' : `发现 ${nextIssues.length} 个配置问题。`);
    } catch (caught) { setError(caught instanceof ApiError || caught instanceof Error ? caught.message : '校验失败。'); }
  };

  const execute = async (runOnce = false) => {
    try {
      const { output, record } = await runJob('run', { flow }, runOnce ? '正在运行一次' : '正在运行完整数据流');
      const next = output.flow as DataFlow;
      setFlow(next); setIssues([]); await persistFlow(next, record);
      const summary = output.summary as FlowRun;
      setMessage(`运行完成：发布 ${summary.published}，隔离 ${summary.rejected}，高风险 ${summary.highRisk}。`);
    } catch (caught) { setError(caught instanceof ApiError || caught instanceof Error ? caught.message : '运行失败。'); }
  };

  const importData = async (file: File) => {
    try {
      const content = await file.text();
      const { output, record } = await runJob('preview', { flow, content, format: 'auto' }, `正在解析 ${file.name}`);
      const next = output.flow as DataFlow;
      setFlow(next); await persistFlow(next, record);
      setMessage(`已载入 ${output.rows as number} 行，等待运行。`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : '数据导入失败。'); }
  };

  const importFlow = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as DataFlow;
      if (parsed.schema !== 'skyview-nifi-flow' || parsed.version !== 2 || !Array.isArray(parsed.processors)) throw new Error('请选择 skyview-nifi-flow v2 流程文件。');
      setFlow({ ...parsed, revision: Number(parsed.revision || 0) + 1, updatedAt: new Date().toISOString() });
      setProjectId(''); setSelectedId(parsed.processors[0]?.id ?? ''); setSelectedKind('processor'); setMessage('流程已导入，请先校验再运行。'); setError('');
    } catch (caught) { setError(caught instanceof Error ? caught.message : '流程导入失败。'); }
  };

  const exportFlow = async (kind: 'flow' | 'provenance') => {
    try {
      const { output } = await runJob('export', { flow }, '正在生成流程交付文件');
      const files = output.files as { flow: string; provenance: string };
      downloadText(String(kind === 'flow' ? output.flowJson : output.provenanceJson), files[kind]);
      setMessage(`${files[kind]} 已导出。`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : '导出失败。'); }
  };

  const replayEvent = async () => {
    if (!selectedEvent) return;
    try {
      const { output, record } = await runJob('replay', { flow, eventId: selectedEvent.id, connectionId: 'c-ingest-convert' }, '正在创建可追溯 Replay');
      const next = output.flow as DataFlow;
      setFlow(next); await persistFlow(next, record); setDialog('connection'); setSelectedId('c-ingest-convert'); setSelectedKind('connection');
      setMessage(`已生成新 FlowFile，父项为 ${String(output.parentUuid).slice(0, 18)}…`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Replay 失败。'); }
  };

  const mutateFlow = (mutator: (next: DataFlow) => void) => {
    setFlow((current) => { const next = structuredClone(current); mutator(next); next.revision += 1; next.updatedAt = new Date().toISOString(); return next; });
  };

  const selectProcessor = (id: string) => { setSelectedId(id); setSelectedKind('processor'); };
  const selectConnection = (id: string) => { setSelectedId(id); setSelectedKind('connection'); };
  const setSelectedState = (state: string) => { if (!selectedProcessor) return; mutateFlow((next) => { const item = next.processors.find((entry) => entry.id === selectedProcessor.id); if (item) item.state = state; }); setMessage(`${selectedProcessor.name} 已${state === 'RUNNING' ? '启动' : '停止'}。`); };

  const copySelected = () => { if (selectedProcessor) { setClipboard(structuredClone(selectedProcessor)); setMessage(`${selectedProcessor.name} 已复制。`); } };
  const pasteProcessor = () => {
    if (!clipboard) return;
    const id = `p-${crypto.randomUUID()}`;
    const next = { ...structuredClone(clipboard), id, name: `${clipboard.name} 副本`, x: clipboard.x + 34, y: clipboard.y + 34, state: 'STOPPED' };
    mutateFlow((value) => value.processors.push(next)); selectProcessor(id); setMessage('处理器副本已粘贴。');
  };

  const deleteSelected = () => {
    mutateFlow((next) => {
      if (selectedKind === 'processor') { next.processors = next.processors.filter((item) => item.id !== selectedId); next.connections = next.connections.filter((item) => item.sourceId !== selectedId && item.destinationId !== selectedId); }
      else next.connections = next.connections.filter((item) => item.id !== selectedId);
    });
    setSelectedId(''); setMessage('所选组件已删除。');
  };

  const addProcessor = () => {
    const definition = processorCatalog.find((item) => item.type === catalogType);
    if (!definition) return;
    const id = `p-${crypto.randomUUID()}`;
    const next = processor(id, definition.type, definition.type, 350 + Math.round(Math.random() * 220), 220 + Math.round(Math.random() * 180), 'STOPPED');
    mutateFlow((value) => value.processors.push(next)); selectProcessor(id); setDialog(null); setMessage(`${definition.type} 已加入画布。`);
  };

  const addConnection = () => {
    const source = flow.processors.find((item) => item.id === connectSource);
    if (!source || connectSource === connectTarget) { setError('请选择不同的来源与目标处理器。'); return; }
    const id = `c-${crypto.randomUUID()}`;
    mutateFlow((next) => next.connections.push(connection(id, connectSource, connectTarget, source.relationships[0]?.name ?? 'success', `${source.name} → ${flow.processors.find((item) => item.id === connectTarget)?.name ?? connectTarget}`)));
    selectConnection(id); setDialog(null); setMessage('连接已创建。');
  };

  const saveProcessor = (form: HTMLFormElement) => {
    if (!selectedProcessor) return;
    const data = new FormData(form);
    const propertiesValue = data.get('properties');
    let parsedProperties: Record<string, string> | null = null;
    if (typeof propertiesValue === 'string') {
      try { parsedProperties = JSON.parse(propertiesValue) as Record<string, string>; }
      catch { throw new Error('Properties 必须是 JSON 对象。'); }
    }
    mutateFlow((next) => {
      const item = next.processors.find((entry) => entry.id === selectedProcessor.id);
      if (!item) return;
      item.name = formString(data, 'name', item.name);
      item.scheduling.strategy = formString(data, 'strategy', item.scheduling.strategy);
      item.scheduling.period = formString(data, 'period', item.scheduling.period);
      item.scheduling.concurrentTasks = Number(formString(data, 'concurrentTasks', String(item.scheduling.concurrentTasks)));
      item.comments = formString(data, 'comments', item.comments);
      if (parsedProperties) item.properties = parsedProperties;
      if (configTab === 'Relationships') item.relationships.forEach((relationship) => { relationship.autoTerminate = data.has(`rel-${relationship.name}`); });
    });
    setDialog(null); setMessage('处理器配置已应用，请执行流程校验。');
  };

  const saveConnection = (form: HTMLFormElement) => {
    if (!selectedConnection) return;
    const data = new FormData(form);
    mutateFlow((next) => {
      const item = next.connections.find((entry) => entry.id === selectedConnection.id);
      if (!item) return;
      item.name = formString(data, 'name', item.name);
      item.queue.objectThreshold = Math.max(1, Number(formString(data, 'objectThreshold', String(item.queue.objectThreshold))));
      item.queue.dataSizeThreshold = Math.max(1024, Number(formString(data, 'dataSizeThreshold', String(item.queue.dataSizeThreshold))));
      item.queue.expiration = formString(data, 'expiration', item.queue.expiration);
    });
    setDialog(null); setMessage('连接与反压配置已应用。');
  };

  const openProject = (id: string) => {
    const record = projects.find((item) => item.id === id);
    const saved = (record?.state.gateway as { flow?: DataFlow } | undefined)?.flow;
    if (!record || !saved) return;
    setProjectId(record.id); setFlow(saved); setSelectedId(saved.selectedId || saved.processors[0]?.id || ''); setSelectedKind(saved.selectedKind || 'processor');
  };

  const connectionLine = (item: Connection) => {
    const source = flow.processors.find((entry) => entry.id === item.sourceId);
    const target = flow.processors.find((entry) => entry.id === item.destinationId);
    if (!source || !target) return null;
    const x1 = source.x + source.width; const y1 = source.y + source.height / 2; const x2 = target.x; const y2 = target.y + target.height / 2;
    const middle = (x1 + x2) / 2;
    return <g key={item.id} onClick={() => selectConnection(item.id)} className={selectedKind === 'connection' && selectedId === item.id ? 'selected' : ''}><path d={`M ${x1} ${y1} C ${middle} ${y1}, ${middle} ${y2}, ${x2} ${y2}`} /><circle cx={(x1 + x2) / 2} cy={(y1 + y2) / 2} r="13" /><text x={(x1 + x2) / 2} y={(y1 + y2) / 2 + 4}>{item.queue.flowFiles.length}</text></g>;
  };

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() === 's') { event.preventDefault(); void saveFlow(); }
      if (event.key.toLowerCase() === 'c' && selectedKind === 'processor') { event.preventDefault(); copySelected(); }
      if (event.key.toLowerCase() === 'v') { event.preventDefault(); pasteProcessor(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  return (
    <section className="dataflow-shell">
      <header className="dataflow-productbar">
        <div className="dataflow-product-identity"><Network /><strong>DataFlow</strong><span>数据网关</span></div>
        <div><label htmlFor="dataflow-project">当前流程</label><NativeSelect id="dataflow-project" value={projectId} onChange={(event) => openProject(event.target.value)}><NativeSelectOption value="">未保存的新流程</NativeSelectOption>{projects.map((item) => <NativeSelectOption key={item.id} value={item.id}>{item.title}</NativeSelectOption>)}</NativeSelect><Button variant="ghost" size="sm" onClick={() => { setFlow(createDefaultFlow()); setProjectId(''); setSelectedId('p-validate'); setSelectedKind('processor'); }}><Plus />新建</Button></div>
      </header>
      <div className="dataflow-toolbar" aria-label="组件工具栏">
        <input ref={dataInput} type="file" accept=".csv,.tsv,.json,text/csv,application/json" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importData(file); event.target.value = ''; }} />
        <input ref={flowInput} type="file" accept=".json,application/json" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importFlow(file); event.target.value = ''; }} />
        <div className="dataflow-toolbar-primary"><Button size="sm" onClick={() => setDialog('catalog')}><Plus />添加处理器</Button><Button variant="outline" size="sm" onClick={() => { setConnectSource(selectedProcessor?.id ?? flow.processors[0]?.id ?? ''); setConnectTarget(flow.processors.find((item) => item.id !== selectedId)?.id ?? ''); setDialog('connect'); }}><GitBranch />连接</Button><Button variant="outline" size="sm" onClick={() => dataInput.current?.click()}><Upload />载入数据</Button><Button variant="outline" size="sm" onClick={() => flowInput.current?.click()}><FileUp />导入流</Button><Button variant="outline" size="sm" onClick={() => void exportFlow('flow')}><Download />导出流</Button></div>
        <div className="dataflow-toolbar-status" aria-label="状态栏"><span><i className="running" />{stats.running} 个运行中</span><span><i />{stats.stopped} 个已停止</span><span><i className="disabled" />{stats.disabled} 个已禁用</span><span><Box /> {stats.queued} 个排队中 / {bytes(stats.queuedBytes)}</span><span><FileClock /> {flow.provenance.length} 条溯源记录</span><span>修订版本 {flow.revision}</span></div>
        <div className="dataflow-toolbar-actions"><Button variant="ghost" size="sm" onClick={() => setDialog('governance')}><Database />流程配置</Button><Button variant="ghost" size="sm" onClick={() => void validate()}><ShieldCheck />校验</Button><Button variant="ghost" size="sm" onClick={() => void execute()} disabled={running}><Play />运行</Button><Button variant="ghost" size="sm" onClick={() => void saveFlow()}><Save />保存</Button></div>
      </div>
      <div className="dataflow-breadcrumb"><button type="button">数据流</button><ChevronDown /><button type="button">根流程组</button><ChevronDown /><strong>{flow.name}</strong><small>SkyViewLab 数据流 v2</small></div>
      <div className="dataflow-workarea">
        <aside className="dataflow-operate" aria-label="操作面板"><header>操作</header><div><button type="button" onClick={() => setSelectedState('RUNNING')} disabled={!selectedProcessor}><CirclePlay />启动</button><button type="button" onClick={() => setSelectedState('STOPPED')} disabled={!selectedProcessor}><CircleStop />停止</button><button type="button" onClick={() => void execute(true)} disabled={running}><Play />运行一次</button><button type="button" onClick={() => { setConfigTab('Settings'); setDialog(selectedKind === 'processor' ? 'processor' : 'connection'); }} disabled={!selectedId}><Settings />配置</button><button type="button" onClick={copySelected} disabled={!selectedProcessor}><Copy />复制</button><button type="button" onClick={pasteProcessor} disabled={!clipboard}><Clipboard />粘贴</button><button type="button" onClick={deleteSelected} disabled={!selectedId}><Trash2 />删除</button><button type="button" onClick={() => setDialog('provenance')}><GitBranch />数据溯源</button><button type="button" onClick={() => setDialog('history')}><History />运行历史</button></div>{selectedProcessor && <section><span>已选择</span><strong>{selectedProcessor.name}</strong><small>{selectedProcessor.type}</small><em data-state={selectedProcessor.state}>{selectedProcessor.state}</em></section>}{selectedConnection && <section><span>连接</span><strong>{selectedConnection.name}</strong><small>{selectedConnection.relationships.join(', ')}</small><em>{selectedConnection.queue.flowFiles.length} 个排队中</em></section>}</aside>
        <div role="application" aria-label="数据流无限画布" className="dataflow-canvas-shell" onPointerMove={(event) => { if (!drag) return; const dx = (event.clientX - drag.startX) / zoom; const dy = (event.clientY - drag.startY) / zoom; mutateFlow((next) => { const item = next.processors.find((entry) => entry.id === drag.id); if (item) { item.x = Math.max(12, drag.x + dx); item.y = Math.max(42, drag.y + dy); } }); setDrag((current) => current ? { ...current, startX: event.clientX, startY: event.clientY, x: current.x + dx, y: current.y + dy } : null); }} onPointerUp={() => setDrag(null)} onPointerLeave={() => setDrag(null)}>
          <div className="dataflow-search"><Search /><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索处理器" />{search && <button type="button" onClick={() => setSearch('')} aria-label="清除搜索"><X /></button>}{searchMatches.length > 0 && <div>{searchMatches.map((item) => <button key={item.id} type="button" onClick={() => { selectProcessor(item.id); setSearch(''); }}><strong>{item.name}</strong><small>{item.type}</small></button>)}</div>}</div>
          <div className="dataflow-zoom"><button type="button" onClick={() => setZoom((value) => Math.min(1.2, value + 0.1))} aria-label="放大"><ZoomIn /></button><button type="button" onClick={() => setZoom((value) => Math.max(0.55, value - 0.1))} aria-label="缩小"><ZoomOut /></button><button type="button" onClick={() => setZoom(0.85)} aria-label="适应画布"><Maximize2 /></button><span>{Math.round(zoom * 100)}%</span></div>
          <div className="dataflow-stage" style={{ width: 1560 * zoom, height: 700 * zoom }}><div className="dataflow-stage-content" style={{ transform: `scale(${zoom})` }}>
            {flow.labels.map((label) => <div key={label.id} className="dataflow-label" style={{ left: label.x, top: label.y }}>{label.text}</div>)}
            <svg width="1560" height="700" className="dataflow-connections">{flow.connections.map(connectionLine)}</svg>
            {flow.processors.map((item) => <button type="button" key={item.id} className={`dataflow-processor ${selectedKind === 'processor' && selectedId === item.id ? 'selected' : ''}`} style={{ left: item.x, top: item.y, width: item.width, height: item.height }} onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); selectProcessor(item.id); setDrag({ id: item.id, startX: event.clientX, startY: event.clientY, x: item.x, y: item.y }); }} onDoubleClick={() => { selectProcessor(item.id); setConfigTab('Settings'); setDialog('processor'); }}><span className="dataflow-node-header"><span data-state={item.state} /><strong>{item.name}</strong><i>{item.validation === 'VALID' ? '✓' : '!'}</i></span><span className="dataflow-node-body"><Network /><span>{item.type}</span></span><span className="dataflow-node-footer"><span>In {item.stats.in}</span><span>Out {item.stats.out}</span><span>Tasks {item.stats.tasks}</span></span></button>)}
          </div></div>
        </div>
        <aside className="dataflow-navigate" aria-label="导航面板"><header>导航</header><div className="dataflow-minimap"><span>{flow.processors.map((item) => <i key={item.id} className={selectedId === item.id ? 'selected' : ''} style={{ left: item.x / 8.7, top: item.y / 7.2, width: item.width / 8.7, height: item.height / 7.2 }} />)}</span></div><section><strong>鸟瞰视图</strong><small>{flow.processors.length} 个处理器</small><small>{flow.connections.length} 条连接</small></section><section><Button variant="outline" size="sm" onClick={() => setDialog('connection')} disabled={!selectedConnection}><ListFilter />查看队列</Button><Button variant="outline" size="sm" onClick={() => setDialog('provenance')}><GitBranch />数据谱系</Button></section></aside>
      </div>
      <footer className="dataflow-footer"><span className={error ? 'error' : ''}>{error || message || '流程已就绪。拖动处理器调整布局，双击打开配置。'}</span><small>CSV / TSV / JSON 最多 10,000 行 · 外部连接只保存 credentialRef</small></footer>
      {running && <div className="dataflow-running"><div><span /><h3>{runningLabel}</h3><p>Go 控制面正在调度 Python 数据流任务</p></div></div>}

      <Dialog open={dialog === 'catalog'} onOpenChange={(open) => { if (!open) setDialog(null); }}><DialogContent className="dataflow-dialog wide"><DialogHeader><DialogTitle>添加处理器</DialogTitle><DialogDescription>从 26 类确定性白名单处理器中选择一个组件。</DialogDescription></DialogHeader><div className="dataflow-catalog"><nav>{groups.map((group) => <button key={group} type="button" className={catalogGroup === group ? 'active' : ''} onClick={() => setCatalogGroup(group)}><span>{group}</span><small>{group === '全部' ? processorCatalog.length : processorCatalog.filter((item) => item.group === group).length}</small></button>)}</nav><section><Input value={catalogQuery} onChange={(event) => setCatalogQuery(event.target.value)} placeholder="搜索处理器类型和标签" /><div>{filteredCatalog.map((item) => <button key={item.type} type="button" className={catalogType === item.type ? 'selected' : ''} onClick={() => setCatalogType(item.type)}><strong>{item.type}</strong><span>{item.description}</span><small>{item.tags.join(', ')}</small></button>)}</div></section></div><DialogFooter><Button variant="outline" onClick={() => setDialog(null)}>取消</Button><Button onClick={addProcessor}>添加</Button></DialogFooter></DialogContent></Dialog>

      <Dialog open={dialog === 'connect'} onOpenChange={(open) => { if (!open) setDialog(null); }}><DialogContent className="dataflow-dialog"><DialogHeader><DialogTitle>创建连接</DialogTitle><DialogDescription>连接来源关系与目标处理器，队列会保存积压和反压状态。</DialogDescription></DialogHeader><label htmlFor="df-connect-source"><span>来源</span><NativeSelect id="df-connect-source" value={connectSource} onChange={(event) => setConnectSource(event.target.value)}>{flow.processors.map((item) => <NativeSelectOption key={item.id} value={item.id}>{item.name}</NativeSelectOption>)}</NativeSelect></label><label htmlFor="df-connect-target"><span>目标</span><NativeSelect id="df-connect-target" value={connectTarget} onChange={(event) => setConnectTarget(event.target.value)}>{flow.processors.map((item) => <NativeSelectOption key={item.id} value={item.id}>{item.name}</NativeSelectOption>)}</NativeSelect></label><DialogFooter><Button variant="outline" onClick={() => setDialog(null)}>取消</Button><Button onClick={addConnection}>添加</Button></DialogFooter></DialogContent></Dialog>

      <Dialog open={dialog === 'processor'} onOpenChange={(open) => { if (!open) setDialog(null); }}><DialogContent className="dataflow-dialog wide"><DialogHeader><DialogTitle>配置处理器 · {selectedProcessor?.name}</DialogTitle><DialogDescription>敏感属性只能填写 `ref:` 凭据引用。</DialogDescription></DialogHeader>{selectedProcessor && <form id="processor-config" onSubmit={(event) => { event.preventDefault(); try { saveProcessor(event.currentTarget); } catch (caught) { setError(caught instanceof Error ? caught.message : '配置无效。'); } }}><div className="dataflow-tabs">{[['Settings', '设置'], ['Scheduling', '调度'], ['Properties', '属性'], ['Relationships', '关系'], ['Comments', '注释']].map(([tab, label]) => <button key={tab} type="button" className={configTab === tab ? 'active' : ''} onClick={() => setConfigTab(tab)}>{label}</button>)}</div><div className="dataflow-config-body">{configTab === 'Settings' && <><label htmlFor="df-processor-name"><span>名称</span><Input id="df-processor-name" name="name" defaultValue={selectedProcessor.name} /></label><label htmlFor="df-processor-type"><span>处理器类型</span><Input id="df-processor-type" value={selectedProcessor.type} readOnly /></label></>}{configTab === 'Scheduling' && <><label htmlFor="df-strategy"><span>调度策略</span><NativeSelect id="df-strategy" name="strategy" defaultValue={selectedProcessor.scheduling.strategy}><NativeSelectOption value="TIMER_DRIVEN">定时驱动</NativeSelectOption><NativeSelectOption value="CRON_DRIVEN">Cron 驱动</NativeSelectOption><NativeSelectOption value="PRIMARY_NODE_ONLY">仅主节点</NativeSelectOption></NativeSelect></label><label htmlFor="df-period"><span>运行计划</span><Input id="df-period" name="period" defaultValue={selectedProcessor.scheduling.period} /></label><label htmlFor="df-tasks"><span>并发任务数</span><Input id="df-tasks" type="number" min="1" max="64" name="concurrentTasks" defaultValue={selectedProcessor.scheduling.concurrentTasks} /></label></>}{configTab === 'Properties' && <label htmlFor="df-properties" className="full"><span>属性 JSON</span><Textarea id="df-properties" name="properties" defaultValue={JSON.stringify(selectedProcessor.properties, null, 2)} /></label>}{configTab === 'Relationships' && <div className="dataflow-relationships">{selectedProcessor.relationships.map((item) => <label key={item.name}><input type="checkbox" name={`rel-${item.name}`} defaultChecked={item.autoTerminate} /><span>{item.name}</span><small>自动终止</small></label>)}</div>}{configTab === 'Comments' && <label htmlFor="df-comments" className="full"><span>注释</span><Textarea id="df-comments" name="comments" defaultValue={selectedProcessor.comments} /></label>}</div></form>}<DialogFooter><Button variant="outline" onClick={() => setDialog(null)}>取消</Button><Button type="submit" form="processor-config">应用</Button></DialogFooter></DialogContent></Dialog>

      <Dialog open={dialog === 'connection'} onOpenChange={(open) => { if (!open) setDialog(null); }}><DialogContent className="dataflow-dialog wide"><DialogHeader><DialogTitle>{selectedConnection ? `查看队列 · ${selectedConnection.name}` : '查看队列'}</DialogTitle><DialogDescription>查看 FlowFile、积压数量与反压阈值。</DialogDescription></DialogHeader>{selectedConnection ? <form id="connection-config" onSubmit={(event) => { event.preventDefault(); saveConnection(event.currentTarget); }}><div className="dataflow-config-body"><label htmlFor="df-connection-name"><span>名称</span><Input id="df-connection-name" name="name" defaultValue={selectedConnection.name} /></label><label htmlFor="df-object-threshold"><span>反压对象数量阈值</span><Input id="df-object-threshold" name="objectThreshold" type="number" defaultValue={selectedConnection.queue.objectThreshold} /></label><label htmlFor="df-size-threshold"><span>反压数据量阈值</span><Input id="df-size-threshold" name="dataSizeThreshold" type="number" defaultValue={selectedConnection.queue.dataSizeThreshold} /></label><label htmlFor="df-expiration"><span>FlowFile 过期时间</span><Input id="df-expiration" name="expiration" defaultValue={selectedConnection.queue.expiration} /></label></div><div className="dataflow-table-wrap"><table><thead><tr><th>位置</th><th>UUID</th><th>文件名</th><th>大小</th><th>队列时间</th></tr></thead><tbody>{selectedConnection.queue.flowFiles.map((file, index) => <tr key={file.uuid}><td>{index + 1}</td><td><code>{file.uuid}</code></td><td>{file.attributes.filename}</td><td>{bytes(file.size)}</td><td>{new Date(file.lineageStartDate).toLocaleString('zh-CN')}</td></tr>)}</tbody></table>{!selectedConnection.queue.flowFiles.length && <p>队列为空。</p>}</div></form> : <p>请先在画布上选择一条连接。</p>}<DialogFooter><Button variant="outline" onClick={() => setDialog(null)}>关闭</Button>{selectedConnection && <Button type="submit" form="connection-config">应用</Button>}</DialogFooter></DialogContent></Dialog>

      <Dialog open={dialog === 'governance'} onOpenChange={(open) => { if (!open) setDialog(null); }}><DialogContent className="dataflow-dialog wide"><DialogHeader><DialogTitle>流程配置</DialogTitle><DialogDescription>控制器服务、参数上下文和访问策略统一随流程版本保存。</DialogDescription></DialogHeader><div className="dataflow-tabs">{[['Controller Services', '控制器服务'], ['Parameter Context', '参数上下文'], ['Access Policies', '访问策略']].map(([tab, label]) => <button key={tab} type="button" className={governanceTab === tab ? 'active' : ''} onClick={() => setGovernanceTab(tab)}>{label}</button>)}</div><div className="dataflow-table-wrap"><table><thead><tr>{governanceTab === 'Controller Services' ? <><th>状态</th><th>名称</th><th>类型</th><th>属性</th></> : governanceTab === 'Parameter Context' ? <><th>参数</th><th>值 / 引用</th><th>敏感</th></> : <><th>资源</th><th>权限</th><th>用户</th></>}</tr></thead><tbody>{governanceTab === 'Controller Services' && flow.controllerServices.map((item) => <tr key={item.id}><td><span className="dataflow-state" data-state={item.state}>{item.state}</span></td><td>{item.name}</td><td>{item.type}</td><td>{Object.keys(item.properties).length}</td></tr>)}{governanceTab === 'Parameter Context' && flow.parameterContext.parameters.map((item) => <tr key={item.name}><td>{item.name}</td><td><code>{item.sensitive ? 'ref:••••••••' : item.value}</code></td><td>{item.sensitive ? '是' : '否'}</td></tr>)}{governanceTab === 'Access Policies' && flow.policies.map((item) => <tr key={item.id}><td>{item.resource}</td><td><code>{item.action}</code></td><td>{item.users.join(', ')}</td></tr>)}</tbody></table></div><DialogFooter><Button onClick={() => setDialog(null)}>完成</Button></DialogFooter></DialogContent></Dialog>

      <Dialog open={dialog === 'validation'} onOpenChange={(open) => { if (!open) setDialog(null); }}><DialogContent className="dataflow-dialog wide"><DialogHeader><DialogTitle>流程校验</DialogTitle><DialogDescription>检查处理器白名单、连接完整性、反压和明文密钥。</DialogDescription></DialogHeader><div className="dataflow-validation">{issues.length ? issues.map((item, index) => <article key={`${item.code}-${index}`} data-level={item.level}><ShieldCheck /><div><strong>{item.code}</strong><p>{item.message}</p><small>{item.componentId}</small></div></article>) : <div className="dataflow-valid"><CheckCircle2 /><h3>流程校验通过</h3><p>未发现阻止预览运行的配置问题。</p></div>}</div><DialogFooter><Button onClick={() => setDialog(null)}>完成</Button></DialogFooter></DialogContent></Dialog>

      <Dialog open={dialog === 'provenance'} onOpenChange={(open) => { if (!open) setDialog(null); }}><DialogContent className="dataflow-dialog extra-wide"><DialogHeader><DialogTitle>数据溯源 · 搜索、谱系与重放</DialogTitle><DialogDescription>每个事件关联 FlowFile、组件、关系、父项和内容快照。</DialogDescription></DialogHeader><Input value={provenanceQuery} onChange={(event) => setProvenanceQuery(event.target.value)} placeholder="搜索事件、FlowFile UUID 或组件" /><div className="dataflow-provenance"><div className="dataflow-table-wrap"><table><thead><tr><th>事件</th><th>时间</th><th>类型</th><th>FlowFile UUID</th><th>组件</th><th>大小</th></tr></thead><tbody>{filteredEvents.map((item) => <tr key={item.id} className={selectedEventId === item.id ? 'selected' : ''} onClick={() => setSelectedEventId(item.id)}><td><code>{item.id.slice(0, 15)}</code></td><td>{new Date(item.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}</td><td><span data-event={item.eventType}>{item.eventType}</span></td><td><code>{item.flowFileUuid.slice(0, 18)}</code></td><td>{item.componentName}</td><td>{bytes(item.fileSize)}</td></tr>)}</tbody></table></div>{selectedEvent && <aside><h3>事件详情</h3><dl><div><dt>事件 ID</dt><dd>{selectedEvent.id}</dd></div><div><dt>FlowFile UUID</dt><dd>{selectedEvent.flowFileUuid}</dd></div><div><dt>父项</dt><dd>{selectedEvent.parentUuids.join(', ') || '—'}</dd></div><div><dt>关系</dt><dd>{selectedEvent.relationship || '—'}</dd></div><div><dt>详情</dt><dd>{selectedEvent.details}</dd></div></dl><h3>属性</h3><pre>{JSON.stringify(selectedEvent.attributes, null, 2)}</pre><Button onClick={() => void replayEvent()} disabled={!selectedEvent.flowFileSnapshot}><RotateCcw />重放到接入队列</Button></aside>}</div><DialogFooter><Button variant="outline" onClick={() => void exportFlow('provenance')}><Download />导出 JSON</Button><Button onClick={() => setDialog(null)}>关闭</Button></DialogFooter></DialogContent></Dialog>

      <Dialog open={dialog === 'history'} onOpenChange={(open) => { if (!open) setDialog(null); }}><DialogContent className="dataflow-dialog wide"><DialogHeader><DialogTitle>运行历史</DialogTitle><DialogDescription>保存每次受控预览运行的发布、隔离、队列与质量结果。</DialogDescription></DialogHeader><div className="dataflow-table-wrap"><table><thead><tr><th>运行</th><th>开始时间</th><th>已处理</th><th>已发布</th><th>已隔离</th><th>高风险</th><th>排队中</th><th>质量</th></tr></thead><tbody>{flow.runHistory.map((item) => <tr key={item.id}><td><code>{item.id}</code></td><td>{new Date(item.startedAt).toLocaleString('zh-CN')}</td><td>{item.processed}</td><td>{item.published}</td><td>{item.rejected}</td><td>{item.highRisk}</td><td>{item.queued}</td><td>{Math.round(item.qualityScore * 100)}%</td></tr>)}</tbody></table>{!flow.runHistory.length && <p>尚无运行记录。</p>}</div><DialogFooter><Button onClick={() => setDialog(null)}>完成</Button></DialogFooter></DialogContent></Dialog>
    </section>
  );
}
