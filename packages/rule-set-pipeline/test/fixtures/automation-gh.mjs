#!/usr/bin/env node
// External gh boundary for local refusal tests. Unexpected requests fail closed.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const directory = process.env.AUTOMATION_FAKE_DIRECTORY;
const statePath = `${directory}/state.json`;
let state;
try { state = JSON.parse(readFileSync(statePath, 'utf8')); }
catch { state = { requests: [], refs: {}, runs: [], sequence: 0 }; }
const args = process.argv.slice(2);
const scenario = process.env.AUTOMATION_FAKE_SCENARIO;
const implementation = process.env.RULE_AUTOMATION_COMMIT;
const input = args.includes('--input') ? JSON.parse(readFileSync(0, 'utf8')) : undefined;
state.requests.push({ args, input });
function request() {
  const path = args[1];
  if (args[0] === 'run' && args[1] === 'download') {
    const destination = args[args.indexOf('--dir') + 1];
    mkdirSync(destination, { recursive: true });
    const run = state.runs.find(run => run.id === Number(args[2]));
    const rows = ['changing', 'deleting', 'fixed'].map(id => ({ id, status: 'delivered', current: { versionId: `version-${id}` } }));
    writeFileSync(`${destination}/rule-result.json`, JSON.stringify({ event: run.event, target: state.target, exitCode: 0,
      results: [{ operation: 'sync', configurationRevision: state.sourceHead, results: rows }] }));
    writeFileSync(`${destination}/rule-execution.json`, JSON.stringify({ runId: String(run.id), runAttempt: '1',
      eventSha: run.head_sha, workflowSha: scenario === 'workflow-sha-mismatch' ? 'b'.repeat(40) : run.head_sha,
      checkoutCommit: scenario === 'checkout-sha-mismatch' ? 'b'.repeat(40) : state.sourceHead }));
    return null;
  }
  if (args[0] !== 'api') throw new Error(`Unexpected fake gh request: ${args.join(' ')}`);
  if (path.endsWith('/actions/variables')) return { variables: [] };
  if (path.includes('/git/ref/heads/')) {
    const moved = path.endsWith(`/heads/${process.env.RULE_AUTOMATION_BRANCH}`)
      && (scenario === 'initial-head-moved' || (scenario === 'head-moved-during-run' && state.runs.length));
    return { object: { sha: moved ? 'b'.repeat(40) : implementation } };
  }
  if (path.includes('/actions/workflows/') && path.includes('/runs?')) return { workflow_runs: state.runs };
  if (/\/actions\/runs\/\d+$/.test(path)) return state.runs.find(run => run.id === Number(path.split('/').at(-1)));
  if (path.endsWith('/dispatches')) {
    state.runs.push({ ...state.runs[0], id: 2, event: 'workflow_dispatch', head_branch: process.env.RULE_AUTOMATION_BRANCH,
      head_sha: scenario === 'dispatch-sha-mismatch' ? 'b'.repeat(40) : implementation });
    return null;
  }
  if (path.includes('/git/matching-refs/')) {
    return Object.keys(state.refs).filter(ref => ref.startsWith(path.split('/git/matching-refs/')[0]))
      .map(ref => ({ ref: `refs/heads/${ref.split('/').at(-1)}` }));
  }
  if (path.endsWith('/git/refs')) {
    const ref = `${path.split('/git/refs')[0]}/${input.ref.slice('refs/'.length)}`;
    state.refs[ref] = input.sha;
    state.target = input.ref.slice('refs/heads/'.length);
    if (path.includes('/sing-box-config-manager/')) {
      state.sourceHead = input.sha;
      state.runs.push({ id: 1, event: 'push', head_sha: scenario === 'push-sha-mismatch' ? 'b'.repeat(40) : input.sha,
        head_branch: state.target, display_title: `Rules push · ${state.target} · sync`, status: 'completed',
        conclusion: 'success', run_attempt: 1, html_url: 'https://example.invalid/runs/1' });
    }
    return {};
  }
  if (path.includes('/git/refs/heads/') && args.includes('DELETE')) {
    delete state.refs[path.replace('/git/refs/', '/')];
    return null;
  }
  if (/\/git\/commits\/[a-f0-9]{40}$/.test(path)) return { tree: { sha: 'c'.repeat(40) } };
  if (/\/git\/(blobs|trees|commits)$/.test(path)) return { sha: (++state.sequence).toString(16).padStart(40, '0') };
  throw new Error(`Unexpected fake gh request: ${args.join(' ')}`);
}
try { process.stdout.write(JSON.stringify(request())); }
finally { writeFileSync(statePath, JSON.stringify(state)); }
