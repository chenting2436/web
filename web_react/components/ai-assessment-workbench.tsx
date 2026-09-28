'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Archive,
  BarChart3,
  BookOpenCheck,
  Braces,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Clock3,
  Code2,
  Download,
  FileCode2,
  FileSearch,
  Filter,
  Gauge,
  History,
  Import,
  Layers3,
  LoaderCircle,
  LockKeyhole,
  Play,
  RefreshCw,
  Save,
  Search,
  ServerCog,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  TestTubes,
  XCircle,
} from 'lucide-react';
import { MonacoCodeEditor } from '@/components/python-lab/monaco-code-editor';
import { useLanguage } from '@/components/language-provider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { ApiError } from '@/services/api/client';
import {
  toolApi,
  type WorkbenchJob,
  type WorkbenchProject,
} from '@/services/api/tools';

type Language = {
  id: number;
  key: string;
  label: string;
  monaco: string;
  extension: string;
};

type TestCase = {
  name: string;
  visible: boolean;
  weight: number;
  stdin?: string;
  expectedOutput?: string;
};

type Problem = {
  id: string;
  versionId: string;
  number: number;
  title: string;
  difficulty: string;
  category: string;
  tags: string[];
  statement: string;
  inputFormat: string;
  outputFormat: string;
  constraints: string[];
  samples: Array<{ input: string; output: string }>;
  hints: string[];
  starters: Record<string, string>;
  limits: { cpuTime: number; wallTime: number; memory: number };
  tests: TestCase[];
  testSummary: { total: number; public: number; hidden: number; weight: number };
  source: string;
};

type CaseResult = {
  index: number;
  name: string;
  visible: boolean;
  weight: number;
  verdict: string;
  timeMs: number;
  memoryKb: number;
  stdout: string;
  stderr: string;
};

type Finding = { level: string; code?: string; message: string };

type Submission = {
  id: string;
  problemId: string;
  problemVersionId: string;
  language: string;
  verdict: string;
  status: string;
  score: number;
  timeMs: number;
  memoryKb: number;
  createdAt: string;
  sourceHash: string;
  cases: CaseResult[];
  diagnostics: Finding[];
  origin: string;
};

type AssessmentState = {
  workspaceId: string;
  catalogVersion: string;
  selectedProblemId: string;
  selectedLanguage: string;
  drafts: Record<string, string>;
  customProblems: Problem[];
  submissions: Submission[];
  activeSubmissionId: string;
  lastReview: {
    lines: number;
    characters: number;
    sourceHash: string;
    findings: Finding[];
  } | null;
  updatedAt: string;
};

type AssessmentResult = {
  schema: 'skyview-ai-assessment-results';
  version: number;
  stage: string;
  catalog: {
    id: string;
    versionId: string;
    title: string;
    problems: Problem[];
    categories: string[];
    integrity: string;
  };
  languages: Language[];
  runtime: {
    provider: string;
    adapter: string;
    status: string;
    executionAvailable: boolean;
    endpointHost: string;
    isolationRequired: boolean;
    batch: boolean;
    hiddenTests: boolean;
    resourceLimits: boolean;
    supportedLanguages: string[];
    executorOptions: string[];
  };
  state: AssessmentState;
  stats: {
    problems: number;
    submissions: number;
    finished: number;
    accepted: number;
    acceptanceRate: number;
    queued: number;
    testCases: number;
    hiddenCases: number;
    verdictDistribution: Array<{ name: string; value: number }>;
    difficultyDistribution: Array<{ name: string; value: number }>;
    categoryDistribution: Array<{ name: string; value: number }>;
  };
  quality: {
    valid: boolean;
    issues: Array<{ level: string; field: string; message: string }>;
    hiddenDataRedacted: boolean;
    sourceHashesRecorded: boolean;
    resourceLimitsRequired: boolean;
  };
  review?: AssessmentState['lastReview'];
  submission?: Submission;
  export?: { fileName: string; contentType: string; base64: string; sha256: string; files: number };
  validation?: { valid: boolean; problems: number; issues: Array<{ level: string; message: string }> };
};

type View = 'workspace' | 'submissions' | 'bank' | 'runtime' | 'analytics' | 'delivery';
type Inspector = 'result' | 'problem' | 'history';

const terminalStatuses = new Set(['succeeded', 'failed', 'canceled']);

const verdictLabels: Record<string, { zh: string; en: string }> = {
  Accepted: { zh: '通过', en: 'Accepted' },
  'Wrong Answer': { zh: '答案错误', en: 'Wrong Answer' },
  'Time Limit Exceeded': { zh: '超出时限', en: 'Time Limit Exceeded' },
  'Compilation Error': { zh: '编译错误', en: 'Compilation Error' },
  'Runtime Error': { zh: '运行错误', en: 'Runtime Error' },
  Queued: { zh: '等待执行', en: 'Queued' },
  Skipped: { zh: '未执行', en: 'Skipped' },
};

function isAssessmentResult(value: unknown): value is AssessmentResult {
  return Boolean(
    value &&
      typeof value === 'object' &&
      (value as AssessmentResult).schema === 'skyview-ai-assessment-results' &&
      Array.isArray((value as AssessmentResult).catalog?.problems),
  );
}

async function waitForJob(id: string): Promise<WorkbenchJob | null> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const job = await toolApi.getJob(id);
    if (terminalStatuses.has(job.status)) return job;
    await new Promise((resolve) => window.setTimeout(resolve, 650));
  }
  return null;
}

function downloadBase64(base64: string, fileName: string, type: string) {
  const binary = window.atob(base64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function formatTime(value: string, locale: 'zh' | 'en') {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return value;
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(parsed);
}

export function AiAssessmentWorkbench({
  executionAllowed = true,
}: {
  executionAllowed?: boolean;
}) {
  const { locale, text } = useLanguage();
  const [view, setView] = useState<View>('workspace');
  const [inspector, setInspector] = useState<Inspector>('result');
  const [result, setResult] = useState<AssessmentResult | null>(null);
  const [projects, setProjects] = useState<WorkbenchProject[]>([]);
  const [projectId, setProjectId] = useState('');
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [difficulty, setDifficulty] = useState('all');
  const [selectedProblemId, setSelectedProblemId] = useState('');
  const [selectedLanguage, setSelectedLanguage] = useState('python');
  const [code, setCode] = useState('');
  const [selectedSubmissionId, setSelectedSubmissionId] = useState('');
  const [bankInput, setBankInput] = useState('');
  const importRef = useRef<HTMLInputElement>(null);

  const projectState = (next: AssessmentResult) => ({ aiAssessment: { result: next } });

  const runWithProject = async (
    project: WorkbenchProject,
    action: string,
    input: Record<string, unknown>,
  ) => {
    const created = await toolApi.createJob(
      project.id,
      'ai-assessment',
      action,
      input,
      crypto.randomUUID(),
    );
    const job = await waitForJob(created.job.id);
    if (!job || job.status !== 'succeeded' || !isAssessmentResult(job.result)) {
      throw new Error(
        job?.error || text('评测服务未返回有效结果', 'The assessment service returned no valid result'),
      );
    }
    const saved = await toolApi.updateProject(project.id, project.title, projectState(job.result));
    setProjects((items) => [saved, ...items.filter((item) => item.id !== saved.id)]);
    setProjectId(saved.id);
    setResult(job.result);
    return job.result;
  };

  useEffect(() => {
    let active = true;
    async function bootstrap() {
      if (!executionAllowed) {
        setError(text('评测工作台暂不可用', 'The assessment workbench is unavailable'));
        setLoading(false);
        return;
      }
      try {
        const items = await toolApi.listProjects('ai-assessment');
        if (!active) return;
        setProjects(items);
        const existing = items[0];
        const stored = existing?.state.aiAssessment as { result?: AssessmentResult } | undefined;
        let output: AssessmentResult;
        if (existing && isAssessmentResult(stored?.result)) {
          setProjectId(existing.id);
          output = stored.result;
          setResult(output);
        } else {
          const created = await toolApi.createProject(
            'ai-assessment',
            text('我的编程评测', 'My coding assessment'),
            {},
          );
          if (!active) return;
          setProjects([created, ...items]);
          setProjectId(created.id);
          output = await runWithProject(created, 'load-sample', {});
        }
        if (!active) return;
        const problemId = output.state.selectedProblemId || output.catalog.problems[0]?.id || '';
        const language = output.state.selectedLanguage || 'python';
        const problem = output.catalog.problems.find((item) => item.id === problemId);
        setSelectedProblemId(problemId);
        setSelectedLanguage(language);
        setCode(
          output.state.drafts[`${problemId}:${language}`] ||
            problem?.starters[language] ||
            '',
        );
        setSelectedSubmissionId(output.state.activeSubmissionId || output.state.submissions[0]?.id || '');
      } catch (reason) {
        if (!active) return;
        setError(
          reason instanceof ApiError || reason instanceof Error
            ? reason.message
            : text('无法载入评测工作台', 'Unable to load the assessment workbench'),
        );
      } finally {
        if (active) setLoading(false);
      }
    }
    void bootstrap();
    return () => {
      active = false;
    };
    // Bootstrap is tied only to the capability boundary.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [executionAllowed]);

  const execute = async (action: string, extra: Record<string, unknown> = {}) => {
    if (!result || running) return null;
    setRunning(true);
    setError('');
    setMessage(text('正在处理并保存…', 'Processing and saving…'));
    try {
      let project = projects.find((item) => item.id === projectId);
      if (!project) {
        project = await toolApi.createProject(
          'ai-assessment',
          text('我的编程评测', 'My coding assessment'),
          projectState(result),
        );
        setProjects((items) => [project!, ...items]);
      }
      const output = await runWithProject(project, action, { state: result.state, ...extra });
      if (output.submission) {
        setSelectedSubmissionId(output.submission.id);
        setInspector('result');
      }
      setMessage(
        action === 'review-source'
          ? text('静态检查已完成。', 'Static review complete.')
          : action === 'submit'
            ? output.runtime.executionAvailable
              ? text('判题完成，已保存逐例结果。', 'Judging complete with per-case results saved.')
              : text('提交已保存，等待隔离执行节点。', 'Submission saved and awaiting an isolated runner.')
            : text('操作已完成并保存。', 'Operation completed and saved.'),
      );
      return output;
    } catch (reason) {
      setError(
        reason instanceof ApiError || reason instanceof Error
          ? reason.message
          : text('操作失败', 'Operation failed'),
      );
      setMessage('');
      return null;
    } finally {
      setRunning(false);
    }
  };

  const problems = useMemo(() => result?.catalog.problems ?? [], [result]);
  const submissions = useMemo(() => result?.state.submissions ?? [], [result]);
  const selectedProblem = problems.find((problem) => problem.id === selectedProblemId) ?? problems[0];
  const selectedLanguageItem = result?.languages.find((language) => language.key === selectedLanguage);
  const selectedSubmission =
    submissions.find((submission) => submission.id === selectedSubmissionId) ?? submissions[0];

  const filteredProblems = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase(locale === 'zh' ? 'zh-CN' : 'en-US');
    return problems.filter((problem) => {
      if (category !== 'all' && problem.category !== category) return false;
      if (difficulty !== 'all' && problem.difficulty !== difficulty) return false;
      if (!keyword) return true;
      return [problem.title, problem.category, ...problem.tags]
        .join(' ')
        .toLocaleLowerCase(locale === 'zh' ? 'zh-CN' : 'en-US')
        .includes(keyword);
    });
  }, [category, difficulty, locale, problems, query]);

  const verdict = (value: string) => verdictLabels[value]?.[locale] || value;

  const chooseProblem = (problem: Problem) => {
    if (selectedProblem && result) {
      setResult((current) => current ? {
        ...current,
        state: {
          ...current.state,
          drafts: {
            ...current.state.drafts,
            [`${selectedProblem.id}:${selectedLanguage}`]: code,
          },
        },
      } : current);
    }
    setSelectedProblemId(problem.id);
    setCode(
      result?.state.drafts[`${problem.id}:${selectedLanguage}`] ||
        problem.starters[selectedLanguage] ||
        '',
    );
    setInspector('problem');
  };

  const chooseLanguage = (language: string) => {
    if (!selectedProblem || !result) return;
    setResult((current) => current ? {
      ...current,
      state: {
        ...current.state,
        drafts: {
          ...current.state.drafts,
          [`${selectedProblem.id}:${selectedLanguage}`]: code,
        },
      },
    } : current);
    setSelectedLanguage(language);
    setCode(
      result.state.drafts[`${selectedProblem.id}:${language}`] ||
        selectedProblem.starters[language] ||
        '',
    );
  };

  const saveDraft = async () => {
    if (!selectedProblem) return;
    await execute('save-draft', {
      problemId: selectedProblem.id,
      language: selectedLanguage,
      code,
    });
  };

  const submit = async () => {
    if (!selectedProblem) return;
    await execute('submit', {
      problemId: selectedProblem.id,
      language: selectedLanguage,
      code,
    });
  };

  const exportWorkspace = async () => {
    const output = await execute('export');
    if (output?.export) {
      downloadBase64(output.export.base64, output.export.fileName, output.export.contentType);
      setMessage(text('评测交付包已生成。', 'Assessment delivery package generated.'));
    }
  };

  const switchProject = (nextId: string) => {
    const project = projects.find((item) => item.id === nextId);
    const stored = project?.state.aiAssessment as { result?: AssessmentResult } | undefined;
    if (!project || !isAssessmentResult(stored?.result)) return;
    const output = stored.result;
    const problemId = output.state.selectedProblemId || output.catalog.problems[0]?.id || '';
    const language = output.state.selectedLanguage || 'python';
    const problem = output.catalog.problems.find((item) => item.id === problemId);
    setProjectId(nextId);
    setResult(output);
    setSelectedProblemId(problemId);
    setSelectedLanguage(language);
    setCode(output.state.drafts[`${problemId}:${language}`] || problem?.starters[language] || '');
    setSelectedSubmissionId(output.state.activeSubmissionId || output.state.submissions[0]?.id || '');
    setMessage(text('已切换工作区。', 'Workspace switched.'));
  };

  const handleImport = async (file: File | undefined) => {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      setBankInput(JSON.stringify(parsed, null, 2));
      await execute('import-problems', { problems: parsed });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : text('题库文件无效', 'Invalid problem bank file'));
    }
  };

  if (loading || !result) {
    return (
      <section className={`aa-loading${error ? ' error' : ''}`}>
        {error ? <CircleAlert /> : <LoaderCircle className="spin" />}
        <strong>{error || text('正在载入多语言评测工作台', 'Loading the multilingual judge')}</strong>
        {!error && <span>{text('同步题库、提交记录与执行节点状态', 'Syncing problems, submissions, and runners')}</span>}
      </section>
    );
  }

  const summary = [
    { icon: BookOpenCheck, label: text('题库', 'Problems'), value: result.stats.problems, note: `${result.stats.testCases} ${text('测试', 'tests')}` },
    { icon: History, label: text('提交', 'Submissions'), value: result.stats.submissions, note: `${result.stats.queued} ${text('等待', 'queued')}` },
    { icon: CheckCircle2, label: text('通过', 'Accepted'), value: result.stats.accepted, note: `${result.stats.acceptanceRate}%` },
    { icon: LockKeyhole, label: text('隐藏测试', 'Hidden tests'), value: result.stats.hiddenCases, note: text('服务端脱敏', 'server-redacted') },
    { icon: ServerCog, label: text('执行节点', 'Runner'), value: result.runtime.executionAvailable ? text('在线', 'Online') : text('待接入', 'Offline'), note: result.runtime.provider },
  ];

  const tabs: Array<{ key: View; label: string; icon: typeof Code2 }> = [
    { key: 'workspace', label: text('题目与代码', 'Problem & code'), icon: Code2 },
    { key: 'submissions', label: text('提交记录', 'Submissions'), icon: History },
    { key: 'bank', label: text('题库管理', 'Problem bank'), icon: Layers3 },
    { key: 'runtime', label: text('运行节点', 'Runners'), icon: ServerCog },
    { key: 'analytics', label: text('分析', 'Analytics'), icon: BarChart3 },
    { key: 'delivery', label: text('交付', 'Delivery'), icon: Archive },
  ];

  return (
    <section className="aa-workbench">
      <header className="aa-topbar">
        <div className="aa-product">
          <span><TestTubes /></span>
          <div>
            <strong>{text('AI 测试与提交', 'AI Testing & Submission')}</strong>
            <small>{text('多语言在线判题控制台', 'Multilingual online judge console')}</small>
          </div>
        </div>
        <label className="aa-project-picker">
          <span>{text('当前工作区', 'Workspace')}</span>
          <NativeSelect value={projectId} onChange={(event) => switchProject(event.target.value)}>
            {projects.map((project) => <NativeSelectOption key={project.id} value={project.id}>{project.title}</NativeSelectOption>)}
          </NativeSelect>
        </label>
        <div className={`aa-runtime-pill ${result.runtime.executionAvailable ? 'ready' : 'waiting'}`}>
          <span aria-hidden="true" />
          <div>
            <b>{result.runtime.executionAvailable ? text('隔离执行器在线', 'Isolated runner online') : text('隔离执行器待接入', 'Runner not connected')}</b>
            <small>{result.runtime.endpointHost || result.runtime.provider}</small>
          </div>
        </div>
        <div className="aa-top-actions">
          <Button variant="outline" size="sm" onClick={() => void saveDraft()} disabled={running}><Save />{text('保存', 'Save')}</Button>
          <Button size="sm" onClick={() => void exportWorkspace()} disabled={running}><Download />{text('导出', 'Export')}</Button>
        </div>
      </header>

      <section className="aa-summary" aria-label={text('工作台摘要', 'Workspace summary')}>
        {summary.map(({ icon: Icon, label, value, note }) => (
          <article key={label}>
            <span><Icon /></span>
            <div><small>{label}</small><strong>{value}</strong></div>
            <em>{note}</em>
          </article>
        ))}
      </section>

      <nav className="aa-tabs" aria-label={text('评测工作区导航', 'Assessment workspace navigation')}>
        {tabs.map(({ key, label, icon: Icon }, index) => (
          <button key={key} className={view === key ? 'active' : ''} type="button" onClick={() => setView(key)}>
            <b>{String(index + 1).padStart(2, '0')}</b><Icon />{label}
          </button>
        ))}
      </nav>

      {(message || error) && (
        <div className={`aa-notice ${error ? 'error' : ''}`}>
          {error ? <CircleAlert /> : <CheckCircle2 />}
          <span>{error || message}</span>
          <button type="button" onClick={() => { setError(''); setMessage(''); }} aria-label={text('关闭提示', 'Dismiss')}><XCircle /></button>
        </div>
      )}

      {view === 'workspace' && selectedProblem && (
        <main className="aa-coding-layout">
          <aside className="aa-problem-browser">
            <header>
              <div><strong>{text('题目目录', 'Problems')}</strong><small>{filteredProblems.length} / {problems.length}</small></div>
              <button type="button" onClick={() => setView('bank')} aria-label={text('打开题库管理', 'Open problem bank')}><Layers3 /></button>
            </header>
            <div className="aa-search"><Search /><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={text('搜索题目或标签', 'Search problems or tags')} /></div>
            <div className="aa-filters">
              <label><Filter /><NativeSelect value={category} onChange={(event) => setCategory(event.target.value)}><NativeSelectOption value="all">{text('全部分类', 'All categories')}</NativeSelectOption>{result.catalog.categories.map((item) => <NativeSelectOption key={item} value={item}>{item}</NativeSelectOption>)}</NativeSelect></label>
              <NativeSelect value={difficulty} onChange={(event) => setDifficulty(event.target.value)}><NativeSelectOption value="all">{text('全部难度', 'All levels')}</NativeSelectOption>{['入门', '进阶', '挑战', '自定义'].map((item) => <NativeSelectOption key={item} value={item}>{item}</NativeSelectOption>)}</NativeSelect>
            </div>
            <div className="aa-problem-list">
              {filteredProblems.map((problem) => (
                <button key={problem.id} className={problem.id === selectedProblem.id ? 'active' : ''} type="button" onClick={() => chooseProblem(problem)}>
                  <span>{String(problem.number).padStart(2, '0')}</span>
                  <div><strong>{problem.title}</strong><small>{problem.category} · {problem.difficulty}</small></div>
                  <ChevronRight />
                </button>
              ))}
            </div>
          </aside>

          <section className="aa-editor-panel">
            <header className="aa-editorbar">
              <div><FileCode2 /><span><strong>{selectedProblem.number}. {selectedProblem.title}</strong><small>{selectedProblem.versionId}</small></span></div>
              <label>
                <NativeSelect value={selectedLanguage} onChange={(event) => chooseLanguage(event.target.value)}>
                  {result.languages.map((language) => <NativeSelectOption key={language.key} value={language.key}>{language.label}</NativeSelectOption>)}
                </NativeSelect>
              </label>
              <div>
                <Button variant="outline" size="sm" onClick={() => void execute('review-source', { code, language: selectedLanguage })} disabled={running}><FileSearch />{text('静态检查', 'Review')}</Button>
                <Button size="sm" onClick={() => void submit()} disabled={running || !code.trim()}><Play />{text('提交评测', 'Submit')}</Button>
              </div>
            </header>
            <div className="aa-monaco-shell">
              <MonacoCodeEditor
                path={`${selectedProblem.id}.${selectedLanguageItem?.extension || 'txt'}`}
                language={selectedLanguageItem?.monaco || 'plaintext'}
                value={code}
                onChange={setCode}
                onRun={() => void submit()}
                onSave={() => void saveDraft()}
              />
            </div>
            <footer className="aa-editor-footer">
              <span><TerminalSquare />Ctrl/⌘ + Enter {text('提交', 'submit')}</span>
              <span>{selectedProblem.limits.cpuTime}s CPU</span>
              <span>{Math.round(selectedProblem.limits.memory / 1024)} MB</span>
              <span>{code.split('\n').length} {text('行', 'lines')}</span>
              <span className="aa-source-hash">SHA-256 {result.state.lastReview?.sourceHash.slice(0, 12) || text('保存后生成', 'after save')}</span>
            </footer>
          </section>

          <aside className="aa-inspector">
            <nav>
              {([
                ['result', text('判题', 'Result'), Activity],
                ['problem', text('题目', 'Problem'), BookOpenCheck],
                ['history', text('历史', 'History'), History],
              ] as Array<[Inspector, string, typeof Activity]>).map(([key, label, Icon]) => (
                <button type="button" key={key} className={inspector === key ? 'active' : ''} onClick={() => setInspector(key)}><Icon />{label}</button>
              ))}
            </nav>
            <div className="aa-inspector-body">
              {inspector === 'result' && selectedSubmission && (
                <div className="aa-result-view">
                  <header>
                    <div><span className={`aa-verdict ${selectedSubmission.verdict.toLowerCase().replaceAll(' ', '-')}`}>{verdict(selectedSubmission.verdict)}</span><small>{selectedSubmission.id}</small></div>
                    <strong>{selectedSubmission.score}<small>/100</small></strong>
                  </header>
                  <div className="aa-result-metrics"><span><Clock3 />{selectedSubmission.timeMs} ms</span><span><Gauge />{Math.round(selectedSubmission.memoryKb / 1024)} MB</span><span><Braces />{result.languages.find((item) => item.key === selectedSubmission.language)?.label || selectedSubmission.language}</span></div>
                  <section className="aa-case-list">
                    {selectedSubmission.cases.map((item) => (
                      <article key={`${selectedSubmission.id}-${item.index}`} className={item.verdict === 'Accepted' ? 'passed' : item.verdict === 'Queued' ? 'queued' : 'failed'}>
                        <span>{item.verdict === 'Accepted' ? <Check /> : item.verdict === 'Queued' ? <Clock3 /> : <XCircle />}</span>
                        <div><strong>{item.visible ? item.name : text(`隐藏测试 ${item.index}`, `Hidden test ${item.index}`)}</strong><small>{verdict(item.verdict)} · {item.weight} {text('分', 'pts')}</small></div>
                        <em>{item.timeMs ? `${item.timeMs} ms` : '—'}</em>
                      </article>
                    ))}
                  </section>
                  {selectedSubmission.diagnostics.length > 0 && <section className="aa-diagnostics"><strong><Sparkles />{text('诊断', 'Diagnostics')}</strong>{selectedSubmission.diagnostics.map((item, index) => <p key={`${item.message}-${index}`}>{item.message}</p>)}</section>}
                </div>
              )}
              {inspector === 'result' && !selectedSubmission && <div className="aa-empty"><TestTubes /><span>{text('提交后查看逐例判题结果', 'Submit to see per-case results')}</span></div>}
              {inspector === 'problem' && (
                <article className="aa-statement">
                  <header><span>{selectedProblem.category}</span><span>{selectedProblem.difficulty}</span><span>{selectedProblem.testSummary.public} {text('公开', 'public')} · {selectedProblem.testSummary.hidden} {text('隐藏', 'hidden')}</span></header>
                  <h2>{selectedProblem.title}</h2>
                  <p>{selectedProblem.statement}</p>
                  <h3>{text('输入格式', 'Input')}</h3><p>{selectedProblem.inputFormat}</p>
                  <h3>{text('输出格式', 'Output')}</h3><p>{selectedProblem.outputFormat}</p>
                  <h3>{text('约束', 'Constraints')}</h3><ul>{selectedProblem.constraints.map((item) => <li key={item}>{item}</li>)}</ul>
                  <h3>{text('样例', 'Example')}</h3>
                  <div className="aa-sample"><span><b>{text('输入', 'Input')}</b><pre>{selectedProblem.samples[0]?.input}</pre></span><span><b>{text('输出', 'Output')}</b><pre>{selectedProblem.samples[0]?.output}</pre></span></div>
                </article>
              )}
              {inspector === 'history' && (
                <div className="aa-mini-history">
                  {submissions.slice(0, 12).map((item) => (
                    <button key={item.id} type="button" className={item.id === selectedSubmission?.id ? 'active' : ''} onClick={() => { setSelectedSubmissionId(item.id); setInspector('result'); }}>
                      <span className={`aa-dot ${item.verdict.toLowerCase().replaceAll(' ', '-')}`} />
                      <div><strong>{problems.find((problem) => problem.id === item.problemId)?.title || item.problemId}</strong><small>{formatTime(item.createdAt, locale)}</small></div>
                      <b>{item.score}</b>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </aside>
        </main>
      )}

      {view === 'submissions' && (
        <main className="aa-section-view aa-submissions-view">
          <header><div><History /><span><strong>{text('提交记录', 'Submission history')}</strong><small>{text('按题目版本、语言和源码摘要完整留痕', 'Audited by problem version, language, and source hash')}</small></span></div><Button variant="outline" size="sm" onClick={() => setView('workspace')}><Code2 />{text('返回代码区', 'Back to code')}</Button></header>
          <section className="aa-table-card">
            <table><thead><tr><th>{text('提交编号', 'Submission')}</th><th>{text('题目', 'Problem')}</th><th>{text('语言', 'Language')}</th><th>{text('结果', 'Verdict')}</th><th>{text('得分', 'Score')}</th><th>{text('耗时 / 内存', 'Time / memory')}</th><th>{text('提交时间', 'Submitted')}</th><th aria-label={text('操作', 'Actions')} /></tr></thead><tbody>{submissions.map((item) => <tr key={item.id}><td><code>{item.id}</code><small>{item.sourceHash.slice(0, 10)}</small></td><td>{problems.find((problem) => problem.id === item.problemId)?.title || item.problemId}</td><td>{result.languages.find((language) => language.key === item.language)?.label || item.language}</td><td><span className={`aa-verdict ${item.verdict.toLowerCase().replaceAll(' ', '-')}`}>{verdict(item.verdict)}</span></td><td><strong>{item.score}</strong></td><td>{item.timeMs} ms<small>{Math.round(item.memoryKb / 1024)} MB</small></td><td>{formatTime(item.createdAt, locale)}</td><td><Button variant="outline" size="sm" onClick={() => { setSelectedSubmissionId(item.id); setView('workspace'); setInspector('result'); }}>{text('查看', 'Open')}</Button></td></tr>)}</tbody></table>
          </section>
        </main>
      )}

      {view === 'bank' && (
        <main className="aa-section-view aa-bank-view">
          <header><div><Layers3 /><span><strong>{text('题库与测试组', 'Problem bank & test groups')}</strong><small>{text('公开测试可审阅，隐藏测试只保留元数据', 'Public tests are reviewable; hidden data stays redacted')}</small></span></div><div><input ref={importRef} type="file" accept="application/json,.json" hidden onChange={(event) => void handleImport(event.target.files?.[0])} /><Button variant="outline" size="sm" onClick={() => importRef.current?.click()}><Import />{text('导入题库', 'Import')}</Button><Button size="sm" onClick={() => void execute('validate-bank')}><ShieldCheck />{text('校验题库', 'Validate')}</Button></div></header>
          <section className="aa-bank-grid">
            <article className="aa-bank-catalog"><header><strong>{result.catalog.title}</strong><span>v{result.catalog.versionId}</span></header><div>{problems.map((problem) => <button type="button" key={problem.id} onClick={() => { chooseProblem(problem); setView('workspace'); }}><span>{String(problem.number).padStart(2, '0')}</span><div><strong>{problem.title}</strong><small>{problem.category} · {problem.difficulty}</small></div><em>{problem.testSummary.total} {text('测试', 'tests')}</em></button>)}</div></article>
            <article className="aa-bank-audit"><header><strong>{text('题库质量门禁', 'Bank quality gates')}</strong><span className={result.quality.valid ? 'passed' : 'failed'}>{result.quality.valid ? text('全部通过', 'Passed') : text('需要处理', 'Action required')}</span></header><div className="aa-gate-grid"><span><CheckCircle2 /><b>{text('测试权重', 'Test weights')}</b><small>100 / 100</small></span><span><LockKeyhole /><b>{text('隐藏数据脱敏', 'Hidden data redaction')}</b><small>{text('已启用', 'Enabled')}</small></span><span><FileSearch /><b>{text('版本可追溯', 'Version traceability')}</b><small>{result.catalog.versionId}</small></span><span><ShieldCheck /><b>{text('目录完整性', 'Catalog integrity')}</b><small>{result.catalog.integrity.slice(0, 12)}</small></span></div><label><strong>{text('导入内容预览', 'Import preview')}</strong><textarea value={bankInput} onChange={(event) => setBankInput(event.target.value)} placeholder={text('选择 JSON 题库文件后在此预览', 'Choose a JSON bank to preview it here')} /></label></article>
          </section>
        </main>
      )}

      {view === 'runtime' && (
        <main className="aa-section-view aa-runtime-view">
          <header><div><ServerCog /><span><strong>{text('隔离执行节点', 'Isolated runners')}</strong><small>{text('凭据只配置在服务端，浏览器不接触执行器密钥', 'Credentials stay server-side and never reach the browser')}</small></span></div><Button variant="outline" size="sm" onClick={() => void execute('refresh-runtime')}><RefreshCw />{text('刷新状态', 'Refresh')}</Button></header>
          <section className="aa-runtime-grid">
            <article className="aa-runner-primary"><header><span><ServerCog /></span><div><strong>{result.runtime.provider}</strong><small>{result.runtime.adapter}</small></div><em className={result.runtime.executionAvailable ? 'ready' : 'waiting'}>{result.runtime.executionAvailable ? text('在线', 'Online') : text('未配置', 'Not configured')}</em></header><dl><div><dt>{text('服务地址', 'Endpoint')}</dt><dd>{result.runtime.endpointHost || text('由服务端环境变量提供', 'Provided by server environment')}</dd></div><div><dt>{text('批量判题', 'Batch judge')}</dt><dd>{result.runtime.batch ? text('支持', 'Supported') : text('不支持', 'Unavailable')}</dd></div><div><dt>{text('资源限制', 'Resource limits')}</dt><dd>{result.runtime.resourceLimits ? text('强制', 'Enforced') : text('未启用', 'Disabled')}</dd></div><div><dt>{text('隐藏测试', 'Hidden tests')}</dt><dd>{result.runtime.hiddenTests ? text('服务端执行', 'Server-side') : text('未启用', 'Disabled')}</dd></div></dl></article>
            <article className="aa-runtime-contract"><header><strong>{text('执行契约', 'Execution contract')}</strong><span>{text('React → Go → Python → Sandbox', 'React → Go → Python → Sandbox')}</span></header><div>{[text('Go 负责身份、项目、任务与审计', 'Go handles identity, projects, jobs, and audit'), text('Python 负责编排测试组、评分与结果脱敏', 'Python orchestrates tests, scoring, and redaction'), text('Judge0 / go-judge 负责不受信任代码隔离', 'Judge0 / go-judge isolates untrusted code'), text('源码以 SHA-256 与题目版本共同留痕', 'Source SHA-256 is recorded with problem version')].map((item, index) => <span key={item}><b>{String(index + 1).padStart(2, '0')}</b>{item}<Check /></span>)}</div></article>
            <article className="aa-runtime-languages"><header><strong>{text('语言映射', 'Language mapping')}</strong><span>{result.languages.length} {text('种', 'languages')}</span></header><div>{result.languages.map((language) => <span key={language.key}><FileCode2 /><b>{language.label}</b><small>ID {language.id} · .{language.extension}</small></span>)}</div></article>
          </section>
        </main>
      )}

      {view === 'analytics' && (
        <main className="aa-section-view aa-analytics-view">
          <header><div><BarChart3 /><span><strong>{text('评测分析', 'Assessment analytics')}</strong><small>{text('结果分布、难度覆盖与知识主题结构', 'Verdict distribution, difficulty coverage, and topic structure')}</small></span></div></header>
          <section className="aa-analytics-grid">
            <article><header><strong>{text('结果分布', 'Verdict distribution')}</strong><span>{result.stats.finished} {text('已完成', 'finished')}</span></header><div className="aa-bars">{result.stats.verdictDistribution.map((item) => <span key={item.name}><label><b>{verdict(item.name)}</b><em>{item.value}</em></label><i><b style={{ width: `${Math.max(8, item.value / Math.max(1, result.stats.submissions) * 100)}%` }} /></i></span>)}</div></article>
            <article><header><strong>{text('难度结构', 'Difficulty mix')}</strong><span>{result.stats.problems} {text('题', 'problems')}</span></header><div className="aa-ring-wrap"><div className="aa-ring" style={{ '--aa-rate': `${result.stats.acceptanceRate * 3.6}deg` } as React.CSSProperties}><span><strong>{result.stats.acceptanceRate}%</strong><small>{text('通过率', 'accepted')}</small></span></div><div>{result.stats.difficultyDistribution.map((item) => <span key={item.name}><b>{item.name}</b><em>{item.value}</em></span>)}</div></div></article>
            <article className="wide"><header><strong>{text('知识主题覆盖', 'Topic coverage')}</strong><span>{result.stats.categoryDistribution.length} {text('个主题', 'topics')}</span></header><div className="aa-topic-grid">{result.stats.categoryDistribution.map((item) => <span key={item.name}><b>{item.name}</b><em>{item.value} {text('题', 'problems')}</em></span>)}</div></article>
          </section>
        </main>
      )}

      {view === 'delivery' && (
        <main className="aa-section-view aa-delivery-view">
          <header><div><Archive /><span><strong>{text('交付与审计', 'Delivery & audit')}</strong><small>{text('生成可复核的题库、提交历史与工作区快照', 'Package the bank, submission history, and workspace snapshot')}</small></span></div></header>
          <section className="aa-delivery-grid">
            <article className="aa-delivery-main"><span><Archive /></span><div><strong>{text('评测工作区交付包', 'Assessment workspace bundle')}</strong><p>{text('包含题库 JSON、提交记录、工作区配置和完整性摘要，可用于归档、复核和跨环境迁移。', 'Includes the problem bank, submissions, workspace settings, and integrity summary for review and migration.')}</p><ul><li>{problems.length} {text('道题目', 'problems')}</li><li>{submissions.length} {text('条提交记录', 'submissions')}</li><li>SHA-256 {text('完整性校验', 'integrity')}</li><li>{text('隐藏测试内容不进入前端导出', 'Hidden test data is not exposed in frontend views')}</li></ul><Button onClick={() => void exportWorkspace()} disabled={running}><Download />{text('生成 ZIP 交付包', 'Generate ZIP bundle')}</Button></div></article>
            <article className="aa-audit-card"><header><strong>{text('当前审计摘要', 'Current audit summary')}</strong><ShieldCheck /></header><dl><div><dt>{text('工作区编号', 'Workspace ID')}</dt><dd>{result.state.workspaceId}</dd></div><div><dt>{text('题库版本', 'Catalog version')}</dt><dd>{result.catalog.versionId}</dd></div><div><dt>{text('目录摘要', 'Catalog hash')}</dt><dd>{result.catalog.integrity.slice(0, 20)}</dd></div><div><dt>{text('最后更新', 'Last updated')}</dt><dd>{formatTime(result.state.updatedAt, locale)}</dd></div></dl></article>
          </section>
        </main>
      )}
    </section>
  );
}
