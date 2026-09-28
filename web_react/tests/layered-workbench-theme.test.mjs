import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const availability = await readFile(
  new URL('../components/workbench-availability.tsx', import.meta.url),
  'utf8',
);
const styles = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');
const home = await readFile(new URL('../app/page.tsx', import.meta.url), 'utf8');
const toolPage = await readFile(new URL('../app/tools/[slug]/page.tsx', import.meta.url), 'utf8');
const sectionOverview = await readFile(new URL('../components/section-overview.tsx', import.meta.url), 'utf8');
const ambientWorkbench = await readFile(
  new URL('../components/ambient-noise-workbench.tsx', import.meta.url),
  'utf8',
);
const remoteWorkbench = await readFile(
  new URL('../components/remote-sensing-workbench.tsx', import.meta.url),
  'utf8',
);
const dataGatewayWorkbench = await readFile(
  new URL('../components/data-gateway-workbench.tsx', import.meta.url),
  'utf8',
);

test('all completed equivalent migrations use the selected layered theme', () => {
  for (const slug of [
    'ambient-noise-imaging',
    'data-gateway',
    'patent-disclosure',
    'paper-writing',
    'disaster-remote-sensing',
    'seismic-physics',
    'patent-transfer',
  ]) {
    assert.match(availability, new RegExp(`data-workbench="${slug}"`));
  }
});

test('layered theme keeps dense controls in flow and provides narrow-screen fallbacks', () => {
  assert.match(styles, /Selected production direction: layered task desk/);
  assert.match(styles, /\.layered-workbench-theme \.dataflow-zoom \{[\s\S]*?position: absolute/);
  assert.match(styles, /\.layered-workbench-theme \.ambient-tabs \{[\s\S]*?overflow-x: auto/);
  assert.match(styles, /@media \(max-width: 860px\)[\s\S]*?\.layered-workbench-theme \.remote-shell/);
  assert.match(styles, /touch-action: manipulation/);
});

test('wide layouts add columns without proportionally scaling the interface', () => {
  assert.match(home, /className="home-main page-width"/);
  assert.match(styles, /\.home-main \{[\s\S]*?grid-template-columns:/);
  assert.match(styles, /\.tool-grid \{[\s\S]*?repeat\(auto-fit, minmax\(300px, 1fr\)\)/);
  assert.match(styles, /\.earth-clock-react \{[\s\S]*?min-height: 480px/);
});

test('completed workbenches fit the viewport and scroll inside their own content panels', () => {
  assert.match(toolPage, /workbench-page-main/);
  assert.match(styles, /\.workbench-page-main \{[\s\S]*?height: calc\(100dvh - 72px\)/);
  assert.match(styles, /\.workbench-page-main > \.layered-workbench-theme \{[\s\S]*?height: 100%/);
  assert.match(styles, /\.ambient-grid \{[\s\S]*?overscroll-behavior: contain/);
});

test('layered charts, labels and controls use distinct high-contrast roles', () => {
  assert.match(styles, /--layered-ink: #18213b/);
  assert.match(styles, /--layered-muted: #505a72/);
  assert.match(styles, /--layered-accent: #4652a3/);
  assert.match(styles, /\.ambient-chart text,[\s\S]*?fill: #34415c/);
  assert.match(styles, /\.remote-zone-grid article\[data-severity='critical'\]/);
});

test('navigation sections open directly on workbench cards without marketing headings', () => {
  assert.doesNotMatch(sectionOverview, /className="page-hero"/);
  assert.doesNotMatch(sectionOverview, />工作台<\/h2>/);
  assert.match(sectionOverview, /<WorkbenchGrid items=\{items\} \/>/);
});

test('tool pages give the full main area to the workbench', () => {
  assert.doesNotMatch(toolPage, /className="workbench-exitbar"/);
  assert.doesNotMatch(toolPage, /退出工作台/);
  assert.doesNotMatch(toolPage, /className="workspace-heading"/);
  assert.doesNotMatch(toolPage, /className="breadcrumb"/);
});

test('desktop workbenches use horizontal reflow and internal scrolling without overlap', () => {
  assert.match(styles, /\.ambient-workbench \{[\s\S]*?grid-template-columns:/);
  assert.match(styles, /\.remote-main\[data-view='overview'\] \.remote-view \{[\s\S]*?grid-template-columns:/);
  assert.match(styles, /\.dataflow-toolbar \{[\s\S]*?overflow-x: auto/);
  assert.match(styles, /\.paper-topbar \{[\s\S]*?overflow-x: auto/);
  assert.match(styles, /\.patent-topbar \{[\s\S]*?overflow-x: auto/);
});

test('ambient summary uses compact metric rows beside a persistent network graph', () => {
  assert.match(ambientWorkbench, /className="ambient-summary-band"/);
  assert.match(ambientWorkbench, /className="ambient-summary-visual"/);
  assert.match(styles, /\.ambient-summary-band \{[\s\S]*?grid-template-columns:/);
  assert.match(
    styles,
    /\.ambient-summary-band \.ambient-stats article \{[\s\S]*?grid-template-columns:/,
  );

  const projectView = ambientWorkbench.slice(
    ambientWorkbench.indexOf("selectedView === 'project'"),
    ambientWorkbench.indexOf("selectedView === 'stations'"),
  );
  assert.doesNotMatch(projectView, /<StationMap/);
});

test('remote-sensing overview isolates metadata from raster previews', () => {
  assert.match(remoteWorkbench, /className="remote-overview-layout"/);
  assert.match(remoteWorkbench, /className="remote-overview-controls"/);
  assert.match(remoteWorkbench, /className="remote-overview-visuals"/);
  assert.match(styles, /\.remote-overview-layout \{[\s\S]*?grid-template-columns:/);
  assert.match(
    styles,
    /\.remote-overview-controls \.remote-dataset dl \{[\s\S]*?minmax\(0, 1fr\)/,
  );
});

test('all migrated workbenches contain long content instead of overlapping neighbours', () => {
  assert.match(styles, /container-name: workbench/);
  assert.match(styles, /\.patent-workspace \{[\s\S]*?minmax\(0, 1fr\)/);
  assert.match(styles, /\.paper-draft-layout > \*/);
  assert.match(styles, /overflow-wrap: anywhere/);
  assert.match(styles, /@container workbench \(max-width: 1180px\)/);
});

test('data-gateway actions and live status share one non-wrapping toolbar row', () => {
  assert.match(dataGatewayWorkbench, /className="dataflow-toolbar-status"/);
  assert.doesNotMatch(dataGatewayWorkbench, /className="dataflow-statusbar"/);
  assert.match(
    styles,
    /\.dataflow-toolbar-status \{[\s\S]*?display: flex;[\s\S]*?justify-content: center/,
  );
  assert.match(styles, /\.dataflow-toolbar \{[\s\S]*?flex-wrap: nowrap;[\s\S]*?overflow-x: auto/);
});

test('ambient KPIs stay on one five-column rail beside the network map', () => {
  assert.match(
    styles,
    /Final dense-workbench composition[\s\S]*?\.ambient-summary-band \.ambient-stats \{[\s\S]*?repeat\(5, minmax\(118px, 1fr\)\)/,
  );
  assert.match(
    styles,
    /\.ambient-summary-band \{[\s\S]*?minmax\(690px, 1\.28fr\)[\s\S]*?minmax\(360px, 0\.72fr\)/,
  );
});

test('patent project portfolio uses four desktop columns with safe fallbacks', () => {
  assert.match(
    styles,
    /Patent portfolio:[\s\S]*?\.patent-project-grid \{[\s\S]*?repeat\(4, minmax\(0, 1fr\)\)/,
  );
  assert.match(
    styles,
    /@container workbench \(max-width: 980px\)[\s\S]*?\.patent-project-grid \{[\s\S]*?repeat\(2, minmax\(0, 1fr\)\)/,
  );
});
