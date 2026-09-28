'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState, type SyntheticEvent } from 'react';
import { CheckCircle2, MessageSquare, Plus, Search, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { authApi } from '@/services/api/auth';
import { collaborationApi, type Discussion, type SharedRecord } from '@/services/api/collaboration';
import type { User } from '@/types/api';

function readableTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function formText(form: FormData, key: string) {
  const value = form.get(key);
  return typeof value === 'string' ? value : '';
}

export function DiscussionWorkbench() {
  const [user, setUser] = useState<User | null>(null);
  const [records, setRecords] = useState<Array<SharedRecord<Discussion>>>([]);
  const [selectedId, setSelectedId] = useState('');
  const [query, setQuery] = useState('');
  const [channel, setChannel] = useState('all');
  const [composing, setComposing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([authApi.currentUser(), collaborationApi.list<Discussion>('discussions')])
      .then(([currentUser, items]) => {
        setUser(currentUser);
        setRecords(items);
        setSelectedId(items[0]?.id ?? '');
      })
      .catch((caught) => setError(caught instanceof Error ? caught.message : '无法读取讨论。'))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => records.filter((record) => {
    const text = `${record.data.title} ${record.data.body} ${record.data.context} ${record.data.tags.join(' ')}`.toLowerCase();
    return (!query || text.includes(query.toLowerCase())) && (channel === 'all' || record.data.channel === channel);
  }), [channel, query, records]);
  const selected = records.find((record) => record.id === selectedId) ?? filtered[0];

  const createDiscussion = async (event: SyntheticEvent<HTMLFormElement, SubmitEvent>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError('');
    try {
      const data: Discussion = {
        title: formText(form, 'title').trim(),
        body: formText(form, 'body').trim(),
        channel: form.get('channel') === 'research' ? 'research' : 'course',
        context: formText(form, 'context').trim() || '一般讨论',
        priority: form.get('priority') === 'high' ? 'high' : form.get('priority') === 'medium' ? 'medium' : 'normal',
        status: 'open',
        tags: formText(form, 'tags').split(/[,，]/).map((tag) => tag.trim()).filter(Boolean).slice(0, 6),
        replies: [],
      };
      const created = await collaborationApi.create<Discussion>('discussions', data);
      setRecords((items) => [created, ...items]);
      setSelectedId(created.id);
      setComposing(false);
      event.currentTarget.reset();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '无法创建讨论。');
    }
  };

  const reply = async (event: SyntheticEvent<HTMLFormElement, SubmitEvent>) => {
    event.preventDefault();
    if (!selected) return;
    const form = new FormData(event.currentTarget);
    const body = formText(form, 'reply').trim();
    if (!body) return;
    setError('');
    try {
      const updated = await collaborationApi.reply(selected.id, body);
      setRecords((items) => items.map((item) => item.id === updated.id ? updated : item));
      event.currentTarget.reset();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '无法发送回复。');
    }
  };

  const resolve = async () => {
    if (!selected) return;
    try {
      const updated = await collaborationApi.update<Discussion>('discussions', selected, { ...selected.data, status: 'resolved' });
      setRecords((items) => items.map((item) => item.id === updated.id ? updated : item));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '无法更新讨论。');
    }
  };

  if (!loading && !user) {
    return <section className="auth-required"><MessageSquare /><h2>登录后使用讨论区</h2><Link href="/login">前往登录</Link></section>;
  }

  return (
    <section className="collaboration-workbench">
      <header className="collab-toolbar">
        <div className="collab-search"><Search /><Input aria-label="搜索讨论" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、正文或标签" /></div>
        <NativeSelect value={channel} onChange={(event) => setChannel(event.target.value)}>
          <NativeSelectOption value="all">全部频道</NativeSelectOption>
          <NativeSelectOption value="course">课程讨论</NativeSelectOption>
          <NativeSelectOption value="research">科研笔记</NativeSelectOption>
        </NativeSelect>
        <Button onClick={() => setComposing((value) => !value)}><Plus />新建讨论</Button>
      </header>

      {composing && (
        <form className="collab-composer" onSubmit={createDiscussion}>
          <Input name="title" placeholder="讨论标题" minLength={4} maxLength={160} required />
          <div className="composer-row">
            <Input name="context" placeholder="课程或研究场景" />
            <Input name="tags" placeholder="标签，用逗号分隔" />
            <NativeSelect name="channel" defaultValue="course"><NativeSelectOption value="course">课程讨论</NativeSelectOption><NativeSelectOption value="research">科研笔记</NativeSelectOption></NativeSelect>
            <NativeSelect name="priority" defaultValue="normal"><NativeSelectOption value="normal">普通</NativeSelectOption><NativeSelectOption value="medium">重要</NativeSelectOption><NativeSelectOption value="high">紧急</NativeSelectOption></NativeSelect>
          </div>
          <Textarea name="body" placeholder="说明问题、已尝试的方法和需要讨论的内容" minLength={10} maxLength={8000} required />
          <div className="composer-actions"><Button type="button" variant="ghost" onClick={() => setComposing(false)}>取消</Button><Button type="submit">发布</Button></div>
        </form>
      )}

      {error && <p className="tool-error" role="alert">{error}</p>}
      <div className="collab-grid">
        <div className="discussion-list">
          {filtered.map((record) => (
            <button key={record.id} className={record.id === selected?.id ? 'is-active' : undefined} type="button" onClick={() => setSelectedId(record.id)}>
              <span className={`priority-mark ${record.data.priority}`} />
              <span><strong>{record.data.title}</strong><small>{record.data.context} · {record.data.replies.length} 条回复</small></span>
              <em>{record.data.status === 'resolved' ? '已解决' : record.data.status === 'answered' ? '已回复' : '待回复'}</em>
            </button>
          ))}
          {!filtered.length && <p className="empty-list">没有符合条件的讨论。</p>}
        </div>

        <article className="discussion-detail">
          {selected ? (
            <>
              <header><div><span>{selected.data.channel === 'research' ? '科研笔记' : '课程讨论'} · {selected.data.context}</span><h2>{selected.data.title}</h2><small>{selected.data.authorName ?? '用户'} · {readableTime(selected.createdAt)}</small></div>{selected.data.status !== 'resolved' && <Button variant="outline" onClick={resolve}><CheckCircle2 />标记解决</Button>}</header>
              <p className="discussion-body">{selected.data.body}</p>
              <div className="tag-row">{selected.data.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
              <section className="reply-list">
                {selected.data.replies.map((item) => <article key={item.id}><header><strong>{item.authorName}</strong><small>{readableTime(item.createdAt)}</small></header><p>{item.body}</p></article>)}
              </section>
              <form className="reply-form" onSubmit={reply}><Textarea name="reply" placeholder="写回复" required /><Button type="submit"><Send />发送</Button></form>
            </>
          ) : <p className="empty-list">选择一条讨论。</p>}
        </article>
      </div>
    </section>
  );
}
