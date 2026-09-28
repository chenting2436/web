import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { LiveEarthClock, ShanghaiTimeReadout } from '@/components/live-earth-clock';
import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';
import { homeEntrances } from '@/lib/site-data';

export default function Home() {
  return (
    <div className="site-shell">
      <SiteHeader />

      <main className="home-main page-width">
        <section className="page-width hero-grid">
          <div>
            <ShanghaiTimeReadout />
            <div className="hero-actions">
              <Link className="action-link primary" href="/research">
                浏览科研工作台
                <ArrowRight size={18} aria-hidden="true" />
              </Link>
              <Link className="action-link" href="/teaching">
                查看教学工具
              </Link>
            </div>
          </div>

          <LiveEarthClock />
        </section>

        <section className="page-width section-block" aria-labelledby="entrances-title">
          <div className="section-heading simple-heading">
            <h2 id="entrances-title">功能入口</h2>
          </div>

          <div className="entrance-grid">
            {homeEntrances.map((item) => {
              const Icon = item.icon;
              return (
                <Link className="entrance-card" href={item.href} key={item.title}>
                  <div className="card-icon">
                    <Icon size={20} aria-hidden="true" />
                  </div>
                  <div>
                    <h3>{item.title}</h3>
                    <p>{item.description}</p>
                  </div>
                  <ArrowRight className="entrance-arrow" size={18} aria-hidden="true" />
                </Link>
              );
            })}
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
