import { compileRecipe, resolveRecipe } from './recipe.js';
import { recipeInputSchema } from './recipe-schema.js';
import { digest } from './json.js';
import { preparePublication } from './publication.js';
import type { NativeCheck, Publication } from './publication.js';
import type { Result } from './types.js';

/** Immutable identities retained by the host for auditing and revision retention. */
export interface RecipePublicationSource {
  inputHash: string;
  recipe: { id: string; revision: string };
  template: { id: string; revision: string };
  nodes: { id: string; revision: string }[];
  artifacts: { id: string; revision: string; sha256: string }[];
}

/** Strict Recipe entry to the existing D06 publication and native-check path. */
export async function prepareRecipePublication(input: unknown, check: NativeCheck): Promise<Result<Publication>> {
  // All synchronous validation and dependency selection precede the first await.
  const compiled = compileRecipe(input);
  if (!compiled.ok) return compiled;
  const parsed = recipeInputSchema.parse(input, '');
  const resolved = resolveRecipe(parsed);
  if (!resolved.ok) return resolved;
  const { recipe, dependencies, params } = parsed;
  const template = dependencies.templates.find(t => t.id === recipe.templateRef.id && t.revision === recipe.templateRef.revision)!;
  const nodes = dependencies.nodes.filter(n => (recipe.resources.outbounds ?? []).some(b => 'kind' in b && b.nodeRef.id === n.id && b.nodeRef.revision === n.revision));
  const manifests = (dependencies.manifests ?? []).filter(m => m.artifacts.some(a => resolved.value.artifacts.some(r => r.id === a.id && r.revision === m.revision)));
  // Unreferenced latest revisions and template candidates are not publication inputs.
  const source: RecipePublicationSource = {
    inputHash: await digest({ recipe, template, nodes, manifests, params }),
    recipe: { id: recipe.id, revision: recipe.revision }, template: recipe.templateRef,
    nodes: nodes.map(({ id, revision }) => ({ id, revision })),
    artifacts: resolved.value.artifacts.map(({ id, revision, sha256 }) => ({ id, revision, sha256 })),
  };
  const prepared = await preparePublication(resolved.value, check);
  if (!prepared.ok) return prepared;
  const body = { ...prepared.value.body, recipeSource: source };
  return { ok: true, value: { id: await digest(body), body }, diagnostics: prepared.diagnostics };
}
