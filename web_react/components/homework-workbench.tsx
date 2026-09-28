'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState, type ChangeEvent, type SyntheticEvent } from 'react';
import { BookOpenCheck, Check, FileUp, Plus, Send, UserRoundCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { authApi } from '@/services/api/auth';
import {
  collaborationApi,
  type Assignment,
  type SharedRecord,
  type Submission,
} from '@/services/api/collaboration';
import type { User } from '@/types/api';

type AttachedFile = { name: string; size: number; type: string; data: string };

function dateText(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function formText(form: FormData, key: string) {
  const value = form.get(key);
  return typeof value === 'string' ? value : '';
}

async function readFiles(files: FileList | null) {
  const items = Array.from(files ?? []);
  if (items.length > 4) throw new Error('最多选择 4 个附件。');
  if (items.some((file) => file.size > 1024 * 1024) || items.reduce((sum, file) => sum + file.size, 0) > 2 * 1024 * 1024) throw new Error('单个附件不超过 1 MB，总计不超过 2 MB。');
  return Promise.all(items.map((file) => new Promise<AttachedFile>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, size: file.size, type: file.type || 'application/octet-stream', data: typeof reader.result === 'string' ? reader.result : '' });
    reader.onerror = () => reject(reader.error ?? new Error('附件读取失败。'));
    reader.readAsDataURL(file);
  })));
}

export function HomeworkWorkbench() {
  const [user, setUser] = useState<User | null>(null);
  const [assignments, setAssignments] = useState<Array<SharedRecord<Assignment>>>([]);
  const [submissions, setSubmissions] = useState<Array<SharedRecord<Submission>>>([]);
  const [selectedId, setSelectedId] = useState('');
  const [status, setStatus] = useState('all');
  const [composing, setComposing] = useState(false);
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      authApi.currentUser(),
      collaborationApi.list<Assignment>('assignments'),
      collaborationApi.list<Submission>('submissions'),
    ]).then(([currentUser, assignmentRows, submissionRows]) => {
      setUser(currentUser);
      setAssignments(assignmentRows);
      setSubmissions(submissionRows);
      setSelectedId(assignmentRows[0]?.id ?? '');
    }).catch((caught) => setError(caught instanceof Error ? caught.message : '无法读取作业。'))
      .finally(() => setLoading(false));
  }, []);

  const visibleAssignments = useMemo(() => assignments.filter((item) => {
    if (user?.role !== 'admin' && item.data.status === 'draft') return false;
    return status === 'all' || item.data.status === status;
  }), [assignments, status, user?.role]);
  const selected = assignments.find((item) => item.id === selectedId) ?? visibleAssignments[0];
  const selectedSubmissions = submissions.filter((item) => item.data.assignmentId === selected?.id);
  const ownSubmission = selectedSubmissions.find((item) => item.data.studentId === user?.id);

  const createAssignment = async (event: SyntheticEvent<HTMLFormElement, SubmitEvent>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const rubric = formText(form, 'rubric').split('\n').map((line, index) => {
      const [label, rawPoints] = line.split('|');
      return { id: `criterion-${index + 1}`, label: label?.trim() ?? '', points: Number(rawPoints) || 0 };
    }).filter((item) => item.label && item.points > 0);
    try {
      const created = await collaborationApi.create<Assignment>('assignments', {
        course: formText(form, 'course').trim(), title: formText(form, 'title').trim(),
        description: formText(form, 'description').trim(), dueAt: new Date(formText(form, 'dueAt')).toISOString(),
        maxScore: Number(formText(form, 'maxScore')) || 100, status: form.get('publish') ? 'published' : 'draft',
        allowLate: Boolean(form.get('allowLate')),
        requirements: formText(form, 'requirements').split('\n').map((item) => item.trim()).filter(Boolean), rubric,
      });
      setAssignments((items) => [created, ...items]);
      setSelectedId(created.id);
      setComposing(false);
      event.currentTarget.reset();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '无法创建作业。');
    }
  };

  const chooseFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    try {
      setFiles(await readFiles(event.target.files));
      setError('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '附件读取失败。');
    }
  };

  const submitWork = async (event: SyntheticEvent<HTMLFormElement, SubmitEvent>) => {
    event.preventDefault();
    if (!selected) return;
    const form = new FormData(event.currentTarget);
    const nextData: Submission = {
      assignmentId: selected.id,
      content: formText(form, 'content').trim(),
      link: formText(form, 'link').trim(),
      status: 'submitted', files,
      versions: [...((ownSubmission?.data.versions as unknown[]) ?? []), {
        version: ((ownSubmission?.data.versions as unknown[]) ?? []).length + 1,
        submittedAt: new Date().toISOString(), files: files.map(({ name, size }) => ({ name, size })),
      }],
    };
    try {
      const saved = ownSubmission
        ? await collaborationApi.update('submissions', ownSubmission, nextData)
        : await collaborationApi.create<Submission>('submissions', nextData);
      setSubmissions((items) => [saved, ...items.filter((item) => item.id !== saved.id)]);
      setFiles([]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '无法提交作业。');
    }
  };

  const grade = async (event: SyntheticEvent<HTMLFormElement, SubmitEvent>, submission: SharedRecord<Submission>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const saved = await collaborationApi.update('submissions', submission, {
        ...submission.data, status: 'graded', score: Number(formText(form, 'score')), feedback: formText(form, 'feedback').trim(),
      });
      setSubmissions((items) => items.map((item) => item.id === saved.id ? saved : item));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '无法发布成绩。');
    }
  };

  const changeAssignmentStatus = async (nextStatus: Assignment['status']) => {
    if (!selected) return;
    try {
      const saved = await collaborationApi.update('assignments', selected, { ...selected.data, status: nextStatus });
      setAssignments((items) => items.map((item) => item.id === saved.id ? saved : item));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '无法更新作业。');
    }
  };

  if (!loading && !user) return <section className="auth-required"><BookOpenCheck /><h2>登录后使用作业管理</h2><Link href="/login">前往登录</Link></section>;

  return (
    <section className="collaboration-workbench homework-workbench">
      <header className="collab-toolbar">
        <NativeSelect value={status} onChange={(event) => setStatus(event.target.value)}><NativeSelectOption value="all">全部状态</NativeSelectOption><NativeSelectOption value="draft">草稿</NativeSelectOption><NativeSelectOption value="published">进行中</NativeSelectOption><NativeSelectOption value="closed">已关闭</NativeSelectOption></NativeSelect>
        <span className="signed-user"><UserRoundCheck />{user?.displayName} · {user?.role === 'admin' ? '管理员' : '学生'}</span>
        {user?.role === 'admin' && <Button onClick={() => setComposing((value) => !value)}><Plus />新建作业</Button>}
      </header>

      {composing && (
        <form className="collab-composer assignment-composer" onSubmit={createAssignment}>
          <div className="composer-row"><Input name="course" placeholder="课程名称" required /><Input name="title" placeholder="作业标题" minLength={4} required /><Input type="datetime-local" name="dueAt" required /><Input type="number" name="maxScore" defaultValue="100" min="1" max="1000" required /></div>
          <Textarea name="description" placeholder="任务说明" required />
          <div className="composer-row"><Textarea name="requirements" placeholder="提交要求，每行一项" /><Textarea name="rubric" placeholder="评分量规，每行：指标 | 分值" defaultValue={'方法与参数 | 30\n证据完整性 | 40\n结果分析 | 30'} /></div>
          <label className="check-field"><input type="checkbox" name="allowLate" />允许逾期提交</label>
          <div className="composer-actions"><Button type="button" variant="ghost" onClick={() => setComposing(false)}>取消</Button><Button type="submit" name="publish" value="yes">发布作业</Button></div>
        </form>
      )}

      {error && <p className="tool-error" role="alert">{error}</p>}
      <div className="collab-grid">
        <div className="discussion-list assignment-list">
          {visibleAssignments.map((record) => (
            <button key={record.id} className={record.id === selected?.id ? 'is-active' : undefined} type="button" onClick={() => setSelectedId(record.id)}>
              <span><strong>{record.data.title}</strong><small>{record.data.course} · 截止 {dateText(record.data.dueAt)}</small></span>
              <em>{record.data.status === 'published' ? '进行中' : record.data.status === 'closed' ? '已关闭' : '草稿'}</em>
            </button>
          ))}
          {!visibleAssignments.length && <p className="empty-list">暂无作业。</p>}
        </div>

        <article className="discussion-detail assignment-detail">
          {selected ? <>
            <header><div><span>{selected.data.course}</span><h2>{selected.data.title}</h2><small>截止 {dateText(selected.data.dueAt)} · {selected.data.maxScore} 分</small></div>{user?.role === 'admin' && <Button variant="outline" onClick={() => void changeAssignmentStatus(selected.data.status === 'published' ? 'closed' : 'published')}>{selected.data.status === 'published' ? '关闭提交' : '发布作业'}</Button>}</header>
            <p className="discussion-body">{selected.data.description}</p>
            <section className="assignment-spec"><div><h3>提交要求</h3><ol>{selected.data.requirements.map((item) => <li key={item}>{item}</li>)}</ol></div><div><h3>评分量规</h3>{selected.data.rubric.map((item) => <p key={item.id}><span>{item.label}</span><strong>{item.points} 分</strong></p>)}</div></section>

            {user?.role === 'student' && selected.data.status === 'published' && (
              <form className="submission-form" onSubmit={submitWork}>
                <h3>{ownSubmission ? '更新提交' : '提交作业'}</h3>
                <Textarea name="content" defaultValue={ownSubmission?.data.content} placeholder="作业说明和方法摘要" required />
                <Input name="link" type="url" defaultValue={ownSubmission?.data.link} placeholder="项目或报告链接（可选）" />
                <label className="file-picker"><FileUp />选择附件<input type="file" multiple onChange={chooseFiles} /></label>
                <div className="file-list">{files.map((file) => <span key={file.name}>{file.name} · {Math.ceil(file.size / 1024)} KB</span>)}</div>
                <Button type="submit"><Send />正式提交</Button>
                {ownSubmission && <p className="submission-status"><Check />当前状态：{ownSubmission.data.status}{typeof ownSubmission.data.score === 'number' ? ` · ${ownSubmission.data.score}/${selected.data.maxScore}` : ''}{ownSubmission.data.feedback ? ` · ${ownSubmission.data.feedback}` : ''}</p>}
              </form>
            )}

            {user?.role === 'admin' && <section className="grading-section"><h3>学生提交</h3>{selectedSubmissions.map((submission) => <article key={submission.id}><header><strong>{submission.data.studentName ?? submission.data.studentId}</strong><span>{submission.data.status}</span></header><p>{submission.data.content}</p>{(submission.data.files as AttachedFile[] | undefined)?.map((file) => <a key={file.name} href={file.data} download={file.name}>{file.name}</a>)}<form onSubmit={(event) => grade(event, submission)}><Input type="number" name="score" min="0" max={selected.data.maxScore} defaultValue={submission.data.score} placeholder="分数" required /><Input name="feedback" defaultValue={submission.data.feedback} placeholder="教师反馈" required /><Button type="submit">发布成绩</Button></form></article>)}{!selectedSubmissions.length && <p className="empty-list">暂无学生提交。</p>}</section>}
          </> : <p className="empty-list">选择一项作业。</p>}
        </article>
      </div>
    </section>
  );
}
