'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArchiveRestore,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Download,
  FileArchive,
  FolderKanban,
  GitBranch,
  ListChecks,
  MessageSquareText,
  Milestone,
  Paperclip,
  Plus,
  Save,
  ShieldCheck,
  Upload,
  UsersRound,
} from 'lucide-react';
import { useLanguage } from '@/components/language-provider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiError } from '@/services/api/client';
import {
  toolApi,
  type WorkbenchJob,
  type WorkbenchProject,
} from '@/services/api/tools';

type Project = {
  id: string;
  code: string;
  title: string;
  objective: string;
  ownerId: string;
  memberIds: string[];
  status: string;
  health: string;
  cycleId: string;
  deadline: string;
  archivedAt: string;
};
type Member = {
  id: string;
  name: string;
  email: string;
  role: string;
  avatar: string;
  active: boolean;
};
type Task = {
  id: string;
  projectId: string;
  key: string;
  title: string;
  status: string;
  priority: string;
  ownerIds: string[];
  labelIds: string[];
  cycleId: string;
  milestoneId: string;
  startDate: string;
  dueDate: string;
  progress: number;
  storyPoints: number;
  dependencyIds: string[];
  archivedAt: string;
};
type MilestoneRow = {
  id: string;
  projectId: string;
  title: string;
  dueDate: string;
  status: string;
  progress: number;
  ownerId: string;
};
type Activity = {
  id: string;
  time: string;
  actor: string;
  action: string;
  target: string;
  text: string;
};
type Portfolio = {
  id: string;
  name: string;
  version: number;
  currentProjectId: string;
  projects: Project[];
  members: Member[];
  statuses: Array<{ id: string; name: string; order: number }>;
  labels: Array<{ id: string; name: string; color: string }>;
  cycles: Array<{
    id: string;
    projectId: string;
    name: string;
    startDate: string;
    endDate: string;
    status: string;
    capacity: number;
  }>;
  milestones: MilestoneRow[];
  tasks: Task[];
  comments: Array<{
    id: string;
    projectId: string;
    taskId: string;
    authorId: string;
    body: string;
    time: string;
  }>;
  attachments: Array<{
    id: string;
    projectId: string;
    taskId: string;
    name: string;
    size: number;
    storage: string;
    time: string;
  }>;
  noteRevisions: Array<{
    id: string;
    projectId: string;
    revision: number;
    authorId: string;
    body: string;
    time: string;
  }>;
  notifications: Array<{
    id: string;
    memberId: string;
    type: string;
    text: string;
    read: boolean;
    time: string;
  }>;
  snapshots: Array<{
    id: string;
    projectId: string;
    label: string;
    version: number;
    createdAt: string;
    state: Record<string, unknown>;
  }>;
  activities: Activity[];
  audit: Array<Record<string, unknown>>;
  updatedAt: string;
};
type Analysis = {
  currentProject: Project;
  metrics: {
    progress: number;
    donePoints: number;
    totalPoints: number;
    openTasks: number;
    blockedTasks: number;
    overdueTasks: number;
    activeMembers: number;
    milestoneProgress: number;
  };
  statusCounts: Record<string, number>;
  priorityCounts: Record<string, number>;
  board: Array<{ status: string; name: string; tasks: Task[] }>;
  taskList: Task[];
  timeline: Task[];
  milestones: MilestoneRow[];
  burndown: Array<{ date: string; ideal: number; remaining: number }>;
  cumulativeFlow: Array<{
    date: string;
    done: number;
    doing: number;
    todo: number;
  }>;
  memberLoad: Array<{
    memberId: string;
    name: string;
    role: string;
    openTasks: number;
    points: number;
    capacity: number;
    utilization: number;
  }>;
  activities: Activity[];
  overdueTaskIds: string[];
  qualityChecks: Array<{ label: string; passed: boolean }>;
};
type ProjectResult = {
  schema: 'skyview-project-workspace-results';
  version: number;
  stage: string;
  portfolio: Portfolio;
  analysis: Analysis;
  runtime: Record<
    string,
    | { status: string; engine: string }
    | string[]
    | boolean
    | Record<string, string>
  >;
  exports: {
    reportMarkdown: string;
    tasksCsv: string;
    membersCsv: string;
    activitiesCsv: string;
    calendarIcs: string;
    projectJson: string;
    backupJson: string;
    packageBase64: string;
  };
};

const views = [
  ['overview', '项目总览', 'Overview'],
  ['board', '任务看板', 'Board'],
  ['schedule', '列表与时间线', 'List & timeline'],
  ['team', '团队与协作', 'Team'],
  ['delivery', '里程碑与交付', 'Delivery'],
] as const;
const statusOrder = ['backlog', 'todo', 'doing', 'review', 'blocked', 'done'];

function sampleResult(): ProjectResult {
  const projects: Project[] = [
    {
      id: 'project-slope-risk',
      code: 'GEO-26-014',
      title: '北岭边坡风险研究',
      objective: '完成监测数据治理、风险模型验证与可复核交付。',
      ownerId: 'member-li',
      memberIds: ['member-li', 'member-zhou', 'member-wang', 'member-chen'],
      status: 'active',
      health: 'at-risk',
      cycleId: 'cycle-02',
      deadline: '2026-09-28',
      archivedAt: '',
    },
    {
      id: 'project-course-data',
      code: 'COURSE-26-03',
      title: '矿山安全数据课程项目',
      objective: '完成从数据检查、指标分析到成果汇报的团队课程项目。',
      ownerId: 'member-li',
      memberIds: ['member-li', 'member-lin', 'member-wang'],
      status: 'active',
      health: 'on-track',
      cycleId: 'cycle-course-01',
      deadline: '2026-10-12',
      archivedAt: '',
    },
    {
      id: 'project-legacy',
      code: 'GEO-25-006',
      title: '历史裂缝编目',
      objective: '保留上一阶段的影像与裂缝记录。',
      ownerId: 'member-li',
      memberIds: ['member-li', 'member-chen'],
      status: 'archived',
      health: 'complete',
      cycleId: '',
      deadline: '2026-08-20',
      archivedAt: '2026-08-28T09:30:00Z',
    },
  ];
  const members: Member[] = [
    {
      id: 'member-li',
      name: '李江峰',
      email: 'jiangfeng.Li@cumt.edu.cn',
      role: 'owner',
      avatar: '李',
      active: true,
    },
    {
      id: 'member-zhou',
      name: '周明',
      email: 'zhouming@example.edu.cn',
      role: 'maintainer',
      avatar: '周',
      active: true,
    },
    {
      id: 'member-wang',
      name: '王欣',
      email: 'wangxin@example.edu.cn',
      role: 'member',
      avatar: '王',
      active: true,
    },
    {
      id: 'member-chen',
      name: '陈宇',
      email: 'chenyu@example.edu.cn',
      role: 'member',
      avatar: '陈',
      active: true,
    },
    {
      id: 'member-lin',
      name: '林珊',
      email: 'linshan@example.edu.cn',
      role: 'viewer',
      avatar: '林',
      active: true,
    },
  ];
  const taskRows: Array<
    [
      string,
      string,
      string,
      string,
      string[],
      string[],
      string,
      string,
      number,
      number,
      string[],
    ]
  > = [
    [
      'GEO-101',
      '冻结监测点位与字段字典',
      'done',
      'high',
      ['member-zhou'],
      ['label-data'],
      '2026-08-31',
      '2026-09-04',
      100,
      5,
      [],
    ],
    [
      'GEO-102',
      '完成缺测与异常值规则',
      'done',
      'medium',
      ['member-wang'],
      ['label-data', 'label-quality'],
      '2026-09-02',
      '2026-09-08',
      100,
      5,
      ['task-001'],
    ],
    [
      'GEO-103',
      '复核坐标参考与时间基准',
      'review',
      'high',
      ['member-chen'],
      ['label-quality'],
      '2026-09-09',
      '2026-09-13',
      85,
      3,
      ['task-001'],
    ],
    [
      'GEO-104',
      '训练位移趋势风险模型',
      'doing',
      'critical',
      ['member-wang', 'member-zhou'],
      ['label-model'],
      '2026-09-10',
      '2026-09-18',
      62,
      8,
      ['task-002'],
    ],
    [
      'GEO-105',
      '核对现场裂缝编目',
      'blocked',
      'high',
      ['member-chen'],
      ['label-field'],
      '2026-09-11',
      '2026-09-16',
      35,
      5,
      ['task-003'],
    ],
    [
      'GEO-106',
      '形成独立验证数据集',
      'todo',
      'high',
      ['member-zhou'],
      ['label-data', 'label-quality'],
      '2026-09-14',
      '2026-09-19',
      0,
      5,
      ['task-003'],
    ],
    [
      'GEO-107',
      '编制方法与参数说明',
      'backlog',
      'medium',
      ['member-li'],
      ['label-report'],
      '2026-09-18',
      '2026-09-24',
      0,
      3,
      ['task-004', 'task-006'],
    ],
    [
      'GEO-108',
      '打包图表、数据与审计清单',
      'backlog',
      'medium',
      ['member-chen'],
      ['label-report'],
      '2026-09-22',
      '2026-09-27',
      0,
      5,
      ['task-007'],
    ],
  ];
  const tasks: Task[] = [
    ...taskRows.map((row, index) => ({
      id: `task-00${index + 1}`,
      projectId: 'project-slope-risk',
      key: row[0],
      title: row[1],
      status: row[2],
      priority: row[3],
      ownerIds: row[4],
      labelIds: row[5],
      cycleId: index < 2 ? 'cycle-01' : 'cycle-02',
      milestoneId:
        index < 2
          ? 'milestone-data'
          : index < 6
            ? 'milestone-model'
            : 'milestone-delivery',
      startDate: row[6],
      dueDate: row[7],
      progress: row[8],
      storyPoints: row[9],
      dependencyIds: row[10],
      archivedAt: '',
    })),
    {
      id: 'task-009',
      projectId: 'project-course-data',
      key: 'COURSE-21',
      title: '梳理课程数据字段',
      status: 'done',
      priority: 'medium',
      ownerIds: ['member-wang'],
      labelIds: ['label-course', 'label-data'],
      cycleId: 'cycle-course-01',
      milestoneId: 'milestone-course',
      startDate: '2026-09-07',
      dueDate: '2026-09-09',
      progress: 100,
      storyPoints: 3,
      dependencyIds: [],
      archivedAt: '',
    },
    {
      id: 'task-010',
      projectId: 'project-course-data',
      key: 'COURSE-22',
      title: '建立缺失值处理方案',
      status: 'doing',
      priority: 'high',
      ownerIds: ['member-wang'],
      labelIds: ['label-course', 'label-data'],
      cycleId: 'cycle-course-01',
      milestoneId: 'milestone-course',
      startDate: '2026-09-09',
      dueDate: '2026-09-15',
      progress: 55,
      storyPoints: 5,
      dependencyIds: ['task-009'],
      archivedAt: '',
    },
    {
      id: 'task-011',
      projectId: 'project-course-data',
      key: 'COURSE-23',
      title: '完成风险指标对比图',
      status: 'todo',
      priority: 'medium',
      ownerIds: ['member-li'],
      labelIds: ['label-course', 'label-model'],
      cycleId: 'cycle-course-01',
      milestoneId: 'milestone-course',
      startDate: '2026-09-14',
      dueDate: '2026-09-18',
      progress: 0,
      storyPoints: 5,
      dependencyIds: ['task-010'],
      archivedAt: '',
    },
    {
      id: 'task-012',
      projectId: 'project-course-data',
      key: 'COURSE-24',
      title: '提交中期汇报材料',
      status: 'backlog',
      priority: 'high',
      ownerIds: ['member-lin'],
      labelIds: ['label-course', 'label-report'],
      cycleId: 'cycle-course-01',
      milestoneId: 'milestone-course',
      startDate: '2026-09-18',
      dueDate: '2026-09-20',
      progress: 0,
      storyPoints: 3,
      dependencyIds: ['task-011'],
      archivedAt: '',
    },
  ];
  const statuses = [
    { id: 'backlog', name: '需求池', order: 0 },
    { id: 'todo', name: '待开始', order: 1 },
    { id: 'doing', name: '进行中', order: 2 },
    { id: 'review', name: '待评审', order: 3 },
    { id: 'blocked', name: '受阻', order: 4 },
    { id: 'done', name: '已完成', order: 5 },
  ];
  const milestones: MilestoneRow[] = [
    {
      id: 'milestone-data',
      projectId: 'project-slope-risk',
      title: '数据基线冻结',
      dueDate: '2026-09-13',
      status: 'done',
      progress: 100,
      ownerId: 'member-zhou',
    },
    {
      id: 'milestone-model',
      projectId: 'project-slope-risk',
      title: '模型独立验证',
      dueDate: '2026-09-21',
      status: 'active',
      progress: 58,
      ownerId: 'member-wang',
    },
    {
      id: 'milestone-delivery',
      projectId: 'project-slope-risk',
      title: '成果包验收',
      dueDate: '2026-09-28',
      status: 'planned',
      progress: 20,
      ownerId: 'member-li',
    },
    {
      id: 'milestone-course',
      projectId: 'project-course-data',
      title: '课程中期检查',
      dueDate: '2026-09-20',
      status: 'active',
      progress: 45,
      ownerId: 'member-wang',
    },
  ];
  const activities: Activity[] = [
    {
      id: 'activity-006',
      time: '2026-09-11T03:00:00Z',
      actor: '李江峰',
      action: 'update-note',
      target: 'project-slope-risk',
      text: '更新阶段笔记第 2 版',
    },
    {
      id: 'activity-005',
      time: '2026-09-11T02:15:00Z',
      actor: '陈宇',
      action: 'move-task',
      target: 'task-005',
      text: 'GEO-105 移至受阻',
    },
    {
      id: 'activity-004',
      time: '2026-09-10T08:40:00Z',
      actor: '周明',
      action: 'add-comment',
      target: 'task-004',
      text: '为 GEO-104 添加评论',
    },
    {
      id: 'activity-003',
      time: '2026-09-09T08:20:00Z',
      actor: '王欣',
      action: 'move-task',
      target: 'task-003',
      text: 'GEO-103 移至待评审',
    },
  ];
  const memberLoad = members.slice(0, 4).map((member, index) => ({
    memberId: member.id,
    name: member.name,
    role: member.role,
    openTasks: [1, 2, 2, 2][index],
    points: [3, 13, 8, 10][index],
    capacity: 12,
    utilization: [25, 108, 67, 83][index],
  }));
  const currentTasks = tasks.filter(
    (task) => task.projectId === 'project-slope-risk',
  );
  const currentMilestones = milestones.filter(
    (item) => item.projectId === 'project-slope-risk',
  );
  const board = statuses.map((status) => ({
    status: status.id,
    name: status.name,
    tasks: currentTasks.filter((task) => task.status === status.id),
  }));
  const portfolio: Portfolio = {
    id: 'portfolio-geoscience-delivery',
    name: '科研与课程项目集',
    version: 12,
    currentProjectId: 'project-slope-risk',
    projects,
    members,
    statuses,
    labels: [
      { id: 'label-data', name: '数据', color: '#167d91' },
      { id: 'label-model', name: '模型', color: '#4b58aa' },
      { id: 'label-field', name: '现场', color: '#b76a24' },
      { id: 'label-report', name: '交付', color: '#2f7d5a' },
      { id: 'label-quality', name: '质量', color: '#9b3f57' },
      { id: 'label-course', name: '课程', color: '#6d5a9a' },
    ],
    cycles: [
      {
        id: 'cycle-01',
        projectId: 'project-slope-risk',
        name: '数据基线',
        startDate: '2026-08-31',
        endDate: '2026-09-13',
        status: 'completed',
        capacity: 34,
      },
      {
        id: 'cycle-02',
        projectId: 'project-slope-risk',
        name: '模型与复核',
        startDate: '2026-09-14',
        endDate: '2026-09-27',
        status: 'active',
        capacity: 40,
      },
      {
        id: 'cycle-course-01',
        projectId: 'project-course-data',
        name: '课程迭代一',
        startDate: '2026-09-07',
        endDate: '2026-09-20',
        status: 'active',
        capacity: 24,
      },
    ],
    milestones,
    tasks,
    comments: [
      {
        id: 'comment-001',
        projectId: 'project-slope-risk',
        taskId: 'task-004',
        authorId: 'member-zhou',
        body: '训练数据切分已固定，请勿覆盖基准版本。',
        time: '2026-09-10T08:40:00Z',
      },
      {
        id: 'comment-002',
        projectId: 'project-slope-risk',
        taskId: 'task-005',
        authorId: 'member-chen',
        body: '等待北侧坡肩补拍影像，任务暂时受阻。',
        time: '2026-09-11T02:15:00Z',
      },
    ],
    attachments: [
      {
        id: 'attachment-001',
        projectId: 'project-slope-risk',
        taskId: 'task-001',
        name: 'monitoring_dictionary_v3.xlsx',
        size: 184320,
        storage: 'metadata-only',
        time: '2026-09-04T10:20:00Z',
      },
    ],
    noteRevisions: [
      {
        id: 'note-002',
        projectId: 'project-slope-risk',
        revision: 2,
        authorId: 'member-li',
        body: '本周期重点：冻结独立验证集，完成模型复核，解决现场裂缝影像缺口。',
        time: '2026-09-11T03:00:00Z',
      },
    ],
    notifications: [
      {
        id: 'notice-001',
        memberId: 'member-chen',
        type: 'blocked',
        text: 'GEO-105 已受阻，需要补拍裂缝影像。',
        read: false,
        time: '2026-09-11T02:15:00Z',
      },
    ],
    snapshots: [
      {
        id: 'snapshot-baseline',
        projectId: 'project-slope-risk',
        label: '数据基线冻结',
        version: 9,
        createdAt: '2026-09-04T11:00:00Z',
        state: {},
      },
    ],
    activities,
    audit: [],
    updatedAt: '2026-09-11T03:00:00Z',
  };
  const analysis: Analysis = {
    currentProject: projects[0],
    metrics: {
      progress: 29,
      donePoints: 10,
      totalPoints: 39,
      openTasks: 6,
      blockedTasks: 1,
      overdueTasks: 0,
      activeMembers: 4,
      milestoneProgress: 59,
    },
    statusCounts: Object.fromEntries(
      statuses.map((status) => [
        status.id,
        board.find((column) => column.status === status.id)?.tasks.length ?? 0,
      ]),
    ),
    priorityCounts: { critical: 1, high: 4, medium: 3, low: 0 },
    board,
    taskList: currentTasks,
    timeline: currentTasks,
    milestones: currentMilestones,
    burndown: Array.from({ length: 8 }, (_, index) => ({
      date: `2026-09-${String(7 + index * 3).padStart(2, '0')}`,
      ideal: Math.max(0, 39 - index * 6),
      remaining: [39, 36, 34, 31, 29, 25, 18, 10][index],
    })),
    cumulativeFlow: [],
    memberLoad,
    activities,
    overdueTaskIds: [],
    qualityChecks: [
      { label: '所有进行中任务均有负责人', passed: true },
      { label: '任务依赖均指向现有任务', passed: true },
      { label: '里程碑均有负责人和日期', passed: true },
      { label: '活动事件由服务端生成', passed: true },
      { label: '外部附件未伪装为已入库', passed: true },
      { label: '归档任务可恢复', passed: true },
    ],
  };
  return {
    schema: 'skyview-project-workspace-results',
    version: 2,
    stage: 'load-sample',
    portfolio,
    analysis,
    runtime: {
      controlPlane: {
        status: 'enabled',
        engine: 'Go projects / jobs / versions / audit',
      },
      analytics: {
        status: 'enabled',
        engine: 'Python deterministic portfolio analytics',
      },
      objectStorage: {
        status: 'not-configured',
        engine: 'S3 compatible adapter',
      },
      webhook: { status: 'not-configured', engine: 'signed webhook adapter' },
      calendar: { status: 'enabled', engine: 'iCalendar export' },
    },
    exports: {
      reportMarkdown: '',
      tasksCsv: '',
      membersCsv: '',
      activitiesCsv: '',
      calendarIcs: '',
      projectJson: '',
      backupJson: '',
      packageBase64: '',
    },
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

function downloadText(content: string, fileName: string, type: string) {
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(new Blob([content], { type }));
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}

function downloadBase64(content: string, fileName: string) {
  const bytes = Uint8Array.from(atob(content), (value) => value.charCodeAt(0));
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(
    new Blob([bytes], { type: 'application/zip' }),
  );
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}

function dateLabel(value: string, locale: string) {
  if (!value) return '—';
  return new Intl.DateTimeFormat(locale === 'zh-CN' ? 'zh-CN' : 'en-US', {
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(`${value.slice(0, 10)}T00:00:00`));
}

function BurndownChart({ rows }: { rows: Analysis['burndown'] }) {
  const max = Math.max(1, ...rows.flatMap((row) => [row.ideal, row.remaining]));
  const point = (value: number, index: number) =>
    `${28 + (index / Math.max(1, rows.length - 1)) * 444},${18 + (1 - value / max) * 126}`;
  return (
    <svg className="projectx-chart" viewBox="0 0 500 170" aria-hidden="true">
      {[0, 1, 2, 3].map((row) => (
        <line
          key={row}
          x1="28"
          x2="472"
          y1={18 + row * 42}
          y2={18 + row * 42}
        />
      ))}
      <polyline
        className="ideal"
        points={rows.map((row, index) => point(row.ideal, index)).join(' ')}
      />
      <polyline
        className="actual"
        points={rows.map((row, index) => point(row.remaining, index)).join(' ')}
      />
      {rows.map((row, index) => (
        <circle
          key={row.date}
          cx={point(row.remaining, index).split(',')[0]}
          cy={point(row.remaining, index).split(',')[1]}
          r="3.5"
        />
      ))}
    </svg>
  );
}

function TaskCard({
  task,
  result,
  text,
  move,
  select,
}: {
  task: Task;
  result: ProjectResult;
  text: (zh: string, en: string) => string;
  move: (taskId: string, direction: number) => void;
  select: (taskId: string) => void;
}) {
  const owners = task.ownerIds
    .map(
      (id) => result.portfolio.members.find((member) => member.id === id)?.name,
    )
    .filter(Boolean);
  return (
    <article className={`projectx-task priority-${task.priority}`}>
      <div className="projectx-task-top">
        <strong>{task.key}</strong>
        <span>
          {task.storyPoints} {text('点', 'pts')}
        </span>
      </div>
      <button
        type="button"
        className="projectx-task-title"
        onClick={() => select(task.id)}
      >
        {task.title}
      </button>
      <div className="projectx-task-meta">
        <span>{owners.join('、') || text('未分配', 'Unassigned')}</span>
        <span>{dateLabel(task.dueDate, text('zh-CN', 'en-US'))}</span>
      </div>
      <div className="projectx-progress">
        <i style={{ width: `${task.progress}%` }} />
      </div>
      <div className="projectx-task-actions">
        <button
          type="button"
          aria-label={text('移到上一阶段', 'Move back')}
          disabled={statusOrder.indexOf(task.status) <= 0}
          onClick={(event) => {
            event.stopPropagation();
            move(task.id, -1);
          }}
        >
          <ChevronLeft />
        </button>
        <span>{task.progress}%</span>
        <button
          type="button"
          aria-label={text('移到下一阶段', 'Move forward')}
          disabled={statusOrder.indexOf(task.status) >= statusOrder.length - 1}
          onClick={(event) => {
            event.stopPropagation();
            move(task.id, 1);
          }}
        >
          <ChevronRight />
        </button>
      </div>
    </article>
  );
}

export function ProjectWorkspaceWorkbench({
  executionAllowed = true,
}: {
  executionAllowed?: boolean;
}) {
  const { locale, text } = useLanguage();
  const [view, setView] = useState<(typeof views)[number][0]>('overview');
  const [result, setResult] = useState<ProjectResult>(() => sampleResult());
  const [projects, setProjects] = useState<WorkbenchProject[]>([]);
  const [projectId, setProjectId] = useState('');
  const [workspaceTitle, setWorkspaceTitle] = useState('科研项目协同工作区');
  const [selectedTaskId, setSelectedTaskId] = useState('task-004');
  const [taskTitle, setTaskTitle] = useState('');
  const [taskPriority, setTaskPriority] = useState('medium');
  const [taskOwnerId, setTaskOwnerId] = useState('member-wang');
  const [comment, setComment] = useState('');
  const [note, setNote] = useState(
    result.portfolio.noteRevisions[0]?.body ?? '',
  );
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const importInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    toolApi
      .listProjects('project-workspace')
      .then((items) => {
        if (!active) return;
        setProjects(items);
        const first = items[0];
        const saved = first?.state.projectWorkspace as
          | { result?: ProjectResult }
          | undefined;
        if (
          first &&
          saved?.result?.schema === 'skyview-project-workspace-results'
        ) {
          setProjectId(first.id);
          setWorkspaceTitle(first.title);
          setResult(saved.result);
          setNote(
            saved.result.portfolio.noteRevisions.find(
              (item) =>
                item.projectId === saved.result?.portfolio.currentProjectId,
            )?.body ?? '',
          );
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const projectState = (next = result) => ({
    projectWorkspace: { result: next },
  });
  const ensureProject = async () => {
    const existing = projects.find((item) => item.id === projectId);
    if (existing) return existing;
    const created = await toolApi.createProject(
      'project-workspace',
      workspaceTitle,
      projectState(),
    );
    setProjects((items) => [created, ...items]);
    setProjectId(created.id);
    return created;
  };
  const storeResult = async (
    project: WorkbenchProject,
    output: ProjectResult,
  ) => {
    setResult(output);
    const saved = await toolApi.updateProject(
      project.id,
      workspaceTitle,
      projectState(output),
    );
    setProjects((items) => [
      saved,
      ...items.filter((item) => item.id !== saved.id),
    ]);
    const latestNote = output.portfolio.noteRevisions.find(
      (item) => item.projectId === output.portfolio.currentProjectId,
    );
    if (latestNote) setNote(latestNote.body);
  };
  const execute = async (
    action: string,
    extra: Record<string, unknown> = {},
  ) => {
    if (!executionAllowed) {
      setError(text('项目作业服务当前不可用', 'Project service unavailable'));
      return null;
    }
    setRunning(true);
    setError('');
    setMessage(
      text(
        'Go 已登记作业，Python 正在更新项目、任务与审计…',
        'Job registered; project analytics are updating…',
      ),
    );
    try {
      const project = await ensureProject();
      const created = await toolApi.createJob(
        project.id,
        'project-workspace',
        action,
        { state: result, actor: '当前用户', actorRole: 'owner', ...extra },
        crypto.randomUUID(),
      );
      const job = await waitForJob(created.job.id);
      if (!job)
        throw new Error(
          text('作业仍在后台运行。', 'The job is still running.'),
        );
      if (job.status !== 'succeeded')
        throw new Error(
          job.error || text('项目作业失败。', 'Project job failed.'),
        );
      const output = job.result as ProjectResult;
      if (output.schema !== 'skyview-project-workspace-results')
        throw new Error(
          text('服务端结果不兼容。', 'Incompatible service result.'),
        );
      await storeResult(project, output);
      setMessage(
        text(
          '项目、任务、图表和审计已同步。',
          'Project, tasks, charts and audit synchronized.',
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
  const saveWorkspace = async () => {
    setSaving(true);
    setError('');
    try {
      const existing = projects.find((item) => item.id === projectId);
      const saved = existing
        ? await toolApi.updateProject(
            existing.id,
            workspaceTitle,
            projectState(),
          )
        : await toolApi.createProject(
            'project-workspace',
            workspaceTitle,
            projectState(),
          );
      setProjects((items) => [
        saved,
        ...items.filter((item) => item.id !== saved.id),
      ]);
      setProjectId(saved.id);
      setMessage(text('工作区已保存。', 'Workspace saved.'));
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
        `项目版本 ${result.portfolio.version} · ${new Date().toLocaleString(locale)}`,
        projectState(),
      );
      setMessage(text('不可变项目版本已创建。', 'Immutable version created.'));
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : text('版本创建失败。', 'Version failed.'),
      );
    }
  };
  const importProject = async (file?: File) => {
    if (!file) return;
    if (file.size > 4_000_000) {
      setError(text('项目文件不能超过 4 MB。', 'File must not exceed 4 MB.'));
      return;
    }
    await execute('import-project', {
      fileName: file.name,
      content: await file.text(),
    });
    if (importInput.current) importInput.current.value = '';
  };
  const selectStoredProject = (id: string) => {
    setProjectId(id);
    const savedProject = projects.find((item) => item.id === id);
    if (!savedProject) {
      setWorkspaceTitle('科研项目协同工作区');
      setResult(sampleResult());
      return;
    }
    const saved = savedProject.state.projectWorkspace as
      | { result?: ProjectResult }
      | undefined;
    if (saved?.result?.schema === 'skyview-project-workspace-results') {
      setWorkspaceTitle(savedProject.title);
      setResult(saved.result);
    }
  };
  const selectPortfolioProject = async (id: string) => {
    await execute('select-project', { projectId: id });
  };
  const moveTask = async (taskId: string, direction: number) => {
    const task = result.portfolio.tasks.find((item) => item.id === taskId);
    if (!task) return;
    const index = statusOrder.indexOf(task.status);
    const status =
      statusOrder[
        Math.max(0, Math.min(statusOrder.length - 1, index + direction))
      ];
    await execute('move-task', {
      taskId,
      status,
      progress: status === 'done' ? 100 : task.progress,
    });
  };
  const createTask = async () => {
    if (!taskTitle.trim()) return;
    const output = await execute('create-task', {
      title: taskTitle,
      priority: taskPriority,
      ownerIds: taskOwnerId ? [taskOwnerId] : [],
      cycleId: result.analysis.currentProject.cycleId,
      dueDate: result.analysis.currentProject.deadline,
      storyPoints: 3,
    });
    if (output) setTaskTitle('');
  };

  const current = result.analysis.currentProject;
  const selectedTask =
    result.portfolio.tasks.find(
      (item) => item.id === selectedTaskId && item.projectId === current.id,
    ) ?? result.analysis.taskList[0];
  const memberById = useMemo(
    () =>
      new Map(result.portfolio.members.map((member) => [member.id, member])),
    [result.portfolio.members],
  );
  const latestComments = result.portfolio.comments.filter(
    (item) =>
      item.projectId === current.id &&
      (!selectedTask || item.taskId === selectedTask.id),
  );

  return (
    <div className="projectx-workbench">
      <header className="projectx-commandbar">
        <div className="projectx-workspace-select">
          <FolderKanban />
          <select
            aria-label={text('选择保存的工作区', 'Select saved workspace')}
            value={projectId}
            onChange={(event) => selectStoredProject(event.target.value)}
          >
            <option value="">
              {text('当前本地工作区', 'Current local workspace')}
            </option>
            {projects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
          <Input
            aria-label={text('工作区名称', 'Workspace name')}
            value={workspaceTitle}
            onChange={(event) => setWorkspaceTitle(event.target.value)}
          />
          <span className={`projectx-health ${current.health}`}>
            {current.health === 'at-risk'
              ? text('需要关注', 'At risk')
              : current.health === 'complete'
                ? text('已完成', 'Complete')
                : text('进展正常', 'On track')}
          </span>
        </div>
        <div className="projectx-actions">
          <input
            ref={importInput}
            type="file"
            hidden
            accept="application/json,.json"
            onChange={(event) => importProject(event.target.files?.[0])}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => importInput.current?.click()}
            disabled={running}
          >
            <Upload />
            {text('导入', 'Import')}
          </Button>
          <Button variant="outline" size="sm" onClick={createVersion}>
            <FileArchive />
            {text('建版本', 'Version')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={saveWorkspace}
            disabled={saving}
          >
            <Save />
            {saving ? text('保存中', 'Saving') : text('保存', 'Save')}
          </Button>
          <Button
            size="sm"
            onClick={() => execute('validate')}
            disabled={running}
          >
            <ShieldCheck />
            {running
              ? text('处理中', 'Running')
              : text('完整校验', 'Validate all')}
          </Button>
        </div>
      </header>

      <div className="projectx-metricbar">
        {[
          [
            text('整体进度', 'Progress'),
            `${result.analysis.metrics.progress}%`,
            `${result.analysis.metrics.donePoints}/${result.analysis.metrics.totalPoints} ${text('点', 'pts')}`,
          ],
          [
            text('未结任务', 'Open tasks'),
            result.analysis.metrics.openTasks,
            `${result.analysis.metrics.blockedTasks} ${text('项受阻', 'blocked')}`,
          ],
          [
            text('逾期任务', 'Overdue'),
            result.analysis.metrics.overdueTasks,
            text('按截止日期', 'By due date'),
          ],
          [
            text('团队成员', 'Members'),
            result.analysis.metrics.activeMembers,
            text('按角色授权', 'Role controlled'),
          ],
          [
            text('里程碑', 'Milestones'),
            `${result.analysis.metrics.milestoneProgress}%`,
            `${result.analysis.milestones.length} ${text('个节点', 'items')}`,
          ],
        ].map(([label, value, detail]) => (
          <article key={String(label)}>
            <span>{label}</span>
            <strong>{value}</strong>
            <small>{detail}</small>
          </article>
        ))}
      </div>

      <nav className="projectx-tabs">
        {views.map(([id, zh, en]) => (
          <button
            key={id}
            type="button"
            className={view === id ? 'active' : ''}
            onClick={() => setView(id)}
          >
            {id === 'overview' ? (
              <FolderKanban />
            ) : id === 'board' ? (
              <ListChecks />
            ) : id === 'schedule' ? (
              <CalendarDays />
            ) : id === 'team' ? (
              <UsersRound />
            ) : (
              <Milestone />
            )}
            {text(zh, en)}
          </button>
        ))}
      </nav>
      {(message || error) && (
        <div className={`projectx-message ${error ? 'error' : ''}`}>
          {error || message}
        </div>
      )}

      <main className="projectx-stage">
        {view === 'overview' && (
          <div className="projectx-overview-grid">
            <section className="projectx-panel projectx-portfolio">
              <header>
                <div>
                  <span>{text('项目集', 'Portfolio')}</span>
                  <h3>{result.portfolio.name}</h3>
                </div>
                <Button
                  size="xs"
                  onClick={() =>
                    execute('create-project', {
                      title: text('新建研究项目', 'New research project'),
                      objective: text(
                        '请补充项目目标。',
                        'Add project objective.',
                      ),
                    })
                  }
                >
                  <Plus />
                  {text('新项目', 'New')}
                </Button>
              </header>
              <div className="projectx-project-list">
                {result.portfolio.projects.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    className={`${item.id === current.id ? 'active' : ''} ${item.status === 'archived' ? 'archived' : ''}`}
                    onClick={() => selectPortfolioProject(item.id)}
                  >
                    <span>
                      <b>{item.code}</b>
                      <small>
                        {item.status === 'archived'
                          ? text('已归档', 'Archived')
                          : item.deadline}
                      </small>
                    </span>
                    <strong>{item.title}</strong>
                    <i>{item.objective}</i>
                  </button>
                ))}
              </div>
            </section>
            <section className="projectx-panel projectx-brief">
              <header>
                <div>
                  <span>{current.code}</span>
                  <h3>{current.title}</h3>
                </div>
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() =>
                    execute(
                      current.status === 'archived'
                        ? 'restore-project'
                        : 'archive-project',
                    )
                  }
                >
                  <ArchiveRestore />
                  {current.status === 'archived'
                    ? text('恢复', 'Restore')
                    : text('归档', 'Archive')}
                </Button>
              </header>
              <p>{current.objective}</p>
              <div className="projectx-brief-row">
                <span>
                  {text('截止', 'Due')}
                  <strong>{current.deadline}</strong>
                </span>
                <span>
                  {text('当前迭代', 'Cycle')}
                  <strong>
                    {result.portfolio.cycles.find(
                      (item) => item.id === current.cycleId,
                    )?.name ?? '—'}
                  </strong>
                </span>
                <span>
                  {text('版本', 'Version')}
                  <strong>{result.portfolio.version}</strong>
                </span>
              </div>
              <div className="projectx-status-strip">
                {result.portfolio.statuses.map((status) => (
                  <span key={status.id}>
                    <i className={`status-${status.id}`} />
                    {locale === 'zh' ? status.name : status.id}
                    <b>{result.analysis.statusCounts[status.id] ?? 0}</b>
                  </span>
                ))}
              </div>
            </section>
            <section className="projectx-panel projectx-burndown">
              <header>
                <div>
                  <span>{text('迭代分析', 'Iteration analytics')}</span>
                  <h3>{text('故事点燃尽', 'Story-point burndown')}</h3>
                </div>
                <span className="projectx-legend">
                  <i />
                  {text('实际', 'Actual')}
                  <i />
                  {text('理想', 'Ideal')}
                </span>
              </header>
              <BurndownChart rows={result.analysis.burndown} />
            </section>
            <section className="projectx-panel projectx-milestone-mini">
              <header>
                <div>
                  <span>{text('关键节点', 'Key milestones')}</span>
                  <h3>{text('里程碑进度', 'Milestone progress')}</h3>
                </div>
              </header>
              <div>
                {result.analysis.milestones.map((item) => (
                  <article key={item.id}>
                    <span>
                      <b>{item.title}</b>
                      <small>{item.dueDate}</small>
                    </span>
                    <div>
                      <i style={{ width: `${item.progress}%` }} />
                    </div>
                    <strong>{item.progress}%</strong>
                  </article>
                ))}
              </div>
            </section>
          </div>
        )}

        {view === 'board' && (
          <div className="projectx-board-view">
            <section className="projectx-create-row">
              <Input
                placeholder={text('输入任务名称', 'Task title')}
                value={taskTitle}
                onChange={(event) => setTaskTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void createTask();
                }}
              />
              <select
                value={taskOwnerId}
                onChange={(event) => setTaskOwnerId(event.target.value)}
              >
                {result.portfolio.members
                  .filter((member) => current.memberIds.includes(member.id))
                  .map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.name}
                    </option>
                  ))}
              </select>
              <select
                value={taskPriority}
                onChange={(event) => setTaskPriority(event.target.value)}
              >
                <option value="critical">{text('紧急', 'Critical')}</option>
                <option value="high">{text('高优先级', 'High')}</option>
                <option value="medium">{text('中优先级', 'Medium')}</option>
                <option value="low">{text('低优先级', 'Low')}</option>
              </select>
              <Button
                onClick={createTask}
                disabled={running || !taskTitle.trim()}
              >
                <Plus />
                {text('添加任务', 'Add task')}
              </Button>
            </section>
            <div className="projectx-board">
              {result.analysis.board.map((column) => (
                <section
                  key={column.status}
                  className={`column-${column.status}`}
                >
                  <header>
                    <span>
                      <i />
                      {locale === 'zh' ? column.name : column.status}
                    </span>
                    <b>{column.tasks.length}</b>
                  </header>
                  <div>
                    {column.tasks.map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        result={result}
                        text={text}
                        move={moveTask}
                        select={setSelectedTaskId}
                      />
                    ))}
                    {column.tasks.length === 0 && (
                      <p>{text('暂无任务', 'No tasks')}</p>
                    )}
                  </div>
                </section>
              ))}
            </div>
          </div>
        )}

        {view === 'schedule' && (
          <div className="projectx-schedule-grid">
            <section className="projectx-panel projectx-task-table">
              <header>
                <div>
                  <span>{text('密集列表', 'Dense list')}</span>
                  <h3>
                    {text(
                      '任务、依赖与责任人',
                      'Tasks, dependencies and owners',
                    )}
                  </h3>
                </div>
                <b>{result.analysis.taskList.length}</b>
              </header>
              <div className="projectx-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>{text('编号', 'Key')}</th>
                      <th>{text('任务', 'Task')}</th>
                      <th>{text('状态', 'Status')}</th>
                      <th>{text('负责人', 'Owner')}</th>
                      <th>{text('截止', 'Due')}</th>
                      <th>{text('进度', 'Progress')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.analysis.taskList.map((task) => (
                      <tr
                        key={task.id}
                        className={task.id === selectedTask?.id ? 'active' : ''}
                        onClick={() => setSelectedTaskId(task.id)}
                      >
                        <td>
                          <b>{task.key}</b>
                        </td>
                        <td>
                          {task.title}
                          <small>
                            {task.dependencyIds.length
                              ? `${text('依赖', 'Depends on')} ${task.dependencyIds.length}`
                              : ''}
                          </small>
                        </td>
                        <td>
                          <span
                            className={`projectx-status status-${task.status}`}
                          >
                            {locale === 'zh'
                              ? result.portfolio.statuses.find(
                                  (item) => item.id === task.status,
                                )?.name
                              : task.status}
                          </span>
                        </td>
                        <td>
                          {task.ownerIds
                            .map((id) => memberById.get(id)?.name)
                            .filter(Boolean)
                            .join('、') || '—'}
                        </td>
                        <td>{task.dueDate || '—'}</td>
                        <td>{task.progress}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            <section className="projectx-panel projectx-gantt">
              <header>
                <div>
                  <span>{text('时间线', 'Timeline')}</span>
                  <h3>
                    {text('计划跨度与交付窗口', 'Schedule and delivery window')}
                  </h3>
                </div>
                <GitBranch />
              </header>
              <div className="projectx-gantt-head">
                <span>08/31</span>
                <span>09/07</span>
                <span>09/14</span>
                <span>09/21</span>
                <span>09/28</span>
              </div>
              <div className="projectx-gantt-body">
                {result.analysis.timeline.map((task) => {
                  const start = Math.max(
                    0,
                    (new Date(task.startDate).getTime() -
                      new Date('2026-08-31').getTime()) /
                      86400000,
                  );
                  const length = Math.max(
                    1,
                    (new Date(task.dueDate).getTime() -
                      new Date(task.startDate).getTime()) /
                      86400000,
                  );
                  return (
                    <div key={task.id}>
                      <b>{task.key}</b>
                      <span>
                        <i
                          className={`status-${task.status}`}
                          style={{
                            left: `${Math.min(88, (start / 28) * 100)}%`,
                            width: `${Math.max(7, Math.min(100 - (start / 28) * 100, (length / 28) * 100))}%`,
                          }}
                        >
                          {task.progress}%
                        </i>
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          </div>
        )}

        {view === 'team' && (
          <div className="projectx-team-grid">
            <section className="projectx-panel projectx-members">
              <header>
                <div>
                  <span>{text('成员与权限', 'Members & roles')}</span>
                  <h3>{text('团队负载', 'Team workload')}</h3>
                </div>
                <Button
                  size="xs"
                  onClick={() =>
                    execute('add-member', {
                      name: text('新成员', 'New member'),
                      email: 'member@example.edu.cn',
                      role: 'member',
                    })
                  }
                >
                  <Plus />
                  {text('成员', 'Member')}
                </Button>
              </header>
              <div>
                {result.analysis.memberLoad.map((item) => (
                  <article key={item.memberId}>
                    <span className="projectx-avatar">
                      {item.name.slice(0, 1)}
                    </span>
                    <div>
                      <b>
                        {item.name}
                        <small>
                          {item.role === 'owner'
                            ? text('负责人', 'Owner')
                            : item.role === 'maintainer'
                              ? text('维护者', 'Maintainer')
                              : text('成员', 'Member')}
                        </small>
                      </b>
                      <span>
                        <i
                          style={{
                            width: `${Math.min(100, item.utilization)}%`,
                          }}
                        />
                      </span>
                    </div>
                    <strong className={item.utilization > 100 ? 'over' : ''}>
                      {item.points}/{item.capacity}
                    </strong>
                  </article>
                ))}
              </div>
            </section>
            <section className="projectx-panel projectx-collaboration">
              <header>
                <div>
                  <span>{text('任务协作', 'Task collaboration')}</span>
                  <h3>
                    {selectedTask
                      ? `${selectedTask.key} · ${selectedTask.title}`
                      : text('选择任务', 'Select a task')}
                  </h3>
                </div>
                <MessageSquareText />
              </header>
              {selectedTask && (
                <>
                  <div className="projectx-selected-task">
                    <span>
                      {text('责任人', 'Owners')}
                      <b>
                        {selectedTask.ownerIds
                          .map((id) => memberById.get(id)?.name)
                          .join('、')}
                      </b>
                    </span>
                    <span>
                      {text('依赖', 'Dependencies')}
                      <b>{selectedTask.dependencyIds.length}</b>
                    </span>
                    <span>
                      {text('附件', 'Attachments')}
                      <b>
                        {
                          result.portfolio.attachments.filter(
                            (item) => item.taskId === selectedTask.id,
                          ).length
                        }
                      </b>
                    </span>
                  </div>
                  <div className="projectx-comment-form">
                    <Input
                      value={comment}
                      onChange={(event) => setComment(event.target.value)}
                      placeholder={text(
                        '记录决定、问题或复核意见',
                        'Add a decision, issue or review note',
                      )}
                    />
                    <Button
                      onClick={async () => {
                        const output = await execute('add-comment', {
                          taskId: selectedTask.id,
                          body: comment,
                          authorId: current.ownerId,
                        });
                        if (output) setComment('');
                      }}
                      disabled={!comment.trim()}
                    >
                      {text('评论', 'Comment')}
                    </Button>
                  </div>
                  <div className="projectx-comments">
                    {latestComments.map((item) => (
                      <article key={item.id}>
                        <span className="projectx-avatar">
                          {memberById.get(item.authorId)?.name.slice(0, 1) ??
                            '成'}
                        </span>
                        <div>
                          <b>
                            {memberById.get(item.authorId)?.name ??
                              text('成员', 'Member')}
                            <small>
                              {new Date(item.time).toLocaleString(locale)}
                            </small>
                          </b>
                          <p>{item.body}</p>
                        </div>
                      </article>
                    ))}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      execute('add-attachment', {
                        taskId: selectedTask.id,
                        name: 'evidence_manifest.csv',
                        size: 0,
                        contentType: 'text/csv',
                      })
                    }
                  >
                    <Paperclip />
                    {text('登记附件元数据', 'Register attachment metadata')}
                  </Button>
                </>
              )}
            </section>
            <section className="projectx-panel projectx-activity">
              <header>
                <div>
                  <span>{text('服务端事件', 'Server events')}</span>
                  <h3>{text('最近活动与审计', 'Recent activity and audit')}</h3>
                </div>
                <b>{result.portfolio.activities.length}</b>
              </header>
              <div>
                {result.portfolio.activities.slice(0, 12).map((item) => (
                  <article key={item.id}>
                    <i />
                    <div>
                      <b>{item.text}</b>
                      <span>
                        {item.actor} ·{' '}
                        {new Date(item.time).toLocaleString(locale)}
                      </span>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          </div>
        )}

        {view === 'delivery' && (
          <div className="projectx-delivery-grid">
            <section className="projectx-panel projectx-milestones">
              <header>
                <div>
                  <span>{text('阶段验收', 'Stage reviews')}</span>
                  <h3>{text('里程碑', 'Milestones')}</h3>
                </div>
                <Button
                  size="xs"
                  onClick={() =>
                    execute('create-milestone', {
                      title: text('新增验收节点', 'New review gate'),
                      dueDate: current.deadline,
                      ownerId: current.ownerId,
                    })
                  }
                >
                  <Plus />
                  {text('里程碑', 'Milestone')}
                </Button>
              </header>
              <div>
                {result.analysis.milestones.map((item) => (
                  <article key={item.id}>
                    <button
                      type="button"
                      aria-label={text('更新里程碑', 'Update milestone')}
                      onClick={() =>
                        execute('update-milestone', {
                          milestoneId: item.id,
                          status: item.progress >= 100 ? 'active' : 'done',
                          progress: item.progress >= 100 ? 75 : 100,
                        })
                      }
                    >
                      {item.progress >= 100 ? <CheckCircle2 /> : <Milestone />}
                    </button>
                    <div>
                      <b>{item.title}</b>
                      <span>
                        {text('计划日期', 'Due')} {item.dueDate} ·{' '}
                        {memberById.get(item.ownerId)?.name}
                      </span>
                      <i>
                        <em style={{ width: `${item.progress}%` }} />
                      </i>
                    </div>
                    <strong>{item.progress}%</strong>
                  </article>
                ))}
              </div>
            </section>
            <section className="projectx-panel projectx-notes">
              <header>
                <div>
                  <span>{text('版本化记录', 'Versioned notes')}</span>
                  <h3>{text('阶段笔记', 'Stage notes')}</h3>
                </div>
                <small>
                  {text('每次保存生成新修订', 'Each save creates a revision')}
                </small>
              </header>
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
              <Button
                size="sm"
                onClick={() =>
                  execute('update-note', {
                    body: note,
                    authorId: current.ownerId,
                  })
                }
              >
                <Save />
                {text('保存新修订', 'Save revision')}
              </Button>
              <div className="projectx-note-history">
                {result.portfolio.noteRevisions
                  .filter((item) => item.projectId === current.id)
                  .slice(0, 4)
                  .map((item) => (
                    <span key={item.id}>
                      <b>v{item.revision}</b>
                      {new Date(item.time).toLocaleString(locale)}
                    </span>
                  ))}
              </div>
            </section>
            <section className="projectx-panel projectx-quality">
              <header>
                <div>
                  <span>{text('交付门禁', 'Delivery gates')}</span>
                  <h3>{text('质量检查', 'Quality checks')}</h3>
                </div>
                <ShieldCheck />
              </header>
              <div>
                {result.analysis.qualityChecks.map((item) => (
                  <article
                    key={item.label}
                    className={item.passed ? 'passed' : 'failed'}
                  >
                    {item.passed ? <CheckCircle2 /> : <CircleAlert />}
                    <span>{item.label}</span>
                    <b>
                      {item.passed
                        ? text('通过', 'Passed')
                        : text('待处理', 'Action needed')}
                    </b>
                  </article>
                ))}
              </div>
            </section>
            <section className="projectx-panel projectx-exports">
              <header>
                <div>
                  <span>{text('成果交付', 'Deliverables')}</span>
                  <h3>
                    {text(
                      '导出与可恢复版本',
                      'Exports and restorable versions',
                    )}
                  </h3>
                </div>
                <Download />
              </header>
              <div className="projectx-export-buttons">
                <Button
                  variant="outline"
                  onClick={() =>
                    downloadText(
                      result.exports.tasksCsv,
                      'project-tasks.csv',
                      'text/csv;charset=utf-8',
                    )
                  }
                  disabled={!result.exports.tasksCsv}
                >
                  {text('任务表', 'Tasks CSV')}
                </Button>
                <Button
                  variant="outline"
                  onClick={() =>
                    downloadText(
                      result.exports.calendarIcs,
                      'project-calendar.ics',
                      'text/calendar;charset=utf-8',
                    )
                  }
                  disabled={!result.exports.calendarIcs}
                >
                  {text('日历', 'Calendar')}
                </Button>
                <Button
                  variant="outline"
                  onClick={() =>
                    downloadText(
                      result.exports.reportMarkdown,
                      'project-report.md',
                      'text/markdown;charset=utf-8',
                    )
                  }
                  disabled={!result.exports.reportMarkdown}
                >
                  {text('状态报告', 'Status report')}
                </Button>
                <Button
                  onClick={() =>
                    result.exports.packageBase64
                      ? downloadBase64(
                          result.exports.packageBase64,
                          'skyview-project-package.zip',
                        )
                      : execute('export')
                  }
                >
                  {result.exports.packageBase64
                    ? text('完整交付包', 'Full package')
                    : text('生成交付包', 'Build package')}
                </Button>
              </div>
              <div className="projectx-snapshot-row">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    execute('create-snapshot', {
                      label: `${current.title} · v${result.portfolio.version}`,
                    })
                  }
                >
                  <FileArchive />
                  {text('创建恢复点', 'Create restore point')}
                </Button>
                <span>
                  {result.portfolio.snapshots
                    .filter((item) => item.projectId === current.id)
                    .map((item) => (
                      <button
                        type="button"
                        key={item.id}
                        onClick={() =>
                          execute('restore-snapshot', { snapshotId: item.id })
                        }
                      >
                        {item.label} · v{item.version}
                      </button>
                    ))}
                </span>
              </div>
              <div className="projectx-runtime">
                <span>
                  <i className="enabled" />
                  {text('项目作业与版本', 'Project jobs & versions')}
                </span>
                <span>
                  <i className="enabled" />
                  {text('Python 组合分析', 'Python analytics')}
                </span>
                <span>
                  <i />
                  {text('对象存储待配置', 'Object storage unconfigured')}
                </span>
                <span>
                  <i />
                  {text(
                    '外部项目适配待配置',
                    'External project adapter unconfigured',
                  )}
                </span>
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
