import { resolveSubscriptionProjection, validateRuleSetUsages, validateSubscriptionEndpoints } from './rule-subscriptions.js';
import { PROFILES } from './profiles.js';
import type { RecipeCompileInput, TemplateDocument, RuleSubscription } from './recipe-schema.js';
import type { Diagnostic, Obj, RuleArtifact, RuleSetBinding } from './types.js';

type Usage = 'route' | 'dns-query' | 'dns-response';

/** Adapt trusted Manifest and subscription data. This never downloads or verifies remote bytes. */
export function resolveRecipeArtifacts(input: RecipeCompileInput, template: TemplateDocument, audit = false) {
  const diagnostics: Diagnostic[] = [];
  const error = (code: string, path: string, message: string) => diagnostics.push({ severity: 'error', code, path, message });
  const manifests = input.dependencies.manifests ?? [];
  const identities = new Set<string>();
  const artifactIds = new Set<string>();
  for (const [i, manifest] of manifests.entries()) {
    const path = `/dependencies/manifests/${i}`;
    const identity = JSON.stringify([manifest.id, manifest.revision]);
    if (identities.has(identity)) error('DEPENDENCY_DUPLICATE', path, '固定 Manifest 修订重复');
    identities.add(identity);
    const ids = new Set<string>();
    for (const artifact of manifest.artifacts) {
      if (artifactIds.has(artifact.id)) error('ARTIFACT_DUPLICATE', path, '固定依赖中的物理产物身份重复，不能跨修订复用');
      artifactIds.add(artifact.id);
      ids.add(artifact.id);
      // A version or content digest must be an exact URL path segment, never a mutable query.
      const segments = new URL(artifact.url).pathname.split('/').map(segment => decodeURIComponent(segment));
      if (!segments.includes(manifest.revision) && !segments.includes(artifact.sha256)) {
        error('ARTIFACT_URL_MUTABLE', path, '产物 HTTPS URL 路径必须固定到修订或字节摘要');
      }
    }
    for (const projection of Object.values(manifest.projections)) {
      if ('artifactIds' in projection && projection.artifactIds.some(id => !ids.has(id))) {
        error('ARTIFACT_MANIFEST_INVALID', path, '用途映射引用了 Manifest 中不存在的物理产物');
      }
    }
  }
  const artifacts = new Map<string, RuleArtifact>();
  const usages = new Map<string, Usage[]>();
  const subscriptions = new Map<string, RuleSubscription>();
  const available = input.dependencies.subscriptions ?? [];
  if (new Set(available.map(s => s.systemRuleSetId)).size !== available.length) {
    error('DEPENDENCY_DUPLICATE', '/dependencies/subscriptions', '系统规则订阅身份重复');
  }
  const resolve = (bindings: NonNullable<TemplateDocument['resources']['ruleSets']>, path: string): RuleSetBinding[] => bindings.flatMap<RuleSetBinding>((binding, i) => {
    if (binding.kind === 'inline') return [binding];
    if (binding.kind === 'subscription') {
      const bindingPath = `${path}/${i}/subscriptionRef`;
      const { systemRuleSetId } = binding.subscriptionRef;
      const selectedUsages = 'usage' in binding.subscriptionRef ? [binding.subscriptionRef.usage] : binding.subscriptionRef.usages;
      const matches = available.filter(s => s.systemRuleSetId === systemRuleSetId);
      if (matches.length !== 1) {
        error(matches.length ? 'DEPENDENCY_DUPLICATE' : 'DEPENDENCY_MISSING', bindingPath, '系统规则集必须有唯一的可信订阅；不会回退固定产物');
        return [];
      }
      const subscription = matches[0]!;
      const projection = resolveSubscriptionProjection(subscription, selectedUsages, bindingPath);
      diagnostics.push(...projection.diagnostics);
      for (const capability of projection.requiredCapabilities) {
        if (!audit && !PROFILES[input.recipe.profile][capability]) error('CAPABILITY_UNSUPPORTED', bindingPath, '规则订阅需要此 Profile 不支持的能力');
      }
      subscriptions.set(systemRuleSetId, subscription);
      usages.set(binding.tag, selectedUsages);
      return [{ kind: 'subscription', systemRuleSetId, usages: selectedUsages, tag: binding.tag, ...(binding.httpClient ? { httpClient: binding.httpClient } : {}) }];
    }
    const bindingPath = `${path}/${i}/artifactRef`;
    const { id, revision } = binding.artifactRef;
    const selectedUsages = 'usage' in binding.artifactRef ? [binding.artifactRef.usage] : binding.artifactRef.usages;
    const matches = manifests.flatMap(manifest => manifest.revision === revision
      ? manifest.artifacts.filter(artifact => artifact.id === id).map(artifact => ({ manifest, artifact })) : []);
    if (matches.length !== 1) {
      error(matches.length ? 'DEPENDENCY_DUPLICATE' : 'DEPENDENCY_MISSING', bindingPath, '固定产物必须且只能存在一份；不会回退其他修订');
      return [];
    }
    const { manifest, artifact } = matches[0]!;
    for (const usage of selectedUsages) {
      const projection = manifest.projections[usage];
      if ('unavailable' in projection) error('ARTIFACT_PROJECTION_EMPTY', bindingPath, '所选用途没有内容，不能生成空匹配集合');
      else if (!projection.artifactIds.includes(id)) error('ARTIFACT_USAGE_MISMATCH', bindingPath, '所选物理产物不属于该用途投影');
    }
    for (const capability of artifact.requiredCapabilities) {
      if (!audit && !PROFILES[input.recipe.profile][capability]) error('CAPABILITY_UNSUPPORTED', bindingPath, '固定规则产物需要此 Profile 不支持的能力');
    }
    const resolved: RuleArtifact = { id, revision, sha256: artifact.sha256, url: artifact.url, format: artifact.format, requiredCapabilities: artifact.requiredCapabilities };
    const previous = artifacts.get(id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(resolved)) error('ARTIFACT_DUPLICATE', bindingPath, '绑定版本的物理产物身份发生冲突');
    artifacts.set(id, resolved);
    usages.set(binding.tag, selectedUsages);
    return [{ kind: 'curated', artifactId: id, tag: binding.tag, ...(binding.httpClient ? { httpClient: binding.httpClient } : {}) }];
  });
  const templateRuleSets = resolve(template.resources.ruleSets ?? [], '/dependencies/templates/' + input.dependencies.templates.indexOf(template) + '/resources/ruleSets');
  const recipeRuleSets = resolve(input.recipe.resources.ruleSets ?? [], '/recipe/resources/ruleSets');
  diagnostics.push(...validateSubscriptionEndpoints([...subscriptions.values()], '/dependencies/subscriptions'));
  const rules: { dns: Obj[]; route: Obj[] } = { dns: [], route: [] };
  const origins = new Map<string, { stepId: string; stepIndex: number; outputRuleIndex: number; preset?: string; presetRuleIndex?: number }>();
  for (const section of ['dns', 'route'] as const) {
    input.recipe[`${section}Steps`].forEach((step, stepIndex) => {
      const presets = template[`${section}Presets`] ?? {};
      const expanded: Obj[] = 'rule' in step ? [step.rule] : (Object.hasOwn(presets, step.preset) ? presets[step.preset]! : []);
      expanded.forEach((rule, presetRuleIndex) => {
        const outputRuleIndex = rules[section].length;
        rules[section].push(rule);
        origins.set(`/${section}/rules/${outputRuleIndex}`, { stepId: step.id, stepIndex, outputRuleIndex,
          ...('preset' in step ? { preset: step.preset, presetRuleIndex } : {}) });
      });
    });
  }
  for (const diagnostic of validateRuleSetUsages(rules, usages)) {
    const [, section, index, suffix] = /^\/(dns|route)\/rules\/(\d+)(.*)$/.exec(diagnostic.path)!;
    const source = origins.get(`/${section}/rules/${index}`)!;
    diagnostics.push({ ...diagnostic,
      path: `/recipe/${section}Steps/${source.stepIndex}/${'preset' in source ? 'preset' : `rule${suffix}`}`,
      source: { ...source, outputPath: diagnostic.path },
    });
  }
  return { diagnostics, artifacts: [...artifacts.values()], subscriptions: [...subscriptions.values()], templateRuleSets, recipeRuleSets };
}
