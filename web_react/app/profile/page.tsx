import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, BookMarked, FolderKanban, MessageSquare } from 'lucide-react';
import { ProfileIdentity } from '@/components/profile-identity';
import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';

export const metadata: Metadata = { title: '个人中心' };

const spaces = [
  { title: '研究项目', detail: '打开研究工作台和已保存项目', href: '/research', icon: FolderKanban },
  { title: '教学工具', detail: '进入课程实验与评测工具', href: '/teaching', icon: BookMarked },
  { title: '讨论区', detail: '课程答疑和科研讨论', href: '/comments', icon: MessageSquare },
  { title: '作业管理', detail: '发布、提交、批改和版本记录', href: '/homework', icon: BookMarked },
];

export default function ProfilePage() {
  return (
    <div className="site-shell subpage-shell">
      <SiteHeader />
      <main className="page-width subpage-main profile-main">
        <ProfileIdentity />

        <section className="profile-grid" aria-label="个人工作区入口">
          {spaces.map(({ title, detail, href, icon: Icon }) => (
            <Link className="profile-tile" href={href} key={title}>
              <span className="profile-tile-icon"><Icon size={21} /></span>
              <h2>{title}</h2>
              <p>{detail}</p>
              <span className="profile-tile-link">进入 <ArrowRight size={15} /></span>
            </Link>
          ))}
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
