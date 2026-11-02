import { PROFILES } from './profiles.js';
import type { RecipeCompileInput, TemplateDocument } from './recipe-schema.js';
import type { Diagnostic, Obj, RuleArtifact, RuleSetBinding } from './types.js';

type Usage = 'route' | 'dns-query' | 'dns-response';

/** Adapt trusted, fixed Manifest data. This never downloads or verifies remote bytes. */
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
  const resolve = (bindings: NonNullable<TemplateDocument['resources']['ruleSets']>, path: string): RuleSetBinding[] => bindings.flatMap<RuleSetBinding>((binding, i) => {
    if (binding.kind === 'inline') return [binding];
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
  const responses = new Set<string>();
  let untaggedResponse = false;
  for (const section of ['dns', 'route'] as const) {
    let outputRuleIndex = 0;
    input.recipe[`${section}Steps`].forEach((step, stepIndex) => {
      const presets = template[`${section}Presets`] ?? {};
      const rules: Obj[] = 'rule' in step ? [step.rule] : (Object.hasOwn(presets, step.preset) ? presets[step.preset]! : []);
      rules.forEach((rule, presetRuleIndex) => {
        const outputPath = `/${section}/rules/${outputRuleIndex}`;
        const source = { stepId: step.id, stepIndex, outputRuleIndex, ...('preset' in step ? { preset: step.preset, presetRuleIndex } : {}) };
        const walk = (match: Obj, suffix: string) => {
          const tags = typeof match.rule_set === 'string' ? [match.rule_set] : (match.rule_set as string[] | undefined) ?? [];
          for (const tag of tags) {
            const allowedUsages = usages.get(tag);
            if (!allowedUsages) continue; // Inline and missing references retain existing D06 validation.
            const response = match.match_response;
            const responseContext = response === true ? untaggedResponse : typeof response === 'string' && responses.has(response);
            const compatible = section === 'route' ? allowedUsages.includes('route')
              : response !== undefined && response !== false
                ? allowedUsages.includes('dns-response') && responseContext && match.rule_set_ip_cidr_match_source !== true
                : allowedUsages.includes('dns-query');
            if (!compatible) diagnostics.push({ severity: 'error', code: 'ARTIFACT_USAGE_MISMATCH',
              path: `/recipe/${section}Steps/${stepIndex}/${'preset' in step ? 'preset' : `rule${suffix}/rule_set`}`,
              message: '规则产物用途与消费位置不符；DNS 响应用途要求此前已 evaluate 的响应上下文',
              source: { ...source, outputPath: `${outputPath}${suffix}/rule_set` },
            });
          }
          if (match.type === 'logical') (match.rules as Obj[]).forEach((child, i) => walk(child, `${suffix}/rules/${i}`));
        };
        walk(rule, '');
        if (section === 'dns' && rule.action === 'evaluate') {
          if (typeof rule.tag === 'string') responses.add(rule.tag);
          else untaggedResponse = true;
        }
        outputRuleIndex++;
      });
    });
  }
  return { diagnostics, artifacts: [...artifacts.values()], templateRuleSets, recipeRuleSets };
}
