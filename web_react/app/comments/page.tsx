import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { DiscussionWorkbench } from '@/components/discussion-workbench';
import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';

export const metadata: Metadata = { title: '课程与科研讨论' };

export default function CommentsPage() {
  return <div className="site-shell subpage-shell"><SiteHeader /><main className="page-width workspace-main"><nav className="breadcrumb"><Link href="/profile"><ArrowLeft size={15} />返回个人中心</Link></nav><section className="workspace-heading"><h1>课程与科研讨论</h1></section><DiscussionWorkbench /></main><SiteFooter /></div>;
}
