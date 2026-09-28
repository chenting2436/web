import type { Metadata } from 'next';
import { SectionOverview } from '@/components/section-overview';

export const metadata: Metadata = { title: '工程与产业化' };

export default function EngineeringPage() {
  return <SectionOverview sectionKey="engineering" />;
}
