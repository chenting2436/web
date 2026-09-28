'use client';

import { useSyncExternalStore, type CSSProperties } from 'react';
import {
  Activity,
  Archive,
  Check,
  Database,
  Download,
  Gauge,
  Layers3,
  Network,
  Play,
  RadioTower,
  Search,
  Settings2,
  SlidersHorizontal,
} from 'lucide-react';

type Concept = {
  id: string;
  name: string;
  summary: string;
  traits: string[];
  layout: string;
  recommendation?: string;
};

const concepts: Concept[] = [
  {
    id: 'A',
    name: '浮岛中台',
    summary: '取消连续分割线，让导航、数据与工具像独立浮岛一样落在工作区中。',
    traits: ['圆角小按钮', '模块有呼吸感', '主图表最突出'],
    layout: 'islands',
    recommendation: '最接近你的描述',
  },
  {
    id: 'B',
    name: '画布优先',
    summary: '图表和数据流画布铺满主体，台站与参数以悬浮工具盘覆盖在边缘。',
    traits: ['最大可视区域', '悬浮工具盘', '适合复杂图表'],
    layout: 'canvas',
  },
  {
    id: 'C',
    name: '胶囊工具带',
    summary: '把阶段和常用操作收进两条胶囊工具带，正文区域尽量保持干净。',
    traits: ['按钮感最强', '操作路径短', '适合触控'],
    layout: 'capsule',
  },
  {
    id: 'D',
    name: '侧轨工作台',
    summary: '左侧只保留图标轨道，点选后再展开工具，避免长期占用大块空间。',
    traits: ['窄侧轨', '按需展开', '内容面积大'],
    layout: 'rail',
  },
  {
    id: 'E',
    name: '层叠任务台',
    summary: '核心结果在底层持续可见，参数、台站和质检以可收起任务片叠放。',
    traits: ['非对称布局', '层级明显', '适合多步骤任务'],
    layout: 'layers',
  },
  {
    id: 'F',
    name: '无框研究台',
    summary: '尽量不用卡片边框，只通过留白、底色和少量按钮组织信息。',
    traits: ['最少矩形框', '阅读轻松', '界面最克制'],
    layout: 'borderless',
  },
];

const storageKey = 'skyviewlab.style-concept.v2';
const selectionEvent = 'skyviewlab:style-concept-v2-change';

function readSelection() {
  return typeof window === 'undefined' ? '' : window.localStorage.getItem(storageKey) ?? '';
}

function subscribeSelection(callback: () => void) {
  const handleStorage = (event: StorageEvent) => {
    if (!event.key || event.key === storageKey) callback();
  };
  window.addEventListener('storage', handleStorage);
  window.addEventListener(selectionEvent, callback);
  return () => {
    window.removeEventListener('storage', handleStorage);
    window.removeEventListener(selectionEvent, callback);
  };
}

function HeaderActions() {
  return (
    <div className="ref-icon-actions">
      <button type="button" aria-label="搜索"><Search /></button>
      <button type="button" aria-label="导出"><Download /></button>
      <button type="button" className="primary"><Play />运行</button>
    </div>
  );
}

function SignalChart() {
  return (
    <svg className="ref-signal" viewBox="0 0 560 210" aria-labelledby="ref-signal-title">
      <title id="ref-signal-title">面波背景噪声处理前后波形</title>
      <g className="ref-grid-lines">
        <path d="M0 35H560M0 70H560M0 105H560M0 140H560M0 175H560" />
        <path d="M70 0V210M140 0V210M210 0V210M280 0V210M350 0V210M420 0V210M490 0V210" />
      </g>
      <path className="ref-wave raw" d="M0 112 C22 20 44 187 66 95 S110 31 132 120 S176 186 198 90 S242 27 264 116 S308 178 330 86 S374 35 396 112 S440 170 462 90 S510 38 560 108" />
      <path className="ref-wave" d="M0 108 C18 73 36 141 54 104 S90 76 108 109 S144 136 162 103 S198 72 216 110 S252 140 270 101 S306 76 324 107 S360 134 378 99 S414 79 432 105 S468 130 486 98 S522 82 560 104" />
    </svg>
  );
}

function StageButtons() {
  return (
    <nav className="ref-stage-buttons" aria-label="成像处理步骤">
      {['总览', '台站', '预处理', '互相关', '频散', '层析', '质检'].map((label, index) => (
        <button type="button" className={index === 0 ? 'active' : ''} key={label}>
          {index === 0 && <Activity />}<b>{index + 1}</b><span>{label}</span>
        </button>
      ))}
    </nav>
  );
}

function StationPicker() {
  return (
    <aside className="ref-stations">
      <header><span><RadioTower />台站</span><button type="button">全部 8 个</button></header>
      <div className="ref-station-list">
        {['SV-01 · BHZ', 'SV-02 · BHZ', 'SV-03 · BHZ'].map((station, index) => (
          <button type="button" className={index === 0 ? 'active' : ''} key={station} aria-label={`选择台站 ${station}`}>
            <i /><span><strong>{station}</strong><small>可用率 {99 - index * 2}.2%</small></span>
          </button>
        ))}
      </div>
    </aside>
  );
}

function ParameterTools() {
  return (
    <aside className="ref-tools">
      <header><span><SlidersHorizontal />预处理</span><button type="button" aria-label="收起参数">收起</button></header>
      <div className="ref-tool-values">
        <button type="button"><span>低截止</span><strong>0.10 Hz</strong></button>
        <button type="button"><span>高截止</span><strong>1.00 Hz</strong></button>
        <button type="button"><span>归一化</span><strong>运行均值</strong></button>
      </div>
      <button type="button" className="ref-apply">应用并预览</button>
    </aside>
  );
}

function AmbientPreview() {
  return (
    <section className="ref-app ref-ambient" aria-label="面波背景噪声成像风格预览">
      <header className="ref-appbar">
        <div className="ref-brand"><RadioTower /><span><small>工程分析</small><strong>面波背景噪声成像</strong></span></div>
        <HeaderActions />
      </header>
      <StageButtons />
      <div className="ref-workspace">
        <StationPicker />
        <main className="ref-result">
          <header><span><small>当前结果</small><strong>SV-01 处理前后波形</strong></span><button type="button"><Check />质量通过</button></header>
          <SignalChart />
          <footer><span><i className="raw" />原始波形</span><span><i />处理后</span><button type="button">信噪比 8.42</button></footer>
        </main>
        <ParameterTools />
      </div>
    </section>
  );
}

const flowNodes = [
  ['数据接入', 'HTTP'],
  ['字段统一', '转换'],
  ['质量门禁', '校验'],
  ['数据发布', '数据库'],
];

function FlowCanvas() {
  return (
    <main className="ref-flow-canvas">
      <div className="ref-flow-line" />
      {flowNodes.map(([name, type], index) => (
        <button
          type="button"
          className={index === 2 ? 'active' : ''}
          key={name}
          style={{
            '--flow-left': `${7 + index * 23}%`,
            '--flow-top': index % 2 ? '142px' : '54px',
          } as CSSProperties}
        >
          <header><i /><strong>{name}</strong></header>
          <span>{type}</span>
          <small>输入 {24 + index * 6}　输出 {24 + index * 5}</small>
        </button>
      ))}
      <div className="ref-canvas-tools">
        <button type="button" aria-label="缩小">−</button><strong>85%</strong><button type="button" aria-label="放大">＋</button>
      </div>
    </main>
  );
}

function GatewayPreview() {
  return (
    <section className="ref-app ref-gateway" aria-label="数据网关风格预览">
      <header className="ref-appbar">
        <div className="ref-brand"><Network /><span><small>数据治理</small><strong>数据网关</strong></span></div>
        <HeaderActions />
      </header>
      <nav className="ref-flow-actions" aria-label="数据网关操作">
        <button type="button" className="active"><Layers3 />流程画布</button>
        <button type="button"><Gauge />运行状态</button>
        <button type="button"><Archive />数据溯源</button>
        <button type="button"><Database />流程配置</button>
      </nav>
      <div className="ref-gateway-workspace">
        <aside className="ref-operation-dock">
          <button type="button" className="primary"><Play />启动</button>
          <button type="button"><Settings2 />配置</button>
          <button type="button"><Archive />历史</button>
        </aside>
        <FlowCanvas />
        <div className="ref-flow-status"><span><i />4 个运行中</span><button type="button">12 条溯源</button><button type="button"><Check />校验通过</button></div>
      </div>
    </section>
  );
}

export function WorkbenchStyleGallery() {
  const selected = useSyncExternalStore(subscribeSelection, readSelection, () => '');
  const selectedConcept = concepts.find((concept) => concept.id === selected);

  const choose = (id: string) => {
    window.localStorage.setItem(storageKey, id);
    window.dispatchEvent(new Event(selectionEvent));
  };

  return (
    <div className="ref-gallery">
      <header className="ref-gallery-intro">
        <div><span>第二轮风格选择</span><h1>减少框线，强化按钮与层次</h1><p>六套方案都使用相同功能内容，重点比较空间组织方式。点击方案可保存候选。</p></div>
        {selectedConcept && <div className="ref-selection"><Check /><span>当前候选</span><strong>{selectedConcept.id} · {selectedConcept.name}</strong></div>}
      </header>

      <nav className="ref-index" aria-label="风格方案快速定位">
        {concepts.map((concept) => <a href={`#style-${concept.id}`} key={concept.id}><b>{concept.id}</b><span>{concept.name}</span></a>)}
      </nav>

      <div className="ref-concepts">
        {concepts.map((concept) => (
          <article className="ref-concept" data-selected={selected === concept.id} id={`style-${concept.id}`} key={concept.id}>
            <header className="ref-concept-heading">
              <div className="ref-number">{concept.id}</div>
              <div>
                <div className="ref-title-row"><h2>{concept.name}</h2>{concept.recommendation && <span>{concept.recommendation}</span>}</div>
                <p>{concept.summary}</p>
                <ul>{concept.traits.map((trait) => <li key={trait}>{trait}</li>)}</ul>
              </div>
              <button type="button" onClick={() => choose(concept.id)}>{selected === concept.id ? <><Check />已选为候选</> : '选择此方案'}</button>
            </header>
            <div className="ref-preview" data-theme={concept.layout}>
              <AmbientPreview />
              <GatewayPreview />
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
