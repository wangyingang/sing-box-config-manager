import manifest from '../../rule-set-pipeline/contracts/artifact-manifest.example.json' with { type: 'json' };
import { input } from './recipe-fixtures.js';
import type { ArtifactManifest, RecipeCompileInput } from '../src/index.js';

// Metadata only: synthetic digests and URLs are not verified remote files.
export function artifactInput(): RecipeCompileInput {
  const request: RecipeCompileInput = input();
  request.dependencies.manifests = [structuredClone(manifest) as ArtifactManifest];
  const fixed = request.dependencies.manifests[0]!;
  const id = fixed.artifacts[0]!.id;
  request.recipe.resources.httpClients = [{ tag: 'download', detour: 'direct', domain_resolver: 'local' }];
  request.recipe.resources.ruleSets = [
    { kind: 'curated', tag: 'routing', artifactRef: { id, revision: '1', usage: 'route' }, httpClient: 'download' },
    { kind: 'curated', tag: 'queries', artifactRef: { id, revision: '1', usage: 'dns-query' } },
  ];
  request.recipe.routeSteps = [{ id: 'route', rule: { rule_set: 'routing', outbound: 'direct' } }];
  request.recipe.dnsSteps = [{ id: 'query', rule: { rule_set: 'queries', server: 'local' } }];
  return request;
}

export function responseInput(): RecipeCompileInput {
  const request = artifactInput();
  const manifest = request.dependencies.manifests![0]!;
  const artifact = manifest.artifacts[0]!;
  const id = 'synthetic:ips@1:binary';
  manifest.artifacts.push({ ...artifact, id, format: 'binary', url: 'https://rules.example.invalid/1/ips.srs', sha256: 'b'.repeat(64) });
  manifest.projections['dns-response'] = { artifactIds: [id] };
  request.recipe.resources.ruleSets!.push({ kind: 'curated', tag: 'answers', artifactRef: { id, revision: '1', usage: 'dns-response' } });
  request.recipe.dnsSteps.push(
    { id: 'evaluate', rule: { action: 'evaluate', server: 'local', tag: 'first' } },
    { id: 'response', rule: { type: 'logical', mode: 'and', rules: [{ match_response: 'first', rule_set: 'answers' }, { query_type: 'A' }], action: 'reject' } },
    { id: 'return-response', rule: { match_response: 'first', action: 'respond' } },
  );
  return request;
}
