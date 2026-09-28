'use client';
/* eslint-disable jsx-a11y/label-has-associated-control */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  CheckCircle2,
  Download,
  FileImage,
  LoaderCircle,
  Play,
  Plus,
  RotateCcw,
  Save,
  ShieldCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/services/api/client';
import {
  toolApi,
  type WorkbenchJob,
  type WorkbenchProject,
} from '@/services/api/tools';

type RasterDataset = {
  name: string;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  bandCount: number;
  format: string;
  bands: number[][];
  geo: null | {
    epsg?: number;
    origin?: number[];
    resolution?: number[];
    noData?: number | null;
  };
  noData?: number | null;
  downsampleFactor: number;
  date?: string;
};

type Settings = {
  method:
    | 'ndvi-loss'
    | 'dnbr'
    | 'ndwi-gain'
    | 'rgb-cva'
    | 'brightness'
    | 'band-abs';
  thresholdStrategy: 'otsu' | 'percentile' | 'manual';
  manualThreshold: number;
  percentile: number;
  morphology: 'none' | 'open' | 'close' | 'open-close';
  morphologyRadius: number;
  minPatchPixels: number;
  radiometricNormalization: boolean;
  offsetX: number;
  offsetY: number;
  singleBand: number;
  mapping: Record<'red' | 'green' | 'blue' | 'nir' | 'swir1' | 'swir2', number>;
};

type Metrics = {
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  outside?: number;
  evaluated: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  iou: number | null;
  accuracy: number | null;
};

type Zone = {
  id: string;
  changedPixels: number;
  changedRatio: number;
  meanScore: number;
  impactScore: number;
  severity: string;
  dominantClass: string;
  areaHa: number | null;
};

type Component = {
  id: number;
  rank: number;
  pixelCount: number;
  areaHa: number | null;
  meanScore: number;
  maxScore: number;
  coordinate: number[];
  bbox: number[];
};

type RemoteResult = {
  schema: 'skyview-remote-sensing-results';
  version: number;
  stage: string;
  processingMode: string;
  synthetic: boolean;
  createdAt: string;
  settings?: Settings;
  width: number;
  height: number;
  threshold: number;
  score: number[];
  mask: number[];
  classes: number[];
  histogram: {
    min: number;
    max: number;
    mean: number;
    std: number;
    counts: number[];
  };
  categories: Array<{
    id: number;
    label: string;
    count: number;
    ratio: number;
  }>;
  components: Component[];
  zones: Zone[];
  validation: Metrics;
  benchmarkValidation: Metrics | null;
  summary: {
    validPixels: number;
    validRatio: number;
    changedPixels: number;
    changedRatio: number;
    areaM2: number | null;
    areaHa: number | null;
  };
  assessment: {
    formula: string;
    changeSignal: number;
    zoneImpact: number;
    compositeScore: number;
    severity: string;
    affectedZones: number;
    totalZones: number;
    recommendations: string[];
  };
  quality: {
    pixelLimit: number;
    crs?: number;
    noData?: number | null;
    resolution?: number[];
    bandMappingComplete: boolean;
  };
  compatibility: { ready: boolean; errors: string[]; warnings: string[] };
  exports: {
    reportMarkdown: string;
    reportHtml: string;
    regionsCsv: string;
    zonesCsv: string;
    validationCsv: string;
    regionsGeoJson: string;
    maskPngBase64: string;
    maskGeoTiffBase64: string;
    packageBase64: string;
  };
};

type ValidationSample = { id: string; x: number; y: number; label: 0 | 1 };
type Evidence = {
  id: string;
  title: string;
  type: string;
  status: string;
  note: string;
  createdAt: string;
};

const defaults: Settings = {
  method: 'ndvi-loss',
  thresholdStrategy: 'otsu',
  manualThreshold: 0.18,
  percentile: 95,
  morphology: 'open-close',
  morphologyRadius: 1,
  minPatchPixels: 8,
  radiometricNormalization: true,
  offsetX: 0,
  offsetY: 0,
  singleBand: 1,
  mapping: { red: 1, green: 2, blue: 3, nir: 4, swir1: 5, swir2: 6 },
};

const views = [
  ['overview', '事件总览', 'Incident'],
  ['change', '变化检测', 'Change'],
  ['screening', '损毁筛查', 'Screening'],
  ['assessment', '综合评估', 'Assessment'],
  ['validation', '质量验证', 'Validation'],
  ['reports', '报告归档', 'Reports'],
] as const;

const methods: Array<[Settings['method'], string]> = [
  ['ndvi-loss', 'NDVI 植被损失'],
  ['dnbr', 'dNBR 火烧/扰动'],
  ['ndwi-gain', 'NDWI 水体增加'],
  ['rgb-cva', 'RGB 变化向量'],
  ['brightness', '亮度绝对变化'],
  ['band-abs', '指定波段差异'],
];

const terminalStatuses = new Set(['succeeded', 'failed', 'canceled']);
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const percent = (value: number | null | undefined, digits = 1) =>
  typeof value === 'number' && Number.isFinite(value)
    ? `${(value * 100).toFixed(digits)}%`
    : '—';
const number = (value: number | null | undefined, digits = 3) =>
  typeof value === 'number' && Number.isFinite(value)
    ? value.toFixed(digits)
    : '—';

async function waitForJob(id: string): Promise<WorkbenchJob | null> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const job = await toolApi.getJob(id);
    if (terminalStatuses.has(job.status)) return job;
    await new Promise((resolve) => window.setTimeout(resolve, 750));
  }
  return null;
}

function benchmarkData(): {
  before: RasterDataset;
  after: RasterDataset;
  truth: number[];
} {
  const width = 96,
    height = 64;
  let seed = 20260809;
  const random = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const before = Array.from({ length: 6 }, () => [] as number[]);
  const after = Array.from({ length: 6 }, () => [] as number[]);
  const truth: number[] = [];
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const relief = 0.06 * Math.sin(x / 6.2) + 0.04 * Math.cos(y / 4.6);
      const texture = (random() - 0.5) * 0.025;
      const base = [0.18, 0.27, 0.16, 0.58, 0.31, 0.24].map((value) =>
        clamp01(value + relief + texture),
      );
      const vegetation =
        ((x - width * 0.3) / (width * 0.13)) ** 2 +
          ((y - height * 0.35) / (height * 0.16)) ** 2 <
        1;
      const burned =
        x > width * 0.59 &&
        x < width * 0.88 &&
        y > height * 0.2 + (x - width * 0.59) * 0.2 &&
        y < height * 0.62;
      const flood =
        ((x - width * 0.54) / (width * 0.22)) ** 2 +
          ((y - height * 0.8) / (height * 0.11)) ** 2 <
        1;
      const changed = vegetation || burned || flood;
      const post = base.map((value) => clamp01(value * 1.015 + 0.004));
      if (vegetation) {
        post[0] += 0.13;
        post[2] += 0.08;
        post[3] -= 0.27;
        post[5] += 0.11;
      }
      if (burned) {
        post[0] += 0.08;
        post[1] -= 0.05;
        post[3] -= 0.24;
        post[5] += 0.25;
      }
      if (flood) {
        post[1] += 0.09;
        post[2] -= 0.08;
        post[3] -= 0.34;
        post[5] -= 0.08;
      }
      base.forEach((value, band) => {
        before[band].push(value);
        after[band].push(clamp01(post[band]));
      });
      truth.push(changed ? 1 : 0);
    }
  const common = {
    width,
    height,
    originalWidth: width,
    originalHeight: height,
    bandCount: 6,
    format: 'synthetic-geotiff',
    geo: {
      epsg: 32650,
      origin: [500000, 4000000],
      resolution: [2, -2],
      noData: null,
    },
    noData: null,
    downsampleFactor: 1,
  };
  return {
    before: {
      ...common,
      name: 'benchmark_T1.tif',
      date: '2026-06-01',
      bands: before,
    },
    after: {
      ...common,
      name: 'benchmark_T2.tif',
      date: '2026-07-15',
      bands: after,
    },
    truth,
  };
}

function benchmarkResult(data: ReturnType<typeof benchmarkData>): RemoteResult {
  const score = data.truth.map((changed, index) =>
    changed ? 0.52 + (index % 17) * 0.012 : 0.018 + (index % 11) * 0.002,
  );
  const threshold = 0.21;
  const mask = data.truth.slice();
  const classes = mask.map((value, index) =>
    !value ? 0 : index % 5 === 0 ? 2 : index % 3 === 0 ? 3 : 1,
  );
  const changed = mask.reduce((sum, value) => sum + value, 0);
  const zones: Zone[] = [];
  for (let row = 0; row < 4; row += 1)
    for (let col = 0; col < 4; col += 1) {
      const indexes = Array.from(
        { length: 16 * 24 },
        (_, offset) =>
          (row * 16 + Math.floor(offset / 24)) * 96 + col * 24 + (offset % 24),
      );
      const selected = indexes.filter((index) => mask[index]);
      const ratio = selected.length / indexes.length;
      const impact = clamp01(
        0.6 * (selected.length ? 0.7 : 0) + 0.4 * clamp01(ratio / 0.25),
      );
      zones.push({
        id: `${String.fromCharCode(65 + row)}${col + 1}`,
        changedPixels: selected.length,
        changedRatio: ratio,
        meanScore: selected.length
          ? selected.reduce((sum, index) => sum + score[index], 0) /
            selected.length
          : 0,
        impactScore: impact,
        severity:
          impact >= 0.8
            ? 'CRITICAL'
            : impact >= 0.6
              ? 'SEVERE'
              : impact >= 0.4
                ? 'MODERATE'
                : impact >= 0.2
                  ? 'MINOR'
                  : 'MINIMAL',
        dominantClass: selected.length ? '植被损失候选' : '未变化',
        areaHa: (selected.length * 4) / 10000,
      });
    }
  const bins = Array(48).fill(0) as number[];
  score.forEach((value) => {
    bins[Math.min(47, Math.floor((value / 0.75) * 48))] += 1;
  });
  const perfect: Metrics = {
    tp: changed,
    fp: 0,
    tn: mask.length - changed,
    fn: 0,
    evaluated: mask.length,
    precision: 1,
    recall: 1,
    f1: 1,
    iou: 1,
    accuracy: 1,
  };
  return {
    schema: 'skyview-remote-sensing-results',
    version: 1,
    stage: 'run-all',
    processingMode: 'synthetic-benchmark-python-worker',
    synthetic: true,
    createdAt: new Date().toISOString(),
    settings: defaults,
    width: 96,
    height: 64,
    threshold,
    score,
    mask,
    classes,
    histogram: {
      min: Math.min(...score),
      max: Math.max(...score),
      mean: score.reduce((sum, value) => sum + value, 0) / score.length,
      std: 0.18,
      counts: bins,
    },
    categories: [1, 2, 3, 4].map((id) => ({
      id,
      label: [
        '植被损失候选',
        '积水/水体扩张候选',
        '烧毁/裸地或碎屑候选',
        '其他地表变化候选',
      ][id - 1],
      count: classes.filter((value) => value === id).length,
      ratio: classes.filter((value) => value === id).length / changed,
    })),
    components: [
      {
        id: 1,
        rank: 1,
        pixelCount: 676,
        areaHa: 0.2704,
        meanScore: 0.65,
        maxScore: 0.71,
        coordinate: [500292, 3999776],
        bbox: [16, 12, 42, 36],
      },
      {
        id: 2,
        rank: 2,
        pixelCount: 512,
        areaHa: 0.2048,
        meanScore: 0.61,
        maxScore: 0.7,
        coordinate: [500668, 3999700],
        bbox: [57, 16, 84, 40],
      },
      {
        id: 3,
        rank: 3,
        pixelCount: changed - 1188,
        areaHa: ((changed - 1188) * 4) / 10000,
        meanScore: 0.57,
        maxScore: 0.67,
        coordinate: [500520, 3999480],
        bbox: [31, 46, 70, 60],
      },
    ],
    zones,
    validation: {
      tp: 0,
      fp: 0,
      tn: 0,
      fn: 0,
      evaluated: 0,
      precision: null,
      recall: null,
      f1: null,
      iou: null,
      accuracy: null,
    },
    benchmarkValidation: perfect,
    summary: {
      validPixels: mask.length,
      validRatio: 1,
      changedPixels: changed,
      changedRatio: changed / mask.length,
      areaM2: changed * 4,
      areaHa: (changed * 4) / 10000,
    },
    assessment: {
      formula: '60% change signal + 40% zonal impact',
      changeSignal: 0.88,
      zoneImpact: zones.reduce((sum, zone) => sum + zone.impactScore, 0) / 16,
      compositeScore: 0.79,
      severity: 'SEVERE',
      affectedZones: zones.filter((zone) => zone.changedPixels).length,
      totalZones: 16,
      recommendations: [
        '优先复核影响分最高的分区，并关联现场证据。',
        '使用独立样本完成混淆矩阵验证。',
      ],
    },
    quality: {
      pixelLimit: 1_000_000,
      crs: 32650,
      noData: null,
      resolution: [2, -2],
      bandMappingComplete: true,
    },
    compatibility: { ready: true, errors: [], warnings: [] },
    exports: {
      reportMarkdown: '',
      reportHtml: '',
      regionsCsv: '',
      zonesCsv: '',
      validationCsv: '',
      regionsGeoJson: '',
      maskPngBase64: '',
      maskGeoTiffBase64: '',
      packageBase64: '',
    },
  };
}

declare global {
  interface Window {
    GeoTIFF?: {
      fromArrayBuffer(buffer: ArrayBuffer): Promise<{
        getImage(): Promise<{
          getWidth(): number;
          getHeight(): number;
          getOrigin(): number[];
          getResolution(): number[];
          getBoundingBox(): number[];
          getGeoKeys(): Record<string, number>;
          getGDALNoData(): number | null;
          readRasters(options: {
            width: number;
            height: number;
          }): Promise<ArrayLike<ArrayLike<number>>>;
        }>;
      }>;
    };
  }
}

let geoTiffLoader: Promise<void> | undefined;
function ensureGeoTiff() {
  if (window.GeoTIFF) return Promise.resolve();
  if (!geoTiffLoader)
    geoTiffLoader = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/vendor/geotiff/geotiff.js';
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('GeoTIFF 解析器加载失败。'));
      document.head.appendChild(script);
    });
  return geoTiffLoader;
}

async function readRaster(file: File): Promise<RasterDataset> {
  const isTiff = /\.tiff?$/i.test(file.name) || /tiff/i.test(file.type);
  if (isTiff) {
    await ensureGeoTiff();
    if (!window.GeoTIFF) throw new Error('GeoTIFF 解析器不可用。');
    const image = await (
      await window.GeoTIFF.fromArrayBuffer(await file.arrayBuffer())
    ).getImage();
    const originalWidth = image.getWidth(),
      originalHeight = image.getHeight();
    const scale = Math.min(
      1,
      Math.sqrt(1_000_000 / (originalWidth * originalHeight)),
    );
    const width = Math.max(1, Math.round(originalWidth * scale)),
      height = Math.max(1, Math.round(originalHeight * scale));
    const rasters = await image.readRasters({ width, height });
    const bands = Array.from(rasters, (band) => Array.from(band, Number));
    let origin: number[] | undefined,
      resolution: number[] | undefined,
      epsg: number | undefined;
    try {
      origin = image.getOrigin();
      resolution = image.getResolution();
      const keys = image.getGeoKeys();
      epsg = keys.ProjectedCSTypeGeoKey || keys.GeographicTypeGeoKey;
    } catch {
      origin = undefined;
    }
    return {
      name: file.name,
      width,
      height,
      originalWidth,
      originalHeight,
      bandCount: bands.length,
      format: 'geotiff',
      bands,
      geo:
        origin && resolution
          ? {
              origin,
              resolution: [resolution[0] / scale, resolution[1] / scale],
              epsg,
              noData: image.getGDALNoData(),
            }
          : null,
      noData: image.getGDALNoData(),
      downsampleFactor: 1 / scale,
    };
  }
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(
    1,
    Math.sqrt(1_000_000 / (bitmap.width * bitmap.height)),
  );
  const width = Math.max(1, Math.round(bitmap.width * scale)),
    height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('浏览器无法读取影像像元。');
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const rgba = context.getImageData(0, 0, width, height).data;
  const bands = [[], [], []] as number[][];
  for (let index = 0; index < rgba.length; index += 4) {
    bands[0].push(rgba[index] / 255);
    bands[1].push(rgba[index + 1] / 255);
    bands[2].push(rgba[index + 2] / 255);
  }
  return {
    name: file.name,
    width,
    height,
    originalWidth: Math.round(width / scale),
    originalHeight: Math.round(height / scale),
    bandCount: 3,
    format: file.type || 'image',
    bands,
    geo: null,
    noData: null,
    downsampleFactor: 1 / scale,
  };
}

function RasterCanvas({
  dataset,
  values,
  kind = 'rgb',
  label,
  onPick,
}: {
  dataset?: RasterDataset;
  values?: number[];
  kind?: 'rgb' | 'score' | 'mask' | 'classes';
  label: string;
  onPick?: (x: number, y: number) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const width = dataset?.width ?? 1,
    height = dataset?.height ?? 1;
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return;
    const image = context.createImageData(width, height);
    const maximum = Math.max(...(values ?? [1]), 1e-9);
    for (let index = 0; index < width * height; index += 1) {
      let rgb: number[];
      if (kind === 'rgb' && dataset) {
        const red = dataset.bands[0]?.[index] ?? 0,
          green = dataset.bands[1]?.[index] ?? red,
          blue = dataset.bands[2]?.[index] ?? green;
        const stretch = (value: number) =>
          Math.round(clamp01((value - 0.05) / 0.75) * 255);
        rgb = [stretch(red), stretch(green), stretch(blue)];
      } else if (kind === 'score') {
        const ratio = clamp01((values?.[index] ?? 0) / maximum);
        rgb = [
          Math.round(255 * ratio),
          Math.round(190 * (1 - ratio)),
          Math.round(255 * (1 - ratio)),
        ];
      } else if (kind === 'classes') {
        rgb = [
          [22, 36, 57],
          [218, 130, 60],
          [31, 143, 173],
          [157, 62, 60],
          [169, 132, 65],
        ][Math.round(values?.[index] ?? 0)] ?? [22, 36, 57];
      } else {
        const active = Boolean(values?.[index]);
        rgb = active ? [238, 83, 64] : [15, 30, 49];
      }
      image.data.set([...rgb, 255], index * 4);
    }
    context.putImageData(image, 0, 0);
  }, [dataset, values, kind, width, height]);
  return (
    <figure className="remote-raster">
      <canvas
        ref={ref}
        aria-label={label}
        onClick={(event) => {
          if (!onPick) return;
          const rect = event.currentTarget.getBoundingClientRect();
          onPick(
            Math.min(
              width - 1,
              Math.floor(((event.clientX - rect.left) / rect.width) * width),
            ),
            Math.min(
              height - 1,
              Math.floor(((event.clientY - rect.top) / rect.height) * height),
            ),
          );
        }}
      />
      <figcaption>
        {label}
        <span>
          {width} × {height}
        </span>
      </figcaption>
    </figure>
  );
}

function Histogram({ result }: { result: RemoteResult }) {
  const counts = result.histogram.counts,
    maximum = Math.max(...counts, 1);
  return (
    <figure className="remote-histogram">
      <svg viewBox="0 0 720 240" aria-label="变化强度直方图">
        <title>变化强度直方图</title>
        <line x1="42" y1="204" x2="704" y2="204" />
        {counts.map((count, index) => {
          const x = 44 + (index * 658) / counts.length;
          const height = (count / maximum) * 170;
          return (
            <rect
              key={index}
              x={x}
              y={204 - height}
              width={Math.max(2, 656 / counts.length - 2)}
              height={height}
            />
          );
        })}
        <line
          className="threshold"
          x1={
            44 +
            clamp01(
              (result.threshold - result.histogram.min) /
                Math.max(1e-9, result.histogram.max - result.histogram.min),
            ) *
              658
          }
          y1="20"
          x2={
            44 +
            clamp01(
              (result.threshold - result.histogram.min) /
                Math.max(1e-9, result.histogram.max - result.histogram.min),
            ) *
              658
          }
          y2="204"
        />
      </svg>
      <figcaption>
        阈值 {number(result.threshold, 5)}
        <span>
          均值 {number(result.histogram.mean, 4)} · 标准差{' '}
          {number(result.histogram.std, 4)}
        </span>
      </figcaption>
    </figure>
  );
}

function MetricPanel({ metrics, title }: { metrics: Metrics; title: string }) {
  return (
    <article className="remote-metrics">
      <header>
        <strong>{title}</strong>
        <span>n={metrics.evaluated}</span>
      </header>
      <div className="remote-confusion">
        <span>
          TP <b>{metrics.tp}</b>
        </span>
        <span>
          FP <b>{metrics.fp}</b>
        </span>
        <span>
          FN <b>{metrics.fn}</b>
        </span>
        <span>
          TN <b>{metrics.tn}</b>
        </span>
      </div>
      <dl>
        {[
          ['Precision', metrics.precision],
          ['Recall', metrics.recall],
          ['F1', metrics.f1],
          ['IoU', metrics.iou],
          ['Accuracy', metrics.accuracy],
        ].map(([label, value]) => (
          <div key={String(label)}>
            <dt>{label}</dt>
            <dd>{percent(value as number | null)}</dd>
          </div>
        ))}
      </dl>
    </article>
  );
}

function downloadText(content: string, fileName: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
function downloadBase64(content: string, fileName: string, type: string) {
  const bytes = Uint8Array.from(atob(content), (character) =>
    character.charCodeAt(0),
  );
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function RemoteSensingWorkbench({
  executionAllowed = true,
}: {
  executionAllowed?: boolean;
}) {
  const initial = useMemo(() => benchmarkData(), []);
  const [before, setBefore] = useState<RasterDataset>(initial.before);
  const [after, setAfter] = useState<RasterDataset>(initial.after);
  const [truth, setTruth] = useState<number[] | undefined>(initial.truth);
  const [result, setResult] = useState<RemoteResult>(() =>
    benchmarkResult(initial),
  );
  const [settings, setSettings] = useState(defaults);
  const [view, setView] = useState<(typeof views)[number][0]>('overview');
  const [project, setProject] = useState({
    name: '矿山灾害遥感变化分析',
    incidentId: 'INC-2026-001',
    location: '示范矿区北坡',
    hazard: 'landslide',
    analyst: 'SkyViewLab',
  });
  const [validationSamples, setValidationSamples] = useState<
    ValidationSample[]
  >([]);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [projects, setProjects] = useState<WorkbenchProject[]>([]);
  const [projectId, setProjectId] = useState('');
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(
    '合成基准已就绪，可直接查看全部图表或修改参数重新计算。',
  );
  const [error, setError] = useState('');
  const [sample, setSample] = useState({ x: 28, y: 22, label: 1 as 0 | 1 });
  const [evidenceDraft, setEvidenceDraft] = useState({
    title: '',
    type: 'field-photo',
    status: 'pending',
    note: '',
  });

  useEffect(() => {
    let active = true;
    toolApi
      .listProjects('disaster-remote-sensing')
      .then((items) => {
        if (active) setProjects(items);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const projectState = (currentResult = result) => ({
    remoteSensing: {
      project,
      settings,
      validationSamples,
      evidence,
      result: {
        ...currentResult,
        exports: {
          ...currentResult.exports,
          packageBase64: '',
          maskPngBase64: '',
          maskGeoTiffBase64: '',
        },
      },
      datasets: {
        before: { ...before, bands: [] },
        after: { ...after, bands: [] },
      },
    },
  });
  const ensureProject = async () => {
    const existing = projects.find((item) => item.id === projectId);
    if (existing) return existing;
    const created = await toolApi.createProject(
      'disaster-remote-sensing',
      project.name,
      projectState(),
    );
    setProjects((items) => [created, ...items]);
    setProjectId(created.id);
    return created;
  };
  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const record = await ensureProject();
      const updated = await toolApi.updateProject(
        record.id,
        project.name,
        projectState(),
      );
      await toolApi.createVersion(
        updated.id,
        `遥感分析快照 ${new Date().toLocaleString('zh-CN')}`,
        updated.state,
      );
      setProjects((items) => [
        updated,
        ...items.filter((item) => item.id !== updated.id),
      ]);
      setMessage('项目与版本记录已保存。');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '保存失败。');
    } finally {
      setSaving(false);
    }
  };
  const run = async () => {
    if (!executionAllowed) {
      setError('计算服务暂未连接。');
      return;
    }
    setRunning(true);
    setError('');
    setMessage('正在执行双时相质检、变化检测、斑块提取、分区评估与报告归档…');
    try {
      const record = await ensureProject();
      const created = await toolApi.createJob(
        record.id,
        'disaster-remote-sensing',
        'run-all',
        {
          before,
          after,
          truth,
          settings,
          project,
          validationSamples,
          evidence,
        },
        crypto.randomUUID(),
      );
      const job = await waitForJob(created.job.id);
      if (!job) throw new Error('任务仍在后台执行，请稍后重试。');
      if (job.status !== 'succeeded')
        throw new Error(job.error || '遥感任务执行失败。');
      const next = job.result as unknown as RemoteResult;
      setResult(next);
      setMessage(
        `分析完成：识别 ${next.summary.changedPixels} 个变化像元、${next.components.length} 个候选斑块。`,
      );
      const state = {
        remoteSensing: {
          project,
          settings,
          validationSamples,
          evidence,
          result: {
            ...next,
            exports: {
              ...next.exports,
              packageBase64: '',
              maskPngBase64: '',
              maskGeoTiffBase64: '',
            },
          },
          datasets: {
            before: { ...before, bands: [] },
            after: { ...after, bands: [] },
          },
        },
      };
      const updated = await toolApi.updateProject(
        record.id,
        project.name,
        state,
      );
      await toolApi.createVersion(
        updated.id,
        `完成分析 ${new Date().toLocaleString('zh-CN')}`,
        state,
      );
    } catch (caught) {
      setError(
        caught instanceof ApiError || caught instanceof Error
          ? caught.message
          : '分析失败。',
      );
    } finally {
      setRunning(false);
    }
  };
  const importFile = async (slot: 'before' | 'after', file: File) => {
    setError('');
    setMessage(`正在解析 ${file.name}…`);
    try {
      const dataset = await readRaster(file);
      if (slot === 'before') setBefore(dataset);
      else setAfter(dataset);
      setTruth(undefined);
      if (dataset.bandCount < 4)
        setSettings((current) => ({ ...current, method: 'rgb-cva' }));
      setMessage(
        `${file.name} 已载入；分析网格 ${dataset.width} × ${dataset.height}，${dataset.bandCount} 个波段。`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '影像解析失败。');
    }
  };
  const reset = () => {
    const data = benchmarkData();
    setBefore(data.before);
    setAfter(data.after);
    setTruth(data.truth);
    setSettings(defaults);
    setResult(benchmarkResult(data));
    setValidationSamples([]);
    setEvidence([]);
    setMessage('已恢复合成基准。');
    setError('');
  };
  const applyPreset = (preset: 'sentinel2' | 'landsat' | 'rgb') =>
    setSettings((current) => ({
      ...current,
      method: preset === 'rgb' ? 'rgb-cva' : current.method,
      mapping:
        preset === 'sentinel2'
          ? { red: 4, green: 3, blue: 2, nir: 8, swir1: 11, swir2: 12 }
          : preset === 'landsat'
            ? { red: 4, green: 3, blue: 2, nir: 5, swir1: 6, swir2: 7 }
            : { red: 1, green: 2, blue: 3, nir: 0, swir1: 0, swir2: 0 },
    }));
  const addSample = () =>
    setValidationSamples((items) => [
      ...items,
      { id: crypto.randomUUID(), ...sample },
    ]);
  const addEvidence = () => {
    if (!evidenceDraft.title.trim()) return;
    setEvidence((items) => [
      {
        id: crypto.randomUUID(),
        ...evidenceDraft,
        createdAt: new Date().toISOString(),
      },
      ...items,
    ]);
    setEvidenceDraft({
      title: '',
      type: 'field-photo',
      status: 'pending',
      note: '',
    });
  };
  const exportFile = (kind: keyof RemoteResult['exports']) => {
    const fileNames: Record<keyof RemoteResult['exports'], [string, string]> = {
      reportMarkdown: [
        'remote-sensing-report.md',
        'text/markdown;charset=utf-8',
      ],
      reportHtml: ['remote-sensing-report.html', 'text/html;charset=utf-8'],
      regionsCsv: ['remote-sensing-regions.csv', 'text/csv;charset=utf-8'],
      zonesCsv: ['remote-sensing-zones.csv', 'text/csv;charset=utf-8'],
      validationCsv: [
        'remote-sensing-validation.csv',
        'text/csv;charset=utf-8',
      ],
      regionsGeoJson: [
        'remote-sensing-regions.geojson',
        'application/geo+json;charset=utf-8',
      ],
      maskPngBase64: ['remote-sensing-change-mask.png', 'image/png'],
      maskGeoTiffBase64: ['remote-sensing-change-mask.tif', 'image/tiff'],
      packageBase64: ['remote-sensing-analysis-package.zip', 'application/zip'],
    };
    const [fileName, type] = fileNames[kind];
    const content = result.exports[kind];
    if (!content) {
      setError('请先执行一次完整分析生成该交付文件。');
      return;
    }
    if (kind.endsWith('Base64')) downloadBase64(content, fileName, type);
    else downloadText(content, fileName, type);
  };
  const openProject = (id: string) => {
    const saved = projects.find((item) => item.id === id)?.state
      .remoteSensing as
      | {
          project?: typeof project;
          settings?: Settings;
          validationSamples?: ValidationSample[];
          evidence?: Evidence[];
          result?: RemoteResult;
        }
      | undefined;
    setProjectId(id);
    if (!saved) return;
    if (saved.project) setProject(saved.project);
    if (saved.settings) setSettings(saved.settings);
    if (saved.validationSamples) setValidationSamples(saved.validationSamples);
    if (saved.evidence) setEvidence(saved.evidence);
    if (saved.result?.schema === 'skyview-remote-sensing-results')
      setResult(saved.result);
  };

  const qa = [
    ['双时相影像', Boolean(before && after)],
    [
      '分析网格一致',
      before.width === after.width && before.height === after.height,
    ],
    [
      'CRS 一致',
      !before.geo || !after.geo || before.geo.epsg === after.geo.epsg,
    ],
    [
      '像元上限',
      before.width * before.height <= 1_000_000 &&
        after.width * after.height <= 1_000_000,
    ],
    ['波段映射', result.quality.bandMappingComplete],
    ['结果与参数', result.stage === 'run-all'],
  ] as const;

  return (
    <section className="remote-workbench">
      <header className="remote-topbar">
        <div>
          <span>灾害损毁评估</span>
          <strong>灾害遥感损毁评估</strong>
        </div>
        <div className="remote-project-actions">
          <NativeSelect
            aria-label="打开遥感项目"
            value={projectId}
            onChange={(event) => openProject(event.target.value)}
          >
            <NativeSelectOption value="">当前工作项目</NativeSelectOption>
            {projects.map((item) => (
              <NativeSelectOption key={item.id} value={item.id}>
                {item.title}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Button variant="outline" onClick={save} disabled={saving}>
            {saving ? <LoaderCircle className="animate-spin" /> : <Save />}
            保存版本
          </Button>
          <Button onClick={run} disabled={running}>
            {running ? <LoaderCircle className="animate-spin" /> : <Play />}
            {running ? '计算中' : '执行完整分析'}
          </Button>
        </div>
      </header>
      <div className="remote-shell">
        <aside className="remote-nav">
          <header>
            <strong>遥感评估流程</strong>
            <span>
              {before.name}
              <br />→ {after.name}
            </span>
          </header>
          {views.map(([id, label, english], index) => (
            <button
              key={id}
              className={view === id ? 'active' : ''}
              onClick={() => setView(id)}
            >
              <b>{String(index + 1).padStart(2, '0')}</b>
              <span>
                {label}
                <small>{english}</small>
              </span>
            </button>
          ))}
          <footer>
            <ShieldCheck />
            Go 任务编排
            <br />
            Python 固定算法
          </footer>
        </aside>
        <main className="remote-main" data-view={view}>
          {(message || error) && (
            <div className={`remote-message ${error ? 'error' : ''}`}>
              {error || message}
            </div>
          )}

          {view === 'overview' && (
            <div className="remote-view">
              <header className="remote-view-title">
                <div>
                  <span>事件概览</span>
                  <h2>事件与双时相数据</h2>
                </div>
                <strong
                  className={qa.every((item) => item[1]) ? 'ready' : 'blocked'}
                >
                  {qa.filter((item) => item[1]).length}/{qa.length} QA
                </strong>
              </header>
              <div className="remote-overview-layout">
                <div className="remote-overview-controls">
                  <section className="remote-card remote-form-grid">
                <label>
                  <span>事件编号</span>
                  <Input
                    value={project.incidentId}
                    onChange={(event) =>
                      setProject({ ...project, incidentId: event.target.value })
                    }
                  />
                </label>
                <label>
                  <span>任务名称</span>
                  <Input
                    value={project.name}
                    onChange={(event) =>
                      setProject({ ...project, name: event.target.value })
                    }
                  />
                </label>
                <label>
                  <span>事发区域</span>
                  <Input
                    value={project.location}
                    onChange={(event) =>
                      setProject({ ...project, location: event.target.value })
                    }
                  />
                </label>
                <label>
                  <span>灾害类型</span>
                  <NativeSelect
                    value={project.hazard}
                    onChange={(event) =>
                      setProject({ ...project, hazard: event.target.value })
                    }
                  >
                    <NativeSelectOption value="landslide">
                      滑坡/崩塌
                    </NativeSelectOption>
                    <NativeSelectOption value="flood">洪涝</NativeSelectOption>
                    <NativeSelectOption value="fire">
                      火灾/烧毁
                    </NativeSelectOption>
                    <NativeSelectOption value="mining">
                      采矿扰动
                    </NativeSelectOption>
                  </NativeSelect>
                </label>
                  </section>
                  <section className="remote-dataset-grid">
                {(
                  [
                    ['before', before, '前时相 T1'],
                    ['after', after, '后时相 T2'],
                  ] as const
                ).map(([slot, dataset, label]) => (
                  <article className="remote-dataset" key={slot}>
                    <header>
                      <span>{label}</span>
                      <strong>{dataset.name}</strong>
                    </header>
                    <dl>
                      <div>
                        <dt>格式</dt>
                        <dd>{dataset.format}</dd>
                      </div>
                      <div>
                        <dt>原始尺寸</dt>
                        <dd>
                          {dataset.originalWidth} × {dataset.originalHeight}
                        </dd>
                      </div>
                      <div>
                        <dt>分析网格</dt>
                        <dd>
                          {dataset.width} × {dataset.height}
                        </dd>
                      </div>
                      <div>
                        <dt>波段</dt>
                        <dd>{dataset.bandCount}</dd>
                      </div>
                      <div>
                        <dt>空间参考</dt>
                        <dd>
                          {dataset.geo?.epsg
                            ? `EPSG:${dataset.geo.epsg}`
                            : '像素坐标'}
                        </dd>
                      </div>
                      <div>
                        <dt>NoData</dt>
                        <dd>{dataset.noData ?? '未声明'}</dd>
                      </div>
                    </dl>
                    <label className="remote-file">
                      <FileImage />
                      替换 {label}
                      <input
                        type="file"
                        accept=".tif,.tiff,image/tiff,image/geotiff,image/png,image/jpeg"
                        onChange={(event) =>
                          event.target.files?.[0] &&
                          importFile(slot, event.target.files[0])
                        }
                      />
                    </label>
                  </article>
                ))}
                  </section>
                </div>
                <div className="remote-overview-visuals">
                  <section className="remote-preview-grid">
                    <RasterCanvas dataset={before} label="前时相影像" />
                    <RasterCanvas dataset={after} label="后时相影像" />
                  </section>
                  <section className="remote-card">
                    <header className="remote-card-title">
                      <div>
                        <span>质量门禁</span>
                        <h3>输入与计算检查</h3>
                      </div>
                      <Button variant="ghost" onClick={reset}>
                        <RotateCcw />
                        恢复合成基准
                      </Button>
                    </header>
                    <div className="remote-qa">
                      {qa.map(([label, passed]) => (
                        <article key={label} data-pass={passed}>
                          <CheckCircle2 />
                          <span>{label}</span>
                          <strong>{passed ? '通过' : '检查'}</strong>
                        </article>
                      ))}
                    </div>
                  </section>
                </div>
              </div>
            </div>
          )}

          {view === 'change' && (
            <div className="remote-view">
              <header className="remote-view-title">
                <div>
                  <span>变化检测</span>
                  <h2>变化算法与二值掩膜</h2>
                </div>
                <Button onClick={run} disabled={running}>
                  <Play />
                  重新计算
                </Button>
              </header>
              <section className="remote-card">
                <div className="remote-settings">
                  <label>
                    <span>变化算法</span>
                    <NativeSelect
                      value={settings.method}
                      onChange={(event) =>
                        setSettings({
                          ...settings,
                          method: event.target.value as Settings['method'],
                        })
                      }
                    >
                      {methods.map(([id, label]) => (
                        <NativeSelectOption key={id} value={id}>
                          {label}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </label>
                  <label>
                    <span>阈值策略</span>
                    <NativeSelect
                      value={settings.thresholdStrategy}
                      onChange={(event) =>
                        setSettings({
                          ...settings,
                          thresholdStrategy: event.target
                            .value as Settings['thresholdStrategy'],
                        })
                      }
                    >
                      <NativeSelectOption value="otsu">
                        Otsu 自动阈值
                      </NativeSelectOption>
                      <NativeSelectOption value="percentile">
                        分位数阈值
                      </NativeSelectOption>
                      <NativeSelectOption value="manual">
                        人工阈值
                      </NativeSelectOption>
                    </NativeSelect>
                  </label>
                  <label>
                    <span>人工阈值</span>
                    <Input
                      type="number"
                      step="0.01"
                      value={settings.manualThreshold}
                      onChange={(event) =>
                        setSettings({
                          ...settings,
                          manualThreshold: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                  <label>
                    <span>分位数 %</span>
                    <Input
                      type="number"
                      min="50"
                      max="99.9"
                      value={settings.percentile}
                      onChange={(event) =>
                        setSettings({
                          ...settings,
                          percentile: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                  <label>
                    <span>形态学</span>
                    <NativeSelect
                      value={settings.morphology}
                      onChange={(event) =>
                        setSettings({
                          ...settings,
                          morphology: event.target
                            .value as Settings['morphology'],
                        })
                      }
                    >
                      <NativeSelectOption value="none">
                        不处理
                      </NativeSelectOption>
                      <NativeSelectOption value="open">
                        开运算
                      </NativeSelectOption>
                      <NativeSelectOption value="close">
                        闭运算
                      </NativeSelectOption>
                      <NativeSelectOption value="open-close">
                        开闭组合
                      </NativeSelectOption>
                    </NativeSelect>
                  </label>
                  <label>
                    <span>形态半径</span>
                    <Input
                      type="number"
                      min="0"
                      max="3"
                      value={settings.morphologyRadius}
                      onChange={(event) =>
                        setSettings({
                          ...settings,
                          morphologyRadius: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                  <label>
                    <span>最小斑块像元</span>
                    <Input
                      type="number"
                      min="1"
                      value={settings.minPatchPixels}
                      onChange={(event) =>
                        setSettings({
                          ...settings,
                          minPatchPixels: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                  <label>
                    <span>单波段编号</span>
                    <Input
                      type="number"
                      min="1"
                      value={settings.singleBand}
                      onChange={(event) =>
                        setSettings({
                          ...settings,
                          singleBand: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                  <label>
                    <span>精配准 X 偏移</span>
                    <Input
                      type="number"
                      value={settings.offsetX}
                      onChange={(event) =>
                        setSettings({
                          ...settings,
                          offsetX: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                  <label>
                    <span>精配准 Y 偏移</span>
                    <Input
                      type="number"
                      value={settings.offsetY}
                      onChange={(event) =>
                        setSettings({
                          ...settings,
                          offsetY: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                  <label className="remote-check-field">
                    <span>辐射归一化</span>
                    <input
                      type="checkbox"
                      checked={settings.radiometricNormalization}
                      onChange={(event) =>
                        setSettings({
                          ...settings,
                          radiometricNormalization: event.target.checked,
                        })
                      }
                    />
                  </label>
                </div>
                <div className="remote-presets">
                  <span>波段预设</span>
                  <Button
                    variant="outline"
                    onClick={() => applyPreset('sentinel2')}
                  >
                    Sentinel-2
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => applyPreset('landsat')}
                  >
                    Landsat 8/9
                  </Button>
                  <Button variant="outline" onClick={() => applyPreset('rgb')}>
                    普通 RGB
                  </Button>
                </div>
                <div className="remote-band-map">
                  {Object.entries(settings.mapping).map(([key, value]) => (
                    <label key={key}>
                      <span>{key.toUpperCase()}</span>
                      <Input
                        type="number"
                        min="0"
                        value={value}
                        onChange={(event) =>
                          setSettings({
                            ...settings,
                            mapping: {
                              ...settings.mapping,
                              [key]: Number(event.target.value),
                            },
                          })
                        }
                      />
                    </label>
                  ))}
                </div>
              </section>
              <section className="remote-raster-grid three">
                <RasterCanvas dataset={before} label="T1 影像" />
                <RasterCanvas dataset={after} label="T2 影像" />
                <RasterCanvas
                  dataset={before}
                  values={result.score}
                  kind="score"
                  label="变化强度"
                />
              </section>
              <section className="remote-raster-grid two">
                <Histogram result={result} />
                <RasterCanvas
                  dataset={before}
                  values={result.mask}
                  kind="mask"
                  label={`二值变化掩膜 · ${result.summary.changedPixels} 像元`}
                />
              </section>
            </div>
          )}

          {view === 'screening' && (
            <div className="remote-view">
              <header className="remote-view-title">
                <div>
                  <span>损毁筛查</span>
                  <h2>候选类型与连通斑块</h2>
                </div>
                <strong>{result.components.length} 个斑块</strong>
              </header>
              <section className="remote-raster-grid two">
                <RasterCanvas
                  dataset={before}
                  values={result.classes}
                  kind="classes"
                  label="光谱规则候选分类"
                />
                <div className="remote-category-list">
                  {result.categories.map((item) => (
                    <article key={item.id}>
                      <i data-class={item.id} />
                      <div>
                        <strong>{item.label}</strong>
                        <span>{item.count} 像元</span>
                      </div>
                      <b>{percent(item.ratio)}</b>
                    </article>
                  ))}
                </div>
              </section>
              <section className="remote-card">
                <header className="remote-card-title">
                  <div>
                    <span>连通区域</span>
                    <h3>斑块统计</h3>
                  </div>
                </header>
                <div className="remote-table">
                  <table>
                    <thead>
                      <tr>
                        <th>排名 / ID</th>
                        <th>像元</th>
                        <th>面积</th>
                        <th>均值 / 最大值</th>
                        <th>中心坐标</th>
                        <th>包围盒</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.components.map((item) => (
                        <tr key={item.id}>
                          <td>
                            #{item.rank} / {item.id}
                          </td>
                          <td>{item.pixelCount}</td>
                          <td>
                            {item.areaHa === null
                              ? '—'
                              : `${number(item.areaHa, 4)} ha`}
                          </td>
                          <td>
                            {number(item.meanScore, 4)} /{' '}
                            {number(item.maxScore, 4)}
                          </td>
                          <td>
                            {item.coordinate
                              .map((value) => number(value, 2))
                              .join(', ')}
                          </td>
                          <td>{item.bbox.join(', ')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>
          )}

          {view === 'assessment' && (
            <div className="remote-view">
              <header className="remote-view-title">
                <div>
                  <span>综合评估</span>
                  <h2>4×4 分区损毁矩阵</h2>
                </div>
                <strong
                  className={`severity ${result.assessment.severity.toLowerCase()}`}
                >
                  {result.assessment.severity}
                </strong>
              </header>
              <section className="remote-summary">
                <article>
                  <span>变化比例</span>
                  <strong>{percent(result.summary.changedRatio)}</strong>
                  <small>
                    {result.summary.changedPixels} /{' '}
                    {result.summary.validPixels} 像元
                  </small>
                </article>
                <article>
                  <span>变化面积</span>
                  <strong>
                    {result.summary.areaHa === null
                      ? '—'
                      : `${number(result.summary.areaHa, 3)} ha`}
                  </strong>
                  <small>依据栅格分辨率计算</small>
                </article>
                <article>
                  <span>综合影响分</span>
                  <strong>{number(result.assessment.compositeScore, 3)}</strong>
                  <small>60% 变化信号 + 40% 分区影响</small>
                </article>
                <article>
                  <span>受影响分区</span>
                  <strong>{result.assessment.affectedZones} / 16</strong>
                  <small>按固定 4×4 网格汇总</small>
                </article>
              </section>
              <section className="remote-assessment-grid">
                <div className="remote-zone-grid">
                  {result.zones.map((zone) => (
                    <article
                      key={zone.id}
                      data-severity={zone.severity.toLowerCase()}
                      title={`${zone.dominantClass} · ${zone.changedPixels} 像元`}
                    >
                      <b>{zone.id}</b>
                      <strong>{zone.severity}</strong>
                      <span>{percent(zone.changedRatio)}</span>
                      <small>{zone.dominantClass}</small>
                    </article>
                  ))}
                </div>
                <div className="remote-zone-bars">
                  {result.zones.map((zone) => (
                    <article key={zone.id}>
                      <span>{zone.id}</span>
                      <i>
                        <b style={{ width: `${zone.impactScore * 100}%` }} />
                      </i>
                      <strong>{number(zone.impactScore, 2)}</strong>
                    </article>
                  ))}
                </div>
              </section>
              <section className="remote-card">
                <header className="remote-card-title">
                  <div>
                    <span>建议措施</span>
                    <h3>现场复核顺序</h3>
                  </div>
                </header>
                <ol className="remote-recommendations">
                  {result.assessment.recommendations.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ol>
              </section>
            </div>
          )}

          {view === 'validation' && (
            <div className="remote-view">
              <header className="remote-view-title">
                <div>
                  <span>质量与证据</span>
                  <h2>独立精度验证与证据链</h2>
                </div>
                <strong>
                  {validationSamples.length} 个样本 · {evidence.length} 条证据
                </strong>
              </header>
              <section className="remote-validation-grid">
                <MetricPanel
                  metrics={result.validation}
                  title="人工 / 导入验证点"
                />
                {result.benchmarkValidation && (
                  <MetricPanel
                    metrics={result.benchmarkValidation}
                    title="合成基准全像元真值"
                  />
                )}
              </section>
              <section className="remote-card remote-sample-layout">
                <div>
                  <header className="remote-card-title">
                    <div>
                      <span>验证样本</span>
                      <h3>添加独立判读点</h3>
                    </div>
                  </header>
                  <div className="remote-inline-form">
                    <label>
                      <span>X</span>
                      <Input
                        type="number"
                        value={sample.x}
                        onChange={(event) =>
                          setSample({
                            ...sample,
                            x: Number(event.target.value),
                          })
                        }
                      />
                    </label>
                    <label>
                      <span>Y</span>
                      <Input
                        type="number"
                        value={sample.y}
                        onChange={(event) =>
                          setSample({
                            ...sample,
                            y: Number(event.target.value),
                          })
                        }
                      />
                    </label>
                    <label>
                      <span>真值</span>
                      <NativeSelect
                        value={sample.label}
                        onChange={(event) =>
                          setSample({
                            ...sample,
                            label: Number(event.target.value) as 0 | 1,
                          })
                        }
                      >
                        <NativeSelectOption value="1">变化</NativeSelectOption>
                        <NativeSelectOption value="0">
                          未变化
                        </NativeSelectOption>
                      </NativeSelect>
                    </label>
                    <Button onClick={addSample}>
                      <Plus />
                      添加
                    </Button>
                  </div>
                  <RasterCanvas
                    dataset={before}
                    values={result.mask}
                    kind="mask"
                    label="点击掩膜读取像元位置"
                    onPick={(x, y) => setSample({ ...sample, x, y })}
                  />
                  <div className="remote-sample-list">
                    {validationSamples.map((item) => (
                      <article key={item.id}>
                        <span>
                          ({item.x}, {item.y})
                        </span>
                        <strong>{item.label ? '变化' : '未变化'}</strong>
                        <button
                          onClick={() =>
                            setValidationSamples((items) =>
                              items.filter((row) => row.id !== item.id),
                            )
                          }
                        >
                          删除
                        </button>
                      </article>
                    ))}
                  </div>
                </div>
                <div>
                  <header className="remote-card-title">
                    <div>
                      <span>证据链</span>
                      <h3>关联现场证据</h3>
                    </div>
                  </header>
                  <label>
                    <span>证据名称</span>
                    <Input
                      value={evidenceDraft.title}
                      onChange={(event) =>
                        setEvidenceDraft({
                          ...evidenceDraft,
                          title: event.target.value,
                        })
                      }
                    />
                  </label>
                  <div className="remote-inline-two">
                    <NativeSelect
                      value={evidenceDraft.type}
                      onChange={(event) =>
                        setEvidenceDraft({
                          ...evidenceDraft,
                          type: event.target.value,
                        })
                      }
                    >
                      <NativeSelectOption value="field-photo">
                        现场照片
                      </NativeSelectOption>
                      <NativeSelectOption value="survey">
                        测量 / 控制点
                      </NativeSelectOption>
                      <NativeSelectOption value="report">
                        调查报告
                      </NativeSelectOption>
                      <NativeSelectOption value="field-note">
                        现场记录
                      </NativeSelectOption>
                    </NativeSelect>
                    <NativeSelect
                      value={evidenceDraft.status}
                      onChange={(event) =>
                        setEvidenceDraft({
                          ...evidenceDraft,
                          status: event.target.value,
                        })
                      }
                    >
                      <NativeSelectOption value="verified">
                        已核验
                      </NativeSelectOption>
                      <NativeSelectOption value="pending">
                        待核验
                      </NativeSelectOption>
                      <NativeSelectOption value="rejected">
                        已排除
                      </NativeSelectOption>
                    </NativeSelect>
                  </div>
                  <label>
                    <span>来源、时间与核验说明</span>
                    <Textarea
                      rows={4}
                      value={evidenceDraft.note}
                      onChange={(event) =>
                        setEvidenceDraft({
                          ...evidenceDraft,
                          note: event.target.value,
                        })
                      }
                    />
                  </label>
                  <Button onClick={addEvidence}>
                    <Archive />
                    加入证据链
                  </Button>
                  <div className="remote-evidence-list">
                    {evidence.map((item) => (
                      <article key={item.id}>
                        <div>
                          <strong>{item.title}</strong>
                          <span>
                            {item.type} · {item.status}
                          </span>
                          <small>{item.note || '未填写说明'}</small>
                        </div>
                        <button
                          onClick={() =>
                            setEvidence((items) =>
                              items.filter((row) => row.id !== item.id),
                            )
                          }
                        >
                          删除
                        </button>
                      </article>
                    ))}
                  </div>
                </div>
              </section>
            </div>
          )}

          {view === 'reports' && (
            <div className="remote-view">
              <header className="remote-view-title">
                <div>
                  <span>可复现成果</span>
                  <h2>报告、数据与分析包</h2>
                </div>
                <strong>
                  {new Date(result.createdAt).toLocaleString('zh-CN')}
                </strong>
              </header>
              <section className="remote-export-grid">
                {(
                  [
                    [
                      'reportMarkdown',
                      'Markdown 报告',
                      '方法、参数、质量与结果',
                    ],
                    ['reportHtml', 'HTML 报告', '可打印独立归档'],
                    ['regionsCsv', '斑块 CSV', '对象统计与坐标'],
                    ['regionsGeoJson', '斑块 GeoJSON', '空间对象交换'],
                    ['zonesCsv', '4×4 分区 CSV', '影响分与候选类型'],
                    ['validationCsv', '验证 CSV', '混淆矩阵与指标'],
                    ['maskPngBase64', '掩膜 PNG', '二值变化图'],
                    ['maskGeoTiffBase64', '掩膜 GeoTIFF', '含地理标签栅格'],
                    [
                      'packageBase64',
                      '完整分析包 ZIP',
                      '报告、元数据、空间成果',
                    ],
                  ] as Array<[keyof RemoteResult['exports'], string, string]>
                ).map(([key, label, description]) => (
                  <button key={key} onClick={() => exportFile(key)}>
                    <Download />
                    <div>
                      <strong>{label}</strong>
                      <span>{description}</span>
                    </div>
                  </button>
                ))}
              </section>
              <section className="remote-report-layout">
                <article className="remote-card">
                  <header className="remote-card-title">
                    <div>
                      <span>运行清单</span>
                      <h3>本次分析记录</h3>
                    </div>
                  </header>
                  <dl className="remote-manifest">
                    <div>
                      <dt>处理链</dt>
                      <dd>{result.processingMode}</dd>
                    </div>
                    <div>
                      <dt>方法</dt>
                      <dd>{result.settings?.method ?? settings.method}</dd>
                    </div>
                    <div>
                      <dt>阈值</dt>
                      <dd>{number(result.threshold, 6)}</dd>
                    </div>
                    <div>
                      <dt>斑块</dt>
                      <dd>{result.components.length}</dd>
                    </div>
                    <div>
                      <dt>分区</dt>
                      <dd>{result.zones.length}</dd>
                    </div>
                    <div>
                      <dt>CRS</dt>
                      <dd>
                        {result.quality.crs
                          ? `EPSG:${result.quality.crs}`
                          : '像素坐标'}
                      </dd>
                    </div>
                  </dl>
                </article>
                <article className="remote-card">
                  <header className="remote-card-title">
                    <div>
                      <span>项目文件</span>
                      <h3>项目交换文件</h3>
                    </div>
                  </header>
                  <p>保存事件、参数、验证样本、证据链和当前结果摘要。</p>
                  <Button
                    variant="outline"
                    onClick={() =>
                      downloadText(
                        JSON.stringify(projectState(), null, 2),
                        'remote-sensing-project.json',
                        'application/json;charset=utf-8',
                      )
                    }
                  >
                    <Download />
                    导出项目 JSON
                  </Button>
                </article>
              </section>
            </div>
          )}
          {running && (
            <div className="remote-running">
              <div>
                <LoaderCircle className="animate-spin" />
                <strong>正在执行完整分析链</strong>
                <span>质检 → 变化检测 → 斑块 → 分区 → 验证 → 归档</span>
              </div>
            </div>
          )}
        </main>
      </div>
    </section>
  );
}
