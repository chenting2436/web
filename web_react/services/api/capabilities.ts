import { apiRequest } from '@/services/api/client';
import type { DeliveryStatus } from '@/lib/platform-data';

export type ToolCapabilityDto = {
  slug: string;
  engine?: string;
  status: DeliveryStatus;
  executionAllowed: boolean;
  productionReady: boolean;
  codeExecutionAvailable?: boolean | null;
  extendedActions?: string[];
};

export const capabilityApi = {
  list() {
    return apiRequest<ToolCapabilityDto[]>('/tools/catalog');
  },
};
