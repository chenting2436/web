'use client';

import { useLanguage } from '@/components/language-provider';

export function SiteFooter() {
  const { text } = useLanguage();
  return (
    <footer className="site-footer">
      <div className="page-width">
        <span>SkyViewLab</span>
        <span>{text('地球科学科研教学平台', 'Earth science research and teaching platform')}</span>
      </div>
    </footer>
  );
}
