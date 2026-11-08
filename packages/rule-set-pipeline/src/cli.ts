#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { saveActivationReceipt } from './activation-receipt.js';
import { activateRules, rollbackRules } from './activation.js';
import { githubActivation } from './activation-transport.js';
import { rebuildRules, updateRules } from './update.js';
import { githubPublication } from './publication.js';
import { manageMaintenance, type MaintenanceSchedule } from './maintenance.js';
import { initializeRemoteState } from './remote-state.js';
import { readRemoteStatus } from './remote-status.js';
import { sha256 } from './release.js';
import { buildRelease, buildNative, decodedTerms, NativeBuildError, type SourceRecord } from './index.js';
import { checkRules, resumeRules } from './check-rules.js';
import { buildConfiguredRelease } from './configured-build.js';
import { configuredSubscriptions, parseBuildConfiguration } from './configuration.js';

async function sourceToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try { return (await promisify(execFile)('gh', ['auth', 'token'])).stdout.trim(); }
  catch { return undefined; } // The source API can also serve anonymous reads.
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { state: { type: 'string' }, release: { type: 'string' }, out: { type: 'string' }, config: { type: 'string' }, id: { type: 'string', multiple: true }, 'expected-source': { type: 'string' }, binary: { type: 'string' }, candidate: { type: 'string' }, activation: { type: 'string' }, subscription: { type: 'string' }, 'expected-head': { type: 'string' }, branch: { type: 'string' },
      'period-days': { type: 'string' }, 'start-at': { type: 'string' }, manual: { type: 'boolean' },
      'maintenance-id': { type: 'string' }, help: { type: 'boolean' } },
  });
  if (values.help) {
    console.log('Usage: build --release <fixed-tag> --out <new-directory> --binary <absolute-1.14.4-path> [--config <versioned-yaml> [--id <logical-id> ...]] [--expected-source <source.json>] | update --state <directory> --binary <absolute-1.14.4-path> [--config <versioned-yaml> [--id <logical-id> ...] [--release <pinned-tag>]] | check-now --state <directory> --binary <absolute-1.14.4-path> --config <versioned-yaml> [--subscription <v2-contract-map.json>] [--id <logical-id> ...] | resume --state <directory> --binary <absolute-1.14.4-path> --config <versioned-yaml> [--subscription <v2-contract-map.json>] --id <logical-id> | initialize/status [--config <yaml> | --branch <target>] | maintenance-preview/maintenance-enter/maintenance-prepare/maintenance-switch/maintenance-resume/maintenance-abort | rebuild/activate/rollback (see package README)');
    return 0;
  }
  const maintenanceAction = positionals.length === 1 ? /^maintenance-(preview|enter|prepare|switch|resume|abort)$/.exec(positionals[0])?.[1] : undefined;
  if (maintenanceAction) {
    if (values.config || values.state || values.release || values.out || values.id || values['expected-source']
      || values.candidate || values.activation || values.subscription || values['expected-head']) throw new Error('Invalid maintenance options');
    const target = values.branch ?? 'main';
    if (target !== 'main' && !/^acceptance-[a-zA-Z0-9._-]+$/.test(target)) {
      throw new Error('Maintenance target must be main or an acceptance branch');
    }
    const repository = githubPublication(undefined, target === 'main' ? 'candidates' : target).repository!;
    const options = { repository, binary: values.binary };
    const period = values['period-days'], startAt = values['start-at'], maintenanceId = values['maintenance-id'];
    let result;
    if (maintenanceAction === 'preview' || maintenanceAction === 'enter') {
      if ((period === undefined) !== (startAt === undefined) || (period !== undefined && !/^[1-9][0-9]*$/.test(period))
        || maintenanceId !== undefined) throw new Error('Use --period-days and --start-at together');
      const schedule: MaintenanceSchedule | undefined = period !== undefined ? { periodDays: Number(period), startAt: startAt! } : undefined;
      result = await manageMaintenance({ ...options, action: maintenanceAction, schedule, manual: values.manual });
    } else {
      if (period !== undefined || startAt !== undefined || values.manual !== undefined || !!maintenanceId !== (maintenanceAction === 'abort')) {
        throw new Error('maintenance-abort requires --maintenance-id; other maintenance commands use the recorded identity');
      }
      result = maintenanceAction === 'abort' ? await manageMaintenance({ ...options, action: 'abort', maintenanceId: maintenanceId! })
        : await manageMaintenance({ ...options, action: maintenanceAction as 'prepare' | 'resume' | 'switch' });
    }
    console.log(JSON.stringify(result));
    return result.status === 'failed' ? 1 : 0;
  }
  if (values['period-days'] !== undefined || values['start-at'] !== undefined || values.manual !== undefined
    || values['maintenance-id'] !== undefined) throw new Error('Maintenance options require a maintenance command');
  if (positionals.length === 1 && ['check-now', 'resume'].includes(positionals[0])) {
    const resume = positionals[0] === 'resume';
    if (!values.config || !values.state || !values.binary || values.out || values.release
      || values['expected-source'] || values.activation || values.candidate || values['expected-head'] || values.branch || (resume && values.id?.length !== 1)) {
      throw new Error(`${positionals[0]} requires --config, --state and --binary${resume ? ', and exactly one --id' : ''}`);
    }
    const configuration = await readFile(values.config, 'utf8');
    const subscriptions = values.subscription ? JSON.parse(await readFile(values.subscription, 'utf8'))
      : configuredSubscriptions(parseBuildConfiguration(configuration));
    if (!subscriptions || typeof subscriptions !== 'object' || Array.isArray(subscriptions)) {
      throw new Error(`${positionals[0]} requires a JSON object of v2 Rule Subscriptions keyed by logical ID`);
    }
    const options = { configuration, subscriptions,
      stateDirectory: resolve(values.state), binary: values.binary, token: await sourceToken() };
    const result = resume
      ? await resumeRules({ ...options, logicalId: values.id![0] })
      : await checkRules({ ...options, selectedIds: values.id });
    console.log(JSON.stringify(result));
    return result.exitCode;
  }
  if (positionals.length === 1 && ['activate', 'rollback'].includes(positionals[0])) {
    const rollback = positionals[0] === 'rollback';
    if (!values.state || (!values.config && !values.subscription) || !values['expected-head'] || !values.binary
      || (rollback ? !values.activation || !!values.candidate : !values.candidate || !!values.activation)
      || values.release || values.out || values['expected-source']
      || (values.config ? values.id?.length !== 1 : !!values.id)) throw new Error(`${positionals[0]} requires --state, ${rollback ? '--activation' : '--candidate'}, --expected-head, --binary and either --config with one --id or --subscription`);
    const configuration = values.config ? await readFile(values.config, 'utf8') : undefined;
    const parsed = configuration === undefined ? undefined : parseBuildConfiguration(configuration);
    const logicalId = values.id?.[0];
    if (parsed && values.branch && values.branch !== parsed.target.branch) throw new Error('Configuration and branch disagree');
    const subscription = values.subscription ? JSON.parse(await readFile(values.subscription, 'utf8'))
      : configuredSubscriptions(parsed!)[logicalId!];
    const common = { ...(parsed ? { configuration, logicalId, stateDirectory: resolve(values.state) } : {}), subscription, binary: values.binary,
      expectedHead: values['expected-head'], transport: githubActivation(parsed?.target.branch ?? values.branch) };
    const result = rollback
      ? await rollbackRules({ ...common, historicalActivationCommit: values.activation! })
      : await activateRules({ ...common, candidateEvidenceUrl: values.candidate! });
    if (!values.config) await saveActivationReceipt(resolve(values.state), result);
    console.log(JSON.stringify(result));
    return 0;
  }
  if (positionals.length === 1 && ['initialize', 'status'].includes(positionals[0])) {
    if (values.release || values.out || values['expected-source'] || values.activation || values.candidate || values.subscription
      || values['expected-head'] || values.id || (positionals[0] === 'initialize' && values.binary)) throw new Error('Invalid remote state options');
    const target = values.config ? parseBuildConfiguration(await readFile(values.config, 'utf8')).target.branch : values.branch ?? 'main';
    if (values.config && values.branch && target !== values.branch) throw new Error('Configuration and branch disagree');
    const publication = githubPublication(undefined, target === 'main' ? 'candidates' : target);
    const result = positionals[0] === 'initialize'
      ? await initializeRemoteState(publication.repository!, target)
      : await readRemoteStatus({ repository: publication.repository!, publication, binary: values.binary });
    console.log(JSON.stringify(result));
    return 0;
  }
  if (values.activation || values.candidate || values.subscription || values['expected-head'] || values.branch) throw new Error('Activation options require activate/rollback');
  if ((values.config || values.id) && !['build', 'update', 'rebuild'].includes(positionals[0])) throw new Error('--config and --id require build, update or rebuild');
  if (positionals.length === 1 && ['update', 'rebuild'].includes(positionals[0])) {
    const rebuild = positionals[0] === 'rebuild';
    if (!values.state || values.out || values['expected-source'] || (rebuild ? !values.release || !values.binary || values.release.toLowerCase() === 'latest' :
          values.release && (positionals[0] !== 'update' || !values.config || !values.id?.length || values.release.toLowerCase() === 'latest')) ||
        (rebuild && (!!values.config !== !!values.id?.length)) || (positionals[0] === 'status' && (values.config || values.id)) ||
        (positionals[0] === 'update' && (values.id && !values.config || values.config && !values.binary))) {
      throw new Error('update/status requires --state; rebuild requires --state, --release <fixed-tag> and --binary');
    }
    {
      const options = { stateDirectory: resolve(values.state), binary: values.binary ?? '', token: await sourceToken() };
      const result = rebuild ? values.config
        ? await rebuildRules({ ...options, release: values.release!, configuration: await readFile(values.config, 'utf8'), selectedIds: values.id! })
        : await rebuildRules({ ...options, release: values.release! }) : values.config
        ? await updateRules({ ...options, configuration: await readFile(values.config, 'utf8'), selectedIds: values.id, retryRelease: values.release })
        : await updateRules(options);
      console.log(JSON.stringify(result));
      if ('results' in result && result.results.some(entry => entry.status === 'failed')) return 1;
    }
    return 0;
  }
  if (positionals.length !== 1 || positionals[0] !== 'build' || !values.release || !values.out) {
    throw new Error('必须使用 build --release <fixed-tag> --out <new-directory>');
  }
  const expectedSource = values['expected-source']
    ? JSON.parse(await readFile(values['expected-source'], 'utf8')) as SourceRecord : undefined;
  if (values['expected-source'] && (!expectedSource || typeof expectedSource !== 'object')) {
    throw new Error('expected-source 必须为来源记录 object');
  }
  const out = resolve(values.out);
  if (values.id && !values.config) throw new Error('--id requires --config');
  if (values.config) {
    const configuration = await readFile(values.config, 'utf8');
    const built = await buildConfiguredRelease({ configuration, selectedIds: values.id,
      release: { tag: values.release, expectedSource, token: process.env.GITHUB_TOKEN }, binary: values.binary ?? '' });
    await mkdir(out);
    const writeJson = (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
    await writeJson(join(out, 'source.json'), built.source);
    const summary = [];
    for (const result of built.results) {
      const directory = join(out, result.id);
      await mkdir(directory);
      await writeJson(join(directory, 'conversion-report.json'), result.report);
      if (result.status === 'failed') {
        await writeJson(join(directory, 'failure.json'), { id: result.id, error: result.error });
        summary.push({ id: result.id, status: result.status, error: result.error });
        continue;
      }
      for (const artifact of result.native.artifacts) await writeFile(join(directory, artifact.file), artifact.content, { flag: 'wx' });
      const { artifacts, buildId: nativeBuildId, ...native } = result.native;
      await writeJson(join(directory, 'build.json'), { id: result.id, definition: result.definition, target: built.configuration.target,
        source: built.source, tools: built.tools, buildId: result.buildId, nativeBuildId, ...native,
        artifacts: artifacts.map(({ content: _content, ...metadata }) => metadata) });
      summary.push({ id: result.id, status: result.status, buildId: result.buildId });
    }
    await writeJson(join(out, 'batch.json'), { release: values.release, source: built.source,
      configuration: built.configuration, results: summary });
    console.log(JSON.stringify({ out, results: summary }));
    return summary.some(result => result.status === 'failed') ? 1 : 0;
  }
  // Exclusive directory creation prevents overwriting a previous build, including
  // when a later attempt fails. The parent directory must already exist.
  await mkdir(out);
  const result = await buildRelease({ tag: values.release, expectedSource, token: process.env.GITHUB_TOKEN });
  const writeJson = (file: string, value: unknown) => writeFile(join(out, file), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  await writeJson('conversion-report.json', result.report);
  if (result.source) await writeJson('source.json', result.source);
  if (!result.ok) {
    await writeJson('failure.json', { status: result.status, diagnostics: result.report.diagnostics });
    console.error(JSON.stringify({ status: 'failed', out, diagnostics: result.report.diagnostics }));
    return 1;
  }
  try {
    const native = await buildNative(decodedTerms(JSON.parse(result.json)), values.binary ?? '');
    for (const artifact of native.artifacts) {
      await writeFile(join(out, artifact.file), artifact.content, { flag: 'wx' });
    }
    const { json: _json, report: _report, artifact: _artifact, usages: _usages, status: _status, ...record } = result;
    const { artifacts, ...validation } = native;
    const buildId = sha256(JSON.stringify({ source: result.source, tools: result.tools, nativeBuildId: native.buildId }));
    // Completion is written last. It proves local validation, never publication.
    await writeJson('build.json', { ...record, ...validation, buildId,
      artifacts: artifacts.map(({ content: _content, ...metadata }) => metadata) });
    console.log(JSON.stringify({ status: native.status, out, buildId }));
  } catch (error) {
    await writeJson('failure.json', { status: 'failed', message: String(error),
      steps: error instanceof NativeBuildError ? error.steps : [] });
    console.error(String(error));
    return 1;
  }
  return 0;
}

try { process.exitCode = await main(); }
catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
