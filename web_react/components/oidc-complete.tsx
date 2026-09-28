'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { authApi } from '@/services/api/auth';

type CompletionState = 'checking' | 'failed';

export function OIDCComplete() {
  const router = useRouter();
  const [state, setState] = useState<CompletionState>('checking');
  const [message, setMessage] = useState('正在确认组织身份…');

  useEffect(() => {
    let active = true;

    authApi.currentUser()
      .then((user) => {
        if (!active) return;
        setMessage(`身份已确认，欢迎回来，${user.displayName}。`);
        router.replace('/profile');
        router.refresh();
      })
      .catch((error: unknown) => {
        if (!active) return;
        setState('failed');
        setMessage(error instanceof Error ? error.message : '无法确认登录会话，请重新登录。');
      });

    return () => {
      active = false;
    };
  }, [router]);

  return (
    <div className="login-form" aria-live="polite">
      <p className="form-message">{message}</p>
      {state === 'failed' && (
        <Link className="login-submit oidc-login" href="/login">
          返回登录
          <span aria-hidden="true">→</span>
        </Link>
      )}
    </div>
  );
}
