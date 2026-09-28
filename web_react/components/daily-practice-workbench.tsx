'use client';

import { useEffect, useRef, useState } from 'react';
import {
  BarChart3,
  BrainCircuit,
  BookCheck,
  Bookmark,
  BookmarkCheck,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  Download,
  FileClock,
  Filter,
  GraduationCap,
  History,
  Layers3,
  LoaderCircle,
  Play,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  Target,
  X,
} from 'lucide-react';
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

type Localized = { zh: string; en: string };
type PracticeQuestion = {
  id: string;
  versionId: string;
  category: string;
  difficulty: 1 | 2 | 3 | 4 | 5;
  type: 'single' | 'multiple' | 'boolean' | 'fill' | 'numeric' | 'ordering' | 'case';
  prompt: Localized;
  choices: Localized[];
  skill: string;
  cognitiveLevel: 'remember' | 'apply' | 'analyze' | 'evaluate';
  estimatedMinutes: number;
  tags: string[];
  sourceKind: 'original' | 'parameterized';
  variant: number;
};
type PracticeAnswer = {
  questionId: string;
  questionVersionId: string;
  selected: number | number[] | string;
  correct: boolean;
  source: 'practice' | 'adaptive' | 'review' | 'exam';
  answeredAt: string;
  confidence?: number;
  elapsedSeconds?: number;
  feedback?: { correctAnswer: Localized | string; explanation: Localized };
};
type ActiveExam = {
  attemptId: string;
  bankVersionId: string;
  questionIds: string[];
  startedAt: number;
  endsAt: number;
  durationMinutes: number;
  courseId: string;
  learnerId: string;
  token: string;
  answers: Record<string, { selected: number | number[] | string; savedAt: string }>;
  status: string;
  remainingSeconds: number;
};
type ExamResult = {
  attemptId: string;
  bankVersionId: string;
  score: number;
  total: number;
  rate: number;
  answered: number;
  startedAt: string;
  finishedAt: string;
  durationSeconds: number;
  autoSubmitted: boolean;
  review: Array<{
    questionId: string;
    selected: number | number[] | string | null;
    correct: boolean;
    correctAnswer: Localized | string;
    explanation: Localized;
  }>;
};
type PracticeState = {
  bankId: string;
  bankVersionId: string;
  practiceSession: {
    id: string;
    answers: Record<string, PracticeAnswer>;
    attempts: PracticeAnswer[];
    startedAt: string;
    updatedAt: string;
  };
  favorites: string[];
  skillMastery: Record<string, { rating: number; attempts: number; correct: number; streak: number }>;
  reviewSchedule: Record<string, { questionId: string; dueAt: number; intervalDays: number; repetitions: number; ease: number }>;
  adaptiveSession: {
    id: string;
    mode: 'adaptive' | 'weak' | 'review' | 'challenge';
    questionIds: string[];
    position: number;
    createdAt: string;
    modelVersion: string;
  } | null;
  activeExam: ActiveExam | null;
  lastExamResult?: ExamResult | null;
  examHistory: Array<{
    attemptId: string;
    bankVersionId: string;
    score: number;
    total: number;
    rate: number;
    answered: number;
    startedAt: string;
    finishedAt: string;
    durationSeconds: number;
    autoSubmitted: boolean;
  }>;
};
type PracticeResult = {
  schema: 'skyview-daily-practice-results';
  version: number;
  stage: string;
  bank: {
    id: string;
    versionId: string;
    status: string;
    questionCount: number;
    checksum: string;
    publishedAt: string;
  };
  topics: Array<{ id: string; label: Localized }>;
  questions: PracticeQuestion[];
  state: PracticeState;
  stats: {
    total: number;
    answered: number;
    correct: number;
    wrong: number;
    accuracy: number;
    mastery: number;
    favorites: number;
    examAttempts: number;
    categories: Array<{
      category: string;
      total: number;
      answered: number;
      correct: number;
      attempts: number;
      mastery: number;
    }>;
    skills: Array<{ skill: string; rating: number; mastery: number; attempts: number; correct: number }>;
    dueReviews: number;
    advancedQuestions: number;
  };
  feedback?: {
    questionId: string;
    correct: boolean;
    correctAnswer: Localized | string;
    explanation: Localized;
  };
  favorite?: { questionId: string; active: boolean };
  exam?: { attempt: ActiveExam; questions: PracticeQuestion[] };
  examResult?: ExamResult;
  adaptive?: { session: NonNullable<PracticeState['adaptiveSession']>; questions: PracticeQuestion[] };
  exports?: { answersCsv: string; skillCsv: string; reportMarkdown: string; backupJson: string; qtiXml: string };
};

type View = 'practice' | 'adaptive' | 'exam' | 'analytics' | 'history' | 'bank';
type Mode = 'all' | 'unanswered' | 'wrong' | 'favorites' | 'adaptive';
type Selection = number | number[] | string | null;

const terminalStatuses = new Set(['succeeded', 'failed', 'canceled']);
const wait = (milliseconds: number) =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));

async function waitForJob(id: string): Promise<WorkbenchJob | null> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const job = await toolApi.getJob(id);
    if (terminalStatuses.has(job.status)) return job;
    await wait(650);
  }
  return null;
}

function downloadText(content: string, fileName: string, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob(['\ufeff', content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function isPracticeResult(value: unknown): value is PracticeResult {
  return Boolean(
    value &&
      typeof value === 'object' &&
      (value as PracticeResult).schema === 'skyview-daily-practice-results' &&
      Array.isArray((value as PracticeResult).questions),
  );
}

function selectionEquals(left: Selection, right: Selection) {
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      [...left].sort((a, b) => Number(a) - Number(b)).join(',') ===
        [...right].sort((a, b) => Number(a) - Number(b)).join(',')
    );
  }
  return String(left ?? '') === String(right ?? '');
}

export function DailyPracticeWorkbench({
  executionAllowed = true,
}: {
  executionAllowed?: boolean;
}) {
  const { locale, text } = useLanguage();
  const [view, setView] = useState<View>('practice');
  const [result, setResult] = useState<PracticeResult | null>(null);
  const [projects, setProjects] = useState<WorkbenchProject[]>([]);
  const [projectId, setProjectId] = useState('');
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [difficulty, setDifficulty] = useState('all');
  const [mode, setMode] = useState<Mode>('all');
  const [adaptiveMode, setAdaptiveMode] = useState<'adaptive' | 'weak' | 'review' | 'challenge'>('adaptive');
  const [confidence, setConfidence] = useState(3);
  const [selectedId, setSelectedId] = useState('');
  const [selection, setSelection] = useState<Selection>(null);
  const [selectionOwner, setSelectionOwner] = useState('');
  const [examCount, setExamCount] = useState('20');
  const [examDuration, setExamDuration] = useState('20');
  const [examIndex, setExamIndex] = useState(0);
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const autoSubmitRef = useRef(false);

  const pick = (value: Localized | string | undefined) =>
    typeof value === 'string' ? value : value?.[locale] || value?.zh || '';

  const projectState = (next: PracticeResult) => ({ dailyPractice: { result: next } });

  const runWithProject = async (
    project: WorkbenchProject,
    action: string,
    input: Record<string, unknown>,
  ) => {
    const created = await toolApi.createJob(
      project.id,
      'daily-practice',
      action,
      input,
      crypto.randomUUID(),
    );
    const job = await waitForJob(created.job.id);
    if (!job || job.status !== 'succeeded' || !isPracticeResult(job.result)) {
      throw new Error(job?.error || text('计算服务未返回有效结果', 'The assessment service returned no valid result'));
    }
    const saved = await toolApi.updateProject(
      project.id,
      project.title,
      projectState(job.result),
    );
    setProjects((items) => [saved, ...items.filter((item) => item.id !== saved.id)]);
    setProjectId(saved.id);
    setResult(job.result);
    return job.result;
  };

  useEffect(() => {
    let active = true;
    async function bootstrap() {
      if (!executionAllowed) {
        setLoading(false);
        setError(text('日常做题服务尚未开放', 'Daily Practice is not available'));
        return;
      }
      try {
        const items = await toolApi.listProjects('daily-practice');
        if (!active) return;
        setProjects(items);
        const existing = items[0];
        const saved = existing?.state.dailyPractice as { result?: PracticeResult } | undefined;
        if (existing && isPracticeResult(saved?.result)) {
          if (saved.result.bank.questionCount < 720 || saved.result.version < 2) {
            const upgraded = await runWithProject(existing, 'upgrade-bank', { state: saved.result.state });
            if (!active) return;
            setSelectedId(upgraded.questions[0]?.id || '');
            return;
          }
          setProjectId(existing.id);
          setResult(saved.result);
          setSelectedId(saved.result.questions[0]?.id || '');
          return;
        }
        const created = await toolApi.createProject('daily-practice', text('我的日常练习', 'My daily practice'), {});
        if (!active) return;
        setProjects([created, ...items]);
        setProjectId(created.id);
        const output = await runWithProject(created, 'load-sample', {});
        if (!active) return;
        setSelectedId(output.questions[0]?.id || '');
      } catch (reason) {
        if (!active) return;
        setError(
          reason instanceof ApiError || reason instanceof Error
            ? reason.message
            : text('无法载入题库', 'Unable to load the question bank'),
        );
      } finally {
        if (active) setLoading(false);
      }
    }
    void bootstrap();
    return () => {
      active = false;
    };
    // Bootstrap intentionally runs only when capability availability changes.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [executionAllowed]);

  const execute = async (action: string, extra: Record<string, unknown> = {}) => {
    if (!result || running) return null;
    setRunning(true);
    setError('');
    setMessage(text('正在保存并计算…', 'Saving and calculating…'));
    try {
      let project = projects.find((item) => item.id === projectId);
      if (!project) {
        project = await toolApi.createProject(
          'daily-practice',
          text('我的日常练习', 'My daily practice'),
          projectState(result),
        );
        setProjects((items) => [project!, ...items]);
      }
      const output = await runWithProject(project, action, { state: result.state, ...extra });
      setMessage(
        action === 'answer-practice'
          ? output.feedback?.correct
            ? text('回答正确，学习记录已保存。', 'Correct. Your progress is saved.')
            : text('已完成批改，请查看解析。', 'Graded. Review the explanation.')
          : action === 'submit-exam'
            ? text('试卷已由服务端完成评分。', 'The exam was graded by the server.')
            : text('操作已完成并保存。', 'The operation is complete and saved.'),
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

  const answers = result?.state.practiceSession.answers ?? {};
  const questions = result?.questions ?? [];
  const filteredQuestions = (() => {
    const keyword = query.trim().toLocaleLowerCase(locale === 'zh' ? 'zh-CN' : 'en-US');
    return questions.filter((question) => {
      const answer = answers[question.id];
      if (category !== 'all' && question.category !== category) return false;
      if (difficulty !== 'all' && String(question.difficulty) !== difficulty) return false;
      if (mode === 'unanswered' && answer) return false;
      if (mode === 'wrong' && (!answer || answer.correct)) return false;
      if (mode === 'favorites' && !result?.state.favorites.includes(question.id)) return false;
      if (mode === 'adaptive' && !result?.state.adaptiveSession?.questionIds.includes(question.id)) return false;
      if (!keyword) return true;
      const searchable = [pick(question.prompt), ...question.choices.map((choice) => pick(choice))]
        .join(' ')
        .toLocaleLowerCase(locale === 'zh' ? 'zh-CN' : 'en-US');
      return searchable.includes(keyword);
    });
  })();

  const selected = filteredQuestions.find((question) => question.id === selectedId) ?? filteredQuestions[0];
  const savedAnswer = selected ? answers[selected.id] : undefined;

  const activeExam = result?.state.activeExam;
  const examQuestions = (activeExam?.questionIds ?? [])
    .map((id) => questions.find((question) => question.id === id))
    .filter((question): question is PracticeQuestion => Boolean(question));
  const currentExamQuestion = examQuestions[examIndex];
  const latestExamResult = result?.examResult ?? result?.state.lastExamResult ?? null;

  const selectionForQuestion = (question: PracticeQuestion) => {
    if (selectionOwner === question.id) return selection;
    if (view === 'exam' && activeExam?.questionIds.includes(question.id)) {
      return activeExam.answers[question.id]?.selected ?? null;
    }
    return answers[question.id]?.selected ?? null;
  };

  const executeRef = useRef(execute);
  const runningRef = useRef(running);
  useEffect(() => {
    executeRef.current = execute;
    runningRef.current = running;
  });

  useEffect(() => {
    if (!activeExam) {
      autoSubmitRef.current = false;
      return;
    }
    const refresh = () => {
      const value = Math.max(0, activeExam.endsAt - Math.floor(Date.now() / 1000));
      setRemainingSeconds(value);
      if (value === 0 && !autoSubmitRef.current && !runningRef.current) {
        autoSubmitRef.current = true;
        void executeRef.current('submit-exam', { autoSubmit: true });
      }
    };
    const frame = window.requestAnimationFrame(refresh);
    const timer = window.setInterval(refresh, 1000);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearInterval(timer);
    };
  }, [activeExam]);

  const choose = (question: PracticeQuestion, value: number | string) => {
    const currentSelection = selectionForQuestion(question);
    setSelectionOwner(question.id);
    if (question.type === 'multiple' || question.type === 'ordering') {
      const values = Array.isArray(currentSelection) ? currentSelection.map(Number) : [];
      const option = Number(value);
      setSelection(values.includes(option) ? values.filter((item) => item !== option) : [...values, option]);
      return;
    }
    setSelection(value);
  };

  const hasSelection = (question: PracticeQuestion | undefined) => {
    if (!question) return false;
    const currentSelection = selectionForQuestion(question);
    if (question.type === 'multiple') return Array.isArray(currentSelection) && currentSelection.length > 0;
    if (question.type === 'ordering') return Array.isArray(currentSelection) && currentSelection.length === question.choices.length;
    return currentSelection !== null && String(currentSelection).trim().length > 0;
  };

  const submitPractice = async () => {
    if (!selected || !hasSelection(selected)) {
      setError(text('请先选择或填写答案。', 'Choose or enter an answer first.'));
      return;
    }
    await execute('answer-practice', {
      questionId: selected.id,
      selected: selectionForQuestion(selected),
      source: mode === 'adaptive' ? 'adaptive' : 'practice',
      confidence,
      elapsedSeconds: 0,
    });
  };

  const saveExamAnswer = async (move = 0) => {
    if (!currentExamQuestion) return;
    if (hasSelection(currentExamQuestion)) {
      const output = await execute('save-exam-answer', {
        questionId: currentExamQuestion.id,
        selected: selectionForQuestion(currentExamQuestion),
      });
      if (!output) return;
    }
    const next = Math.max(0, Math.min(examQuestions.length - 1, examIndex + move));
    setExamIndex(next);
  };

  const formatClock = (seconds: number) =>
    `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;

  const categoryLabel = (value: string) => {
    const topic = result?.topics.find((item) => item.id === value);
    return topic ? pick(topic.label) : value;
  };
  const typeLabel = (value: PracticeQuestion['type']) =>
    ({
      single: text('单选题', 'Single choice'),
      multiple: text('多选题', 'Multiple choice'),
      boolean: text('判断题', 'True / false'),
      fill: text('填空题', 'Fill in'),
      numeric: text('数值题', 'Numeric'),
      ordering: text('排序题', 'Ordering'),
      case: text('案例题', 'Case analysis'),
    })[value];

  if (loading) {
    return (
      <section className="dp-loading" aria-live="polite">
        <LoaderCircle className="spin" />
        <strong>{text('正在载入 720 题专业题库…', 'Loading the 720-question professional bank…')}</strong>
        <span>{text('题目、学习记录与考试状态会自动恢复', 'Questions, progress, and exam state restore automatically')}</span>
      </section>
    );
  }

  if (!result) {
    return (
      <section className="dp-loading error" aria-live="polite">
        <CircleAlert />
        <strong>{text('题库暂时无法载入', 'The question bank could not be loaded')}</strong>
        <span>{error}</span>
        <Button onClick={() => window.location.reload()}>
          <RefreshCw /> {text('重新连接', 'Reconnect')}
        </Button>
      </section>
    );
  }

  const views: Array<[View, string, React.ReactNode]> = [
    ['practice', text('题库训练', 'Practice'), <BookCheck key="practice" />],
    ['adaptive', text('智能训练', 'Adaptive'), <BrainCircuit key="adaptive" />],
    ['exam', text('模拟考试', 'Mock exam'), <GraduationCap key="exam" />],
    ['analytics', text('掌握分析', 'Mastery'), <BarChart3 key="analytics" />],
    ['history', text('考试记录', 'History'), <History key="history" />],
    ['bank', text('题库信息', 'Question bank'), <ShieldCheck key="bank" />],
  ];
  const summaryItems: Array<{
    label: string;
    value: string;
    icon: typeof BookCheck;
  }> = [
    { label: text('已完成', 'Completed'), value: `${result.stats.answered}/${result.stats.total}`, icon: BookCheck },
    { label: text('答对', 'Correct'), value: String(result.stats.correct), icon: CheckCircle2 },
    { label: text('正确率', 'Accuracy'), value: `${result.stats.accuracy}%`, icon: Target },
    { label: text('待复习', 'Due review'), value: String(result.stats.dueReviews), icon: FileClock },
    { label: text('高阶题', 'Advanced'), value: String(result.stats.advancedQuestions), icon: Layers3 },
  ];

  return (
    <div className="dp-workbench" data-view={view}>
      <header className="dp-topbar">
        <div className="dp-product">
          <span><Target /></span>
          <div>
            <strong>{text('专业学习与测评中心', 'Professional Learning & Assessment')}</strong>
            <small>{result.bank.questionCount} {text('题', 'questions')} · 6 {text('领域', 'domains')} · {result.bank.versionId}</small>
          </div>
        </div>
        <label className="dp-project-picker">
          <span>{text('学习项目', 'Learning project')}</span>
          <NativeSelect
            aria-label={text('学习项目', 'Learning project')}
            value={projectId}
            onChange={(event) => {
              const next = projects.find((project) => project.id === event.target.value);
              const saved = next?.state.dailyPractice as { result?: PracticeResult } | undefined;
              if (next && isPracticeResult(saved?.result)) {
                setProjectId(next.id);
                setResult(saved.result);
                setSelectedId(saved.result.questions[0]?.id || '');
              }
            }}
          >
            {projects.map((project) => (
              <NativeSelectOption key={project.id} value={project.id}>{project.title}</NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        <div className="dp-actions">
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              const project = projects.find((item) => item.id === projectId);
              if (!project) return;
              await toolApi.createVersion(project.id, text('学习进度快照', 'Progress snapshot'), projectState(result));
              setMessage(text('学习进度快照已保存。', 'Progress snapshot saved.'));
            }}
          >
            <Save /> {text('保存快照', 'Save snapshot')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              const output = await execute('export');
              if (output?.exports) downloadText(output.exports.reportMarkdown, text('日常做题学习报告.md', 'daily-practice-report.md'));
            }}
          >
            <Download /> {text('导出报告', 'Export report')}
          </Button>
        </div>
      </header>

      <section className="dp-summary" aria-label={text('学习概览', 'Learning summary')}>
        {summaryItems.map(({ label, value, icon: Icon }) => (
          <article key={label}>
            <span><Icon /></span><div><small>{label}</small><strong>{value}</strong></div>
          </article>
        ))}
      </section>

      <nav className="dp-tabs" aria-label={text('功能视图', 'Workspace views')}>
        {views.map(([id, label, icon], index) => (
          <button key={id} className={view === id ? 'active' : ''} onClick={() => setView(id)}>
            <b>{String(index + 1).padStart(2, '0')}</b>{icon}<span>{label}</span>
            {id === 'exam' && activeExam && <i>{formatClock(remainingSeconds)}</i>}
          </button>
        ))}
      </nav>

      {(message || error) && (
        <div className={`dp-status ${error ? 'error' : ''}`}>
          {error ? <CircleAlert /> : <CheckCircle2 />}
          <span>{error || message}</span>
          <button aria-label={text('关闭状态', 'Dismiss')} onClick={() => { setError(''); setMessage(''); }}><X /></button>
        </div>
      )}

      <main className="dp-stage">
        {view === 'practice' && (
          <div className="dp-practice-layout">
            <aside className="dp-question-browser">
              <div className="dp-search"><Search /><Input aria-label={text('搜索题目', 'Search questions')} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={text('搜索题目或选项', 'Search questions or choices')} /></div>
              <div className="dp-filter-row">
                <NativeSelect aria-label={text('分类', 'Category')} value={category} onChange={(event) => setCategory(event.target.value as typeof category)}>
                  <NativeSelectOption value="all">{text('全部分类', 'All topics')}</NativeSelectOption>
                  {result.topics.map((topic) => <NativeSelectOption key={topic.id} value={topic.id}>{pick(topic.label)}</NativeSelectOption>)}
                </NativeSelect>
                <NativeSelect aria-label={text('难度', 'Difficulty')} value={difficulty} onChange={(event) => setDifficulty(event.target.value as typeof difficulty)}>
                  <NativeSelectOption value="all">{text('全部难度', 'All levels')}</NativeSelectOption>
                  <NativeSelectOption value="1">★☆☆☆☆</NativeSelectOption>
                  <NativeSelectOption value="2">★★☆☆☆</NativeSelectOption>
                  <NativeSelectOption value="3">★★★☆☆</NativeSelectOption>
                  <NativeSelectOption value="4">★★★★☆</NativeSelectOption>
                  <NativeSelectOption value="5">★★★★★</NativeSelectOption>
                </NativeSelect>
              </div>
              <div className="dp-mode-row" aria-label={text('练习筛选', 'Practice filters')}>
                {([
                  ['all', text('全部', 'All')],
                  ['unanswered', text('未答', 'Open')],
                  ['wrong', text('错题', 'Wrong')],
                  ['favorites', text('收藏', 'Saved')],
                  ['adaptive', text('智能队列', 'Adaptive')],
                ] as Array<[Mode, string]>).map(([id, label]) => (
                  <button key={id} className={mode === id ? 'active' : ''} onClick={() => setMode(id)}>{label}</button>
                ))}
              </div>
              <div className="dp-browser-heading"><span><Filter />{text('题目目录', 'Questions')}</span><strong>{filteredQuestions.length}</strong></div>
              <div className="dp-question-list">
                {filteredQuestions.map((question, index) => {
                  const answer = answers[question.id];
                  return (
                    <button key={question.id} className={`${selected?.id === question.id ? 'active' : ''} ${answer?.correct ? 'correct' : answer ? 'wrong' : ''}`} onClick={() => setSelectedId(question.id)}>
                      <b>{String(index + 1).padStart(2, '0')}</b>
                      <span><strong>{pick(question.prompt)}</strong><small>{categoryLabel(question.category)} · {'★'.repeat(question.difficulty)}{'☆'.repeat(5 - question.difficulty)} · {question.skill}</small></span>
                      {result.state.favorites.includes(question.id) ? <BookmarkCheck /> : answer ? <Check /> : <i />}
                    </button>
                  );
                })}
                {!filteredQuestions.length && <p>{text('没有符合条件的题目，请调整筛选。', 'No questions match these filters.')}</p>}
              </div>
            </aside>

            {selected && (
              <section className="dp-question-card">
                <header>
                  <div className="dp-question-meta"><span>{categoryLabel(selected.category)}</span><span>{typeLabel(selected.type)}</span><span>{text('难度', 'Level')} {'★'.repeat(selected.difficulty)}{'☆'.repeat(5 - selected.difficulty)}</span><span>{selected.skill}</span><span>{text('预计', 'Est.')} {selected.estimatedMinutes} {text('分钟', 'min')}</span></div>
                  <button className={result.state.favorites.includes(selected.id) ? 'active' : ''} aria-label={text('收藏题目', 'Save question')} onClick={() => void execute('toggle-favorite', { questionId: selected.id })}>
                    {result.state.favorites.includes(selected.id) ? <BookmarkCheck /> : <Bookmark />}
                  </button>
                </header>
                <div className="dp-question-scroll">
                  <h2>{pick(selected.prompt)}</h2>
                  {selected.type === 'fill' || selected.type === 'numeric' ? (
                    <label className="dp-fill-answer"><span>{text('填写答案', 'Your answer')}</span><Input value={typeof selectionForQuestion(selected) === 'string' ? String(selectionForQuestion(selected)) : ''} onChange={(event) => { setSelectionOwner(selected.id); setSelection(event.target.value); }} placeholder={text('请输入答案', 'Enter your answer')} /></label>
                  ) : (
                    <div className="dp-options">
                      {selected.choices.map((choice, index) => {
                        const currentSelection = selectionForQuestion(selected);
                        const ordered = Array.isArray(currentSelection) ? currentSelection.map(Number) : [];
                        const checked = selected.type === 'multiple' || selected.type === 'ordering' ? ordered.includes(index) : selectionEquals(currentSelection, index);
                        const rank = selected.type === 'ordering' ? ordered.indexOf(index) + 1 : 0;
                        return <button key={`${selected.id}-${index}`} className={checked ? 'selected' : ''} onClick={() => choose(selected, index)}><b>{rank || String.fromCharCode(65 + index)}</b><span>{pick(choice)}</span><i>{checked && <Check />}</i></button>;
                      })}
                    </div>
                  )}
                  {savedAnswer?.feedback ? (
                    <div className={`dp-feedback ${savedAnswer.correct ? 'correct' : 'wrong'}`}>
                      {savedAnswer.correct ? <CheckCircle2 /> : <CircleAlert />}
                      <div><strong>{savedAnswer.correct ? text('回答正确', 'Correct') : text('答案需要调整', 'Review this answer')}</strong>{!savedAnswer.correct && <span>{text('正确答案：', 'Correct answer: ')}{pick(savedAnswer.feedback.correctAnswer)}</span>}<p>{pick(savedAnswer.feedback.explanation)}</p></div>
                    </div>
                  ) : (
                    <div className="dp-feedback pending"><ShieldCheck /><span>{selected.type === 'ordering' ? text('依次点击全部步骤完成排序，再提交判分。', 'Click every step in order, then submit.') : selected.type === 'multiple' ? text('可选择多个答案，提交后立即查看解析。', 'Select all that apply; feedback appears after submission.') : text('提交后立即批改并保存学习记录。', 'Submit for immediate grading and saved progress.')}</span></div>
                  )}
                </div>
                <footer>
                  <label className="dp-confidence"><span>{text('作答信心', 'Confidence')}</span><NativeSelect value={String(confidence)} onChange={(event) => setConfidence(Number(event.target.value))}>{[1,2,3,4,5].map((value) => <NativeSelectOption key={value} value={String(value)}>{value}</NativeSelectOption>)}</NativeSelect></label>
                  <Button onClick={() => void submitPractice()} disabled={running || !hasSelection(selected)}>{running ? <LoaderCircle className="spin" /> : <CheckCircle2 />}{savedAnswer ? text('重新作答', 'Try again') : text('提交答案', 'Submit answer')}</Button>
                  <Button variant="outline" onClick={() => {
                    const index = filteredQuestions.findIndex((item) => item.id === selected.id);
                    const next = filteredQuestions[(index + 1) % Math.max(1, filteredQuestions.length)];
                    if (next) setSelectedId(next.id);
                  }}>{text('下一题', 'Next')} <ChevronRight /></Button>
                </footer>
              </section>
            )}

            <aside className="dp-mastery-panel">
              <header><BarChart3 /><span>{text('知识掌握', 'Topic mastery')}</span></header>
              <div className="dp-mastery-ring" style={{ '--dp-value': `${result.stats.mastery * 3.6}deg` } as React.CSSProperties}><span><strong>{result.stats.mastery}%</strong><small>{text('总体掌握', 'overall')}</small></span></div>
              <div className="dp-topic-mastery">
                {result.stats.categories.map((item) => <article key={item.category}><div><span>{categoryLabel(item.category)}</span><strong>{item.correct}/{item.total}</strong></div><i><b style={{ width: `${item.mastery}%` }} /></i><small>{item.answered} {text('题已完成', 'completed')}</small></article>)}
              </div>
              <button className="dp-exam-shortcut" onClick={() => setView('exam')}><GraduationCap /><span><strong>{text('开始模拟考试', 'Start a mock exam')}</strong><small>{text('服务端计时与统一评分', 'Server timing and grading')}</small></span><ChevronRight /></button>
            </aside>
          </div>
        )}

        {view === 'adaptive' && (
          <div className="dp-adaptive-view">
            <section className="dp-adaptive-console">
              <header><div><BrainCircuit /><span>{text('智能训练引擎', 'Adaptive training engine')}</span></div><strong>{text('能力评分 + 间隔复习', 'Skill rating + spaced review')}</strong></header>
              <div className="dp-adaptive-modes">
                {([
                  ['adaptive', text('能力自适应', 'Adaptive'), text('根据每个能力点的评分选择略高于当前水平的题目。', 'Targets questions just above the current skill rating.')],
                  ['weak', text('弱项突破', 'Weak skills'), text('优先重练低评分能力点和最近错题。', 'Prioritizes low-rated skills and recent mistakes.')],
                  ['review', text('到期复习', 'Due review'), text('按间隔复习计划召回到期内容，降低遗忘。', 'Recalls due material using spaced repetition.')],
                  ['challenge', text('高阶挑战', 'Challenge'), text('集中训练四至五星的分析、评价与复杂案例题。', 'Focuses on level 4–5 analysis and evaluation cases.')],
                ] as const).map(([id, label, description]) => (
                  <button key={id} className={adaptiveMode === id ? 'active' : ''} onClick={() => setAdaptiveMode(id)}><span>{id === 'adaptive' ? <Sparkles /> : id === 'weak' ? <Target /> : id === 'review' ? <FileClock /> : <Layers3 />}</span><strong>{label}</strong><small>{description}</small></button>
                ))}
              </div>
              <div className="dp-adaptive-controls">
                <label><span>{text('训练领域', 'Domain')}</span><NativeSelect value={category} onChange={(event) => setCategory(event.target.value)}><NativeSelectOption value="all">{text('六领域综合', 'All six domains')}</NativeSelectOption>{result.topics.map((topic) => <NativeSelectOption key={topic.id} value={topic.id}>{pick(topic.label)}</NativeSelectOption>)}</NativeSelect></label>
                <Button disabled={running} onClick={async () => { const output = await execute('build-adaptive-session', { mode: adaptiveMode, category, count: 20 }); if (output?.state.adaptiveSession) { setMode('adaptive'); setSelectedId(output.state.adaptiveSession.questionIds[0] || ''); } }}>{running ? <LoaderCircle className="spin" /> : <BrainCircuit />}{text('生成 20 题训练队列', 'Build 20-question queue')}</Button>
              </div>
            </section>
            <section className="dp-adaptive-queue">
              <header><div><Layers3 /><span>{text('本轮训练队列', 'Current training queue')}</span></div><strong>{result.state.adaptiveSession?.questionIds.length || 0} {text('题', 'questions')}</strong></header>
              {result.state.adaptiveSession ? <>
                <div>{result.state.adaptiveSession.questionIds.slice(0, 12).map((id, index) => { const question = questions.find((item) => item.id === id); return question ? <article key={id}><b>{String(index + 1).padStart(2, '0')}</b><span><strong>{pick(question.prompt)}</strong><small>{categoryLabel(question.category)} · {question.skill}</small></span><em>{'★'.repeat(question.difficulty)}</em></article> : null; })}</div>
                <footer><span>{text('队列由服务端基于能力评分、历史正确率、到期复习和题目难度生成。', 'The server ranks questions using skill rating, history, review due time, and difficulty.')}</span><Button onClick={() => setView('practice')}><Play />{text('进入智能训练', 'Start adaptive training')}</Button></footer>
              </> : <div className="dp-empty"><BrainCircuit /><strong>{text('选择策略后生成个性化训练队列', 'Choose a strategy to build a personalized queue')}</strong><span>{text('首次训练会兼顾未作答题和高阶题；完成后会逐渐转向真实薄弱能力点。', 'The first run balances unseen and advanced questions, then adapts to measured weaknesses.')}</span></div>}
            </section>
            <section className="dp-skill-snapshot">
              <header><span>{text('能力点快照', 'Skill snapshot')}</span><strong>{result.stats.skills.filter((item) => item.attempts > 0).length}/{result.stats.skills.length}</strong></header>
              <div>{result.stats.skills.slice().sort((a,b) => a.mastery - b.mastery).slice(0, 10).map((skill) => <article key={skill.skill}><span><strong>{skill.skill}</strong><small>{skill.attempts} {text('次作答', 'attempts')}</small></span><i><b style={{ width: `${skill.mastery}%` }} /></i><em>{skill.mastery}%</em></article>)}</div>
            </section>
          </div>
        )}

        {view === 'exam' && !activeExam && (
          <div className="dp-exam-setup">
            <section className="dp-exam-intro">
              <span><GraduationCap /></span>
              <div><small>{text('模拟考试', 'Mock exam')}</small><h2>{text('从已发布题库组建一套限时试卷', 'Build a timed exam from the published bank')}</h2><p>{text('答题过程不显示正确答案和解析；交卷后由 Python 评分服务一次性反馈。刷新页面仍可恢复当前考试。', 'Answers and explanations remain hidden until the Python grading service receives the submission. The current exam survives refreshes.')}</p></div>
              <ul><li><ShieldCheck />{text('签名试卷凭证', 'Signed exam token')}</li><li><Clock3 />{text('服务端时间', 'Server clock')}</li><li><FileClock />{text('自动交卷', 'Automatic submission')}</li></ul>
            </section>
            <section className="dp-exam-builder">
              <header><span>{text('组卷设置', 'Exam settings')}</span><strong>{result.bank.questionCount} {text('题可选', 'questions available')}</strong></header>
              <div className="dp-exam-fields">
                <label><span>{text('知识分类', 'Topic')}</span><NativeSelect value={category} onChange={(event) => setCategory(event.target.value)}><NativeSelectOption value="all">{text('六领域均衡组卷', 'Balanced across six domains')}</NativeSelectOption>{result.topics.map((topic) => <NativeSelectOption key={topic.id} value={topic.id}>{pick(topic.label)}</NativeSelectOption>)}</NativeSelect></label>
                <label><span>{text('难度范围', 'Difficulty')}</span><NativeSelect value={difficulty} onChange={(event) => setDifficulty(event.target.value)}><NativeSelectOption value="all">{text('全部难度', 'All levels')}</NativeSelectOption>{[1,2,3,4,5].map((level) => <NativeSelectOption key={level} value={String(level)}>{'★'.repeat(level)}{'☆'.repeat(5-level)}</NativeSelectOption>)}</NativeSelect></label>
                <label><span>{text('题目数量', 'Questions')}</span><NativeSelect value={examCount} onChange={(event) => setExamCount(event.target.value)}>{['10', '20', '30', '50', '80', '100'].map((count) => <NativeSelectOption key={count} value={count}>{count} {text('题', 'questions')}</NativeSelectOption>)}</NativeSelect></label>
                <label><span>{text('考试时长', 'Duration')}</span><NativeSelect value={examDuration} onChange={(event) => setExamDuration(event.target.value)}>{['10', '20', '30', '45', '60', '90', '120'].map((minutes) => <NativeSelectOption key={minutes} value={minutes}>{minutes} {text('分钟', 'minutes')}</NativeSelectOption>)}</NativeSelect></label>
              </div>
              <Button size="lg" disabled={running} onClick={async () => { const output = await execute('start-exam', { count: Number(examCount), durationMinutes: Number(examDuration), category, difficulty, courseId: 'skyview-course-core', learnerId: 'authenticated-user' }); if (output) { setExamIndex(0); setSelectionOwner(''); setSelection(null); } }}><Play />{text('开始考试', 'Start exam')}</Button>
              {latestExamResult && <div className="dp-latest-result"><span>{text('最近成绩', 'Latest score')}</span><strong>{latestExamResult.score}/{latestExamResult.total}</strong><b>{latestExamResult.rate}%</b><button onClick={() => setView('history')}>{text('查看详情', 'View details')}</button></div>}
            </section>
          </div>
        )}

        {view === 'exam' && activeExam && currentExamQuestion && (
          <div className="dp-exam-room">
            <aside className="dp-exam-nav">
              <header><span>{text('答题卡', 'Answer sheet')}</span><strong>{Object.keys(activeExam.answers).length}/{examQuestions.length}</strong></header>
              <div>{examQuestions.map((question, index) => <button key={question.id} className={`${index === examIndex ? 'active' : ''} ${activeExam.answers[question.id] ? 'answered' : ''}`} onClick={() => setExamIndex(index)}>{index + 1}</button>)}</div>
              <p><i className="answered" />{text('已作答', 'Answered')}<i className="current" />{text('当前题', 'Current')}</p>
            </aside>
            <section className="dp-exam-question">
              <header><div><span>{categoryLabel(currentExamQuestion.category)} · {typeLabel(currentExamQuestion.type)}</span><strong>{text('第', 'Question ')} {examIndex + 1} {text('题', '')}</strong></div><time className={remainingSeconds < 300 ? 'urgent' : ''}><Clock3 />{formatClock(remainingSeconds)}</time></header>
              <div className="dp-exam-question-body">
                <h2>{pick(currentExamQuestion.prompt)}</h2>
                {currentExamQuestion.type === 'fill' || currentExamQuestion.type === 'numeric' ? <label className="dp-fill-answer"><span>{text('填写答案', 'Your answer')}</span><Input value={typeof selectionForQuestion(currentExamQuestion) === 'string' ? String(selectionForQuestion(currentExamQuestion)) : ''} onChange={(event) => { setSelectionOwner(currentExamQuestion.id); setSelection(event.target.value); }} /></label> : <div className="dp-options">{currentExamQuestion.choices.map((choice, index) => { const currentSelection = selectionForQuestion(currentExamQuestion); const ordered = Array.isArray(currentSelection) ? currentSelection.map(Number) : []; const checked = currentExamQuestion.type === 'multiple' || currentExamQuestion.type === 'ordering' ? ordered.includes(index) : selectionEquals(currentSelection, index); const rank = currentExamQuestion.type === 'ordering' ? ordered.indexOf(index) + 1 : 0; return <button key={index} className={checked ? 'selected' : ''} onClick={() => choose(currentExamQuestion, index)}><b>{rank || String.fromCharCode(65 + index)}</b><span>{pick(choice)}</span><i>{checked && <Check />}</i></button>; })}</div>}
                <div className="dp-feedback pending"><ShieldCheck /><span>{text('考试模式不会即时公布答案；当前选择保存后仍可修改。', 'Exam mode hides answers until submission; saved choices remain editable.')}</span></div>
              </div>
              <footer><Button variant="outline" disabled={examIndex === 0 || running} onClick={() => void saveExamAnswer(-1)}><ChevronLeft />{text('上一题', 'Previous')}</Button><Button disabled={running} onClick={() => void saveExamAnswer(1)}>{running ? <LoaderCircle className="spin" /> : <Save />}{text('保存并下一题', 'Save and next')}</Button><Button className="dp-submit-exam" disabled={running} onClick={() => void execute('submit-exam')}>{text('立即交卷', 'Submit exam')}</Button></footer>
            </section>
          </div>
        )}

        {view === 'analytics' && (
          <div className="dp-analytics-view">
            <section className="dp-analytics-hero"><div className="dp-mastery-ring large" style={{ '--dp-value': `${result.stats.mastery * 3.6}deg` } as React.CSSProperties}><span><strong>{result.stats.mastery}%</strong><small>{text('总体掌握度', 'Overall mastery')}</small></span></div><div><span>{text('学习进度', 'Learning progress')}</span><h2>{result.stats.answered} / {result.stats.total}</h2><p>{text('掌握度按当前题库中答对的不同题目计算；正确率按已作答题目计算。', 'Mastery counts distinct correct questions in the current bank; accuracy uses answered questions.')}</p></div><article><small>{text('累计作答', 'Attempts')}</small><strong>{result.state.practiceSession.attempts.length}</strong></article><article><small>{text('错题', 'Wrong')}</small><strong>{result.stats.wrong}</strong></article><article><small>{text('模拟考试', 'Exams')}</small><strong>{result.stats.examAttempts}</strong></article></section>
            <section className="dp-topic-grid">{result.stats.categories.map((item) => <article key={item.category}><header><span>{categoryLabel(item.category)}</span><strong>{item.mastery}%</strong></header><div className="dp-topic-chart"><i style={{ height: `${Math.max(8, item.mastery)}%` }} /><b style={{ height: `${Math.max(8, item.answered / item.total * 100)}%` }} /></div><dl><div><dt>{text('已完成', 'Completed')}</dt><dd>{item.answered}/{item.total}</dd></div><div><dt>{text('答对', 'Correct')}</dt><dd>{item.correct}</dd></div><div><dt>{text('待巩固', 'To improve')}</dt><dd>{Math.max(0, item.answered - item.correct)}</dd></div></dl><button onClick={() => { setCategory(item.category); setMode('wrong'); setView('practice'); }}>{text('练习本类错题', 'Practice mistakes')}</button></article>)}</section>
            <section className="dp-skill-matrix"><header><div><BrainCircuit /><span>{text('能力点诊断', 'Skill diagnostics')}</span></div><strong>{result.stats.skills.length} {text('项能力', 'skills')}</strong></header><div>{result.stats.skills.slice().sort((a,b) => b.attempts - a.attempts || a.mastery - b.mastery).slice(0, 18).map((skill) => <article key={skill.skill}><span><strong>{skill.skill}</strong><small>{skill.attempts} {text('次 · 评分', 'attempts · rating')} {skill.rating}</small></span><i><b style={{ width: `${skill.mastery}%` }} /></i><em>{skill.mastery}%</em></article>)}</div></section>
            <section className="dp-attempt-stream"><header><span>{text('最近作答', 'Recent answers')}</span><strong>{Math.min(12, result.state.practiceSession.attempts.length)} {text('条', 'items')}</strong></header><div>{result.state.practiceSession.attempts.slice().reverse().slice(0, 12).map((attempt, index) => { const question = questions.find((item) => item.id === attempt.questionId); return <button key={`${attempt.answeredAt}-${index}`} onClick={() => { setSelectedId(attempt.questionId); setView('practice'); }}><span className={attempt.correct ? 'correct' : 'wrong'}>{attempt.correct ? <Check /> : <X />}</span><strong>{question ? pick(question.prompt) : attempt.questionId}</strong><small>{categoryLabel(question?.category || 'python')} · {attempt.source === 'exam' ? text('考试', 'Exam') : text('练习', 'Practice')}</small><time>{attempt.answeredAt.slice(0, 16).replace('T', ' ')}</time></button>; })}</div></section>
          </div>
        )}

        {view === 'history' && (
          <div className="dp-history-view">
            <section className="dp-history-list"><header><div><History /><span>{text('模拟考试记录', 'Mock exam history')}</span></div><strong>{result.state.examHistory.length} {text('次', 'attempts')}</strong></header>{result.state.examHistory.length ? result.state.examHistory.map((exam, index) => <article key={exam.attemptId}><b>{String(index + 1).padStart(2, '0')}</b><span><strong>{exam.score}/{exam.total}</strong><small>{exam.finishedAt.slice(0, 16).replace('T', ' ')} · {Math.ceil(exam.durationSeconds / 60)} {text('分钟', 'min')}</small></span><div className="dp-scorebar"><i style={{ width: `${exam.rate}%` }} /></div><em>{exam.rate}%</em><small>{exam.autoSubmitted ? text('自动交卷', 'Auto submitted') : text('主动交卷', 'Submitted')}</small></article>) : <div className="dp-empty"><GraduationCap /><strong>{text('尚无模拟考试记录', 'No mock exam attempts yet')}</strong><button onClick={() => setView('exam')}>{text('开始第一次考试', 'Start your first exam')}</button></div>}</section>
            {latestExamResult ? <section className="dp-review-panel"><header><div><BookCheck /><span>{text('最近试卷解析', 'Latest exam review')}</span></div><strong>{latestExamResult.score}/{latestExamResult.total}</strong></header><div>{latestExamResult.review.map((item, index) => { const question = questions.find((entry) => entry.id === item.questionId); return <article key={item.questionId}><span className={item.correct ? 'correct' : 'wrong'}>{item.correct ? <Check /> : <X />}</span><div><strong>{index + 1}. {question ? pick(question.prompt) : item.questionId}</strong>{!item.correct && <small>{text('正确答案：', 'Correct answer: ')}{pick(item.correctAnswer)}</small>}<p>{pick(item.explanation)}</p></div></article>; })}</div></section> : <section className="dp-review-panel empty"><ShieldCheck /><strong>{text('交卷后在这里查看逐题解析', 'Question-level review appears here after submission')}</strong><span>{text('考试进行期间，答案和解析不会发送到浏览器。', 'Answers and explanations are not sent to the browser during an exam.')}</span></section>}
          </div>
        )}

        {view === 'bank' && (
          <div className="dp-bank-view">
            <section className="dp-bank-identity"><span><ShieldCheck /></span><div><small>{text('已发布专业题库', 'Published professional bank')}</small><h2>{text('六领域技术学习、训练与测评题库', 'Six-domain technical learning and assessment bank')}</h2><p>{text('保留卡片版 120 题，新增 600 道高阶原创参数化题，覆盖工程实践、算法、数据、统计、AI 与科研复现。', 'The original 120 questions remain, with 600 new advanced original parameterized questions across engineering, algorithms, data, statistics, AI, and reproducible research.')}</p></div><dl><div><dt>{text('版本', 'Version')}</dt><dd>{result.bank.versionId}</dd></div><div><dt>{text('状态', 'Status')}</dt><dd>{text('已发布', 'Published')}</dd></div><div><dt>{text('题目', 'Questions')}</dt><dd>{result.bank.questionCount}</dd></div><div><dt>{text('校验摘要', 'Checksum')}</dt><dd>{result.bank.checksum.slice(0, 12)}</dd></div></dl></section>
            <section className="dp-bank-matrix"><header><span>{text('题库构成', 'Bank composition')}</span><strong>6 × 120 = 720</strong></header><div>{result.topics.map((topic) => { const rows = questions.filter((item) => item.category === topic.id); return <article key={topic.id}><header><span>{pick(topic.label)}</span><strong>{rows.length}</strong></header><dl>{(['single', 'multiple', 'boolean', 'fill', 'ordering', 'case'] as PracticeQuestion['type'][]).map((type) => <div key={type}><dt>{typeLabel(type)}</dt><dd>{rows.filter((item) => item.type === type).length}</dd></div>)}</dl><div>{[1, 2, 3, 4, 5].map((level) => <span key={level}>{'★'.repeat(level)}{'☆'.repeat(5 - level)} <b>{rows.filter((item) => item.difficulty === level).length}</b></span>)}</div></article>; })}</div></section>
            <section className="dp-bank-safety"><header><ShieldCheck /><div><span>{text('答案隔离', 'Answer isolation')}</span><strong>{text('未作答前不下发答案和解析', 'No answers or explanations before submission')}</strong></div></header><div><article><b>01</b><span><strong>{text('练习行为', 'Practice behavior')}</strong><small>{text('仅在提交当前题后返回当前题解析', 'Only the submitted question receives feedback')}</small></span></article><article><b>02</b><span><strong>{text('考试行为', 'Exam behavior')}</strong><small>{text('所有答案在服务端统一评分后返回', 'All feedback arrives after server grading')}</small></span></article><article><b>03</b><span><strong>{text('时间与防篡改', 'Timing and tamper resistance')}</strong><small>{text('考试凭证签名，开始和截止时间由服务端校验', 'Signed token with server-validated start and end times')}</small></span></article></div></section>
            <section className="dp-bank-exports"><header><div><Download /><span>{text('标准化导出', 'Standardized export')}</span></div><strong>{text('学习记录与题库交换', 'Learning records and bank exchange')}</strong></header><div>{[
              [text('学习报告', 'Learning report'), 'reportMarkdown', text('日常做题学习报告.md', 'daily-practice-report.md')],
              [text('作答明细', 'Answer details'), 'answersCsv', text('日常做题作答明细.csv', 'daily-practice-answers.csv')],
              [text('能力画像', 'Skill profile'), 'skillCsv', text('日常做题能力画像.csv', 'daily-practice-skills.csv')],
              [text('完整备份', 'Full backup'), 'backupJson', text('日常做题完整备份.json', 'daily-practice-backup.json')],
              [text('QTI 交换清单', 'QTI exchange manifest'), 'qtiXml', text('日常做题-QTI.xml', 'daily-practice-qti.xml')],
            ].map(([label, key, fileName]) => <Button key={key} variant="outline" disabled={running} onClick={async () => { const output = await execute('export'); const content = output?.exports?.[key as keyof NonNullable<PracticeResult['exports']>]; if (content) downloadText(content, fileName); }}><Download />{label}</Button>)}</div></section>
          </div>
        )}
      </main>
    </div>
  );
}
