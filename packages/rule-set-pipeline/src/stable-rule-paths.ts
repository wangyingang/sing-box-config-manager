import { reservedArtifactBasename, validArtifactBasename } from './artifact-path.js';
import type { RuleDefinition } from './configuration.js';

const deliveryDirectory = '_delivery';
const projectedRecord = 'activation.json';

export function pathsOverlap(first: string, second: string) {
  return first === second || first.startsWith(second + '/') || second.startsWith(first + '/');
}

export function singleArtifactPaths(publishPath: string, artifact: string) {
  const prefix = `${publishPath}/${artifact}`;
  return [`${prefix}.json`, `${prefix}.srs`] as const;
}

export function ruleDeliveryRecordPath(rule: RuleDefinition) {
  return 'artifact' in rule ? `${rule.stablePath}/${deliveryDirectory}/${rule.artifact}.json`
    : `${rule.stablePath}/${projectedRecord}`;
}

/** Interpret a metadata pathname independently of the JSON it contains. */
export function stableRecordLocation(path: string) {
  if (!path.startsWith('stable/')) return;
  if (path.endsWith('/' + projectedRecord)) return { directory: path.slice(0, -(projectedRecord.length + 1)) };
  const separator = `/${deliveryDirectory}/`;
  const index = path.indexOf(separator);
  if (index < 0 || !path.endsWith('.json')) return;
  const directory = path.slice(0, index);
  const artifact = path.slice(index + separator.length, -'.json'.length);
  if (/^stable(?:\/[a-z0-9][a-z0-9._-]*)+$/.test(directory)
    && validArtifactBasename(artifact) && !reservedArtifactBasename(artifact)) return { directory, artifact };
}
