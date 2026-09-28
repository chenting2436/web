import type { Metadata } from 'next';
import { SectionOverview } from '@/components/section-overview';

export const metadata: Metadata = { title: '科研成果' };

export default function ResearchPage() {
  return <SectionOverview sectionKey="research" />;
}
