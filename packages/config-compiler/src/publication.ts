import type { RecipePublicationSource } from './recipe-publication.js';
import { compile, COMPILER_VERSION } from './compiler.js';
import { CAPABILITY_VERSION } from './profiles.js';
import build from '../schemas/build.json' with { type: 'json' };
import { applyEcs } from './ecs.js';
import { digest, objects } from './json.js';
import { ruleSubscriptionSchema, StructureError } from './recipe-schema.js';
import { validateSubscriptionEndpoints } from './rule-subscriptions.js';
import { validateConfig } from './validate.js';
import type { CompileInput, CompiledConfig, Diagnostic, GenerationParams, Obj, Result } from './types.js';

export interface PublicationBody {
  format: 'd06-publication-1';
  inputHash: string;
  recipeSource?: RecipePublicationSource;
  compiled: CompiledConfig;
  checks: { enabledHash: string; disabledHash: string };
}
/** Load only from trusted publication storage. The digest is integrity, not authentication. */
export interface Publication { id: string; body: PublicationBody }
export type NativeCheck = (config: Obj) => Promise<void>;

export async function preparePublication(input: CompileInput, check: NativeCheck): Promise<Result<Publication>> {
  // Snapshot before the first await, so caller edits cannot race native validation.
  const snapshot = structuredClone(input);
  if (snapshot.template.ecsResponseTags.length && snapshot.params.ecs === null) {
    return { ok: false, diagnostics: [{ severity: 'error', code: 'ECS_PROBE_REQUIRED', path: '/params/ecs', message: '发布校验需要显式的 ECS 样本及掩码；订阅仍可不启用 ECS' }] };
  }
  const enabled = compile(snapshot);
  const disabled = compile({ ...snapshot, params: { ecs: null } });
  if (!enabled.ok || !disabled.ok) return { ok: false, diagnostics: [...enabled.diagnostics, ...disabled.diagnostics] };
  try {
    // Give the checker its own objects; it cannot change the candidate after validation.
    await check(structuredClone(enabled.value.config));
    await check(structuredClone(disabled.value.config));
  } catch {
    return { ok: false, diagnostics: [{ severity: 'error', code: 'NATIVE_CHECK_FAILED', path: '', message: '真实 sing-box check 未通过或执行器不可用；未发布候选' }] };
  }
  const body: PublicationBody = {
    format: 'd06-publication-1', inputHash: await digest(snapshot), compiled: disabled.value,
    checks: { enabledHash: await digest(enabled.value.config), disabledHash: await digest(disabled.value.config) },
  };
  return { ok: true, value: { id: await digest(body), body }, diagnostics: enabled.diagnostics };
}

export async function renderSubscription(publication: Publication, params: GenerationParams): Promise<Result<Obj>> {
  const invalid = (): Result<Obj> => ({ ok: false, diagnostics: [{ severity: 'error', code: 'PUBLICATION_INVALID', path: '', message: '发布快照或校验绑定不完整' }] });
  try {
    const snapshot = structuredClone(publication);
    if (snapshot.body.format !== 'd06-publication-1' || snapshot.id !== await digest(snapshot.body) ||
      snapshot.body.checks.disabledHash !== await digest(snapshot.body.compiled.config)) return invalid();
    const versions = snapshot.body.compiled.versions;
    if (versions.target !== '1.14.4' || versions.compiler !== COMPILER_VERSION ||
      versions.capabilities !== CAPABILITY_VERSION || versions.schema !== build.schemaSha256) return invalid();
    const { config, ecsResponseTags, profile, artifacts, subscriptions } = snapshot.body.compiled;
    const diagnostics: Diagnostic[] = applyEcs(config, ecsResponseTags, params);
    const urls = new Set(objects((config.route as Obj)?.rule_set).map(s => s.url));
    const validatedSubscriptions = (subscriptions ?? []).map((s, i) => ruleSubscriptionSchema.parse(s, `/subscriptions/${i}`));
    const sourceSubscriptions = snapshot.body.recipeSource?.subscriptions?.map((s, i) => ruleSubscriptionSchema.parse(s, `/recipeSource/subscriptions/${i}`));
    if (snapshot.body.recipeSource && JSON.stringify(sourceSubscriptions) !== JSON.stringify(subscriptions === undefined ? undefined : validatedSubscriptions)) return invalid();
    diagnostics.push(...validateSubscriptionEndpoints(validatedSubscriptions, '/subscriptions'));
    const endpoints = validatedSubscriptions.flatMap(s => Object.values(s.projections)
      .flatMap(p => 'formats' in p && urls.has(p.formats.binary.url) ? [p.formats.binary] : []));
    diagnostics.push(...validateConfig(config, profile, [...artifacts, ...endpoints]));
    return diagnostics.some(d => d.severity === 'error') ? { ok: false, diagnostics } : { ok: true, value: config, diagnostics };
  } catch (cause) {
    if (cause instanceof StructureError) return { ok: false, diagnostics: [{ severity: 'error', code: 'SUBSCRIPTION_INVALID', path: cause.path,
      message: '发布快照只接受 Rule Subscription v2 的有效订阅声明' }] };
    return invalid();
  }
}
