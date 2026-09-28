'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArchiveRestore,
  ChevronLeft,
  Download,
  Eye,
  FileText,
  FileUp,
  History,
  Images,
  LoaderCircle,
  Pencil,
  Plus,
  Save,
  Settings,
  Sparkles,
  Trash2,
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

type ChapterVersion = {
  id: string;
  number: number;
  content: string;
  status: string;
  createdAt: string;
};

type PatentChapter = {
  id: string;
  order: number;
  name: string;
  key: string;
  mandatory: boolean;
  description: string;
  content: string;
  status: string;
  generationMode: string;
  versions: ChapterVersion[];
  updatedAt: string;
};

type PatentFigure = {
  id: string;
  number: number;
  positionLabel: string;
  description: string;
  chapter: string;
  contentType: string;
};

type ConceptAnalysis = {
  coreInventiveConcept: string;
  technicalProblem: string;
  keyComponents: string[];
  connectionTypes: string[];
  novelFeatures: string[];
  priorArtGaps: string[];
  technicalEffects: string[];
  suggestedTerminology: Record<string, string>;
  mode: string;
};

type QualityReport = {
  completed: number;
  score: number;
  issues: Array<{ level: 'error' | 'warn'; text: string }>;
};

type PatentProject = {
  schema: 'skyview-patent-assistant';
  version: number;
  upstream: { repository: string; commit: string; license: string };
  id: string;
  patentType: string;
  title: string;
  technicalConcept: string;
  status: string;
  conceptAnalysis: ConceptAnalysis | null;
  chapters: PatentChapter[];
  figures: PatentFigure[];
  createdAt: string;
  updatedAt: string;
};

type ExportBundle = {
  markdown: string;
  docxBase64: string;
  projectJson: string;
  files: { markdown: string; docx: string; project: string };
};

const chapterDefinitions = [
  ['title', '发明名称', true, '准确反映技术主题，一般不超过25个字'],
  ['technical_field', '技术领域', true, '明确所属或直接应用的具体技术领域'],
  ['background_art', '背景技术', true, '说明现有方案及其直接相关不足'],
  ['purpose', '发明目的', true, '明确需要解决的技术问题'],
  ['technical_solution', '技术方案', true, '描述要素、关系、机制、步骤与参数'],
  ['beneficial_effects', '有益效果', true, '建立技术特征与效果的因果关系'],
  ['drawing_description', '附图说明', true, '列出图号、图名和建议位置'],
  ['detailed_embodiments', '具体实施方式', true, '提供完整、可复现的实施例'],
  ['alternative_embodiments', '替代方案', false, '描述关键特征的变体或替代实现'],
  ['key_points', '关键点与保护点', true, '区分必要特征、可选特征和子方案'],
] as const;

const sampleConcept = '现有露天矿边坡监测依赖人工分别判断位移和微震数据，存在时间基准不一致、证据难以追溯的问题。本方案设置位移传感器、微震采集单元、时间同步模块和风险分析模块，先统一时间轴，再融合特征并输出分级预警，同时保存输入、参数和结果。与传统方案相比，其创新点是面向证据链的多源同步与分级研判。预期缩短人工研判时间，但具体指标仍需现场试验验证。';
const terminalStatuses = new Set(['succeeded', 'failed', 'canceled']);

function createLocalProject(patentType: string, concept: string, title: string): PatentProject {
  const now = new Date().toISOString();
  const projectTitle = title.trim() || '未命名专利草稿';
  return {
    schema: 'skyview-patent-assistant',
    version: 1,
    upstream: { repository: 'Dyp130/Patent-assistant', commit: '7123187a1e071b402c4e87ff6d2ce8d1aff825e4', license: 'MIT' },
    id: `patent-${crypto.randomUUID()}`,
    patentType,
    title: projectTitle,
    technicalConcept: concept.trim(),
    status: 'drafting',
    conceptAnalysis: null,
    chapters: chapterDefinitions.map(([key, name, mandatory, description], index) => ({
      id: `chapter-${crypto.randomUUID()}`,
      order: index + 1,
      key,
      name,
      mandatory,
      description,
      content: key === 'title' && title.trim() ? title.trim() : '',
      status: key === 'title' && title.trim() ? 'user_edited' : 'pending',
      generationMode: '',
      versions: [],
      updatedAt: now,
    })),
    figures: [],
    createdAt: now,
    updatedAt: now,
  };
}

function qualityFromProject(project: PatentProject): QualityReport {
  const completed = project.chapters.filter((chapter) => chapter.content.trim().length >= (chapter.key === 'title' ? 4 : 80)).length;
  const issues = project.chapters
    .filter((chapter) => chapter.mandatory && chapter.content.trim().length < (chapter.key === 'title' ? 4 : 80))
    .map((chapter) => ({ level: 'error' as const, text: `${chapter.name}尚未形成有效内容。` }));
  if (!project.conceptAnalysis) issues.push({ level: 'error', text: '尚未完成技术特征分析。' });
  return { completed, score: Math.min(100, Math.round(completed / 10 * 80 + (project.conceptAnalysis ? 15 : 0) + (project.figures.length ? 5 : 0))), issues };
}

function wait(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function waitForJob(id: string): Promise<WorkbenchJob | null> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const job = await toolApi.getJob(id);
    if (terminalStatuses.has(job.status)) return job;
    await wait(750);
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
  const bytes = Uint8Array.from(atob(content), (character) => character.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function chapterStatus(status: string) {
  return status === 'local_generated' ? '结构稿' : status === 'user_edited' ? '已编辑' : status === 'finalized' ? '已定稿' : '待撰写';
}

export function PatentDisclosureWorkbench({ executionAllowed = true }: { executionAllowed?: boolean }) {
  const [projects, setProjects] = useState<WorkbenchProject[]>([]);
  const [projectId, setProjectId] = useState('');
  const [project, setProject] = useState<PatentProject | null>(null);
  const [selectedChapter, setSelectedChapter] = useState('');
  const [chapterDraft, setChapterDraft] = useState('');
  const [conceptDraft, setConceptDraft] = useState('');
  const [titleDraft, setTitleDraft] = useState('');
  const [preview, setPreview] = useState(false);
  const [quality, setQuality] = useState<QualityReport | null>(null);
  const [dialog, setDialog] = useState<'new' | 'settings' | 'versions' | null>(null);
  const [newPatentType, setNewPatentType] = useState('发明专利');
  const [newTitle, setNewTitle] = useState('');
  const [newConcept, setNewConcept] = useState(sampleConcept);
  const [running, setRunning] = useState(false);
  const [runningLabel, setRunningLabel] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const importInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    toolApi.listProjects('patent-disclosure').then((items) => {
      if (active) setProjects(items);
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  const activeChapter = useMemo(
    () => project?.chapters.find((chapter) => chapter.key === selectedChapter),
    [project, selectedChapter],
  );
  const report = quality ?? (project ? qualityFromProject(project) : null);

  const openProject = (record: WorkbenchProject) => {
    const saved = record.state.patent as { project?: PatentProject } | undefined;
    if (!saved?.project?.chapters) {
      setError('项目数据不完整，无法打开。');
      return;
    }
    setProjectId(record.id);
    setProject(saved.project);
    setConceptDraft(saved.project.technicalConcept);
    setTitleDraft(saved.project.title === '未命名专利草稿' ? '' : saved.project.title);
    setSelectedChapter('');
    setQuality(null);
    setMessage('');
    setError('');
  };

  const ensureProject = async (current: PatentProject) => {
    const existing = projects.find((item) => item.id === projectId);
    if (existing) return existing;
    const created = await toolApi.createProject('patent-disclosure', current.title, { patent: { project: current } });
    setProjects((items) => [created, ...items]);
    setProjectId(created.id);
    return created;
  };

  const persistProject = async (nextProject: PatentProject, record?: WorkbenchProject) => {
    const target = record ?? await ensureProject(nextProject);
    const saved = await toolApi.updateProject(target.id, nextProject.title, { patent: { project: nextProject } });
    await toolApi.createVersion(
      saved.id,
      `专利交底书快照 ${new Date().toLocaleString('zh-CN')}`,
      saved.state,
    );
    setProjects((items) => [saved, ...items.filter((item) => item.id !== saved.id)]);
    setProjectId(saved.id);
    return saved;
  };

  const run = async (action: string, input: Record<string, unknown>, label: string) => {
    if (!executionAllowed) throw new Error('服务暂未连接，请稍后重试。');
    if (!project) throw new Error('请先创建或打开项目。');
    setRunning(true);
    setRunningLabel(label);
    setError('');
    setMessage('');
    try {
      const record = await ensureProject(project);
      const created = await toolApi.createJob(record.id, 'patent-disclosure', action, input, crypto.randomUUID());
      const job = await waitForJob(created.job.id);
      if (!job) throw new Error('任务仍在后台处理，请稍后重新打开项目。');
      if (job.status !== 'succeeded') throw new Error(job.error || '任务执行失败。');
      return { output: job.result, record };
    } finally {
      setRunning(false);
      setRunningLabel('');
    }
  };

  const saveConcept = async () => {
    if (!project) return;
    const next = { ...project, title: titleDraft.trim() || '未命名专利草稿', technicalConcept: conceptDraft.trim(), updatedAt: new Date().toISOString() };
    if (next.technicalConcept.length < 20) {
      setError('核心技术构思至少需要20个字符。');
      return;
    }
    setProject(next);
    try {
      await persistProject(next);
      setMessage('核心构思已保存。');
      setError('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '保存失败。');
    }
  };

  const analyze = async () => {
    if (!project) return;
    const next = { ...project, title: titleDraft.trim() || project.title, technicalConcept: conceptDraft.trim() };
    try {
      const { output, record } = await run('analyze', { project: next, concept: next.technicalConcept }, '正在分析技术特征');
      const updated = { ...next, conceptAnalysis: output.analysis as ConceptAnalysis, updatedAt: new Date().toISOString() };
      setProject(updated);
      setQuality(null);
      await persistProject(updated, record);
      setMessage('技术特征分析完成。');
    } catch (caught) {
      setError(caught instanceof ApiError || caught instanceof Error ? caught.message : '分析失败。');
    }
  };

  const generateAll = async () => {
    if (!project) return;
    const next = { ...project, title: titleDraft.trim() || project.title, technicalConcept: conceptDraft.trim() };
    try {
      const { output, record } = await run('generate-all', { project: next }, '正在生成十章节交底书');
      const generated = output.project as PatentProject;
      setProject(generated);
      setTitleDraft(generated.title);
      setConceptDraft(generated.technicalConcept);
      setQuality(output.quality as QualityReport);
      setSelectedChapter('technical_field');
      setChapterDraft(generated.chapters.find((chapter) => chapter.key === 'technical_field')?.content ?? '');
      await persistProject(generated, record);
      setMessage('十章节结构稿已生成，请逐章核验和编辑。');
    } catch (caught) {
      setError(caught instanceof ApiError || caught instanceof Error ? caught.message : '生成失败。');
    }
  };

  const generateSelectedChapter = async () => {
    if (!project || !activeChapter) return;
    try {
      const { output, record } = await run('generate-chapter', { project, chapterKey: activeChapter.key }, `正在生成“${activeChapter.name}”`);
      const now = new Date().toISOString();
      const versions = activeChapter.content.trim() && activeChapter.versions[0]?.content !== activeChapter.content
        ? [{ id: `version-${crypto.randomUUID()}`, number: (activeChapter.versions[0]?.number ?? 0) + 1, content: activeChapter.content, status: activeChapter.status, createdAt: now }, ...activeChapter.versions].slice(0, 20)
        : activeChapter.versions;
      const chapters = project.chapters.map((chapter) => chapter.key === activeChapter.key ? { ...chapter, content: String(output.content), status: 'local_generated', generationMode: 'local-structured', versions, updatedAt: now } : chapter);
      const updated = { ...project, chapters, figures: [...project.figures.filter((figure) => figure.chapter !== activeChapter.name), ...((output.figures as PatentFigure[]) ?? [])].sort((left, right) => left.number - right.number), updatedAt: now };
      setProject(updated);
      setChapterDraft(String(output.content));
      setQuality(null);
      await persistProject(updated, record);
      setMessage(`${activeChapter.name}已生成。`);
    } catch (caught) {
      setError(caught instanceof ApiError || caught instanceof Error ? caught.message : '章节生成失败。');
    }
  };

  const saveChapter = async () => {
    if (!project || !activeChapter) return;
    const now = new Date().toISOString();
    const versions = activeChapter.content.trim() && activeChapter.content !== chapterDraft && activeChapter.versions[0]?.content !== activeChapter.content
      ? [{ id: `version-${crypto.randomUUID()}`, number: (activeChapter.versions[0]?.number ?? 0) + 1, content: activeChapter.content, status: activeChapter.status, createdAt: now }, ...activeChapter.versions].slice(0, 20)
      : activeChapter.versions;
    const updated = { ...project, chapters: project.chapters.map((chapter) => chapter.key === activeChapter.key ? { ...chapter, content: chapterDraft, status: 'user_edited', versions, updatedAt: now } : chapter), updatedAt: now };
    setProject(updated);
    setQuality(null);
    try {
      await persistProject(updated);
      setMessage(`${activeChapter.name}已保存。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '章节保存失败。');
    }
  };

  const audit = async () => {
    if (!project) return;
    try {
      const { output, record } = await run('audit', { project }, '正在检查交底完整度');
      const next = output.project ? output.project as PatentProject : project;
      setProject(next);
      setQuality(output.quality as QualityReport);
      await persistProject(next, record);
      setMessage('质量检查已更新。');
    } catch (caught) {
      setError(caught instanceof ApiError || caught instanceof Error ? caught.message : '检查失败。');
    }
  };

  const exportFile = async (kind: keyof ExportBundle['files']) => {
    if (!project) return;
    try {
      const { output } = await run('export', { project }, '正在生成交付文件');
      const bundle = output as ExportBundle;
      if (kind === 'docx') downloadBase64(bundle.docxBase64, bundle.files.docx, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      if (kind === 'markdown') downloadText(`\ufeff${bundle.markdown}`, bundle.files.markdown, 'text/markdown;charset=utf-8');
      if (kind === 'project') downloadText(bundle.projectJson, bundle.files.project, 'application/json;charset=utf-8');
      setMessage(`${bundle.files[kind]} 已导出。`);
    } catch (caught) {
      setError(caught instanceof ApiError || caught instanceof Error ? caught.message : '导出失败。');
    }
  };

  const restoreVersion = async (version: ChapterVersion) => {
    if (!project || !activeChapter) return;
    const now = new Date().toISOString();
    const currentSnapshot = activeChapter.content.trim() ? [{ id: `version-${crypto.randomUUID()}`, number: (activeChapter.versions[0]?.number ?? 0) + 1, content: activeChapter.content, status: activeChapter.status, createdAt: now }] : [];
    const updated = { ...project, chapters: project.chapters.map((chapter) => chapter.key === activeChapter.key ? { ...chapter, content: version.content, status: version.status || 'user_edited', versions: [...currentSnapshot, ...chapter.versions].slice(0, 20), updatedAt: now } : chapter), updatedAt: now };
    setProject(updated);
    setChapterDraft(version.content);
    setDialog(null);
    try {
      await persistProject(updated);
      setMessage(`已恢复版本 ${version.number}。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '版本恢复失败。');
    }
  };

  const deleteProject = async (record: WorkbenchProject) => {
    if (!window.confirm(`确定删除“${record.title}”及其章节和历史版本吗？`)) return;
    try {
      await toolApi.deleteProject(record.id);
      setProjects((items) => items.filter((item) => item.id !== record.id));
      setMessage('项目已删除。');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '删除失败。');
    }
  };

  const importProject = (file: File) => {
    file.text().then((text) => {
      const parsed = JSON.parse(text) as { project?: unknown };
      const imported = (parsed.project ?? parsed) as PatentProject;
      if (!imported?.chapters || imported.chapters.length !== 10) throw new Error('项目文件必须包含十个章节。');
      setProject({ ...imported, id: `patent-${crypto.randomUUID()}`, updatedAt: new Date().toISOString() });
      setProjectId('');
      setTitleDraft(imported.title);
      setConceptDraft(imported.technicalConcept);
      setSelectedChapter('');
      setQuality(null);
      setMessage('项目文件已导入，保存后写入当前工作区。');
      setError('');
    }).catch((caught) => setError(caught instanceof Error ? caught.message : '无法导入项目文件。'));
  };

  if (!project) {
    return (
      <section className="patent-assistant">
        <header className="patent-topbar">
          <div><span className="patent-mark" /> <strong>专利撰写助手</strong><small>十章节技术交底书</small></div>
          <div>
            <input ref={importInput} type="file" accept=".json,application/json" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) importProject(file); event.target.value = ''; }} />
            <Button variant="outline" onClick={() => importInput.current?.click()}><FileUp />导入项目</Button>
            <Button variant="outline" onClick={() => setDialog('settings')}><Settings />生成设置</Button>
            <Button onClick={() => setDialog('new')}><Plus />新建项目</Button>
          </div>
        </header>
        <div className="patent-list-heading"><div><h2>我的专利项目</h2><p>按项目管理核心构思、十章节、附图、质量记录和历史版本。</p></div></div>
        <div className="patent-project-grid">
          {projects.length ? projects.map((record) => {
            const saved = (record.state.patent as { project?: PatentProject } | undefined)?.project;
            const completed = saved?.chapters.filter((chapter) => chapter.content.trim()).length ?? 0;
            return <article key={record.id} className="patent-project-card"><div><FileText /><span>{saved?.patentType ?? '专利项目'}</span><button type="button" aria-label={`删除${record.title}`} onClick={() => void deleteProject(record)}><Trash2 /></button></div><button type="button" className="patent-project-open" onClick={() => openProject(record)}><h3>{record.title}</h3><p>{saved?.technicalConcept ?? '打开查看项目内容'}</p><div className="patent-card-progress"><i style={{ width: `${completed * 10}%` }} /></div><footer><span>{completed}/10 章节</span><time>{new Date(record.updatedAt).toLocaleDateString('zh-CN')}</time></footer></button></article>;
          }) : <div className="patent-empty"><FileText /><h2>新建第一份专利交底书</h2><p>从核心技术构思开始，建立十章节、附图与版本记录。</p><Button onClick={() => setDialog('new')}><Plus />新建项目</Button></div>}
        </div>
        <SourceCredit />
        <ProjectDialogs dialog={dialog} setDialog={setDialog} patentType={newPatentType} setPatentType={setNewPatentType} title={newTitle} setTitle={setNewTitle} concept={newConcept} setConcept={setNewConcept} onCreate={() => {
          if (newConcept.trim().length < 20) { setError('核心技术构思至少需要20个字符。'); return; }
          const created = createLocalProject(newPatentType, newConcept, newTitle);
          setProject(created); setProjectId(''); setTitleDraft(newTitle); setConceptDraft(newConcept); setDialog(null); setError('');
        }} />
        {error && <div className="patent-toast error">{error}</div>}
      </section>
    );
  }

  return (
    <section className="patent-assistant workspace-mode">
      <header className="patent-topbar">
        <div><span className="patent-mark" /> <strong>专利撰写助手</strong><small>{project.title}</small></div>
        <div><span className="patent-service">Python 结构化生成</span><Button variant="ghost" onClick={() => { setProject(null); setProjectId(''); setSelectedChapter(''); }}><ChevronLeft />项目列表</Button><Button variant="outline" onClick={() => setDialog('settings')}><Settings />生成设置</Button><Button onClick={() => setDialog('new')}><Plus />新建项目</Button></div>
      </header>
      <div className="patent-workspace">
        <aside className="patent-chapters">
          <header><h3>章节列表</h3><Button size="sm" onClick={() => void generateAll()} disabled={running}><Sparkles />全部生成</Button></header>
          <nav aria-label="交底书章节">
            {project.chapters.map((chapter) => <button key={chapter.key} type="button" className={selectedChapter === chapter.key ? 'active' : ''} onClick={() => { setSelectedChapter(chapter.key); setChapterDraft(chapter.content); setPreview(false); }}><b>{String(chapter.order).padStart(2, '0')}</b><span><strong>{chapter.name}</strong><small>{chapter.description}</small></span><i className={chapter.content.trim() ? 'done' : ''} /></button>)}
          </nav>
          <div className="patent-progress"><div><span>总体进度</span><strong>{report?.completed ?? 0}/10</strong></div><div><i style={{ width: `${(report?.completed ?? 0) * 10}%` }} /></div></div>
          <footer><Button variant="outline" onClick={() => void exportFile('docx')} disabled={running}><Download />导出 DOCX</Button><Button variant="outline" onClick={() => void exportFile('markdown')} disabled={running}><Download />导出 Markdown</Button><Button variant="outline" onClick={() => void exportFile('project')} disabled={running}><Download />导出项目备份</Button></footer>
        </aside>
        <main className="patent-editor">
          {!selectedChapter ? <div className="patent-concept"><header><h2>关键核心技术构思</h2><p>十章节内容均以这里保存的事实为基础。</p></header><div><label htmlFor="patent-concept-title"><span>发明名称</span><Input id="patent-concept-title" value={titleDraft} onChange={(event) => setTitleDraft(event.target.value)} placeholder="例如：一种多源监测预警系统" /></label><label htmlFor="patent-concept-text"><span>核心技术构思</span><Textarea id="patent-concept-text" value={conceptDraft} onChange={(event) => setConceptDraft(event.target.value)} /></label><div className="patent-concept-actions"><Button onClick={() => void saveConcept()} disabled={running}><Save />保存构思</Button><Button variant="outline" onClick={() => void analyze()} disabled={running}><Sparkles />分析技术特征</Button></div>{project.conceptAnalysis && <AnalysisPanel analysis={project.conceptAnalysis} />}</div></div> : <div className="patent-chapter-editor"><header><h2>{activeChapter?.order}. {activeChapter?.name}</h2><span data-status={activeChapter?.status}>{chapterStatus(activeChapter?.status ?? '')}</span><Button variant="outline" size="sm" onClick={() => void generateSelectedChapter()} disabled={running}><Sparkles />生成章节</Button><Button variant="outline" size="sm" onClick={() => setPreview((value) => !value)}>{preview ? <Pencil /> : <Eye />}{preview ? '编辑' : '预览'}</Button><Button size="sm" onClick={() => void saveChapter()} disabled={running}><Save />保存</Button><Button variant="outline" size="sm" onClick={() => setDialog('versions')} disabled={!activeChapter?.versions.length}><History />历史版本</Button><Button variant="ghost" size="sm" onClick={() => setSelectedChapter('')}><ChevronLeft />返回构思</Button></header><div>{preview ? <div className="patent-preview"><pre>{chapterDraft || '【待撰写】'}</pre></div> : <Textarea className="patent-editor-textarea" value={chapterDraft} onChange={(event) => setChapterDraft(event.target.value)} placeholder="在此编辑章节内容，或使用生成章节。" />}</div></div>}
        </main>
        <aside className="patent-figures"><header><h3>附图清单</h3><span>{project.figures.length}</span></header><div>{project.figures.length ? project.figures.map((figure) => <article key={figure.id}><b>{figure.positionLabel}</b><p>{figure.description}</p><small>{figure.contentType} · {figure.chapter}</small></article>) : <div className="patent-no-figures"><Images /><p>章节中的附图标记将汇总在这里。</p></div>}</div><section><header><span>交底完整度</span><strong>{report?.score ?? 0}</strong></header><Button variant="outline" size="sm" onClick={() => void audit()} disabled={running}>重新检查</Button><div>{report?.issues.slice(0, 8).map((issue) => <p key={issue.text} data-level={issue.level}>{issue.text}</p>) ?? null}{report && !report.issues.length && <p>结构检查未发现缺项。</p>}</div></section></aside>
      </div>
      <SourceCredit />
      {(message || error) && <div className={`patent-toast ${error ? 'error' : ''}`}>{error || message}</div>}
      {running && <div className="patent-streaming"><div><header><h3>{runningLabel}</h3><LoaderCircle /></header><p>任务由 Go 控制面排队，并在 Python 服务中执行。</p></div></div>}
      <ProjectDialogs dialog={dialog} setDialog={setDialog} patentType={newPatentType} setPatentType={setNewPatentType} title={newTitle} setTitle={setNewTitle} concept={newConcept} setConcept={setNewConcept} activeChapter={activeChapter} onRestore={(version) => void restoreVersion(version)} onCreate={() => {
        if (newConcept.trim().length < 20) { setError('核心技术构思至少需要20个字符。'); return; }
        const created = createLocalProject(newPatentType, newConcept, newTitle);
        setProject(created); setProjectId(''); setTitleDraft(newTitle); setConceptDraft(newConcept); setSelectedChapter(''); setQuality(null); setDialog(null); setError('');
      }} />
    </section>
  );
}

function AnalysisPanel({ analysis }: { analysis: ConceptAnalysis }) {
  const cells = [
    ['核心构思', analysis.coreInventiveConcept],
    ['技术问题', analysis.technicalProblem],
    ['关键组成', analysis.keyComponents.join('、')],
    ['连接与协同', analysis.connectionTypes.join('；') || '待进一步明确'],
    ['创新点候选', analysis.novelFeatures.join('；')],
    ['预期效果', analysis.technicalEffects.join('；')],
  ];
  return <section className="patent-analysis"><h3>技术特征分析</h3><div>{cells.map(([label, value]) => <article key={label}><strong>{label}</strong><p>{value}</p></article>)}</div></section>;
}

function SourceCredit() {
  return <footer className="patent-source">基于 <a href="https://github.com/Dyp130/Patent-assistant" target="_blank" rel="noreferrer">Dyp130/Patent-assistant</a>（MIT，固定提交 7123187）改编；保留十章节、附图、版本与导出流程。</footer>;
}

function ProjectDialogs({ dialog, setDialog, patentType, setPatentType, title, setTitle, concept, setConcept, onCreate, activeChapter, onRestore }: {
  dialog: 'new' | 'settings' | 'versions' | null;
  setDialog: (value: 'new' | 'settings' | 'versions' | null) => void;
  patentType: string;
  setPatentType: (value: string) => void;
  title: string;
  setTitle: (value: string) => void;
  concept: string;
  setConcept: (value: string) => void;
  onCreate: () => void;
  activeChapter?: PatentChapter;
  onRestore?: (version: ChapterVersion) => void;
}) {
  return <>
    <Dialog open={dialog === 'new'} onOpenChange={(open) => { if (!open) setDialog(null); }}><DialogContent className="patent-dialog"><DialogHeader><DialogTitle>新建专利草稿</DialogTitle><DialogDescription>录入专利类型、名称和核心技术构思。</DialogDescription></DialogHeader><label htmlFor="patent-new-type"><span>专利类型</span><NativeSelect id="patent-new-type" value={patentType} onChange={(event) => setPatentType(event.target.value)}><NativeSelectOption>发明专利</NativeSelectOption><NativeSelectOption>实用新型</NativeSelectOption><NativeSelectOption>外观设计</NativeSelectOption></NativeSelect></label><label htmlFor="patent-new-title"><span>发明名称</span><Input id="patent-new-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="可以稍后生成或修改" /></label><label htmlFor="patent-new-concept"><span>核心技术构思</span><Textarea id="patent-new-concept" value={concept} onChange={(event) => setConcept(event.target.value)} /></label><DialogFooter><Button variant="outline" onClick={() => setDialog(null)}>取消</Button><Button onClick={onCreate}>开始撰写</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={dialog === 'settings'} onOpenChange={(open) => { if (!open) setDialog(null); }}><DialogContent className="patent-dialog"><DialogHeader><DialogTitle>生成设置</DialogTitle><DialogDescription>模型凭据由服务端统一管理，不会进入浏览器或项目文件。</DialogDescription></DialogHeader><label htmlFor="patent-generation-mode"><span>当前生成方式</span><Input id="patent-generation-mode" value="Python 本地结构化生成" readOnly /></label><label htmlFor="patent-model-service"><span>组织模型服务</span><Input id="patent-model-service" value="尚未配置" readOnly /></label><p className="patent-settings-note">启用组织模型后，仍通过 Go 控制面提交任务，并记录模型、模板版本、输入来源和人工确认。浏览器不接收长期密钥。</p><DialogFooter><Button onClick={() => setDialog(null)}>完成</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={dialog === 'versions'} onOpenChange={(open) => { if (!open) setDialog(null); }}><DialogContent className="patent-dialog"><DialogHeader><DialogTitle>{activeChapter?.name} · 历史版本</DialogTitle><DialogDescription>每章保留最近20个版本，恢复前会保存当前正文。</DialogDescription></DialogHeader><div className="patent-version-list">{activeChapter?.versions.length ? activeChapter.versions.map((version) => <article key={version.id}><div><strong>版本 {version.number}</strong><small>{new Date(version.createdAt).toLocaleString('zh-CN')} · {version.content.length} 字符</small></div><Button variant="outline" size="sm" onClick={() => onRestore?.(version)}><ArchiveRestore />恢复</Button></article>) : <p>暂无历史版本。</p>}</div></DialogContent></Dialog>
  </>;
}
