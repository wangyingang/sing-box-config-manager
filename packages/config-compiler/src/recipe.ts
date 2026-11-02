import { compile } from './compiler.js';
import { isJson } from './json.js';
import { recipeInputSchema, StructureError } from './recipe-schema.js';
import type { CompileInput, CompiledConfig, Diagnostic, Obj, Result } from './types.js';

/** Resolve exact immutable dependencies. The caller owns persistence and authorization. */
export function resolveRecipe(input: unknown): Result<CompileInput> {
  const diagnostics: Diagnostic[] = [];
  const error = (code: string, path: string, message: string) => diagnostics.push({ severity: 'error', code, path, message });
  try {
    if (!isJson(input)) throw new StructureError('');
    const { recipe, dependencies, params } = recipeInputSchema.parse(input, '');
    const exact = <T extends { id: string; revision: string }>(items: T[], ref: { id: string; revision: string }, path: string): T | undefined => {
      const matches = items.filter(item => item.id === ref.id && item.revision === ref.revision);
      if (matches.length !== 1) error(matches.length ? 'DEPENDENCY_DUPLICATE' : 'DEPENDENCY_MISSING', path, '固定依赖必须且只能存在一份；不会回退其他修订');
      return matches.length === 1 ? matches[0] : undefined;
    };
    const template = exact(dependencies.templates, recipe.templateRef, '/recipe/templateRef');
    const stepIds = new Set<string>();
    recipe.routeSteps.forEach((step, i) => {
      if (stepIds.has(step.id)) diagnostics.push({ severity: 'error', code: 'STEP_ID_DUPLICATE', path: `/recipe/routeSteps/${i}/id`, message: 'Route 步骤 ID 必须唯一', source: { stepId: step.id, stepIndex: i } });
      stepIds.add(step.id);
    });
    const outbounds = (recipe.resources.outbounds ?? []).flatMap<Obj>((binding, i) => {
      if (!('kind' in binding)) return [binding];
      const node = exact(dependencies.nodes, binding.nodeRef, `/recipe/resources/outbounds/${i}/nodeRef`);
      return node ? [{ ...node.connection, tag: binding.tag }] : [];
    });
    if (!template || diagnostics.length) return { ok: false, diagnostics };
    return { ok: true, diagnostics, value: {
      template: { id: template.id, revision: template.revision, targetVersion: template.targetVersion, defaults: template.defaults, resources: template.resources, platformDnsServers: template.platformDnsServers, dnsPresets: {}, routePresets: template.routePresets ?? {}, ecsResponseTags: [] },
      recipe: { id: recipe.id, revision: recipe.revision, resources: { outbounds, ...(recipe.resources.ruleSets ? { ruleSets: recipe.resources.ruleSets } : {}) }, ...(recipe.settings ? { settings: recipe.settings } : {}), dnsSteps: [], routeSteps: recipe.routeSteps.map(step => 'preset' in step ? { preset: step.preset } : { rule: step.rule }) },
      artifacts: [], profile: recipe.profile, params,
    } };
  } catch (cause) {
    error('STRUCTURE_INVALID', cause instanceof StructureError ? cause.path : '', '输入不符合当前 Recipe 切片契约');
    return { ok: false, diagnostics };
  }
}

/** Compile using the Profile fixed in the Recipe; no caller override is accepted. */
export function compileRecipe(input: unknown): Result<CompiledConfig> {
  const resolved = resolveRecipe(input);
  if (!resolved.ok) return resolved;
  const result = compile(resolved.value);
  const { recipe } = recipeInputSchema.parse(input, '');
  const origins = recipe.routeSteps.flatMap<NonNullable<Diagnostic['source']>>((step, stepIndex) => {
    const source = { stepId: step.id, stepIndex };
    return 'preset' in step
      ? (resolved.value.template.routePresets[step.preset] ?? []).map((_, presetRuleIndex) => ({ ...source, preset: step.preset, presetRuleIndex }))
      : [source];
  });
  result.diagnostics = result.diagnostics.map(diagnostic => {
    const output = /^\/route\/rules\/(\d+)(.*)$/.exec(diagnostic.path);
    if (output) {
      const outputRuleIndex = Number(output[1]);
      const origin = origins[outputRuleIndex];
      if (origin) return { ...diagnostic,
        path: `/recipe/routeSteps/${origin.stepIndex}/${'preset' in origin ? 'preset' : 'rule' + output[2]}`,
        source: { ...origin, outputRuleIndex, outputPath: diagnostic.path },
      };
    }
    const stepPath = /^\/recipe\/routeSteps\/(\d+)/.exec(diagnostic.path);
    const stepIndex = stepPath ? Number(stepPath[1]) : -1;
    const step = recipe.routeSteps[stepIndex];
    return step ? { ...diagnostic, source: { stepId: step.id, stepIndex, ...('preset' in step ? { preset: step.preset } : {}) } } : diagnostic;
  });
  return result;
}
