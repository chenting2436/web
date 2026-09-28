'use client';

import { type SyntheticEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { authApi } from '@/services/api/auth';

export function LoginForm() {
  const router = useRouter();
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const oidcEnabled = process.env.NEXT_PUBLIC_OIDC_ENABLED !== 'false';
  const devLoginEnabled = process.env.NEXT_PUBLIC_ENABLE_DEV_LOGIN === 'true';

  async function login(account: string, password: string) {
    setSubmitting(true);
    setMessage('');
    try {
      const session = await authApi.login({ account, password });
      setMessage(`欢迎回来，${session.user.displayName}。`);
      router.push('/profile');
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '登录失败，请稍后重试。');
    } finally {
      setSubmitting(false);
    }
  }

  function beginOIDCLogin() {
    setMessage('');
    try {
      window.location.assign(authApi.oidcStartUrl());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '无法连接组织身份源。');
    }
  }

  async function handleSubmit(
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const accountValue = form.get('account');
    const passwordValue = form.get('password');
    const account = typeof accountValue === 'string' ? accountValue.trim() : '';
    const password = typeof passwordValue === 'string' ? passwordValue : '';

    await login(account, password);
  }

  return (
    <div className="login-form">
      {oidcEnabled && (
        <Button
          className="login-submit oidc-login"
          type="button"
          onClick={beginOIDCLogin}
        >
          使用组织账号登录
          <span aria-hidden="true">→</span>
        </Button>
      )}

      {devLoginEnabled && (
        <>
          {oidcEnabled && <div className="login-separator"><span>本地开发</span></div>}
          <form className="dev-login-form" onSubmit={handleSubmit}>
            <label htmlFor="account">开发账号</label>
            <div className="field-with-icon">
              <span className="field-icon" aria-hidden="true">@</span>
              <Input
                id="account"
                name="account"
                type="text"
                autoComplete="username"
                placeholder="请输入管理员配置的账号"
                required
              />
            </div>

            <label htmlFor="password">开发密码</label>
            <div className="field-with-icon">
              <span className="field-icon" aria-hidden="true">••</span>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                placeholder="请输入密码"
                required
              />
            </div>

            <Button className="login-submit" type="submit" disabled={submitting}>
              {submitting ? '正在连接…' : '本地登录'}
              <span aria-hidden="true">→</span>
            </Button>
          </form>
        </>
      )}

      {message && <p className="form-message" aria-live="polite">{message}</p>}
    </div>
  );
}
