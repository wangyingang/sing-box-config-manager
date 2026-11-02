import assert from 'node:assert/strict';
import type { Result } from '../src/types.js';
export function success<T>(result: Result<T>): T {
  assert.ok(result.ok, JSON.stringify(result.diagnostics));
  return result.value;
}
