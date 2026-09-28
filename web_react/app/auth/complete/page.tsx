import type { Metadata } from 'next';
import Link from 'next/link';
import { OIDCComplete } from '@/components/oidc-complete';

export const metadata: Metadata = { title: '确认组织身份' };

export default function AuthCompletePage() {
  return (
    <main className="login-page">
      <section className="login-context">
        <Link className="login-back" href="/">
          ← 返回首页
        </Link>
        <p className="workspace-label">SKYVIEWLAB · 组织访问</p>
        <h1>正在完成登录</h1>
        <p>身份验证由组织身份源完成，本站只确认已经建立的安全会话。</p>
      </section>

      <section className="login-panel" aria-labelledby="auth-complete-title">
        <div className="login-card">
          <p className="eyebrow">身份确认</p>
          <h2 id="auth-complete-title">组织账号登录</h2>
          <OIDCComplete />
        </div>
      </section>
    </main>
  );
}
