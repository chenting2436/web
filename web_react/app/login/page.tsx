import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowLeft, UserRound } from 'lucide-react';
import { LoginForm } from '@/components/login-form';

export const metadata: Metadata = { title: '登录' };

export default function LoginPage() {
  return (
    <main className="login-page">
      <header className="login-topbar">
        <Link className="login-back" href="/">
          <ArrowLeft size={16} aria-hidden="true" /> 返回首页
        </Link>
        <Image
          className="login-logo"
          src="/assets/images/skyviewlab-logo.png"
          alt="SkyViewLab"
          width={328}
          height={80}
        />
      </header>
      <section className="login-panel" aria-labelledby="login-title">
        <div className="login-card">
          <span className="login-avatar"><UserRound size={24} /></span>
          <h1 id="login-title">登录</h1>
          <LoginForm />
        </div>
      </section>
    </main>
  );
}
