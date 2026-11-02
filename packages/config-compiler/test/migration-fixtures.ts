import { readFileSync } from 'node:fs';
import type { RecipeCompileInput } from '../src/index.js';

export const migrationCases = ['user-a-tun', 'user-b-tun', 'user-b-android-tun', 'user-c-tun', 'user-d-tun'] as const;
export type MigrationCase = typeof migrationCases[number];

/** Static new-contract records; no legacy fragment conversion occurs at runtime. */
export function migrationInput(id: MigrationCase = 'user-a-tun'): RecipeCompileInput {
  return JSON.parse(readFileSync(new URL(`./fixtures/migrated/${id}.json`, import.meta.url), 'utf8'));
}

export function migrationMapping(id: MigrationCase) {
  return JSON.parse(readFileSync(new URL(`./fixtures/migrated/${id}.mapping.json`, import.meta.url), 'utf8'));
}
