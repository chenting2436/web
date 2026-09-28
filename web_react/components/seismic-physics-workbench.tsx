'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Archive,
  CheckCircle2,
  Download,
  FileUp,
  FolderOpen,
  Gauge,
  LoaderCircle,
  Play,
  Plus,
  RotateCcw,
  Save,
  ShieldCheck,
  Trash2,
  Waves,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { ApiError } from '@/services/api/client';
import { toolApi, type WorkbenchJob, type WorkbenchProject } from '@/services/api/tools';

type SeismicSettings = {
  detrend: 'linear' | 'mean' | 'none';
  taperPercent: number;
  filterMode: 'bandpass' | 'highpass' | 'lowpass' | 'none';
  lowCut: number;
  highCut: number;
  filterOrder: number;
  zeroPhase: boolean;
  notchEnabled: boolean;
  notchFrequency: number;
  notchQ: number;
  sensitivity: number;
  outputUnit: 'counts' | 'm/s²' | 'm/s' | 'm';
  staMethod: 'recursive' | 'classic';
  staSeconds: number;
  ltaSeconds: number;
  triggerOn: number;
  triggerOff: number;
  minDuration: number;
  deadTime: number;
  aicPhase: 'P' | 'S' | 'X';
  aicStart: number;
  aicEnd: number;
  noiseStart: number;
  noiseEnd: number;
  signalStart: number;
  signalEnd: number;
  validationTolerance: number;
};

type PhysicsInputs = {
  pTime: number | string;
  sTime: number | string;
  vp: number;
  vs: number;
  depth: number;
  density: number;
  omega0: number | string;
  radiation: number;
  freeSurface: number;
  waveType: 'P' | 'S';
};

type TraceSummary = {
  id: string;
  network: string;
  station: string;
  location: string;
  channel: string;
  sampleRate: number;
  unit: string;
  startTime: string | null;
  samples: number;
  duration: number;
};

type PhasePick = {
  id: string;
  phase: 'P' | 'S' | 'X';
  time: number;
  traceId: string;
  source: string;
  uncertainty: number;
  status: string;
};

type TriggerEvent = {
  id: string;
  startTime: number;
  endTime: number;
  peakTime: number;
  duration: number;
  characteristicPeak: number;
  amplitudePeak: number;
  decision: string;
};

type Evidence = {
  id: string;
  title: string;
  type: string;
  status: string;
  note: string;
};

type Validation = {
  reference: number;
  predicted: number;
  matched: number;
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
  mae: number | null;
  rmse: number | null;
  bias: number | null;
  tolerance: number;
};

type SeismicResult = {
  schema: 'skyview-seismic-physics-results';
  version: number;
  stage: string;
  project: { name: string; analyst: string; stationNotes: string; eventNotes: string };
  dataset: {
    name: string;
    sourceType: string;
    benchmark: boolean;
    seed: number | null;
    sampleRate: number;
    startTime: string | null;
    traces: TraceSummary[];
  };
  selectedTrace: string;
  preview: {
    sampleRate: number;
    duration: number;
    raw: number[];
    processed: number[];
    envelope: number[];
    characteristic: number[];
  };
  tracePreviews: Record<string, number[]>;
  psd: {
    nperseg: number;
    windows: number;
    frequencies: number[];
    power: number[];
    dominantFrequency: number;
    centroidFrequency: number;
    bandwidth90: [number, number];
  };
  spectrogram: { frequencies: number[]; frames: Array<{ time: number; db: number[] }>; minDb: number; maxDb: number };
  events: TriggerEvent[];
  picks: PhasePick[];
  referencePicks: PhasePick[];
  quality: {
    invalid: number;
    invalidRatio: number;
    clipped: number;
    clippedRatio: number;
    spikes: number;
    nyquist: number;
    raw: { count: number; mean: number; rms: number; peak: number };
    processed: { count: number; mean: number; rms: number; peak: number };
  };
  window: { noiseRms: number; signalRms: number; snr: number; snrDb: number; peak: number; cav: number | null; ariasIntensity: number | null };
  polarization: null | { principalVector: number[]; rectilinearity: number; planarity: number; startTime: number; endTime: number };
  physics: {
    inputs: PhysicsInputs;
    result: { valid: boolean; error?: string; deltaTime?: number; hypocentralKm?: number; epicentralKm?: number | null; vpVs?: number; poisson?: number; moment?: number | null; momentMagnitude?: number | null };
  };
  validation: Validation;
  evidence: Evidence[];
  qualityChecks: Array<{ passed: boolean; label: string }>;
  settings: SeismicSettings;
  history: Array<{ id: string; createdAt: string; project: string; traceId: string; events: number; picks: number; dominantFrequency: number; snr: number; stage: string }>;
  exports: {
    processedCsv: string;
    psdCsv: string;
    eventsCsv: string;
    picksCsv: string;
    referenceCsv: string;
    reportMarkdown: string;
    reportHtml: string;
    packageBase64: string;
  };
  runtime: { compute: string; miniSeed: string; miniSeedConfigured: boolean; stationXmlConfigured: boolean; fdsnConfigured: boolean };
  limitations: string[];
};

const defaultSettings: SeismicSettings = {
  detrend: 'linear', taperPercent: 5, filterMode: 'bandpass', lowCut: 1, highCut: 20,
  filterOrder: 4, zeroPhase: true, notchEnabled: false, notchFrequency: 50, notchQ: 30,
  sensitivity: 1, outputUnit: 'counts', staMethod: 'recursive', staSeconds: 0.25,
  ltaSeconds: 3, triggerOn: 3, triggerOff: 1.2, minDuration: 0.1, deadTime: 0.5,
  aicPhase: 'P', aicStart: 7.5, aicEnd: 9, noiseStart: 0, noiseEnd: 5,
  signalStart: 7, signalEnd: 16, validationTolerance: 0.3,
};

const defaultPhysics: PhysicsInputs = {
  pTime: 8.215, sTime: 12.58, vp: 6, vs: 3.5, depth: 5, density: 2700,
  omega0: '', radiation: 0.52, freeSurface: 2, waveType: 'P',
};

const views = [
  ['overview', '项目总览'],
  ['waveform', '波形与预处理'],
  ['detection', '检测与拾取'],
  ['spectrum', '频谱与时频'],
  ['physics', '信号与物理'],
  ['validation', '验证与证据'],
  ['delivery', '成果交付'],
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

function number(value: number | null | undefined, digits = 2) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—';
}

function percent(value: number | null | undefined, digits = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : '—';
}

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function createTrace(channel: string, channelIndex: number, points = 1200) {
  const random = seededRandom(20260909 + channelIndex * 117);
  const weights = channel === 'BHZ' ? [1, 0.36, 0.16] : channel === 'BHN' ? [0.24, 1, 0.44] : [0.18, 0.76, 1];
  return Array.from({ length: points }, (_, index) => {
    const time = index / (points - 1) * 30;
    const background = 0.022 * Math.sin(Math.PI * 2 * 0.73 * time + channelIndex * 0.41)
      + 0.016 * Math.sin(Math.PI * 2 * 2.1 * time + channelIndex) + (random() - 0.5) * 0.032;
    const pEnvelope = Math.exp(-Math.pow((time - 8.2) / 0.43, 2));
    const sEnvelope = Math.exp(-Math.pow((time - 12.6) / 0.86, 2));
    const coda = time >= 12.6 ? Math.exp(-(time - 12.6) / 4.5) : 0;
    return background
      + weights[0] * 1.05 * pEnvelope * Math.sin(Math.PI * 2 * 8.1 * (time - 8.2))
      + weights[1] * 1.72 * sEnvelope * Math.sin(Math.PI * 2 * 4.35 * (time - 12.6) + 0.2)
      + weights[2] * 0.34 * coda * Math.sin(Math.PI * 2 * 3.15 * (time - 12.6));
  });
}

function localValidation(reference: PhasePick[], predicted: PhasePick[], tolerance: number): Validation {
  const used = new Set<number>();
  const errors: number[] = [];
  reference.forEach((expected) => {
    const candidates = predicted.map((pick, index) => ({ pick, index }))
      .filter(({ pick, index }) => !used.has(index) && pick.phase === expected.phase && Math.abs(pick.time - expected.time) <= tolerance)
      .sort((left, right) => Math.abs(left.pick.time - expected.time) - Math.abs(right.pick.time - expected.time));
    if (candidates[0]) {
      used.add(candidates[0].index);
      errors.push(candidates[0].pick.time - expected.time);
    }
  });
  const tp = errors.length;
  const fp = predicted.length - tp;
  const fn = reference.length - tp;
  const precision = tp / Math.max(1, tp + fp);
  const recall = tp / Math.max(1, tp + fn);
  return {
    reference: reference.length, predicted: predicted.length, matched: tp, tp, fp, fn, precision, recall,
    f1: 2 * precision * recall / Math.max(1e-12, precision + recall),
    mae: errors.length ? errors.reduce((sum, value) => sum + Math.abs(value), 0) / errors.length : null,
    rmse: errors.length ? Math.sqrt(errors.reduce((sum, value) => sum + value * value, 0) / errors.length) : null,
    bias: errors.length ? errors.reduce((sum, value) => sum + value, 0) / errors.length : null,
    tolerance,
  };
}

function createBenchmarkResult(): SeismicResult {
  const traceIds = ['SC.SVL1..BHZ', 'SC.SVL1..BHN', 'SC.SVL1..BHE'];
  const previews = Object.fromEntries(traceIds.map((id, index) => [id, createTrace(id.slice(-3), index)]));
  const raw = previews[traceIds[0]];
  const processed = raw.map((value, index) => value - 0.018 * Math.sin(index / raw.length * 30 * Math.PI * 2 * 0.73));
  const envelope = processed.map((_, index) => {
    const start = Math.max(0, index - 4);
    const end = Math.min(processed.length, index + 5);
    return Math.sqrt(processed.slice(start, end).reduce((sum, value) => sum + value * value, 0) / Math.max(1, end - start));
  });
  const characteristic = processed.map((_, index) => {
    const time = index / (processed.length - 1) * 30;
    return 0.35 + 5.7 * Math.exp(-Math.pow((time - 8.25) / 0.48, 2)) + 4.2 * Math.exp(-Math.pow((time - 12.7) / 0.85, 2));
  });
  const frequencies = Array.from({ length: 129 }, (_, index) => index * 100 / 128);
  const power = frequencies.map((frequency) => 0.001 + 1.3 * Math.exp(-Math.pow((frequency - 4.35) / 0.72, 2)) + 0.72 * Math.exp(-Math.pow((frequency - 8.1) / 1.1, 2)));
  const frames = Array.from({ length: 46 }, (_, frame) => {
    const time = 0.65 + frame * 0.63;
    return {
      time,
      db: Array.from({ length: 65 }, (_, bin) => {
        const frequency = bin * 100 / 64;
        const pEnergy = 42 * Math.exp(-Math.pow((time - 8.2) / 0.6, 2)) * Math.exp(-Math.pow((frequency - 8.1) / 2.1, 2));
        const sEnergy = 56 * Math.exp(-Math.pow((time - 12.6) / 1.2, 2)) * Math.exp(-Math.pow((frequency - 4.35) / 1.6, 2));
        return -78 + pEnergy + sEnergy;
      }),
    };
  });
  const traces: TraceSummary[] = traceIds.map((id) => ({
    id, network: 'SC', station: 'SVL1', location: '', channel: id.slice(-3), sampleRate: 200,
    unit: 'counts', startTime: '2026-09-09T00:00:00.000Z', samples: 6000, duration: 30,
  }));
  const picks: PhasePick[] = [
    { id: 'AUTO-P', phase: 'P', time: 8.215, traceId: traceIds[0], source: '自动候选', uncertainty: 0.025, status: 'pending' },
    { id: 'AUTO-S', phase: 'S', time: 12.58, traceId: traceIds[0], source: '自动候选', uncertainty: 0.025, status: 'pending' },
  ];
  const referencePicks: PhasePick[] = [
    { id: 'TRUTH-P', phase: 'P', time: 8.2, traceId: traceIds[0], source: '基准真值', uncertainty: 0, status: 'verified' },
    { id: 'TRUTH-S', phase: 'S', time: 12.6, traceId: traceIds[0], source: '基准真值', uncertainty: 0, status: 'verified' },
  ];
  const validation = localValidation(referencePicks, picks, 0.3);
  const reportMarkdown = '# 地震波形与震相分析\n\n确定性三分量基准已经载入。\n\n## 结果\n\n- 事件候选：2\n- P/S 拾取：2\n- 主频：4.297 Hz\n- 信号窗 SNR：21.90×\n';
  return {
    schema: 'skyview-seismic-physics-results', version: 2, stage: 'run-all',
    project: { name: '地震波形与震相分析', analyst: 'SkyViewLab', stationNotes: '', eventNotes: '' },
    dataset: { name: 'SVL1 三分量确定性基准', sourceType: 'synthetic-benchmark', benchmark: true, seed: 20260909, sampleRate: 200, startTime: '2026-09-09T00:00:00.000Z', traces },
    selectedTrace: traceIds[0],
    preview: { sampleRate: 200, duration: 30, raw, processed, envelope, characteristic },
    tracePreviews: previews,
    psd: { nperseg: 512, windows: 22, frequencies, power, dominantFrequency: 4.297, centroidFrequency: 6.18, bandwidth90: [2.34, 10.16] },
    spectrogram: { frequencies: Array.from({ length: 65 }, (_, index) => index * 100 / 64), frames, minDb: -78, maxDb: -22 },
    events: [
      { id: 'EV-001', startTime: 7.88, endTime: 9.16, peakTime: 8.25, duration: 1.28, characteristicPeak: 6.05, amplitudePeak: 1.04, decision: 'pending' },
      { id: 'EV-002', startTime: 11.82, endTime: 14.24, peakTime: 12.7, duration: 2.42, characteristicPeak: 4.55, amplitudePeak: 0.68, decision: 'pending' },
    ],
    picks, referencePicks,
    quality: { invalid: 0, invalidRatio: 0, clipped: 1, clippedRatio: 1 / 6000, spikes: 0, nyquist: 100, raw: { count: 6000, mean: 0.0002, rms: 0.192, peak: 1.05 }, processed: { count: 6000, mean: 0, rms: 0.187, peak: 1.01 } },
    window: { noiseRms: 0.021, signalRms: 0.46, snr: 21.9, snrDb: 26.81, peak: 1.01, cav: null, ariasIntensity: null },
    polarization: { principalVector: [0.18, 0.78, 0.6], rectilinearity: 0.832, planarity: 0.914, startTime: 7, endTime: 16 },
    physics: { inputs: defaultPhysics, result: { valid: true, deltaTime: 4.365, hypocentralKm: 36.67, epicentralKm: 36.33, vpVs: 1.7143, poisson: 0.2432, moment: null, momentMagnitude: null } },
    validation,
    evidence: [
      { id: 'E-001', title: '确定性基准生成参数', type: '台站日志', status: 'verified', note: '固定种子 20260909，三分量 200 Hz / 30 s。' },
      { id: 'E-002', title: '三通道采样一致性', type: '台站元数据', status: 'verified', note: 'BHZ、BHN、BHE 的起点、采样率和样本数一致。' },
      { id: 'E-003', title: '独立到时真值', type: '事件目录', status: 'verified', note: 'P=8.200 s，S=12.600 s。' },
    ],
    qualityChecks: [
      '波形数据已载入', '连续段样本数满足分析要求', '滤波频率位于 Nyquist 范围内',
      '无效样本比例低于 1%', '疑似削波比例低于 1%', '输出量纲与灵敏度一致',
      'P、S 到时均有记录', '至少两个独立参考到时', '到时验证 F1 不低于 80%',
    ].map((label) => ({ passed: true, label })),
    settings: defaultSettings,
    history: [{ id: 'RUN-BASELINE', createdAt: '2026-09-09T00:00:00.000Z', project: '地震波形与震相分析', traceId: traceIds[0], events: 2, picks: 2, dominantFrequency: 4.297, snr: 21.9, stage: 'run-all' }],
    exports: {
      processedCsv: 'time_s,raw_counts,processed\r\n' + raw.map((value, index) => `${index / 40},${value},${processed[index]}`).join('\r\n'),
      psdCsv: 'frequency_hz,power_spectral_density\r\n' + frequencies.map((value, index) => `${value},${power[index]}`).join('\r\n'),
      eventsCsv: 'id,start_s,end_s,peak_s,decision\r\nEV-001,7.88,9.16,8.25,pending\r\nEV-002,11.82,14.24,12.7,pending',
      picksCsv: 'id,phase,time_s,source\r\nAUTO-P,P,8.215,automatic\r\nAUTO-S,S,12.58,automatic',
      referenceCsv: 'id,phase,time_s,source\r\nTRUTH-P,P,8.2,benchmark\r\nTRUTH-S,S,12.6,benchmark',
      reportMarkdown, reportHtml: `<pre>${reportMarkdown}</pre>`, packageBase64: '',
    },
    runtime: { compute: 'Python CPU 作业服务', miniSeed: 'ObsPy 外部运行时适配器', miniSeedConfigured: false, stationXmlConfigured: false, fdsnConfigured: false },
    limitations: [],
  };
}

function downloadText(content: string, fileName: string, type: string) {
  const url = URL.createObjectURL(new Blob(['\ufeff', content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function downloadBase64(content: string, fileName: string) {
  const bytes = Uint8Array.from(atob(content), (character) => character.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function NumberField({ label, value, onChange, step = '0.01', min }: { label: string; value: number | string; onChange: (value: number) => void; step?: string; min?: number }) {
  return <label className="seismic-field"><span>{label}</span><input type="number" value={value} step={step} min={min} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

function pathPoints(values: number[], duration: number, width: number, height: number, padding: { left: number; right: number; top: number; bottom: number }) {
  const maximum = Math.max(...values.map((value) => Math.abs(value)), 1e-9);
  return values.map((value, index) => {
    const x = padding.left + index / Math.max(1, values.length - 1) * (width - padding.left - padding.right);
    const y = padding.top + (1 - (value / maximum + 1) / 2) * (height - padding.top - padding.bottom);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
}

function WaveformChart({ result, traceId, mode, onPick }: { result: SeismicResult; traceId: string; mode: 'inspect' | 'P' | 'S' | 'X'; onPick: (time: number) => void }) {
  const width = 940;
  const height = 330;
  const padding = { left: 54, right: 20, top: 24, bottom: 35 };
  const raw = result.tracePreviews[traceId] ?? result.preview.raw;
  const processed = traceId === result.selectedTrace ? result.preview.processed : raw;
  const envelope = traceId === result.selectedTrace ? result.preview.envelope : raw.map((value) => Math.abs(value));
  const x = (time: number) => padding.left + time / result.preview.duration * (width - padding.left - padding.right);
  return (
    <div className={`seismic-chart-frame ${mode !== 'inspect' ? 'picking' : ''}`}>
      <button type="button" className="seismic-chart-pick-target" aria-label={mode === 'inspect' ? '波形检查图' : `在波形上拾取 ${mode} 到时`} onClick={(event) => {
        if (mode === 'inspect') return;
        const rect = event.currentTarget.getBoundingClientRect();
        const local = (event.clientX - rect.left) / rect.width * width;
        const time = Math.max(0, Math.min(result.preview.duration, (local - padding.left) / (width - padding.left - padding.right) * result.preview.duration));
        onPick(time);
      }}>
      <svg viewBox={`0 0 ${width} ${height}`} aria-label="原始、处理波形、包络和震相到时">
        <title>原始、处理波形、包络和震相到时</title>
        {Array.from({ length: 6 }, (_, index) => <line key={index} x1={padding.left} x2={width - padding.right} y1={padding.top + index * (height - padding.top - padding.bottom) / 5} y2={padding.top + index * (height - padding.top - padding.bottom) / 5} className="seismic-gridline" />)}
        {result.events.map((event) => <rect key={event.id} x={x(event.startTime)} y={padding.top} width={Math.max(2, x(event.endTime) - x(event.startTime))} height={height - padding.top - padding.bottom} className="seismic-event-window" />)}
        <polyline points={pathPoints(raw, result.preview.duration, width, height, padding)} className="seismic-series raw" />
        <polyline points={pathPoints(processed, result.preview.duration, width, height, padding)} className="seismic-series processed" />
        <polyline points={pathPoints(envelope, result.preview.duration, width, height, padding)} className="seismic-series envelope" />
        {result.picks.filter((pick) => pick.traceId === traceId || !pick.traceId).map((pick) => <g key={pick.id}><line x1={x(pick.time)} x2={x(pick.time)} y1={padding.top} y2={height - padding.bottom} className={`seismic-pick ${pick.phase}`} /><text x={x(pick.time) + 4} y={padding.top + 16} className={`seismic-pick-label ${pick.phase}`}>{pick.phase}</text></g>)}
        {Array.from({ length: 7 }, (_, index) => <text key={index} x={x(index * 5)} y={height - 11} textAnchor={index === 0 ? 'start' : index === 6 ? 'end' : 'middle'}>{index * 5}s</text>)}
      </svg>
      </button>
      <div className="seismic-chart-legend"><span><i className="raw" />原始</span><span><i className="processed" />处理后</span><span><i className="envelope" />包络</span></div>
    </div>
  );
}

function LineChart({ rows, xLabel, yLabel, thresholds = [] }: { rows: Array<{ x: number; y: number }>; xLabel: string; yLabel: string; thresholds?: Array<{ value: number; label: string; tone: string }> }) {
  const width = 760;
  const height = 270;
  const padding = { left: 58, right: 18, top: 22, bottom: 38 };
  const xs = rows.map((row) => row.x);
  const ys = rows.map((row) => row.y);
  const xMin = Math.min(...xs, 0);
  const xMax = Math.max(...xs, 1);
  const yMin = Math.min(...ys, 0);
  const yMax = Math.max(...ys, ...thresholds.map((item) => item.value), 1);
  const x = (value: number) => padding.left + (value - xMin) / Math.max(1e-12, xMax - xMin) * (width - padding.left - padding.right);
  const y = (value: number) => padding.top + (yMax - value) / Math.max(1e-12, yMax - yMin) * (height - padding.top - padding.bottom);
  return <div className="seismic-line-chart"><svg viewBox={`0 0 ${width} ${height}`} aria-label={`${xLabel}与${yLabel}`}>
    <title>{xLabel}与{yLabel}</title>
    {Array.from({ length: 5 }, (_, index) => <g key={index}><line x1={padding.left} x2={width - padding.right} y1={padding.top + index * (height - padding.top - padding.bottom) / 4} y2={padding.top + index * (height - padding.top - padding.bottom) / 4} className="seismic-gridline" /><text x={padding.left - 8} y={padding.top + index * (height - padding.top - padding.bottom) / 4 + 4} textAnchor="end">{number(yMax - index * (yMax - yMin) / 4, 1)}</text></g>)}
    {thresholds.map((item) => <g key={item.label}><line x1={padding.left} x2={width - padding.right} y1={y(item.value)} y2={y(item.value)} className={`seismic-threshold ${item.tone}`} /><text x={width - padding.right - 4} y={y(item.value) - 5} textAnchor="end">{item.label}</text></g>)}
    <polyline points={rows.map((row) => `${x(row.x)},${y(row.y)}`).join(' ')} className="seismic-line" />
    <text x={padding.left} y={height - 11}>{number(xMin, 1)}</text><text x={width - padding.right} y={height - 11} textAnchor="end">{number(xMax, 1)} {xLabel}</text>
  </svg></div>;
}

function Spectrogram({ result }: { result: SeismicResult }) {
  const width = 780;
  const height = 300;
  const frames = result.spectrogram.frames;
  const bins = result.spectrogram.frequencies.length;
  const color = (value: number) => {
    const t = Math.max(0, Math.min(1, (value - result.spectrogram.minDb) / Math.max(1, result.spectrogram.maxDb - result.spectrogram.minDb)));
    const hue = 230 - t * 196;
    return `hsl(${hue} 72% ${30 + t * 26}%)`;
  };
  return <div className="seismic-spectrogram"><svg viewBox={`0 0 ${width} ${height}`} aria-label="短时傅里叶时频图"><title>短时傅里叶时频图</title>
    {frames.flatMap((frame, frameIndex) => frame.db.map((value, binIndex) => <rect key={`${frameIndex}-${binIndex}`} x={48 + frameIndex / Math.max(1, frames.length) * (width - 66)} y={18 + (bins - 1 - binIndex) / Math.max(1, bins) * (height - 48)} width={(width - 66) / Math.max(1, frames.length) + 0.7} height={(height - 48) / Math.max(1, bins) + 0.7} fill={color(value)} />))}
    <text x="48" y={height - 8}>0s</text><text x={width - 18} y={height - 8} textAnchor="end">{number(frames.at(-1)?.time, 1)}s</text><text x="44" y="28" textAnchor="end">{number(result.spectrogram.frequencies.at(-1), 0)}Hz</text><text x="44" y={height - 34} textAnchor="end">0Hz</text>
  </svg><div className="seismic-colorbar"><span>低功率</span><i /><span>高功率</span></div></div>;
}

function ParticlePlot({ result }: { result: SeismicResult }) {
  const traces = result.dataset.traces.slice(0, 3).map((trace) => result.tracePreviews[trace.id] ?? []);
  const horizontal = traces[1] ?? [];
  const east = traces[2] ?? [];
  const start = Math.floor(result.settings.signalStart / result.preview.duration * horizontal.length);
  const end = Math.ceil(result.settings.signalEnd / result.preview.duration * horizontal.length);
  const maximum = Math.max(...horizontal.slice(start, end).map((value) => Math.abs(value)).concat(east.slice(start, end).map((value) => Math.abs(value))), 1e-9);
  const points = horizontal.slice(start, end).map((value, index) => `${180 + value / maximum * 145},${180 - (east[start + index] ?? 0) / maximum * 145}`).join(' ');
  return <svg className="seismic-particle" viewBox="0 0 360 360" aria-label="水平两分量粒子运动"><title>水平两分量粒子运动</title><line x1="30" x2="330" y1="180" y2="180" /><line x1="180" x2="180" y1="30" y2="330" /><polyline points={points} /><text x="330" y="174" textAnchor="end">北向</text><text x="187" y="42">东向</text></svg>;
}

export function SeismicPhysicsWorkbench({ executionAllowed = true }: { executionAllowed?: boolean }) {
  const [selectedView, setSelectedView] = useState<(typeof views)[number][0]>('overview');
  const [settings, setSettings] = useState(defaultSettings);
  const [physics, setPhysics] = useState(defaultPhysics);
  const [result, setResult] = useState<SeismicResult>(() => createBenchmarkResult());
  const [selectedTrace, setSelectedTrace] = useState('SC.SVL1..BHZ');
  const [manualPhase, setManualPhase] = useState<'inspect' | 'P' | 'S' | 'X'>('inspect');
  const [projects, setProjects] = useState<WorkbenchProject[]>([]);
  const [projectId, setProjectId] = useState('');
  const [projectTitle, setProjectTitle] = useState('地震波形与震相分析');
  const [analyst, setAnalyst] = useState('SkyViewLab');
  const [waveformText, setWaveformText] = useState('');
  const [fileName, setFileName] = useState('');
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [referencePhase, setReferencePhase] = useState<'P' | 'S' | 'X'>('P');
  const [referenceTime, setReferenceTime] = useState('');
  const [evidenceTitle, setEvidenceTitle] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    toolApi.listProjects('seismic-physics').then((items) => {
      if (!active) return;
      setProjects(items);
      const project = items[0];
      const saved = project?.state.seismic as { settings?: SeismicSettings; physics?: PhysicsInputs; result?: SeismicResult; selectedTrace?: string; analyst?: string } | undefined;
      if (!project || saved?.result?.schema !== 'skyview-seismic-physics-results') return;
      setProjectId(project.id);
      setProjectTitle(project.title);
      setSettings(saved.settings ?? saved.result.settings);
      setPhysics(saved.physics ?? saved.result.physics.inputs);
      setResult(saved.result);
      setSelectedTrace(saved.selectedTrace ?? saved.result.selectedTrace);
      setAnalyst(saved.analyst ?? saved.result.project.analyst);
      setMessage('已打开最近项目及其分析结果。');
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  const projectState = (nextResult: SeismicResult = result) => ({
    seismic: { settings, physics, result: nextResult, selectedTrace, analyst },
  });

  const ensureProject = async () => {
    const existing = projects.find((project) => project.id === projectId);
    if (existing) return existing;
    const created = await toolApi.createProject('seismic-physics', projectTitle, projectState());
    setProjects((items) => [created, ...items]);
    setProjectId(created.id);
    return created;
  };

  const execute = async (action: string) => {
    if (!executionAllowed) return;
    setRunning(true);
    setError('');
    setMessage('Python 作业服务正在处理三分量波形…');
    try {
      const project = await ensureProject();
      const created = await toolApi.createJob(project.id, 'seismic-physics', action, {
        project: { name: projectTitle, analyst, stationNotes: result.project.stationNotes, eventNotes: result.project.eventNotes },
        settings, physics, selectedTrace, waveformText, fileName,
        picks: result.picks, referencePicks: result.referencePicks,
        eventDecisions: Object.fromEntries(result.events.map((event) => [event.id, event.decision])),
        evidence: result.evidence, history: result.history,
      }, crypto.randomUUID());
      const job = await waitForJob(created.job.id);
      if (!job) throw new Error('计算仍在后台运行，请稍后重新打开项目。');
      if (job.status === 'failed') throw new Error(job.error || '计算失败。');
      if (job.status === 'canceled') throw new Error('计算已取消。');
      const output = job.result as SeismicResult;
      if (output.schema !== 'skyview-seismic-physics-results') throw new Error('服务端返回了不兼容的结果。');
      setResult(output);
      setSettings(output.settings);
      setPhysics(output.physics.inputs);
      setSelectedTrace(output.selectedTrace);
      const saved = await toolApi.updateProject(project.id, projectTitle, projectState(output));
      setProjects((items) => [saved, ...items.filter((item) => item.id !== saved.id)]);
      setMessage(action === 'run-all' ? '完整分析已完成，图表、验证与成果包均已更新。' : '当前分析阶段已完成。');
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
        : await toolApi.createProject('seismic-physics', projectTitle, projectState());
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
      const benchmark = createBenchmarkResult();
      setProjectTitle('地震波形与震相分析');
      setSettings(defaultSettings);
      setPhysics(defaultPhysics);
      setResult(benchmark);
      setSelectedTrace(benchmark.selectedTrace);
      return;
    }
    const saved = project.state.seismic as { settings?: SeismicSettings; physics?: PhysicsInputs; result?: SeismicResult; selectedTrace?: string; analyst?: string } | undefined;
    setProjectTitle(project.title);
    if (saved?.result?.schema === 'skyview-seismic-physics-results') {
      setSettings(saved.settings ?? saved.result.settings);
      setPhysics(saved.physics ?? saved.result.physics.inputs);
      setResult(saved.result);
      setSelectedTrace(saved.selectedTrace ?? saved.result.selectedTrace);
      setAnalyst(saved.analyst ?? saved.result.project.analyst);
    }
  };

  const updatePicks = (picks: PhasePick[]) => {
    const validation = localValidation(result.referencePicks, picks, settings.validationTolerance);
    const p = [...picks].sort((left, right) => left.time - right.time).find((pick) => pick.phase === 'P');
    const s = [...picks].sort((left, right) => left.time - right.time).find((pick) => pick.phase === 'S');
    setPhysics((current) => ({ ...current, pTime: p?.time ?? current.pTime, sTime: s?.time ?? current.sTime }));
    setResult((current) => ({ ...current, picks, validation }));
  };

  const addManualPick = (time: number) => {
    if (manualPhase === 'inspect') return;
    updatePicks([...result.picks, {
      id: crypto.randomUUID(), phase: manualPhase, time, traceId: selectedTrace,
      source: '人工波形拾取', uncertainty: result.preview.duration / 940, status: 'pending',
    }]);
    setMessage(`已添加 ${manualPhase} 到时 ${number(time, 4)} s。`);
  };

  const addReference = () => {
    const time = Number(referenceTime);
    if (!Number.isFinite(time) || time < 0) return;
    const referencePicks = [...result.referencePicks, { id: crypto.randomUUID(), phase: referencePhase, time, traceId: selectedTrace, source: '人工独立参考', uncertainty: 0, status: 'verified' }];
    setResult((current) => ({ ...current, referencePicks, validation: localValidation(referencePicks, current.picks, settings.validationTolerance) }));
    setReferenceTime('');
  };

  const addEvidence = () => {
    if (!evidenceTitle.trim()) return;
    setResult((current) => ({ ...current, evidence: [{ id: crypto.randomUUID(), title: evidenceTitle.trim(), type: '人工复核', status: 'verified', note: `由 ${analyst || '分析人员'} 添加。` }, ...current.evidence] }));
    setEvidenceTitle('');
  };

  const activeTrace = result.dataset.traces.find((trace) => trace.id === selectedTrace) ?? result.dataset.traces[0];
  const triggerRows = useMemo(() => result.preview.characteristic.map((value, index) => ({ x: index / Math.max(1, result.preview.characteristic.length - 1) * result.preview.duration, y: value })), [result]);
  const psdRows = useMemo(() => result.psd.frequencies.map((frequency, index) => ({ x: frequency, y: 10 * Math.log10((result.psd.power[index] ?? 0) + 1e-20) })), [result]);
  const passCount = result.qualityChecks.filter((item) => item.passed).length;

  return (
    <section className="seismic-workbench">
      <header className="seismic-commandbar">
        <div className="seismic-project-picker"><FolderOpen size={17} /><NativeSelect value={projectId} onChange={(event) => selectProject(event.target.value)} disabled={running}><NativeSelectOption value="">未保存项目</NativeSelectOption>{projects.map((project) => <NativeSelectOption key={project.id} value={project.id}>{project.title}</NativeSelectOption>)}</NativeSelect><Input aria-label="项目名称" value={projectTitle} onChange={(event) => setProjectTitle(event.target.value)} /><Input aria-label="分析人员" value={analyst} onChange={(event) => setAnalyst(event.target.value)} /></div>
        <div className="seismic-command-actions"><Button variant="ghost" onClick={() => selectProject('')} disabled={running}><Plus />新建</Button><Button variant="outline" onClick={() => void saveProject()} disabled={saving || running}>{saving ? <LoaderCircle className="spin" /> : <Save />}保存</Button><Button variant="outline" onClick={() => void createVersion()} disabled={saving || running}><Archive />创建版本</Button></div>
      </header>

      <div className="seismic-toolbar">
        <div className="seismic-source"><Waves /><span>{result.dataset.benchmark ? '三分量确定性基准' : result.dataset.name}</span><b>{result.dataset.traces.length} 通道 · {number(result.dataset.sampleRate, 0)} Hz · {number(activeTrace?.duration, 1)} s</b></div>
        <div className="seismic-toolbar-actions"><input ref={fileInput} type="file" accept=".csv,.json,text/csv,application/json" hidden onChange={(event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          file.text().then((text) => { setWaveformText(text); setFileName(file.name); setMessage(`已选择 ${file.name}，执行后由 Python 解析。`); }).catch(() => setError('无法读取文件。'));
        }} /><Button variant="outline" onClick={() => fileInput.current?.click()} disabled={running}><FileUp />导入波形</Button><Button onClick={() => void execute('run-all')} disabled={running}>{running ? <LoaderCircle className="spin" /> : <Play />}执行完整分析</Button></div>
      </div>

      <section className="seismic-kpi-rail" aria-label="分析摘要">
        <article><Activity /><span>连续通道</span><strong>{result.dataset.traces.length}</strong><small>{activeTrace?.samples.toLocaleString('zh-CN')} 点/道</small></article>
        <article><Gauge /><span>事件候选</span><strong>{result.events.length}</strong><small>{result.events.filter((event) => event.decision === 'accepted').length} 个已接受</small></article>
        <article><Waves /><span>震相拾取</span><strong>{result.picks.length}</strong><small>{result.picks.filter((pick) => pick.phase === 'P').length} P · {result.picks.filter((pick) => pick.phase === 'S').length} S</small></article>
        <article><Activity /><span>主频</span><strong>{number(result.psd.dominantFrequency, 2)}</strong><small>Hz · 质心 {number(result.psd.centroidFrequency, 2)}</small></article>
        <article><ShieldCheck /><span>信号窗 SNR</span><strong>{number(result.window.snr, 1)}×</strong><small>{number(result.window.snrDb, 1)} dB · 门禁 {passCount}/{result.qualityChecks.length}</small></article>
      </section>

      <nav className="seismic-tabs" aria-label="地震与物理分析工作区">{views.map(([id, label], index) => <button key={id} type="button" className={selectedView === id ? 'active' : ''} onClick={() => setSelectedView(id)}><b>{String(index + 1).padStart(2, '0')}</b><span>{label}</span></button>)}</nav>
      {(message || error) && <div className={`seismic-status ${error ? 'error' : ''}`}>{error || message}</div>}

      <main className="seismic-main" data-view={selectedView}>
        {selectedView === 'overview' && <div className="seismic-view seismic-overview">
          <section className="seismic-surface seismic-process"><header><span>完整处理链</span><strong>从波形到可复核结论</strong></header><div className="seismic-pipeline">{[
            ['接入', `${result.dataset.traces.length} 个通道`], ['预处理', `${settings.lowCut}–${settings.highCut} Hz`], ['检测', `${result.events.length} 个候选`], ['拾取', `${result.picks.length} 个到时`], ['验证', `F1 ${percent(result.validation.f1)}`], ['交付', '7 类文件'],
          ].map(([label, value], index) => <article key={label}><b>{String(index + 1).padStart(2, '0')}</b><div><strong>{label}</strong><small>{value}</small></div></article>)}</div></section>
          <section className="seismic-surface seismic-trace-overview"><header><span>台站与连续段</span><strong>{result.dataset.name}</strong></header><div className="seismic-trace-list">{result.dataset.traces.map((trace) => <button key={trace.id} type="button" aria-label={`查看 ${trace.channel} 波形`} className={selectedTrace === trace.id ? 'active' : ''} onClick={() => { setSelectedTrace(trace.id); setSelectedView('waveform'); }}><i /><div><strong>{trace.channel}</strong><span>{trace.network}.{trace.station}{trace.location ? `.${trace.location}` : ''}</span></div><small><span>{trace.samples.toLocaleString('zh-CN')} 点</span><span>{trace.sampleRate} Hz</span></small></button>)}</div></section>
          <section className="seismic-surface seismic-qa"><header><span>质量门禁</span><strong>{passCount} / {result.qualityChecks.length} 项通过</strong></header><div>{result.qualityChecks.map((item) => <p key={item.label} className={item.passed ? 'pass' : 'warn'}>{item.passed ? <CheckCircle2 /> : <Activity />}<span>{item.label}</span></p>)}</div></section>
          <section className="seismic-surface seismic-overview-wave"><header><span>当前连续段</span><strong>{activeTrace?.id}</strong><small>原始、处理后与包络</small></header><WaveformChart result={result} traceId={selectedTrace} mode="inspect" onPick={() => undefined} /></section>
        </div>}

        {selectedView === 'waveform' && <div className="seismic-view seismic-waveform-layout">
          <aside className="seismic-surface seismic-controls"><header><span>波形预处理</span><strong>参数配方</strong></header><div className="seismic-compact-form"><label className="seismic-field" htmlFor="seismic-detrend"><span>去趋势</span><NativeSelect id="seismic-detrend" value={settings.detrend} onChange={(event) => setSettings((current) => ({ ...current, detrend: event.target.value as SeismicSettings['detrend'] }))}><NativeSelectOption value="linear">线性去趋势</NativeSelectOption><NativeSelectOption value="mean">去均值</NativeSelectOption><NativeSelectOption value="none">不处理</NativeSelectOption></NativeSelect></label><label className="seismic-field" htmlFor="seismic-filter-mode"><span>滤波方式</span><NativeSelect id="seismic-filter-mode" value={settings.filterMode} onChange={(event) => setSettings((current) => ({ ...current, filterMode: event.target.value as SeismicSettings['filterMode'] }))}><NativeSelectOption value="bandpass">带通</NativeSelectOption><NativeSelectOption value="highpass">高通</NativeSelectOption><NativeSelectOption value="lowpass">低通</NativeSelectOption><NativeSelectOption value="none">关闭</NativeSelectOption></NativeSelect></label><NumberField label="低截止 / Hz" value={settings.lowCut} onChange={(value) => setSettings((current) => ({ ...current, lowCut: value }))} /><NumberField label="高截止 / Hz" value={settings.highCut} onChange={(value) => setSettings((current) => ({ ...current, highCut: value }))} /><NumberField label="渐消 / %" value={settings.taperPercent} onChange={(value) => setSettings((current) => ({ ...current, taperPercent: value }))} /><NumberField label="滤波阶数" value={settings.filterOrder} step="2" onChange={(value) => setSettings((current) => ({ ...current, filterOrder: value }))} /></div><div className="seismic-checks"><label><input type="checkbox" checked={settings.zeroPhase} onChange={(event) => setSettings((current) => ({ ...current, zeroPhase: event.target.checked }))} />零相位滤波</label><label><input type="checkbox" checked={settings.notchEnabled} onChange={(event) => setSettings((current) => ({ ...current, notchEnabled: event.target.checked }))} />工频陷波</label></div><Button onClick={() => void execute('preprocess')} disabled={running}><Play />应用处理配方</Button><div className="seismic-trace-chips">{result.dataset.traces.map((trace) => <button key={trace.id} className={selectedTrace === trace.id ? 'active' : ''} onClick={() => setSelectedTrace(trace.id)}>{trace.channel}</button>)}</div></aside>
          <section className="seismic-surface seismic-waveform-stage"><header><span>{activeTrace?.id}</span><strong>波形、包络与到时</strong><div className="seismic-pick-modes">{([['inspect', '检查'], ['P', '拾取 P'], ['S', '拾取 S'], ['X', '其他到时']] as const).map(([id, label]) => <button key={id} className={manualPhase === id ? 'active' : ''} onClick={() => setManualPhase(id)}>{label}</button>)}</div></header><WaveformChart result={result} traceId={selectedTrace} mode={manualPhase} onPick={addManualPick} /><div className="seismic-pick-strip">{result.picks.filter((pick) => pick.traceId === selectedTrace).map((pick) => <article key={pick.id}><b className={pick.phase}>{pick.phase}</b><span>{number(pick.time, 4)} s</span><small>{pick.source} · ±{number(pick.uncertainty, 3)} s</small><button onClick={() => updatePicks(result.picks.filter((item) => item.id !== pick.id))} aria-label="删除拾取"><Trash2 /></button></article>)}</div></section>
        </div>}

        {selectedView === 'detection' && <div className="seismic-view seismic-detection-layout">
          <section className="seismic-surface seismic-trigger-stage"><header><span>事件特征函数</span><strong>{settings.staMethod === 'recursive' ? '递归' : '经典'} STA/LTA</strong><div className="seismic-inline-fields"><NumberField label="STA / s" value={settings.staSeconds} onChange={(value) => setSettings((current) => ({ ...current, staSeconds: value }))} /><NumberField label="LTA / s" value={settings.ltaSeconds} onChange={(value) => setSettings((current) => ({ ...current, ltaSeconds: value }))} /><NumberField label="触发阈值" value={settings.triggerOn} onChange={(value) => setSettings((current) => ({ ...current, triggerOn: value }))} /><NumberField label="结束阈值" value={settings.triggerOff} onChange={(value) => setSettings((current) => ({ ...current, triggerOff: value }))} /><Button onClick={() => void execute('detect')} disabled={running}><Play />重新检测</Button></div></header><LineChart rows={triggerRows} xLabel="秒" yLabel="STA/LTA" thresholds={[{ value: settings.triggerOn, label: '触发', tone: 'on' }, { value: settings.triggerOff, label: '结束', tone: 'off' }]} /></section>
          <section className="seismic-surface seismic-event-catalog"><header><span>触发目录</span><strong>{result.events.length} 个候选</strong></header><div className="seismic-event-list">{result.events.map((event) => <article key={event.id}><b>{event.id}</b><div><strong>{number(event.startTime, 3)}–{number(event.endTime, 3)} s</strong><small>峰值 {number(event.characteristicPeak, 2)} · 振幅 {number(event.amplitudePeak, 3)}</small></div><NativeSelect value={event.decision} onChange={(change) => setResult((current) => ({ ...current, events: current.events.map((item) => item.id === event.id ? { ...item, decision: change.target.value } : item) }))}><NativeSelectOption value="pending">待复核</NativeSelectOption><NativeSelectOption value="accepted">接受</NativeSelectOption><NativeSelectOption value="rejected">排除</NativeSelectOption></NativeSelect></article>)}</div></section>
          <section className="seismic-surface seismic-aic"><header><span>到时建议</span><strong>AIC 窗口拾取</strong></header><div className="seismic-inline-fields"><label className="seismic-field" htmlFor="seismic-aic-phase"><span>震相</span><NativeSelect id="seismic-aic-phase" value={settings.aicPhase} onChange={(event) => setSettings((current) => ({ ...current, aicPhase: event.target.value as SeismicSettings['aicPhase'] }))}><NativeSelectOption value="P">P 波</NativeSelectOption><NativeSelectOption value="S">S 波</NativeSelectOption><NativeSelectOption value="X">其他</NativeSelectOption></NativeSelect></label><NumberField label="起点 / s" value={settings.aicStart} onChange={(value) => setSettings((current) => ({ ...current, aicStart: value }))} /><NumberField label="终点 / s" value={settings.aicEnd} onChange={(value) => setSettings((current) => ({ ...current, aicEnd: value }))} /><Button onClick={() => void execute('aic-pick')} disabled={running}><Plus />计算并加入</Button></div><div className="seismic-mini-table">{result.picks.map((pick) => <p key={pick.id}><b className={pick.phase}>{pick.phase}</b><span>{number(pick.time, 4)} s</span><small>{pick.source}</small><em>{pick.status === 'verified' ? '已核验' : '待复核'}</em></p>)}</div></section>
        </div>}

        {selectedView === 'spectrum' && <div className="seismic-view seismic-spectrum-layout">
          <section className="seismic-surface seismic-psd"><header><span>功率谱密度</span><strong>Welch PSD</strong><small>主频 {number(result.psd.dominantFrequency, 3)} Hz · {result.psd.windows} 个平均窗</small></header><LineChart rows={psdRows} xLabel="Hz" yLabel="dB/Hz" /><div className="seismic-spectrum-stats"><span>分段 <b>{result.psd.nperseg}</b></span><span>频谱质心 <b>{number(result.psd.centroidFrequency, 3)} Hz</b></span><span>90% 频带 <b>{number(result.psd.bandwidth90[0], 2)}–{number(result.psd.bandwidth90[1], 2)} Hz</b></span></div></section>
          <section className="seismic-surface seismic-stft"><header><span>时间—频率分布</span><strong>短时傅里叶谱</strong><small>{result.spectrogram.frames.length} 个时间窗</small></header><Spectrogram result={result} /></section>
        </div>}

        {selectedView === 'physics' && <div className="seismic-view seismic-physics-layout">
          <section className="seismic-signal-rail"><article><span>峰值振幅</span><strong>{number(result.window.peak, 4)}</strong><small>{settings.outputUnit}</small></article><article><span>噪声 RMS</span><strong>{number(result.window.noiseRms, 5)}</strong><small>{settings.noiseStart}–{settings.noiseEnd} s</small></article><article><span>信号 RMS</span><strong>{number(result.window.signalRms, 5)}</strong><small>{settings.signalStart}–{settings.signalEnd} s</small></article><article><span>直线度</span><strong>{number(result.polarization?.rectilinearity, 3)}</strong><small>三分量偏振</small></article></section>
          <section className="seismic-surface seismic-particle-card"><header><span>三分量偏振</span><strong>水平粒子运动</strong></header><ParticlePlot result={result} /><dl><div><dt>直线度</dt><dd>{number(result.polarization?.rectilinearity, 4)}</dd></div><div><dt>平面度</dt><dd>{number(result.polarization?.planarity, 4)}</dd></div><div><dt>主方向</dt><dd>{result.polarization?.principalVector.map((value) => number(value, 2)).join(' / ') ?? '—'}</dd></div></dl></section>
          <section className="seismic-surface seismic-model"><header><span>均匀速度模型</span><strong>P–S 到时差与介质参数</strong></header><div className="seismic-physics-form"><NumberField label="P 到时 / s" value={physics.pTime} onChange={(value) => setPhysics((current) => ({ ...current, pTime: value }))} /><NumberField label="S 到时 / s" value={physics.sTime} onChange={(value) => setPhysics((current) => ({ ...current, sTime: value }))} /><NumberField label="Vp / km·s⁻¹" value={physics.vp} onChange={(value) => setPhysics((current) => ({ ...current, vp: value }))} /><NumberField label="Vs / km·s⁻¹" value={physics.vs} onChange={(value) => setPhysics((current) => ({ ...current, vs: value }))} /><NumberField label="假定深度 / km" value={physics.depth} onChange={(value) => setPhysics((current) => ({ ...current, depth: value }))} /><NumberField label="介质密度 / kg·m⁻³" value={physics.density} step="10" onChange={(value) => setPhysics((current) => ({ ...current, density: value }))} /></div><Button onClick={() => void execute('physics')} disabled={running}><Play />重新计算模型</Button><div className="seismic-model-result">{result.physics.result.valid ? <><b>{number(result.physics.result.hypocentralKm, 2)} km</b><span>震源距</span><p>到时差 {number(result.physics.result.deltaTime, 4)} s · 水平距 {number(result.physics.result.epicentralKm, 2)} km · Vp/Vs {number(result.physics.result.vpVs, 4)} · 泊松比 {number(result.physics.result.poisson, 4)}</p></> : <p>{result.physics.result.error}</p>}</div></section>
        </div>}

        {selectedView === 'validation' && <div className="seismic-view seismic-validation-layout">
          <section className="seismic-metric-board">{[['精确率', result.validation.precision], ['召回率', result.validation.recall], ['F1', result.validation.f1]].map(([label, value]) => <article key={String(label)}><span>{label}</span><strong>{percent(value as number, 1)}</strong></article>)}<article><span>平均绝对误差</span><strong>{result.validation.mae === null ? '—' : `${number(result.validation.mae, 4)} s`}</strong></article><article><span>TP / FP / FN</span><strong>{result.validation.tp} / {result.validation.fp} / {result.validation.fn}</strong></article></section>
          <section className="seismic-surface seismic-reference"><header><span>独立参考到时</span><strong>匹配容差 ±{number(settings.validationTolerance, 3)} s</strong></header><div className="seismic-reference-add"><NativeSelect value={referencePhase} onChange={(event) => setReferencePhase(event.target.value as 'P' | 'S' | 'X')}><NativeSelectOption value="P">P 波</NativeSelectOption><NativeSelectOption value="S">S 波</NativeSelectOption><NativeSelectOption value="X">其他</NativeSelectOption></NativeSelect><Input type="number" placeholder="参考到时 / s" value={referenceTime} onChange={(event) => setReferenceTime(event.target.value)} /><Button onClick={addReference}><Plus />添加参考</Button></div><div className="seismic-mini-table">{result.referencePicks.map((pick) => <p key={pick.id}><b className={pick.phase}>{pick.phase}</b><span>{number(pick.time, 4)} s</span><small>{pick.source}</small><button onClick={() => { const referencePicks = result.referencePicks.filter((item) => item.id !== pick.id); setResult((current) => ({ ...current, referencePicks, validation: localValidation(referencePicks, current.picks, settings.validationTolerance) })); }}><Trash2 /></button></p>)}</div></section>
          <section className="seismic-surface seismic-evidence"><header><span>证据链</span><strong>{result.evidence.length} 条记录</strong></header><div className="seismic-evidence-add"><Input placeholder="台站日志、响应文件或人工复核记录" value={evidenceTitle} onChange={(event) => setEvidenceTitle(event.target.value)} /><Button onClick={addEvidence}><Plus />加入证据链</Button></div><div>{result.evidence.map((item) => <article key={item.id}><CheckCircle2 /><div><strong>{item.title}</strong><span>{item.type} · {item.status === 'verified' ? '已核验' : item.status}</span><small>{item.note}</small></div><button onClick={() => setResult((current) => ({ ...current, evidence: current.evidence.filter((entry) => entry.id !== item.id) }))}><Trash2 /></button></article>)}</div></section>
        </div>}

        {selectedView === 'delivery' && <div className="seismic-view seismic-delivery-layout">
          <section className="seismic-surface seismic-deliverables"><header><span>可复现成果</span><strong>报告、波形、频谱、目录与分析包</strong></header><div className="seismic-export-grid"><button onClick={() => downloadText(result.exports.reportMarkdown, 'seismic-analysis-report.md', 'text/markdown;charset=utf-8')}><Download /><strong>分析报告</strong><small>Markdown</small></button><button onClick={() => downloadText(result.exports.reportHtml, 'seismic-analysis-report.html', 'text/html;charset=utf-8')}><Download /><strong>打印报告</strong><small>HTML</small></button><button onClick={() => downloadText(result.exports.processedCsv, 'seismic-processed-waveform.csv', 'text/csv;charset=utf-8')}><Download /><strong>处理波形</strong><small>CSV</small></button><button onClick={() => downloadText(result.exports.psdCsv, 'seismic-welch-psd.csv', 'text/csv;charset=utf-8')}><Download /><strong>功率谱密度</strong><small>CSV</small></button><button onClick={() => downloadText(result.exports.eventsCsv, 'seismic-event-catalog.csv', 'text/csv;charset=utf-8')}><Download /><strong>事件目录</strong><small>CSV</small></button><button onClick={() => downloadText(result.exports.picksCsv, 'seismic-phase-picks.csv', 'text/csv;charset=utf-8')}><Download /><strong>震相拾取</strong><small>CSV</small></button><button className="primary" disabled={!result.exports.packageBase64} onClick={() => result.exports.packageBase64 && downloadBase64(result.exports.packageBase64, 'seismic-analysis-package.zip')}><Archive /><strong>完整分析包</strong><small>{result.exports.packageBase64 ? 'ZIP' : '执行完整分析后生成'}</small></button></div></section>
          <section className="seismic-surface seismic-history"><header><span>运行履历</span><strong>{result.history.length} 次记录</strong></header><div>{result.history.slice(0, 12).map((item) => <article key={item.id}><Activity /><div><strong>{item.project}</strong><span>{item.traceId}</span></div><p>{item.events} 事件 · {item.picks} 拾取<br /><small>主频 {number(item.dominantFrequency, 2)} Hz · SNR {number(item.snr, 1)}×</small></p><time>{new Date(item.createdAt).toLocaleString('zh-CN')}</time></article>)}</div></section>
          <section className="seismic-surface seismic-runtime"><header><span>运行时连接</span><strong>计算与数据适配器</strong></header><dl><div><dt>主计算服务</dt><dd className="ready">已连接</dd><small>{result.runtime.compute}</small></div><div><dt>miniSEED</dt><dd className={result.runtime.miniSeedConfigured ? 'ready' : 'standby'}>{result.runtime.miniSeedConfigured ? '已配置' : '待配置'}</dd><small>{result.runtime.miniSeed}</small></div><div><dt>StationXML</dt><dd className={result.runtime.stationXmlConfigured ? 'ready' : 'standby'}>{result.runtime.stationXmlConfigured ? '已配置' : '待配置'}</dd><small>台站与仪器响应元数据</small></div><div><dt>FDSN</dt><dd className={result.runtime.fdsnConfigured ? 'ready' : 'standby'}>{result.runtime.fdsnConfigured ? '已配置' : '待配置'}</dd><small>台网波形与事件目录接口</small></div></dl><Button variant="ghost" onClick={() => { const benchmark = createBenchmarkResult(); setResult(benchmark); setSettings(defaultSettings); setPhysics(defaultPhysics); setSelectedTrace(benchmark.selectedTrace); setWaveformText(''); setFileName(''); setMessage('已恢复确定性三分量基准。'); }}><RotateCcw />恢复合成基准</Button></section>
        </div>}
      </main>
    </section>
  );
}
