import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { inspectEvidence } from './lib/verification-evidence.mjs';

import { createReportDirectory } from './lib/audit-output.mjs';

async function main() {
  const { values } = parseArgs({ options: { evidence: { type: 'string', multiple: true }, out: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log('Usage: node scripts/inspect-evidence.mjs --evidence <directory> [--evidence <directory> ...] --out <new directory>');
    console.log('只读核验 verify.mjs 的 summary.json、files.json 和日志；分别报告每次运行，不合并不同源码的测试统计。');
    return;
  }
  if (!values.out || !values.evidence?.length || values.evidence.some(value => !value)) throw new Error('需要 --evidence <目录> 和 --out <新目录>');
  const output = await createReportDirectory(values.out, values.evidence);
  const directories = values.evidence.map(value => resolve(value));
  const evidence = [];
  for (const directory of directories) evidence.push(await inspectEvidence(directory));
  const report = { schemaVersion: 1, inspectedAt: new Date().toISOString(), status: evidence.every(entry => entry.status === 'passed') ? 'passed' : 'failed', evidence };
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const passed = evidence.filter(entry => entry.status === 'passed').length;
  console.log(`${report.status}: ${passed}/${evidence.length} 个证据目录通过；完整报告：${resolve(output, 'report.json')}`);
  if (report.status !== 'passed') process.exitCode = 1;
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
