'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { Languages, LogOut } from 'lucide-react';
import { useLanguage } from '@/components/language-provider';
import { navItems } from '@/lib/navigation';
import { getWorkbench } from '@/lib/platform-data';

export function SiteHeader() {
  const pathname = usePathname();
  const { locale, setLocale, text } = useLanguage();
  const toolMatch = pathname.match(/^\/tools\/([^/]+)/);
  const activeWorkbench = toolMatch ? getWorkbench(toolMatch[1]) : undefined;

  return (
    <header className="site-header">
      <div className="header-inner">
        <div className="header-brand-group">
          {activeWorkbench && (
            <Link
              className="header-workbench-exit"
              href={`/${activeWorkbench.section}`}
              aria-label={text(`退出${activeWorkbench.title}`, `Exit ${activeWorkbench.title}`)}
            >
              <LogOut size={16} aria-hidden="true" />
              <span>{text('退出工作台', 'Exit')}</span>
            </Link>
          )}
          <Link href="/" aria-label={text('SkyViewLab 首页', 'SkyViewLab home')}>
            <Image
              className="brand-logo"
              src="/assets/images/skyviewlab-logo.png"
              alt="SkyViewLab"
              width={328}
              height={80}
              priority
            />
          </Link>
        </div>

        <nav className="desktop-nav" aria-label={text('主导航', 'Main navigation')}>
          {navItems.map((item) => (
            <Link
              className="nav-link"
              data-active={pathname === item.href}
              href={item.href}
              key={item.href}
            >
              {locale === 'zh' ? item.label : item.labelEn}
            </Link>
          ))}
        </nav>

        <div className="nav-actions">
          <button
            className="language-toggle"
            type="button"
            data-no-translate
            aria-label={locale === 'zh' ? '切换到英文' : 'Switch to Chinese'}
            onClick={() => setLocale(locale === 'zh' ? 'en' : 'zh')}
          >
            <Languages size={17} aria-hidden="true" />
            <span>{locale === 'zh' ? '英文' : 'Chinese'}</span>
          </button>
          <Link className="header-button" href="/login">
            {text('登录', 'Sign in')}
          </Link>
          <Link className="header-button primary" href="/research">
            {text('进入工作台', 'Open workbenches')}
          </Link>
          <details className="mobile-nav">
            <summary aria-label={text('打开导航菜单', 'Open navigation menu')}>
              <span className="menu-glyph" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            </summary>
            <nav className="mobile-menu" aria-label={text('移动端导航', 'Mobile navigation')}>
              {navItems.map((item) => (
                <Link className="nav-link" href={item.href} key={item.href}>
                  {locale === 'zh' ? item.label : item.labelEn}
                </Link>
              ))}
              <Link className="nav-link" href="/login">
                {text('登录', 'Sign in')}
              </Link>
            </nav>
          </details>
        </div>
      </div>
    </header>
  );
}
