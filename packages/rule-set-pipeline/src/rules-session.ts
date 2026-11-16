import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { guardRulesConfiguration, type LoadedRules } from './rules-context.js';
import { encodeRecord, parseRulesJournal, RULE_STATE_PATH, type RulesJournal } from './rules-model.js';
import { PublicationWriteError, type PublicationSnapshot } from './publication-repository.js';
import type { RuleWrites } from './rules-repository.js';

export interface RulesSession {
  loaded: LoadedRules;
  journal: RulesJournal;
  snapshot: PublicationSnapshot;
  shared: boolean;
  save(files?: RuleWrites): Promise<string>;
  guard(): Promise<void>;
  stable(): Promise<PublicationSnapshot>;
}

/** State remains entirely remote; even preview builds do not touch a normal cache. */
export async function openRulesSession(loaded: LoadedRules): Promise<RulesSession> {
  const { repository } = loaded.context;
  let snapshot = await repository.snapshot();
  const bytes = await snapshot.read(RULE_STATE_PATH);
  if (!bytes && snapshot.paths.some(path => path.startsWith('pipeline/') || path.startsWith('candidates/') || path.startsWith('stable/'))) {
    throw new Error('RULE_STATE_MIGRATION_REQUIRED: unmanaged existing content cannot be initialized');
  }
  let persisted = bytes && parseRulesJournal(bytes);
  const initial: RulesJournal = persisted ?? { schemaVersion: 2, id: randomUUID(), generation: 1, maintenance: 'open',
    targetBranch: loaded.context.targetBranch, rules: {}, candidates: {} };
  if (initial.targetBranch !== loaded.context.targetBranch) throw new Error('RULE_TARGET_MISMATCH');
  const session: RulesSession = {
    loaded, journal: structuredClone(initial), snapshot, shared: repository.branch === loaded.context.targetBranch,
    stable: () => session.shared ? Promise.resolve(session.snapshot) : repository.snapshot(loaded.context.targetBranch),
    async guard() {
      if (loaded.dryRun) throw new Error('Dry-run has no write capability');
      await guardRulesConfiguration(loaded);
      const current = await repository.snapshot();
      if (current.head !== snapshot.head) throw new Error('RULE_WRITE_CONFLICT: journal changed');
      if (session.journal.maintenance !== 'open') throw new Error('RULE_MAINTENANCE: writes are isolated');
    },
    async save(files = {}) {
      if (Object.keys(files).length === 0 && persisted && isDeepStrictEqual(session.journal, persisted)) return snapshot.head;
      await session.guard();
      const next = { ...structuredClone(session.journal), writeId: randomUUID() };
      // Validate our own complete record before any remote mutation.
      const state = encodeRecord(next);
      parseRulesJournal(state);
      const writes = { ...files, [RULE_STATE_PATH]: state,
        ...(!persisted ? { 'pipeline/identity.json': encodeRecord({ schemaVersion: 2, id: next.id }) } : {}) };
      try {
        await repository.commit(repository.branch, snapshot.head, writes, '保存规则配置、版本与操作状态', session.guard);
      } catch (error) {
        if (!(error instanceof PublicationWriteError)) throw error;
        const observed = await repository.snapshot().catch(() => undefined);
        const observedState = observed && await observed.read(RULE_STATE_PATH).catch(() => undefined);
        if (!observedState || parseRulesJournal(observedState).writeId !== next.writeId) {
          throw new Error(`RULE_WRITE_PENDING: cannot confirm ${error.attemptedCommit}`, { cause: error });
        }
      }
      snapshot = await repository.snapshot();
      const actual = await snapshot.read(RULE_STATE_PATH);
      if (!actual || !actual.equals(state)) throw new Error('RULE_WRITE_CONFLICT: state changed after commit');
      persisted = parseRulesJournal(actual);
      session.snapshot = snapshot;
      session.journal.writeId = next.writeId;
      return snapshot.head;
    },
  };
  return session;
}
