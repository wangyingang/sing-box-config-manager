import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { verifyDelivery } from './verify-delivery.js';

try {
  const { values } = parseArgs({ options: { status: { type: 'string' }, retired: { type: 'string', multiple: true } } });
  if (!values.status) throw new Error('Usage: rules:verify-delivery --status <file> [--retired <URL> ...]');
  const statusPath = resolve(process.env.INIT_CWD ?? process.cwd(), values.status);
  const status = JSON.parse(await readFile(statusPath, 'utf8'));
  const report = await verifyDelivery(status, values.retired ?? []);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
}
