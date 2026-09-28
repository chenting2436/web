import { apiRequest } from '@/services/api/client';

export type CollaborationKind = 'discussions' | 'assignments' | 'submissions';

export type SharedRecord<T extends Record<string, unknown> = Record<string, unknown>> = {
  id: string;
  kind: CollaborationKind;
  revision: number;
  data: T;
  createdAt: string;
  updatedAt: string;
};

export const collaborationApi = {
  list<T extends Record<string, unknown>>(kind: CollaborationKind) {
    return apiRequest<Array<SharedRecord<T>>>(`/collaboration/${kind}`);
  },
  create<T extends Record<string, unknown>>(kind: CollaborationKind, data: T) {
    return apiRequest<SharedRecord<T>>(`/collaboration/${kind}`, {
      method: 'POST', body: JSON.stringify({ data }),
    });
  },
  update<T extends Record<string, unknown>>(kind: CollaborationKind, record: SharedRecord<T>, data: T) {
    return apiRequest<SharedRecord<T>>(`/collaboration/${kind}/${record.id}`, {
      method: 'PUT', body: JSON.stringify({ revision: record.revision, data }),
    });
  },
  delete(kind: CollaborationKind, id: string) {
    return apiRequest<{ deleted: boolean }>(`/collaboration/${kind}/${id}`, { method: 'DELETE' });
  },
  reply(id: string, body: string) {
    return apiRequest<SharedRecord<Discussion>>(`/collaboration/discussions/${id}/replies`, {
      method: 'POST', body: JSON.stringify({ body }),
    });
  },
};

export type DiscussionReply = {
  id: string;
  authorId: string;
  authorName: string;
  authorRole: string;
  body: string;
  createdAt: string;
};

export type Discussion = Record<string, unknown> & {
  title: string;
  body: string;
  channel: 'course' | 'research';
  context: string;
  priority: 'normal' | 'medium' | 'high';
  status: 'open' | 'answered' | 'resolved';
  tags: string[];
  replies: DiscussionReply[];
  authorId?: string;
  authorName?: string;
};

export type Assignment = Record<string, unknown> & {
  course: string;
  title: string;
  description: string;
  dueAt: string;
  maxScore: number;
  status: 'draft' | 'published' | 'closed';
  allowLate: boolean;
  requirements: string[];
  rubric: Array<{ id: string; label: string; points: number }>;
};

export type Submission = Record<string, unknown> & {
  assignmentId: string;
  content: string;
  link: string;
  status: 'draft' | 'submitted' | 'revision' | 'graded';
  score?: number;
  feedback?: string;
  studentId?: string;
  studentName?: string;
};
