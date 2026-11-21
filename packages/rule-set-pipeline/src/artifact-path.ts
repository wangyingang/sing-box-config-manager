const reservedArtifactNames = new Set(['activation', 'manifest', 'build', 'readback', 'source', 'conversion-report']);

export function reservedArtifactBasename(basename: string): boolean {
  return reservedArtifactNames.has(basename);
}

export function validArtifactBasename(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,249}$/.test(value);
}

export function validArtifactFilename(file: string): boolean {
  const [basename, extension, ...rest] = file.split('.');
  return rest.length === 0 && (extension === 'srs' || extension === 'json')
    && validArtifactBasename(basename) && !reservedArtifactBasename(basename);
}
