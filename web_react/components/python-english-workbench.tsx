'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Award, BookOpen, Brain, CheckCircle2, ChevronLeft, ChevronRight, Clock3,
  Download, FileArchive, Gauge, Headphones, Keyboard, Layers3, Library,
  ListChecks, LoaderCircle, LockKeyhole, Medal, Play, RotateCcw, Settings2,
  ShieldCheck, Sparkles, Speaker, Target, Trophy, Upload, Users, Volume2,
} from 'lucide-react';
import { useLanguage } from '@/components/language-provider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toolApi, type WorkbenchJob, type WorkbenchProject } from '@/services/api/tools';

type Word = { id: string; word: string; translation: string; example: string; ipa: string; category: string };
type WordSet = { id: string; name: string; description: string; words: Word[] };
type ExamMeta = { id: string; title: string; level: string; durationMinutes: number; description: string; questionCount: number };
type ReferenceGuide = { id: string; title: string; category: string; minutes: number; summary: string; sections: string[][]; code: string };
type ExamQuestion = { id: string; prompt: string; code: string; choices: Array<{ id: string; label: string }> };
type ActiveAttempt = { id: string; examId: string; title: string; startedAt: string; expiresAt: string; durationMinutes: number; questions: ExamQuestion[]; answers: Record<string, string>; status: string; currentIndex: number };
type CompletedAttempt = { id: string; examId: string; title: string; percent: number; passed: boolean; correct: number; total: number; submittedAt: string; review: Array<{ questionId: string; prompt: string; selectedChoiceId: string; correctChoiceId: string; correct: boolean; explanation: string }> };
type LearningProject = {
  schema: string; version: number; id: string; title: string; catalogVersion: string;
  activeSetId: string; activeWordId: string; activeMode: string;
  profile: { displayName: string; dailyGoalXp: number; leaderboardOptIn: boolean; sound: boolean; vibration: boolean };
  xpEvents: Array<{ id: string; key: string; xp: number; kind: string; termId: string; createdAt: string }>;
  progressByTerm: Record<string, { evidence: string[]; masteredAt: string | null }>;
  referenceReads: string[]; attempts: CompletedAttempt[]; activeAttempt: ActiveAttempt | null;
  customSets: WordSet[]; customExamDrafts: Array<{ id: string; title: string; questionCount: number; status: string }>;
  activities: Array<{ id: string; type: string; message: string; createdAt: string }>;
};
type PythonEnglishResult = {
  schema: string; version: number; stage: string; project: LearningProject;
  catalog: { version: string; vocabularySets: WordSet[]; exams: ExamMeta[]; references: ReferenceGuide[]; source: { name: string; repository: string; commit: string } };
  analysis: {
    metrics: { xp: number; level: string; levelIndex: number; nextLevelXp: number; levelProgress: number; streak: number; mastered: number; totalTerms: number; examAverage: number; completedExams: number; referencesRead: number };
    leaderboard: Array<{ rank: number; displayName: string; xp: number; level: string }>;
    awards: Array<{ id: string; name: string; earned: boolean }>;
  };
  runtime: Record<string, unknown>;
  exports: { projectJson: string; progressCsv: string; attemptsCsv: string; vocabularyJson: string; referencesMarkdown: string; packageBase64: string };
  examToken: string;
};

const setSeeds = [
  ['fundamentals', 'Fundamentals & Types', ['variable', 'assignment', 'integer', 'floating-point number', 'string', 'Boolean', 'type conversion', 'expression']],
  ['control-flow', 'Control Flow', ['condition', 'branch', 'loop', 'iteration', 'iterable', 'break statement', 'continue statement', 'comprehension']],
  ['collections', 'Collections', ['list', 'tuple', 'dictionary', 'set', 'key-value pair', 'index', 'slice', 'membership']],
  ['functions', 'Functions & Modules', ['function', 'parameter', 'argument', 'return value', 'scope', 'module', 'package', 'dependency']],
  ['oop-errors', 'OOP & Exceptions', ['class', 'instance', 'attribute', 'method', 'inheritance', 'exception', 'traceback', 'exception handler']],
  ['files-data', 'Files & Data', ['file path', 'encoding', 'context manager', 'delimiter', 'row', 'column', 'serialization', 'missing value']],
  ['testing', 'Testing & Debugging', ['test case', 'assertion', 'fixture', 'edge case', 'regression', 'breakpoint', 'side effect', 'reproducible']],
  ['scientific', 'Scientific Python', ['array', 'data frame', 'vectorized operation', 'sampling rate', 'uncertainty', 'baseline', 'reproducibility', 'interpretation']],
] as const;
const translations: Record<string, string> = {
  variable: '变量：绑定到对象的名称', assignment: '赋值：把对象绑定到名称', integer: '整数类型', 'floating-point number': '浮点数', string: '字符串：字符序列', Boolean: '布尔值：True 或 False', 'type conversion': '类型转换', expression: '表达式：可求值的代码组合',
  condition: '条件', branch: '分支', loop: '循环', iteration: '迭代', iterable: '可迭代对象', 'break statement': '终止当前循环', 'continue statement': '跳过当前迭代', comprehension: '推导式',
  list: '列表', tuple: '元组', dictionary: '字典', set: '集合', 'key-value pair': '键值对', index: '索引', slice: '切片', membership: '成员关系',
  function: '函数', parameter: '形参', argument: '实参', 'return value': '返回值', scope: '作用域', module: '模块', package: '包', dependency: '依赖项',
  class: '类', instance: '实例', attribute: '属性', method: '方法', inheritance: '继承', exception: '异常', traceback: '回溯信息', 'exception handler': '异常处理器',
  'file path': '文件路径', encoding: '字符编码', 'context manager': '上下文管理器', delimiter: '分隔符', row: '表格行', column: '表格列', serialization: '序列化', 'missing value': '缺失值',
  'test case': '测试用例', assertion: '断言', fixture: '测试夹具', 'edge case': '边界情况', regression: '回归问题', breakpoint: '断点', 'side effect': '副作用', reproducible: '可复现的',
  array: '数组', 'data frame': '数据框', 'vectorized operation': '向量化运算', 'sampling rate': '采样率', uncertainty: '不确定性', baseline: '基线', reproducibility: '可复现性', interpretation: '解释',
};
const setNamesZh: Record<string, string> = { fundamentals: '基础与类型', 'control-flow': '控制流程', collections: '集合与容器', functions: '函数与模块', 'oop-errors': '面向对象与异常', 'files-data': '文件与数据', testing: '测试与调试', scientific: '科学计算' };
const examNamesZh: Record<string, string> = { 'exam-core': 'Python 核心英语', 'exam-flow-functions': '控制流程与函数', 'exam-data-errors': '数据、文件与异常', 'exam-testing-science': '测试与科研表达' };
const referenceNamesZh: Record<string, string> = { 'ref-explain-code': '如何用英语解释 Python 代码', 'ref-read-traceback': '阅读 Python 回溯信息', 'ref-functions': '函数、参数与契约', 'ref-collections': '选择合适的 Python 集合', 'ref-files': '安全的本地文件处理', 'ref-tests': '编写基于证据的测试', 'ref-scientific': '用清晰英语表达科研结果', 'ref-present': '展示 Python 项目' };
const categoryNamesZh: Record<string, string> = { Communication: '技术表达', Debugging: '调试', 'Core Python': 'Python 基础', Data: '数据', Testing: '测试', Research: '科研表达' };

function sampleResult(): PythonEnglishResult {
  const sets: WordSet[] = setSeeds.map(([id, name, words]) => ({
    id, name, description: `${name} technical English`,
    words: words.map((word, index) => ({ id: `${id}-${index + 1}`, word, translation: translations[word] ?? word, example: `Use “${word}” to describe this Python operation precisely.`, ipa: '', category: name })),
  }));
  const now = '2026-09-15T02:40:00Z';
  const progressByTerm = Object.fromEntries(sets[0].words.slice(0, 6).map((word) => [word.id, { evidence: ['learn', 'cards', 'quiz'], masteredAt: now }]));
  const xpEvents = sets[0].words.slice(0, 6).flatMap((word, index) => ['learn', 'cards', 'quiz'].map((kind, order) => ({ id: `xp-${index}-${order}`, key: `sample:${word.id}:${kind}`, xp: kind === 'quiz' ? 12 : 8, kind, termId: word.id, createdAt: now })));
  const exams: ExamMeta[] = [
    ['exam-core', 'Python Core English', 'Foundation', 12, '类型、表达式、集合与准确代码解释'],
    ['exam-flow-functions', 'Control Flow & Functions', 'Intermediate', 14, '迭代、函数接口、作用域与复用设计'],
    ['exam-data-errors', 'Data, Files & Exceptions', 'Intermediate', 15, '文件、表格、异常与诊断表达'],
    ['exam-testing-science', 'Testing & Scientific Communication', 'Advanced', 16, '测试证据、数值工作流与科研表达'],
  ].map((item) => ({ id: item[0] as string, title: item[1] as string, level: item[2] as string, durationMinutes: item[3] as number, description: item[4] as string, questionCount: 8 }));
  const referenceNames = [
    ['ref-explain-code', 'How to Explain Python Code in English', 'Communication'], ['ref-read-traceback', 'Reading a Python Traceback', 'Debugging'],
    ['ref-functions', 'Functions, Parameters and Contracts', 'Core Python'], ['ref-collections', 'Choosing a Python Collection', 'Core Python'],
    ['ref-files', 'Safe Local File Handling', 'Data'], ['ref-tests', 'Writing Evidence-Based Tests', 'Testing'],
    ['ref-scientific', 'Scientific Results in Clear English', 'Research'], ['ref-present', 'Presenting a Python Project', 'Communication'],
  ];
  const references: ReferenceGuide[] = referenceNames.map((item, index) => ({ id: item[0], title: item[1], category: item[2], minutes: 6 + index % 4, summary: '用可复核的结构表达目的、方法、证据和限制。', sections: [['核心结构', '先说明目的，再描述输入、变换、输出和限制。'], ['准确表达', '使用明确的技术动词，区分观察事实与解释。']], code: "result = validate(transform(source))" }));
  const project: LearningProject = { schema: 'skyview-python-english-project', version: 3, id: 'python-english-card-parity', title: 'Python 技术英语进阶', catalogVersion: '2026.09-card-parity-v1', activeSetId: 'fundamentals', activeWordId: 'fundamentals-1', activeMode: 'learn', profile: { displayName: '当前学习者', dailyGoalXp: 80, leaderboardOptIn: false, sound: true, vibration: false }, xpEvents, progressByTerm, referenceReads: ['ref-explain-code', 'ref-read-traceback'], attempts: [], activeAttempt: null, customSets: [], customExamDrafts: [], activities: [{ id: 'activity-1', type: 'catalog', message: '卡片版完整课程基准已载入', createdAt: now }] };
  return { schema: 'skyview-python-english-results', version: 3, stage: 'load-sample', project, catalog: { version: project.catalogVersion, vocabularySets: sets, exams, references, source: { name: '2EZ-exam', repository: 'https://github.com/dvrone/2EZ-exam', commit: '333427c5080ddbebb8d70198df653173876fb0f9' } }, analysis: { metrics: { xp: xpEvents.reduce((sum, item) => sum + item.xp, 0), level: '新手', levelIndex: 1, nextLevelXp: 500, levelProgress: 31, streak: 1, mastered: 6, totalTerms: 64, examAverage: 0, completedExams: 0, referencesRead: 2 }, leaderboard: [], awards: [{ id: 'first-mastery', name: '术语启航', earned: true }, { id: 'six-mastered', name: '基础构筑者', earned: true }, { id: 'exam-pass', name: '考试通关', earned: false }, { id: 'reader', name: '指南研读者', earned: false }] }, runtime: { speechSynthesis: { status: 'browser-native' }, speechRecognition: { status: 'browser-optional' }, pronunciationScoring: { status: 'not-configured', mode: 'learner-self-assessment' } }, exports: { projectJson: JSON.stringify(project, null, 2), progressCsv: '', attemptsCsv: '', vocabularyJson: '', referencesMarkdown: '', packageBase64: '' }, examToken: '' };
}

const views = [
  ['dashboard', '学习总览', 'Overview', Gauge], ['vocabulary', '词汇训练', 'Vocabulary', Brain],
  ['exams', '考试中心', 'Exams', ListChecks], ['references', '参考指南', 'References', Library],
  ['leaderboard', '排行榜', 'Leaderboard', Trophy], ['manage', '课程管理', 'Manage', Settings2],
] as const;
const modes = [
  ['learn', '学习', BookOpen], ['cards', '卡片', Layers3], ['quiz', '测验', Target], ['speak', '朗读', Headphones], ['type', '拼写', Keyboard],
] as const;

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
  anchor.href = URL.createObjectURL(new Blob([content], { type })); anchor.download = name; anchor.click(); URL.revokeObjectURL(anchor.href);
}
function downloadBase64(content: string, name: string) {
  const bytes = Uint8Array.from(atob(content), (value) => value.charCodeAt(0));
  const anchor = document.createElement('a'); anchor.href = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' })); anchor.download = name; anchor.click(); URL.revokeObjectURL(anchor.href);
}

export function PythonEnglishWorkbench({ executionAllowed }: { executionAllowed: boolean }) {
  const { text, locale } = useLanguage();
  const [result, setResult] = useState<PythonEnglishResult>(() => sampleResult());
  const [view, setView] = useState<(typeof views)[number][0]>('dashboard');
  const [projects, setProjects] = useState<WorkbenchProject[]>([]);
  const [projectId, setProjectId] = useState('');
  const projectIdRef = useRef('');
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState('完整课程基准已载入，可直接训练、考试、阅读和导出。');
  const [error, setError] = useState('');
  const [wordIndex, setWordIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [quizChoice, setQuizChoice] = useState('');
  const [typing, setTyping] = useState('');
  const [examIndex, setExamIndex] = useState(0);
  const [examToken, setExamToken] = useState('');
  const [referenceId, setReferenceId] = useState('ref-explain-code');
  const [vocabularyImport, setVocabularyImport] = useState('{\n  "name": "项目词汇",\n  "words": [{"word": "pipeline", "translation": "流水线", "example": "The pipeline validates every record."}]\n}');
  const [examImport, setExamImport] = useState('# 自定义测验\n? Which word means 参数?\n- variable\n- #parameter\n- argument\n> A parameter appears in a function definition.');
  const [displayName, setDisplayName] = useState('当前学习者');
  const [clockNow, setClockNow] = useState(() => Date.now());

  const allSets = [...result.catalog.vocabularySets, ...result.project.customSets];
  const activeSet = allSets.find((item) => item.id === result.project.activeSetId) ?? allSets[0];
  const activeWord = activeSet?.words[wordIndex % Math.max(1, activeSet.words.length)] ?? activeSet?.words[0];
  const activeReference = result.catalog.references.find((item) => item.id === referenceId) ?? result.catalog.references[0];
  const activeAttempt = result.project.activeAttempt;
  const activeQuestion = activeAttempt?.questions[examIndex] ?? activeAttempt?.questions[0];
  const lastAttempt = result.project.attempts[0];
  const metrics = result.analysis.metrics;
  const quizOptions = activeWord && activeSet
    ? [activeWord, ...activeSet.words.filter((item) => item.id !== activeWord.id).slice(0, 3)].sort((a, b) => a.id.localeCompare(b.id))
    : [];

  useEffect(() => {
    let active = true;
    toolApi.listProjects('python-english').then(async (items) => {
      if (!active) return;
      setProjects(items);
      const first = items[0];
      const saved = first?.state.pythonEnglish as { result?: PythonEnglishResult; examToken?: string } | undefined;
      if (first && saved?.result?.schema === 'skyview-python-english-results') {
        projectIdRef.current = first.id; setProjectId(first.id); setResult(saved.result); setExamToken(saved.examToken ?? ''); setDisplayName(saved.result.project.profile.displayName);
      } else if (!first && executionAllowed) {
        try {
          const baseline = sampleResult();
          const createdProject = await toolApi.createProject('python-english', baseline.project.title, { pythonEnglish: { result: baseline, examToken: '' } });
          const key = crypto.randomUUID();
          const createdJob = await toolApi.createJob(createdProject.id, 'python-english', 'load-sample', {}, key);
          const job = await waitForJob(createdJob.job.id);
          if (!active || !job || job.status !== 'succeeded') return;
          const output = job.result as PythonEnglishResult;
          if (output.schema !== 'skyview-python-english-results') return;
          const stored = await toolApi.updateProject(createdProject.id, output.project.title, { pythonEnglish: { result: output, examToken: '' } });
          if (!active) return;
          projectIdRef.current = stored.id; setProjectId(stored.id); setProjects([stored]); setResult(output); setDisplayName(output.project.profile.displayName);
          setMessage(locale === 'zh' ? '完整课程已自动载入，可直接开始训练。' : 'The complete course is ready.');
        } catch { /* 未登录时保留完整只读基准；登录后会自动持久化。 */ }
      }
    }).catch(() => undefined);
    return () => { active = false; };
  }, [executionAllowed, locale]);

  useEffect(() => {
    if (!activeAttempt) return undefined;
    const timer = window.setInterval(() => setClockNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [activeAttempt]);

  const projectState = (next = result, token = examToken) => ({ pythonEnglish: { result: next, examToken: token } });
  const ensureProject = async () => {
    const existing = projects.find((item) => item.id === (projectIdRef.current || projectId));
    if (existing) return existing;
    const created = await toolApi.createProject('python-english', result.project.title, projectState());
    projectIdRef.current = created.id; setProjectId(created.id); setProjects((items) => [created, ...items]); return created;
  };
  const execute = async (action: string, extra: Record<string, unknown> = {}) => {
    if (!executionAllowed) { setError(text('Python 英语学习服务当前不可用。', 'The learning service is unavailable.')); return null; }
    setRunning(true); setError(''); setMessage(text('Go 已登记作业，Python 正在更新课程记录…', 'Updating the learning record…'));
    try {
      const project = await ensureProject();
      const created = await toolApi.createJob(project.id, 'python-english', action, { state: result, actorRole: 'owner', examToken, ...extra }, crypto.randomUUID());
      const job = await waitForJob(created.job.id);
      if (!job || job.status !== 'succeeded') throw new Error(job?.error || text('课程作业未完成。', 'Learning job did not complete.'));
      const output = job.result as PythonEnglishResult;
      if (output.schema !== 'skyview-python-english-results') throw new Error(text('服务端结果不兼容。', 'Incompatible server result.'));
      const nextToken = output.examToken ?? examToken;
      setResult(output); setExamToken(nextToken); setDisplayName(output.project.profile.displayName);
      const saved = await toolApi.updateProject(project.id, output.project.title, projectState(output, nextToken));
      setProjects((items) => [saved, ...items.filter((item) => item.id !== saved.id)]);
      setMessage(text('学习证据、积分和项目状态已保存。', 'Progress, XP, and project state saved.'));
      return output;
    } catch (cause) { setError(cause instanceof Error ? cause.message : text('操作失败。', 'Operation failed.')); return null; }
    finally { setRunning(false); }
  };

  const selectSet = async (setId: string) => { setWordIndex(0); setFlipped(false); await execute('select-set', { setId }); };
  const selectMode = async (mode: string) => { setFlipped(false); setQuizChoice(''); setTyping(''); await execute('select-mode', { mode }); };
  const advanceWord = () => { setWordIndex((value) => (value + 1) % Math.max(1, activeSet.words.length)); setFlipped(false); setQuizChoice(''); setTyping(''); };
  const record = async (action: string, extra: Record<string, unknown> = {}) => { if (!activeWord) return; const output = await execute(action, { termId: activeWord.id, sessionKey: crypto.randomUUID(), ...extra }); if (output) advanceWord(); };
  const speak = () => {
    if (!activeWord || !('speechSynthesis' in window)) { setError(text('当前浏览器不支持语音合成。', 'Speech synthesis is unavailable.')); return; }
    window.speechSynthesis.cancel(); const utterance = new SpeechSynthesisUtterance(activeWord.word); utterance.lang = 'en-US'; utterance.rate = 0.82; window.speechSynthesis.speak(utterance);
  };
  const startExam = async (examId: string) => { const output = await execute('start-exam', { examId }); if (output) { setExamIndex(0); setView('exams'); } };
  const chooseExamAnswer = async (choiceId: string) => { if (!activeQuestion) return; await execute('save-exam-answer', { questionId: activeQuestion.id, choiceId, currentIndex: examIndex }); };
  const submitExam = async () => { const output = await execute('submit-exam', { answers: activeAttempt?.answers ?? {} }); if (output) setExamToken(''); };
  const updatePreferences = async (preferences: Record<string, unknown>) => execute('update-preferences', { preferences });
  const remainingSeconds = activeAttempt ? Math.max(0, Math.floor((new Date(activeAttempt.expiresAt).getTime() - clockNow) / 1_000)) : 0;
  const remainingLabel = `${String(Math.floor(remainingSeconds / 60)).padStart(2, '0')}:${String(remainingSeconds % 60).padStart(2, '0')}`;
  const setLabel = (item: WordSet) => locale === 'zh' ? setNamesZh[item.id] ?? item.name : item.name;
  const examLabel = (item: ExamMeta) => locale === 'zh' ? examNamesZh[item.id] ?? item.title : item.title;
  const referenceLabel = (item: ReferenceGuide) => locale === 'zh' ? referenceNamesZh[item.id] ?? item.title : item.title;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select')) return;
      if (view === 'exams' && activeQuestion) {
        const choiceIndex = Number(event.key) - 1;
        if (choiceIndex >= 0 && choiceIndex < activeQuestion.choices.length) { event.preventDefault(); void chooseExamAnswer(activeQuestion.choices[choiceIndex].id); }
        if (event.key === 'ArrowLeft' && examIndex > 0) setExamIndex((value) => value - 1);
        if (event.key === 'ArrowRight' && activeAttempt && examIndex < activeAttempt.questions.length - 1) setExamIndex((value) => value + 1);
      }
      if (view === 'vocabulary' && event.code === 'Space' && result.project.activeMode === 'cards') { event.preventDefault(); setFlipped((value) => !value); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  return (
    <section className="pyeng-shell" aria-label={text('Python 英语学习工作台', 'Python English learning workbench')}>
      <header className="pyeng-commandbar">
        <div className="pyeng-brandmark"><span>Py</span><div><strong>{text('Python 技术英语', 'Python Technical English')}</strong><small>{text('64 个术语 · 32 道考题 · 8 篇指南', '64 terms · 32 questions · 8 guides')}</small></div></div>
        <div className="pyeng-command-actions">
          <select aria-label={text('学习项目', 'Learning project')} value={projectId} onChange={(event) => {
            const item = projects.find((project) => project.id === event.target.value); const saved = item?.state.pythonEnglish as { result?: PythonEnglishResult; examToken?: string } | undefined;
            if (item && saved?.result?.schema === 'skyview-python-english-results') { projectIdRef.current = item.id; setProjectId(item.id); setResult(saved.result); setExamToken(saved.examToken ?? ''); }
          }}><option value="">{result.project.title}</option>{projects.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select>
          <span className="pyeng-daily"><Target size={15} />{text('今日目标', 'Daily goal')} {Math.min(metrics.xp, result.project.profile.dailyGoalXp)}/{result.project.profile.dailyGoalXp} XP</span>
          <Button size="sm" onClick={() => setView('vocabulary')}><Play size={15} />{text('继续训练', 'Continue')}</Button>
        </div>
      </header>

      <div className="pyeng-metricbar">
        {[
          [Sparkles, `${metrics.xp}`, 'XP'], [Award, metrics.level, `${text('等级', 'Level')} ${metrics.levelIndex}`], [Clock3, `${metrics.streak} ${text('天', 'days')}`, text('连续学习', 'Streak')],
          [Brain, `${metrics.mastered}/${metrics.totalTerms}`, text('已掌握', 'Mastered')], [ListChecks, `${metrics.examAverage}%`, `${metrics.completedExams} ${text('次考试', 'exams')}`], [BookOpen, `${metrics.referencesRead}/8`, text('指南研读', 'Guides')],
        ].map(([Icon, value, label], index) => <div className="pyeng-metric" key={index}><Icon size={16} /><strong>{value as string}</strong><span>{label as string}</span></div>)}
      </div>

      <nav className="pyeng-tabs" aria-label={text('课程功能', 'Course views')}>
        {views.map(([id, zh, en, Icon]) => <button type="button" key={id} className={view === id ? 'active' : ''} onClick={() => setView(id)}><Icon size={15} /><span>{text(zh, en)}</span></button>)}
      </nav>
      <main className={`pyeng-stage ${error ? 'has-alert' : ''}`}>
        {error && <div className="pyeng-alert" role="alert">{error}</div>}
        {view === 'dashboard' && <div className="pyeng-dashboard">
          <article className="pyeng-level-card">
            <div className="pyeng-level-orbit"><span>{metrics.levelIndex}</span></div>
            <div><small>{text('当前等级', 'Current level')}</small><h2>{metrics.level}</h2><p>{metrics.xp} / {metrics.nextLevelXp} XP</p><div className="pyeng-progress"><i style={{ width: `${metrics.levelProgress}%` }} /></div></div>
          </article>
          <article className="pyeng-panel pyeng-continue"><div className="pyeng-panel-title"><div><small>{text('下一步', 'Next')}</small><h3>{text('继续技术词汇训练', 'Continue technical vocabulary')}</h3></div><Button size="sm" onClick={() => setView('vocabulary')}><Play size={14} />{text('开始', 'Start')}</Button></div><p>{setLabel(activeSet)} · {activeSet.words.length} {text('个术语', 'terms')}</p><div className="pyeng-path">{modes.map(([id, zh, Icon], index) => <div key={id} className={index < 3 ? 'done' : ''}><Icon size={14} /><span>{text(zh, id)}</span></div>)}</div></article>
          <article className="pyeng-panel"><div className="pyeng-panel-title"><div><small>{text('掌握证据', 'Mastery evidence')}</small><h3>{text('需要继续练习', 'Needs practice')}</h3></div><span>{metrics.totalTerms - metrics.mastered}</span></div><div className="pyeng-word-chips">{result.catalog.vocabularySets.slice(1, 4).flatMap((item) => item.words.slice(0, 2)).map((word) => <button key={word.id} onClick={() => { setView('vocabulary'); void selectSet(word.id.split('-').slice(0, -1).join('-')); }}>{word.word}</button>)}</div></article>
          <article className="pyeng-panel pyeng-activity"><div className="pyeng-panel-title"><div><small>{text('不可变事件', 'Immutable events')}</small><h3>{text('最近学习记录', 'Recent activity')}</h3></div><ShieldCheck size={18} /></div>{result.project.activities.slice(0, 4).map((item) => <div key={item.id}><span>{item.message}</span><time>{new Date(item.createdAt).toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en-US')}</time></div>)}</article>
          <article className="pyeng-panel pyeng-awards"><div className="pyeng-panel-title"><div><small>{text('里程碑', 'Milestones')}</small><h3>{text('学习徽章', 'Awards')}</h3></div><Medal size={18} /></div><div>{result.analysis.awards.map((award) => <span className={award.earned ? 'earned' : ''} key={award.id}><Award size={17} />{award.name}</span>)}</div></article>
        </div>}

        {view === 'vocabulary' && <div className="pyeng-training-layout">
          <aside className="pyeng-setrail"><h3>{text('词汇主题', 'Vocabulary sets')}</h3><p>{allSets.length} {text('套课程', 'sets')} · {metrics.totalTerms} {text('个术语', 'terms')}</p>{allSets.map((item) => { const mastered = item.words.filter((word) => result.project.progressByTerm[word.id]?.masteredAt).length; return <button type="button" key={item.id} className={activeSet.id === item.id ? 'active' : ''} onClick={() => void selectSet(item.id)}><span>{setLabel(item)}</span><small>{mastered}/{item.words.length}</small><i><b style={{ width: `${mastered / Math.max(1, item.words.length) * 100}%` }} /></i></button>; })}</aside>
          <section className="pyeng-trainer">
            <div className="pyeng-modebar">{modes.map(([id, zh, Icon]) => <button key={id} className={result.project.activeMode === id ? 'active' : ''} onClick={() => void selectMode(id)}><Icon size={15} />{text(zh, id)}</button>)}</div>
            <div className="pyeng-trainer-head"><span>{setLabel(activeSet)}</span><strong>{wordIndex + 1} / {activeSet.words.length}</strong></div>
            {activeWord && <div className={`pyeng-wordstage mode-${result.project.activeMode}`}>
              {result.project.activeMode === 'cards' ? <button className={`pyeng-flashcard ${flipped ? 'flipped' : ''}`} onClick={() => setFlipped((value) => !value)}><small>{flipped ? text('释义', 'Meaning') : text('术语', 'Term')}</small><strong>{flipped ? activeWord.translation : activeWord.word}</strong><span>{flipped ? activeWord.example : activeWord.ipa || text('点击翻面', 'Tap to flip')}</span></button> : <>
                <div className="pyeng-wordhero"><button title={text('播放发音', 'Play pronunciation')} onClick={speak}><Volume2 size={20} /></button><small>{setLabel(activeSet)}</small><h2>{activeWord.word}</h2><p>{activeWord.ipa}</p></div>
                {result.project.activeMode === 'learn' && <div className="pyeng-meaning"><strong>{activeWord.translation}</strong><p>{activeWord.example}</p></div>}
                {result.project.activeMode === 'quiz' && <div className="pyeng-choices">{quizOptions.map((word) => <button key={word.id} className={quizChoice === word.id ? 'selected' : ''} onClick={() => setQuizChoice(word.id)}>{word.translation}</button>)}</div>}
                {result.project.activeMode === 'speak' && <div className="pyeng-speaking"><Speaker size={24} /><strong>{text('听示范后朗读，再由你自己确认', 'Listen, speak, then self-assess')}</strong><p>{text('当前未配置自动发音评分，不会把浏览器转写冒充 AI 评分。', 'Automatic pronunciation scoring is not configured.')}</p></div>}
                {result.project.activeMode === 'type' && <div className="pyeng-typing"><label>{text('根据中文输入英文术语', 'Type the English term')}<Input value={typing} onChange={(event) => setTyping(event.target.value)} placeholder={activeWord.translation} onKeyDown={(event) => { if (event.key === 'Enter') void record('record-typing', { correct: typing.trim().toLowerCase() === activeWord.word.toLowerCase() }); }} /></label></div>}
              </>}
            </div>}
            <div className="pyeng-trainer-actions"><Button variant="outline" size="sm" onClick={() => { setWordIndex((value) => (value - 1 + activeSet.words.length) % activeSet.words.length); setFlipped(false); }}><ChevronLeft size={14} />{text('上一个', 'Previous')}</Button>
              {result.project.activeMode === 'learn' && <Button size="sm" onClick={() => void record('record-learn')}>{text('学会了', 'Learned')}<ChevronRight size={14} /></Button>}
              {result.project.activeMode === 'cards' && <Button size="sm" onClick={() => void record('record-card')}>{text('记住了', 'Remembered')}<ChevronRight size={14} /></Button>}
              {result.project.activeMode === 'quiz' && <Button size="sm" disabled={!quizChoice} onClick={() => void record('record-quiz', { correct: quizChoice === activeWord.id })}>{text('提交答案', 'Submit')}</Button>}
              {result.project.activeMode === 'speak' && <><Button variant="outline" size="sm" onClick={speak}><Volume2 size={14} />{text('播放示范', 'Play')}</Button><Button variant="outline" size="sm" onClick={() => void record('record-pronunciation', { selfAssessment: 'retry' })}>{text('需要再练', 'Retry')}</Button><Button size="sm" onClick={() => void record('record-pronunciation', { selfAssessment: 'accurate' })}>{text('我读准了', 'Accurate')}</Button></>}
              {result.project.activeMode === 'type' && <Button size="sm" disabled={!typing.trim()} onClick={() => void record('record-typing', { correct: typing.trim().toLowerCase() === activeWord.word.toLowerCase() })}>{text('核对拼写', 'Check')}</Button>}
            </div>
          </section>
          <aside className="pyeng-evidence"><h3>{text('掌握证据', 'Mastery evidence')}</h3>{activeSet.words.map((word, index) => { const progress = result.project.progressByTerm[word.id]; return <button key={word.id} className={index === wordIndex ? 'active' : ''} onClick={() => setWordIndex(index)}><span>{word.word}</span><small>{progress?.evidence?.length ?? 0}/3</small>{progress?.masteredAt && <CheckCircle2 size={14} />}</button>; })}<div className="pyeng-evidence-note"><LockKeyhole size={15} /><span>{text('至少三类独立练习证据后才标记掌握。', 'Mastery requires three distinct evidence types.')}</span></div></aside>
        </div>}

        {view === 'exams' && <div className="pyeng-exam-layout">
          <aside className="pyeng-exam-list"><h3>{text('认证考试', 'Exams')}</h3>{result.catalog.exams.map((exam) => <button key={exam.id} className={activeAttempt?.examId === exam.id ? 'active' : ''} onClick={() => !activeAttempt && void startExam(exam.id)}><span><strong>{examLabel(exam)}</strong><small>{locale === 'zh' ? ({ Foundation: '基础', Intermediate: '进阶', Advanced: '高级' }[exam.level] ?? exam.level) : exam.level} · {exam.questionCount} {text('题', 'questions')} · {exam.durationMinutes} min</small></span><Play size={15} /></button>)}</aside>
          <section className="pyeng-exam-canvas">
            {!activeAttempt ? <div className="pyeng-exam-empty"><ListChecks size={34} /><h2>{lastAttempt ? `${text('最近成绩', 'Latest score')} ${lastAttempt.percent}%` : text('选择一场考试开始', 'Choose an exam')}</h2><p>{text('题目和选项每次重新排序；达到 70% 通过。正确答案仅在提交后由 Python 服务返回。', 'Questions and choices are shuffled. Answers are revealed only after server grading.')}</p>{lastAttempt && <div className="pyeng-review-list">{lastAttempt.review.slice(0, 4).map((item, index) => <div className={item.correct ? 'correct' : 'wrong'} key={item.questionId}><span>{index + 1}</span><p><strong>{item.prompt}</strong><small>{item.explanation}</small></p></div>)}</div>}</div> : activeQuestion && <>
              <div className="pyeng-exam-head"><div><small>{activeAttempt.title}</small><strong>{text('第', 'Question')} {examIndex + 1} / {activeAttempt.questions.length} {locale === 'zh' ? '题' : ''}</strong></div><span><Clock3 size={15} />{remainingLabel} {text('剩余', 'remaining')}</span></div>
              <div className="pyeng-question"><h2>{activeQuestion.prompt}</h2>{activeQuestion.code && <pre>{activeQuestion.code}</pre>}<div>{activeQuestion.choices.map((choice, index) => <button key={choice.id} className={activeAttempt.answers[activeQuestion.id] === choice.id ? 'selected' : ''} onClick={() => void chooseExamAnswer(choice.id)}><span>{String.fromCharCode(65 + index)}</span>{choice.label}</button>)}</div></div>
              <div className="pyeng-question-nav"><Button variant="outline" size="sm" disabled={examIndex === 0} onClick={() => setExamIndex((value) => value - 1)}><ChevronLeft size={14} />{text('上一题', 'Previous')}</Button><div>{activeAttempt.questions.map((question, index) => <button key={question.id} className={`${index === examIndex ? 'active' : ''} ${activeAttempt.answers[question.id] ? 'answered' : ''}`} onClick={() => setExamIndex(index)}>{index + 1}</button>)}</div>{examIndex < activeAttempt.questions.length - 1 ? <Button size="sm" onClick={() => setExamIndex((value) => value + 1)}>{text('下一题', 'Next')}<ChevronRight size={14} /></Button> : <Button size="sm" onClick={() => void submitExam()}>{text('提交评分', 'Submit')}</Button>}</div>
            </>}
          </section>
          <aside className="pyeng-exam-status"><h3>{text('考试状态', 'Exam status')}</h3><div><span>{text('已作答', 'Answered')}</span><strong>{activeAttempt ? Object.keys(activeAttempt.answers).length : 0}/{activeAttempt?.questions.length ?? 8}</strong></div><div><span>{text('通过线', 'Pass mark')}</span><strong>70%</strong></div><div><span>{text('成绩记录', 'Attempts')}</span><strong>{metrics.completedExams}</strong></div><p><ShieldCheck size={15} />{text('试卷会话由服务端签名；浏览器中不保存正确答案。', 'The exam session is signed; answers are not stored in the browser.')}</p></aside>
        </div>}

        {view === 'references' && <div className="pyeng-reference-layout"><aside className="pyeng-reference-list"><h3>{text('8 篇技术指南', '8 technical guides')}</h3>{result.catalog.references.map((item) => <button className={item.id === activeReference.id ? 'active' : ''} key={item.id} onClick={() => setReferenceId(item.id)}><span>{referenceLabel(item)}</span><small>{locale === 'zh' ? categoryNamesZh[item.category] ?? item.category : item.category} · {item.minutes} min</small>{result.project.referenceReads.includes(item.id) && <CheckCircle2 size={14} />}</button>)}</aside><article className="pyeng-reader"><header><div><small>{locale === 'zh' ? categoryNamesZh[activeReference.category] ?? activeReference.category : activeReference.category}</small><h2>{referenceLabel(activeReference)}</h2><p>{activeReference.summary}</p></div><Button size="sm" variant={result.project.referenceReads.includes(activeReference.id) ? 'outline' : 'default'} onClick={() => void execute('mark-reference-read', { referenceId: activeReference.id })}>{result.project.referenceReads.includes(activeReference.id) ? text('已完成', 'Completed') : text('标记完成', 'Mark complete')}</Button></header><div className="pyeng-reader-sections">{activeReference.sections.map((section) => <section key={section[0]}><h3>{section[0]}</h3><p>{section[1]}</p></section>)}</div><pre>{activeReference.code}</pre></article></div>}

        {view === 'leaderboard' && <div className="pyeng-privacy-layout"><article className="pyeng-panel pyeng-privacy"><ShieldCheck size={30} /><div><small>{text('显式加入', 'Explicit opt-in')}</small><h2>{text('隐私优先排行榜', 'Privacy-first leaderboard')}</h2><p>{text('排行榜默认关闭，只展示明确同意加入的真实学习者；当前未配置组织成员目录，也不会生成虚构账号。', 'The leaderboard is off by default and never invents users.')}</p></div><Button onClick={() => void updatePreferences({ leaderboardOptIn: !result.project.profile.leaderboardOptIn })}>{result.project.profile.leaderboardOptIn ? text('退出排行榜', 'Opt out') : text('同意加入', 'Opt in')}</Button></article><article className="pyeng-leaderboard">{result.analysis.leaderboard.length ? result.analysis.leaderboard.map((item) => <div key={item.rank}><span>{item.rank}</span><div><strong>{item.displayName}</strong><small>{item.level}</small></div><b>{item.xp} XP</b></div>) : <div className="pyeng-empty-state"><Users size={30} /><h3>{text('暂无已明确加入的成员', 'No opted-in members')}</h3><p>{text('连接组织身份目录后，可在最小披露原则下展示真实成员。', 'Connect an organization directory to show real members with minimal disclosure.')}</p></div>}</article></div>}

        {view === 'manage' && <div className="pyeng-manage-grid">
          <article className="pyeng-panel"><div className="pyeng-panel-title"><div><small>{text('账户与隐私', 'Profile & privacy')}</small><h3>{text('学习偏好', 'Preferences')}</h3></div><Settings2 size={18} /></div><label>{text('显示名称', 'Display name')}<Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label><div className="pyeng-toggle-row"><button className={result.project.profile.sound ? 'active' : ''} onClick={() => void updatePreferences({ sound: !result.project.profile.sound })}>{text('朗读声音', 'Audio')}</button><button className={result.project.profile.vibration ? 'active' : ''} onClick={() => void updatePreferences({ vibration: !result.project.profile.vibration })}>{text('触觉反馈', 'Haptics')}</button></div><Button size="sm" onClick={() => void updatePreferences({ displayName })}>{text('保存偏好', 'Save')}</Button></article>
          <article className="pyeng-panel"><div className="pyeng-panel-title"><div><small>JSON</small><h3>{text('导入词汇集', 'Import vocabulary')}</h3></div><Upload size={18} /></div><textarea value={vocabularyImport} onChange={(event) => setVocabularyImport(event.target.value)} /><Button size="sm" onClick={() => void execute('import-vocabulary', { content: vocabularyImport })}>{text('校验并导入', 'Validate & import')}</Button></article>
          <article className="pyeng-panel"><div className="pyeng-panel-title"><div><small>TXT</small><h3>{text('导入考试草稿', 'Import exam draft')}</h3></div><Upload size={18} /></div><textarea value={examImport} onChange={(event) => setExamImport(event.target.value)} /><p>{text('正确答案保留为教师草稿，未接入私有题库前不可发布给学生。', 'Answers remain in a teacher draft until a private item bank is connected.')}</p><Button size="sm" onClick={() => void execute('import-exam', { content: examImport })}>{text('校验草稿', 'Validate draft')}</Button></article>
          <article className="pyeng-panel pyeng-delivery"><div className="pyeng-panel-title"><div><small>{text('可追溯交付', 'Traceable delivery')}</small><h3>{text('导出完整学习记录', 'Export learning record')}</h3></div><FileArchive size={18} /></div><div><button onClick={() => downloadText(result.exports.projectJson, 'python-english-project.json', 'application/json')}><Download size={16} />{text('项目 JSON', 'Project JSON')}</button><button onClick={() => downloadText(result.exports.progressCsv, 'term-progress.csv', 'text/csv')}><Download size={16} />{text('术语进度 CSV', 'Term progress CSV')}</button><button onClick={() => downloadText(result.exports.attemptsCsv, 'exam-attempts.csv', 'text/csv')}><Download size={16} />{text('考试记录 CSV', 'Exam attempts CSV')}</button><button onClick={() => downloadText(result.exports.referencesMarkdown, 'python-guides.md', 'text/markdown')}><Download size={16} />{text('指南 Markdown', 'Guides Markdown')}</button><button disabled={!result.exports.packageBase64} onClick={() => downloadBase64(result.exports.packageBase64, 'python-english-package.zip')}><FileArchive size={16} />{text('完整交付包', 'Complete package')}</button></div><Button variant="outline" size="sm" onClick={() => void execute('reset-progress')}><RotateCcw size={14} />{text('清空学习进度', 'Reset progress')}</Button></article>
        </div>}
      </main>

      <footer className="pyeng-status" aria-live="polite"><span className={error ? 'error' : ''}>{running ? <LoaderCircle className="spin" size={15} /> : error ? '!' : '✓'} {error || message}</span><span>{executionAllowed ? text('Go 项目边界 · Python 学习引擎', 'Go projects · Python learning engine') : text('计算服务未连接', 'Service disconnected')}</span></footer>
    </section>
  );
}
