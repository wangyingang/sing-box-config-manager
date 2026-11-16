import { access, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { parseBuildConfiguration } from './configuration.js';
import { ghJson } from './publication.js';
import { githubRulesRepository, type RulesRepository } from './rules-repository.js';
import { sha256 } from './release.js';

const SOURCE_REPOSITORY = 'wangyingang/sing-box-config-manager';
const CONFIGURATION_PATH = 'packages/rule-set-pipeline/config/rulesets.yml';
export interface ConfigurationSnapshot { revision: string; content: string; origin: string }
export interface RulesContext {
  /** A trusted host reads the current pushed definition, not a user-supplied commit. */
  readConfiguration(): Promise<ConfigurationSnapshot>;
  repository: RulesRepository;
  targetBranch: string;
  allowWrites: boolean;
  binary?: string;
  fetch?: typeof fetch;
  token?: string;
  now?: () => Date;
}
export interface RulesRequest { context?: RulesContext; dryRun?: boolean; draft?: string }

export async function readCurrentRulesConfiguration(request: typeof ghJson = ghJson): Promise<ConfigurationSnapshot> {
  const commit = await request(['api', `repos/${SOURCE_REPOSITORY}/commits/main`]);
  if (!/^[a-f0-9]{40}$/.test(commit?.sha)) throw new Error('Cannot establish current official configuration revision');
  const file = await request(['api', `repos/${SOURCE_REPOSITORY}/contents/${CONFIGURATION_PATH}?ref=${commit.sha}`]);
  if (file?.encoding !== 'base64' || typeof file.content !== 'string') throw new Error('Official configuration is unavailable');
  return { revision: commit.sha, content: Buffer.from(file.content, 'base64').toString('utf8'), origin: `${SOURCE_REPOSITORY}@main` };
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
  const repository = githubRulesRepository(targetBranch);
  return { targetBranch, repository, readConfiguration: () => readCurrentRulesConfiguration(),
    allowWrites: targetBranch !== 'main' || process.env.RULE_UPDATE_ENABLED === 'true',
    binary: await installedBinary(), token: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN };
}

export async function loadRulesRequest(request: RulesRequest) {
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
  return { context, observed, configuration, dryRun: Boolean(request.dryRun) };
}
export type LoadedRules = Awaited<ReturnType<typeof loadRulesRequest>>;

export async function guardRulesConfiguration(loaded: LoadedRules) {
  if (!loaded.context.allowWrites) throw new Error('RULE_WRITES_DISABLED: configuration has not been applied');
  const current = await loaded.context.readConfiguration();
  if (current.revision !== loaded.observed.revision || current.content !== loaded.observed.content) {
    throw new Error('RULE_INTENT_SUPERSEDED: official configuration changed; run sync again');
  }
}

export function rulesBinary(context: RulesContext) {
  if (!context.binary) throw new Error('Install sing-box 1.14.4 or configure SING_BOX_BINARY once for this environment');
  return context.binary;
}
