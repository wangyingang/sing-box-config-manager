#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { activateRules, rollbackRules } from './activation.js';
import { githubActivation } from './activation-transport.js';
import { rebuildRules, updateRules, readUpdateState } from './update.js';
import { sha256 } from './release.js';
import { buildRelease, buildNative, decodedTerms, NativeBuildError, type SourceRecord } from './index.js';
import { buildConfiguredRelease, parseBuildConfiguration } from './configured-build.js';

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { state: { type: 'string' }, release: { type: 'string' }, out: { type: 'string' }, config: { type: 'string' }, id: { type: 'string', multiple: true }, 'expected-source': { type: 'string' }, binary: { type: 'string' }, candidate: { type: 'string' }, activation: { type: 'string' }, subscription: { type: 'string' }, 'expected-head': { type: 'string' }, branch: { type: 'string' }, help: { type: 'boolean' } },
  });
  if (values.help) {
    console.log('Usage: build --release <fixed-tag> --out <new-directory> --binary <absolute-1.14.4-path> [--config <versioned-yaml> [--id <logical-id> ...]] [--expected-source <source.json>] | update --state <directory> --binary <absolute-1.14.4-path> [--config <versioned-yaml> [--id <logical-id> ...] [--release <pinned-tag>]] | status/rebuild/activate/rollback (see package README)');
    return 0;
  }
  if (positionals.length === 1 && ['activate', 'rollback'].includes(positionals[0])) {
    const rollback = positionals[0] === 'rollback';
    if (!values.state || !values.subscription || !values['expected-head'] || !values.binary
      || (rollback ? !values.activation || !!values.candidate : !values.candidate || !!values.activation)
      || values.release || values.out || values['expected-source']
      || (values.config ? values.id?.length !== 1 || rollback : !!values.id)) throw new Error(`${positionals[0]} requires --state, ${rollback ? '--activation' : '--candidate'}, --subscription, --expected-head and --binary`);
    const common = { ...(values.config ? { configuration: await readFile(values.config, 'utf8'), logicalId: values.id![0], stateDirectory: resolve(values.state) } : {}), subscription: JSON.parse(await readFile(values.subscription, 'utf8')), binary: values.binary,
      expectedHead: values['expected-head'], transport: githubActivation(values.branch) };
    const result = rollback
      ? await rollbackRules({ ...common, historicalActivationCommit: values.activation! })
      : await activateRules({ ...common, candidateEvidenceUrl: values.candidate! });
    if (!values.config) {
      const temporary = join(resolve(values.state), `active-${result.activation.id}.tmp`);
      try {
        await mkdir(resolve(values.state), { recursive: true });
        await writeFile(temporary, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
        await rename(temporary, join(resolve(values.state), 'active-version.json'));
      } catch (error) { throw new Error(`ACTIVATION_APPLIED_LOCAL_RECEIPT_PENDING: commit ${result.commit}`, { cause: error }); }
    }
    console.log(JSON.stringify(result));
    return 0;
  }
  if (values.activation || values.candidate || values.subscription || values['expected-head'] || values.branch) throw new Error('Activation options require activate/rollback');
  if ((values.config || values.id) && !['build', 'update'].includes(positionals[0])) throw new Error('--config and --id require build or update');
  if (positionals.length === 1 && ['update', 'status', 'rebuild'].includes(positionals[0])) {
    const rebuild = positionals[0] === 'rebuild';
    if (!values.state || values.out || values['expected-source'] || (rebuild ? !values.release || !values.binary || values.release.toLowerCase() === 'latest' :
          values.release && (positionals[0] !== 'update' || !values.config || !values.id?.length || values.release.toLowerCase() === 'latest')) ||
        (rebuild && (values.config || values.id)) || (positionals[0] === 'status' && (values.config || values.id)) ||
        (positionals[0] === 'update' && (values.id && !values.config || values.config && !values.binary))) {
      throw new Error('update/status requires --state; rebuild requires --state, --release <fixed-tag> and --binary');
    }
    if (positionals[0] === 'status') {
      console.log(JSON.stringify(await readUpdateState(resolve(values.state))));
    } else {
      let token = process.env.GITHUB_TOKEN;
      if (!token) {
        try { token = (await promisify(execFile)('gh', ['auth', 'token'])).stdout.trim(); } catch { /* public API may work without auth */ }
      }
      const options = { stateDirectory: resolve(values.state), binary: values.binary ?? '', token };
      const result = rebuild ? await rebuildRules({ ...options, release: values.release! }) : values.config
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
    parseBuildConfiguration(configuration);
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
