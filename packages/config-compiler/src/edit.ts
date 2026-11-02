import { canonical, isJson } from './json.js';
import { compileRecipe } from './recipe.js';
import { nodeRevisionDeletionSchema, recipeEditSchema, recipeSchema, StructureError } from './recipe-schema.js';
import type { RecipeDocument } from './recipe-schema.js';
import type { Diagnostic, Result } from './types.js';

export type EditDecision<T> =
  | { allowed: true; value: T; reasons: Diagnostic[]; diagnostics: Diagnostic[] }
  | { allowed: false; reasons: Diagnostic[]; diagnostics: Diagnostic[] };

function reason(code: string, path: string, message: string): Diagnostic {
  return { severity: 'error', code, path, message };
}
function structureFailure(cause: unknown): Diagnostic {
  return reason('STRUCTURE_INVALID', cause instanceof StructureError ? cause.path : '', '输入不符合当前编辑契约');
}

/** Structure only: success does not imply compilability or permission to save. */
export function validateRecipeDraft(input: unknown): Result<RecipeDocument> {
  try {
    if (!isJson(input)) throw new StructureError('');
    return { ok: true, value: recipeSchema.parse(input, ''), diagnostics: [] };
  } catch (cause) {
    return { ok: false, diagnostics: [structureFailure(cause)] };
  }
}

/** The host must load previous by candidate ID (null only for a new ID), and supply
 * authoritative node states. This decision performs no authentication or persistence.
 * Semantic diagnostics do not block drafts; independent edit constraints do.
 */
export function decideRecipeEdit(input: unknown): EditDecision<RecipeDocument> {
  try {
    if (!isJson(input)) throw new StructureError('');
    const { previous, candidate, dependencies, params, nodes } = recipeEditSchema.parse(input, '');
    const reasons: Diagnostic[] = [];
    const sameRecipe = previous?.id === candidate.id;
    if (sameRecipe && previous.profile !== candidate.profile) {
      reasons.push(reason('RECIPE_PROFILE_FIXED', '/candidate/profile', '既有 Recipe 不能改换 Client Profile；请创建另一身份的 Recipe'));
    }
    if (sameRecipe && previous.revision === candidate.revision && canonical(previous) !== canonical(candidate)) {
      reasons.push(reason('RECIPE_REVISION_IMMUTABLE', '/candidate/revision', '修改 Recipe 必须创建新修订'));
    }
    // Consume retained bindings once: duplicating one binding is still an addition.
    const retained = sameRecipe ? (previous.resources.outbounds ?? []).filter(binding => 'kind' in binding) : [];
    for (const [i, binding] of (candidate.resources.outbounds ?? []).entries()) {
      if (!('kind' in binding)) continue;
      const path = `/candidate/resources/outbounds/${i}/nodeRef`;
      const states = nodes.filter(state => state.id === binding.nodeRef.id);
      if (states.length !== 1) {
        reasons.push(reason('NODE_STATE_INVALID', path, '宿主必须为绑定节点提供唯一的归档状态'));
        continue;
      }
      const index = retained.findIndex(old => old.tag === binding.tag && old.nodeRef.id === binding.nodeRef.id && old.nodeRef.revision === binding.nodeRef.revision);
      if (index >= 0) retained.splice(index, 1);
      else if (states[0]!.archived) reasons.push(reason('NODE_ARCHIVED', path, '归档节点禁止新增固定绑定'));
    }
    const diagnostics = compileRecipe({ recipe: candidate, dependencies, params }).diagnostics;
    return reasons.length ? { allowed: false, reasons, diagnostics } : { allowed: true, value: candidate, reasons, diagnostics };
  } catch (cause) {
    return { allowed: false, reasons: [structureFailure(cause)], diagnostics: [] };
  }
}

/** Reference flags must describe this exact revision, from trusted host queries.
 * This function neither scans references nor deletes data; the host owns atomicity.
 */
export function decideNodeRevisionDeletion(input: unknown): EditDecision<{ id: string; revision: string }> {
  try {
    if (!isJson(input)) throw new StructureError('');
    const { nodeRef, references } = nodeRevisionDeletionSchema.parse(input, '');
    const reasons: Diagnostic[] = [];
    if (references.recipeRevisions) reasons.push(reason('NODE_REVISION_RECIPE_REFERENCED', '/references/recipeRevisions', 'Recipe 修订引用的节点修订不能删除'));
    if (references.publications) reasons.push(reason('NODE_REVISION_PUBLICATION_REFERENCED', '/references/publications', '发布记录引用的节点修订不能删除'));
    return reasons.length ? { allowed: false, reasons, diagnostics: [] } : { allowed: true, value: nodeRef, reasons, diagnostics: [] };
  } catch (cause) {
    return { allowed: false, reasons: [structureFailure(cause)], diagnostics: [] };
  }
}
