import { apiRequest } from '@/services/api/client';

export type ToolResult = Record<string, unknown>;

export type WorkbenchProject = {
  id: string;
  slug: string;
  title: string;
  state: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type ProjectVersion = {
  id: string;
  projectId: string;
  label: string;
  state: Record<string, unknown>;
  createdAt: string;
};

export type WorkbenchRun = {
  id: string;
  jobId?: string;
  projectId: string;
  slug: string;
  action: string;
  status: string;
  result: ToolResult;
  error?: string;
  durationMs: number;
  createdAt: string;
  updatedAt?: string;
};

export type WorkbenchJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

export type WorkbenchJob = {
  id: string;
  projectId: string;
  slug: string;
  action: string;
  status: WorkbenchJobStatus;
  result: ToolResult;
  error?: string;
  attempt: number;
  durationMs: number;
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  finishedAt?: string;
};

export type CreatedWorkbenchJob = {
  job: WorkbenchJob;
  run: WorkbenchRun;
};

export type WorkbenchStateRecord = {
  state: Record<string, unknown>;
  revision: number;
  updatedAt?: string;
};

export const toolApi = {
  createJob(projectId: string, slug: string, action: string, input: Record<string, unknown>, idempotencyKey: string) {
    return apiRequest<CreatedWorkbenchJob>(`/projects/${projectId}/jobs`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ slug, action, input, idempotencyKey }),
    });
  },

  getJob(id: string, signal?: AbortSignal) {
    return apiRequest<WorkbenchJob>(`/jobs/${id}`, { signal });
  },

  cancelJob(id: string) {
    return apiRequest<WorkbenchJob>(`/jobs/${id}/cancel`, { method: 'POST' });
  },

  getStateRecord(slug: string) {
    return apiRequest<WorkbenchStateRecord>(`/workbenches/${slug}/state`);
  },

  async getState(slug: string) {
    const record = await apiRequest<WorkbenchStateRecord>(`/workbenches/${slug}/state`);
    return record.state;
  },

  saveState(slug: string, state: Record<string, unknown>, revision: number) {
    return apiRequest<WorkbenchStateRecord>(`/workbenches/${slug}/state`, {
      method: 'PUT',
      body: JSON.stringify({ state, revision }),
    });
  },

  listProjects(slug: string) {
    return apiRequest<WorkbenchProject[]>(`/workbenches/${slug}/projects`);
  },

  createProject(slug: string, title: string, state: Record<string, unknown>) {
    return apiRequest<WorkbenchProject>(`/workbenches/${slug}/projects`, {
      method: 'POST', body: JSON.stringify({ title, state }),
    });
  },

  updateProject(id: string, title: string, state: Record<string, unknown>) {
    return apiRequest<WorkbenchProject>(`/projects/${id}`, {
      method: 'PUT', body: JSON.stringify({ title, state }),
    });
  },

  deleteProject(id: string) {
    return apiRequest<{ deleted: boolean }>(`/projects/${id}`, { method: 'DELETE' });
  },

  listVersions(id: string) {
    return apiRequest<ProjectVersion[]>(`/projects/${id}/versions`);
  },

  createVersion(id: string, label: string, state: Record<string, unknown>) {
    return apiRequest<ProjectVersion>(`/projects/${id}/versions`, {
      method: 'POST', body: JSON.stringify({ label, state }),
    });
  },

  listRuns(id: string) {
    return apiRequest<WorkbenchRun[]>(`/projects/${id}/runs`);
  },

};
