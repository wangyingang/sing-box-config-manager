/** Structural input identities; trust comes from pinned GitHub objects and digests. */
export const validRepository = (value: unknown): value is string => typeof value === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)
  && !value.split('/').some(part => part === '.' || part === '..');

export const validInputFile = (value: unknown): value is string => typeof value === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value);

export const validInputPath = (value: unknown): value is string => typeof value === 'string'
  && value.split('/').every(validInputFile);

export const validBranch = (value: unknown): value is string => typeof value === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) && !value.includes('..')
  && !value.endsWith('.') && !value.endsWith('.lock')
  && value.split('/').every(part => part.length > 0 && !part.startsWith('.'));
