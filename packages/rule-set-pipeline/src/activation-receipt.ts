import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Persist a local receipt only after remote application has been confirmed. */
export async function saveActivationReceipt(stateDirectory: string,
  result: { commit: string; activation: { id: string } }, logicalId?: string) {
  const directory = logicalId ? join(stateDirectory, 'active-rule-versions') : stateDirectory;
  const temporary = join(directory, `active-${result.activation.id}.tmp`);
  const destination = join(directory, logicalId ? `${logicalId}.json` : 'active-version.json');
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(temporary, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw new Error(`ACTIVATION_APPLIED_LOCAL_RECEIPT_PENDING: commit ${result.commit} (operation ${result.activation.id})`, { cause: error });
  }
}
