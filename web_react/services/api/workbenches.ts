import { apiRequest } from '@/services/api/client';
import type { Paginated } from '@/types/api';

export type WorkbenchSummaryDto = {
  id: string;
  slug: string;
  title: string;
  updatedAt: string;
};

export type WorkbenchDetailDto = WorkbenchSummaryDto & {
  description: string;
  state: Record<string, unknown>;
};

export const workbenchApi = {
  list(page = 1) {
    return apiRequest<Paginated<WorkbenchSummaryDto>>(
      `/workbenches?page=${page}`,
    );
  },
  get(slug: string) {
    return apiRequest<WorkbenchDetailDto>(`/workbenches/${slug}`);
  },
};
