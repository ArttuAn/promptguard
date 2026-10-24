import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadCases, runCases } from '../src/harness.js';
import { selectFailedCases, caseDiffs } from '../src/triage.js';
import { htmlReport } from '../src/html.js';
import { compareRuns } from '../src/harness.js';
import stable from '../examples/app.mjs';
import unstable from '../examples/unstable-app.mjs';

const cases = await loadCases(new URL('../examples/cases.jsonl', import.meta.url));
const baseline = await runCases(cases, stable, { repeat: 3 });
const current = await runCases(cases, unstable, { repeat: 3 });
const cli = (...args) => spawnSync(process.execPath, ['bin/evaldiff.js', ...args], { encoding: 'utf8' });

test('failed-case selection retains original dataset order and excludes passes', () => {
  assert.deepEqual(selectFailedCases(cases, current).map(c => c.id), ['route-refund', 'extract-contact', 'refusal']);
  assert.throws(() => selectFailedCases(cases, baseline), /no failed cases/);
  assert.throws(() => selectFailedCases(cases.map((c, i) => i ? c : { ...c, input: 'changed' }), current), /does not match/);
  const forged = structuredClone(current); forged.results[0].id = 'unknown-id';
  assert.throws(() => selectFailedCases(cases, forged), /different case IDs/);
});
test('case diffs retain failed-trial reasons and identify fixed cases', () => {
  const diffs = caseDiffs(baseline, current);
  assert.equal(diffs.length, 3);
  assert.equal(diffs.find(d => d.id === 'route-refund').failedTrials, 1);
  assert.match(diffs.find(d => d.id === 'extract-contact').reasons[0], /required property/);
  assert.equal(caseDiffs(current, baseline).every(d => d.status === 'fixed'), true);
  assert.deepEqual(caseDiffs(baseline, baseline), []);
});
test('HTML marks new, fixed, and unchanged case verdicts', () => {
  assert.match(htmlReport(current, compareRuns(baseline, current)), /New regression · PASS → FAIL/);
  assert.match(htmlReport(baseline, compareRuns(current, baseline)), /Fixed · FAIL → PASS/);
});
test('CLI reruns only failed cases and inherits trial count', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'evaldiff-triage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, 'source.json'); const out = join(dir, 'rerun.json');
  await writeFile(source, JSON.stringify(current));
  const result = cli('run', '--cases', 'examples/cases.jsonl', '--adapter', 'examples/app.mjs', '--failed-from', source, '--out', out);
  assert.equal(result.status, 0, result.stderr);
  const run = JSON.parse(await readFile(out));
  assert.equal(run.total, 3); assert.equal(run.passed, 3); assert.equal(run.trialsPerCase, 3);
  assert.notEqual(run.datasetHash, current.datasetHash);
  const mismatch = cli('run', '--cases', 'examples/cases.jsonl', '--adapter', 'missing.mjs', '--failed-from', source, '--repeat', '1');
  assert.equal(mismatch.status, 2); assert.match(mismatch.stderr, /same trial count/);
  assert.equal(cli('run', '--cases', 'examples/cases.jsonl', '--adapter', 'examples/app.mjs', '--failed-from', source, '--baseline', source).status, 2);
});
test('CLI refuses baseline overwrite, including existing symlink aliases', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'evaldiff-paths-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'baseline.json'); const alias = join(dir, 'alias.json');
  const original = JSON.stringify(baseline);
  await writeFile(file, original);
  let linked = true;
  try { await symlink(file, alias); } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
    linked = false;
  }
  for (const out of linked ? [file, alias] : [file]) {
    const result = cli('run', '--cases', 'examples/cases.jsonl', '--adapter', 'missing.mjs', '--baseline', file, '--out', out);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /overwrite an input/);
    assert.equal(await readFile(file, 'utf8'), original);
  }
});
test('CLI rejects shared output paths before importing an adapter', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'evaldiff-output-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'artifact.json');
  const result = cli('run', '--cases', 'examples/cases.jsonl', '--adapter', 'missing.mjs', '--out', file, '--summary', file);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /another output/);
});
test('CLI comparison details report reasons without inference', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'evaldiff-diff-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const base = join(dir, 'base.json'); const now = join(dir, 'current.json');
  const diagnostic = structuredClone(current);
  diagnostic.results[0].trials[1].error = '\u001b[31mprovider error';
  await writeFile(base, JSON.stringify(baseline)); await writeFile(now, JSON.stringify(diagnostic));
  const result = cli('compare', '--baseline', base, '--current', now, '--details');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /NEW FAILURE extract-contact/);
  assert.match(result.stdout, /required property/);
  assert.match(result.stdout, /1\/3 failed trials/);
  assert.ok(!result.stdout.includes('\u001b'));
  assert.ok(result.stdout.includes('\\u001b'));
});
