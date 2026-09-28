import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getWorkbenchReadiness,
  workbenches,
} from '../lib/platform-data.ts';

test('workbench slugs stay unique and cover the current 26 routes', () => {
  const slugs = workbenches.map(({ slug }) => slug);
  assert.equal(slugs.length, 26);
  assert.equal(new Set(slugs).size, slugs.length);
});

test('no workbench is presented as production-ready before acceptance', () => {
  for (const { slug } of workbenches) {
    const readiness = getWorkbenchReadiness(slug);
    assert.match(readiness.status, /^(prototype|planned|security-blocked)$/);
    assert.notEqual(readiness.label, '生产可用');
  }
});

test('migrated emergency console can execute through the controlled worker', () => {
  assert.equal(getWorkbenchReadiness('emergency-console').status, 'prototype');
  assert.equal(getWorkbenchReadiness('emergency-console').executionAllowed, true);
});

test('migrated warning platform can execute through the controlled worker', () => {
  assert.equal(getWorkbenchReadiness('warning-platform').status, 'prototype');
  assert.equal(getWorkbenchReadiness('warning-platform').executionAllowed, true);
});

test('migrated UAV inspection can execute through the controlled worker', () => {
  assert.equal(getWorkbenchReadiness('uav-inspection').status, 'prototype');
  assert.equal(getWorkbenchReadiness('uav-inspection').executionAllowed, true);
});

test('migrated multi-source fusion can execute through the controlled worker', () => {
  assert.equal(getWorkbenchReadiness('fusion-console').status, 'prototype');
  assert.equal(getWorkbenchReadiness('fusion-console').executionAllowed, true);
});

test('project packaging stays blocked while the assessment control plane is available', () => {
  assert.equal(getWorkbenchReadiness('project-submission').status, 'security-blocked');
  assert.equal(getWorkbenchReadiness('project-submission').executionAllowed, false);
  assert.equal(getWorkbenchReadiness('ai-assessment').status, 'prototype');
  assert.equal(getWorkbenchReadiness('ai-assessment').executionAllowed, true);
});

test('python lab can use its isolated browser runtime without opening server execution', () => {
  assert.equal(getWorkbenchReadiness('python-lab').status, 'prototype');
  assert.equal(getWorkbenchReadiness('python-lab').executionAllowed, true);
});
