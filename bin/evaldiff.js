#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadCases, runCases, compareRuns } from '../src/harness.js';
import { headline, markdownReport } from '../src/report.js';
import { summarizeRun } from '../src/analysis.js';
import { htmlReport } from '../src/html.js';
import { selectFailedCases, caseDiffs } from '../src/triage.js';

const help = `EvalDiff — evaluate outputs, compare baselines, catch regressions.

Usage:
  evaldiff validate --cases cases.jsonl
  evaldiff run --cases cases.jsonl --adapter app.mjs --out run.json
  evaldiff run --cases cases.jsonl --prompt prompt.txt --out run.json
  evaldiff run ... --baseline baseline.json --report comparison.json --markdown report.md
  evaldiff compare --baseline baseline.json --current run.json --report comparison.json

Options:
  --adapter PATH    JS module exporting default async (input, { id, trial, signal }) => output
  --prompt PATH     System prompt for OpenAI (requires OPENAI_API_KEY)
  --model NAME      OpenAI model (default: OPENAI_MODEL or gpt-4.1-mini)
  --timeout MS      Per-trial timeout (default: 30000)
  --repeat N        Trials per case, 1–100 (default: 1; ALL trials must pass)
  --concurrency N   Cases evaluated in parallel, 1–32 (default: 1; trials stay sequential)
  --failed-from PATH  Rerun only failures from a matching full-dataset artifact
  --details         Print changed case verdicts and reasons (requires baseline)
  --out PATH        Save full run artifact (includes inputs' resulting outputs)
  --report PATH     Save structured comparison (requires baseline)
  --markdown PATH   Save PR-ready Markdown (requires baseline)
  --html PATH       Save a standalone HTML evaluation dashboard
  --summary PATH    Save aggregate JSON metrics (slices, graders, latency)
  --help            Show usage

Exit codes: 0 = pass/no new failures; 1 = failing cases/new regressions; 2 = configuration/artifact error.
With a baseline, previously failing cases do not fail the gate; ANY newly failing case does.
`;
async function save(path, data) {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, data);
}
const json = path => readFile(path, 'utf8').then(JSON.parse);
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    cases: { type: 'string' }, adapter: { type: 'string' }, prompt: { type: 'string' }, model: { type: 'string' }, timeout: { type: 'string' }, repeat: { type: 'string' }, concurrency: { type: 'string' }, 'failed-from': { type: 'string' }, details: { type: 'boolean' }, out: { type: 'string' }, baseline: { type: 'string' }, current: { type: 'string' }, report: { type: 'string' }, markdown: { type: 'string' }, html: { type: 'string' }, summary: { type: 'string' }, help: { type: 'boolean', short: 'h' }
  } });
  if (values.help || !positionals.length) { console.log(help); return; }
  if (positionals.length !== 1 || !['run', 'compare', 'validate'].includes(positionals[0])) throw new Error('Use run, compare, or validate. See --help.');
  if (positionals[0] === 'validate') {
    if (!values.cases || Object.keys(values).some(key => key !== 'cases')) throw new Error('validate accepts only --cases.');
    const cases = await loadCases(values.cases);
    const tags = [...new Set(cases.flatMap(c => c.tags || []))];
    console.log(`Valid dataset: ${cases.length} cases · ${cases.reduce((n, c) => n + c.graders.length, 0)} graders · ${tags.length} tags. No inference performed.`);
    return;
  }
  if (values.repeat !== undefined && positionals[0] !== 'run') throw new Error('--repeat is only valid with run; compare uses saved trial settings.');
  if (values.concurrency !== undefined && positionals[0] !== 'run') throw new Error('--concurrency is only valid with run.');
  if (values['failed-from'] && (positionals[0] !== 'run' || values.baseline)) throw new Error('--failed-from is for run without --baseline; reruns produce a separate subset artifact.');
  if (values.details && !values.baseline) throw new Error('--details requires --baseline.');
  if ((values.report || values.markdown) && !values.baseline) throw new Error('--report and --markdown require --baseline.');
  // Never overwrite source datasets/baselines or mix multiple output formats.
  const canonicalPath = async path => realpath(resolve(path)).catch(error => {
    if (error.code === 'ENOENT') return resolve(path);
    throw error;
  });
  const protectedPaths = new Set(await Promise.all(['cases', 'adapter', 'prompt', 'baseline', 'current', 'failed-from'].filter(key => values[key]).map(key => canonicalPath(values[key]))));
  const outputs = new Set();
  for (const key of ['out', 'report', 'markdown', 'html', 'summary']) {
    if (!values[key]) continue;
    const path = await canonicalPath(values[key]);
    if (protectedPaths.has(path) || outputs.has(path)) throw new Error(`--${key} would overwrite an input or another output. Choose distinct artifact paths.`);
    outputs.add(path);
  }
  let current;
  let baseline;
  if (positionals[0] === 'run') {
    if (!values.cases || Number(Boolean(values.adapter)) + Number(Boolean(values.prompt)) !== 1) throw new Error('run requires --cases and exactly one of --adapter or --prompt.');
    const timeoutMs = Number(values.timeout ?? 30000);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw new Error('--timeout must be an integer from 1 to 600000.');
    const concurrency = Number(values.concurrency ?? 1);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('--concurrency must be an integer from 1 to 32.');
    let repeat = Number(values.repeat ?? 1);
    let cases = await loadCases(values.cases);
    if (values['failed-from']) {
      const source = await json(values['failed-from']);
      const selected = selectFailedCases(cases, source);
      const sourceRepeat = source.trialsPerCase ?? 1;
      if (values.repeat !== undefined && repeat !== sourceRepeat) throw new Error('Reruns must use the same trial count as their source.');
      repeat = sourceRepeat;
      console.log(`Rerunning ${selected.length}/${cases.length} failed cases · ${repeat} trial(s) per case.`);
      cases = selected;
    }
    if (!Number.isInteger(repeat) || repeat < 1 || repeat > 100) throw new Error('--repeat must be an integer from 1 to 100.');
    if (cases.length * repeat > 100000) throw new Error('Evaluation exceeds 100000 total trials.');
    // Validate baseline compatibility before spending money on inference.
    if (values.baseline) {
      const { fingerprint, validateRun } = await import('../src/harness.js');
      const base = validateRun(await json(values.baseline));
      baseline = base;
      if ((base.trialsPerCase ?? 1) !== repeat) throw new Error('Trial counts differ: use the same --repeat setting as the baseline.');
      if (base.datasetHash !== fingerprint([...cases].sort((a, b) => a.id.localeCompare(b.id)))) throw new Error('Dataset changed: regenerate the baseline explicitly before comparing.');
    }
    let adapter;
    if (values.adapter) {
      adapter = (await import(pathToFileURL(resolve(values.adapter)).href)).default;
      if (typeof adapter !== 'function') throw new Error('Adapter module must default-export a function.');
    } else {
      if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required for --prompt.');
      const prompt = await readFile(values.prompt, 'utf8');
      adapter = async (input, { signal }) => {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST', signal,
          headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: values.model || process.env.OPENAI_MODEL || 'gpt-4.1-mini', messages: [{ role: 'system', content: prompt }, { role: 'user', content: typeof input === 'string' ? input : JSON.stringify(input) }] })
        });
        if (!response.ok) throw new Error(`OpenAI request failed (HTTP ${response.status}).`);
        const data = await response.json();
        const content = data.choices?.[0]?.message?.content;
        if (typeof content !== 'string') throw new Error('OpenAI returned no text content.');
        return content;
      };
    }
    current = await runCases(cases, adapter, { timeoutMs, repeat, concurrency });
    if (values.out) await save(values.out, JSON.stringify(current, null, 2) + '\n');
    console.log(`Passing: ${current.passed}/${current.total}`);
    for (const row of current.results.filter(r => !r.passed)) console.log(`  FAIL ${row.id}: ${JSON.stringify(row.error || row.grades.filter(g => !g.passed).map(g => g.reason).join('; '))}`);
  } else {
    if (!values.current || !values.baseline) throw new Error('compare requires --baseline and --current.');
    current = await json(values.current);
  }
  let comparison;
  if (values.baseline) {
    baseline ??= await json(values.baseline);
    comparison = compareRuns(baseline, current);
    console.log(headline(comparison));
    if (values.details) {
      const changes = caseDiffs(baseline, current);
      if (!changes.length) console.log('No case verdicts changed.');
      for (const change of changes) {
        console.log(`  ${change.status === 'fixed' ? 'FIXED' : 'NEW FAILURE'} ${change.id} · ${change.failedTrials}/${change.totalTrials} failed trials`);
        for (const reason of change.reasons) console.log(`    ${JSON.stringify(reason)}`);
      }
    }
    if (values.report) await save(values.report, JSON.stringify(comparison, null, 2) + '\n');
    if (values.markdown) await save(values.markdown, markdownReport(comparison));
    process.exitCode = comparison.regression ? 1 : 0;
  } else process.exitCode = current.passed === current.total ? 0 : 1;
  const summary = summarizeRun(current);
  console.log(`Latency: p50 ${summary.latency.p50Ms ?? 'n/a'} ms · p95 ${summary.latency.p95Ms ?? 'n/a'} ms · adapter errors ${summary.errors}`);
  if (summary.stability.trialsPerCase > 1) console.log(`Stability: ${summary.stability.passedTrials}/${summary.stability.totalTrials} trials passed · ${summary.stability.flakyCases.length} flaky cases (all-trials-pass policy)`);
  if (values.summary) await save(values.summary, JSON.stringify(summary, null, 2) + '\n');
  if (values.html) await save(values.html, htmlReport(current, comparison));
}
main().catch(error => { console.error(`EvalDiff: ${error.message}`); process.exitCode = 2; });
