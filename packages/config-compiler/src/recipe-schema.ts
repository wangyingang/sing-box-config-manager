import { PROFILES } from './profiles.js';
import type { ProfileId } from './types.js';

// Small closed structural schemas: no coercion, defaults, IO or mutation.
type Schema<T> = { parse(value: unknown, path: string): T };
type Value<S> = S extends Schema<infer T> ? T : never;
type Shape = Record<string, Schema<unknown>>;
type OptionalKeys<S extends Shape> = { [K in keyof S]: undefined extends Value<S[K]> ? K : never }[keyof S];
type Fields<S extends Shape> = { [K in Exclude<keyof S, OptionalKeys<S>>]: Value<S[K]> } & { [K in OptionalKeys<S>]?: Value<S[K]> };
export class StructureError extends Error { constructor(readonly path: string) { super('字段不符合当前切片的数据契约'); } }
function schema<T>(check: (value: unknown) => value is T): Schema<T> {
  return { parse(value, path) { if (!check(value)) throw new StructureError(path); return value; } };
}
const string = schema((v): v is string => typeof v === 'string' && v.length > 0);
const bool = schema((v): v is boolean => typeof v === 'boolean');
const integer = (min: number, max: number) => schema((v): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max);
const literal = <T extends string | number>(value: T) => schema((v): v is T => v === value);
const enumeration = <T extends string>(values: readonly T[]) => schema((v): v is T => typeof v === 'string' && values.includes(v as T));
const optional = <T>(inner: Schema<T>): Schema<T | undefined> => ({ parse: (v, p) => v === undefined ? undefined : inner.parse(v, p) });
const array = <T>(inner: Schema<T>): Schema<T[]> => ({ parse(v, p) {
  if (!Array.isArray(v)) throw new StructureError(p);
  return v.map((item, i) => inner.parse(item, `${p}/${i}`));
} });
function object<S extends Shape>(shape: S): Schema<Fields<S>> {
  return { parse(value, path) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StructureError(path);
    const input = value as Record<string, unknown>;
    for (const key of Object.keys(input)) if (!Object.hasOwn(shape, key)) throw new StructureError(`${path}/${key}`);
    const result: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(shape)) {
      const parsed = field.parse(input[key], `${path}/${key}`);
      if (parsed !== undefined) result[key] = parsed;
    }
    return result as Fields<S>;
  } };
}
function union<T extends readonly Schema<unknown>[]>(...variants: T): Schema<Value<T[number]>> {
  return { parse(value, path) {
    let failure: unknown;
    for (const variant of variants) { try { return variant.parse(value, path) as Value<T[number]>; } catch (error) { failure = error; } }
    throw failure;
  } };
}
const profile = enumeration(Object.keys(PROFILES) as ProfileId[]);
const ref = object({ id: string, revision: string });
const identity = { schemaVersion: literal(1), id: string, revision: string };
const tls = object({ enabled: optional(bool), server_name: optional(string), certificate: optional(array(string)),
  utls: optional(object({ enabled: optional(bool), fingerprint: optional(string) })),
  reality: optional(object({ enabled: optional(bool), public_key: optional(string), short_id: optional(string) })),
});
const transport = object({ type: literal('ws'), path: optional(string), headers: optional(object({ Host: optional(string) })) });
const endpoint = { server: string, server_port: integer(1, 65535) };
const connection = union(
  object({ type: literal('vless'), ...endpoint, uuid: string, flow: optional(literal('xtls-rprx-vision')), tls: optional(tls), transport: optional(transport) }),
  object({ type: literal('hysteria2'), ...endpoint, password: string, tls: optional(tls) }),
  object({ type: literal('shadowsocks'), ...endpoint, method: enumeration(['aes-128-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305', '2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm', '2022-blake3-chacha20-poly1305'] as const), password: string }),
);
export const nodeRevisionSchema = object({ ...identity, connection });
export const recipeSchema = object({ ...identity, profile, templateRef: ref,
  resources: object({ outbounds: optional(array(object({ kind: literal('node'), tag: string, nodeRef: ref }))) }),
  settings: optional(object({ logLevel: optional(enumeration(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'panic'] as const)), tunMtu: optional(integer(576, 65535)), dnsFinal: optional(string), routeFinal: optional(string) })),
  // Policy contracts are delivered by later slices; empty arrays are explicit.
  dnsSteps: array(schema((v): v is never => false)), routeSteps: array(schema((v): v is never => false)),
});
const resolver = union(
  object({ type: literal('local'), tag: string, prefer_go: optional(bool) }),
  object({ type: literal('udp'), tag: string, ...endpoint }),
  object({ type: literal('https'), tag: string, ...endpoint, path: optional(string), tls: optional(tls) }),
);
export const templateSchema = object({ ...identity, targetVersion: literal('1.14.4'),
  defaults: object({ log: optional(object({ disabled: optional(bool), level: optional(enumeration(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'panic'] as const)) })),
    dns: optional(object({ final: optional(string), strategy: optional(enumeration(['prefer_ipv4', 'prefer_ipv6', 'ipv4_only', 'ipv6_only'] as const)) })),
    route: optional(object({ final: optional(string), auto_detect_interface: optional(bool), default_domain_resolver: optional(string) })),
  }),
  resources: object({
    outbounds: optional(array(object({ type: literal('direct'), tag: string }))),
    dnsServers: optional(array(resolver)),
    inbounds: optional(array(object({ type: literal('mixed'), tag: string, listen: string, listen_port: integer(1, 65535) }))),
  }),
  platformDnsServers: object({ 'windows-standalone': optional(array(resolver)), 'macos-standalone': optional(array(resolver)), 'macos-appstore': optional(array(resolver)), 'ios-appstore': optional(array(resolver)), 'android-google-play': optional(array(resolver)) }),
});
export type RecipeDocument = Value<typeof recipeSchema>;
export type TemplateDocument = Value<typeof templateSchema>;
export type NodeRevision = Value<typeof nodeRevisionSchema>;
const params = object({ ecs: union(schema((v): v is null => v === null), object({ address: string, prefix: integer(0, 32) })) });
export const recipeInputSchema = object({ recipe: recipeSchema,
  dependencies: object({ templates: array(templateSchema), nodes: array(nodeRevisionSchema) }),
  params,
});
export type RecipeCompileInput = Value<typeof recipeInputSchema>;

// Lifecycle state is supplied by a trusted host, separately from immutable dependencies.
export const recipeEditSchema = object({
  previous: union(schema((v): v is null => v === null), recipeSchema),
  candidate: recipeSchema,
  dependencies: object({ templates: array(templateSchema), nodes: array(nodeRevisionSchema) }),
  params,
  nodes: array(object({ id: string, archived: bool })),
});
export const nodeRevisionDeletionSchema = object({
  nodeRef: ref,
  references: object({ recipeRevisions: bool, publications: bool }),
});
export type RecipeEditInput = Value<typeof recipeEditSchema>;
export type NodeRevisionDeletionInput = Value<typeof nodeRevisionDeletionSchema>;
