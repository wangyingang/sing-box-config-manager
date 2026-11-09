import { lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

function contains(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

export async function createReportDirectory(value, evidenceDirectories) {
  if (!value?.trim()) throw new Error('--out 需要新目录');
  const output = resolve(value);
  const existing = await lstat(output).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
  if (existing) throw new Error(`输出目录已存在，不覆盖：${output}`);
  const canonicalOutput = resolve(await realpath(dirname(output)), relative(dirname(output), output));
  const directories = evidenceDirectories.map(value => resolve(value));
  const roots = await Promise.all(directories.map(directory => realpath(directory).catch(() => directory)));
  if (new Set(roots).size !== roots.length) throw new Error('--evidence 目录不能重复');
  if (roots.some(root => contains(root, canonicalOutput))) throw new Error('输出目录不能位于被核验的证据目录内');
  await mkdir(output, { mode: 0o700 });
  return output;
}
