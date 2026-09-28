import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';
import { WorkbenchGrid } from '@/components/workbench-grid';
import {
  getSectionWorkbenches,
  sections,
  type SectionKey,
} from '@/lib/platform-data';

export function SectionOverview({ sectionKey }: { sectionKey: SectionKey }) {
  const section = sections[sectionKey];
  const items = getSectionWorkbenches(sectionKey);

  return (
    <div className="site-shell subpage-shell">
      <SiteHeader />
      <main className="page-width subpage-main workbench-index-main">
        <section className="tool-section workbench-index-section" aria-label={`${section.title}工作台`}>
          <WorkbenchGrid items={items} />
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
