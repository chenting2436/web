import type {
  DeliveryStatus,
  WorkbenchReadiness,
} from '@/lib/platform-data';
import type { ToolCapabilityDto } from '@/services/api/capabilities';

export type CapabilityLoadState = 'loading' | 'ready' | 'error';

const validStatuses = new Set<DeliveryStatus>([
  'prototype',
  'planned',
  'security-blocked',
]);

const statusCopy: Record<DeliveryStatus, Omit<WorkbenchReadiness, 'status' | 'executionAllowed'>> = {
  prototype: {
    label: '原型',
    summary: '当前仅用于流程和交互评审，结果不作为正式科研、法律、教学评分或安全决策依据。',
  },
  planned: {
    label: '规划中',
    summary: '该能力尚未通过建设和验收，当前不允许执行。',
  },
  'security-blocked': {
    label: '安全整改中',
    summary: '该能力被服务端安全门禁冻结，通过隔离、权限和审计验收后再开放。',
  },
};

export function resolveWorkbenchReadiness(
  local: WorkbenchReadiness,
  remote: ToolCapabilityDto | undefined,
  loadState: CapabilityLoadState,
): WorkbenchReadiness {
  if (loadState === 'loading') {
    return {
      ...local,
      label: '正在校验',
      summary: '正在向 Go 控制面校验能力状态，完成前不开放执行。',
      executionAllowed: false,
    };
  }

  if (loadState === 'error') {
    return {
      status: 'security-blocked',
      label: '控制面不可用',
      summary: '无法取得服务端能力和健康状态，已按安全默认值停止执行。',
      executionAllowed: false,
    };
  }

  if (!remote || !validStatuses.has(remote.status)) {
    return {
      status: 'security-blocked',
      label: '能力未发布',
      summary: 'Go 控制面没有发布该能力，当前不允许执行。',
      executionAllowed: false,
    };
  }

  // A remote response may further restrict a route, but it cannot reopen a
  // locally frozen high-risk route until that acceptance gate is removed too.
  if (!local.executionAllowed) return local;

  const status = remote.status;
  return {
    status,
    ...statusCopy[status],
    executionAllowed: status === 'prototype' && remote.executionAllowed === true,
  };
}
