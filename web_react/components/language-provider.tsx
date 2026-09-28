'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import { LANGUAGE_STORAGE_KEY, translateText, type Locale } from '@/lib/i18n';

type LanguageContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  text: (zh: string, en: string) => string;
};

const LanguageContext = createContext<LanguageContextValue | null>(null);
const translatableAttributes = ['aria-label', 'title', 'placeholder'] as const;

function skipped(element: Element | null) {
  return Boolean(
    element?.closest(
      '[data-no-translate], script, style, noscript, textarea, pre, code, [contenteditable="true"]',
    ),
  );
}

const languageEvent = 'skyviewlab:language-change';

function readLocale(): Locale {
  if (typeof window === 'undefined') return 'zh';
  const saved = window.localStorage.getItem(LANGUAGE_STORAGE_KEY) ?? window.localStorage.getItem('cardVersionLanguage');
  return saved === 'en' ? 'en' : 'zh';
}

function subscribeLocale(callback: () => void) {
  const handleStorage = (event: StorageEvent) => {
    if (!event.key || event.key === LANGUAGE_STORAGE_KEY || event.key === 'cardVersionLanguage') callback();
  };
  window.addEventListener('storage', handleStorage);
  window.addEventListener(languageEvent, callback);
  return () => {
    window.removeEventListener('storage', handleStorage);
    window.removeEventListener(languageEvent, callback);
  };
}

function translateTree(root: HTMLElement, locale: Locale) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const parent = node.parentElement;
    if (!skipped(parent) && node.nodeValue) {
      const next = translateText(node.nodeValue, locale);
      if (next !== node.nodeValue) node.nodeValue = next;
    }
    node = walker.nextNode();
  }

  const elements = [root, ...root.querySelectorAll('*')];
  for (const element of elements) {
    if (skipped(element)) continue;
    for (const attribute of translatableAttributes) {
      const current = element.getAttribute(attribute);
      if (!current) continue;
      const next = translateText(current, locale);
      if (next !== current) element.setAttribute(attribute, next);
    }
  }
}

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const locale = useSyncExternalStore<Locale>(subscribeLocale, readLocale, () => 'zh');

  useEffect(() => {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
    document.documentElement.dataset.locale = locale;
    translateTree(document.body, locale);

    let queued = false;
    const observer = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      window.requestAnimationFrame(() => {
        queued = false;
        translateTree(document.body, locale);
      });
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, next);
    window.localStorage.setItem('cardVersionLanguage', next);
    window.dispatchEvent(new Event(languageEvent));
  }, []);

  const value = useMemo<LanguageContextValue>(
    () => ({ locale, setLocale, text: (zh, en) => (locale === 'zh' ? zh : en) }),
    [locale, setLocale],
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) throw new Error('useLanguage must be used inside LanguageProvider');
  return context;
}
