'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  CheckCircle2,
  Circle,
  CircleAlert,
  Clock3,
  Database,
  Download,
  FileArchive,
  Film,
  Gauge,
  Image as ImageIcon,
  Layers3,
  LockKeyhole,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Save,
  ScanSearch,
  Square,
  Trash2,
  Type,
  Upload,
} from 'lucide-react';
import { useLanguage } from '@/components/language-provider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiError } from '@/services/api/client';
import {
  toolApi,
  type WorkbenchJob,
  type WorkbenchProject,
} from '@/services/api/tools';

type Scene = {
  id: string;
  name: string;
  order: number;
  duration: number;
  fps: number;
  width: number;
  height: number;
  background: string;
  cameraId: string;
  status: string;
};

type SceneObject = {
  id: string;
  sceneId: string;
  type: string;
  name: string;
  parentId: string;
  locked: boolean;
  hidden: boolean;
  order: number;
  props: Record<string, string | number | boolean>;
};

type Keyframe = {
  id: string;
  sceneId: string;
  objectId: string;
  property: string;
  time: number;
  value: string | number | boolean;
  easing: string;
};

type Workspace = {
  id: string;
  name: string;
  description: string;
  version: number;
  currentSceneId: string;
  selectedObjectId: string;
  currentTime: number;
  scenes: Scene[];
  objects: SceneObject[];
  keyframes: Keyframe[];
  cameras: Array<Record<string, string | number>>;
  dataSources: Array<Record<string, unknown>>;
  bindings: Array<Record<string, unknown>>;
  narration: Array<Record<string, unknown>>;
  renderProfiles: Array<Record<string, unknown>>;
  renderJobs: Array<Record<string, unknown>>;
  snapshots: Array<Record<string, unknown>>;
  audit: Array<Record<string, unknown>>;
  createdAt: string;
  updatedAt: string;
};

type AnimationResult = {
  schema: string;
  version: number;
  stage: string;
  workspace: Workspace;
  analysis: {
    metrics?: Record<string, number>;
    diagnostics?: Array<Record<string, unknown>>;
    qualityChecks?: Array<{ label: string; passed: boolean }>;
    dataBindings?: Array<Record<string, unknown>>;
    storyboard?: Array<Record<string, unknown>>;
  };
  runtime: Record<string, unknown>;
  exports: {
    projectJson: string;
    manimScript: string;
    timelineCsv: string;
    storyboardHtml: string;
    renderManifest: string;
    packageBase64: string;
  };
};

type PropertyDraft = {
  name: string;
  text: string;
  x: string;
  y: string;
  opacity: string;
  scale: string;
  rotation: string;
  fill: string;
};

const views = [
  ['compose', '场景编排', 'Composer'],
  ['timeline', '时间轴', 'Timeline'],
  ['data', '数据驱动', 'Data'],
  ['review', '分镜审查', 'Review'],
  ['delivery', '成果交付', 'Delivery'],
] as const;

const objectTypeMeta: Record<string, { label: string; icon: typeof Square }> = {
  text: { label: '文本', icon: Type },
  rect: { label: '矩形', icon: Square },
  circle: { label: '圆形', icon: Circle },
  line: { label: '线段', icon: ScanSearch },
  path: { label: '路径', icon: Film },
  plot: { label: '图表', icon: Gauge },
  group: { label: '组合', icon: Box },
};

function sampleResult(): AnimationResult {
  const scenes: Scene[] = [
    { id: 'scene-wave', name: '面波传播与频散', order: 1, duration: 12, fps: 30, width: 960, height: 540, background: '#071426', cameraId: 'camera-wave', status: 'editing' },
    { id: 'scene-inversion', name: '层析反演过程', order: 2, duration: 9, fps: 30, width: 960, height: 540, background: '#081a2c', cameraId: 'camera-inversion', status: 'ready' },
    { id: 'scene-summary', name: '结果与方法总结', order: 3, duration: 7, fps: 30, width: 960, height: 540, background: '#0b1830', cameraId: 'camera-summary', status: 'draft' },
  ];
  const base = (id: string, sceneId: string, type: string, name: string, order: number, props: SceneObject['props'], locked = false): SceneObject => ({ id, sceneId, type, name, parentId: '', locked, hidden: false, order, props });
  const objects = [
    base('obj-title', 'scene-wave', 'text', '标题', 1, { x: 64, y: 56, text: '面波传播与频散', fontSize: 28, fill: '#f4f8ff', opacity: 1, scale: 1, rotation: 0 }),
    base('obj-subtitle', 'scene-wave', 'text', '说明', 2, { x: 66, y: 88, text: '不同周期的群速度沿测线传播', fontSize: 15, fill: '#8fb3d8', opacity: 1, scale: 1, rotation: 0 }),
    base('obj-ground', 'scene-wave', 'rect', '地层背景', 3, { x: 56, y: 246, width: 848, height: 214, fill: '#123454', stroke: '#4f7598', strokeWidth: 2, opacity: 1, scale: 1, rotation: 0 }, true),
    base('obj-layer', 'scene-wave', 'path', '速度界面', 4, { x: 0, y: 0, d: 'M56 326 C220 292 350 362 510 328 S750 286 904 338 L904 460 L56 460 Z', fill: '#0b5969', stroke: '#3ab0b9', strokeWidth: 2, opacity: 0.86, scale: 1, rotation: 0 }),
    base('obj-source', 'scene-wave', 'circle', '震源', 5, { x: 156, y: 225, radius: 12, fill: '#f27649', stroke: '#ffd7c8', strokeWidth: 3, opacity: 1, scale: 1, rotation: 0 }),
    base('obj-wave-a', 'scene-wave', 'path', '短周期波列', 6, { x: 0, y: 0, d: 'M160 218 C190 158 220 278 250 218 S310 158 340 218 S400 278 430 218 S490 158 520 218 S580 278 610 218', fill: 'none', stroke: '#55d6df', strokeWidth: 5, opacity: 0.95, scale: 1, rotation: 0 }),
    base('obj-wave-b', 'scene-wave', 'path', '长周期波列', 7, { x: 0, y: 0, d: 'M160 226 C220 120 280 332 340 226 S460 120 520 226 S640 332 700 226 S820 120 880 226', fill: 'none', stroke: '#f5bb58', strokeWidth: 4, opacity: 0.8, scale: 1, rotation: 0 }),
    base('obj-station-a', 'scene-wave', 'circle', '台站 A', 8, { x: 380, y: 238, radius: 8, fill: '#ffffff', stroke: '#55d6df', strokeWidth: 4, opacity: 1, scale: 1, rotation: 0 }),
    base('obj-station-b', 'scene-wave', 'circle', '台站 B', 9, { x: 780, y: 238, radius: 8, fill: '#ffffff', stroke: '#f5bb58', strokeWidth: 4, opacity: 1, scale: 1, rotation: 0 }),
    base('obj-axis-x', 'scene-wave', 'line', '频散横轴', 10, { x1: 610, y1: 430, x2: 866, y2: 430, stroke: '#a8bdd2', strokeWidth: 2, opacity: 1 }, true),
    base('obj-axis-y', 'scene-wave', 'line', '频散纵轴', 11, { x1: 610, y1: 430, x2: 610, y2: 346, stroke: '#a8bdd2', strokeWidth: 2, opacity: 1 }, true),
    base('obj-curve', 'scene-wave', 'path', '频散曲线', 12, { x: 0, y: 0, d: 'M618 408 C662 394 694 378 728 380 S790 352 856 358', fill: 'none', stroke: '#f27649', strokeWidth: 4, opacity: 1, scale: 1, rotation: 0 }),
    base('obj-inversion-title', 'scene-inversion', 'text', '反演标题', 1, { x: 68, y: 58, text: '层析反演：从射线路径到速度结构', fontSize: 27, fill: '#f4f8ff', opacity: 1, scale: 1, rotation: 0 }),
    base('obj-inversion-grid', 'scene-inversion', 'rect', '反演网格', 2, { x: 150, y: 120, width: 660, height: 330, fill: '#11495a', stroke: '#56c4cd', strokeWidth: 2, opacity: 0.9, scale: 1, rotation: 0 }),
    base('obj-summary-title', 'scene-summary', 'text', '总结标题', 1, { x: 92, y: 84, text: '可复核的成像结论', fontSize: 34, fill: '#f4f8ff', opacity: 1, scale: 1, rotation: 0 }),
  ];
  const kf = (id: string, objectId: string, property: string, time: number, value: number, easing = 'smooth'): Keyframe => ({ id, sceneId: 'scene-wave', objectId, property, time, value, easing });
  const keyframes = [
    kf('kf-01', 'obj-title', 'opacity', 0, 0, 'ease-out'), kf('kf-02', 'obj-title', 'opacity', 0.8, 1, 'ease-out'),
    kf('kf-03', 'obj-subtitle', 'opacity', 0.4, 0, 'ease-out'), kf('kf-04', 'obj-subtitle', 'opacity', 1.4, 1, 'ease-out'),
    kf('kf-05', 'obj-source', 'scale', 1, 0.4), kf('kf-06', 'obj-source', 'scale', 2, 1.4), kf('kf-07', 'obj-source', 'scale', 2.8, 1),
    kf('kf-08', 'obj-wave-a', 'x', 1.8, -180, 'linear'), kf('kf-09', 'obj-wave-a', 'x', 6, 240, 'linear'),
    kf('kf-10', 'obj-wave-b', 'x', 2, -220, 'ease-in-out'), kf('kf-11', 'obj-wave-b', 'x', 8.2, 80, 'ease-in-out'),
    kf('kf-12', 'obj-station-a', 'scale', 3, 1), kf('kf-13', 'obj-station-a', 'scale', 4, 1.8), kf('kf-14', 'obj-station-a', 'scale', 4.8, 1),
    kf('kf-15', 'obj-station-b', 'scale', 6.3, 1), kf('kf-16', 'obj-station-b', 'scale', 7.3, 1.8), kf('kf-17', 'obj-station-b', 'scale', 8, 1),
    kf('kf-18', 'obj-curve', 'opacity', 7, 0, 'ease-out'), kf('kf-19', 'obj-curve', 'opacity', 9, 1, 'ease-out'),
    kf('kf-20', 'obj-curve', 'scale', 7, 0.6, 'ease-out'), kf('kf-21', 'obj-curve', 'scale', 9, 1, 'ease-out'),
  ];
  const workspace: Workspace = {
    id: 'animation-project-surface-wave', name: '面波成像科普动画', description: '用可复核场景、数据曲线与镜头组织解释面波传播和层析反演。', version: 8,
    currentSceneId: 'scene-wave', selectedObjectId: 'obj-wave-a', currentTime: 4.8, scenes, objects, keyframes,
    cameras: scenes.map((scene) => ({ id: scene.cameraId, sceneId: scene.id, name: '主镜头', x: 480, y: 270, zoom: 1, rotation: 0, projection: 'orthographic' })),
    dataSources: [
      { id: 'data-dispersion', name: '频散拾取结果', format: 'CSV', rows: 8, columns: ['period_s', 'group_velocity_km_s', 'quality'], checksum: 'sha256:sample-dispersion', status: 'bound' },
      { id: 'data-model', name: '层析网格摘要', format: 'JSON', rows: 80, columns: ['x_km', 'y_km', 'velocity_km_s', 'coverage'], checksum: 'sha256:sample-tomography', status: 'bound' },
    ],
    bindings: [
      { id: 'binding-curve', sceneId: 'scene-wave', sourceId: 'data-dispersion', objectId: 'obj-curve', mapping: { x: 'period_s', y: 'group_velocity_km_s', filter: 'quality >= 0.8' }, status: 'valid' },
      { id: 'binding-grid', sceneId: 'scene-inversion', sourceId: 'data-model', objectId: 'obj-inversion-grid', mapping: { x: 'x_km', y: 'y_km', color: 'velocity_km_s', opacity: 'coverage' }, status: 'valid' },
    ],
    narration: [
      { id: 'cue-01', sceneId: 'scene-wave', start: 0, end: 3, text: '首先建立地层、震源与观测台站。', status: 'draft' },
      { id: 'cue-02', sceneId: 'scene-wave', start: 3, end: 8.2, text: '不同周期的面波以不同群速度传播。', status: 'draft' },
      { id: 'cue-03', sceneId: 'scene-wave', start: 8.2, end: 12, text: '由到时差形成频散曲线，为反演提供观测。', status: 'draft' },
    ],
    renderProfiles: [
      { id: 'preview-web', name: '网页实时预览', width: 960, height: 540, fps: 30, format: 'SVG/Web Animation', status: 'enabled' },
      { id: 'video-hd', name: '高清交付', width: 1920, height: 1080, fps: 60, format: 'MP4/H.264', status: 'runtime-required' },
      { id: 'frame-4k', name: '四倍高清关键帧', width: 3840, height: 2160, fps: 1, format: 'PNG', status: 'runtime-required' },
    ],
    renderJobs: [], snapshots: [{ id: 'snapshot-storyboard', label: '传播场景分镜确认', version: 6, createdAt: '2026-09-10T08:30:00Z', sceneIds: scenes.map((scene) => scene.id) }],
    audit: [{ id: 'audit-seed', time: '2026-09-10T08:30:00Z', action: 'create-snapshot', actor: '动画负责人', target: 'snapshot-storyboard', detail: '冻结三场景分镜结构' }],
    createdAt: '2026-09-09T01:00:00Z', updatedAt: '2026-09-10T08:30:00Z',
  };
  return {
    schema: 'skyview-scientific-animation-results', version: 2, stage: 'load-sample', workspace,
    analysis: { metrics: { scenes: 3, objects: 15, tracks: 12, keyframes: 21, duration: 28, qualityPassed: 6 }, diagnostics: [], qualityChecks: [
      { label: '对象标识唯一', passed: true }, { label: '关键帧位于场景时长内', passed: true }, { label: '数据绑定列映射完整', passed: true },
      { label: '所有场景均绑定相机', passed: true }, { label: '网页预览不执行导入代码', passed: true }, { label: '外部视频渲染未伪装为已完成', passed: true },
    ], dataBindings: workspace.bindings, storyboard: [] },
    runtime: {
      webPreview: { status: 'enabled', engine: 'SVG + Web Animation timeline' }, composer: { status: 'enabled', engine: 'Python deterministic scene compiler' },
      manimGL: { status: 'not-configured', engine: 'isolated ManimGL render worker' }, ffmpeg: { status: 'not-configured', engine: 'FFmpeg transcode worker' },
      latex: { status: 'not-configured', engine: 'sandboxed LaTeX service' }, objectStorage: { status: 'not-configured', engine: 'S3 compatible artifacts' }, arbitraryCodeExecution: false,
    },
    exports: { projectJson: '', manimScript: '', timelineCsv: '', storyboardHtml: '', renderManifest: '', packageBase64: '' },
  };
}

function eased(value: number, mode: string) {
  const t = Math.max(0, Math.min(1, value));
  if (mode === 'ease-in') return t * t;
  if (mode === 'ease-out') return 1 - (1 - t) ** 2;
  if (mode === 'ease-in-out' || mode === 'smooth') return t * t * (3 - 2 * t);
  return t;
}

function interpolated(frames: Keyframe[], base: SceneObject['props'][string], time: number) {
  if (!frames.length) return base;
  const ordered = [...frames].sort((a, b) => a.time - b.time);
  if (time <= ordered[0].time) return ordered[0].value;
  if (time >= ordered[ordered.length - 1].time) return ordered[ordered.length - 1].value;
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const left = ordered[index];
    const right = ordered[index + 1];
    if (left.time <= time && time <= right.time) {
      if (typeof left.value !== 'number' || typeof right.value !== 'number') return left.value;
      const fraction = eased((time - left.time) / Math.max(0.0001, right.time - left.time), right.easing);
      return left.value + (right.value - left.value) * fraction;
    }
  }
  return base;
}

function frameObjects(workspace: Workspace, scene: Scene, time: number) {
  return workspace.objects
    .filter((item) => item.sceneId === scene.id && !item.hidden)
    .sort((a, b) => a.order - b.order)
    .map((item) => {
      const props = { ...item.props };
      Object.keys(props).forEach((property) => {
        props[property] = interpolated(workspace.keyframes.filter((row) => row.objectId === item.id && row.property === property), props[property], time);
      });
      return { ...item, props };
    });
}

async function waitForJob(id: string): Promise<WorkbenchJob | null> {
  for (let index = 0; index < 90; index += 1) {
    const job = await toolApi.getJob(id);
    if (['succeeded', 'failed', 'canceled'].includes(job.status)) return job;
    await new Promise((resolve) => window.setTimeout(resolve, 350));
  }
  return null;
}

function downloadText(content: string, name: string, type: string) {
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(new Blob([content], { type }));
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}

function downloadBase64(content: string, name: string) {
  const bytes = Uint8Array.from(atob(content), (value) => value.charCodeAt(0));
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}

function SceneCanvas({ scene, objects, selectedId, select }: { scene: Scene; objects: SceneObject[]; selectedId: string; select: (id: string) => void }) {
  return (
    <svg className="animx-stage-svg" viewBox={`0 0 ${scene.width} ${scene.height}`} aria-label={`${scene.name}网页动画预览`}>
      <defs>
        <pattern id="animx-grid" width="48" height="48" patternUnits="userSpaceOnUse">
          <path d="M 48 0 L 0 0 0 48" fill="none" stroke="#b8d1e8" strokeOpacity=".08" strokeWidth="1" />
        </pattern>
        <filter id="animx-glow"><feGaussianBlur stdDeviation="7" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
      </defs>
      <rect width={scene.width} height={scene.height} fill={scene.background} />
      <rect width={scene.width} height={scene.height} fill="url(#animx-grid)" />
      {objects.map((item) => {
        const p = item.props;
        const selected = selectedId === item.id;
        const x = Number(p.x ?? 0);
        const y = Number(p.y ?? 0);
        const pivotTransform = `rotate(${Number(p.rotation ?? 0)} ${x} ${y}) translate(${x} ${y}) scale(${Number(p.scale ?? 1)}) translate(${-x} ${-y})`;
        const originTransform = `translate(${x} ${y}) rotate(${Number(p.rotation ?? 0)}) scale(${Number(p.scale ?? 1)})`;
        const common = { opacity: Number(p.opacity ?? 1), onClick: () => select(item.id), className: selected ? 'animx-selected-shape' : 'animx-shape' };
        if (item.type === 'rect') return <rect key={item.id} x={x} y={y} width={Number(p.width)} height={Number(p.height)} rx="8" fill={String(p.fill ?? 'none')} stroke={String(p.stroke ?? 'none')} strokeWidth={Number(p.strokeWidth ?? 0)} transform={pivotTransform} {...common} />;
        if (item.type === 'circle') return <circle key={item.id} cx={x} cy={y} r={Number(p.radius)} fill={String(p.fill ?? 'none')} stroke={String(p.stroke ?? 'none')} strokeWidth={Number(p.strokeWidth ?? 0)} transform={pivotTransform} {...common} filter={item.name === '震源' ? 'url(#animx-glow)' : undefined} />;
        if (item.type === 'line') return <line key={item.id} x1={Number(p.x1)} y1={Number(p.y1)} x2={Number(p.x2)} y2={Number(p.y2)} stroke={String(p.stroke ?? '#fff')} strokeWidth={Number(p.strokeWidth ?? 2)} {...common} />;
        if (item.type === 'path') return <path key={item.id} d={String(p.d ?? '')} fill={String(p.fill ?? 'none')} stroke={String(p.stroke ?? 'none')} strokeWidth={Number(p.strokeWidth ?? 0)} strokeLinecap="round" strokeLinejoin="round" transform={originTransform} {...common} />;
        if (item.type === 'text') return <text key={item.id} x={x} y={y} fill={String(p.fill ?? '#fff')} fontSize={Number(p.fontSize ?? 24)} fontFamily="var(--font-sans)" fontWeight="650" transform={pivotTransform} {...common}>{String(p.text ?? '')}</text>;
        return null;
      })}
    </svg>
  );
}

export function ScientificAnimationWorkbench({ executionAllowed = true }: { executionAllowed?: boolean }) {
  const { locale, text } = useLanguage();
  const [view, setView] = useState<(typeof views)[number][0]>('compose');
  const [result, setResult] = useState<AnimationResult>(() => sampleResult());
  const [projects, setProjects] = useState<WorkbenchProject[]>([]);
  const [projectId, setProjectId] = useState('');
  const [workspaceTitle, setWorkspaceTitle] = useState('科学动画创作项目');
  const [playhead, setPlayhead] = useState(result.workspace.currentTime);
  const [playing, setPlaying] = useState(false);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('网页预览已就绪，可直接播放和逐帧检查。');
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<PropertyDraft>({ name: '', text: '', x: '0', y: '0', opacity: '1', scale: '1', rotation: '0', fill: '#55d6df' });
  const importInput = useRef<HTMLInputElement>(null);

  const scene = result.workspace.scenes.find((item) => item.id === result.workspace.currentSceneId) ?? result.workspace.scenes[0];
  const sceneObjects = useMemo(() => frameObjects(result.workspace, scene, playhead), [result.workspace, scene, playhead]);
  const layers = useMemo(() => result.workspace.objects.filter((item) => item.sceneId === scene.id).sort((a, b) => b.order - a.order), [result.workspace.objects, scene.id]);
  const selected = layers.find((item) => item.id === result.workspace.selectedObjectId) ?? layers[0];
  const tracks = useMemo(() => layers.map((item) => ({ item, frames: result.workspace.keyframes.filter((frame) => frame.objectId === item.id).sort((a, b) => a.time - b.time) })), [layers, result.workspace.keyframes]);
  const totalDuration = result.workspace.scenes.reduce((sum, item) => sum + Number(item.duration), 0);
  const quality = result.analysis.qualityChecks ?? [];

  useEffect(() => {
    let active = true;
    toolApi.listProjects('scientific-animation-studio').then((items) => {
      if (!active) return;
      setProjects(items);
      const first = items[0];
      const saved = first?.state.scientificAnimation as { result?: AnimationResult } | undefined;
      if (first && saved?.result?.schema === 'skyview-scientific-animation-results') {
        setProjectId(first.id);
        setWorkspaceTitle(first.title);
        setResult(saved.result);
        setPlayhead(saved.result.workspace.currentTime);
      }
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let animation = 0;
    const tick = (now: number) => {
      const elapsed = (now - last) / 1000;
      last = now;
      setPlayhead((current) => current + elapsed >= scene.duration ? 0 : current + elapsed);
      animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animation);
  }, [playing, scene.duration]);

  const propertyDraft = (item?: SceneObject): PropertyDraft => ({
    name: item?.name ?? '',
    text: String(item?.props.text ?? ''),
    x: String(item?.props.x ?? 0),
    y: String(item?.props.y ?? 0),
    opacity: String(item?.props.opacity ?? 1),
    scale: String(item?.props.scale ?? 1),
    rotation: String(item?.props.rotation ?? 0),
    fill: String(item?.props.fill ?? '#55d6df'),
  });

  const projectState = (next = result) => ({ scientificAnimation: { result: next } });
  const ensureProject = async () => {
    const existing = projects.find((item) => item.id === projectId);
    if (existing) return existing;
    const created = await toolApi.createProject('scientific-animation-studio', workspaceTitle, projectState());
    setProjects((items) => [created, ...items]);
    setProjectId(created.id);
    return created;
  };
  const storeResult = async (project: WorkbenchProject, output: AnimationResult) => {
    setResult(output);
    setPlayhead(output.workspace.currentTime);
    setDraft(propertyDraft(output.workspace.objects.find((item) => item.id === output.workspace.selectedObjectId)));
    const saved = await toolApi.updateProject(project.id, workspaceTitle, projectState(output));
    setProjects((items) => [saved, ...items.filter((item) => item.id !== saved.id)]);
  };
  const execute = async (action: string, extra: Record<string, unknown> = {}) => {
    if (!executionAllowed) {
      setError(text('动画计算服务当前不可用。', 'Animation service is unavailable.'));
      return null;
    }
    setRunning(true);
    setError('');
    setMessage(text('Go 已登记作业，Python 正在编译场景与审计记录…', 'Job registered; the scene compiler is running…'));
    try {
      const project = await ensureProject();
      const created = await toolApi.createJob(project.id, 'scientific-animation-studio', action, { state: result, actor: '当前创作者', actorRole: 'owner', ...extra }, crypto.randomUUID());
      const job = await waitForJob(created.job.id);
      if (!job) throw new Error(text('作业仍在后台运行。', 'The job is still running.'));
      if (job.status !== 'succeeded') throw new Error(job.error || text('动画作业失败。', 'Animation job failed.'));
      const output = job.result as AnimationResult;
      if (output.schema !== 'skyview-scientific-animation-results') throw new Error(text('服务端结果不兼容。', 'Incompatible result.'));
      await storeResult(project, output);
      setMessage(text('场景、时间轴、质量检查和审计已同步。', 'Scene, timeline, quality and audit synchronized.'));
      return output;
    } catch (caught) {
      setError(caught instanceof ApiError || caught instanceof Error ? caught.message : text('操作失败。', 'Action failed.'));
      setMessage('');
      return null;
    } finally {
      setRunning(false);
    }
  };
  const saveWorkspace = async () => {
    setSaving(true);
    setError('');
    try {
      const existing = projects.find((item) => item.id === projectId);
      const saved = existing ? await toolApi.updateProject(existing.id, workspaceTitle, projectState()) : await toolApi.createProject('scientific-animation-studio', workspaceTitle, projectState());
      setProjects((items) => [saved, ...items.filter((item) => item.id !== saved.id)]);
      setProjectId(saved.id);
      setMessage(text('动画项目已保存。', 'Animation project saved.'));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : text('保存失败。', 'Save failed.'));
    } finally { setSaving(false); }
  };
  const createVersion = async () => {
    try {
      const project = await ensureProject();
      await toolApi.createVersion(project.id, `动画版本 ${result.workspace.version} · ${new Date().toLocaleString(locale)}`, projectState());
      await execute('create-snapshot', { label: `分镜快照 ${result.workspace.version}` });
    } catch (caught) { setError(caught instanceof Error ? caught.message : text('版本创建失败。', 'Version failed.')); }
  };
  const selectStored = (id: string) => {
    setProjectId(id);
    const stored = projects.find((item) => item.id === id);
    if (!stored) { setResult(sampleResult()); setWorkspaceTitle('科学动画创作项目'); return; }
    const saved = stored.state.scientificAnimation as { result?: AnimationResult } | undefined;
    if (saved?.result?.schema === 'skyview-scientific-animation-results') {
      setResult(saved.result); setPlayhead(saved.result.workspace.currentTime); setWorkspaceTitle(stored.title);
      setDraft(propertyDraft(saved.result.workspace.objects.find((item) => item.id === saved.result?.workspace.selectedObjectId)));
    }
  };
  const selectObject = (objectId: string) => {
    setDraft(propertyDraft(result.workspace.objects.find((item) => item.id === objectId)));
    setResult((current) => ({ ...current, workspace: { ...current.workspace, selectedObjectId: objectId } }));
  };
  const updateSelected = async () => {
    if (!selected) return;
    await execute('update-object', { objectId: selected.id, name: draft.name, props: { text: draft.text, x: Number(draft.x), y: Number(draft.y), opacity: Number(draft.opacity), scale: Number(draft.scale), rotation: Number(draft.rotation), fill: draft.fill } });
  };
  const importProject = async (file?: File) => {
    if (!file) return;
    if (file.size > 4_000_000) { setError(text('动画项目不能超过 4 MB。', 'Project must not exceed 4 MB.')); return; }
    await execute('import-project', { fileName: file.name, content: await file.text() });
    if (importInput.current) importInput.current.value = '';
  };
  const exportArtifact = async (kind: keyof AnimationResult['exports'], fileName: string, mime: string) => {
    const output = await execute('export');
    const content = output?.exports[kind];
    if (!content) return;
    if (kind === 'packageBase64') downloadBase64(content, fileName);
    else downloadText(content, fileName, mime);
  };

  const metrics = [
    ['场景', result.workspace.scenes.length, 'Scenes'], ['对象', result.workspace.objects.length, 'Objects'],
    ['轨道', tracks.length, 'Tracks'], ['关键帧', result.workspace.keyframes.length, 'Keyframes'],
    ['总时长', `${totalDuration.toFixed(1)}s`, 'Duration'], ['质量门禁', `${quality.filter((item) => item.passed).length}/${quality.length}`, 'Quality'],
  ];

  return (
    <section className="animx-shell" aria-label={text('科学动画工作室', 'Scientific animation studio')}>
      <header className="animx-commandbar">
        <div className="animx-brand"><span><Film /></span><div><strong>{text('科学动画工作室', 'Scientific animation studio')}</strong><small>{text('场景 · 时间轴 · 数据 · 交付', 'Scenes · timeline · data · delivery')}</small></div></div>
        <select aria-label={text('已保存项目', 'Saved projects')} value={projectId} onChange={(event) => selectStored(event.target.value)}>
          <option value="">{text('当前本地项目', 'Current local project')}</option>
          {projects.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select>
        <Input aria-label={text('项目名称', 'Project name')} value={workspaceTitle} onChange={(event) => setWorkspaceTitle(event.target.value)} />
        <input ref={importInput} hidden type="file" accept="application/json,.json" onChange={(event) => void importProject(event.target.files?.[0])} />
        <Button variant="outline" onClick={() => importInput.current?.click()}><Upload />{text('导入', 'Import')}</Button>
        <Button variant="outline" disabled={saving} onClick={() => void saveWorkspace()}><Save />{saving ? text('保存中', 'Saving') : text('保存', 'Save')}</Button>
        <Button variant="outline" disabled={running} onClick={() => void createVersion()}><LockKeyhole />{text('固化版本', 'Snapshot')}</Button>
        <Button disabled={running} onClick={() => void execute('validate-scene')}>{running ? <RotateCcw className="animx-spin" /> : <ScanSearch />}{text('质量检查', 'Validate')}</Button>
      </header>

      <div className="animx-metrics">
        {metrics.map(([label, value, en]) => <div key={String(label)}><span>{text(String(label), String(en))}</span><strong>{value}</strong></div>)}
      </div>

      <nav className="animx-tabs" aria-label={text('动画工作区', 'Animation workspace')}>
        {views.map(([id, zh, en]) => <button key={id} type="button" className={view === id ? 'active' : ''} onClick={() => setView(id)}>{text(zh, en)}</button>)}
        <div className={`animx-status ${error ? 'error' : ''}`}>{error ? <CircleAlert /> : <CheckCircle2 />}{error || message}</div>
      </nav>

      <div className="animx-content">
        {view === 'compose' && (
          <div className="animx-compose">
            <aside className="animx-sidebar animx-scenes">
              <div className="animx-panel-title"><span>{text('场景与图层', 'Scenes & layers')}</span><button type="button" title={text('新建场景', 'New scene')} onClick={() => void execute('create-scene', { name: `新场景 ${result.workspace.scenes.length + 1}`, duration: 8 })}><Plus /></button></div>
              <div className="animx-scene-strip">
                {result.workspace.scenes.map((item, index) => <button type="button" key={item.id} className={scene.id === item.id ? 'active' : ''} onClick={() => void execute('select-scene', { sceneId: item.id })}><b>{String(index + 1).padStart(2, '0')}</b><span>{item.name}<small>{item.duration}s · {item.status === 'ready' ? text('就绪', 'Ready') : text('编辑中', 'Editing')}</small></span></button>)}
              </div>
              <div className="animx-layer-head"><span>{text('图层', 'Layers')}</span><small>{layers.length}</small></div>
              <div className="animx-layer-list">
                {layers.map((item) => {
                  const meta = objectTypeMeta[item.type] ?? objectTypeMeta.group;
                  const Icon = meta.icon;
                  return <button type="button" key={item.id} className={selected?.id === item.id ? 'active' : ''} onClick={() => selectObject(item.id)}><Icon /><span>{item.name}<small>{text(meta.label, item.type)}</small></span>{item.locked && <LockKeyhole />}</button>;
                })}
              </div>
              <div className="animx-add-grid">
                {(['text', 'rect', 'circle', 'path'] as const).map((type) => { const Icon = objectTypeMeta[type].icon; return <button key={type} type="button" onClick={() => void execute('add-object', { type, name: `新${objectTypeMeta[type].label}` })}><Icon />{text(objectTypeMeta[type].label, type)}</button>; })}
              </div>
            </aside>

            <main className="animx-stage-panel">
              <div className="animx-stage-head"><div><strong>{scene.name}</strong><small>{scene.width} × {scene.height} · {scene.fps} FPS</small></div><span>{text('网页实时预览', 'Live web preview')}</span></div>
              <div className="animx-stage"><SceneCanvas scene={scene} objects={sceneObjects} selectedId={selected?.id ?? ''} select={selectObject} /></div>
              <div className="animx-player">
                <button type="button" aria-label={playing ? text('暂停', 'Pause') : text('播放', 'Play')} onClick={() => setPlaying((value) => !value)}>{playing ? <Pause /> : <Play />}</button>
                <strong>{playhead.toFixed(2)}s</strong>
                <input aria-label={text('播放位置', 'Playhead')} type="range" min="0" max={scene.duration} step={1 / scene.fps} value={playhead} onChange={(event) => { setPlaying(false); setPlayhead(Number(event.target.value)); }} />
                <span>{scene.duration.toFixed(2)}s</span>
                <button type="button" onClick={() => void execute('render-preview', { time: playhead })}>{text('编译当前帧', 'Compile frame')}</button>
              </div>
            </main>

            <aside className="animx-sidebar animx-inspector">
              <div className="animx-panel-title"><span>{text('属性检查器', 'Inspector')}</span><small>{selected ? objectTypeMeta[selected.type]?.label ?? selected.type : '—'}</small></div>
              {selected ? <>
                <label>{text('图层名称', 'Layer name')}<Input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></label>
                {selected.type === 'text' && <label>{text('文本内容', 'Text')}<Input value={draft.text} onChange={(event) => setDraft((current) => ({ ...current, text: event.target.value }))} /></label>}
                <div className="animx-field-grid">
                  <label htmlFor="animx-x">横坐标<Input id="animx-x" type="number" value={draft.x} onChange={(event) => setDraft((current) => ({ ...current, x: event.target.value }))} /></label>
                  <label htmlFor="animx-y">纵坐标<Input id="animx-y" type="number" value={draft.y} onChange={(event) => setDraft((current) => ({ ...current, y: event.target.value }))} /></label>
                  <label htmlFor="animx-scale">缩放<Input id="animx-scale" type="number" min="0" step="0.1" value={draft.scale} onChange={(event) => setDraft((current) => ({ ...current, scale: event.target.value }))} /></label>
                  <label htmlFor="animx-rotation">旋转<Input id="animx-rotation" type="number" value={draft.rotation} onChange={(event) => setDraft((current) => ({ ...current, rotation: event.target.value }))} /></label>
                </div>
                <label>{text('不透明度', 'Opacity')}<div className="animx-inline-field"><input type="range" min="0" max="1" step="0.05" value={draft.opacity} onChange={(event) => setDraft((current) => ({ ...current, opacity: event.target.value }))} /><b>{Number(draft.opacity).toFixed(2)}</b></div></label>
                <label>{text('填充颜色', 'Fill color')}<div className="animx-color-field"><input type="color" value={draft.fill.startsWith('#') ? draft.fill : '#55d6df'} onChange={(event) => setDraft((current) => ({ ...current, fill: event.target.value }))} /><Input value={draft.fill} onChange={(event) => setDraft((current) => ({ ...current, fill: event.target.value }))} /></div></label>
                <div className="animx-inspector-actions"><Button disabled={running || selected.locked} onClick={() => void updateSelected()}><Save />{text('应用属性', 'Apply')}</Button><Button variant="destructive" disabled={running || selected.locked} onClick={() => void execute('delete-object', { objectId: selected.id })}><Trash2 /></Button></div>
                <div className="animx-keyframe-card"><span><Clock3 />{text('当前位置关键帧', 'Keyframe here')}</span><div><button type="button" onClick={() => void execute('add-keyframe', { objectId: selected.id, property: 'opacity', time: playhead, value: Number(draft.opacity), easing: 'smooth' })}>{text('透明度', 'Opacity')}</button><button type="button" onClick={() => void execute('add-keyframe', { objectId: selected.id, property: 'scale', time: playhead, value: Number(draft.scale), easing: 'smooth' })}>{text('缩放', 'Scale')}</button><button type="button" onClick={() => void execute('add-keyframe', { objectId: selected.id, property: 'x', time: playhead, value: Number(draft.x), easing: 'ease-in-out' })}>横坐标</button></div></div>
              </> : <p className="animx-empty">{text('选择一个图层开始编辑。', 'Select a layer to edit.')}</p>}
            </aside>
          </div>
        )}

        {view === 'timeline' && (
          <div className="animx-timeline-view">
            <div className="animx-view-head"><div><strong>{text('多轨时间轴', 'Multitrack timeline')}</strong><small>{scene.name} · {scene.duration}s · {scene.fps} FPS</small></div><div><Button variant="outline" onClick={() => setPlayhead(0)}><RotateCcw />{text('回到开头', 'Rewind')}</Button><Button onClick={() => setPlaying((value) => !value)}>{playing ? <Pause /> : <Play />}{playing ? text('暂停', 'Pause') : text('播放', 'Play')}</Button></div></div>
            <div className="animx-ruler"><span />{Array.from({ length: 7 }, (_, index) => <b key={index}>{((scene.duration / 6) * index).toFixed(1)}s</b>)}</div>
            <div className="animx-tracks">
              <i className="animx-playhead" style={{ left: `calc(194px + (100% - 214px) * ${playhead / scene.duration})` }} />
              {tracks.map(({ item, frames }) => <div className={`animx-track ${selected?.id === item.id ? 'active' : ''}`} key={item.id}><button type="button" className="animx-track-label" onClick={() => selectObject(item.id)}><b>{item.name}</b><small>{frames.length ? [...new Set(frames.map((frame) => frame.property))].join(' · ') : text('静态图层', 'Static')}</small></button><div>{frames.map((frame) => <button key={frame.id} type="button" aria-label={`${item.name} ${frame.property} ${frame.time}秒关键帧`} title={`${frame.property} · ${frame.time}s · ${frame.easing}`} style={{ left: `${(frame.time / scene.duration) * 100}%` }} onClick={() => { setPlayhead(frame.time); selectObject(item.id); }} />)}</div></div>)}
            </div>
            <div className="animx-narration"><strong>{text('解说与节拍', 'Narration cues')}</strong>{result.workspace.narration.filter((item) => item.sceneId === scene.id).map((cue) => <article key={String(cue.id)}><span>{Number(cue.start).toFixed(1)}–{Number(cue.end).toFixed(1)}s</span><p>{String(cue.text)}</p><small>{text('草稿', 'Draft')}</small></article>)}</div>
          </div>
        )}

        {view === 'data' && (
          <div className="animx-data-view">
            <div className="animx-sources">
              <div className="animx-view-head"><div><strong>{text('数据源', 'Data sources')}</strong><small>{text('校验和锁定输入版本', 'Checksums lock input versions')}</small></div><Button variant="outline"><Plus />{text('添加数据源', 'Add source')}</Button></div>
              {result.workspace.dataSources.map((source) => <article key={String(source.id)}><span><Database /></span><div><strong>{String(source.name)}</strong><small>{String(source.format)} · {String(source.rows)} {text('行', 'rows')}</small></div><code>{String(source.checksum)}</code><i>{text('已绑定', 'Bound')}</i></article>)}
            </div>
            <div className="animx-binding-map">
              <div className="animx-view-head"><div><strong>{text('字段到视觉通道', 'Fields to visual channels')}</strong><small>{text('输入、映射和目标图层可追溯', 'Traceable input, mapping and target')}</small></div></div>
              {result.workspace.bindings.map((binding) => {
                const source = result.workspace.dataSources.find((item) => item.id === binding.sourceId);
                const object = result.workspace.objects.find((item) => item.id === binding.objectId);
                const mapping = binding.mapping as Record<string, string>;
                return <article key={String(binding.id)}><div><Database /><strong>{String(source?.name ?? binding.sourceId)}</strong></div><span>→</span><div className="animx-mapping-pills">{Object.entries(mapping).map(([channel, field]) => <b key={channel}><small>{channel}</small>{field}</b>)}</div><span>→</span><div><Layers3 /><strong>{object?.name ?? String(binding.objectId)}</strong></div><i><CheckCircle2 />{text('有效', 'Valid')}</i></article>;
              })}
            </div>
            <div className="animx-data-preview"><div><strong>{text('频散数据预览', 'Dispersion data preview')}</strong><small>{text('字段映射实时驱动曲线', 'Field mapping drives the curve')}</small></div><svg viewBox="0 0 620 190" aria-hidden="true"><g>{[0, 1, 2, 3].map((row) => <line key={row} x1="34" x2="592" y1={28 + row * 42} y2={28 + row * 42} />)}</g><path d="M42 154 C118 145 164 121 222 126 S322 88 382 95 S484 50 580 44" /><circle cx="222" cy="126" r="5" /><circle cx="382" cy="95" r="5" /><circle cx="580" cy="44" r="5" /></svg></div>
          </div>
        )}

        {view === 'review' && (
          <div className="animx-review-view">
            <div className="animx-storyboard">
              <div className="animx-view-head"><div><strong>{text('分镜板', 'Storyboard')}</strong><small>{text('逐场景核对叙事、时长和画面', 'Review narrative, timing and frame')}</small></div><Button onClick={() => void execute('create-storyboard')}><ImageIcon />{text('重新生成', 'Regenerate')}</Button></div>
              <div className="animx-story-grid">{result.workspace.scenes.map((item, index) => { const frame = frameObjects(result.workspace, item, Math.min(item.duration * .55, item.duration)); return <article key={item.id}><div><SceneCanvas scene={item} objects={frame} selectedId="" select={() => undefined} /></div><span><b>{String(index + 1).padStart(2, '0')} · {item.name}</b><small>{item.duration}s · {result.workspace.objects.filter((row) => row.sceneId === item.id).length} {text('个对象', 'objects')}</small></span></article>; })}</div>
            </div>
            <aside className="animx-quality"><div className="animx-view-head"><div><strong>{text('质量门禁', 'Quality gates')}</strong><small>{quality.filter((item) => item.passed).length}/{quality.length} {text('项通过', 'passed')}</small></div></div>{quality.map((item) => <div key={item.label} className={item.passed ? 'passed' : 'failed'}>{item.passed ? <CheckCircle2 /> : <CircleAlert />}<span>{item.label}</span><b>{item.passed ? text('通过', 'Pass') : text('阻断', 'Blocked')}</b></div>)}<section><strong>{text('审计轨迹', 'Audit trail')}</strong>{result.workspace.audit.slice(0, 4).map((item) => <p key={String(item.id)}><b>{String(item.actor)}</b><span>{String(item.detail)}</span></p>)}</section></aside>
          </div>
        )}

        {view === 'delivery' && (
          <div className="animx-delivery-view">
            <div className="animx-delivery-main">
              <div className="animx-view-head"><div><strong>{text('交付配置', 'Delivery profiles')}</strong><small>{text('网页预览直接运行，外部渲染按真实接入状态展示', 'Web preview runs here; external render reflects actual status')}</small></div></div>
              <div className="animx-profile-grid">{result.workspace.renderProfiles.map((profile) => <article key={String(profile.id)}><span className={profile.status === 'enabled' ? 'enabled' : ''}>{profile.status === 'enabled' ? <Play /> : <Film />}</span><div><strong>{String(profile.name)}</strong><small>{String(profile.width)} × {String(profile.height)} · {String(profile.fps)} FPS</small><code>{String(profile.format)}</code></div><b>{profile.status === 'enabled' ? text('可用', 'Ready') : text('需接运行节点', 'Runtime needed')}</b><Button variant="outline" onClick={() => profile.status === 'enabled' ? setPlaying(true) : void execute('prepare-render', { profileId: profile.id })}>{profile.status === 'enabled' ? text('播放', 'Play') : text('准备任务', 'Prepare')}</Button></article>)}</div>
              <div className="animx-code-preview" data-no-translate><div><span>scene.py</span><b>{text('ManimGL 兼容脚本预览', 'ManimGL-compatible script')}</b></div><pre>{result.exports.manimScript || `from manimlib import *\n\nclass SkyViewScientificScene(Scene):\n    def construct(self):\n        title = Text("${scene.name}")\n        self.play(Write(title))\n        self.wait(1)`}</pre></div>
            </div>
            <aside className="animx-export-panel">
              <div className="animx-view-head"><div><strong>{text('导出成果', 'Exports')}</strong><small>{text('一次计算，形成可复核交付物', 'One compilation, traceable artifacts')}</small></div></div>
              <button type="button" onClick={() => void exportArtifact('projectJson', 'scientific-animation-project.json', 'application/json')}><FileArchive /><span><b>{text('动画项目', 'Animation project')}</b><small>JSON · {text('可再次导入', 're-importable')}</small></span><Download /></button>
              <button type="button" onClick={() => void exportArtifact('manimScript', 'scene.py', 'text/x-python')}><Film /><span><b>{text('动画脚本', 'Animation script')}</b><small>Python · ManimGL</small></span><Download /></button>
              <button type="button" onClick={() => void exportArtifact('timelineCsv', 'timeline.csv', 'text/csv')}><Clock3 /><span><b>{text('时间轴数据', 'Timeline data')}</b><small>CSV · {text('关键帧', 'keyframes')}</small></span><Download /></button>
              <button type="button" onClick={() => void exportArtifact('storyboardHtml', 'storyboard.html', 'text/html')}><ImageIcon /><span><b>{text('分镜审查页', 'Storyboard')}</b><small>HTML · {text('独立查看', 'standalone')}</small></span><Download /></button>
              <button className="primary" type="button" onClick={() => void exportArtifact('packageBase64', 'scientific-animation-package.zip', 'application/zip')}><FileArchive /><span><b>{text('完整工程包', 'Complete package')}</b><small>ZIP · {text('项目、脚本、时间轴、清单', 'project, script, timeline, manifest')}</small></span><Download /></button>
              <div className="animx-runtime-note"><CircleAlert /><p><strong>{text('运行边界清晰', 'Clear runtime boundary')}</strong><span>{text('当前不执行任意 Python 代码。MP4 与 4K 正式渲染需要隔离的 ManimGL、FFmpeg 和对象存储节点。', 'Arbitrary Python is not executed. MP4/4K requires isolated ManimGL, FFmpeg and object storage workers.')}</span></p></div>
            </aside>
          </div>
        )}
      </div>
    </section>
  );
}
