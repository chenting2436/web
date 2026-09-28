import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';
import { WorkbenchStyleGallery } from '@/components/workbench-style-gallery';

export const metadata = {
  title: '工作台风格方案',
  description: '面波背景噪声成像与数据网关的第二轮统一风格对比。',
};

export default function StyleLabPage() {
  return (
    <div className="site-shell style-lab-shell">
      <SiteHeader />
      <main className="page-width style-lab-main">
        <WorkbenchStyleGallery />
      </main>
      <SiteFooter />
    </div>
  );
}
