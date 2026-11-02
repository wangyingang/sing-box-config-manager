import type { RecipeDocument, TemplateDocument, NodeRevision } from '../src/index.js';
export const template: TemplateDocument = {
  schemaVersion: 1, id: 'base', revision: '1', targetVersion: '1.14.4',
  defaults: { dns: { final: 'local' }, route: { final: 'direct', default_domain_resolver: 'local' } },
  resources: { outbounds: [{ type: 'direct', tag: 'direct' }] },
  platformDnsServers: { 'macos-standalone': [{ type: 'local', tag: 'local' }] },
};
export const node: NodeRevision = { schemaVersion: 1, id: 'shared', revision: '1', connection: {
  type: 'vless', server: '192.0.2.1', server_port: 443, uuid: '00000000-0000-4000-8000-000000000001',
  tls: { enabled: true, server_name: 'example.invalid' },
} };
export function recipe(id = 'alice', tag = 'alice-proxy'): RecipeDocument {
  return { schemaVersion: 1, id, revision: '1', profile: 'macos-standalone', templateRef: { id: 'base', revision: '1' },
    resources: { outbounds: [{ kind: 'node', tag, nodeRef: { id: 'shared', revision: '1' } }] }, dnsSteps: [], routeSteps: [] };
}
export function input(document = recipe()) { return structuredClone({ recipe: document, dependencies: { templates: [template], nodes: [node] }, params: { ecs: null } }); }
