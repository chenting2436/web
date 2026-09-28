'use client';

import { useEffect, useMemo, useState } from 'react';
import { WorkbenchCard } from '@/components/workbench-card';
import {
  resolveWorkbenchReadiness,
  type CapabilityLoadState,
} from '@/lib/capability-state';
import {
  getWorkbenchReadiness,
  type Workbench,
} from '@/lib/platform-data';
import {
  capabilityApi,
  type ToolCapabilityDto,
} from '@/services/api/capabilities';

export function WorkbenchGrid({ items }: { items: Workbench[] }) {
  const [loadState, setLoadState] = useState<CapabilityLoadState>('loading');
  const [capabilities, setCapabilities] = useState<ToolCapabilityDto[]>([]);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    capabilityApi.list().then(
      (result) => {
        if (!active) return;
        setCapabilities(result);
        setLoadState('ready');
      },
      () => {
        if (!active) return;
        setCapabilities([]);
        setLoadState('error');
      },
    );
    return () => {
      active = false;
    };
  }, [attempt]);

  const bySlug = useMemo(
    () => new Map(capabilities.map((capability) => [capability.slug, capability])),
    [capabilities],
  );

  return (
    <>
      <div className="capability-health" data-state={loadState} aria-live="polite">
        <span>
          {loadState === 'loading' && '正在校验控制面能力状态…'}
          {loadState === 'ready' && '能力状态已由 Go 控制面核验。'}
          {loadState === 'error' && '控制面当前不可用，所有执行入口已按安全默认值关闭。'}
        </span>
        {loadState === 'error' && (
          <button
            type="button"
            className="capability-retry"
            onClick={() => {
              setLoadState('loading');
              setAttempt((value) => value + 1);
            }}
          >
            重新校验
          </button>
        )}
      </div>
      <div className="tool-grid">
        {items.map((workbench) => (
          <WorkbenchCard
            key={workbench.slug}
            workbench={workbench}
            readiness={resolveWorkbenchReadiness(
              getWorkbenchReadiness(workbench.slug),
              bySlug.get(workbench.slug),
              loadState,
            )}
          />
        ))}
      </div>
    </>
  );
}
