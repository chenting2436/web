import { apiRequest, getApiEndpoint } from '@/services/api/client';
import type { AuthSession, LoginPayload, User } from '@/types/api';

export const authApi = {
  oidcStartUrl() {
    return getApiEndpoint('/auth/oidc/start');
  },
  login(payload: LoginPayload) {
    return apiRequest<AuthSession>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
  logout() {
    return apiRequest<void>('/auth/logout', { method: 'POST' });
  },
  currentUser() {
    return apiRequest<User>('/auth/me');
  },
};
