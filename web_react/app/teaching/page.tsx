import type { Metadata } from 'next';
import { SectionOverview } from '@/components/section-overview';

export const metadata: Metadata = { title: '教学' };

export default function TeachingPage() {
  return <SectionOverview sectionKey="teaching" />;
}
