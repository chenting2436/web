'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Archive,
  ArrowRight,
  BadgeAlert,
  Boxes,
  CheckCircle2,
  CircleAlert,
  ClipboardCheck,
  Download,
  FileArchive,
  FileInput,
  GitBranch,
  History,
  Layers3,
  LoaderCircle,
  MapPinned,
  MessageSquareMore,
  Radio,
  RefreshCw,
  Save,
  ShieldCheck,
  Siren,
  Users,
  Warehouse,
  X,
} from 'lucide-react';
import { useLanguage } from '@/components/language-provider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiError } from '@/services/api/client';
import {
  toolApi,
  type WorkbenchJob,
  type WorkbenchProject,
} from '@/services/api/tools';

type Report = {
  id: string;
  source: string;
  type: string;
  title: string;
  content: string;
  time: string;
  status: string;
  confidence: number;
  x: number;
  y: number;
  evidenceIds: string[];
  reviewer: string;
};
type Verification = {
  id: string;
  reportId: string;
  decision: string;
  reviewer: string;
  time?: string;
  note?: string;
};
type Task = {
  id: string;
  title: string;
  owner: string;
  status: string;
  priority: string;
  startAt: string;
  dueAt: string;
  progress: number;
  dependencyIds: string[];
  sop: string[];
  evidenceIds: string[];
};
type Resource = {
  id: string;
  name: string;
  type: string;
  quantity: number;
  available: number;
  status: string;
  assignedTaskId: string;
  x: number;
  y: number;
};
type Team = {
  id: string;
  name: string;
  leader: string;
  members: number;
  status: string;
  capabilities: string[];
  x: number;
  y: number;
};
type Shelter = {
  id: string;
  name: string;
  capacity: number;
  occupancy: number;
  status: string;
  x: number;
  y: number;
};
type Decision = {
  id: string;
  title: string;
  option: string;
  status: string;
  decider: string;
  approvers: string[];
  time: string;
  reason: string;
  evidenceIds: string[];
  impact: string;
};
type Communication = {
  id: string;
  channel: string;
  audience: string;
  subject: string;
  status: string;
  time: string;
  sender: string;
};
type Shift = {
  id: string;
  name: string;
  leader: string;
  startAt: string;
  endAt: string;
  status: string;
  handoverNote: string;
  acceptedBy: string;
};
type ConsoleState = {
  id: string;
  name: string;
  version: number;
  selectedReportId: string;
  selectedTaskId: string;
  selectedDecisionId: string;
  incident: {
    id: string;
    code: string;
    title: string;
    category: string;
    level: string;
    status: string;
    commander: string;
    location: string;
    startedAt: string;
    summary: string;
    objectives: string[];
    sensitiveFields: string[];
  };
  reports: Report[];
  verifications: Verification[];
  mapLayers: Array<Record<string, unknown>>;
  mapZones: Array<{
    id: string;
    name: string;
    level: string;
    points: number[][];
  }>;
  resources: Resource[];
  teams: Team[];
  shelters: Shelter[];
  tasks: Task[];
  dependencies: Array<{ source: string; target: string }>;
  decisions: Decision[];
  communications: Communication[];
  shifts: Shift[];
  situationReports: Array<{
    id: string;
    version: number;
    title: string;
    status: string;
    time: string;
    author: string;
    approvers: string[];
    evidenceIds: string[];
    summary: string;
  }>;
  afterActionReviews: Array<Record<string, unknown>>;
  roles: Array<{ role: string; permissions: string[] }>;
  audit: Array<{
    id: string;
    time: string;
    action: string;
    actor: string;
    target: string;
    detail: string;
  }>;
  createdAt: string;
  updatedAt: string;
};
type EmergencyResult = {
  schema: 'skyview-emergency-console-results';
  version: number;
  stage: string;
  console: ConsoleState;
  analysis: {
    metrics: {
      verifiedReports: number;
      totalReports: number;
      openTasks: number;
      blockedTasks: number;
      resourceAvailability: number;
      deployedTeams: number;
      pendingDecisions: number;
      shelterOccupancy: number;
    };
    taskStatusCounts: Record<string, number>;
    timeline: Array<{
      id: string;
      time: string;
      kind: string;
      title: string;
      status: string;
    }>;
    riskMatrix: Array<{
      name: string;
      likelihood: number;
      impact: number;
      score: number;
      control: string;
    }>;
    dependencyGraph: {
      nodes: Array<{
        id: string;
        title: string;
        status: string;
        priority: string;
      }>;
      edges: Array<{ source: string; target: string }>;
    };
    mapItems: {
      reports: Array<Record<string, unknown>>;
      teams: Array<Record<string, unknown>>;
      resources: Array<Record<string, unknown>>;
      shelters: Array<Record<string, unknown>>;
    };
    qualityChecks: Array<{ label: string; passed: boolean }>;
  };
  runtime: {
    controlPlane: Record<string, string>;
    analysis: Record<string, string>;
    mapService: Record<string, string>;
    weather: Record<string, string>;
    organizationDirectory: Record<string, string>;
    communications: Record<string, string>;
    supportedImports: string[];
    supportedExports: string[];
    arbitraryCodeExecution: boolean;
  };
  exports: {
    reportMarkdown: string;
    tasksCsv: string;
    resourcesCsv: string;
    auditCsv: string;
    geoJson: string;
    capXml: string;
    backupJson: string;
    packageBase64: string;
  };
  importSummary?: {
    accepted: number;
    rejected: number;
    violations: Array<{ line: number; reason: string }>;
  };
};

const views = [
  ['situation', '态势总览', 'Situation'],
  ['verification', '线索核验', 'Verification'],
  ['dispatch', '任务调度', 'Dispatch'],
  ['resources', '资源与通信', 'Resources'],
  ['decisions', '决策交接', 'Decisions'],
] as const;
const terminal = new Set(['succeeded', 'failed', 'canceled']);
const wait = (milliseconds: number) =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));
const statusLabel: Record<string, string> = {
  active: '处置中',
  verified: '已核验',
  unverified: '待核验',
  review: '复核中',
  rejected: '已排除',
  todo: '待开始',
  doing: '进行中',
  blocked: '受阻',
  done: '已完成',
  approved: '已批准',
  pending: '待决策',
  deployed: '已出动',
  operating: '值守中',
  available: '可用',
  standby: '待命',
  delivered: '已送达',
  acknowledged: '已确认',
  recorded: '已记录',
  prepared: '待接入',
  published: '已发布',
  open: '开放',
  scheduled: '待接班',
  'handed-over': '已交接',
};
const reportTypeLabel: Record<string, string> = {
  sensor: '传感器',
  uav: '无人机',
  field: '现场上报',
  public: '公众线索',
};
const channelLabel: Record<string, string> = {
  'in-app': '站内通知',
  radio: '无线电',
  sms: '短信',
  email: '邮件',
};
const percent = (value: number) => `${Math.round(value * 100)}%`;

async function waitForJob(id: string): Promise<WorkbenchJob | null> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const job = await toolApi.getJob(id);
    if (terminal.has(job.status)) return job;
    await wait(750);
  }
  return null;
}

function sampleResult(): EmergencyResult {
  const reports: Report[] = [
    {
      id: 'report-001',
      source: 'GNSS 监测',
      type: 'sensor',
      title: '位移速率持续升高',
      content: '北坡 G12 点位移速率达到 6.8 mm/h。',
      time: '2026-09-10T07:48:00Z',
      status: 'verified',
      confidence: 0.98,
      x: 63,
      y: 31,
      evidenceIds: ['ev-gnss-12'],
      reviewer: '张审核',
    },
    {
      id: 'report-002',
      source: '无人机巡检',
      type: 'uav',
      title: '坡肩发现新增裂缝',
      content: '正射影像显示约 18 m 连续裂缝，宽度 4–12 cm。',
      time: '2026-09-10T08:06:00Z',
      status: 'verified',
      confidence: 0.92,
      x: 58,
      y: 26,
      evidenceIds: ['ev-uav-44', 'ev-uav-45'],
      reviewer: '陈审核',
    },
    {
      id: 'report-003',
      source: '现场二组',
      type: 'field',
      title: '排水沟局部堵塞',
      content: '坡脚西段排水沟存在淤堵，积水深约 12 cm。',
      time: '2026-09-10T08:22:00Z',
      status: 'review',
      confidence: 0.81,
      x: 46,
      y: 68,
      evidenceIds: ['ev-photo-208'],
      reviewer: '',
    },
    {
      id: 'report-004',
      source: '雨量站 R3',
      type: 'sensor',
      title: '1 小时雨量超过阈值',
      content: '过去一小时累计降雨 72 mm。',
      time: '2026-09-10T08:31:00Z',
      status: 'verified',
      confidence: 0.99,
      x: 75,
      y: 48,
      evidenceIds: ['ev-rain-r3'],
      reviewer: '系统规则+王值守',
    },
    {
      id: 'report-005',
      source: '公众热线',
      type: 'public',
      title: '北侧道路落石线索',
      content: '来电称北侧便道有小块落石，尚未完成位置核验。',
      time: '2026-09-10T08:43:00Z',
      status: 'unverified',
      confidence: 0.42,
      x: 31,
      y: 54,
      evidenceIds: ['ev-call-019'],
      reviewer: '',
    },
  ];
  const tasks: Task[] = [
    ['task-001', '封控北侧便道入口', '现场一组', 'done', 'critical', 100, []],
    [
      'task-002',
      '撤离核心警戒区人员',
      '现场一组',
      'done',
      'critical',
      100,
      ['task-001'],
    ],
    [
      'task-003',
      '无人机复飞裂缝区域',
      '无人机组',
      'doing',
      'high',
      65,
      ['task-001'],
    ],
    [
      'task-004',
      '疏通坡脚排水沟',
      '现场二组',
      'doing',
      'high',
      40,
      ['task-001'],
    ],
    ['task-005', '复核公众落石线索', '信息核验组', 'todo', 'medium', 0, []],
    ['task-006', '部署夜间照明与备用电源', '保障组', 'todo', 'medium', 0, []],
    [
      'task-007',
      '发布第 2 号态势通报',
      '信息核验组',
      'blocked',
      'high',
      20,
      ['task-003', 'task-004'],
    ],
    [
      'task-008',
      '准备下一班次交接',
      '现场指挥组',
      'todo',
      'medium',
      0,
      ['task-007'],
    ],
  ].map(([id, title, owner, status, priority, progress, dependencyIds]) => ({
    id: String(id),
    title: String(title),
    owner: String(owner),
    status: String(status),
    priority: String(priority),
    startAt: '2026-09-10T08:00:00Z',
    dueAt: '2026-09-10T10:00:00Z',
    progress: Number(progress),
    dependencyIds: dependencyIds as string[],
    sop: ['确认安全条件', '执行并记录', '复核后反馈'],
    evidenceIds: [],
  }));
  const resources: Resource[] = [
    {
      id: 'res-001',
      name: '四驱指挥车',
      type: '车辆',
      quantity: 2,
      available: 1,
      status: 'deployed',
      assignedTaskId: 'task-001',
      x: 23,
      y: 78,
    },
    {
      id: 'res-002',
      name: '无人机 M350',
      type: '航空器',
      quantity: 2,
      available: 1,
      status: 'deployed',
      assignedTaskId: 'task-003',
      x: 38,
      y: 76,
    },
    {
      id: 'res-003',
      name: '挖掘机',
      type: '工程机械',
      quantity: 3,
      available: 2,
      status: 'standby',
      assignedTaskId: '',
      x: 17,
      y: 63,
    },
    {
      id: 'res-004',
      name: '医疗急救包',
      type: '医疗',
      quantity: 12,
      available: 9,
      status: 'available',
      assignedTaskId: '',
      x: 15,
      y: 85,
    },
    {
      id: 'res-005',
      name: '便携照明组',
      type: '保障',
      quantity: 8,
      available: 4,
      status: 'available',
      assignedTaskId: 'task-006',
      x: 28,
      y: 82,
    },
  ];
  const teams: Team[] = [
    {
      id: 'team-command',
      name: '现场指挥组',
      leader: '李指挥',
      members: 5,
      status: 'operating',
      capabilities: ['指挥', '决策'],
      x: 21,
      y: 80,
    },
    {
      id: 'team-field-a',
      name: '现场一组',
      leader: '赵队长',
      members: 8,
      status: 'deployed',
      capabilities: ['警戒', '疏散'],
      x: 38,
      y: 58,
    },
    {
      id: 'team-field-b',
      name: '现场二组',
      leader: '钱队长',
      members: 6,
      status: 'deployed',
      capabilities: ['排水', '工程处置'],
      x: 46,
      y: 68,
    },
    {
      id: 'team-info',
      name: '信息核验组',
      leader: '张审核',
      members: 4,
      status: 'operating',
      capabilities: ['核验', '态势图'],
      x: 25,
      y: 82,
    },
  ];
  const shelters: Shelter[] = [
    {
      id: 'shelter-001',
      name: '南侧临时安置点',
      capacity: 180,
      occupancy: 74,
      status: 'open',
      x: 12,
      y: 89,
    },
    {
      id: 'shelter-002',
      name: '综合楼集合点',
      capacity: 120,
      occupancy: 42,
      status: 'open',
      x: 20,
      y: 90,
    },
  ];
  const decisions: Decision[] = [
    {
      id: 'decision-001',
      title: '启动红色响应',
      option: '立即启动',
      status: 'approved',
      decider: '李指挥',
      approvers: ['李指挥', '王值班长'],
      time: '2026-09-10T07:56:00Z',
      reason: '多源指标超过红色阈值并呈持续加速',
      evidenceIds: ['report-001', 'report-004'],
      impact: '封控、撤离、提高监测频率',
    },
    {
      id: 'decision-002',
      title: '扩大核心警戒区',
      option: '向西扩展 120 m',
      status: 'approved',
      decider: '李指挥',
      approvers: ['李指挥', '安全总监'],
      time: '2026-09-10T08:18:00Z',
      reason: '新增坡肩裂缝与形变方向一致',
      evidenceIds: ['report-001', 'report-002'],
      impact: '增加 2 个封控点',
    },
    {
      id: 'decision-003',
      title: '是否启用工程卸载',
      option: '等待排水与复飞结果',
      status: 'pending',
      decider: '待审批',
      approvers: [],
      time: '2026-09-10T08:46:00Z',
      reason: '需要确认地下水响应与裂缝延伸范围',
      evidenceIds: ['report-002', 'report-003'],
      impact: '影响后续机械资源调度',
    },
  ];
  const communications: Communication[] = [
    ['comm-001', 'in-app', '全体应急成员', '启动红色响应', 'delivered'],
    ['comm-002', 'radio', '现场一组', '封控与撤离指令', 'acknowledged'],
    ['comm-003', 'in-app', '信息核验组', '核验无人机裂缝影像', 'delivered'],
    ['comm-004', 'sms', '外部协作单位', '待接入短信网关后发送', 'prepared'],
    ['comm-005', 'email', '监管只读组', '第 1 号态势通报待分发', 'prepared'],
    ['comm-006', 'radio', '现场二组', '确认排水沟处置进度', 'acknowledged'],
  ].map(([id, channel, audience, subject, status], index) => ({
    id,
    channel,
    audience,
    subject,
    status,
    time: `2026-09-10T08:${String(index * 8).padStart(2, '0')}:00Z`,
    sender: '现场指挥组',
  }));
  const console: ConsoleState = {
    id: 'incident-console-north-slope',
    name: '北岭矿区边坡应急协同',
    version: 7,
    selectedReportId: 'report-003',
    selectedTaskId: 'task-004',
    selectedDecisionId: 'decision-003',
    incident: {
      id: 'incident-20260910-001',
      code: 'INC-20260910-001',
      title: '北侧边坡多源异常事件',
      category: '地质灾害',
      level: 'red',
      status: 'active',
      commander: '李指挥',
      location: '北岭矿区北侧边坡',
      startedAt: '2026-09-10T07:48:00Z',
      summary:
        '连续降雨后 GNSS 位移、孔压与微震指标同步升高，已划定警戒区并组织现场复核。',
      objectives: [
        '确保人员撤离危险区',
        '核实边坡变形范围',
        '保持矿区应急通道畅通',
      ],
      sensitiveFields: ['人员联系方式', '精确集合点坐标'],
    },
    reports,
    verifications: [
      {
        id: 'verify-001',
        reportId: 'report-001',
        decision: 'verified',
        reviewer: '张审核',
      },
    ],
    mapLayers: [
      { id: 'layer-base', name: '矿区基础图', status: 'sample-metadata' },
      { id: 'layer-hazard', name: '危险区', status: 'available' },
      { id: 'layer-route', name: '疏散路线', status: 'available' },
    ],
    mapZones: [
      {
        id: 'zone-red',
        name: '核心警戒区',
        level: 'red',
        points: [
          [48, 22],
          [72, 22],
          [80, 50],
          [66, 72],
          [40, 61],
        ],
      },
      {
        id: 'zone-amber',
        name: '外围管控区',
        level: 'amber',
        points: [
          [33, 13],
          [83, 14],
          [92, 62],
          [73, 84],
          [25, 70],
        ],
      },
    ],
    resources,
    teams,
    shelters,
    tasks,
    dependencies: [
      { source: 'task-001', target: 'task-002' },
      { source: 'task-001', target: 'task-003' },
      { source: 'task-001', target: 'task-004' },
      { source: 'task-003', target: 'task-007' },
      { source: 'task-004', target: 'task-007' },
      { source: 'task-007', target: 'task-008' },
    ],
    decisions,
    communications,
    shifts: [
      {
        id: 'shift-day',
        name: '白班',
        leader: '王值班长',
        startAt: '2026-09-10T08:00:00Z',
        endAt: '2026-09-10T16:00:00Z',
        status: 'active',
        handoverNote: '重点跟踪裂缝复飞、排水效果与工程卸载决策。',
        acceptedBy: '',
      },
      {
        id: 'shift-night',
        name: '夜班',
        leader: '周值班长',
        startAt: '2026-09-10T16:00:00Z',
        endAt: '2026-09-11T00:00:00Z',
        status: 'scheduled',
        handoverNote: '',
        acceptedBy: '',
      },
    ],
    situationReports: [
      {
        id: 'sitrep-001',
        version: 1,
        title: '北侧边坡事件第 1 号态势通报',
        status: 'published',
        time: '2026-09-10T08:35:00Z',
        author: '信息核验组',
        approvers: ['王值班长', '李指挥'],
        evidenceIds: ['report-001', 'report-002', 'report-004'],
        summary: '完成封控和人员撤离，现场处置持续进行。',
      },
    ],
    afterActionReviews: [],
    roles: [
      { role: '指挥员', permissions: ['incident:*', 'decision:approve'] },
      { role: '值班员', permissions: ['task:*', 'sitrep:create'] },
      { role: '现场队伍', permissions: ['task:update', 'report:create'] },
      { role: '信息审核', permissions: ['report:verify'] },
      { role: '外部协作', permissions: ['assigned-task:read'] },
      { role: '监管只读', permissions: ['approved-record:read'] },
    ],
    audit: [
      {
        id: 'audit-seed',
        time: '2026-09-10T08:35:00Z',
        action: 'publish-situation-report',
        actor: '信息核验组',
        target: 'sitrep-001',
        detail: '双人批准后发布第 1 号态势通报',
      },
    ],
    createdAt: '2026-09-10T07:48:00Z',
    updatedAt: '2026-09-10T08:50:00Z',
  };
  const timeline = [
    ...reports.map((item) => ({
      id: item.id,
      time: item.time,
      kind: 'report',
      title: item.title,
      status: item.status,
    })),
    ...decisions.map((item) => ({
      id: item.id,
      time: item.time,
      kind: 'decision',
      title: item.title,
      status: item.status,
    })),
    ...communications.map((item) => ({
      id: item.id,
      time: item.time,
      kind: 'communication',
      title: item.subject,
      status: item.status,
    })),
  ].sort((a, b) => b.time.localeCompare(a.time));
  return {
    schema: 'skyview-emergency-console-results',
    version: 2,
    stage: 'load-sample',
    console,
    analysis: {
      metrics: {
        verifiedReports: 3,
        totalReports: 5,
        openTasks: 6,
        blockedTasks: 1,
        resourceAvailability: 56,
        deployedTeams: 2,
        pendingDecisions: 1,
        shelterOccupancy: 116,
      },
      taskStatusCounts: { todo: 3, doing: 2, blocked: 1, done: 2 },
      timeline,
      riskMatrix: [
        {
          name: '边坡失稳',
          likelihood: 4,
          impact: 5,
          score: 20,
          control: '封控、撤离、连续监测',
        },
        {
          name: '道路落石',
          likelihood: 3,
          impact: 3,
          score: 9,
          control: '巡查与交通管制',
        },
        {
          name: '排水失效',
          likelihood: 4,
          impact: 4,
          score: 16,
          control: '截流、清淤、复测',
        },
        {
          name: '通信中断',
          likelihood: 2,
          impact: 4,
          score: 8,
          control: '无线电与人工传令备份',
        },
      ],
      dependencyGraph: {
        nodes: tasks.map((item) => ({
          id: item.id,
          title: item.title,
          status: item.status,
          priority: item.priority,
        })),
        edges: console.dependencies,
      },
      mapItems: { reports, teams, resources, shelters },
      qualityChecks: [
        { label: '活动事件已指定指挥员', passed: true },
        { label: '高优先级任务均有责任人', passed: true },
        { label: '已批准决策均关联证据', passed: true },
        { label: '态势通报保留批准人', passed: true },
        { label: '外部通信未伪装为已发送', passed: true },
        { label: '敏感字段已声明字段级授权', passed: true },
      ],
    },
    runtime: {
      controlPlane: {
        status: 'enabled',
        engine: 'Go jobs / projects / versions / audit',
      },
      analysis: {
        status: 'enabled',
        engine: 'Python deterministic incident analysis',
      },
      mapService: {
        status: 'sample-metadata',
        engine: 'MapLibre/OpenLayers adapter',
      },
      weather: { status: 'not-configured', engine: 'weather adapter' },
      organizationDirectory: {
        status: 'not-configured',
        engine: 'organization directory adapter',
      },
      communications: {
        inApp: 'enabled',
        radio: 'record-only',
        sms: 'not-configured',
        email: 'not-configured',
      },
      supportedImports: ['CAP', 'GeoJSON', 'KML', 'CSV', 'JSON'],
      supportedExports: [
        'CAP',
        'GeoJSON',
        'KML',
        'CSV',
        'Markdown',
        'JSON',
        'ZIP',
      ],
      arbitraryCodeExecution: false,
    },
    exports: {
      reportMarkdown: '# 应急态势报告',
      tasksCsv: '任务ID,标题,责任人\n',
      resourcesCsv: '资源ID,名称,类型\n',
      auditCsv: '审计ID,时间,动作\n',
      geoJson: '{"type":"FeatureCollection","features":[]}',
      capXml: '<?xml version="1.0"?><alert/>',
      backupJson: '{}',
      packageBase64: '',
    },
  };
}

function downloadText(
  content: string,
  fileName: string,
  type = 'text/plain;charset=utf-8',
) {
  const url = URL.createObjectURL(new Blob(['\ufeff', content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
function downloadBase64(content: string, fileName: string) {
  const bytes = Uint8Array.from(atob(content), (character) =>
    character.charCodeAt(0),
  );
  const url = URL.createObjectURL(
    new Blob([bytes], { type: 'application/zip' }),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function SituationMap({
  result,
  selectedReportId,
  onSelect,
}: {
  result: EmergencyResult;
  selectedReportId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <svg
      className="emergencyx-map"
      viewBox="0 0 900 500"
      aria-label="事件态势地图"
    >
      <title>事件态势地图</title>
      <defs>
        <pattern
          id="emergency-grid"
          width="45"
          height="45"
          patternUnits="userSpaceOnUse"
        >
          <path d="M45 0H0V45" />
        </pattern>
      </defs>
      <rect className="base" width="900" height="500" />
      <rect width="900" height="500" fill="url(#emergency-grid)" />
      <path
        className="terrain"
        d="M15 345C118 280 145 160 252 205S402 360 520 230 704 85 885 170"
      />
      <path
        className="route"
        d="M78 449C164 390 218 348 337 330S520 375 730 440"
      />
      {result.console.mapZones
        .slice()
        .reverse()
        .map((zone) => (
          <polygon
            key={zone.id}
            className={`zone ${zone.level}`}
            points={zone.points.map(([x, y]) => `${x * 9},${y * 5}`).join(' ')}
          />
        ))}
      {result.console.reports.map((item) => (
        <a
          key={item.id}
          className={`report ${item.status} ${item.id === selectedReportId ? 'active' : ''}`}
          href={`#${item.id}`}
          aria-label={`${item.title}，${statusLabel[item.status] ?? item.status}`}
          onClick={(event) => {
            event.preventDefault();
            onSelect(item.id);
          }}
        >
          <g transform={`translate(${item.x * 9} ${item.y * 5})`}>
            <circle r={item.id === selectedReportId ? 13 : 9} />
            <text y="-16">{item.title.slice(0, 9)}</text>
          </g>
        </a>
      ))}
      {result.console.teams.map((item) => (
        <g
          key={item.id}
          className="team"
          transform={`translate(${item.x * 9} ${item.y * 5})`}
        >
          <rect x="-9" y="-9" width="18" height="18" rx="4" />
          <text x="14" y="4">
            {item.name}
          </text>
        </g>
      ))}
      {result.console.shelters.map((item) => (
        <g
          key={item.id}
          className="shelter"
          transform={`translate(${item.x * 9} ${item.y * 5})`}
        >
          <path d="M-11 2L0-10 11 2V11H-11Z" />
          <text x="15" y="5">
            {item.name}
          </text>
        </g>
      ))}
    </svg>
  );
}

function DependencyGraph({ result }: { result: EmergencyResult }) {
  const columns = [
    ['task-001'],
    ['task-002', 'task-003', 'task-004'],
    ['task-005', 'task-006', 'task-007'],
    ['task-008'],
  ];
  const positions = new Map<string, { x: number; y: number }>();
  columns.forEach((ids, column) =>
    ids.forEach((id, row) =>
      positions.set(id, { x: 80 + column * 230, y: 85 + row * 105 }),
    ),
  );
  return (
    <svg
      className="emergencyx-dependency"
      viewBox="0 0 820 350"
      aria-label="任务依赖图"
    >
      <title>任务依赖图</title>
      <defs>
        <marker
          id="arrow-emergency"
          markerWidth="8"
          markerHeight="8"
          refX="7"
          refY="4"
          orient="auto"
        >
          <path d="M0 0L8 4 0 8Z" />
        </marker>
      </defs>
      {result.console.dependencies.map((edge) => {
        const left = positions.get(edge.source);
        const right = positions.get(edge.target);
        return left && right ? (
          <path
            key={`${edge.source}-${edge.target}`}
            d={`M${left.x + 70} ${left.y}C${left.x + 135} ${left.y},${right.x - 120} ${right.y},${right.x - 70} ${right.y}`}
            markerEnd="url(#arrow-emergency)"
          />
        ) : null;
      })}
      {result.console.tasks.map((task) => {
        const point = positions.get(task.id);
        return point ? (
          <g
            key={task.id}
            transform={`translate(${point.x} ${point.y})`}
            className={task.status}
          >
            <rect x="-70" y="-31" width="140" height="62" rx="12" />
            <text y="-5">{task.id.replace('task-', 'T')}</text>
            <text y="14">{task.title.slice(0, 10)}</text>
          </g>
        ) : null;
      })}
    </svg>
  );
}

export function EmergencyConsoleWorkbench({
  executionAllowed = true,
}: {
  executionAllowed?: boolean;
}) {
  const { text } = useLanguage();
  const [view, setView] = useState<(typeof views)[number][0]>('situation');
  const [result, setResult] = useState<EmergencyResult>(() => sampleResult());
  const [projects, setProjects] = useState<WorkbenchProject[]>([]);
  const [projectId, setProjectId] = useState('');
  const [projectTitle, setProjectTitle] = useState('北岭矿区边坡应急协同');
  const [actor, setActor] = useState('当前值班员');
  const [selectedReportId, setSelectedReportId] = useState('report-003');
  const [selectedTaskId, setSelectedTaskId] = useState('task-004');
  const [selectedDecisionId, setSelectedDecisionId] = useState('decision-003');
  const [taskOwner, setTaskOwner] = useState('现场二组');
  const [communicationSubject, setCommunicationSubject] = useState(
    '请现场二组在 10 分钟内回报排水处置进度。',
  );
  const [communicationChannel, setCommunicationChannel] = useState('in-app');
  const [handoverNote, setHandoverNote] = useState(
    '重点跟踪裂缝复飞、排水效果与工程卸载决策。',
  );
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const importInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    toolApi
      .listProjects('emergency-console')
      .then((items) => {
        if (!active) return;
        setProjects(items);
        const project = items[0];
        const saved = project?.state.emergencyConsole as
          | { result?: EmergencyResult }
          | undefined;
        if (
          project &&
          saved?.result?.schema === 'skyview-emergency-console-results'
        ) {
          setProjectId(project.id);
          setProjectTitle(project.title);
          setResult(saved.result);
          setSelectedReportId(saved.result.console.selectedReportId);
          setSelectedTaskId(saved.result.console.selectedTaskId);
          setSelectedDecisionId(saved.result.console.selectedDecisionId);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  const projectState = (next = result) => ({
    emergencyConsole: { result: next },
  });
  const ensureProject = async () => {
    const existing = projects.find((item) => item.id === projectId);
    if (existing) return existing;
    const created = await toolApi.createProject(
      'emergency-console',
      projectTitle,
      projectState(),
    );
    setProjects((items) => [created, ...items]);
    setProjectId(created.id);
    return created;
  };
  const storeResult = async (
    project: WorkbenchProject,
    output: EmergencyResult,
  ) => {
    setResult(output);
    const saved = await toolApi.updateProject(
      project.id,
      projectTitle,
      projectState(output),
    );
    setProjects((items) => [
      saved,
      ...items.filter((item) => item.id !== saved.id),
    ]);
  };
  const execute = async (
    action: string,
    extra: Record<string, unknown> = {},
  ) => {
    if (!executionAllowed) {
      setError(
        text('应急研判服务当前不可用', 'Emergency service is unavailable'),
      );
      return null;
    }
    setRunning(true);
    setError('');
    setMessage(
      text(
        'Go 已登记作业，Python 正在更新态势、任务、证据和审计…',
        'Job registered; situation, tasks, evidence and audit are updating…',
      ),
    );
    try {
      const project = await ensureProject();
      const created = await toolApi.createJob(
        project.id,
        'emergency-console',
        action,
        { state: result, actor, ...extra },
        crypto.randomUUID(),
      );
      const job = await waitForJob(created.job.id);
      if (!job)
        throw new Error(
          text('作业仍在后台运行。', 'The job is still running.'),
        );
      if (job.status === 'failed')
        throw new Error(
          job.error || text('应急作业失败。', 'Emergency job failed.'),
        );
      if (job.status === 'canceled')
        throw new Error(text('作业已取消。', 'Job canceled.'));
      const output = job.result as EmergencyResult;
      if (output.schema !== 'skyview-emergency-console-results')
        throw new Error(
          text('服务端结果不兼容。', 'Incompatible service result.'),
        );
      await storeResult(project, output);
      setSelectedReportId(output.console.selectedReportId);
      setSelectedTaskId(output.console.selectedTaskId);
      setSelectedDecisionId(output.console.selectedDecisionId);
      setMessage(
        text(
          '态势、任务、决策、通信和审计已更新。',
          'Situation, tasks, decisions, communication and audit updated.',
        ),
      );
      return output;
    } catch (caught) {
      setError(
        caught instanceof ApiError || caught instanceof Error
          ? caught.message
          : text('操作失败。', 'Operation failed.'),
      );
      setMessage('');
      return null;
    } finally {
      setRunning(false);
    }
  };
  const saveProject = async () => {
    setSaving(true);
    setError('');
    try {
      const existing = projects.find((item) => item.id === projectId);
      const saved = existing
        ? await toolApi.updateProject(existing.id, projectTitle, projectState())
        : await toolApi.createProject(
            'emergency-console',
            projectTitle,
            projectState(),
          );
      setProjects((items) => [
        saved,
        ...items.filter((item) => item.id !== saved.id),
      ]);
      setProjectId(saved.id);
      setMessage(text('应急项目已保存。', 'Emergency project saved.'));
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : text('保存失败。', 'Save failed.'),
      );
    } finally {
      setSaving(false);
    }
  };
  const createVersion = async () => {
    try {
      const project = await ensureProject();
      await toolApi.createVersion(
        project.id,
        `应急研判 v${result.console.version} · ${new Date().toLocaleString('zh-CN')}`,
        projectState(),
      );
      setMessage(text('已创建不可变版本。', 'Immutable version created.'));
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : text('版本创建失败。', 'Version failed.'),
      );
    }
  };
  const importReports = async (file?: File) => {
    if (!file) return;
    if (file.size > 4_000_000) {
      setError(text('线索文件不能超过 4 MB。', 'File must not exceed 4 MB.'));
      return;
    }
    await execute('import-reports', {
      fileName: file.name,
      content: await file.text(),
    });
    if (importInput.current) importInput.current.value = '';
  };
  const selectProject = (id: string) => {
    setProjectId(id);
    const project = projects.find((item) => item.id === id);
    if (!project) {
      setProjectTitle('北岭矿区边坡应急协同');
      setResult(sampleResult());
      return;
    }
    const saved = project.state.emergencyConsole as
      | { result?: EmergencyResult }
      | undefined;
    if (saved?.result?.schema === 'skyview-emergency-console-results') {
      setResult(saved.result);
      setProjectTitle(project.title);
    }
  };

  const report =
    result.console.reports.find((item) => item.id === selectedReportId) ??
    result.console.reports[0];
  const task =
    result.console.tasks.find((item) => item.id === selectedTaskId) ??
    result.console.tasks[0];
  const decision =
    result.console.decisions.find((item) => item.id === selectedDecisionId) ??
    result.console.decisions[0];
  const reportsByStatus = useMemo(
    () => ({
      verified: result.console.reports.filter(
        (item) => item.status === 'verified',
      ).length,
      pending: result.console.reports.filter(
        (item) => item.status !== 'verified' && item.status !== 'rejected',
      ).length,
    }),
    [result.console.reports],
  );
  const riskLevel = (score: number) =>
    score >= 16 ? 'critical' : score >= 9 ? 'high' : 'medium';
  const runtimeCommunicationLabel: Record<string, [string, string]> = {
    inApp: ['站内通知', 'In-app'],
    radio: ['无线电', 'Radio'],
    sms: ['短信', 'SMS'],
    email: ['邮件', 'Email'],
  };
  const runtimeStateLabel: Record<string, [string, string]> = {
    enabled: ['已启用', 'Enabled'],
    'record-only': ['仅记录', 'Record only'],
    'not-configured': ['未配置', 'Not configured'],
  };

  return (
    <div className="emergencyx-workbench">
      <header className="emergencyx-commandbar">
        <div className="emergencyx-project">
          <Siren />
          <NativeSelect
            aria-label={text('选择应急项目', 'Select project')}
            value={projectId}
            onChange={(event) => selectProject(event.target.value)}
          >
            <NativeSelectOption value="">
              {text('当前本地项目', 'Current local project')}
            </NativeSelectOption>
            {projects.map((projectItem) => (
              <NativeSelectOption key={projectItem.id} value={projectItem.id}>
                {projectItem.title}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Input
            aria-label={text('项目名称', 'Project name')}
            value={projectTitle}
            onChange={(event) => setProjectTitle(event.target.value)}
          />
          <span className="emergencyx-level">
            {text('红色响应', 'Red response')}
          </span>
        </div>
        <div className="emergencyx-actions">
          <input
            ref={importInput}
            hidden
            type="file"
            accept=".csv,.json,text/csv,application/json"
            onChange={(event) => void importReports(event.target.files?.[0])}
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() => importInput.current?.click()}
          >
            <FileInput />
            {text('导入线索', 'Import')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={saving}
            onClick={() => void saveProject()}
          >
            {saving ? <LoaderCircle className="spin" /> : <Save />}
            {text('保存', 'Save')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void createVersion()}
          >
            <Archive />
            {text('版本', 'Version')}
          </Button>
          <Button
            size="sm"
            disabled={running}
            onClick={() => void execute('validate')}
          >
            {running ? <LoaderCircle className="spin" /> : <ShieldCheck />}
            {text('刷新态势', 'Refresh')}
          </Button>
        </div>
      </header>
      <section className="emergencyx-kpis">
        <article className="danger">
          <BadgeAlert />
          <span>{text('事件响应', 'Incident')}</span>
          <strong>{text('红色', 'Red')}</strong>
          <em>
            {result.console.incident.status === 'active'
              ? text('处置中', 'Active')
              : result.console.incident.status}
          </em>
        </article>
        <article>
          <ClipboardCheck />
          <span>{text('核验线索', 'Verified reports')}</span>
          <strong>
            {result.analysis.metrics.verifiedReports}
            <small>/{result.analysis.metrics.totalReports}</small>
          </strong>
          <em>
            {reportsByStatus.pending} {text('条待核验', 'pending')}
          </em>
        </article>
        <article>
          <Activity />
          <span>{text('未结任务', 'Open tasks')}</span>
          <strong>{result.analysis.metrics.openTasks}</strong>
          <em>
            {result.analysis.metrics.blockedTasks} {text('项受阻', 'blocked')}
          </em>
        </article>
        <article>
          <Warehouse />
          <span>{text('资源可用', 'Resources')}</span>
          <strong>
            {result.analysis.metrics.resourceAvailability}
            <small>%</small>
          </strong>
          <em>
            {result.analysis.metrics.deployedTeams}{' '}
            {text('支队伍出动', 'teams deployed')}
          </em>
        </article>
        <article>
          <Users />
          <span>{text('安置人数', 'Sheltered')}</span>
          <strong>{result.analysis.metrics.shelterOccupancy}</strong>
          <em>
            {result.console.shelters.length} {text('个安置点', 'shelters')}
          </em>
        </article>
        <article>
          <GitBranch />
          <span>{text('待决策', 'Pending decisions')}</span>
          <strong>{result.analysis.metrics.pendingDecisions}</strong>
          <em>
            {result.console.decisions.length} {text('条决策记录', 'decisions')}
          </em>
        </article>
      </section>
      <Tabs
        value={view}
        onValueChange={(value) => setView(value as typeof view)}
        className="emergencyx-tabs-shell"
      >
        <TabsList className="emergencyx-tabs" variant="line">
          {views.map(([id, zh, en], index) => (
            <TabsTrigger key={id} value={id}>
              <b>{String(index + 1).padStart(2, '0')}</b>
              {text(zh, en)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {(message || error) && (
        <div className={`emergencyx-status ${error ? 'error' : ''}`}>
          {error ? <CircleAlert /> : <CheckCircle2 />}
          <span>{error || message}</span>
          <button
            aria-label={text('关闭状态', 'Dismiss')}
            onClick={() => {
              setMessage('');
              setError('');
            }}
          >
            <X />
          </button>
        </div>
      )}
      <main className="emergencyx-stage">
        {view === 'situation' && (
          <div className="emergencyx-view emergencyx-situation-view">
            <section className="emergencyx-surface emergencyx-map-card">
              <header>
                <MapPinned />
                <div>
                  <span>{text('事件态势图', 'Situation map')}</span>
                  <strong>{result.console.incident.location}</strong>
                </div>
                <em>
                  {result.console.mapLayers.length} {text('个图层', 'layers')}
                </em>
              </header>
              <SituationMap
                result={result}
                selectedReportId={report.id}
                onSelect={(id) => {
                  setSelectedReportId(id);
                  setView('verification');
                }}
              />
              <footer>
                <span>
                  <i className="red" />
                  {text('核心警戒区', 'Exclusion zone')}
                </span>
                <span>
                  <i className="amber" />
                  {text('外围管控区', 'Control zone')}
                </span>
                <span>
                  <i className="report" />
                  {text('线索', 'Report')}
                </span>
                <span>
                  <i className="team" />
                  {text('队伍', 'Team')}
                </span>
                <span>
                  <i className="shelter" />
                  {text('安置点', 'Shelter')}
                </span>
              </footer>
            </section>
            <aside className="emergencyx-surface emergencyx-incident-card">
              <header>
                <Siren />
                <div>
                  <span>{result.console.incident.code}</span>
                  <strong>{result.console.incident.title}</strong>
                </div>
                <em>{statusLabel[result.console.incident.status]}</em>
              </header>
              <p>{result.console.incident.summary}</p>
              <div className="emergencyx-facts">
                <p>
                  <span>{text('指挥员', 'Commander')}</span>
                  <strong>{result.console.incident.commander}</strong>
                </p>
                <p>
                  <span>{text('事件类型', 'Category')}</span>
                  <strong>{result.console.incident.category}</strong>
                </p>
                <p>
                  <span>{text('启动时间', 'Started')}</span>
                  <strong>
                    {result.console.incident.startedAt.slice(11, 16)}
                  </strong>
                </p>
                <p>
                  <span>{text('敏感字段', 'Sensitive')}</span>
                  <strong>
                    {result.console.incident.sensitiveFields.length}
                  </strong>
                </p>
              </div>
              <section>
                {result.console.incident.objectives.map((item) => (
                  <p key={item}>
                    <CheckCircle2 />
                    <span>{item}</span>
                  </p>
                ))}
              </section>
            </aside>
            <section className="emergencyx-surface emergencyx-timeline">
              <header>
                <History />
                <div>
                  <span>{text('处置时间线', 'Response timeline')}</span>
                  <strong>
                    {text(
                      '线索、决策与通信',
                      'Reports, decisions & communications',
                    )}
                  </strong>
                </div>
              </header>
              <div>
                {result.analysis.timeline.slice(0, 8).map((item) => (
                  <article key={`${item.kind}-${item.id}`}>
                    <time>{item.time.slice(11, 16)}</time>
                    <i className={item.kind} />
                    <span>
                      <strong>{item.title}</strong>
                      <small>
                        {item.kind === 'report'
                          ? text('线索', 'Report')
                          : item.kind === 'decision'
                            ? text('决策', 'Decision')
                            : text('通信', 'Message')}
                      </small>
                    </span>
                    <em>{statusLabel[item.status] ?? item.status}</em>
                  </article>
                ))}
              </div>
            </section>
            <aside className="emergencyx-surface emergencyx-risk">
              <header>
                <BadgeAlert />
                <div>
                  <span>{text('风险矩阵', 'Risk matrix')}</span>
                  <strong>
                    {text('可能性 × 影响', 'Likelihood × impact')}
                  </strong>
                </div>
              </header>
              {result.analysis.riskMatrix.map((item) => (
                <article key={item.name} className={riskLevel(item.score)}>
                  <b>{item.score}</b>
                  <span>
                    <strong>{item.name}</strong>
                    <small>{item.control}</small>
                  </span>
                  <em>
                    {item.likelihood} × {item.impact}
                  </em>
                </article>
              ))}
            </aside>
          </div>
        )}
        {view === 'verification' && (
          <div className="emergencyx-view emergencyx-verification-view">
            <aside className="emergencyx-surface emergencyx-report-list">
              <header>
                <ClipboardCheck />
                <div>
                  <span>{text('多源线索队列', 'Report queue')}</span>
                  <strong>
                    {result.console.reports.length} {text('条', 'reports')}
                  </strong>
                </div>
              </header>
              {result.console.reports.map((item) => (
                <button
                  key={item.id}
                  className={`${item.status} ${item.id === report.id ? 'active' : ''}`}
                  onClick={() => setSelectedReportId(item.id)}
                >
                  <i />
                  <span>
                    <strong>{item.title}</strong>
                    <small>
                      {item.source} · {item.time.slice(11, 16)}
                    </small>
                  </span>
                  <em>{statusLabel[item.status]}</em>
                </button>
              ))}
            </aside>
            <section className="emergencyx-surface emergencyx-report-detail">
              <header>
                <Layers3 />
                <div>
                  <span>
                    {text('线索核验工作区', 'Verification workspace')}
                  </span>
                  <strong>{report.title}</strong>
                </div>
                <em>{percent(report.confidence)}</em>
              </header>
              <article className="emergencyx-report-content">
                <span>{report.source}</span>
                <p>{report.content}</p>
                <footer>
                  {report.evidenceIds.map((item) => (
                    <code key={item}>{item}</code>
                  ))}
                </footer>
              </article>
              <div className="emergencyx-facts">
                <p>
                  <span>{text('来源类型', 'Source type')}</span>
                  <strong>
                    {text(
                      reportTypeLabel[report.type] ?? report.type,
                      report.type,
                    )}
                  </strong>
                </p>
                <p>
                  <span>{text('当前状态', 'Status')}</span>
                  <strong>{statusLabel[report.status]}</strong>
                </p>
                <p>
                  <span>{text('核验人', 'Reviewer')}</span>
                  <strong>
                    {report.reviewer || text('待分配', 'Unassigned')}
                  </strong>
                </p>
                <p>
                  <span>{text('空间位置', 'Location')}</span>
                  <strong>
                    {report.x}, {report.y}
                  </strong>
                </p>
              </div>
              <section className="emergencyx-verify-actions">
                <Button
                  variant="outline"
                  disabled={running}
                  onClick={() =>
                    void execute('verify-report', {
                      reportId: report.id,
                      decision: 'rejected',
                      note: '交叉核验后排除',
                    })
                  }
                >
                  {text('排除线索', 'Reject')}
                </Button>
                <Button
                  variant="outline"
                  disabled={running}
                  onClick={() =>
                    void execute('verify-report', {
                      reportId: report.id,
                      decision: 'review',
                      note: '需要补充现场证据',
                    })
                  }
                >
                  {text('补充证据', 'More evidence')}
                </Button>
                <Button
                  disabled={running}
                  onClick={() =>
                    void execute('verify-report', {
                      reportId: report.id,
                      decision: 'verified',
                      note: '多源证据一致，人工确认',
                    })
                  }
                >
                  <CheckCircle2 />
                  {text('确认有效', 'Verify')}
                </Button>
              </section>
            </section>
            <aside className="emergencyx-surface emergencyx-verification-log">
              <header>
                <History />
                <div>
                  <span>{text('核验记录', 'Verification log')}</span>
                  <strong>
                    {result.console.verifications.length}{' '}
                    {text('次', 'records')}
                  </strong>
                </div>
              </header>
              {result.console.verifications.slice(0, 8).map((item, index) => (
                <article key={item.id || String(index)}>
                  <ShieldCheck />
                  <span>
                    <strong>
                      {item.reviewer || text('审核员', 'Reviewer')}
                    </strong>
                    <small>
                      {item.note ||
                        text('交叉核验已记录', 'Cross-check recorded')}
                    </small>
                  </span>
                  <em>{statusLabel[item.decision] ?? item.decision}</em>
                </article>
              ))}
            </aside>
          </div>
        )}
        {view === 'dispatch' && (
          <div className="emergencyx-view emergencyx-dispatch-view">
            <section className="emergencyx-surface emergencyx-kanban">
              <header>
                <Activity />
                <div>
                  <span>{text('处置任务看板', 'Response Kanban')}</span>
                  <strong>
                    {result.console.tasks.length} {text('项任务', 'tasks')}
                  </strong>
                </div>
                <em>
                  {result.analysis.metrics.openTasks} {text('项未结', 'open')}
                </em>
              </header>
              <div>
                {(['todo', 'doing', 'blocked', 'done'] as const).map(
                  (status) => (
                    <section key={status}>
                      <header>
                        <span>{statusLabel[status]}</span>
                        <b>{result.analysis.taskStatusCounts[status]}</b>
                      </header>
                      {result.console.tasks
                        .filter((item) => item.status === status)
                        .map((item) => (
                          <button
                            key={item.id}
                            className={`${item.priority} ${item.id === task.id ? 'active' : ''}`}
                            onClick={() => setSelectedTaskId(item.id)}
                          >
                            <strong>{item.title}</strong>
                            <small>{item.owner}</small>
                            <p>
                              <i style={{ width: `${item.progress}%` }} />
                            </p>
                            <em>{item.progress}%</em>
                          </button>
                        ))}
                    </section>
                  ),
                )}
              </div>
            </section>
            <aside className="emergencyx-surface emergencyx-task-detail">
              <header>
                <ClipboardCheck />
                <div>
                  <span>{text('任务详情', 'Task details')}</span>
                  <strong>{task.title}</strong>
                </div>
                <em>{statusLabel[task.status]}</em>
              </header>
              <label>
                <span>{text('责任人', 'Owner')}</span>
                <Input
                  value={taskOwner}
                  onChange={(event) => setTaskOwner(event.target.value)}
                />
              </label>
              <div className="emergencyx-task-progress">
                <span>{text('当前进度', 'Progress')}</span>
                <strong>{task.progress}%</strong>
                <p>
                  <i style={{ width: `${task.progress}%` }} />
                </p>
              </div>
              <section>
                {task.sop.map((item, index) => (
                  <p key={item}>
                    <b>{index + 1}</b>
                    <span>{item}</span>
                  </p>
                ))}
              </section>
              <div className="emergencyx-task-buttons">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={running}
                  onClick={() =>
                    void execute('update-task', {
                      taskId: task.id,
                      owner: taskOwner,
                      status: 'blocked',
                      progress: task.progress,
                    })
                  }
                >
                  {text('标记受阻', 'Block')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={running}
                  onClick={() =>
                    void execute('update-task', {
                      taskId: task.id,
                      owner: taskOwner,
                      status: 'doing',
                      progress: Math.min(95, task.progress + 20),
                    })
                  }
                >
                  {text('推进 20%', 'Advance')}
                </Button>
                <Button
                  size="sm"
                  disabled={running}
                  onClick={() =>
                    void execute('update-task', {
                      taskId: task.id,
                      owner: taskOwner,
                      status: 'done',
                      progress: 100,
                    })
                  }
                >
                  {text('完成', 'Complete')}
                </Button>
              </div>
            </aside>
            <section className="emergencyx-surface emergencyx-dependency-card">
              <header>
                <GitBranch />
                <div>
                  <span>{text('任务依赖图', 'Dependency graph')}</span>
                  <strong>
                    {text('前置条件与阻塞链', 'Prerequisites & blockers')}
                  </strong>
                </div>
              </header>
              <DependencyGraph result={result} />
            </section>
          </div>
        )}
        {view === 'resources' && (
          <div className="emergencyx-view emergencyx-resource-view">
            <section className="emergencyx-surface emergencyx-resource-list">
              <header>
                <Boxes />
                <div>
                  <span>{text('资源状态', 'Resource status')}</span>
                  <strong>
                    {result.console.resources.length} {text('类资源', 'types')}
                  </strong>
                </div>
              </header>
              <div>
                {result.console.resources.map((item) => (
                  <article key={item.id}>
                    <span>
                      <strong>{item.name}</strong>
                      <small>
                        {item.type} · {statusLabel[item.status]}
                      </small>
                    </span>
                    <b>
                      {item.available}
                      <small>/{item.quantity}</small>
                    </b>
                    <p>
                      <i
                        style={{
                          width: `${(item.available / item.quantity) * 100}%`,
                        }}
                      />
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={running || item.available < 1}
                      onClick={() =>
                        void execute('assign-resource', {
                          resourceId: item.id,
                          taskId: task.id,
                          quantity: 1,
                        })
                      }
                    >
                      {text('分配', 'Assign')}
                    </Button>
                  </article>
                ))}
              </div>
            </section>
            <section className="emergencyx-surface emergencyx-team-list">
              <header>
                <Users />
                <div>
                  <span>{text('队伍与安置点', 'Teams & shelters')}</span>
                  <strong>
                    {result.console.teams.length +
                      result.console.shelters.length}{' '}
                    {text('个单元', 'units')}
                  </strong>
                </div>
              </header>
              <div>
                {result.console.teams.map((item) => (
                  <article key={item.id}>
                    <span>
                      <strong>{item.name}</strong>
                      <small>
                        {item.leader} · {item.capabilities.join(' / ')}
                      </small>
                    </span>
                    <b>
                      {item.members} {text('人', 'people')}
                    </b>
                    <em>{statusLabel[item.status]}</em>
                  </article>
                ))}
                {result.console.shelters.map((item) => (
                  <article key={item.id} className="shelter">
                    <span>
                      <strong>{item.name}</strong>
                      <small>{statusLabel[item.status]}</small>
                    </span>
                    <b>
                      {item.occupancy}/{item.capacity}
                    </b>
                    <em>
                      {Math.round((item.occupancy / item.capacity) * 100)}%
                    </em>
                  </article>
                ))}
              </div>
            </section>
            <section className="emergencyx-surface emergencyx-communications">
              <header>
                <MessageSquareMore />
                <div>
                  <span>{text('通信日志', 'Communication log')}</span>
                  <strong>
                    {result.console.communications.length}{' '}
                    {text('条记录', 'records')}
                  </strong>
                </div>
                <em>{text('不伪报外发状态', 'Truthful delivery state')}</em>
              </header>
              <div className="emergencyx-message-form">
                <NativeSelect
                  aria-label={text('通信渠道', 'Channel')}
                  value={communicationChannel}
                  onChange={(event) =>
                    setCommunicationChannel(event.target.value)
                  }
                >
                  <NativeSelectOption value="in-app">
                    {text('站内通知', 'In-app')}
                  </NativeSelectOption>
                  <NativeSelectOption value="radio">
                    {text('无线电记录', 'Radio')}
                  </NativeSelectOption>
                  <NativeSelectOption value="sms">
                    {text('短信（待接入）', 'SMS (not configured)')}
                  </NativeSelectOption>
                  <NativeSelectOption value="email">
                    {text('邮件（待接入）', 'Email (not configured)')}
                  </NativeSelectOption>
                </NativeSelect>
                <Input
                  value={communicationSubject}
                  onChange={(event) =>
                    setCommunicationSubject(event.target.value)
                  }
                />
                <Button
                  disabled={running}
                  onClick={() =>
                    void execute('send-communication', {
                      channel: communicationChannel,
                      audience: '应急协同成员',
                      subject: communicationSubject,
                    })
                  }
                >
                  <Radio />
                  {text('记录发送', 'Record send')}
                </Button>
              </div>
              <div className="emergencyx-message-log">
                {result.console.communications.map((item) => (
                  <article key={item.id}>
                    <i className={item.channel} />
                    <time>{item.time.slice(11, 16)}</time>
                    <span>
                      <strong>{item.subject}</strong>
                      <small>
                        {item.audience} ·{' '}
                        {text(
                          channelLabel[item.channel] ?? item.channel,
                          item.channel,
                        )}
                      </small>
                    </span>
                    <em>{statusLabel[item.status]}</em>
                  </article>
                ))}
              </div>
              <footer>
                {Object.entries(result.runtime.communications).map(
                  ([key, value]) => (
                    <span key={key}>
                      <b>
                        {text(
                          ...(runtimeCommunicationLabel[key] ?? [key, key]),
                        )}
                      </b>
                      {text(...(runtimeStateLabel[value] ?? [value, value]))}
                    </span>
                  ),
                )}
              </footer>
            </section>
          </div>
        )}
        {view === 'decisions' && (
          <div className="emergencyx-view emergencyx-decision-view">
            <aside className="emergencyx-surface emergencyx-decision-list">
              <header>
                <GitBranch />
                <div>
                  <span>{text('决策记录', 'Decision records')}</span>
                  <strong>
                    {result.console.decisions.length} {text('条', 'decisions')}
                  </strong>
                </div>
              </header>
              {result.console.decisions.map((item) => (
                <button
                  key={item.id}
                  className={`${item.status} ${item.id === decision.id ? 'active' : ''}`}
                  onClick={() => setSelectedDecisionId(item.id)}
                >
                  <i />
                  <span>
                    <strong>{item.title}</strong>
                    <small>{item.option}</small>
                  </span>
                  <em>{statusLabel[item.status]}</em>
                </button>
              ))}
            </aside>
            <section className="emergencyx-surface emergencyx-decision-detail">
              <header>
                <ShieldCheck />
                <div>
                  <span>{text('决策证据链', 'Decision evidence')}</span>
                  <strong>{decision.title}</strong>
                </div>
                <em>{statusLabel[decision.status]}</em>
              </header>
              <p>{decision.reason}</p>
              <div className="emergencyx-decision-flow">
                <article>
                  <span>{text('证据', 'Evidence')}</span>
                  <strong>{decision.evidenceIds.length}</strong>
                </article>
                <ArrowRight />
                <article>
                  <span>{text('方案', 'Option')}</span>
                  <strong>{decision.option}</strong>
                </article>
                <ArrowRight />
                <article>
                  <span>{text('影响', 'Impact')}</span>
                  <strong>{decision.impact}</strong>
                </article>
              </div>
              <section>
                {decision.evidenceIds.map((id) => {
                  const item = result.console.reports.find(
                    (row) => row.id === id,
                  );
                  return (
                    <article key={id}>
                      <ClipboardCheck />
                      <span>
                        <strong>{item?.title ?? id}</strong>
                        <small>{item?.source}</small>
                      </span>
                      <em>{item ? percent(item.confidence) : '—'}</em>
                    </article>
                  );
                })}
              </section>
              <footer>
                <span>
                  {text('决策人', 'Decider')} <b>{decision.decider}</b>
                </span>
                <span>
                  {text('批准人', 'Approvers')}{' '}
                  <b>
                    {decision.approvers.join('、') || text('待审批', 'Pending')}
                  </b>
                </span>
              </footer>
            </section>
            <aside className="emergencyx-surface emergencyx-handover">
              <header>
                <History />
                <div>
                  <span>{text('班次交接', 'Shift handover')}</span>
                  <strong>
                    {result.console.shifts[0].name} →{' '}
                    {result.console.shifts[1].name}
                  </strong>
                </div>
              </header>
              <label>
                <span>{text('当前操作人', 'Actor')}</span>
                <Input
                  value={actor}
                  onChange={(event) => setActor(event.target.value)}
                />
              </label>
              <label>
                <span>{text('交接重点', 'Handover note')}</span>
                <textarea
                  value={handoverNote}
                  onChange={(event) => setHandoverNote(event.target.value)}
                />
              </label>
              <Button
                disabled={running}
                onClick={() =>
                  void execute('handover-shift', {
                    shiftId: 'shift-day',
                    nextShiftId: 'shift-night',
                    acceptedBy: '周值班长',
                    note: handoverNote,
                  })
                }
              >
                <Users />
                {text('双方记录交接', 'Record handover')}
              </Button>
              <section>
                {result.console.shifts.map((item) => (
                  <p key={item.id}>
                    <i className={item.status} />
                    <span>
                      <strong>
                        {item.name} · {item.leader}
                      </strong>
                      <small>
                        {item.startAt.slice(11, 16)}–{item.endAt.slice(11, 16)}
                      </small>
                    </span>
                    <em>{statusLabel[item.status]}</em>
                  </p>
                ))}
              </section>
            </aside>
            <section className="emergencyx-surface emergencyx-delivery">
              <header>
                <FileArchive />
                <div>
                  <span>{text('态势报告与交付', 'Reports & delivery')}</span>
                  <strong>
                    {result.console.situationReports.length}{' '}
                    {text('个已发布版本', 'published versions')}
                  </strong>
                </div>
                <em>
                  {
                    result.analysis.qualityChecks.filter((item) => item.passed)
                      .length
                  }
                  /{result.analysis.qualityChecks.length}{' '}
                  {text('门禁', 'gates')}
                </em>
              </header>
              <div className="emergencyx-gates">
                {result.analysis.qualityChecks.map((item) => (
                  <p key={item.label} className={item.passed ? 'pass' : 'fail'}>
                    {item.passed ? <CheckCircle2 /> : <CircleAlert />}
                    <span>{item.label}</span>
                  </p>
                ))}
              </div>
              <div className="emergencyx-downloads">
                <button
                  onClick={() =>
                    downloadText(
                      result.exports.reportMarkdown,
                      'situation-report.md',
                    )
                  }
                >
                  <Download />
                  <span>
                    <strong>{text('态势报告', 'Situation report')}</strong>
                    <small>Markdown</small>
                  </span>
                </button>
                <button
                  onClick={() =>
                    downloadTextText(result.exports.tasksCsv, 'tasks.csv')
                  }
                >
                  <Download />
                  <span>
                    <strong>{text('任务清单', 'Task list')}</strong>
                    <small>CSV</small>
                  </span>
                </button>
                <button
                  onClick={() =>
                    downloadText(
                      result.exports.geoJson,
                      'situation.geojson',
                      'application/geo+json',
                    )
                  }
                >
                  <MapPinned />
                  <span>
                    <strong>{text('态势空间数据', 'Situation map')}</strong>
                    <small>GeoJSON</small>
                  </span>
                </button>
                <button
                  onClick={() =>
                    downloadText(
                      result.exports.capXml,
                      'alert.cap.xml',
                      'application/xml',
                    )
                  }
                >
                  <BadgeAlert />
                  <span>
                    <strong>CAP</strong>
                    <small>XML</small>
                  </span>
                </button>
                <button
                  onClick={() =>
                    result.exports.packageBase64
                      ? downloadBase64(
                          result.exports.packageBase64,
                          'emergency-console-package.zip',
                        )
                      : void execute('export')
                  }
                >
                  <FileArchive />
                  <span>
                    <strong>{text('完整交付包', 'Full package')}</strong>
                    <small>ZIP</small>
                  </span>
                </button>
              </div>
              <footer>
                <Button
                  variant="outline"
                  disabled={running}
                  onClick={() =>
                    void execute('publish-situation-report', {
                      summary: result.console.incident.summary,
                      approvers: ['王值班长', '李指挥'],
                      evidenceIds: ['report-001', 'report-002', 'report-004'],
                    })
                  }
                >
                  <RefreshCw />
                  {text('发布新通报', 'Publish report')}
                </Button>
                <Button
                  variant="outline"
                  disabled={running}
                  onClick={() => void execute('export')}
                >
                  <Download />
                  {text('刷新交付物', 'Refresh exports')}
                </Button>
                <span>
                  {result.console.audit.length}{' '}
                  {text('条审计', 'audit records')}
                </span>
              </footer>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

function downloadTextText(content: string, fileName: string) {
  downloadText(content, fileName, 'text/csv;charset=utf-8');
}
