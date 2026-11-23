import { copyFile, writeFile } from 'node:fs/promises';

// The historical validators also run from dist with only Pipeline's production dependencies.
const alias = '#rule-subscription-v2';
const schema = './contracts/rule-subscription-v2.schema.json';
const dist = new URL('../dist/', import.meta.url);
await copyFile(new URL(import.meta.resolve(alias)), new URL(schema, dist));
await writeFile(new URL('package.json', dist), JSON.stringify({
  type: 'module',
  imports: { [alias]: schema },
}, null, 2) + '\n');
