'use client';

import { useEffect, useState } from 'react';
import { ToolWorkbench } from '@/components/tool-workbench';
import { AmbientNoiseWorkbench } from '@/components/ambient-noise-workbench';
import { DataGatewayWorkbench } from '@/components/data-gateway-workbench';
import { PatentDisclosureWorkbench } from '@/components/patent-disclosure-workbench';
import { PatentTransferWorkbench } from '@/components/patent-transfer-workbench';
import { PaperWritingWorkbench } from '@/components/paper-writing-workbench';
import { RemoteSensingWorkbench } from '@/components/remote-sensing-workbench';
import { SeismicPhysicsWorkbench } from '@/components/seismic-physics-workbench';
import { SkillEvolutionWorkbench } from '@/components/skill-evolution-workbench';
import { KnowledgeSystemWorkbench } from '@/components/knowledge-system-workbench';
import { ResearchRadarWorkbench } from '@/components/research-radar-workbench';
import { MineSafetyRadarWorkbench } from '@/components/mine-safety-radar-workbench';
import { ResearchAutomationWorkbench } from '@/components/research-automation-workbench';
import { PythonLabWorkbench } from '@/components/python-lab-workbench';
import { DailyPracticeWorkbench } from '@/components/daily-practice-workbench';
import { AiAssessmentWorkbench } from '@/components/ai-assessment-workbench';
import { Flac3dSlopeWorkbench } from '@/components/flac3d-slope-workbench';
import { WarningPlatformWorkbench } from '@/components/warning-platform-workbench';
import { UavInspectionWorkbench } from '@/components/uav-inspection-workbench';
import { FusionConsoleWorkbench } from '@/components/fusion-console-workbench';
import { EmergencyConsoleWorkbench } from '@/components/emergency-console-workbench';
import { ProjectWorkspaceWorkbench } from '@/components/project-workspace-workbench';
import { ScientificAnimationWorkbench } from '@/components/scientific-animation-workbench';
import { DataLabWorkbench } from '@/components/data-lab-workbench';
import { AiReportWorkbench } from '@/components/ai-report-workbench';
import { PythonEnglishWorkbench } from '@/components/python-english-workbench';
import {
  resolveWorkbenchReadiness,
  type CapabilityLoadState,
} from '@/lib/capability-state';
import { getWorkbenchReadiness, type Workbench } from '@/lib/platform-data';
import {
  capabilityApi,
  type ToolCapabilityDto,
} from '@/services/api/capabilities';

export function WorkbenchAvailability({ workbench }: { workbench: Workbench }) {
  const [loadState, setLoadState] = useState<CapabilityLoadState>('loading');
  const [capability, setCapability] = useState<ToolCapabilityDto>();

  useEffect(() => {
    let active = true;
    const loadCapability = () => {
      capabilityApi.list().then(
        (items) => {
          if (!active) return;
          setCapability(items.find((item) => item.slug === workbench.slug));
          setLoadState('ready');
        },
        () => {
          if (!active) return;
          setCapability(undefined);
          setLoadState('error');
        },
      );
    };
    loadCapability();
    const retryTimer = window.setInterval(loadCapability, 10_000);
    window.addEventListener('focus', loadCapability);
    window.addEventListener('online', loadCapability);
    return () => {
      active = false;
      window.clearInterval(retryTimer);
      window.removeEventListener('focus', loadCapability);
      window.removeEventListener('online', loadCapability);
    };
  }, [workbench.slug]);

  const readiness = resolveWorkbenchReadiness(
    getWorkbenchReadiness(workbench.slug),
    capability,
    loadState,
  );

  if (workbench.slug === 'ambient-noise-imaging') {
    return (
      <div className="layered-workbench-theme" data-workbench="ambient-noise-imaging">
        <AmbientNoiseWorkbench executionAllowed={readiness.executionAllowed} />
      </div>
    );
  }

  if (workbench.slug === 'data-gateway') {
    return (
      <div className="layered-workbench-theme" data-workbench="data-gateway">
        <DataGatewayWorkbench executionAllowed={readiness.executionAllowed} />
      </div>
    );
  }

  if (workbench.slug === 'patent-disclosure') {
    return (
      <div className="layered-workbench-theme" data-workbench="patent-disclosure">
        <PatentDisclosureWorkbench
          executionAllowed={readiness.executionAllowed}
        />
      </div>
    );
  }

  if (workbench.slug === 'paper-writing') {
    return (
      <div className="layered-workbench-theme" data-workbench="paper-writing">
        <PaperWritingWorkbench executionAllowed={readiness.executionAllowed} />
      </div>
    );
  }

  if (workbench.slug === 'disaster-remote-sensing') {
    return (
      <div className="layered-workbench-theme" data-workbench="disaster-remote-sensing">
        <RemoteSensingWorkbench executionAllowed={readiness.executionAllowed} />
      </div>
    );
  }

  if (workbench.slug === 'seismic-physics') {
    return (
      <div className="layered-workbench-theme" data-workbench="seismic-physics">
        <SeismicPhysicsWorkbench executionAllowed={readiness.executionAllowed} />
      </div>
    );
  }

  if (workbench.slug === 'patent-transfer') {
    return (
      <div className="layered-workbench-theme" data-workbench="patent-transfer">
        <PatentTransferWorkbench executionAllowed={readiness.executionAllowed} />
      </div>
    );
  }

  if (workbench.slug === 'skill-evolution') {
    return (
      <div className="layered-workbench-theme" data-workbench="skill-evolution">
        <SkillEvolutionWorkbench executionAllowed={readiness.executionAllowed} />
      </div>
    );
  }

  if (workbench.slug === 'knowledge-system') {
    return (
      <div className="layered-workbench-theme" data-workbench="knowledge-system">
        <KnowledgeSystemWorkbench executionAllowed={readiness.executionAllowed} />
      </div>
    );
  }

  if (workbench.slug === 'research-radar') {
    return (
      <div className="layered-workbench-theme" data-workbench="research-radar">
        <ResearchRadarWorkbench executionAllowed={readiness.executionAllowed} />
      </div>
    );
  }

  if (workbench.slug === 'mine-safety-radar') {
    return (
      <div className="layered-workbench-theme" data-workbench="mine-safety-radar">
        <MineSafetyRadarWorkbench executionAllowed={readiness.executionAllowed} />
      </div>
    );
  }

  if (workbench.slug === 'research-automation') {
    return (
      <div className="layered-workbench-theme" data-workbench="research-automation">
        <ResearchAutomationWorkbench executionAllowed={readiness.executionAllowed} />
      </div>
    );
  }

  if (workbench.slug === 'python-lab') {
    return (
      <div className="layered-workbench-theme" data-workbench="python-lab">
        <PythonLabWorkbench executionAllowed={readiness.executionAllowed} />
      </div>
    );
  }

  if (workbench.slug === 'daily-practice') {
    return (
      <div className="layered-workbench-theme" data-workbench="daily-practice">
        <DailyPracticeWorkbench executionAllowed={readiness.executionAllowed} />
      </div>
    );
  }

  if (workbench.slug === 'ai-assessment') {
    return (
      <div className="layered-workbench-theme" data-workbench="ai-assessment">
        <AiAssessmentWorkbench executionAllowed={readiness.executionAllowed} />
      </div>
    );
  }

  if (workbench.slug === 'flac3d-slope-stability') {
    return (
      <div className="layered-workbench-theme" data-workbench="flac3d-slope-stability">
        <Flac3dSlopeWorkbench executionAllowed={readiness.executionAllowed} />
      </div>
    );
  }

  if (workbench.slug === 'warning-platform') {
    return (
      <div className="layered-workbench-theme" data-workbench="warning-platform">
        <WarningPlatformWorkbench executionAllowed={readiness.executionAllowed} />
      </div>
    );
  }

  if (workbench.slug === 'uav-inspection') {
    return (
      <div className="layered-workbench-theme" data-workbench="uav-inspection">
        <UavInspectionWorkbench executionAllowed={readiness.executionAllowed} />
      </div>
    );
  }

  if (workbench.slug === 'fusion-console') {
    return (
      <div className="layered-workbench-theme" data-workbench="fusion-console">
        <FusionConsoleWorkbench executionAllowed={readiness.executionAllowed} />
      </div>
    );
  }

  if (workbench.slug === 'emergency-console') {
    return (
      <div className="layered-workbench-theme" data-workbench="emergency-console">
        <EmergencyConsoleWorkbench executionAllowed={readiness.executionAllowed} />
      </div>
    );
  }

  if (workbench.slug === 'project-workspace') {
    return (
      <div className="layered-workbench-theme" data-workbench="project-workspace">
        <ProjectWorkspaceWorkbench executionAllowed={readiness.executionAllowed} />
      </div>
    );
  }

  if (workbench.slug === 'scientific-animation-studio') {
    return (
      <div className="layered-workbench-theme" data-workbench="scientific-animation-studio">
        <ScientificAnimationWorkbench executionAllowed={readiness.executionAllowed} />
      </div>
    );
  }

  if (workbench.slug === 'data-lab') {
    return (
      <div className="layered-workbench-theme" data-workbench="data-lab">
        <DataLabWorkbench executionAllowed={readiness.executionAllowed} />
      </div>
    );
  }

  if (workbench.slug === 'ai-report') {
    return (
      <div className="layered-workbench-theme" data-workbench="ai-report">
        <AiReportWorkbench executionAllowed={readiness.executionAllowed} />
      </div>
    );
  }

  if (workbench.slug === 'python-english') {
    return (
      <div className="layered-workbench-theme" data-workbench="python-english">
        <PythonEnglishWorkbench executionAllowed={readiness.executionAllowed} />
      </div>
    );
  }

  if (readiness.executionAllowed) {
    return <ToolWorkbench slug={workbench.slug} title={workbench.title} />;
  }

  return (
    <section className="workbench-gate" aria-labelledby="workbench-gate-title">
      <div>
        <span>工作台状态</span>
        <h2 id="workbench-gate-title">
          {loadState === 'loading'
            ? '正在连接服务'
            : readiness.status === 'planned'
              ? '功能正在建设'
              : '该功能暂未开放'}
        </h2>
      </div>
      <ul>
        {workbench.capabilities.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}
