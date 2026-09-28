import type { ApiEnvelope, ApiErrorEnvelope } from '@/types/api';

const configuredBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL?.trim();

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
    public readonly code?: string,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class ApiConfigurationError extends Error {
  constructor() {
    super('尚未配置后端地址，请设置 NEXT_PUBLIC_API_BASE_URL。');
    this.name = 'ApiConfigurationError';
  }
}

export function getApiEndpoint(path: string) {
  if (!configuredBaseUrl) throw new ApiConfigurationError();
  const base = configuredBaseUrl.replace(/\/$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${base}${normalizedPath}`;
}

export async function apiRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(getApiEndpoint(path), {
    ...init,
    credentials: 'include',
    headers,
  });

  const payload = (await response.json().catch(() => null)) as ApiEnvelope<T> | ApiErrorEnvelope | null;

  if (!response.ok) {
    const error = payload && 'error' in payload ? payload.error : undefined;
    const message = error?.message
      ?? (payload && 'message' in payload ? payload.message : undefined)
      ?? `请求失败（${response.status}）`;
    throw new ApiError(message, response.status, error?.details ?? payload, error?.code, payload?.requestId);
  }

  if (!payload || !('data' in payload)) {
    throw new ApiError(
      '后端返回了无法识别的数据格式。',
      response.status,
      payload,
      'INVALID_RESPONSE_ENVELOPE',
      payload && 'requestId' in payload ? payload.requestId : undefined,
    );
  }

  return payload.data;
}
