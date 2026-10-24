import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCases, runCases, compareRuns, validateRun } from '../src/harness.js';
import app from '../examples/app.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const cli = (...args) => spawnSync(process.execPath, ['bin/evaldiff.js', ...args], { encoding: 'utf8' });

test('parallel cases preserve order, verdicts, and the concurrency limit', async () => {
  const cases = await loadCases(new URL('../examples/cases.jsonl', import.meta.url));
  let active = 0; let peak = 0;
  const adapter = async (input, context) => {
    active++; peak = Math.max(peak, active);
    await pause(5);
    try { return await app(input, context); } finally { active--; }
  };
  const sequential = await runCases(cases, app);
  const parallel = await runCases(cases, adapter, { concurrency: 3 });
  assert.ok(peak > 1 && peak <= 3, `peak concurrency was ${peak}`);
  assert.deepEqual(parallel.results.map(r => r.id), sequential.results.map(r => r.id));
  assert.deepEqual(parallel.results.map(r => r.passed), sequential.results.map(r => r.passed));
  assert.equal(parallel.datasetHash, sequential.datasetHash);
  assert.equal(compareRuns(sequential, parallel).regression, false);
  validateRun(parallel);
});

test('trials within a case stay sequential under parallelism', async () => {
  const cases = Array.from({ length: 4 }, (_, i) => ({ id: `case-${i}`, input: i, graders: [{ type: 'exact', expected: i }] }));
  const active = new Map();
  const calls = new Map();
  const adapter = async (input, { id, trial }) => {
    assert.equal(active.get(id) || 0, 0, `case ${id} ran overlapping trials`);
    const count = calls.get(id) || 0;
    assert.equal(trial, count + 1);
    calls.set(id, count + 1);
    active.set(id, 1);
    await pause(5);
    active.set(id, 0);
    return input;
  };
  const run = await runCases(cases, adapter, { repeat: 3, concurrency: 4 });
  assert.equal(run.passed, 4);
  assert.deepEqual(run.results[0].trials.map(t => t.passed), [true, true, true]);
});

test('invalid concurrency values are rejected before inference', async () => {
  const cases = [{ id: 'one', input: 'hello', graders: [{ type: 'exact', expected: 'hello' }] }];
  for (const concurrency of [0, -1, 33, 1.5, NaN]) await assert.rejects(runCases(cases, input => input, { concurrency }), /concurrency/);
  assert.equal((await runCases(cases, input => input, { concurrency: 1 })).passed, 1);
  assert.equal((await runCases(cases, input => input, { concurrency: 32 })).passed, 1);
});

test('CLI validates --concurrency and limits it to run', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'evaldiff-concurrency-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const parallel = cli('run', '--cases', 'examples/cases.jsonl', '--adapter', 'examples/app.mjs', '--concurrency', '4', '--out', join(dir, 'run.json'));
  assert.equal(parallel.status, 0, parallel.stderr);
  assert.match(parallel.stdout, /Passing: 10\/10/);
  assert.equal(cli('run', '--cases', 'examples/cases.jsonl', '--adapter', 'examples/app.mjs', '--concurrency', '0').status, 2);
  assert.equal(cli('run', '--cases', 'examples/cases.jsonl', '--adapter', 'examples/app.mjs', '--concurrency', '33').status, 2);
  assert.equal(cli('compare', '--baseline', 'examples/baseline.json', '--current', 'examples/baseline.json', '--concurrency', '2').status, 2);
});
