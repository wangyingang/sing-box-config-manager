import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const absWorkingDir = fileURLToPath(new URL('../', import.meta.url));
await build({ absWorkingDir, entryPoints: ['src/index.ts'], bundle: true, platform: 'browser', format: 'esm', target: 'es2022', outfile: 'dist/index.js', minify: true });
await build({ absWorkingDir, entryPoints: ['src/publisher.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node24', outfile: 'dist/publisher.js', minify: true });
