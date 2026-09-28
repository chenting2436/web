import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft, ShieldAlert } from 'lucide-react';
import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';

export const metadata: Metadata = { title: '作业管理' };

export default function HomeworkPage() {
  return (
    <div className="site-shell subpage-shell">
      <SiteHeader />
      <main className="page-width workspace-main">
        <nav className="breadcrumb"><Link href="/profile"><ArrowLeft size={15} />返回个人中心</Link></nav>
        <section className="workspace-heading"><h1>作业管理</h1></section>
        <aside className="delivery-notice" data-status="security-blocked">
          <ShieldAlert size={20} aria-hidden="true" />
          <div>
            <strong>安全整改中</strong>
            <p>附件、正式提交和成绩发布入口已冻结，避免文件进入 JSON/SQLite，或在成绩状态机与权限审计完成前形成正式记录。</p>
          </div>
        </aside>
        <section className="workbench-gate" aria-labelledby="homework-gate-title">
          <div><span>验收闸门</span><h2 id="homework-gate-title">对象存储与评分流程通过后开放</h2></div>
          <ul>
            <li>分片上传、MIME 探测、恶意文件扫描与版本留存</li>
            <li>课程/选课、截止时区、重交、匿名与双评状态机</li>
            <li>学生本人权限、教师范围、正式成绩发布与改分审计</li>
          </ul>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
