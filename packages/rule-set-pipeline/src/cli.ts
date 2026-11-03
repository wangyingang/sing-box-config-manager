#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { updateRules, readUpdateState } from './update.js';
import { sha256 } from './release.js';
import { buildRelease, buildNative, decodedTerms, NativeBuildError, type SourceRecord } from './index.js';

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { state: { type: 'string' }, release: { type: 'string' }, out: { type: 'string' }, 'expected-source': { type: 'string' }, binary: { type: 'string' }, help: { type: 'boolean' } },
  });
  if (values.help) {
    console.log('Usage: update --state <directory> --binary <absolute-1.14.4-path> | status --state <directory> |  build --release <fixed-tag> --out <new-directory> --binary <absolute-1.14.4-path> [--expected-source <source.json>]');
    return 0;
  }
  if (positionals.length === 1 && ['update', 'status'].includes(positionals[0])) {
    if (!values.state || values.release || values.out || values['expected-source']) throw new Error('update/status requires --state; fixed build options are not accepted');
    if (positionals[0] === 'status') {
      console.log(JSON.stringify(await readUpdateState(resolve(values.state))));
    } else {
      let token = process.env.GITHUB_TOKEN;
      if (!token) {
        try { token = (await promisify(execFile)('gh', ['auth', 'token'])).stdout.trim(); } catch { /* public API may work without auth */ }
      }
      console.log(JSON.stringify(await updateRules({ stateDirectory: resolve(values.state), binary: values.binary ?? '', token })));
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
