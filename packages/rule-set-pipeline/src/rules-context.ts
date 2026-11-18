import { access, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { parseBuildConfiguration } from './configuration.js';
import { ghJson } from './publication.js';
import { githubRulesRepository, type RulesRepository } from './rules-repository.js';
import { sha256 } from './release.js';
import { githubBaselineTransport, type BaselineTransport } from './maintenance-baseline-transport.js';
import { gitMaintenanceRefs, type MaintenanceRefTransport } from './maintenance-refs.js';
import { cacheImmutableGitReads } from './immutable-github.js';
import { createOperationNativeBuilder } from './native.js';
import { reportRulesProgress, type RulesProgress } from './rules-progress.js';

const SOURCE_REPOSITORY = 'wangyingang/sing-box-config-manager';
const CONFIGURATION_PATH = 'packages/rule-set-pipeline/config/rulesets.yml';
export interface ConfigurationSnapshot { revision: string; content: string; origin: string }
export interface RulesContext {
  /** A trusted host reads the current pushed definition, not a user-supplied commit. */
  readConfiguration(): Promise<ConfigurationSnapshot>;
  repository: RulesRepository;
  targetBranch: string;
  allowWrites: boolean;
  /** History maintenance has an independent environment gate. */
  allowCleanupWrites?: boolean;
  binary?: string;
  fetch?: typeof fetch;
  token?: string;
  now?: () => Date;
  /** Trusted maintenance transports; never inferred from a custom/test repository. */
  cleanup?: { baseline: BaselineTransport; refs: MaintenanceRefTransport };
}
export interface RulesRequest {
  context?: RulesContext; dryRun?: boolean; draft?: string;
  onProgress?: (event: RulesProgress) => void;
}

export async function readCurrentRulesConfiguration(request: typeof ghJson = ghJson, branch = 'main'): Promise<ConfigurationSnapshot> {
  if (branch !== 'main' && !/^acceptance-[a-zA-Z0-9._-]+$/.test(branch)) throw new Error('Invalid official configuration branch');
  const commit = await request(['api', `repos/${SOURCE_REPOSITORY}/commits/${branch}`]);
  if (!/^[a-f0-9]{40}$/.test(commit?.sha)) throw new Error('Cannot establish current official configuration revision');
  const file = await request(['api', `repos/${SOURCE_REPOSITORY}/contents/${CONFIGURATION_PATH}?ref=${commit.sha}`]);
  if (file?.encoding !== 'base64' || typeof file.content !== 'string') throw new Error('Official configuration is unavailable');
  return { revision: commit.sha, content: Buffer.from(file.content, 'base64').toString('utf8'), origin: `${SOURCE_REPOSITORY}@${branch}` };
}

async function installedBinary() {
  if (process.env.SING_BOX_BINARY) {
    if (!isAbsolute(process.env.SING_BOX_BINARY)) throw new Error('SING_BOX_BINARY must be an absolute path');
    return process.env.SING_BOX_BINARY;
  }
  const candidates: string[] = [];
  const versions = join(homedir(), '.sbvm', 'versions', 'v1.14.4');
  try {
    for (const directory of await readdir(versions)) candidates.push(join(versions, directory, 'sing-box'));
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  candidates.push(...(process.env.PATH ?? '').split(delimiter).filter(Boolean).map(directory => join(directory, 'sing-box')));
  for (const path of candidates) {
    try { await access(path); return path; } catch { /* Try another configured location. */ }
  }
}

/** Environment setup happens once; ordinary requests need no binary/head/cache flags. */
export async function createGitHubRulesContext(): Promise<RulesContext> {
  const targetBranch = process.env.RULE_TARGET ?? 'main';
  if (targetBranch !== 'main' && !/^acceptance-[a-zA-Z0-9._-]+$/.test(targetBranch)) throw new Error('Invalid isolated target');
  const configurationBranch = process.env.RULE_CONFIG_BRANCH ?? 'main';
  if (configurationBranch !== 'main' && (targetBranch === 'main' || configurationBranch !== targetBranch)) {
    throw new Error('Isolated configuration must match its acceptance target; it cannot authorize production');
  }
  const repository = githubRulesRepository(targetBranch);
  // Source reads use this workflow's token; artifact writes keep their separate
  // credential. An expired artifact secret must not hide current configuration.
  const readSource = cacheImmutableGitReads((args, input) => ghJson(args, input, process.env.GITHUB_TOKEN));
  return { targetBranch, repository, readConfiguration: () => readCurrentRulesConfiguration(readSource, configurationBranch),
    cleanup: { baseline: githubBaselineTransport(), refs: gitMaintenanceRefs() },
    allowWrites: targetBranch !== 'main' || process.env.RULE_UPDATE_ENABLED === 'true',
    allowCleanupWrites: targetBranch !== 'main' || process.env.RULE_CLEANUP_ENABLED === 'true',
    binary: await installedBinary(), token: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN };
}

export async function loadRulesRequest(request: RulesRequest, writeKind: 'update' | 'cleanup' = 'update') {
  reportRulesProgress(request.onProgress, 'configuration');
  const context = request.context ?? await createGitHubRulesContext();
  if (request.draft !== undefined && !request.dryRun) throw new Error('Draft configuration is only allowed with --dry-run');
  const observed = request.draft === undefined ? await context.readConfiguration()
    : { content: request.draft, revision: `draft:${sha256(request.draft)}`, origin: 'local-draft' };
  if (!observed.revision || !observed.origin) throw new Error('Configuration must identify its revision and origin');
  const configuration = parseBuildConfiguration(observed.content);
  if (context.targetBranch !== 'main' && !/^acceptance-[a-zA-Z0-9._-]+$/.test(context.targetBranch)) throw new Error('Invalid isolated target');
  if (context.targetBranch === 'main' && configuration.target.branch !== 'main') throw new Error('Draft/test target cannot authorize production writes');
  if (context.repository.branch !== (context.targetBranch === 'main' ? 'candidates' : context.targetBranch)) throw new Error('Rules context repository does not match its target');
  configuration.target.branch = context.targetBranch;
  const allowWrites = writeKind === 'cleanup' ? context.allowCleanupWrites ?? context.allowWrites : context.allowWrites;
  return { context, observed, configuration, dryRun: Boolean(request.dryRun), allowWrites, writeKind,
    nativeBuild: createOperationNativeBuilder(),
    progress: (stage: RulesProgress['stage'], id?: string) => reportRulesProgress(request.onProgress, stage, id) };
}
export type LoadedRules = Awaited<ReturnType<typeof loadRulesRequest>>;

export async function guardRulesConfiguration(loaded: LoadedRules) {
  const allowed = loaded.writeKind === 'cleanup'
    ? loaded.context.allowCleanupWrites ?? loaded.context.allowWrites : loaded.context.allowWrites;
  if (!allowed) throw new Error('RULE_WRITES_DISABLED: configuration has not been applied');
  const current = await loaded.context.readConfiguration();
  if (current.revision !== loaded.observed.revision || current.content !== loaded.observed.content) {
    throw new Error('RULE_INTENT_SUPERSEDED: official configuration changed; run sync again');
  }
}

export function rulesBinary(context: RulesContext) {
  if (!context.binary) throw new Error('Install sing-box 1.14.4 or configure SING_BOX_BINARY once for this environment');
  return context.binary;
}
