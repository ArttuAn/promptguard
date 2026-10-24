import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
};
export const fingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export async function loadCases(path) {
  const text = await readFile(path, 'utf8');
  const cases = [];
  const ids = new Set();
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let item;
    try { item = JSON.parse(line); } catch { throw new Error(`Line ${index + 1}: invalid JSON.`); }
    if (!item || typeof item.id !== 'string' || !/^[a-zA-Z0-9._-]{1,100}$/.test(item.id)) throw new Error(`Line ${index + 1}: id must be 1–100 letters, digits, dots, underscores, or hyphens.`);
    if (ids.has(item.id)) throw new Error(`Duplicate case id: ${item.id}`);
    if (!Object.hasOwn(item, 'input')) throw new Error(`Case ${item.id}: input is required.`);
    if (item.tags !== undefined && (!Array.isArray(item.tags) || item.tags.length > 20 || new Set(item.tags).size !== item.tags.length || item.tags.some(tag => typeof tag !== 'string' || !/^[a-zA-Z0-9._-]{1,64}$/.test(tag)))) throw new Error(`Case ${item.id}: tags must be unique identifiers (maximum 20).`);
    if (!Array.isArray(item.graders) || !item.graders.length) throw new Error(`Case ${item.id}: graders are required.`);
    for (const grader of item.graders) {
      if (!grader || !['exact', 'json-schema'].includes(grader.type)) throw new Error(`Case ${item.id}: unknown grader.`);
      if (grader.type === 'exact' && !Object.hasOwn(grader, 'expected')) throw new Error(`Case ${item.id}: exact grader needs expected.`);
      if (grader.type === 'json-schema') {
        if (!grader.schema || typeof grader.schema !== 'object' || Array.isArray(grader.schema)) throw new Error(`Case ${item.id}: schema must be an object.`);
        try { ajv.compile(grader.schema); } catch (error) { throw new Error(`Case ${item.id}: invalid schema: ${error.message}`); }
      }
    }
    ids.add(item.id); cases.push(item);
  }
  if (!cases.length) throw new Error('Test set is empty.');
  return cases;
}

export function grade(output, grader) {
  if (grader.type === 'exact') {
    // Text is strict (including whitespace); JSON values use structural equality.
    const passed = isDeepStrictEqual(output, grader.expected);
    return { type: grader.type, passed, reason: passed ? 'Exact match.' : 'Output did not exactly match the expected value.' };
  }
  if (grader.type !== 'json-schema') throw new Error('Unknown grader.');
  let value = output;
  if (typeof output === 'string') {
    try { value = JSON.parse(output); } catch { return { type: grader.type, passed: false, reason: 'Output is not valid JSON.' }; }
  }
  const validate = ajv.compile(grader.schema);
  const passed = validate(value);
  return { type: grader.type, passed, reason: passed ? 'JSON Schema matched.' : ajv.errorsText(validate.errors, { separator: '; ' }) };
}

async function runTrial(item, adapter, timeoutMs, trial) {
  const controller = new AbortController();
  let timer;
  const started = performance.now();
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error(`Timed out after ${timeoutMs}ms.`)); }, timeoutMs);
    });
    const output = await Promise.race([Promise.resolve().then(() => adapter(structuredClone(item.input), { id: item.id, trial, signal: controller.signal })), timeout]);
    // Reject lossy serialization (undefined fields, NaN, functions, Dates, etc.).
    const serialized = JSON.stringify(output);
    if (serialized === undefined || !isDeepStrictEqual(JSON.parse(serialized), output)) throw new Error('Adapter must return a losslessly JSON-compatible value.');
    const grades = item.graders.map(grader => grade(output, grader));
    return { passed: grades.every(g => g.passed), output: JSON.parse(serialized), grades, durationMs: Math.round(performance.now() - started) };
  } catch (error) {
    return { passed: false, error: error instanceof Error ? error.message : 'Adapter failed.', grades: item.graders.map(g => ({ type: g.type, passed: false, reason: 'Not evaluated: adapter failed or timed out.' })), durationMs: Math.round(performance.now() - started) };
  } finally { clearTimeout(timer); }
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

export async function runCases(cases, adapter, { timeoutMs = 30000, repeat = 1, concurrency = 1 } = {}) {
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 100) throw new Error('repeat must be an integer from 1 to 100.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw new Error('timeoutMs must be an integer from 1 to 600000.');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('concurrency must be an integer from 1 to 32.');
  if (!cases.length || cases.length * repeat > 100000) throw new Error('Evaluation must contain 1–100000 total trials.');
  // Cases run in parallel up to the limit; trials within a case stay sequential.
  const results = await mapWithConcurrency(cases, concurrency, async item => {
    const trials = [];
    for (let trial = 1; trial <= repeat; trial++) trials.push(await runTrial(item, adapter, timeoutMs, trial));
    const representative = trials.find(t => !t.passed) || trials[0];
    return { id: item.id, tags: item.tags || [], ...representative,
      passed: trials.every(t => t.passed),
      durationMs: trials.reduce((sum, t) => sum + t.durationMs, 0),
      ...(repeat > 1 ? { trials } : {})
    };
  });
  return {
    version: 1,
    trialsPerCase: repeat,
    datasetHash: fingerprint([...cases].sort((a, b) => a.id.localeCompare(b.id))),
    total: results.length,
    passed: results.filter(r => r.passed).length,
    results
  };
}

export function validateRun(run) {
  if (!run || run.version !== 1 || !/^[a-f0-9]{64}$/.test(run.datasetHash) || !Number.isInteger(run.total) || run.total < 1 || !Array.isArray(run.results) || run.results.length !== run.total) throw new Error('Invalid run artifact.');
  const repeat = run.trialsPerCase ?? 1;
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 100 || run.total * repeat > 100000) throw new Error('Invalid trial configuration.');
  const ids = new Set();
  for (const result of run.results) {
    if (!result || typeof result.id !== 'string' || !/^[a-zA-Z0-9._-]{1,100}$/.test(result.id) || ids.has(result.id) || typeof result.passed !== 'boolean') throw new Error('Invalid run results.');
    if (result.tags !== undefined && (!Array.isArray(result.tags) || result.tags.length > 20 || new Set(result.tags).size !== result.tags.length || result.tags.some(tag => typeof tag !== 'string' || !/^[a-zA-Z0-9._-]{1,64}$/.test(tag)))) throw new Error('Invalid result tags.');
    if (repeat > 1 || result.trials !== undefined) {
      if (!Array.isArray(result.trials) || result.trials.length !== repeat || result.trials.some(t => !t || typeof t.passed !== 'boolean' || !Number.isFinite(t.durationMs) || t.durationMs < 0 || !Array.isArray(t.grades) || !t.grades.length || t.grades.some(g => !g || typeof g.passed !== 'boolean') || t.passed !== t.grades.every(g => g.passed) || (t.error !== undefined && (typeof t.error !== 'string' || t.passed))) || result.passed !== result.trials.every(t => t.passed)) throw new Error('Invalid or inconsistent trial results.');
    }
    ids.add(result.id);
  }
  if (run.passed !== run.results.filter(r => r.passed).length) throw new Error('Invalid run pass count.');
  return run;
}

export function compareRuns(baseline, current) {
  validateRun(baseline); validateRun(current);
  if ((baseline.trialsPerCase ?? 1) !== (current.trialsPerCase ?? 1)) throw new Error('Trial counts differ: compare evaluations with the same repeat setting.');
  if (baseline.datasetHash !== current.datasetHash) throw new Error('Dataset changed: use the same inputs and graders, then explicitly regenerate the baseline.');
  const previous = new Map(baseline.results.map(r => [r.id, r.passed]));
  if (baseline.total !== current.total || current.results.some(r => !previous.has(r.id))) throw new Error('Case IDs differ between runs.');
  const newFailures = current.results.filter(r => previous.get(r.id) && !r.passed).map(r => r.id).sort();
  const fixed = current.results.filter(r => !previous.get(r.id) && r.passed).map(r => r.id).sort();
  const baselineRows = new Map(baseline.results.map(r => [r.id, r]));
  for (const row of current.results) {
    if (!isDeepStrictEqual([...(row.tags || [])].sort(), [...(baselineRows.get(row.id).tags || [])].sort())) throw new Error('Result tags differ between runs. Regenerate the baseline.');
  }
  const tags = [...new Set(current.results.flatMap(r => r.tags || []))].sort();
  const slices = tags.map(tag => {
    const rows = current.results.filter(r => r.tags?.includes(tag));
    return { tag, total: rows.length, baselinePassed: rows.filter(r => previous.get(r.id)).length, currentPassed: rows.filter(r => r.passed).length, newFailures: rows.filter(r => previous.get(r.id) && !r.passed).length };
  });
  return {
    version: 1,
    total: current.total,
    trialsPerCase: current.trialsPerCase ?? 1,
    baselinePassed: baseline.passed,
    currentPassed: current.passed,
    newFailures,
    fixed,
    existingFailures: current.results.filter(r => !previous.get(r.id) && !r.passed).map(r => r.id).sort(),
    regression: newFailures.length > 0,
    slices
  };
}
