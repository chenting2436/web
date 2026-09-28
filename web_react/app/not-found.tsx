import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

export default function NotFound() {
  return (
    <main className="not-found-page">
      <span>404</span>
      <h1>没有找到这个页面</h1>
      <p>它可能尚未迁移，或者地址已经发生变化。</p>
      <Link className="action-link primary" href="/">
        <ArrowLeft size={17} /> 返回首页
      </Link>
    </main>
  );
}
