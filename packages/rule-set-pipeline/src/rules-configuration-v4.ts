import { Ajv, type ErrorObject } from 'ajv';
import { isMap, isScalar, type Document, type LineCounter } from 'yaml';
import schema from '../config/rulesets.schema.json' with { type: 'json' };
import { validFixedUrl, type FixedUrlInput } from './fixed-url-source.js';
import type { CommitInput } from './github-commit.js';
import { singleArtifactPaths, pathsOverlap } from './stable-rule-paths.js';

type BranchFormat = Extract<CommitInput['input']['format'], 'clash-rule-list' | 'cidr-text' | 'domain-suffix-text'>;
type FilterCondition = { tags: { allOf: string[] } | { anyOf: string[] } } | { type: { anyOf: string[] } };
type Source = { fetch: { method: 'url'; url: string; sha256Url?: string }; format: FixedUrlInput['input']['format'] }
  | { fetch: { method: 'github-branch'; repository: string; branch: string }; format?: never };
interface RuleSet {
  data: { source: string; file?: string; format?: BranchFormat; list?: string };
  filter?: { include: FilterCondition } | { exclude: FilterCondition };
  publishPath: string;
  artifact: string;
}
interface RulesConfigurationV4 {
  schemaVersion: 4;
  candidateRetentionDays: number;
  target: { repository: 'wangyingang/sing-box-rule-artifacts'; branch: string };
  sources: Record<string, Source>;
  ruleSets: Record<string, RuleSet>;
}

type Path = string[];
type Report = (path: Path, message: string, key?: boolean) => void;
const validate = new Ajv({ strict: true, strictRequired: false, allErrors: true, ownProperties: true }).compile<RulesConfigurationV4>(schema);

function reportSchemaError(report: Report, { instancePath, keyword, params, message }: ErrorObject) {
  if (keyword === 'if' || keyword === 'propertyNames') return;
  const location = instancePath === '' ? [] : instancePath.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (params.propertyName !== undefined) location.push(params.propertyName);
  if (keyword === 'additionalProperties') report([...location, params.additionalProperty], 'unknown field', true);
  else if (keyword === 'required') report([...location, params.missingProperty], 'required field is missing');
  else if (keyword === 'dependencies') report([...location, params.deps], `required when ${params.property} is present`);
  else if (keyword === 'enum') report(location, `allowed values: ${params.allowedValues.join(', ')}`);
  else if (keyword === 'const') report(location, `expected ${JSON.stringify(params.allowedValue)}`);
  else if (keyword === 'minItems') report(location, 'must contain at least one value');
  else if (keyword === 'false schema') report(location, 'field is not allowed in this configuration');
  else report(location, message ?? 'invalid value', params.propertyName !== undefined);
}

function checkRuleInput(report: Report, id: string, { data, filter }: RuleSet, source: Source) {
  const path = ['ruleSets', id];
  const field = (name: string) => [...path, 'data', name];
  const format = source.fetch.method === 'url' ? source.format : data.format;
  if (source.fetch.method === 'url') {
    if (data.file !== undefined) report(field('file'), 'must be omitted for a URL source');
    if (data.format !== undefined) report(field('format'), 'declare the format on the URL source');
  } else {
    if (data.file === undefined) report(field('file'), 'required for a GitHub branch source');
    if (data.format === undefined) report(field('format'), 'required for a GitHub branch source');
  }
  if (!format) return;
  if (format === 'v2fly-dlc-yaml' && data.list === undefined) report(field('list'), 'required for v2fly-dlc-yaml');
  if (format !== 'v2fly-dlc-yaml' && data.list !== undefined) report(field('list'), `must be omitted for ${format}`);
  if (filter) {
    const condition = 'include' in filter ? filter.include : filter.exclude;
    if (format === 'v2fly-dlc-yaml' ? !('tags' in condition) : format !== 'clash-rule-list' || !('type' in condition)) {
      report([...path, 'filter'], `invalid filter for ${format}`);
    }
  }
}

function checkRulePaths(report: Report, rules: RulesConfigurationV4['ruleSets']) {
  const outputs = new Map<string, string>();
  for (const [id, rule] of Object.entries(rules)) {
    for (const path of singleArtifactPaths(rule.publishPath, rule.artifact)) {
      for (const [otherPath, otherId] of outputs) {
        if (!pathsOverlap(path, otherPath)) continue;
        const field = otherPath === path || otherPath.startsWith(path + '/') ? 'artifact' : 'publishPath';
        report(['ruleSets', id, field], `output path conflict between ${otherId} and ${id}: ${path === otherPath ? path : `${otherPath} and ${path}`}`);
      }
      outputs.set(path, id);
    }
  }
}

/** The editor uses the JSON Schema. Checks that require the entire configuration run here. */
export function validateRulesConfigurationV4(document: Document, lines: LineCounter, raw: unknown): RulesConfigurationV4 {
  const diagnostics = new Set<string>();
  const report: Report = (path, message, key) => {
    const parent = document.getIn(path.slice(0, -1), true);
    const pair = key && isMap(parent) && parent.items.find(item => isScalar(item.key) && item.key.value === path.at(-1));
    let location = (pair ? pair.key : document.getIn(path, true)) as { range?: number[] } | undefined;
    for (let length = path.length - 1; !location?.range && length >= 0; length--) {
      location = document.getIn(path.slice(0, length), true) as typeof location;
    }
    const { line, col } = lines.linePos(location?.range?.[0] ?? 0);
    diagnostics.add(`${line}:${col} ${path.join('.') || 'configuration'}: ${message}`);
  };
  const fail = () => { throw new Error(`Invalid v4 rule configuration:\n${[...diagnostics].join('\n')}`); };
  if (!validate(raw)) {
    for (const error of validate.errors ?? []) reportSchemaError(report, error);
    return fail();
  }

  for (const [id, source] of Object.entries(raw.sources)) {
    if (source.fetch.method !== 'url') continue;
    for (const field of ['url', 'sha256Url'] as const) {
      const url = source.fetch[field];
      if (url !== undefined && !validFixedUrl(url)) report(['sources', id, 'fetch', field], 'invalid fixed HTTPS URL');
    }
    if (source.fetch.sha256Url === source.fetch.url) {
      report(['sources', id, 'fetch', 'sha256Url'], 'must differ from the input URL');
    }
  }
  for (const [id, rule] of Object.entries(raw.ruleSets)) {
    const source = Object.hasOwn(raw.sources, rule.data.source) ? raw.sources[rule.data.source] : undefined;
    if (!source) report(['ruleSets', id, 'data', 'source'], `unknown source ${rule.data.source}`);
    else checkRuleInput(report, id, rule, source);
  }
  checkRulePaths(report, raw.ruleSets);
  if (diagnostics.size) return fail();

  return raw;
}
