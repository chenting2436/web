import Link from 'next/link';
import Image from 'next/image';
import { ArrowUpRight } from 'lucide-react';
import {
  getWorkbenchReadiness,
  type Workbench,
  type WorkbenchReadiness,
} from '@/lib/platform-data';

export function WorkbenchCard({
  workbench,
  readiness: readinessOverride,
}: {
  workbench: Workbench;
  readiness?: WorkbenchReadiness;
}) {
  const readiness = readinessOverride ?? getWorkbenchReadiness(workbench.slug);

  return (
    <article className="tool-card" data-status={readiness.status}>
      <Link className="tool-card-image" href={`/tools/${workbench.slug}`}>
        <Image
          src={workbench.image}
          alt=""
          fill
          sizes="(max-width: 640px) 100vw, (max-width: 960px) 50vw, 33vw"
        />
        <span className="tool-arrow" aria-hidden="true">
          <ArrowUpRight size={18} />
        </span>
      </Link>
      <div className="tool-card-body">
        {readiness.status !== 'prototype' && (
          <span className="delivery-status" data-status={readiness.status}>
            {readiness.status === 'planned' ? '即将开放' : '暂未开放'}
          </span>
        )}
        <h2>
          <Link href={`/tools/${workbench.slug}`}>{workbench.title}</Link>
        </h2>
        <p>{workbench.description}</p>
        <Link className="tool-text-link" href={`/tools/${workbench.slug}`}>
          {readiness.status === 'planned' ? '查看建设范围' : '查看当前版本'} <ArrowUpRight size={15} aria-hidden="true" />
        </Link>
      </div>
    </article>
  );
}
