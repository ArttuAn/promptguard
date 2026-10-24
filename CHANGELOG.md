# Changelog

## 0.4.0

- `--concurrency N` evaluates up to 32 cases in parallel, reducing wall time for API-backed datasets.
- Trials within a case remain sequential, so repetition order, evidence, fingerprints, and comparisons are unchanged.
- Invalid concurrency values are rejected before inference and the option is limited to `run`.
- The symlink overwrite test now skips the alias half only on hosts where symlink creation is not permitted.
- 37 tests, including concurrency limits, stable ordering, sequential trials, and CLI validation.

## 0.3.1

- `--failed-from` reruns only failed cases from a matching full-dataset evaluation, inheriting its trial count.
- Reject stale datasets, conflicting repetitions, empty failure selections, and full-baseline/subset mixing before inference.
- `compare --details` prints changed case verdicts and failed-trial reasons without model calls.
- HTML case rows distinguish new regressions, fixes, existing failures, and unchanged passes.
- Diagnostic reasons are JSON-quoted in the terminal to escape control characters.
- Prevent artifacts from overwriting input files or sharing output paths, including existing symlink aliases; compare against the baseline snapshot loaded before inference.
- 33 tests, including rerun selection, dataset integrity, inherited repetition, detailed comparisons, safe diagnostics, and overwrite prevention.

## 0.3.0

### Stability evaluations
- `--repeat N` runs 1–100 trials per case with conservative all-trials-pass verdicts.
- Retain every trial's output, grade, error, and duration; detect observed mixed-outcome (flaky) cases.
- Repeated baselines must use the same trial count; incompatible comparisons fail before inference.
- HTML trial explorer, stability metrics, PR policy notes, and a deterministic stability demo.
- Clone inputs and snapshot JSON outputs to prevent cross-trial data contamination; reject lossy JSON values.

### Validation and reliability
- `validate --cases` checks datasets and schemas without importing adapters or calling providers.
- 26 automated tests, including repetition, baseline compatibility, input isolation, output snapshots, and per-trial HTML escaping.
- CI validates the example dataset and cancels superseded evaluations for the same branch/PR.

## 0.2.0

### Evaluation analysis
- Tagged dataset slices with per-slice baseline/current pass rates and new failure counts.
- Per-grader outcome breakdown and adapter-error counts.
- Nearest-rank p50/p95 latency, timing sample count, and total observed duration.
- `--summary` for portable aggregate metrics without raw outputs.

### Reporting
- `--html` for an offline, script-free evaluation dashboard with expandable case evidence.
- Slice comparison tables in Markdown, Actions summaries, and PR comments.
- Example HTML report and real desktop screenshot in the README.

### Reliability
- 17 automated tests, including tag validation, percentile math, HTML escaping, and failing-run exports.
- CI compatibility checks on Node.js 22 and 24.
- Adapter errors explicitly fail all configured grader applications instead of disappearing from grader denominators.
- The example baseline was intentionally refreshed after adding dataset tags; its 10/10 passing outcomes are unchanged.

## 0.1.0

Initial evaluation runner, exact-match and JSON Schema graders, saved baselines, case-level regression gates, and isolated updating PR bot. Originally released under the PromptGuard name; subsequently renamed EvalDiff.
