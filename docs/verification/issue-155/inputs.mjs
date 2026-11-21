import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const reference = JSON.parse(await readFile(new URL('../issue-149/fixed-builds.json', import.meta.url)));
const release = reference.ruleSets.find(row => row.id === 'openai').source;
const gitRows = reference.ruleSets.filter(row => row.source.kind === 'github-commit');
const voice = reference.ruleSets.find(row => row.id === 'chatgpt-voice').source;
const voiceBytes = Buffer.from('{ "prefixes": [{ "ipv4Prefix": "192.0.2.0/24" }, { "ipv6Prefix": "2001:db8:1::/48" }] }\n');
assert.equal(digest(voiceBytes), voice.inputSha256);

const files = [
  { id: 'dlc', sha: release.inputSha256, url: release.yaml.url, asset: release.yaml.id },
  { id: 'checksum', sha: release.checksumSha256, url: release.checksum.url, asset: release.checksum.id },
  ...gitRows.map(({ id, source }) => ({ id, url: source.file.url, sha: source.inputSha256 })),
];

export async function loadInputs(directory, prepare = false) {
  if (prepare) await mkdir(directory, { recursive: true });
  const bytes = new Map();
  for (const file of files) {
    const path = join(directory, file.id);
    let data;
    try {
      data = await readFile(path);
    } catch (error) {
      if (error.code !== 'ENOENT' || !prepare) throw error;
      const options = { encoding: 'buffer', maxBuffer: 20 * 1024 * 1024 };
      try {
        ({ stdout: data } = await exec('curl', ['--fail', '--silent', '--show-error', '--location',
          '--max-time', '120', '--retry', '2', file.url], options));
      } catch (cause) {
        if (!file.asset) throw cause;
        ({ stdout: data } = await exec('gh', ['api', '-H', 'Accept: application/octet-stream',
          'repos/' + release.repository + '/releases/assets/' + file.asset], options));
      }
      assert.equal(digest(data), file.sha, file.id);
      await writeFile(path, data, { flag: 'wx' });
    }
    assert.equal(digest(data), file.sha, file.id);
    bytes.set(file.id, data);
  }
  return bytes;
}

function changeDlc(original) {
  let text = original.toString('utf8');
  for (const id of ['openai', 'anthropic']) {
    const pattern = new RegExp('(  - name: "' + id + '"\\n    length: )(\\d+)(\\n    rules:\\n)', 'g');
    assert.equal([...text.matchAll(pattern)].length, 1, id);
    text = text.replace(pattern, (_, prefix, length, rules) =>
      prefix + (Number(length) + 1) + rules + '      - "domain:benchmark-' + id + '.invalid"\n');
  }
  return Buffer.from(text);
}

// Freeze the public inputs and change only the designated source revisions in each scenario.
export function replay(bytes, scenario) {
  const changedDlc = scenario === 'same-source';
  const changedGit = scenario === 'multi-source';
  const yaml = changedDlc ? changeDlc(bytes.get('dlc')) : bytes.get('dlc');
  const yamlHash = digest(yaml);
  const checksum = changedDlc ? Buffer.from(yamlHash + '  dlc.dat_plain.yml\n') : bytes.get('checksum');
  const tag = changedDlc ? 'local-baseline-155' : release.tag;
  const commit = changedDlc ? yamlHash.slice(0, 40) : release.commit;
  const releaseId = changedDlc ? release.releaseId + 1 : release.releaseId;
  const routes = new Map();
  const api = 'https://api.github.com/repos/' + release.repository;
  const assets = [[release.yaml, yaml], [release.checksum, checksum]].map(([original, body], index) => {
    const id = changedDlc ? 900000001 + index : original.id;
    routes.set(api + '/releases/assets/' + id, () => new Response(body));
    return { id, name: original.name, browser_download_url: 'https://github.com/' + release.repository +
      '/releases/download/' + tag + '/' + original.name, state: 'uploaded', digest: 'sha256:' + digest(body) };
  });
  routes.set(api + '/releases/latest', () => Response.json({ id: releaseId, tag_name: tag, assets }));
  routes.set(api + '/git/ref/tags/' + tag, () => Response.json({ object: { type: 'commit', sha: commit } }));
  const identities = { dlc: { commit, inputSha256: yamlHash }, 'openai-voice': { inputSha256: voice.inputSha256 } };
  for (const { id, definition, source } of gitRows) {
    let body = bytes.get(id);
    const added = { gfw: '\nbenchmark-gfw.invalid\n', onedrive: '\nDOMAIN-SUFFIX,benchmark-onedrive.invalid\n' }[id];
    const changed = changedGit && added;
    if (changed) body = Buffer.concat([body, Buffer.from(added)]);
    const hash = digest(body);
    const revision = changed ? hash.slice(0, 40) : source.commit;
    const gitApi = 'https://api.github.com/repos/' + source.repository;
    routes.set(gitApi + '/branches/' + encodeURIComponent(source.branch),
      () => Response.json({ name: source.branch, commit: { sha: revision } }));
    routes.set('https://raw.githubusercontent.com/' + source.repository + '/' + revision + '/' + source.file.path,
      () => new Response(body));
    // Without optional tree metadata the real adapter checks the pinned body.
    routes.set(gitApi + '/git/commits/' + revision, () => new Response(null, { status: 404 }));
    identities[definition.source] = { commit: revision, inputSha256: hash };
  }
  routes.set(voice.url, init => new Headers(init?.headers).get('if-none-match') === voice.etag
    ? new Response(null, { status: 304, headers: { etag: voice.etag } })
    : new Response(voiceBytes, { headers: { etag: voice.etag } }));
  return { identities, async fetch(address, init) {
    const response = routes.get(String(address));
    assert.ok(response, 'Unrecognized local replay URL ' + address);
    return response(init);
  } };
}
