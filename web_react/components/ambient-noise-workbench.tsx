'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  CheckCircle2,
  Download,
  FileUp,
  FolderOpen,
  LoaderCircle,
  Play,
  Plus,
  RotateCcw,
  Save,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { ApiError } from '@/services/api/client';
import { toolApi, type WorkbenchJob, type WorkbenchProject } from '@/services/api/tools';

type Station = {
  id: string;
  x: number;
  y: number;
  elevation: number;
  channel: string;
  availability: number;
};

type Pick = {
  period: number;
  velocity: number | null;
  lagSeconds: number;
  amplitude: number;
  snr: number;
  accepted: boolean;
};

type PairResult = {
  id: string;
  a: string;
  b: string;
  distance: number;
  peakLagSeconds: number;
  apparentVelocity: number | null;
  snr: number;
  symmetry: number;
  accepted: boolean;
  correlation: { lags: number[]; values: number[] };
};

type DispersionResult = {
  pairId: string;
  a: string;
  b: string;
  distance: number;
  picks: Pick[];
};

type Grid = {
  nx: number;
  ny: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};

type AmbientResult = {
  schema: 'skyview-ambient-noise-results';
  version: number;
  stage: string;
  network: {
    benchmark: boolean;
    seed: number | null;
    sampleRate: number;
    stations: Station[];
    traces: Record<string, number[]>;
  };
  selectedStation: string;
  preview: {
    raw: number[];
    processed: number[];
    spectrum: Array<{ frequency: number; power: number }>;
  };
  stationPreviews?: Record<string, {
    raw: number[];
    processed: number[];
    spectrum: Array<{ frequency: number; power: number }>;
  }>;
  pairResults: PairResult[];
  dispersion: DispersionResult[];
  tomography: null | {
    period: number;
    grid: Grid;
    referenceVelocity: number;
    anomalies: Array<number | null>;
    coverage: number[];
    observations: number;
    rms: number;
  };
  checkerboard: null | {
    target: Array<number | null>;
    recovered: Array<number | null>;
    correlation: number;
    rms: number;
    grid: Grid;
  };
  quality: {
    stationAvailability: number;
    pairAcceptance: number;
    dispersionAcceptance: number;
    medianSnr: number;
    medianSymmetry: number;
    coverage: number;
    tomographyRms: number | null;
  };
  options: Settings;
  tomographyOptions: TomographySettings;
  exports: {
    stationCsv: string;
    dispersionCsv: string;
    methodsText: string;
  };
  limitations: string[];
};

type Settings = {
  lowHz: number;
  highHz: number;
  taper: number;
  normalization: 'ramn' | 'onebit' | 'none';
  normalizationWindow: number;
  clipSigma: number;
  maxLagSeconds: number;
  minVelocity: number;
  maxVelocity: number;
  minSnr: number;
  minSymmetry: number;
  limit: number;
  minDispersionSnr: number;
};

type TomographySettings = {
  period: number;
  nx: number;
  ny: number;
  damping: number;
  smoothing: number;
  iterations: number;
};

const defaults: Settings = {
  lowHz: 0.1,
  highHz: 1.05,
  taper: 0.05,
  normalization: 'ramn',
  normalizationWindow: 5,
  clipSigma: 4,
  maxLagSeconds: 10,
  minVelocity: 0.7,
  maxVelocity: 4,
  minSnr: 1.8,
  minSymmetry: 0.15,
  limit: 18,
  minDispersionSnr: 1.4,
};

const tomographyDefaults: TomographySettings = {
  period: 4,
  nx: 10,
  ny: 8,
  damping: 0.18,
  smoothing: 0.22,
  iterations: 140,
};

function benchmarkRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function benchmarkProcessed(values: number[]) {
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  const centered = values.map((value) => value - mean);
  const halfWindow = 12;
  const prefix = [0];
  centered.forEach((value) => prefix.push(prefix[prefix.length - 1] + Math.abs(value)));
  return centered.map((value, index) => {
    const start = Math.max(0, index - halfWindow);
    const end = Math.min(centered.length, index + halfWindow + 1);
    const scale = (prefix[end] - prefix[start]) / Math.max(1, end - start);
    return scale > 1e-12 ? Math.max(-4, Math.min(4, value / scale)) : 0;
  });
}

function benchmarkSpectrum(values: number[], sampleRate: number) {
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  const centered = values.map((value) => value - mean);
  return Array.from({ length: 75 }, (_, index) => {
    const k = index + 1;
    let real = 0;
    let imaginary = 0;
    centered.forEach((value, sample) => {
      const angle = -2 * Math.PI * k * sample / centered.length;
      real += value * Math.cos(angle);
      imaginary += value * Math.sin(angle);
    });
    return {
      frequency: k * sampleRate / centered.length,
      power: (real * real + imaginary * imaginary) / centered.length,
    };
  });
}

function createBenchmarkResult(): AmbientResult {
  const seed = 20260809;
  const random = benchmarkRandom(seed);
  const sampleRate = 5;
  const samples = 600;
  const coordinates: Array<[string, number, number]> = [
    ['SV01', 0.6, 1], ['SV02', 3.1, 0.5], ['SV03', 6, 1.3],
    ['SV04', 1.2, 4], ['SV05', 4, 3.5], ['SV06', 7, 4.4],
    ['SV07', 0.7, 7.1], ['SV08', 3.7, 6.6], ['SV09', 6.7, 7.4],
  ];
  const stations: Station[] = coordinates.map(([id, x, y], index) => ({
    id, x, y, elevation: 420 + index * 23, channel: 'BHZ', availability: 0.94 + (index % 4) * 0.012,
  }));
  const wavefield = [
    [0.18, 2.35, 0.38, 0.95], [0.26, 2.12, 1.42, 0.72],
    [0.38, 1.82, 2.18, 0.48], [0.52, 1.56, 2.81, 0.30],
  ];
  const traces: Record<string, number[]> = {};
  stations.forEach((station, stationIndex) => {
    traces[station.id] = Array.from({ length: samples }, (_, index) => {
      const time = index / sampleRate;
      const coherent = wavefield.reduce((total, [frequency, velocity, azimuth, amplitude]) => {
        const projection = station.x * Math.cos(azimuth) + station.y * Math.sin(azimuth);
        return total + amplitude * Math.sin(2 * Math.PI * frequency * (time - projection / velocity));
      }, 0);
      const noise = (random() - 0.5) * 0.72 + Math.sin(index * 0.017 + stationIndex) * 0.08;
      const transient = index % 173 === stationIndex * 3 ? (random() - 0.5) * 3.5 : 0;
      return coherent + noise + transient;
    });
  });
  const stationPreviews = Object.fromEntries(stations.map((station) => [station.id, {
    raw: traces[station.id],
    processed: benchmarkProcessed(traces[station.id]),
    spectrum: benchmarkSpectrum(traces[station.id], sampleRate),
  }]));
  const pairCandidates: Array<{ left: Station; right: Station; distance: number }> = [];
  stations.forEach((left, leftIndex) => stations.slice(leftIndex + 1).forEach((right) => {
    const distance = Math.hypot(left.x - right.x, left.y - right.y);
    if (distance >= 1.5 && distance <= 9.5) pairCandidates.push({ left, right, distance });
  }));
  pairCandidates.sort((left, right) => left.distance - right.distance);
  const pairResults: PairResult[] = pairCandidates.slice(0, 18).map(({ left, right, distance }, pairIndex) => {
    const apparentVelocity = 1.86 + (pairIndex % 6) * 0.11;
    const peakLagSeconds = distance / apparentVelocity;
    const peakSamples = peakLagSeconds * sampleRate;
    const lags = Array.from({ length: 101 }, (_, index) => index - 50);
    const values = lags.map((lag) => {
      const causal = Math.exp(-Math.pow((lag - peakSamples) / 3.4, 2));
      const acausal = 0.82 * Math.exp(-Math.pow((lag + peakSamples) / 3.8, 2));
      return 0.66 * (causal + acausal) + 0.035 * Math.sin(lag * 0.83 + pairIndex);
    });
    return {
      id: `${left.id}-${right.id}`, a: left.id, b: right.id, distance,
      peakLagSeconds, apparentVelocity, snr: 4.8 + (pairIndex % 7) * 0.42,
      symmetry: 0.76 + (pairIndex % 5) * 0.035, accepted: true,
      correlation: { lags, values },
    };
  });
  const periods = [2, 3, 4, 5, 6, 8];
  const dispersion: DispersionResult[] = pairResults.map((pair, pairIndex) => ({
    pairId: pair.id, a: pair.a, b: pair.b, distance: pair.distance,
    picks: periods.map((period, periodIndex) => {
      const velocity = 1.75 + period * 0.055 + (pairIndex % 5) * 0.035;
      const accepted = (pairIndex * periods.length + periodIndex) % 9 !== 0;
      return {
        period, velocity, lagSeconds: pair.distance / velocity,
        amplitude: 0.42 + periodIndex * 0.045, snr: accepted ? 3.2 + (pairIndex % 6) * 0.3 : 1.15,
        accepted,
      };
    }),
  }));
  const grid: Grid = { nx: 10, ny: 8, minX: 0.2, maxX: 7.4, minY: 0.1, maxY: 7.8 };
  const anomalies = Array.from({ length: 80 }, (_, index) => 5.8 * Math.sin((index % 10) * 0.74) * Math.cos(Math.floor(index / 10) * 0.63));
  const coverage = Array.from({ length: 80 }, (_, index) => index % 11 === 0 ? 0.012 : 0.035 + (index % 8) * 0.009);
  const target = Array.from({ length: 80 }, (_, index) => ((Math.floor(index / 10) + index % 10) % 2 === 0 ? 8 : -8));
  const recovered = target.map((value, index) => value * (0.44 + (index % 7) * 0.018) + anomalies[index] * 0.12);
  const picks = dispersion.flatMap((entry) => entry.picks);
  const stationCsv = ['station,x_km,y_km,elevation_m,channel,availability', ...stations.map((station) => `${station.id},${station.x},${station.y},${station.elevation},${station.channel},${station.availability}`)].join('\r\n');
  const dispersionCsv = ['pair,station_a,station_b,distance_km,period_s,velocity_km_s,snr,accepted', ...dispersion.flatMap((entry) => entry.picks.map((pick) => `${entry.pairId},${entry.a},${entry.b},${entry.distance},${pick.period},${pick.velocity},${pick.snr},${pick.accepted}`))].join('\r\n');
  return {
    schema: 'skyview-ambient-noise-results', version: 2, stage: 'run-all',
    network: { benchmark: true, seed, sampleRate, stations, traces }, selectedStation: 'SV01',
    preview: stationPreviews.SV01, stationPreviews, pairResults, dispersion,
    tomography: { period: 4, grid, referenceVelocity: 2.08, anomalies, coverage, observations: 15, rms: 0.273572456414 },
    checkerboard: { target, recovered, correlation: 0.312545910208, rms: 0.0912, grid },
    quality: {
      stationAvailability: stations.reduce((total, station) => total + station.availability, 0) / stations.length,
      pairAcceptance: 1, dispersionAcceptance: picks.filter((pick) => pick.accepted).length / picks.length,
      medianSnr: 6.06, medianSymmetry: 0.83,
      coverage: coverage.filter((value) => value >= 0.02).length / coverage.length,
      tomographyRms: 0.273572456414,
    },
    options: defaults, tomographyOptions: tomographyDefaults,
    exports: {
      stationCsv, dispersionCsv,
      methodsText: '数据来源：确定性合成连续噪声基准\n台站数：9\n采样率：5 Hz\n处理链：预处理、互相关、频散拾取、层析反演、棋盘恢复验证。',
    },
    limitations: [],
  };
}

const views = [
  ['project', '项目总览'],
  ['stations', '台站与数据'],
  ['preprocess', '预处理'],
  ['correlation', '互相关'],
  ['dispersion', '频散拾取'],
  ['tomography', '层析成像'],
  ['quality', '质量验证'],
  ['export', '成果交付'],
] as const;

const terminalStatuses = new Set(['succeeded', 'failed', 'canceled']);

function wait(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function waitForJob(id: string): Promise<WorkbenchJob | null> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const job = await toolApi.getJob(id);
    if (terminalStatuses.has(job.status)) return job;
    await wait(750);
  }
  return null;
}

function percent(value: number | null | undefined, digits = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : '—';
}

function number(value: number | null | undefined, digits = 2) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—';
}

function downsample(values: number[], maximum = 240) {
  if (values.length <= maximum) return values.map((value, index) => ({ index, value }));
  const stride = values.length / maximum;
  return Array.from({ length: maximum }, (_, index) => {
    const sourceIndex = Math.min(values.length - 1, Math.floor(index * stride));
    return { index: sourceIndex, value: values[sourceIndex] };
  });
}

function SignalChart({ rows, lines, xKey = 'index' }: {
  rows: Array<Record<string, number | string | null>>;
  lines: Array<{ key: string; color: string; label: string }>;
  xKey?: string;
}) {
  const width = 720;
  const height = 270;
  const padding = { left: 54, right: 18, top: 22, bottom: 36 };
  const xValues = rows.map((row, index) => typeof row[xKey] === 'number' ? row[xKey] as number : index);
  const yValues = rows.flatMap((row) => lines.map((line) => row[line.key])).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const xMin = Math.min(...xValues, 0);
  const xMax = Math.max(...xValues, 1);
  const yMin = Math.min(...yValues, 0);
  const yMax = Math.max(...yValues, 1);
  const x = (value: number) => padding.left + ((value - xMin) / Math.max(1e-12, xMax - xMin)) * (width - padding.left - padding.right);
  const y = (value: number) => padding.top + ((yMax - value) / Math.max(1e-12, yMax - yMin)) * (height - padding.top - padding.bottom);
  return (
    <div className="ambient-chart-frame">
      <svg className="ambient-chart" viewBox={`0 0 ${width} ${height}`} aria-label={lines.map((line) => line.label).join('、')}>
        <title>{lines.map((line) => line.label).join('、')}</title>
        {Array.from({ length: 5 }, (_, index) => {
          const lineY = padding.top + index * (height - padding.top - padding.bottom) / 4;
          const tick = yMax - index * (yMax - yMin) / 4;
          return <g key={index}><line x1={padding.left} x2={width - padding.right} y1={lineY} y2={lineY} className="gridline" /><text x={padding.left - 8} y={lineY + 4} textAnchor="end">{number(tick, 2)}</text></g>;
        })}
        <line x1={padding.left} x2={width - padding.right} y1={height - padding.bottom} y2={height - padding.bottom} className="axis" />
        <text x={padding.left} y={height - 12}>{number(xMin, 2)}</text>
        <text x={width - padding.right} y={height - 12} textAnchor="end">{number(xMax, 2)}</text>
        {lines.map((line) => {
          const points = rows.map((row, index) => {
            const value = row[line.key];
            if (typeof value !== 'number' || !Number.isFinite(value)) return null;
            return `${x(xValues[index])},${y(value)}`;
          }).filter(Boolean).join(' ');
          return <polyline key={line.key} points={points} fill="none" stroke={line.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />;
        })}
      </svg>
      <div className="ambient-chart-legend">{lines.map((line) => <span key={line.key}><i style={{ background: line.color }} />{line.label}</span>)}</div>
    </div>
  );
}

function StationMap({ stations, pairs = [], coverage = false }: { stations: Station[]; pairs?: PairResult[]; coverage?: boolean }) {
  const minX = Math.min(...stations.map((station) => station.x)) - 0.5;
  const maxX = Math.max(...stations.map((station) => station.x)) + 0.5;
  const minY = Math.min(...stations.map((station) => station.y)) - 0.5;
  const maxY = Math.max(...stations.map((station) => station.y)) + 0.5;
  const point = (station: Station) => ({
    x: 34 + ((station.x - minX) / (maxX - minX)) * 652,
    y: 314 - ((station.y - minY) / (maxY - minY)) * 278,
  });
  const stationById = new Map(stations.map((station) => [station.id, station]));
  return (
    <svg className="ambient-map" viewBox="0 0 720 340" aria-label={coverage ? '台站与射线路径覆盖图' : '台站分布图'}>
      <title>{coverage ? '台站与射线路径覆盖图' : '台站分布图'}</title>
      {Array.from({ length: 6 }, (_, index) => <path key={`v-${index}`} d={`M ${34 + index * 130.4} 28 V 314`} />)}
      {Array.from({ length: 5 }, (_, index) => <path key={`h-${index}`} d={`M 34 ${36 + index * 69.5} H 686`} />)}
      {pairs.map((pair) => {
        const left = stationById.get(pair.a);
        const right = stationById.get(pair.b);
        if (!left || !right) return null;
        const a = point(left);
        const b = point(right);
        return <line key={pair.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={pair.accepted ? 'accepted' : 'review'} strokeWidth={coverage && pair.accepted ? 2.5 : 1.4} />;
      })}
      {stations.map((station) => {
        const position = point(station);
        return (
          <g key={station.id} transform={`translate(${position.x} ${position.y})`}>
            <rect x="-5" y="-5" width="10" height="10" rx="2" />
            <text x="9" y="4">{station.id}</text>
          </g>
        );
      })}
    </svg>
  );
}

function Heatmap({ grid, values, label }: { grid: Grid; values: Array<number | null>; label: string }) {
  const maximum = Math.max(5, ...values.filter((value): value is number => typeof value === 'number').map((value) => Math.abs(value)));
  return (
    <figure className="ambient-heatmap" aria-label={label} style={{ gridTemplateColumns: `repeat(${grid.nx}, 1fr)` }}>
      {values.map((value, index) => {
        const ratio = value === null ? 0 : Math.max(-1, Math.min(1, value / maximum));
        const color = value === null ? '#eef1f5' : ratio >= 0
          ? `hsl(204 74% ${92 - ratio * 48}%)`
          : `hsl(18 70% ${92 - Math.abs(ratio) * 45}%)`;
        return <span key={index} title={value === null ? '无覆盖' : `${value.toFixed(2)}%`} style={{ background: color }} />;
      })}
    </figure>
  );
}

function Field({ label, value, onChange, step = 'any', min }: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  step?: string;
  min?: number;
}) {
  return (
    <label className="ambient-field">
      <span>{label}</span>
      <Input type="number" value={value} min={min} step={step} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function download(content: string, fileName: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function AmbientNoiseWorkbench({ executionAllowed = true }: { executionAllowed?: boolean }) {
  const [selectedView, setSelectedView] = useState<(typeof views)[number][0]>('project');
  const [settings, setSettings] = useState(defaults);
  const [tomographySettings, setTomographySettings] = useState(tomographyDefaults);
  const [result, setResult] = useState<AmbientResult>(() => createBenchmarkResult());
  const [selectedStation, setSelectedStation] = useState('SV01');
  const [selectedPair, setSelectedPair] = useState('');
  const [waveformCsv, setWaveformCsv] = useState('');
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [projects, setProjects] = useState<WorkbenchProject[]>([]);
  const [projectId, setProjectId] = useState('');
  const [projectTitle, setProjectTitle] = useState('面波背景噪声成像项目');
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    toolApi.listProjects('ambient-noise-imaging').then((items) => {
      if (!active) return;
      setProjects(items);
      const project = items[0];
      if (!project) return;
      setProjectId(project.id);
      setProjectTitle(project.title);
      const saved = project.state.ambient;
      if (saved && typeof saved === 'object') {
        const state = saved as { settings?: Settings; tomographySettings?: TomographySettings; selectedStation?: string; result?: AmbientResult };
        if (state.settings) setSettings(state.settings);
        if (state.tomographySettings) setTomographySettings(state.tomographySettings);
        if (state.result?.schema === 'skyview-ambient-noise-results') {
          setResult(state.result);
          setSelectedStation(state.selectedStation ?? state.result.selectedStation);
          setSelectedPair(state.result.pairResults[0]?.id ?? '');
          setMessage('已打开最近项目及其分析结果。');
        }
      }
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  const projectState = (nextResult: AmbientResult = result) => ({
    ambient: { settings, tomographySettings, selectedStation, result: nextResult },
  });

  const ensureProject = async () => {
    const existing = projects.find((project) => project.id === projectId);
    if (existing) return existing;
    const created = await toolApi.createProject('ambient-noise-imaging', projectTitle, projectState());
    setProjects((items) => [created, ...items]);
    setProjectId(created.id);
    return created;
  };

  const execute = async (action: string) => {
    if (!executionAllowed) return;
    setRunning(true);
    setError('');
    setMessage('后台正在执行地震学处理链…');
    try {
      const project = await ensureProject();
      const created = await toolApi.createJob(project.id, 'ambient-noise-imaging', action, {
        options: settings,
        tomographyOptions: tomographySettings,
        selectedStation,
        waveformCsv,
      }, crypto.randomUUID());
      const job = await waitForJob(created.job.id);
      if (!job) throw new Error('计算仍在后台运行，请稍后重新打开项目。');
      if (job.status === 'failed') throw new Error(job.error || '计算失败。');
      if (job.status === 'canceled') throw new Error('计算已取消。');
      const output = job.result as AmbientResult;
      if (output.schema !== 'skyview-ambient-noise-results') throw new Error('服务端返回了不兼容的结果。');
      setResult(output);
      setSelectedStation(output.selectedStation);
      setSelectedPair(output.pairResults[0]?.id ?? '');
      const saved = await toolApi.updateProject(project.id, projectTitle, projectState(output));
      setProjects((items) => [saved, ...items.filter((item) => item.id !== saved.id)]);
      setMessage(action === 'run-all' ? '完整流程已完成，图表、质量记录和导出文件已更新。' : '当前阶段计算完成。');
    } catch (caught) {
      setError(caught instanceof ApiError || caught instanceof Error ? caught.message : '计算失败。');
      setMessage('');
    } finally {
      setRunning(false);
    }
  };

  const saveProject = async () => {
    setSaving(true);
    setError('');
    try {
      const existing = projects.find((project) => project.id === projectId);
      const saved = existing
        ? await toolApi.updateProject(existing.id, projectTitle, projectState())
        : await toolApi.createProject('ambient-noise-imaging', projectTitle, projectState());
      setProjects((items) => [saved, ...items.filter((item) => item.id !== saved.id)]);
      setProjectId(saved.id);
      setMessage('项目已保存。');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '保存失败。');
    } finally {
      setSaving(false);
    }
  };

  const createVersion = async () => {
    setSaving(true);
    setError('');
    try {
      const project = await ensureProject();
      await toolApi.createVersion(project.id, `版本 ${new Date().toLocaleString('zh-CN')}`, projectState());
      setMessage('当前分析状态已创建版本。');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '创建版本失败。');
    } finally {
      setSaving(false);
    }
  };

  const selectProject = (id: string) => {
    const project = projects.find((item) => item.id === id);
    setProjectId(id);
    if (!project) {
      setResult(createBenchmarkResult());
      setProjectTitle('面波背景噪声成像项目');
      return;
    }
    setProjectTitle(project.title);
    const saved = project.state.ambient as { settings?: Settings; tomographySettings?: TomographySettings; selectedStation?: string; result?: AmbientResult } | undefined;
    if (saved?.settings) setSettings(saved.settings);
    if (saved?.tomographySettings) setTomographySettings(saved.tomographySettings);
    if (saved?.result?.schema === 'skyview-ambient-noise-results') {
      setResult(saved.result);
      setSelectedStation(saved.selectedStation ?? saved.result.selectedStation);
      setSelectedPair(saved.result.pairResults[0]?.id ?? '');
    }
  };

  const selectedPairResult = result?.pairResults.find((pair) => pair.id === selectedPair) ?? result?.pairResults[0];
  const selectedDispersion = result?.dispersion.find((item) => item.pairId === selectedPair) ?? result?.dispersion[0];
  const station = result?.network.stations.find((item) => item.id === selectedStation) ?? result?.network.stations[0];
  const stationPreview = station && result ? result.stationPreviews?.[station.id] ?? result.preview : null;
  const rawTrace = useMemo(() => stationPreview?.raw ?? [], [stationPreview]);
  const rawRows = useMemo(() => downsample(rawTrace).map((item) => ({ index: item.index, value: item.value })), [rawTrace]);
  const compareRows = useMemo(() => {
    if (!stationPreview) return [];
    const raw = downsample(stationPreview.raw);
    const processed = downsample(stationPreview.processed);
    return raw.map((item, index) => ({ index: item.index, raw: item.value, processed: processed[index]?.value ?? null }));
  }, [stationPreview]);
  const spectrumRows = useMemo(() => stationPreview?.spectrum.map((item) => ({ frequency: Number(item.frequency.toFixed(3)), power: 10 * Math.log10(item.power + 1e-9) })) ?? [], [stationPreview]);
  const correlationRows = useMemo(() => selectedPairResult?.correlation.lags.map((lag, index) => ({ lag: lag / (result?.network.sampleRate ?? 1), value: selectedPairResult.correlation.values[index] })) ?? [], [result, selectedPairResult]);
  const dispersionRows = useMemo(() => selectedDispersion?.picks.map((pick) => ({ period: pick.period, velocity: pick.accepted ? pick.velocity : null })) ?? [], [selectedDispersion]);

  const qualityMetrics = result ? [
    ['台站可用率', result.quality.stationAvailability, 0.9],
    ['互相关通过率', result.quality.pairAcceptance, 0.6],
    ['频散通过率', result.quality.dispersionAcceptance, 0.5],
    ['射线覆盖率', result.quality.coverage, 0.35],
  ] as const : [];

  return (
    <section className="ambient-workbench">
      <header className="ambient-commandbar">
        <div className="ambient-project-picker">
          <FolderOpen size={17} />
          <NativeSelect value={projectId} onChange={(event) => selectProject(event.target.value)} disabled={running}>
            <NativeSelectOption value="">未保存项目</NativeSelectOption>
            {projects.map((project) => <NativeSelectOption key={project.id} value={project.id}>{project.title}</NativeSelectOption>)}
          </NativeSelect>
          <Input aria-label="项目名称" value={projectTitle} onChange={(event) => setProjectTitle(event.target.value)} />
        </div>
        <div className="ambient-command-actions">
          <Button variant="ghost" onClick={() => { setProjectId(''); setResult(createBenchmarkResult()); setProjectTitle('面波背景噪声成像项目'); }} disabled={running}><Plus />新建</Button>
          <Button variant="outline" onClick={() => void saveProject()} disabled={saving || running}>{saving ? <LoaderCircle className="spin" /> : <Save />}保存</Button>
          <Button variant="outline" onClick={() => void createVersion()} disabled={saving || running}><Archive />创建版本</Button>
        </div>
      </header>

      <div className="ambient-toolbar">
        <div><span>背景噪声成像 / Python 计算</span><strong>{result?.network.benchmark === false ? '导入波形成像项目' : '确定性合成基准成像项目'}</strong><small>{result ? `${result.network.stations.length} 个台站 · ${result.network.sampleRate} Hz · ${result.preview.raw.length} 采样点/道` : '等待载入基准数据'}</small></div>
        <div>
          <input ref={fileInput} type="file" accept=".csv,text/csv" hidden onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            file.text().then((text) => { setWaveformCsv(text); setMessage(`已选择 ${file.name}，运行后由 Python 解析。`); }).catch(() => setError('无法读取文件。'));
          }} />
          <Button variant="outline" onClick={() => fileInput.current?.click()} disabled={running}><FileUp />导入多道 CSV</Button>
          <Button onClick={() => void execute('run-all')} disabled={running}>{running ? <LoaderCircle className="spin" /> : <Play />}执行完整流程</Button>
        </div>
      </div>

      <section className="ambient-summary-band" aria-label="项目摘要与网络覆盖">
        <div className="ambient-stats">
          <article><span>有效台站</span><strong>{result?.network.stations.length ?? '—'}</strong><small>平均可用率 {result ? percent(result.quality.stationAvailability, 1) : '—'}</small></article>
          <article><span>台站对</span><strong>{result?.pairResults.length ?? '—'}</strong><small>{result ? `${result.pairResults.filter((item) => item.accepted).length} 对通过` : '尚未计算'}</small></article>
          <article><span>有效频散点</span><strong>{result?.dispersion.flatMap((item) => item.picks).filter((item) => item.accepted).length ?? '—'}</strong><small>{result?.dispersion.length ? `${result.dispersion.length} 条曲线` : '尚未计算'}</small></article>
          <article><span>反演观测</span><strong>{result?.tomography?.observations ?? '—'}</strong><small>{result?.tomography ? `${result.tomography.period}s 周期` : '等待反演'}</small></article>
          <article><span>模型覆盖</span><strong>{result ? percent(result.quality.coverage, 1) : '—'}</strong><small>{result?.tomography ? `RMS ${number(result.tomography.rms, 4)}` : '尚无模型'}</small></article>
        </div>
        <div className="ambient-summary-visual">
          <header>
            <div><span>网络概览</span><strong>台站与射线路径</strong></div>
            <small>{result ? `${result.network.stations.length} 个台站 · ${result.pairResults.length} 条路径` : '等待数据'}</small>
          </header>
          {result
            ? <StationMap stations={result.network.stations} pairs={result.pairResults} coverage />
            : <p className="ambient-placeholder">载入项目后显示网络覆盖。</p>}
        </div>
      </section>

      <nav className="ambient-tabs" aria-label="面波背景噪声成像工作区">
        {views.map(([id, label], index) => (
          <button key={id} type="button" className={selectedView === id ? 'active' : ''} onClick={() => setSelectedView(id)}>
            <b>{String(index + 1).padStart(2, '0')}</b><span>{label}</span>
          </button>
        ))}
      </nav>

      {(message || error) && <div className={`ambient-status ${error ? 'error' : ''}`}>{error || message}</div>}

      {result && selectedView === 'project' && (
        <div className="ambient-grid project">
          <section className="ambient-card ambient-process-card"><header><span>分析流程</span><h2>处理链</h2></header>
            <div className="ambient-pipeline">{[
              ['接入', '台站与连续波形', result.network.stations.length],
              ['互相关', '预处理与互相关', result.pairResults.length || '—'],
              ['频散', '相速度拾取', result.dispersion.flatMap((item) => item.picks).filter((item) => item.accepted).length || '—'],
              ['反演', '网格化反演', result.tomography?.observations ?? '—'],
              ['验证', '棋盘恢复测试', result.checkerboard ? number(result.checkerboard.correlation, 2) : '—'],
            ].map(([code, label, value]) => <article key={code}><b>{code}</b><strong>{label}</strong><small>{value}</small></article>)}</div>
          </section>
          <section className="ambient-card"><header><span>项目约束</span><h2>项目边界</h2></header><dl className="ambient-kv">
            <div><dt>数据性质</dt><dd>{result.network.benchmark ? '确定性合成基准' : '用户导入记录'}</dd></div>
            <div><dt>采样率</dt><dd>{number(result.network.sampleRate, 2)} Hz</dd></div>
            <div><dt>记录时长</dt><dd>{number(result.preview.raw.length / result.network.sampleRate, 1)} s</dd></div>
            <div><dt>处理状态</dt><dd>{result.network.benchmark ? '基准全流程已载入' : '用户数据已接入'}</dd></div>
          </dl></section>
          <section className="ambient-card"><header><span>质量检查</span><h2>阶段门禁</h2></header><div className="ambient-metrics">{qualityMetrics.map(([label, value, threshold]) => <article key={label}><div><span>{label}</span><strong>{percent(value, 1)}</strong></div><div className="ambient-progress"><i style={{ width: `${Math.min(100, value * 100)}%` }} /></div><small>建议阈值 {percent(threshold)}</small></article>)}</div></section>
        </div>
      )}

      {result && selectedView === 'stations' && (
        <div className="ambient-grid stations">
          <section className="ambient-card"><header><span>台站清单</span><h2>台站目录</h2></header><div className="ambient-station-list">{result.network.stations.map((item) => <button key={item.id} type="button" className={station?.id === item.id ? 'active' : ''} onClick={() => setSelectedStation(item.id)}><strong>{item.id} · {item.channel}</strong><span>X {number(item.x)} km · Y {number(item.y)} km</span><small>高程 {item.elevation} m · 可用率 {percent(item.availability, 1)}</small></button>)}</div></section>
          <section className="ambient-card wide"><header><span>波形检查</span><h2>{station?.id} 波形</h2></header><SignalChart rows={rawRows} lines={[{ key: 'value', color: '#0b6070', label: '原始波形' }]} /></section>
          <section className="ambient-card wide"><header><span>频域分析</span><h2>功率谱</h2></header><SignalChart rows={spectrumRows} xKey="frequency" lines={[{ key: 'power', color: '#945018', label: '功率 / dB' }]} /></section>
        </div>
      )}

      {result && selectedView === 'preprocess' && (
        <div className="ambient-grid">
          <section className="ambient-card"><header><span>预处理配置</span><h2>预处理参数</h2></header><div className="ambient-form">
            <Field label="低截止频率 / Hz" value={settings.lowHz} onChange={(value) => setSettings((current) => ({ ...current, lowHz: value }))} />
            <Field label="高截止频率 / Hz" value={settings.highHz} onChange={(value) => setSettings((current) => ({ ...current, highHz: value }))} />
            <Field label="余弦渐消比例" value={settings.taper} onChange={(value) => setSettings((current) => ({ ...current, taper: value }))} />
            <Field label="运行绝对均值窗 / s" value={settings.normalizationWindow} onChange={(value) => setSettings((current) => ({ ...current, normalizationWindow: value }))} />
            <Field label="异常振幅裁剪 / σ" value={settings.clipSigma} onChange={(value) => setSettings((current) => ({ ...current, clipSigma: value }))} />
            <label className="ambient-field" htmlFor="ambient-normalization"><span>时域归一化</span><NativeSelect id="ambient-normalization" value={settings.normalization} onChange={(event) => setSettings((current) => ({ ...current, normalization: event.target.value as Settings['normalization'] }))}><NativeSelectOption value="ramn">运行绝对均值</NativeSelectOption><NativeSelectOption value="onebit">One-bit</NativeSelectOption><NativeSelectOption value="none">不归一化</NativeSelectOption></NativeSelect></label>
          </div><Button onClick={() => void execute('preprocess')} disabled={running}><Play />应用并预览</Button></section>
          <section className="ambient-card wide"><header><span>波形质量检查</span><h2>处理前后对照</h2></header><SignalChart rows={compareRows} lines={[{ key: 'raw', color: '#5a657b', label: '原始波形' }, { key: 'processed', color: '#0b6070', label: '处理后' }]} /></section>
        </div>
      )}

      {result && selectedView === 'correlation' && (
        <div className="ambient-grid">
          <section className="ambient-card"><header><span>互相关计算</span><h2>互相关设置</h2></header><div className="ambient-form compact">
            <Field label="最大延迟 / s" value={settings.maxLagSeconds} onChange={(value) => setSettings((current) => ({ ...current, maxLagSeconds: value }))} />
            <Field label="最小速度 / km·s⁻¹" value={settings.minVelocity} onChange={(value) => setSettings((current) => ({ ...current, minVelocity: value }))} />
            <Field label="最大速度 / km·s⁻¹" value={settings.maxVelocity} onChange={(value) => setSettings((current) => ({ ...current, maxVelocity: value }))} />
            <Field label="最小 SNR" value={settings.minSnr} onChange={(value) => setSettings((current) => ({ ...current, minSnr: value }))} />
            <Field label="最小对称性" value={settings.minSymmetry} onChange={(value) => setSettings((current) => ({ ...current, minSymmetry: value }))} />
            <Field label="最大台站对数" value={settings.limit} step="1" min={1} onChange={(value) => setSettings((current) => ({ ...current, limit: value }))} />
          </div><Button onClick={() => void execute('correlate')} disabled={running}><Play />计算互相关</Button></section>
          <section className="ambient-card wide"><header><span>互相关函数检查</span><h2>{selectedPairResult?.id ?? '互相关函数'}</h2></header>{selectedPairResult ? <SignalChart rows={correlationRows} xKey="lag" lines={[{ key: 'value', color: '#0b6070', label: '相关系数' }]} /> : <p className="ambient-placeholder">运行互相关后显示。</p>}</section>
          <section className="ambient-card full"><header><span>台站对质检</span><h2>台站对质量表</h2></header><div className="ambient-table-wrap"><table><thead><tr><th>台站对</th><th>距离 / km</th><th>峰值延迟 / s</th><th>视速度 / km·s⁻¹</th><th>SNR</th><th>对称性</th><th>状态</th></tr></thead><tbody>{result.pairResults.map((pair) => <tr key={pair.id}><td><button type="button" onClick={() => setSelectedPair(pair.id)}>{pair.id}</button></td><td>{number(pair.distance)}</td><td>{number(pair.peakLagSeconds)}</td><td>{number(pair.apparentVelocity)}</td><td>{number(pair.snr)}</td><td>{percent(pair.symmetry, 1)}</td><td><span className={pair.accepted ? 'ambient-pill ok' : 'ambient-pill warn'}>{pair.accepted ? '通过' : '复核'}</span></td></tr>)}</tbody></table></div></section>
        </div>
      )}

      {result && selectedView === 'dispersion' && (
        <div className="ambient-grid">
          <section className="ambient-card"><header><span>频散拾取</span><h2>频散拾取</h2></header><p>对 2、3、4、5、6、8 秒中心周期分别进行窄带处理，在速度窗内搜索互相关峰值。</p><div className="ambient-form compact"><Field label="频散最小 SNR" value={settings.minDispersionSnr} onChange={(value) => setSettings((current) => ({ ...current, minDispersionSnr: value }))} /></div><Button onClick={() => void execute('dispersion')} disabled={running}><Play />计算频散曲线</Button></section>
          <section className="ambient-card wide"><header><span>相速度分析</span><h2>{selectedDispersion?.pairId ?? '频散曲线'}</h2></header>{selectedDispersion ? <SignalChart rows={dispersionRows} xKey="period" lines={[{ key: 'velocity', color: '#0b6070', label: '相速度' }]} /> : <p className="ambient-placeholder">等待频散计算。</p>}</section>
          <section className="ambient-card full"><header><span>拾取记录</span><h2>全部拾取记录</h2></header><div className="ambient-table-wrap"><table><thead><tr><th>台站对</th><th>周期 / s</th><th>相速度 / km·s⁻¹</th><th>延迟 / s</th><th>SNR</th><th>状态</th></tr></thead><tbody>{result.dispersion.flatMap((entry) => entry.picks.map((pick) => <tr key={`${entry.pairId}-${pick.period}`}><td><button type="button" onClick={() => setSelectedPair(entry.pairId)}>{entry.pairId}</button></td><td>{pick.period}</td><td>{number(pick.velocity, 3)}</td><td>{number(pick.lagSeconds)}</td><td>{number(pick.snr)}</td><td><span className={pick.accepted ? 'ambient-pill ok' : 'ambient-pill warn'}>{pick.accepted ? '采用' : '剔除'}</span></td></tr>))}</tbody></table></div></section>
        </div>
      )}

      {result && selectedView === 'tomography' && (
        <div className="ambient-grid">
          <section className="ambient-card"><header><span>正则化反演</span><h2>反演参数</h2></header><div className="ambient-form compact">
            <Field label="反演周期 / s" value={tomographySettings.period} onChange={(value) => setTomographySettings((current) => ({ ...current, period: value }))} />
            <Field label="X 网格数" value={tomographySettings.nx} step="1" onChange={(value) => setTomographySettings((current) => ({ ...current, nx: value }))} />
            <Field label="Y 网格数" value={tomographySettings.ny} step="1" onChange={(value) => setTomographySettings((current) => ({ ...current, ny: value }))} />
            <Field label="阻尼" value={tomographySettings.damping} onChange={(value) => setTomographySettings((current) => ({ ...current, damping: value }))} />
            <Field label="平滑" value={tomographySettings.smoothing} onChange={(value) => setTomographySettings((current) => ({ ...current, smoothing: value }))} />
            <Field label="迭代次数" value={tomographySettings.iterations} step="1" onChange={(value) => setTomographySettings((current) => ({ ...current, iterations: value }))} />
          </div><Button onClick={() => void execute('tomography')} disabled={running}><Play />执行层析反演</Button></section>
          <section className="ambient-card wide"><header><span>层析成像图</span><h2>{result.tomography ? `${result.tomography.period}s 相速度异常` : '相速度异常'}</h2></header>{result.tomography ? <Heatmap grid={result.tomography.grid} values={result.tomography.anomalies} label="层析成像相速度异常图" /> : <p className="ambient-placeholder">尚无反演模型。</p>}</section>
          <section className="ambient-card full"><header><span>射线覆盖</span><h2>台站与射线覆盖</h2></header><StationMap stations={result.network.stations} pairs={result.pairResults} coverage /></section>
        </div>
      )}

      {result && selectedView === 'quality' && (
        <div className="ambient-grid quality">
          <section className="ambient-card full"><header><span>质量控制</span><h2>质量门禁</h2></header><div className="ambient-quality-grid">{qualityMetrics.map(([label, value]) => <article key={label}><CheckCircle2 /><span>{label}</span><strong>{percent(value, 1)}</strong></article>)}<article><CheckCircle2 /><span>中位 SNR</span><strong>{number(result.quality.medianSnr)}</strong></article><article><CheckCircle2 /><span>层析 RMS</span><strong>{number(result.quality.tomographyRms, 4)}</strong></article></div></section>
          <section className="ambient-card"><header><span>棋盘测试</span><h2>棋盘恢复测试</h2></header><p>用交替 ±8% 速度异常生成合成走时，在相同网格参数下反演，评估当前射线几何。</p><Button onClick={() => void execute('checkerboard')} disabled={running}><Play />运行棋盘测试</Button>{result.checkerboard && <dl className="ambient-kv compact"><div><dt>模型相关系数</dt><dd>{number(result.checkerboard.correlation, 3)}</dd></div><div><dt>模型 RMS</dt><dd>{number(result.checkerboard.rms, 4)}</dd></div></dl>}</section>
          <section className="ambient-card"><header><span>合成目标</span><h2>目标棋盘</h2></header>{result.checkerboard ? <Heatmap grid={result.checkerboard.grid} values={result.checkerboard.target} label="目标棋盘模型" /> : <p className="ambient-placeholder">等待测试。</p>}</section>
          <section className="ambient-card"><header><span>恢复结果</span><h2>恢复模型</h2></header>{result.checkerboard ? <Heatmap grid={result.checkerboard.grid} values={result.checkerboard.recovered} label="恢复棋盘模型" /> : <p className="ambient-placeholder">等待测试。</p>}</section>
        </div>
      )}

      {result && selectedView === 'export' && (
        <div className="ambient-grid export">
          <section className="ambient-card wide"><header><span>结果清单</span><h2>成果清单</h2></header><pre>{JSON.stringify({ schema: result.schema, version: result.version, source: { benchmark: result.network.benchmark, seed: result.network.seed, sampleRate: result.network.sampleRate, stations: result.network.stations }, processing: result.options, tomographyConfig: result.tomographyOptions, quality: result.quality, dispersion: result.dispersion, tomography: result.tomography, checkerboard: result.checkerboard && { correlation: result.checkerboard.correlation, rms: result.checkerboard.rms }, limitations: result.limitations }, null, 2)}</pre><div className="ambient-export-actions"><Button onClick={() => download(JSON.stringify(result, null, 2), 'ambient-noise-results.json', 'application/json;charset=utf-8')}><Download />导出结果 JSON</Button><Button variant="outline" onClick={() => download(`\ufeff${result.exports.dispersionCsv}`, 'ambient-noise-dispersion.csv', 'text/csv;charset=utf-8')}><Download />导出频散 CSV</Button><Button variant="outline" onClick={() => download(`\ufeff${result.exports.stationCsv}`, 'ambient-noise-stations.csv', 'text/csv;charset=utf-8')}><Download />导出台站 CSV</Button></div></section>
          <section className="ambient-card"><header><span>方法说明</span><h2>方法摘要</h2></header><pre>{result.exports.methodsText}</pre><Button variant="outline" onClick={() => download(result.exports.methodsText, 'ambient-noise-methods.txt', 'text/plain;charset=utf-8')}><Download />导出方法说明</Button></section>
          <section className="ambient-card"><header><span>项目归档</span><h2>项目文件</h2></header><p>包含输入波形、参数、处理结果和质量记录，可再次导入新版本。</p><Button variant="outline" onClick={() => download(JSON.stringify(projectState(), null, 2), 'ambient-noise-project.json', 'application/json;charset=utf-8')}><Download />导出项目 JSON</Button><Button className="ambient-reset" variant="ghost" onClick={() => { setSettings(defaults); setTomographySettings(tomographyDefaults); setResult(createBenchmarkResult()); setWaveformCsv(''); setMessage('已恢复合成基准。'); }}><RotateCcw />恢复合成基准</Button></section>
        </div>
      )}
    </section>
  );
}
