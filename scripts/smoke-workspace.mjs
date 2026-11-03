import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const web = join(root, 'apps/web');
const compiler = join(root, 'packages/config-compiler');
// Temporary consumer files resolve through the Web App's actual workspace dependency.
const temporary = await mkdtemp(join(web, '.workspace-smoke-'));
const name = '@sing-box-config-manager/config-compiler';
try {
  await writeFile(join(temporary, 'runtime.mjs'), `
import assert from 'node:assert/strict';
import { compile, compileRecipe, resolveRecipe, inspectRecipeComposition, prepareRecipePublication, preparePublication, renderSubscription, validateRecipeDraft, decideRecipeEdit, decideNodeRevisionDeletion } from '${name}';
import { createSingBoxChecker, publish, publishRecipe } from '${name}/publisher';
const result = compile({
  template: { id: 'smoke', revision: '1', targetVersion: '1.14.4', defaults: {},
    resources: {}, platformDnsServers: {}, dnsPresets: {}, routePresets: {}, ecsResponseTags: [] },
  recipe: { id: 'smoke', revision: '1', resources: {}, dnsSteps: [], routeSteps: [] },
  profile: 'macos-standalone', artifacts: [], params: { ecs: null }
});
assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
for (const fn of [compileRecipe, resolveRecipe, inspectRecipeComposition, prepareRecipePublication, preparePublication, renderSubscription, validateRecipeDraft, decideRecipeEdit, decideNodeRevisionDeletion, createSingBoxChecker, publish, publishRecipe]) assert.equal(typeof fn, 'function');
`);
  execFileSync(process.execPath, [join(temporary, 'runtime.mjs')], { cwd: web, stdio: 'inherit' });

  await writeFile(join(temporary, 'consumer.mts'), `
import { compile, compileRecipe, resolveRecipe, inspectRecipeComposition, prepareRecipePublication, artifactManifestSchema, ruleSubscriptionSchema, preparePublication, type RuleSubscription, type ArtifactManifest, type RecipePublicationSource, type RecipeCompileInput, type RecipeDocument, type TemplateDocument, type NodeRevision, type CompileInput, type Result, type CompiledConfig } from '${name}';
import { createSingBoxChecker } from '${name}/publisher';
import { validateRecipeDraft, decideRecipeEdit, decideNodeRevisionDeletion, type RecipeEditInput, type NodeRevisionDeletionInput, type EditDecision } from '${name}';
const compileTyped: (input: CompileInput) => Result<CompiledConfig> = compile;
const check: (config: CompiledConfig['config']) => Promise<void> = createSingBoxChecker('/unused');
// This must be a type error: an untyped JS export would make the directive fail.
// @ts-expect-error target version is deliberately unsupported
const invalidVersion: CompileInput['template']['targetVersion'] = 'invalid';
const resolveTyped: (input: RecipeCompileInput) => Result<CompileInput> = resolveRecipe;
const prepareTyped: (input: unknown, check: (config: CompiledConfig['config']) => Promise<void>) => ReturnType<typeof preparePublication> = prepareRecipePublication;
const sourceNodes: RecipePublicationSource['nodes'] = [{ id: 'fixed', revision: '1' }];
void [prepareTyped, sourceNodes, inspectRecipeComposition];
const recipeTyped: (input: RecipeCompileInput) => Result<CompiledConfig> = compileRecipe;
// @ts-expect-error Profile is fixed to the supported five variants
const invalidProfile: RecipeDocument['profile'] = 'linux';
const dnsSteps: RecipeDocument['dnsSteps'] = [
  { id: 'evaluate', rule: { action: 'evaluate', server: 'dns', tag: 'first' } },
  { id: 'respond', rule: { match_response: 'first', action: 'respond' } },
];
const dnsServers: RecipeDocument['resources']['dnsServers'] = [{ type: 'https', tag: 'dns', server: '8.8.8.8', server_port: 443, headers: { Host: 'dns.google' }, domain_resolver: { server: 'local', strategy: 'ipv4_only' } }];
const httpClients: TemplateDocument['resources']['httpClients'] = [{ tag: 'download', detour: 'direct', domain_resolver: 'dns' }];
// @ts-expect-error dynamic ECS belongs to generation params, never a Recipe rule
const staleEcs: RecipeDocument['dnsSteps'] = [{ id: 'bad', rule: { action: 'evaluate', server: 'dns', client_subnet: '8.8.8.0/24' } }];
const artifactRef: NonNullable<RecipeDocument['resources']['ruleSets']>[number] = { kind: 'curated', tag: 'domains', artifactRef: { id: 'system@1:source', revision: '1', usage: 'dns-query' }, httpClient: 'download' };
const manifests: ArtifactManifest[] = [];
const subscriptions: RuleSubscription[] = [];
const subscriptionBinding: NonNullable<Extract<RecipeDocument, { schemaVersion: 2 }>['resources']['ruleSets']>[number] = { kind: 'subscription', tag: 'stable', subscriptionRef: { systemRuleSetId: 'v2fly:category-ai', usages: ['route', 'dns-query'] } };
// @ts-expect-error v2 no longer permits fixed rule artifact bindings
const v2FixedBinding: NonNullable<Extract<RecipeDocument, { schemaVersion: 2 }>['resources']['ruleSets']>[number] = artifactRef;
void [subscriptions, subscriptionBinding, v2FixedBinding, ruleSubscriptionSchema];
// @ts-expect-error unknown artifact capabilities must never be treated as compatible
const unknownCapability: ArtifactManifest['artifacts'][number]['requiredCapabilities'] = ['unknown'];
void [dnsSteps, dnsServers, httpClients, staleEcs, artifactRef, manifests, unknownCapability, artifactManifestSchema];
const dependencies: RecipeCompileInput['dependencies'] = { templates: [] as TemplateDocument[], nodes: [] as NodeRevision[] };
void [compileTyped, check, invalidVersion, resolveTyped, recipeTyped, invalidProfile, dependencies];
const draftTyped: (input: unknown) => Result<RecipeDocument> = validateRecipeDraft;
const editTyped: (input: RecipeEditInput) => EditDecision<RecipeDocument> = decideRecipeEdit;
const deleteTyped: (input: NodeRevisionDeletionInput) => EditDecision<{ id: string; revision: string }> = decideNodeRevisionDeletion;
// @ts-expect-error lifecycle state must be explicitly boolean
const invalidState: RecipeEditInput['nodes'] = [{ id: 'node', archived: 'false' }];
void [draftTyped, editTyped, deleteTyped, invalidState];
`);
  await writeFile(join(temporary, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, types: [] },
    files: ['consumer.mts'],
  }));
  // The Compiler owns these tools; root and Web App do not rely on hoisted dev dependencies.
  execFileSync('pnpm', ['--dir', compiler, 'exec', 'tsc', '-p', join(temporary, 'tsconfig.json')], { cwd: root, stdio: 'inherit' });

  await writeFile(join(temporary, 'browser.mjs'), `export { compile, compileRecipe, resolveRecipe, inspectRecipeComposition, prepareRecipePublication, recipeSchema, templateSchema, nodeRevisionSchema, artifactManifestSchema, ruleSubscriptionSchema, renderSubscription, validateRecipeDraft, decideRecipeEdit, decideNodeRevisionDeletion } from '${name}';\n`);
  execFileSync('pnpm', ['--dir', compiler, 'exec', 'esbuild', join(temporary, 'browser.mjs'), '--bundle', '--platform=browser', '--format=esm', '--log-level=error', `--outfile=${join(temporary, 'browser.bundle.mjs')}`], { cwd: root, stdio: 'inherit' });
  console.log('Workspace smoke passed: Web App imports, public declarations, and browser bundle.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
