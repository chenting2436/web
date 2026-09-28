import type { Metadata } from 'next';
import { LanguageProvider } from '@/components/language-provider';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'SkyViewLab · 科研教学协作平台',
    template: '%s · SkyViewLab',
  },
  description: '面向地球科学研究、工程实践与课程教学的一体化协作平台。',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>
        <LanguageProvider>{children}</LanguageProvider>
      </body>
    </html>
  );
}
