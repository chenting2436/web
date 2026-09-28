import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const toolsClient = readFileSync(new URL('../services/api/tools.ts', import.meta.url), 'utf8');
const homeworkPage = readFileSync(new URL('../app/homework/page.tsx', import.meta.url), 'utf8');

test('browser submits work through the versioned control-plane job contract', () => {
  assert.match(toolsClient, /Idempotency-Key/);
  assert.match(toolsClient, /\/projects\/\$\{projectId\}\/jobs/);
  assert.match(toolsClient, /\/jobs\/\$\{id\}/);
});

test('browser cannot create terminal run records or call the compute route directly', () => {
  assert.doesNotMatch(toolsClient, /createRun\s*\(/);
  assert.doesNotMatch(toolsClient, /\/tools\/\$\{slug\}\/run/);
});

test('browser job and run response types expose only the public projection', () => {
  const runType = toolsClient.match(/export type WorkbenchRun = \{([\s\S]*?)\n\};/)?.[1] ?? '';
  const jobType = toolsClient.match(/export type WorkbenchJob = \{([\s\S]*?)\n\};/)?.[1] ?? '';

  assert.match(jobType, /projectId: string/);
  assert.match(jobType, /result: ToolResult/);
  assert.match(jobType, /attempt: number/);
  assert.match(runType, /jobId\?: string/);
  assert.match(runType, /result: ToolResult/);

  for (const privateField of ['tenantId', 'workspaceId', 'createdByUserId', 'input', 'idempotencyKey', 'workerId', 'claimToken']) {
    assert.doesNotMatch(jobType, new RegExp(`\\b${privateField}\\??:`));
  }
  assert.doesNotMatch(runType, /\binput\??:/);
});

test('homework file submission and grading UI stays behind the security gate', () => {
  assert.match(homeworkPage, /安全整改中/);
  assert.doesNotMatch(homeworkPage, /<HomeworkWorkbench/);
});
