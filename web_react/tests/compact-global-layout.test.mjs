import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const header = await readFile(new URL('../components/site-header.tsx', import.meta.url), 'utf8');
const toolPage = await readFile(new URL('../app/tools/[slug]/page.tsx', import.meta.url), 'utf8');
const seismic = await readFile(new URL('../components/seismic-physics-workbench.tsx', import.meta.url), 'utf8');
const profile = await readFile(new URL('../components/profile-identity.tsx', import.meta.url), 'utf8');
const login = await readFile(new URL('../app/login/page.tsx', import.meta.url), 'utf8');
const home = await readFile(new URL('../app/page.tsx', import.meta.url), 'utf8');
const clock = await readFile(new URL('../components/live-earth-clock.tsx', import.meta.url), 'utf8');
const team = await readFile(new URL('../app/team/page.tsx', import.meta.url), 'utf8');
const directory = await readFile(new URL('../components/team-directory.tsx', import.meta.url), 'utf8');
const styles = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');

test('workbench exit sits before the logo and no longer consumes a content row', () => {
  assert.match(header, /className="header-brand-group"/);
  assert.ok(header.indexOf('header-workbench-exit') < header.indexOf('brand-logo'));
  assert.match(header, /href=\{`\/\$\{activeWorkbench\.section\}`\}/);
  assert.doesNotMatch(toolPage, /workbench-exitbar/);
  assert.match(styles, /September 2026 compact page composition[\s\S]*?\.workbench-page-main \{[\s\S]*?grid-template-rows: minmax\(0, 1fr\)/);
});

test('seismic station selector renders all three compact cards in one row', () => {
  assert.match(seismic, /className="seismic-trace-list"/);
  assert.match(styles, /September 2026 compact page composition[\s\S]*?\.seismic-overview \{[\s\S]*?repeat\(12, minmax\(0, 1fr\)\)[\s\S]*?\.seismic-trace-list \{[\s\S]*?repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.seismic-process \{[\s\S]*?grid-column: 1 \/ span 8/);
  assert.match(styles, /\.seismic-trace-overview \{[\s\S]*?grid-column: 9 \/ -1/);
});

test('earth globe and clock face share the same geometric center', () => {
  assert.match(clock, /earthSystem\.position\.y = 0;/);
  assert.doesNotMatch(clock, /earthSystem\.position\.y = 0\.08;/);
  assert.match(styles, /\.home-main \.analog-clock-face \{\s*top: 50%/);
});

test('anonymous profile hides protected entries and login page is minimal', () => {
  assert.match(profile, /data-authenticated=\{loading \? 'loading' : user \? 'true' : 'false'\}/);
  assert.match(profile, /请先登录/);
  assert.match(styles, /\.profile-banner\[data-authenticated='false'\] \+ \.profile-grid \{[\s\S]*?display: none/);
  assert.doesNotMatch(login, /账号访问|欢迎回来|组织身份登录|进入你的研究与课程工作区/);
  assert.match(login, /className="login-avatar"/);
});

test('team page is a one-screen mentor and four-column student directory', () => {
  assert.doesNotMatch(team, /团队与协作|研究方向|page-hero|SiteFooter/);
  assert.match(directory, /jiangfeng\.Li@cumt\.endu\.cn/);
  assert.match(directory, /https:\/\/faculty\.cumt\.edu\.cn\/lijiangfeng\//);
  assert.match(directory, /navigator\.clipboard\.writeText/);
  assert.doesNotMatch(directory, /学术指导/);
  assert.match(styles, /\.student-card-grid \{[\s\S]*?repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.team-page-shell \{[\s\S]*?height: 100dvh/);
});

test('home moves live time above actions and removes all clock-bottom copy', () => {
  assert.doesNotMatch(home, /科研协作工作台|把时间留给|真正的问题|连接科研、工程与课程工具/);
  assert.ok(home.indexOf('<ShanghaiTimeReadout />') < home.indexOf('className="hero-actions"'));
  assert.doesNotMatch(clock, /className="earth-clock-readout"|上海时间|UTC\+08:00/);
  assert.match(clock, /export function ShanghaiTimeReadout/);
});
