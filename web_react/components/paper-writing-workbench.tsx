'use client';

/* oxlint-disable jsx-a11y/label-has-associated-control, jsx-a11y/control-has-associated-label -- Base UI Input/Textarea controls are nested inside their visible labels. */

import { useEffect, useMemo, useState } from 'react';
import {
  ArchiveRestore,
  BookOpenCheck,
  Check,
  ChevronRight,
  ClipboardCheck,
  Download,
  FileArchive,
  FileCheck2,
  FileText,
  History,
  LibraryBig,
  LoaderCircle,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
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
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/services/api/client';
import {
  toolApi,
  type WorkbenchJob,
  type WorkbenchProject,
} from '@/services/api/tools';

type StageRecord = {
  id: string;
  status: string;
  attempts: number;
  completedAt: string | null;
  confirmedAt: string | null;
  note: string;
  deliverables: string[];
};
type PaperSection = {
  id: string;
  name: string;
  content: string;
  status: string;
  updatedAt: string;
};
type Reference = {
  id: string;
  key: string;
  type: string;
  title: string;
  authors: string;
  year: string;
  venue: string;
  doi: string;
  url: string;
  status: string;
  verification: string;
  locator: string;
  notes: string;
  source?: string;
  addedAt: string;
};
type Claim = {
  id: string;
  text: string;
  type: string;
  sectionId: string;
  referenceKeys: string[];
  experimentIds: string[];
  locator: string;
  status: string;
  notes: string;
  createdAt: string;
};
type Experiment = {
  id: string;
  name: string;
  dataVersion: string;
  method: string;
  output: string;
  status: string;
  verifier: string;
  createdAt: string;
};
type Asset = {
  id: string;
  name: string;
  kind: string;
  source: string;
  sectionId: string;
  verified: boolean;
  notes: string;
  createdAt: string;
};
type Finding = {
  id: string;
  severity: string;
  sectionId?: string;
  issue: string;
  recommendation: string;
  evidence?: string;
  status: string;
};
type Review = {
  id: string;
  round: number;
  type: string;
  reports: Array<{
    id: string;
    roleId: string;
    role: string;
    score: number;
    findings: Finding[];
  }>;
  decision: string;
  roadmap: RevisionItem[];
  createdAt: string;
  manuscriptHash: string;
};
type RevisionItem = {
  id: string;
  order: number;
  sourceFindingId: string;
  severity: string;
  issue: string;
  action: string;
  sectionId: string;
  response: string;
  status: string;
  evidence: string;
};
type IntegrityRun = {
  id: string;
  phase: string;
  createdAt: string;
  pass: boolean;
  score: number;
  issues: Array<{
    id: string;
    severity: string;
    category: string;
    message: string;
    action: string;
    evidence: string;
  }>;
  stats: Record<string, number>;
  failureModes: Array<{ id: string; name: string; status: string }>;
  manuscriptHash: string;
};
type Snapshot = {
  id: string;
  label: string;
  createdAt: string;
  words: number;
  hash: string;
  sections: PaperSection[];
  references: Reference[];
  claims: Claim[];
};

type PaperProject = {
  id: string;
  schema: 'skyview-ars-paper';
  schemaVersion: number;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  currentStage: string;
  stageRecords: StageRecord[];
  activeSection: string;
  config: {
    mode: string;
    paperType: string;
    language: string;
    citationStyle: string;
    wordTarget: number;
    discipline: string;
    targetJournal: string;
    authors: string;
    affiliations: string;
    correspondingAuthor: string;
    keywords: string;
  };
  framing: Record<string, string>;
  methodology: Record<string, string>;
  outline: Array<{
    sectionId: string;
    heading: string;
    purpose: string;
    evidenceKeys: string[];
    status: string;
  }>;
  sections: PaperSection[];
  references: Reference[];
  claims: Claim[];
  experiments: Experiment[];
  assets: Asset[];
  integrityRuns: IntegrityRun[];
  reviews: Review[];
  revisionItems: RevisionItem[];
  snapshots: Snapshot[];
  decisions: Array<{
    id: string;
    stageId: string;
    action: string;
    note: string;
    createdAt: string;
    override: boolean;
  }>;
  activities: Array<{
    id: string;
    type: string;
    message: string;
    createdAt: string;
  }>;
  disclosure: {
    usedAI: boolean;
    tools: string;
    purpose: string;
    humanVerification: string;
    text: string;
  };
  finalization: {
    selectedStyle: string;
    formats: string[];
    finalizedAt: string | null;
    coverLetter: string;
    processRecord: string;
  };
};

type ExportBundle = {
  markdown: string;
  html: string;
  latex: string;
  bibtex: string;
  passportJson: string;
  processMarkdown: string;
  docxBase64: string;
  packageBase64: string;
  projectJson: string;
  files: Record<
    | 'markdown'
    | 'html'
    | 'latex'
    | 'bibtex'
    | 'passport'
    | 'process'
    | 'docx'
    | 'package'
    | 'project',
    string
  >;
};

const stages = [
  ['research', '1', '研究'],
  ['write', '2', '写作'],
  ['integrity_pre', '2.5', '完整性核验'],
  ['review', '3', '审稿'],
  ['revise', '4', '修订'],
  ['re_review', '3′', '复审'],
  ['re_revise', '4′', '再修订'],
  ['integrity_final', '4.5', '最终核验'],
  ['finalize', '5', '定稿'],
  ['process', '6', '过程总结'],
] as const;
const views = [
  ['dashboard', '生产总览', FileText],
  ['research', '研究设计', BookOpenCheck],
  ['evidence', '证据管理', LibraryBig],
  ['draft', '完整论文写作', Sparkles],
  ['integrity', '完整性核验', ShieldCheck],
  ['review', '五角色审稿', ClipboardCheck],
  ['revision', '修订响应', RefreshCw],
  ['finalize', '定稿交付', FileCheck2],
  ['process', '过程记录', History],
  ['settings', '项目设置', Settings],
] as const;
const stageView: Record<string, string> = {
  research: 'research',
  write: 'draft',
  integrity_pre: 'integrity',
  review: 'review',
  revise: 'revision',
  re_review: 'review',
  re_revise: 'revision',
  integrity_final: 'integrity',
  finalize: 'finalize',
  process: 'process',
};
const sectionDefinitions = [
  ['abstract', '摘要'],
  ['introduction', '1 引言'],
  ['literature', '2 相关研究'],
  ['materials', '3 数据与研究对象'],
  ['methods', '4 研究方法'],
  ['results', '5 结果'],
  ['discussion', '6 讨论'],
  ['conclusion', '7 结论'],
  ['declarations', '声明'],
];
const paperTypeSections: Record<string, string[][]> = {
  empirical: sectionDefinitions,
  review: [
    ['abstract', '摘要'],
    ['introduction', '1 引言'],
    ['review_method', '2 综述方法'],
    ['themes', '3 主题综合'],
    ['gaps', '4 证据缺口'],
    ['discussion', '5 讨论'],
    ['conclusion', '6 结论'],
    ['declarations', '声明'],
  ],
  theoretical: [
    ['abstract', '摘要'],
    ['introduction', '1 引言'],
    ['concepts', '2 核心概念'],
    ['framework', '3 理论框架'],
    ['propositions', '4 命题与论证'],
    ['implications', '5 理论与实践意义'],
    ['conclusion', '6 结论'],
    ['declarations', '声明'],
  ],
  case: [
    ['abstract', '摘要'],
    ['introduction', '1 引言'],
    ['case_context', '2 案例背景'],
    ['methods', '3 研究设计'],
    ['findings', '4 案例发现'],
    ['discussion', '5 讨论'],
    ['conclusion', '6 结论'],
    ['declarations', '声明'],
  ],
  policy: [
    ['executive', '执行摘要'],
    ['problem', '1 问题界定'],
    ['evidence', '2 证据基础'],
    ['options', '3 政策选项'],
    ['recommendation', '4 建议'],
    ['implementation', '5 实施与评估'],
    ['references', '参考文献'],
  ],
  conference: [
    ['abstract', '摘要'],
    ['introduction', '1 引言'],
    ['methods', '2 方法'],
    ['results', '3 结果'],
    ['discussion', '4 讨论'],
    ['conclusion', '5 结论'],
    ['declarations', '声明'],
  ],
};
const terminalStatuses = new Set(['succeeded', 'failed', 'canceled']);
const sampleQuestion =
  '多源监测数据的时间对齐与证据链记录如何影响滑坡预警结果的可复核性？';

function createLocalProject(
  title = '多源监测数据融合与滑坡预警证据链研究',
): PaperProject {
  const now = new Date().toISOString();
  const projectTitle = title.trim() || '未命名研究论文';
  const sections = sectionDefinitions.map(([id, name]) => ({
    id,
    name,
    content: '',
    status: 'empty',
    updatedAt: now,
  }));
  return {
    id: `paper-${crypto.randomUUID()}`,
    schema: 'skyview-ars-paper',
    schemaVersion: 1,
    title: projectTitle,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    currentStage: 'research',
    stageRecords: stages.map(([id], index) => ({
      id,
      status: index ? 'pending' : 'in_progress',
      attempts: 0,
      completedAt: null,
      confirmedAt: null,
      note: '',
      deliverables: [],
    })),
    activeSection: 'abstract',
    config: {
      mode: 'full',
      paperType: 'empirical',
      language: 'zh-CN',
      citationStyle: 'APA 7',
      wordTarget: 6000,
      discipline: '地质工程与监测',
      targetJournal: '',
      authors: '',
      affiliations: '',
      correspondingAuthor: '',
      keywords: '多源监测；滑坡预警；证据链；可复核性',
    },
    framing: {
      topic: '多源监测与滑坡预警',
      problem: '多源监测结果常因时间基准和记录口径不一致而难以复核。',
      significance: '提高预警结果的可解释性与工程交付可靠性。',
      gap: '现有流程较少同时记录时间对齐、数据版本、模型参数与结论证据关系。',
      question: sampleQuestion,
      hypothesis: '',
      objectives: '建立统一时间轴、证据矩阵与可追溯质量门禁。',
      contribution: '形成可复核的多源监测论文生产流程。',
      theory: '',
      scope: '露天矿与山地滑坡多源监测场景',
      exclusions: '不替代现场专家的安全决策。',
    },
    methodology: {
      design: '回顾性观测研究与消融对比',
      studyArea: '',
      population: '',
      sampling: '',
      sampleSize: '',
      period: '',
      dataSources: 'GNSS、降雨、微震与现场巡查记录；具体版本待作者登记。',
      variables: '',
      preprocessing: '统一时区、采样间隔与缺失值规则。',
      analysis: '比较不同时间对齐策略下的验证指标与误报情况。',
      validation: '时间切分验证、消融实验与敏感性分析。',
      software: '',
      ethics: '仅处理经授权的项目数据，个人信息字段应完成脱敏。',
      dataAvailability: '',
      limitations: '样本覆盖范围与传感器缺测可能限制外推。',
    },
    outline: sections.map((item) => ({
      sectionId: item.id,
      heading: item.name,
      purpose: '',
      evidenceKeys: [],
      status: 'planned',
    })),
    sections,
    references: [],
    claims: [],
    experiments: [],
    assets: [],
    integrityRuns: [],
    reviews: [],
    revisionItems: [],
    snapshots: [],
    decisions: [],
    activities: [],
    disclosure: {
      usedAI: true,
      tools: 'SkyViewLab 结构化写作引擎',
      purpose: '结构组织、完整性检查与修订清单',
      humanVerification: '作者逐项核对文献原文、数据、实验、图表与全部结论。',
      text: '作者使用 SkyViewLab 辅助组织稿件结构和检查记录完整性；所有事实、引文、分析结果与最终表述均由作者复核并承担责任。',
    },
    finalization: {
      selectedStyle: 'APA 7',
      formats: [],
      finalizedAt: null,
      coverLetter: '',
      processRecord: '',
    },
  };
}

function wait(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
async function waitForJob(id: string): Promise<WorkbenchJob | null> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const job = await toolApi.getJob(id);
    if (terminalStatuses.has(job.status)) return job;
    await wait(650);
  }
  return null;
}
function downloadText(content: string, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
function downloadBase64(content: string, filename: string, type: string) {
  const bytes = Uint8Array.from(atob(content), (character) =>
    character.charCodeAt(0),
  );
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
function words(value: string) {
  return (
    (value.match(/[\u3400-\u9fff]/g) ?? []).length +
    (
      value
        .replace(/[\u3400-\u9fff]/g, ' ')
        .match(/[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)*/g) ?? []
    ).length
  );
}
function stageStatus(value: string) {
  return value === 'completed'
    ? '已确认'
    : value === 'awaiting_confirmation'
      ? '待作者确认'
      : value === 'in_progress'
        ? '进行中'
        : '未开始';
}
function decisionLabel(value: string) {
  return (
    (
      {
        accept: '接收',
        minor: '小修',
        major: '大修',
        reject: '拒稿',
      } as Record<string, string>
    )[value] ?? value
  );
}

function LabeledTextarea({
  label,
  value,
  onChange,
  rows = 4,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
}) {
  return (
    <label className="paper-field">
      <span>{label}</span>
      <Textarea
        rows={rows}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export function PaperWritingWorkbench({
  executionAllowed = true,
}: {
  executionAllowed?: boolean;
}) {
  const [project, setProject] = useState<PaperProject>(() =>
    createLocalProject(),
  );
  const [projects, setProjects] = useState<WorkbenchProject[]>([]);
  const [projectId, setProjectId] = useState('');
  const [view, setView] = useState('dashboard');
  const [dialog, setDialog] = useState<'new' | 'bibtex' | 'crossref' | null>(
    null,
  );
  const [bibtex, setBibtex] = useState(
    '@article{Li2026,\n  title={Multi-source monitoring for slope safety},\n  author={Li, J. and Zhang, W.},\n  year={2026},\n  journal={Engineering Geology},\n  doi={https://doi.org/10.1000/example.01}\n}',
  );
  const [crossrefQuery, setCrossrefQuery] = useState(
    'multi-source landslide monitoring',
  );
  const [crossrefRows, setCrossrefRows] = useState<Reference[]>([]);
  const [newTitle, setNewTitle] = useState('未命名研究论文');
  const [reportIndex, setReportIndex] = useState(0);
  const [stageNote, setStageNote] = useState(
    '我已核对本阶段交付物，并确认进入下一阶段。',
  );
  const [running, setRunning] = useState(false);
  const [runningLabel, setRunningLabel] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    toolApi
      .listProjects('paper-writing')
      .then((items) => {
        if (!active) return;
        setProjects(items);
        const recent = items[0];
        const saved = recent?.state.paper as
          | { project?: PaperProject }
          | undefined;
        if (saved?.project?.schema === 'skyview-ars-paper') {
          setProject(saved.project);
          setProjectId(recent.id);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const manuscript = useMemo(
    () => project.sections.map((item) => item.content).join('\n\n'),
    [project.sections],
  );
  const activeSection =
    project.sections.find((item) => item.id === project.activeSection) ??
    project.sections[0];
  const currentRecord = project.stageRecords.find(
    (item) => item.id === project.currentStage,
  );
  const latestAudit =
    project.integrityRuns.find(
      (item) =>
        item.phase ===
        (project.currentStage === 'integrity_final' ||
        project.currentStage === 'finalize'
          ? 'final'
          : 'pre'),
    ) ?? project.integrityRuns[0];
  const latestReview = project.reviews[0];
  const activeReport =
    latestReview?.reports[
      Math.min(reportIndex, Math.max(0, latestReview.reports.length - 1))
    ];
  const completedStages = project.stageRecords.filter(
    (item) => item.status === 'completed',
  ).length;

  const ensureProject = async (current: PaperProject) => {
    const existing = projects.find((item) => item.id === projectId);
    if (existing) return existing;
    const created = await toolApi.createProject(
      'paper-writing',
      current.title,
      { paper: { project: current } },
    );
    setProjects((items) => [created, ...items]);
    setProjectId(created.id);
    return created;
  };
  const persist = async (
    next: PaperProject,
    record?: WorkbenchProject,
    label = '论文工作台快照',
  ) => {
    const target = record ?? (await ensureProject(next));
    const saved = await toolApi.updateProject(target.id, next.title, {
      paper: { project: next },
    });
    await toolApi.createVersion(
      saved.id,
      `${label} ${new Date().toLocaleString('zh-CN')}`,
      saved.state,
    );
    setProjects((items) => [
      saved,
      ...items.filter((item) => item.id !== saved.id),
    ]);
    setProjectId(saved.id);
    return saved;
  };
  const run = async (
    action: string,
    input: Record<string, unknown>,
    label: string,
  ) => {
    if (!executionAllowed) throw new Error('服务暂未连接，请稍后重试。');
    setRunning(true);
    setRunningLabel(label);
    setError('');
    setMessage('');
    try {
      const record = await ensureProject(project);
      const created = await toolApi.createJob(
        record.id,
        'paper-writing',
        action,
        input,
        crypto.randomUUID(),
      );
      const job = await waitForJob(created.job.id);
      if (!job) throw new Error('任务仍在后台处理，请稍后重新打开项目。');
      if (job.status !== 'succeeded')
        throw new Error(job.error || '任务执行失败。');
      return { output: job.result, record };
    } finally {
      setRunning(false);
      setRunningLabel('');
    }
  };
  const applyServerProject = async (
    action: string,
    input: Record<string, unknown>,
    label: string,
    success: string,
  ) => {
    try {
      const { output, record } = await run(
        action,
        { project, ...input },
        label,
      );
      const next = output.project as PaperProject;
      if (!next) throw new Error('服务未返回项目状态。');
      setProject(next);
      await persist(next, record, success);
      setMessage(success);
      return output;
    } catch (caught) {
      setError(
        caught instanceof ApiError || caught instanceof Error
          ? caught.message
          : '操作失败。',
      );
      return null;
    }
  };
  const patchProject = (patch: Partial<PaperProject>) =>
    setProject((current) => ({
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    }));
  const patchNested = (
    target: 'framing' | 'methodology' | 'config' | 'disclosure',
    key: string,
    value: string | boolean | number,
  ) =>
    setProject((current) => ({
      ...current,
      [target]: { ...current[target], [key]: value },
      updatedAt: new Date().toISOString(),
    }));
  const save = async () => {
    try {
      await persist(project, undefined, '作者保存');
      setMessage('项目与版本记录已保存。');
      setError('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '保存失败。');
    }
  };
  const openProject = (id: string) => {
    const record = projects.find((item) => item.id === id);
    const saved = record?.state.paper as { project?: PaperProject } | undefined;
    if (!record || !saved?.project) return;
    setProjectId(id);
    setProject(saved.project);
    setView('dashboard');
    setMessage('');
    setError('');
  };
  const createNew = () => {
    setProject(createLocalProject(newTitle));
    setProjectId('');
    setView('dashboard');
    setDialog(null);
    setMessage('新论文已建立，请保存研究设计。');
  };
  const changePaperType = (paperType: string) => {
    const definitions =
      paperTypeSections[paperType] ?? paperTypeSections.empirical;
    const now = new Date().toISOString();
    const sections = definitions.map(
      ([id, name]) =>
        project.sections.find((item) => item.id === id) ?? {
          id,
          name,
          content: '',
          status: 'empty',
          updatedAt: now,
        },
    );
    patchProject({
      config: { ...project.config, paperType },
      sections,
      outline: sections.map(
        (item) =>
          project.outline.find((row) => row.sectionId === item.id) ?? {
            sectionId: item.id,
            heading: item.name,
            purpose: '',
            evidenceKeys: [],
            status: 'planned',
          },
      ),
      activeSection: sections[0].id,
    });
  };
  const importBibtex = async () => {
    const output = await applyServerProject(
      'bibtex-import',
      { bibtex },
      '正在解析并去重 BibTeX',
      'BibTeX 文献已导入并保存。',
    );
    if (output) setDialog(null);
  };
  const searchCrossref = async () => {
    try {
      const { output } = await run(
        'crossref-search',
        { project, query: crossrefQuery },
        '正在通过服务端检索 Crossref',
      );
      setCrossrefRows((output.records as Reference[]) ?? []);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'Crossref 检索失败。',
      );
    }
  };
  const addCrossref = (reference: Reference) => {
    if (
      project.references.some((item) => item.doi && item.doi === reference.doi)
    ) {
      setError('该 DOI 已在证据库中。');
      return;
    }
    patchProject({ references: [...project.references, reference] });
    setMessage('已加入候选库；引用前请阅读并核验原文。');
  };
  const addClaim = () =>
    patchProject({
      claims: [
        ...project.claims,
        {
          id: `claim-${crypto.randomUUID()}`,
          text: '填写需要证据支持的核心论断',
          type: 'factual',
          sectionId: project.activeSection,
          referenceKeys: [],
          experimentIds: [],
          locator: '',
          status: 'draft',
          notes: '',
          createdAt: new Date().toISOString(),
        },
      ],
    });
  const addExperiment = () =>
    patchProject({
      experiments: [
        ...project.experiments,
        {
          id: `experiment-${crypto.randomUUID()}`,
          name: '新实验记录',
          dataVersion: '',
          method: '',
          output: '',
          status: 'unverified',
          verifier: '',
          createdAt: new Date().toISOString(),
        },
      ],
    });
  const addAsset = () =>
    patchProject({
      assets: [
        ...project.assets,
        {
          id: `asset-${crypto.randomUUID()}`,
          name: '图 1',
          kind: 'figure',
          source: '',
          sectionId: project.activeSection,
          verified: false,
          notes: '',
          createdAt: new Date().toISOString(),
        },
      ],
    });
  const adoptRoadmap = async () => {
    if (latestReview)
      await applyServerProject(
        'adopt-roadmap',
        { reviewId: latestReview.id },
        '正在建立修订路线图',
        '修订路线图已建立。',
      );
  };
  const prepareStage = async () => {
    await applyServerProject(
      'prepare-stage',
      { stageId: project.currentStage },
      '正在检查阶段交付物',
      '本阶段已提交作者确认。',
    );
  };
  const confirmStage = async () => {
    const output = await applyServerProject(
      'confirm-stage',
      { stageId: project.currentStage, note: stageNote },
      '正在记录作者确认',
      '阶段已确认，流水线已进入下一阶段。',
    );
    if (output?.project)
      setView(
        stageView[(output.project as PaperProject).currentStage] ?? 'dashboard',
      );
  };
  const exportFile = async (kind: keyof ExportBundle['files']) => {
    try {
      const { output } = await run(
        'export',
        { project },
        '正在生成论文交付文件',
      );
      const bundle = output as ExportBundle;
      if (kind === 'docx')
        downloadBase64(
          bundle.docxBase64,
          bundle.files.docx,
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        );
      else if (kind === 'package')
        downloadBase64(
          bundle.packageBase64,
          bundle.files.package,
          'application/zip',
        );
      else {
        const values: Record<string, string> = {
          markdown: bundle.markdown,
          html: bundle.html,
          latex: bundle.latex,
          bibtex: bundle.bibtex,
          passport: bundle.passportJson,
          process: bundle.processMarkdown,
          project: bundle.projectJson,
        };
        const types: Record<string, string> = {
          html: 'text/html;charset=utf-8',
          passport: 'application/json;charset=utf-8',
          project: 'application/json;charset=utf-8',
        };
        downloadText(
          values[kind],
          bundle.files[kind],
          types[kind] ?? 'text/plain;charset=utf-8',
        );
      }
      setMessage(`${bundle.files[kind]} 已导出。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '导出失败。');
    }
  };

  return (
    <section className="paper-workbench" data-paper-writing-workbench>
      <header className="paper-topbar">
        <div>
          <span className="paper-brand">论文研究工作台</span>
          <strong>AI 辅助论文写作</strong>
          <small>十阶段研究与审稿流水线</small>
        </div>
        <div className="paper-project-actions">
          <NativeSelect
            aria-label="当前论文项目"
            value={projectId}
            onChange={(event) => openProject(event.target.value)}
          >
            <NativeSelectOption value="">当前未保存项目</NativeSelectOption>
            {projects.map((item) => (
              <NativeSelectOption key={item.id} value={item.id}>
                {item.title}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Button variant="outline" size="sm" onClick={() => setDialog('new')}>
            <Plus />
            新建
          </Button>
          <Button size="sm" onClick={() => void save()}>
            <Save />
            保存
          </Button>
        </div>
      </header>
      <div className="paper-pipeline" aria-label="十阶段流水线">
        {stages.map(([id, code, name], index) => {
          const record = project.stageRecords.find((item) => item.id === id);
          return (
            <button
              key={id}
              type="button"
              data-status={record?.status}
              className={project.currentStage === id ? 'active' : ''}
              onClick={() => setView(stageView[id] ?? 'dashboard')}
            >
              <span>{record?.status === 'completed' ? <Check /> : code}</span>
              <div>
                <strong>{name}</strong>
                <small>{stageStatus(record?.status ?? 'pending')}</small>
              </div>
              {index < stages.length - 1 && <ChevronRight />}
            </button>
          );
        })}
      </div>
      <div className="paper-shell">
        <nav className="paper-nav" aria-label="论文工作台模块">
          {views.map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              className={view === id ? 'active' : ''}
              onClick={() => setView(id)}
            >
              <Icon />
              <span>{label}</span>
            </button>
          ))}
          <div className="paper-nav-progress">
            <span>流水线进度</span>
            <strong>
              {completedStages}/{stages.length}
            </strong>
            <i>
              <b style={{ width: `${completedStages * 10}%` }} />
            </i>
          </div>
        </nav>
        <main className="paper-main">
          {view === 'dashboard' && (
            <Dashboard
              project={project}
              wordsCount={words(manuscript)}
              latestAudit={latestAudit}
              latestReview={latestReview}
              setView={setView}
            />
          )}
          {view === 'research' && (
            <ResearchView
              project={project}
              patchNested={patchNested}
              patchProject={patchProject}
              addExperiment={addExperiment}
              addAsset={addAsset}
            />
          )}
          {view === 'evidence' && (
            <EvidenceView
              project={project}
              setProject={setProject}
              addClaim={addClaim}
              openBibtex={() => setDialog('bibtex')}
              openCrossref={() => setDialog('crossref')}
            />
          )}
          {view === 'draft' && (
            <DraftView
              project={project}
              setProject={setProject}
              activeSection={activeSection}
              generate={() =>
                void applyServerProject(
                  'generate-draft',
                  {},
                  '正在生成完整论文结构稿',
                  '完整结构稿已生成，请逐节核验。',
                )
              }
              snapshot={() =>
                void applyServerProject(
                  'snapshot',
                  { label: '正文手动快照' },
                  '正在保存正文快照',
                  '正文快照已保存。',
                )
              }
            />
          )}
          {view === 'integrity' && (
            <IntegrityView
              project={project}
              audit={latestAudit}
              runPre={() =>
                void applyServerProject(
                  'integrity',
                  { phase: 'pre' },
                  '正在执行预审完整性核验',
                  '预审完整性报告已更新。',
                )
              }
              runFinal={() =>
                void applyServerProject(
                  'integrity',
                  { phase: 'final' },
                  '正在执行最终完整性核验',
                  '最终完整性报告已更新。',
                )
              }
            />
          )}
          {view === 'review' && (
            <ReviewView
              review={latestReview}
              activeReport={activeReport}
              reportIndex={reportIndex}
              setReportIndex={setReportIndex}
              runReview={() =>
                void applyServerProject(
                  'review',
                  {},
                  '正在执行五角色审稿',
                  '五角色审稿报告已生成。',
                )
              }
              rereview={() =>
                void applyServerProject(
                  'rereview',
                  {},
                  '正在执行修订复审',
                  '修订复审报告已生成。',
                )
              }
              adoptRoadmap={() => void adoptRoadmap()}
            />
          )}
          {view === 'revision' && (
            <RevisionView
              project={project}
              setProject={setProject}
              rereview={() =>
                void applyServerProject(
                  'rereview',
                  {},
                  '正在执行修订复审',
                  '修订复审报告已生成。',
                )
              }
            />
          )}
          {view === 'finalize' && (
            <FinalizeView
              project={project}
              patchNested={patchNested}
              finalize={() =>
                void applyServerProject(
                  'finalize',
                  {},
                  '正在锁定定稿记录',
                  '定稿记录已生成。',
                )
              }
              exportFile={exportFile}
            />
          )}
          {view === 'process' && (
            <ProcessView
              project={project}
              restore={(id) =>
                void applyServerProject(
                  'restore',
                  { snapshotId: id },
                  '正在恢复正文快照',
                  '快照已恢复，并已保存恢复前版本。',
                )
              }
              exportProcess={() => void exportFile('process')}
            />
          )}
          {view === 'settings' && (
            <SettingsView
              project={project}
              patchNested={patchNested}
              patchProject={patchProject}
              changePaperType={changePaperType}
            />
          )}
        </main>
      </div>
      <footer className="paper-checkpoint" data-status={currentRecord?.status}>
        <div>
          <span>
            作者检查点 · 阶段{' '}
            {stages.find(([id]) => id === project.currentStage)?.[1]}
          </span>
          <strong>
            {stages.find(([id]) => id === project.currentStage)?.[2]}
          </strong>
          <small>
            {currentRecord?.status === 'awaiting_confirmation'
              ? `待确认交付物：${currentRecord.deliverables.join('、')}`
              : '完成当前阶段要求后提交作者确认。'}
          </small>
        </div>
        {currentRecord?.status === 'awaiting_confirmation' ? (
          <>
            <Input
              aria-label="作者确认说明"
              value={stageNote}
              onChange={(event) => setStageNote(event.target.value)}
            />
            <Button onClick={() => void confirmStage()}>
              <Check />
              确认并进入下一阶段
            </Button>
          </>
        ) : (
          <Button variant="outline" onClick={() => void prepareStage()}>
            <ClipboardCheck />
            提交阶段检查
          </Button>
        )}
      </footer>
      {(message || error) && (
        <output className={`paper-toast ${error ? 'error' : ''}`}>
          {error || message}
        </output>
      )}
      {running && (
        <div className="paper-running">
          <div>
            <LoaderCircle />
            <strong>{runningLabel}</strong>
            <span>任务由 Go 控制面排队，并在 Python 论文引擎中执行。</span>
          </div>
        </div>
      )}

      <Dialog
        open={dialog === 'new'}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建论文项目</DialogTitle>
            <DialogDescription>
              建立独立的论文、证据、审稿与版本记录。
            </DialogDescription>
          </DialogHeader>
          <label className="paper-field">
            <span>论文题目</span>
            <Input
              id="paper-new-title"
              value={newTitle}
              onChange={(event) => setNewTitle(event.target.value)}
            />
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>
              取消
            </Button>
            <Button onClick={createNew}>建立项目</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={dialog === 'bibtex'}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        <DialogContent className="paper-dialog-wide">
          <DialogHeader>
            <DialogTitle>BibTeX 导入</DialogTitle>
            <DialogDescription>
              解析条目、规范化 DOI，并按 DOI
              或题名去重。导入后仍需阅读原文并登记定位信息。
            </DialogDescription>
          </DialogHeader>
          <Textarea
            rows={16}
            value={bibtex}
            onChange={(event) => setBibtex(event.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>
              取消
            </Button>
            <Button onClick={() => void importBibtex()}>解析并去重</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={dialog === 'crossref'}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        <DialogContent className="paper-dialog-wide">
          <DialogHeader>
            <DialogTitle>Crossref 真实元数据检索</DialogTitle>
            <DialogDescription>
              请求由服务端转发，并记录来源与获取时间；元数据不等于原文核验。
            </DialogDescription>
          </DialogHeader>
          <div className="paper-search-row">
            <Input
              value={crossrefQuery}
              onChange={(event) => setCrossrefQuery(event.target.value)}
            />
            <Button onClick={() => void searchCrossref()}>
              <Search />
              检索
            </Button>
          </div>
          <div className="paper-crossref-results">
            {crossrefRows.map((item) => (
              <article key={item.id}>
                <div>
                  <strong>{item.title}</strong>
                  <span>
                    {item.authors || '作者信息缺失'} · {item.year || '年份缺失'}{' '}
                    · {item.venue || '来源信息缺失'}
                  </span>
                  <code>{item.doi || item.url}</code>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => addCrossref(item)}
                >
                  加入候选库
                </Button>
              </article>
            ))}
            {!crossrefRows.length && <p>输入题名、作者或关键词开始检索。</p>}
          </div>
          <DialogFooter>
            <Button onClick={() => setDialog(null)}>完成</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function Dashboard({
  project,
  wordsCount,
  latestAudit,
  latestReview,
  setView,
}: {
  project: PaperProject;
  wordsCount: number;
  latestAudit?: IntegrityRun;
  latestReview?: Review;
  setView: (value: string) => void;
}) {
  const active = stages.find(([id]) => id === project.currentStage);
  return (
    <div className="paper-view paper-dashboard">
      <header>
        <div>
          <span>论文生产总览</span>
          <h2>{project.title}</h2>
          <p>
            当前阶段：Stage {active?.[1]} · {active?.[2]}
          </p>
        </div>
        <Button
          onClick={() => setView(stageView[project.currentStage] ?? 'research')}
        >
          进入当前任务
          <ChevronRight />
        </Button>
      </header>
      <div className="paper-metrics">
        <article>
          <span>正文</span>
          <strong>{wordsCount}</strong>
          <small>字 / 目标 {project.config.wordTarget}</small>
        </article>
        <article>
          <span>证据库</span>
          <strong>{project.references.length}</strong>
          <small>
            {
              project.references.filter(
                (item) => item.verification === 'verified',
              ).length
            }{' '}
            条已核验
          </small>
        </article>
        <article>
          <span>论断—证据</span>
          <strong>{project.claims.length}</strong>
          <small>
            {project.claims.filter((item) => item.status === 'verified').length}{' '}
            条已确认
          </small>
        </article>
        <article>
          <span>质量门禁</span>
          <strong>{latestAudit?.score ?? '—'}</strong>
          <small>
            {latestAudit
              ? latestAudit.pass
                ? '最近一次通过'
                : `${latestAudit.issues.length} 项待处理`
              : '尚未运行'}
          </small>
        </article>
      </div>
      <div className="paper-dashboard-grid">
        <article>
          <h3>研究与证据</h3>
          <dl>
            <div>
              <dt>研究问题</dt>
              <dd>{project.framing.question || '待填写'}</dd>
            </div>
            <div>
              <dt>研究设计</dt>
              <dd>{project.methodology.design || '待填写'}</dd>
            </div>
            <div>
              <dt>数据来源</dt>
              <dd>{project.methodology.dataSources || '待填写'}</dd>
            </div>
          </dl>
          <Button variant="outline" onClick={() => setView('research')}>
            编辑研究设计
          </Button>
        </article>
        <article>
          <h3>审稿与修订</h3>
          <dl>
            <div>
              <dt>最近决定</dt>
              <dd>
                {latestReview
                  ? decisionLabel(latestReview.decision)
                  : '尚未审稿'}
              </dd>
            </div>
            <div>
              <dt>审稿轮次</dt>
              <dd>{project.reviews.length}</dd>
            </div>
            <div>
              <dt>开放修订项</dt>
              <dd>
                {
                  project.revisionItems.filter(
                    (item) => item.status !== 'resolved',
                  ).length
                }
              </dd>
            </div>
          </dl>
          <Button variant="outline" onClick={() => setView('review')}>
            查看审稿中心
          </Button>
        </article>
        <article>
          <h3>最近活动</h3>
          {project.activities.slice(0, 5).map((item) => (
            <p key={item.id}>
              <time>{new Date(item.createdAt).toLocaleString('zh-CN')}</time>
              {item.message}
            </p>
          ))}
          {!project.activities.length && (
            <p>保存研究设计或运行任务后显示活动记录。</p>
          )}
        </article>
      </div>
    </div>
  );
}

function ResearchView({
  project,
  patchNested,
  patchProject,
  addExperiment,
  addAsset,
}: {
  project: PaperProject;
  patchNested: (
    target: 'framing' | 'methodology',
    key: string,
    value: string,
  ) => void;
  patchProject: (patch: Partial<PaperProject>) => void;
  addExperiment: () => void;
  addAsset: () => void;
}) {
  return (
    <div className="paper-view">
      <header className="paper-view-title">
        <div>
          <span>研究设计</span>
          <h2>研究问题、范围与方法</h2>
          <p>所有正文生成都以这里登记的材料为边界。</p>
        </div>
      </header>
      <div className="paper-form-grid">
        <LabeledTextarea
          label="研究主题"
          value={project.framing.topic}
          onChange={(value) => patchNested('framing', 'topic', value)}
        />
        <LabeledTextarea
          label="问题背景"
          value={project.framing.problem}
          onChange={(value) => patchNested('framing', 'problem', value)}
        />
        <LabeledTextarea
          label="研究问题"
          value={project.framing.question}
          onChange={(value) => patchNested('framing', 'question', value)}
        />
        <LabeledTextarea
          label="研究缺口"
          value={project.framing.gap}
          onChange={(value) => patchNested('framing', 'gap', value)}
        />
        <LabeledTextarea
          label="研究目标"
          value={project.framing.objectives}
          onChange={(value) => patchNested('framing', 'objectives', value)}
        />
        <LabeledTextarea
          label="预期贡献"
          value={project.framing.contribution}
          onChange={(value) => patchNested('framing', 'contribution', value)}
        />
        <LabeledTextarea
          label="理论或概念框架"
          value={project.framing.theory}
          onChange={(value) => patchNested('framing', 'theory', value)}
        />
        <LabeledTextarea
          label="适用范围与排除项"
          value={`${project.framing.scope}\n${project.framing.exclusions}`}
          onChange={(value) => {
            const [scope, ...rest] = value.split('\n');
            patchNested('framing', 'scope', scope);
            patchNested('framing', 'exclusions', rest.join('\n'));
          }}
        />
      </div>
      <h3 className="paper-subtitle">章节提纲</h3>
      <section className="paper-outline">
        <header>
          <span>章节</span>
          <span>本节目的</span>
          <span>状态</span>
        </header>
        {project.outline.map((item) => (
          <article key={item.sectionId}>
            <strong>{item.heading}</strong>
            <Input
              aria-label={`${item.heading}目的`}
              value={item.purpose}
              onChange={(event) =>
                patchProject({
                  outline: project.outline.map((row) =>
                    row.sectionId === item.sectionId
                      ? { ...row, purpose: event.target.value }
                      : row,
                  ),
                })
              }
            />
            <NativeSelect
              aria-label={`${item.heading}状态`}
              value={item.status}
              onChange={(event) =>
                patchProject({
                  outline: project.outline.map((row) =>
                    row.sectionId === item.sectionId
                      ? { ...row, status: event.target.value }
                      : row,
                  ),
                })
              }
            >
              <NativeSelectOption value="planned">已规划</NativeSelectOption>
              <NativeSelectOption value="drafted">已起草</NativeSelectOption>
              <NativeSelectOption value="verified">已核验</NativeSelectOption>
            </NativeSelect>
          </article>
        ))}
      </section>
      <h3 className="paper-subtitle">方法与复现边界</h3>
      <div className="paper-form-grid">
        <LabeledTextarea
          label="研究设计"
          value={project.methodology.design}
          onChange={(value) => patchNested('methodology', 'design', value)}
        />
        <LabeledTextarea
          label="数据来源与版本"
          value={project.methodology.dataSources}
          onChange={(value) => patchNested('methodology', 'dataSources', value)}
        />
        <LabeledTextarea
          label="预处理"
          value={project.methodology.preprocessing}
          onChange={(value) =>
            patchNested('methodology', 'preprocessing', value)
          }
        />
        <LabeledTextarea
          label="分析方法"
          value={project.methodology.analysis}
          onChange={(value) => patchNested('methodology', 'analysis', value)}
        />
        <LabeledTextarea
          label="验证设计"
          value={project.methodology.validation}
          onChange={(value) => patchNested('methodology', 'validation', value)}
        />
        <LabeledTextarea
          label="局限性"
          value={project.methodology.limitations}
          onChange={(value) => patchNested('methodology', 'limitations', value)}
        />
      </div>
      <div className="paper-register">
        <section>
          <header>
            <h3>实验与运行记录</h3>
            <Button variant="outline" size="sm" onClick={addExperiment}>
              <Plus />
              新增实验
            </Button>
          </header>
          {project.experiments.map((item) => (
            <article key={item.id}>
              <Input
                value={item.name}
                onChange={(event) =>
                  patchProject({
                    experiments: project.experiments.map((row) =>
                      row.id === item.id
                        ? { ...row, name: event.target.value }
                        : row,
                    ),
                  })
                }
              />
              <Input
                placeholder="数据版本"
                value={item.dataVersion}
                onChange={(event) =>
                  patchProject({
                    experiments: project.experiments.map((row) =>
                      row.id === item.id
                        ? { ...row, dataVersion: event.target.value }
                        : row,
                    ),
                  })
                }
              />
              <Input
                placeholder="方法与参数"
                value={item.method}
                onChange={(event) =>
                  patchProject({
                    experiments: project.experiments.map((row) =>
                      row.id === item.id
                        ? { ...row, method: event.target.value }
                        : row,
                    ),
                  })
                }
              />
              <Input
                placeholder="输出与指标"
                value={item.output}
                onChange={(event) =>
                  patchProject({
                    experiments: project.experiments.map((row) =>
                      row.id === item.id
                        ? { ...row, output: event.target.value }
                        : row,
                    ),
                  })
                }
              />
              <Input
                placeholder="核验人"
                value={item.verifier}
                onChange={(event) =>
                  patchProject({
                    experiments: project.experiments.map((row) =>
                      row.id === item.id
                        ? { ...row, verifier: event.target.value }
                        : row,
                    ),
                  })
                }
              />
              <NativeSelect
                value={item.status}
                onChange={(event) =>
                  patchProject({
                    experiments: project.experiments.map((row) =>
                      row.id === item.id
                        ? { ...row, status: event.target.value }
                        : row,
                    ),
                  })
                }
              >
                <NativeSelectOption value="unverified">
                  待核验
                </NativeSelectOption>
                <NativeSelectOption value="verified">已核验</NativeSelectOption>
              </NativeSelect>
            </article>
          ))}
        </section>
        <section>
          <header>
            <h3>图表与材料登记</h3>
            <Button variant="outline" size="sm" onClick={addAsset}>
              <Plus />
              新增材料
            </Button>
          </header>
          {project.assets.map((item) => (
            <article key={item.id}>
              <Input
                value={item.name}
                onChange={(event) =>
                  patchProject({
                    assets: project.assets.map((row) =>
                      row.id === item.id
                        ? { ...row, name: event.target.value }
                        : row,
                    ),
                  })
                }
              />
              <Input
                placeholder="来源或生成记录"
                value={item.source}
                onChange={(event) =>
                  patchProject({
                    assets: project.assets.map((row) =>
                      row.id === item.id
                        ? { ...row, source: event.target.value }
                        : row,
                    ),
                  })
                }
              />
              <label>
                <input
                  type="checkbox"
                  checked={item.verified}
                  onChange={(event) =>
                    patchProject({
                      assets: project.assets.map((row) =>
                        row.id === item.id
                          ? { ...row, verified: event.target.checked }
                          : row,
                      ),
                    })
                  }
                />
                已核验
              </label>
            </article>
          ))}
        </section>
      </div>
    </div>
  );
}

function EvidenceView({
  project,
  setProject,
  addClaim,
  openBibtex,
  openCrossref,
}: {
  project: PaperProject;
  setProject: React.Dispatch<React.SetStateAction<PaperProject>>;
  addClaim: () => void;
  openBibtex: () => void;
  openCrossref: () => void;
}) {
  const updateRef = (id: string, patch: Partial<Reference>) =>
    setProject((current) => ({
      ...current,
      references: current.references.map((item) =>
        item.id === id ? { ...item, ...patch } : item,
      ),
    }));
  const updateClaim = (id: string, patch: Partial<Claim>) =>
    setProject((current) => ({
      ...current,
      claims: current.claims.map((item) =>
        item.id === id ? { ...item, ...patch } : item,
      ),
    }));
  const addReference = () =>
    setProject((current) => ({
      ...current,
      references: [
        ...current.references,
        {
          id: `ref-${crypto.randomUUID()}`,
          key: `ref${current.references.length + 1}`,
          type: 'article',
          title: '新文献',
          authors: '',
          year: '',
          venue: '',
          doi: '',
          url: '',
          status: 'candidate',
          verification: 'unverified',
          locator: '',
          notes: 'Manual entry',
          source: '手动录入',
          addedAt: new Date().toISOString(),
        },
      ],
    }));
  return (
    <div className="paper-view">
      <header className="paper-view-title">
        <div>
          <span>证据资料库</span>
          <h2>文献与论断—证据矩阵</h2>
          <p>候选元数据、已核验原文和正文引文采用不同状态。</p>
        </div>
        <div>
          <Button variant="outline" onClick={addReference}>
            <Plus />
            手动新增文献
          </Button>
          <Button variant="outline" onClick={openCrossref}>
            <Search />
            Crossref 检索
          </Button>
          <Button onClick={openBibtex}>
            <LibraryBig />
            导入 BibTeX
          </Button>
        </div>
      </header>
      <div className="paper-table-wrap">
        <table>
          <thead>
            <tr>
              <th>引用键 / 状态</th>
              <th>文献</th>
              <th>DOI / 定位</th>
              <th>纳入状态</th>
            </tr>
          </thead>
          <tbody>
            {project.references.map((item) => (
              <tr key={item.id}>
                <td>
                  <Input
                    value={item.key}
                    onChange={(event) =>
                      updateRef(item.id, { key: event.target.value })
                    }
                  />
                  <NativeSelect
                    value={item.verification}
                    onChange={(event) =>
                      updateRef(item.id, { verification: event.target.value })
                    }
                  >
                    <NativeSelectOption value="unverified">
                      未核验原文
                    </NativeSelectOption>
                    <NativeSelectOption value="verified">
                      已核验原文
                    </NativeSelectOption>
                  </NativeSelect>
                </td>
                <td>
                  <strong>{item.title}</strong>
                  <span>
                    {item.authors} · {item.year} · {item.venue}
                  </span>
                  <small>来源：{item.source ?? '手动录入'}</small>
                </td>
                <td>
                  <code>{item.doi || item.url || '—'}</code>
                  <Input
                    placeholder="页码、章节或表格"
                    value={item.locator}
                    onChange={(event) =>
                      updateRef(item.id, { locator: event.target.value })
                    }
                  />
                </td>
                <td>
                  <NativeSelect
                    value={item.status}
                    onChange={(event) =>
                      updateRef(item.id, { status: event.target.value })
                    }
                  >
                    <NativeSelectOption value="candidate">
                      候选
                    </NativeSelectOption>
                    <NativeSelectOption value="included">
                      纳入
                    </NativeSelectOption>
                    <NativeSelectOption value="excluded">
                      排除
                    </NativeSelectOption>
                  </NativeSelect>
                </td>
              </tr>
            ))}
            {!project.references.length && (
              <tr>
                <td colSpan={4}>
                  尚无文献。可使用 Crossref 元数据检索或 BibTeX 导入。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <section className="paper-claims">
        <header>
          <div>
            <h3>论断—证据矩阵</h3>
            <p>每项事实性论断必须关联已核验文献或实验记录。</p>
          </div>
          <Button variant="outline" onClick={addClaim}>
            <Plus />
            新增论断
          </Button>
        </header>
        {project.claims.map((item) => (
          <article key={item.id}>
            <Textarea
              value={item.text}
              onChange={(event) =>
                updateClaim(item.id, { text: event.target.value })
              }
            />
            <Input
              placeholder="引文键，逗号分隔"
              value={item.referenceKeys.join(', ')}
              onChange={(event) =>
                updateClaim(item.id, {
                  referenceKeys: event.target.value
                    .split(',')
                    .map((value) => value.trim())
                    .filter(Boolean),
                })
              }
            />
            <Input
              placeholder="证据定位或说明"
              value={item.locator}
              onChange={(event) =>
                updateClaim(item.id, { locator: event.target.value })
              }
            />
            <NativeSelect
              value={item.status}
              onChange={(event) =>
                updateClaim(item.id, { status: event.target.value })
              }
            >
              <NativeSelectOption value="draft">草拟</NativeSelectOption>
              <NativeSelectOption value="verified">已确认</NativeSelectOption>
              <NativeSelectOption value="withdrawn">撤回</NativeSelectOption>
            </NativeSelect>
          </article>
        ))}
      </section>
    </div>
  );
}

function DraftView({
  project,
  setProject,
  activeSection,
  generate,
  snapshot,
}: {
  project: PaperProject;
  setProject: React.Dispatch<React.SetStateAction<PaperProject>>;
  activeSection: PaperSection;
  generate: () => void;
  snapshot: () => void;
}) {
  const updateSection = (value: string) =>
    setProject((current) => ({
      ...current,
      sections: current.sections.map((item) =>
        item.id === activeSection.id
          ? {
              ...item,
              content: value,
              status: 'user_edited',
              updatedAt: new Date().toISOString(),
            }
          : item,
      ),
    }));
  return (
    <div className="paper-view paper-draft">
      <header className="paper-view-title">
        <div>
          <span>稿件编辑器</span>
          <h2>完整论文写作</h2>
          <p>章节、引文键、实验记录和材料保持在同一个项目版本中。</p>
        </div>
        <div>
          <Button variant="outline" onClick={snapshot}>
            <History />
            保存快照
          </Button>
          <Button onClick={generate}>
            <Sparkles />
            生成完整结构稿
          </Button>
        </div>
      </header>
      <div className="paper-draft-layout">
        <aside>
          {project.sections.map((item) => (
            <button
              key={item.id}
              type="button"
              className={activeSection.id === item.id ? 'active' : ''}
              onClick={() =>
                setProject((current) => ({
                  ...current,
                  activeSection: item.id,
                }))
              }
            >
              <span>{item.name}</span>
              <small>{words(item.content)} 字</small>
            </button>
          ))}
        </aside>
        <section>
          <header>
            <div>
              <span>当前章节</span>
              <h3>{activeSection.name}</h3>
            </div>
            <span data-status={activeSection.status}>
              {activeSection.status === 'user_edited'
                ? '作者已编辑'
                : activeSection.status === 'draft'
                  ? '结构稿'
                  : '待撰写'}
            </span>
          </header>
          <Textarea
            aria-label={`${activeSection.name}正文`}
            value={activeSection.content}
            onChange={(event) => updateSection(event.target.value)}
            placeholder="在此撰写章节正文；使用 [@citationKey] 插入引文键。"
          />
        </section>
        <aside className="paper-draft-context">
          <h3>可用证据</h3>
          {project.references
            .filter((item) => item.status === 'included')
            .map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() =>
                  updateSection(`${activeSection.content} [@${item.key}]`)
                }
              >
                <strong>@{item.key}</strong>
                <span>{item.title}</span>
                <small>
                  {item.verification === 'verified'
                    ? `已核验 · ${item.locator || '缺定位'}`
                    : '原文未核验'}
                </small>
              </button>
            ))}
          {!project.references.some((item) => item.status === 'included') && (
            <p>请先在证据管理中纳入并核验来源。</p>
          )}
          <h3>本节论断</h3>
          {project.claims
            .filter((item) => item.sectionId === activeSection.id)
            .map((item) => (
              <p key={item.id}>{item.text}</p>
            ))}
        </aside>
      </div>
    </div>
  );
}

function IntegrityView({
  project,
  audit,
  runPre,
  runFinal,
}: {
  project: PaperProject;
  audit?: IntegrityRun;
  runPre: () => void;
  runFinal: () => void;
}) {
  return (
    <div className="paper-view">
      <header className="paper-view-title">
        <div>
          <span>完整性门禁</span>
          <h2>双阶段完整性核验</h2>
          <p>
            预审门禁阻止带关键证据缺口的稿件进入审稿；最终门禁要求零未解决问题。
          </p>
        </div>
        <div>
          <Button variant="outline" onClick={runPre}>
            运行预审核验
          </Button>
          <Button onClick={runFinal}>运行最终核验</Button>
        </div>
      </header>
      <div className="paper-integrity-summary">
        <article data-pass={audit?.pass}>
          <span>{audit?.phase === 'final' ? '最终核验' : '预审核验'}</span>
          <strong>{audit?.score ?? '—'}</strong>
          <small>
            {audit ? (audit.pass ? '门禁通过' : '门禁未通过') : '尚未运行'}
          </small>
        </article>
        <dl>
          <div>
            <dt>稿件字数</dt>
            <dd>
              {audit?.stats.words ??
                project.sections.reduce(
                  (sum, item) => sum + words(item.content),
                  0,
                )}
            </dd>
          </div>
          <div>
            <dt>完成章节</dt>
            <dd>
              {audit?.stats.completedSections ?? 0}/{project.sections.length}
            </dd>
          </div>
          <div>
            <dt>已引用来源</dt>
            <dd>{audit?.stats.cited ?? 0}</dd>
          </div>
          <div>
            <dt>已核验实验</dt>
            <dd>{audit?.stats.verifiedExperiments ?? 0}</dd>
          </div>
        </dl>
      </div>
      <h3 className="paper-subtitle">七类透明失败模式</h3>
      <div className="paper-failure-grid">
        {(
          audit?.failureModes ??
          [
            ['fabricated_evidence', '虚构文献或证据'],
            ['unsupported_claim', '论断超出证据'],
            ['data_method_mismatch', '数据与方法不匹配'],
            ['citation_drift', '引文与陈述错位'],
            ['hidden_uncertainty', '掩盖不确定性'],
            ['automation_bias', '将自动判断冒充专家结论'],
            ['undeclared_ai', 'AI 使用未披露'],
          ].map(([id, name]) => ({ id, name, status: 'unchecked' }))
        ).map((item) => (
          <article key={item.id} data-status={item.status}>
            <span>{item.status === 'clear' ? <Check /> : <ShieldCheck />}</span>
            <div>
              <strong>{item.name}</strong>
              <small>
                {item.status === 'clear'
                  ? '未触发'
                  : item.status === 'suspected'
                    ? '需要处理'
                    : '等待核验'}
              </small>
            </div>
          </article>
        ))}
      </div>
      <div className="paper-issues">
        {audit?.issues.map((item) => (
          <article key={item.id} data-severity={item.severity}>
            <span>{item.severity}</span>
            <div>
              <strong>{item.message}</strong>
              <p>{item.action}</p>
              {item.evidence && <code>{item.evidence}</code>}
            </div>
          </article>
        ))}
        {audit && !audit.issues.length && <p>当前规则检查未发现未解决项。</p>}
      </div>
    </div>
  );
}

function ReviewView({
  review,
  activeReport,
  reportIndex,
  setReportIndex,
  runReview,
  rereview,
  adoptRoadmap,
}: {
  review?: Review;
  activeReport?: Review['reports'][number];
  reportIndex: number;
  setReportIndex: (value: number) => void;
  runReview: () => void;
  rereview: () => void;
  adoptRoadmap: () => void;
}) {
  return (
    <div className="paper-view">
      <header className="paper-view-title">
        <div>
          <span>同行评审</span>
          <h2>五角色审稿与修订路线图</h2>
          <p>分别检查期刊适配、理论论证、方法学、证据引文和反方挑战。</p>
        </div>
        <div>
          <Button variant="outline" onClick={rereview}>
            <RefreshCw />
            执行修订复审
          </Button>
          <Button onClick={runReview}>
            <ClipboardCheck />
            启动五角色审稿
          </Button>
        </div>
      </header>
      {review ? (
        <>
          <div
            className="paper-review-decision"
            data-decision={review.decision}
          >
            <div>
              <span>编辑决定 · Round {review.round}</span>
              <strong>{decisionLabel(review.decision)}</strong>
              <small>稿件哈希 {review.manuscriptHash}</small>
            </div>
            <Button variant="outline" onClick={adoptRoadmap}>
              采用修订路线图
            </Button>
          </div>
          <div className="paper-review-tabs">
            {review.reports.map((item, index) => (
              <button
                key={item.id}
                type="button"
                className={reportIndex === index ? 'active' : ''}
                onClick={() => setReportIndex(index)}
              >
                <span>{item.role}</span>
                <strong>{item.score}</strong>
              </button>
            ))}
          </div>
          {activeReport && (
            <section className="paper-review-report">
              <header>
                <div>
                  <h3>{activeReport.role}</h3>
                  <p>基于项目登记信息与透明规则生成，结论需要真实同行复核。</p>
                </div>
                <strong>{activeReport.score}/100</strong>
              </header>
              {activeReport.findings.map((item) => (
                <article key={item.id} data-severity={item.severity}>
                  <span>{item.severity}</span>
                  <div>
                    <strong>{item.issue}</strong>
                    <p>{item.recommendation}</p>
                  </div>
                </article>
              ))}
            </section>
          )}
        </>
      ) : (
        <div className="paper-empty">
          <ClipboardCheck />
          <h3>尚无审稿报告</h3>
          <p>完成结构稿和预审完整性核验后，启动五角色审稿。</p>
          <Button onClick={runReview}>启动五角色审稿</Button>
        </div>
      )}
    </div>
  );
}

function RevisionView({
  project,
  setProject,
  rereview,
}: {
  project: PaperProject;
  setProject: React.Dispatch<React.SetStateAction<PaperProject>>;
  rereview: () => void;
}) {
  const update = (id: string, patch: Partial<RevisionItem>) =>
    setProject((current) => ({
      ...current,
      revisionItems: current.revisionItems.map((item) =>
        item.id === id ? { ...item, ...patch } : item,
      ),
    }));
  return (
    <div className="paper-view">
      <header className="paper-view-title">
        <div>
          <span>修订回复</span>
          <h2>修订路线图与逐项响应</h2>
          <p>记录改动内容、证据位置与解决状态，复审会检查未响应项。</p>
        </div>
        <Button onClick={rereview}>
          <RefreshCw />
          执行修订复审
        </Button>
      </header>
      <div className="paper-revision-list">
        {project.revisionItems.map((item) => (
          <article key={item.id} data-status={item.status}>
            <header>
              <span>
                #{item.order} · {item.severity}
              </span>
              <strong>{item.issue}</strong>
              <NativeSelect
                value={item.status}
                onChange={(event) =>
                  update(item.id, { status: event.target.value })
                }
              >
                <NativeSelectOption value="open">待处理</NativeSelectOption>
                <NativeSelectOption value="in_progress">
                  处理中
                </NativeSelectOption>
                <NativeSelectOption value="resolved">已解决</NativeSelectOption>
              </NativeSelect>
            </header>
            <p>{item.action}</p>
            <div>
              <LabeledTextarea
                label="作者修订响应"
                value={item.response}
                onChange={(value) => update(item.id, { response: value })}
                rows={3}
              />
              <LabeledTextarea
                label="改动位置与核验依据"
                value={item.evidence}
                onChange={(value) => update(item.id, { evidence: value })}
                rows={3}
              />
            </div>
          </article>
        ))}
        {!project.revisionItems.length && (
          <div className="paper-empty">
            <RefreshCw />
            <h3>尚无修订路线图</h3>
            <p>在审稿中心运行五角色审稿并采用路线图。</p>
          </div>
        )}
      </div>
    </div>
  );
}

function FinalizeView({
  project,
  patchNested,
  finalize,
  exportFile,
}: {
  project: PaperProject;
  patchNested: (
    target: 'disclosure',
    key: string,
    value: string | boolean,
  ) => void;
  finalize: () => void;
  exportFile: (kind: keyof ExportBundle['files']) => void;
}) {
  const finalAudit = project.integrityRuns.find(
    (item) => item.phase === 'final' && item.pass,
  );
  const formats: Array<[keyof ExportBundle['files'], string, string]> = [
    ['markdown', 'Markdown', '结构化正文与参考文献'],
    ['html', 'HTML', '浏览、打印与归档'],
    ['latex', 'LaTeX', '标准 article 文档'],
    ['docx', 'DOCX', 'Word 可编辑稿件'],
    ['bibtex', 'BibTeX', '独立文献库'],
    ['passport', '材料护照', '机器可读交付摘要'],
    ['process', '论文创建过程记录', '阶段、门禁与作者确认'],
    ['package', '投稿材料包 ZIP', '正文、文献、护照与过程记录'],
  ];
  return (
    <div className="paper-view">
      <header className="paper-view-title">
        <div>
          <span>最终交付</span>
          <h2>声明、定稿与成果交付</h2>
          <p>最终核验通过后才能锁定定稿记录；工作稿仍可随时导出。</p>
        </div>
        <Button disabled={!finalAudit} onClick={finalize}>
          <FileCheck2 />
          锁定定稿记录
        </Button>
      </header>
      <div className="paper-final-gate" data-pass={Boolean(finalAudit)}>
        <ShieldCheck />
        <div>
          <strong>
            {finalAudit ? '最终完整性门禁已通过' : '最终完整性门禁尚未通过'}
          </strong>
          <span>
            {finalAudit
              ? `稿件哈希 ${finalAudit.manuscriptHash}`
              : '处理全部完整性问题后重新运行最终核验。'}
          </span>
        </div>
      </div>
      <div className="paper-form-grid">
        <label className="paper-check">
          <input
            type="checkbox"
            checked={project.disclosure.usedAI}
            onChange={(event) =>
              patchNested('disclosure', 'usedAI', event.target.checked)
            }
          />
          <span>本项目使用了 AI 辅助</span>
        </label>
        <LabeledTextarea
          label="使用工具与用途"
          value={`${project.disclosure.tools}\n${project.disclosure.purpose}`}
          onChange={(value) => {
            const [tools, ...rest] = value.split('\n');
            patchNested('disclosure', 'tools', tools);
            patchNested('disclosure', 'purpose', rest.join('\n'));
          }}
        />
        <LabeledTextarea
          label="人工核验方式"
          value={project.disclosure.humanVerification}
          onChange={(value) =>
            patchNested('disclosure', 'humanVerification', value)
          }
        />
        <LabeledTextarea
          label="投稿披露声明"
          value={project.disclosure.text}
          onChange={(value) => patchNested('disclosure', 'text', value)}
        />
      </div>
      <h3 className="paper-subtitle">成果交付</h3>
      <div className="paper-export-grid">
        {formats.map(([id, label, description]) => (
          <article key={id}>
            <FileArchive />
            <div>
              <strong>{label}</strong>
              <span>{description}</span>
            </div>
            <Button variant="outline" size="sm" onClick={() => exportFile(id)}>
              <Download />
              导出
            </Button>
          </article>
        ))}
      </div>
    </div>
  );
}

function ProcessView({
  project,
  restore,
  exportProcess,
}: {
  project: PaperProject;
  restore: (id: string) => void;
  exportProcess: () => void;
}) {
  return (
    <div className="paper-view">
      <header className="paper-view-title">
        <div>
          <span>过程记录</span>
          <h2>论文创建过程记录</h2>
          <p>阶段确认、完整性核验、审稿轮次、版本快照和作者决定保持可追溯。</p>
        </div>
        <Button variant="outline" onClick={exportProcess}>
          <Download />
          导出过程记录
        </Button>
      </header>
      <div className="paper-process-grid">
        <section>
          <h3>阶段与作者确认</h3>
          {stages.map(([id, code, name]) => {
            const record = project.stageRecords.find((item) => item.id === id);
            return (
              <article key={id} data-status={record?.status}>
                <span>{code}</span>
                <div>
                  <strong>{name}</strong>
                  <small>{stageStatus(record?.status ?? 'pending')}</small>
                  {record?.note && <p>{record.note}</p>}
                </div>
              </article>
            );
          })}
        </section>
        <section>
          <h3>正文快照</h3>
          {project.snapshots.map((item) => (
            <article key={item.id}>
              <History />
              <div>
                <strong>{item.label}</strong>
                <small>
                  {new Date(item.createdAt).toLocaleString('zh-CN')} ·{' '}
                  {item.words} 字 · {item.hash}
                </small>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => restore(item.id)}
              >
                <ArchiveRestore />
                恢复
              </Button>
            </article>
          ))}
          {!project.snapshots.length && (
            <p>在正文编辑器中保存快照后显示版本记录。</p>
          )}
          <h3>活动与决定</h3>
          {[
            ...project.decisions.map((item) => ({
              id: item.id,
              createdAt: item.createdAt,
              message: `Stage ${item.stageId}：${item.note || item.action}`,
            })),
            ...project.activities,
          ]
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .slice(0, 20)
            .map((item) => (
              <p key={item.id}>
                <time>{new Date(item.createdAt).toLocaleString('zh-CN')}</time>
                {item.message}
              </p>
            ))}
        </section>
      </div>
    </div>
  );
}

function SettingsView({
  project,
  patchNested,
  patchProject,
  changePaperType,
}: {
  project: PaperProject;
  patchNested: (target: 'config', key: string, value: string | number) => void;
  patchProject: (patch: Partial<PaperProject>) => void;
  changePaperType: (paperType: string) => void;
}) {
  return (
    <div className="paper-view">
      <header className="paper-view-title">
        <div>
          <span>项目设置</span>
          <h2>论文与投稿设置</h2>
          <p>远程模型凭据由服务端统一管理，不写入浏览器或项目文件。</p>
        </div>
      </header>
      <div className="paper-settings">
        <label className="paper-field">
          <span>论文题目</span>
          <Input
            value={project.title}
            onChange={(event) => patchProject({ title: event.target.value })}
          />
        </label>
        <label className="paper-field">
          <span>论文类型</span>
          <NativeSelect
            value={project.config.paperType}
            onChange={(event) => changePaperType(event.target.value)}
          >
            <NativeSelectOption value="empirical">实证研究</NativeSelectOption>
            <NativeSelectOption value="review">主题文献综述</NativeSelectOption>
            <NativeSelectOption value="theoretical">
              理论分析
            </NativeSelectOption>
            <NativeSelectOption value="case">案例研究</NativeSelectOption>
            <NativeSelectOption value="policy">政策简报</NativeSelectOption>
            <NativeSelectOption value="conference">会议论文</NativeSelectOption>
          </NativeSelect>
        </label>
        <label className="paper-field">
          <span>作者</span>
          <Input
            value={project.config.authors}
            onChange={(event) =>
              patchNested('config', 'authors', event.target.value)
            }
          />
        </label>
        <label className="paper-field">
          <span>单位</span>
          <Input
            value={project.config.affiliations}
            onChange={(event) =>
              patchNested('config', 'affiliations', event.target.value)
            }
          />
        </label>
        <label className="paper-field">
          <span>通讯作者</span>
          <Input
            value={project.config.correspondingAuthor}
            onChange={(event) =>
              patchNested('config', 'correspondingAuthor', event.target.value)
            }
          />
        </label>
        <label className="paper-field">
          <span>目标期刊或会议</span>
          <Input
            value={project.config.targetJournal}
            onChange={(event) =>
              patchNested('config', 'targetJournal', event.target.value)
            }
          />
        </label>
        <label className="paper-field">
          <span>引文样式</span>
          <NativeSelect
            value={project.config.citationStyle}
            onChange={(event) =>
              patchNested('config', 'citationStyle', event.target.value)
            }
          >
            {['APA 7', 'Chicago Author-Date', 'MLA 9', 'IEEE', 'Vancouver'].map(
              (item) => (
                <NativeSelectOption key={item}>{item}</NativeSelectOption>
              ),
            )}
          </NativeSelect>
        </label>
        <label className="paper-field">
          <span>目标字数</span>
          <Input
            type="number"
            min="800"
            value={project.config.wordTarget}
            onChange={(event) =>
              patchNested('config', 'wordTarget', Number(event.target.value))
            }
          />
        </label>
        <label className="paper-field paper-full">
          <span>关键词</span>
          <Input
            value={project.config.keywords}
            onChange={(event) =>
              patchNested('config', 'keywords', event.target.value)
            }
          />
        </label>
      </div>
      <div className="paper-server-note">
        <ShieldCheck />
        <div>
          <strong>服务端模型网关</strong>
          <p>
            浏览器只提交项目编号与任务输入。模型供应商、凭据、超时、配额和审计策略由
            Go 控制面管理；Python 引擎负责可复现的结构化处理。
          </p>
        </div>
      </div>
    </div>
  );
}
