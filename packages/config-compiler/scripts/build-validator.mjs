import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import standalone from 'ajv/dist/standalone/index.js';

const schemaBytes = await readFile(new URL('../schemas/sing-box-1.14.4.json', import.meta.url));
const metadata = JSON.parse(await readFile(new URL('../schemas/build.json', import.meta.url), 'utf8'));
if (createHash('sha256').update(schemaBytes).digest('hex') !== metadata.schemaSha256) {
  throw new Error('Schema hash differs from the pinned build metadata');
}
// The upstream schema includes annotations unknown to Ajv. Validation keywords remain active.
const ajv = new Ajv2020({ strict: false, allErrors: true, code: { source: true }, inlineRefs: false });
const validate = ajv.compile(JSON.parse(schemaBytes));
await writeFile(new URL('../src/generated/validate.cjs', import.meta.url), standalone(ajv, validate));
