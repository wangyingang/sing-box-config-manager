import { compile } from './compiler.js';
import { isJson } from './json.js';
import { recipeInputSchema, StructureError } from './recipe-schema.js';
import type { CompileInput, CompiledConfig, Diagnostic, Result } from './types.js';

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
    const outbounds = (recipe.resources.outbounds ?? []).flatMap((binding, i) => {
      const node = exact(dependencies.nodes, binding.nodeRef, `/recipe/resources/outbounds/${i}/nodeRef`);
      return node ? [{ ...node.connection, tag: binding.tag }] : [];
    });
    if (!template || diagnostics.length) return { ok: false, diagnostics };
    return { ok: true, diagnostics, value: {
      template: { id: template.id, revision: template.revision, targetVersion: template.targetVersion, defaults: template.defaults, resources: template.resources, platformDnsServers: template.platformDnsServers, dnsPresets: {}, routePresets: {}, ecsResponseTags: [] },
      recipe: { id: recipe.id, revision: recipe.revision, resources: { outbounds }, ...(recipe.settings ? { settings: recipe.settings } : {}), dnsSteps: [], routeSteps: [] },
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
  return resolved.ok ? compile(resolved.value) : resolved;
}
