#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildRelease, type SourceRecord } from './index.js';

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { release: { type: 'string' }, out: { type: 'string' }, 'expected-source': { type: 'string' }, help: { type: 'boolean' } },
  });
  if (values.help) {
    console.log('Usage: build --release <fixed-tag> --out <new-directory> [--expected-source <source.json>]');
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
  await writeFile(join(out, 'domains.json'), result.json, { flag: 'wx' });
  const { json: _json, report: _report, ...record } = result;
  // Write completion record last; this is neither a verified candidate nor a
  // successfully processed Release record (native validation/publishing follow).
  await writeJson('build.json', record);
  console.log(JSON.stringify({ status: result.status, out, artifact: result.artifact }));
  return 0;
}

try { process.exitCode = await main(); }
catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
