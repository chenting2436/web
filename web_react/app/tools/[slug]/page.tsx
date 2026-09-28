import { notFound } from 'next/navigation';
import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';
import { WorkbenchAvailability } from '@/components/workbench-availability';
import { getWorkbench, workbenches } from '@/lib/platform-data';

export function generateStaticParams() {
  return workbenches.map(({ slug }) => ({ slug }));
}

export default async function WorkbenchPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const workbench = getWorkbench(slug);
  if (!workbench) notFound();

  return (
    <div className="site-shell subpage-shell">
      <SiteHeader />
      <main className="page-width workspace-main workbench-page-main">
        <WorkbenchAvailability workbench={workbench} />
      </main>
      <SiteFooter />
    </div>
  );
}
