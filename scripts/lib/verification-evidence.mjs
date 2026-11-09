import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const filename = value => text(value) && value !== '.' && value !== '..' && !/[\\/\x00-\x1f\x7f]/.test(value);
const metrics = ['tests', 'pass', 'fail', 'skipped', 'cancelled', 'todo'];
const scopes = { 'check-only': ['check'], 'check-native': ['check', 'integration'], 'check-native-release': ['check', 'integration', 'release'] };
function requireThat(condition, message) { if (!condition) throw new Error(message); }

function fileRecord(record, label, key = 'path') {
  requireThat(object(record) && filename(record[key]) && digest(record.sha256) && integer(record.byteLength), `${label} 的文件名、大小或 SHA-256 无效`);
  return { path: record[key], byteLength: record.byteLength, sha256: record.sha256 };
}

function stepRecord(step, label) {
  requireThat(object(step) && text(step.name) && (step.exitCode === null || integer(step.exitCode)) && Array.isArray(step.suites), `${label} 需要名称、退出码和 suites 数组`);
  requireThat(step.signal === null || typeof step.signal === 'string', `${label}.signal 无效`);
  requireThat(step.interrupted === undefined || text(step.interrupted), `${label}.interrupted 无效`);
  requireThat(step.error === undefined || text(step.error), `${label}.error 无效`);
  const log = fileRecord(step, label, 'log');
  const stdout = step.stdout === undefined ? undefined : fileRecord(step.stdout, `${label}.stdout`, 'log');
  const counts = Object.fromEntries(metrics.map(key => [key, 0]));
  for (const suite of step.suites) {
    requireThat(object(suite) && text(suite.name), `${label}.suites 包含无效测试组`);
    for (const metric of metrics) {
      const value = suite[metric] ?? (['cancelled', 'todo'].includes(metric) ? 0 : undefined);
      requireThat(integer(value), `${label}.suites.${metric} 必须是非负安全整数`);
      counts[metric] += value;
      requireThat(integer(counts[metric]), `${label}.${metric} 总数超出安全整数范围`);
    }
  }
  return { name: step.name, exitCode: step.exitCode, signal: step.signal, ...counts,
    ...(step.interrupted ? { interrupted: step.interrupted } : {}), ...(step.error ? { error: step.error } : {}),
    log, ...(stdout ? { stdout } : {}) };
}

function summaryRecord(summary) {
  requireThat(object(summary) && summary.schemaVersion === 1, 'summary.json 需要 schemaVersion 1');
  requireThat(['passed', 'failed', 'running'].includes(summary.status), 'summary.json.status 无效');
  requireThat(Object.hasOwn(scopes, summary.scope), 'summary.json.scope 无效');
  const source = summary.source;
  requireThat(object(source) && typeof source.commit === 'string' && /^[a-f0-9]{40}$/.test(source.commit)
    && typeof source.clean === 'boolean' && typeof source.status === 'string' && digest(source.trackedDiffSha256)
    && source.clean === (source.status.length === 0), 'summary.json.source 源码身份无效或不一致');
  requireThat(object(summary.tools) && object(summary.tools.node) && text(summary.tools.node.version) && text(summary.tools.node.executable), 'summary.json.tools 缺少 Node 身份');
  requireThat(Array.isArray(summary.steps) && Array.isArray(summary.preflight), 'summary.json.steps 和 preflight 必须是数组');
  requireThat(summary.error === undefined || text(summary.error), 'summary.json.error 无效');
  const steps = summary.steps.map((step, index) => stepRecord(step, `steps[${index}]`));
  const preflight = summary.preflight.map((step, index) => stepRecord(step, `preflight[${index}]`));
  const expected = scopes[summary.scope];
  requireThat(steps.length <= expected.length && steps.every((step, index) => step.name === expected[index]), 'summary.json.steps 与验证范围或执行顺序不一致');
  if (summary.status === 'passed') {
    requireThat(steps.length === expected.length, '通过的验证缺少该范围要求的步骤');
    requireThat([...preflight, ...steps].every(step => step.exitCode === 0 && step.signal === null && !step.interrupted && !step.error), '通过的验证包含失败或中断的步骤');
    requireThat(steps.every(step => step.tests > 0 && step.pass === step.tests
      && ['fail', 'skipped', 'cancelled', 'todo'].every(metric => step[metric] === 0)), '通过的验证缺少完整测试统计，或包含失败、跳过的测试');
  }
  return { source, scope: summary.scope, verificationStatus: summary.status, tools: summary.tools,
    ...(summary.error ? { verificationError: summary.error } : {}), steps, preflight };
}

async function readRegularFile(directory, name, json = false) {
  requireThat(filename(name), `拒绝读取非扁平文件路径：${name}`);
  const path = join(directory, name), entry = await lstat(path);
  requireThat(entry.isFile() && !entry.isSymbolicLink(), `${name} 必须是普通文件，不能是符号链接`);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    requireThat(stat.isFile(), `${name} 不是普通文件`);
    if (json) {
      requireThat(stat.size <= 4 * 1024 * 1024, `${name} 超过 JSON 大小限制`);
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await file.readFile())); }
      catch (error) { throw new Error(`${name} 不是有效 JSON：${error.message}`); }
    }
    const hash = createHash('sha256');
    let byteLength = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      byteLength += chunk.length; hash.update(chunk);
    }
    return { byteLength, sha256: hash.digest('hex') };
  } finally { await file.close(); }
}

/** Read one verify.mjs bundle; a valid failed run stays distinct from damaged evidence. */
export async function inspectEvidence(directory) {
  const report = { directory: typeof directory === 'string' ? resolve(directory) : null, status: 'failed', integrityStatus: 'failed',
    source: null, scope: null, verificationStatus: null, steps: [], errors: [], files: { total: 0, checked: 0, failures: [] } };
  try {
    requireThat(text(directory), '证据目录不能为空');
    const stat = await lstat(report.directory);
    requireThat(stat.isDirectory() && !stat.isSymbolicLink(), '证据根路径必须是普通目录，不能是符号链接');
    const root = await realpath(report.directory);
    Object.assign(report, summaryRecord(await readRegularFile(root, 'summary.json', true)));
    const inventory = await readRegularFile(root, 'files.json', true);
    requireThat(object(inventory) && inventory.schemaVersion === 1 && Array.isArray(inventory.files), 'files.json 需要 schemaVersion 1 和 files 数组');
    const entries = inventory.files.map((record, index) => fileRecord(record, `files[${index}]`));
    const names = new Set(entries.map(entry => entry.path));
    requireThat(names.size === entries.length && names.has('summary.json') && !names.has('files.json'), 'files.json 存在重复路径、缺少 summary.json 或包含自身');
    report.files.total = entries.length;
    const failed = (path, reason) => {
      report.files.failures.push({ path, reason }); report.errors.push(`${path}：${reason}`);
    };
    const actual = new Map();
    for (const entry of entries) {
      try {
        const hash = await readRegularFile(root, entry.path);
        actual.set(entry.path, hash); report.files.checked++;
        if (hash.byteLength !== entry.byteLength || hash.sha256 !== entry.sha256) failed(entry.path, '与 files.json 的大小或 SHA-256 不符');
      } catch (error) { failed(entry.path, error.message); }
    }
    for (const name of await readdir(root)) {
      if (name !== 'files.json' && !names.has(name)) failed(name, '文件未列入 files.json');
    }
    for (const step of [...report.preflight, ...report.steps]) {
      for (const file of [step.log, step.stdout].filter(Boolean)) {
        const hash = actual.get(file.path);
        if (!hash || hash.sha256 !== file.sha256 || hash.byteLength !== file.byteLength) failed(file.path, '步骤日志摘要与清单中的实际文件不符');
      }
    }
    if (report.errors.length === 0) report.integrityStatus = 'passed';
    if (report.integrityStatus === 'passed' && report.verificationStatus === 'passed') report.status = 'passed';
  } catch (error) { report.errors.push(error.message); }
  return report;
}
