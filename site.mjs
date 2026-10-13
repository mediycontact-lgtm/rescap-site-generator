import { readFileSync, readdirSync, lstatSync, realpathSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { resolve, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, stable, build } from './index.mjs';
import { hostingInventory, validateHostingProfile } from './hosting.mjs';
import { extract, validateMapping } from './html-adapter.mjs';

export const CONFIG_FORMAT = 'rescap.site-config.v1';
export const CANDIDATE_FORMAT = 'rescap.site-candidate.v1';
const need = (ok, message) => { if (!ok) throw Error(message); };
const text = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
const readJson = path => JSON.parse(text(readFileSync(path)));
const shape = (value, keys) => need(value && typeof value === 'object' && !Array.isArray(value) && stable(Object.keys(value).sort()) === stable([...keys].sort()), 'invalid contract keys');
const digest = value => need(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'explicit SHA-256 required');
const relativePath = value => {
  need(typeof value === 'string' && value.length > 0 && !/[\\\x00-\x1f\x7f:]/.test(value) && value.split('/').every(p => p && p !== '.' && p !== '..'), 'safe relative path required');
  return value;
};
const within = (path, root) => path === root || path.startsWith(root + sep);
const target = path => join(realpathSync(dirname(resolve(path))), relativePath(resolve(path).split(sep).at(-1)));
const overlap = (a, b) => need(!within(a, b) && !within(b, a), 'input/output directories overlap');
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const md = value => String(value).replace(/[\\`*_[\]<>|]/g, c => '\\' + c).replace(/[\r\n]/g, ' ');

export function validateConfig(config) {
  shape(config, ['format', 'build_dir', 'mapping', 'public_path', 'public_build', ...(Object.hasOwn(config, 'hosting') ? ['hosting'] : [])]);
  if (Object.hasOwn(config, 'hosting')) relativePath(config.hosting);
  need(config.format === CONFIG_FORMAT, 'unsupported site config');
  for (const key of ['build_dir', 'mapping', 'public_path']) relativePath(config[key]);
  need(config.public_build === true, 'explicit public_build:true required after reviewing the built site scope');
  return config;
}

export function initConfig(path) {
  const config = { format: CONFIG_FORMAT, build_dir: 'dist', mapping: 'rescap.mapping.json', public_path: 'rescap', public_build: false };
  writeFileSync(target(path), stable(config), { flag: 'wx' });
  return config;
}

// Never follow links, even links into the same root. Empty directories have no hosted byte identity.
export function snapshot(root) {
  need(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(), 'regular directory required');
  const files = new Map();
  const visit = (dir, prefix = '') => {
    for (const name of readdirSync(dir).sort()) {
      relativePath(name);
      const path = join(dir, name), rel = prefix + name, stat = lstatSync(path);
      need(!stat.isSymbolicLink(), `symlink denied: ${rel}`);
      if (stat.isDirectory()) visit(path, rel + '/');
      else { need(stat.isFile(), `special file denied: ${rel}`); files.set(rel, readFileSync(path)); }
    }
  };
  visit(root);
  return new Map([...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}
const inventory = files => [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) }));
const sameFiles = (left, right) => stable(inventory(left)) === stable(inventory(right));
const checkReserved = (config, files) => {
  need(files.size > 0, 'build output is empty');
  need(![...files.keys()].some(p => p === config.public_path || p.startsWith(config.public_path + '/')), 'reserved public_path already exists; resolve explicitly in the build');
};
const identity = () => {
  const names = ['package.json', 'site.mjs', 'site-cli.mjs', 'index.mjs', 'html-adapter.mjs', 'github-approval.mjs', 'release.mjs', 'public-reader.mjs', 'hosting.mjs'];
  return { format: 'rescap.site-generator.phase3a.v1', files: names.map(path => ({ path, sha256: hash(readFileSync(new URL(path, import.meta.url))) })) };
};
const getInputs = configPath => {
  need(lstatSync(configPath).isFile() && !lstatSync(configPath).isSymbolicLink(), 'regular config file required');
  const configBytes = readFileSync(configPath), config = validateConfig(JSON.parse(text(configBytes))), root = dirname(realpathSync(configPath));
  const mappingPath = resolve(root, config.mapping), buildPath = resolve(root, config.build_dir);
  for (const path of [mappingPath, buildPath]) need(within(realpathSync(path), root), 'configured path escaped project root');
  need(lstatSync(mappingPath).isFile() && !lstatSync(mappingPath).isSymbolicLink(), 'regular mapping file required');
  need(!lstatSync(buildPath).isSymbolicLink(), 'build root symlink denied');
  const mappingBytes = readFileSync(mappingPath), siteFiles = snapshot(buildPath);
  need(!within(realpathSync(configPath), realpathSync(buildPath)) && !within(realpathSync(mappingPath), realpathSync(buildPath)), 'private config/mapping cannot be inside public build');
  checkReserved(config, siteFiles);
  let hostingBytes = null;
  if (config.hosting) {
    const path = resolve(root, config.hosting);
    need(within(realpathSync(path), root) && !within(realpathSync(path), realpathSync(buildPath)) && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 'private regular hosting profile required within project and outside build');
    hostingBytes = readFileSync(path); validateHostingProfile(JSON.parse(text(hostingBytes)));
  }
  return { configBytes, mappingBytes, hostingBytes, siteFiles, buildPath: realpathSync(buildPath) };
};

const changes = (before, after) => [...new Set([...before.keys(), ...after.keys()])].sort().flatMap(path => {
  const a = before.get(path), b = after.get(path);
  return a && b && hash(a) === hash(b) ? [] : [{ path, kind: !a ? 'added' : !b ? 'removed' : 'changed', before_sha256: a ? hash(a) : null, after_sha256: b ? hash(b) : null }];
});
const semanticChanges = (previous, current) => {
  const pick = c => ({ id: c.id, label: c.label, text: c.text, source_url: c.source_url, pointer: c.pointer });
  const before = new Map((previous?.evidence.claims ?? []).map(c => [c.id, pick(c)])), after = new Map(current.evidence.claims.map(c => [c.id, pick(c)]));
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap(id => {
    const a = before.get(id) ?? null, b = after.get(id) ?? null;
    return stable(a) === stable(b) ? [] : [{ id, kind: !a ? 'added' : !b ? 'removed' : 'changed', before: a, after: b }];
  });
};

async function assemble(inputs, runtime, baseline) {
  shape(runtime, ['revision', 'generated_at', 'producer', 'job_id']);
  for (const value of Object.values(runtime)) need(typeof value === 'string' && value.trim().length > 0, 'explicit non-empty build metadata required');
  const config = validateConfig(JSON.parse(text(inputs.configBytes)));
  checkReserved(config, inputs.siteFiles);
  const mapping = { ...JSON.parse(text(inputs.mappingBytes)), job_id: runtime.job_id, generated_at: runtime.generated_at, producer: runtime.producer };
  validateMapping(mapping);
  const docs = Object.fromEntries(mapping.pages.map(page => {
    relativePath(page.path); const bytes = inputs.siteFiles.get(page.path);
    need(bytes, `mapped HTML missing from build: ${page.path}`);
    return [page.id, text(bytes)];
  }));
  const job = await extract(mapping, docs), result = build(job, baseline?.result.evidence.job ?? null);
  const finalFiles = new Map(inputs.siteFiles);
  for (const [path, bytes] of [...result.publicFiles, ['publication.json', 'pending-publication-placeholder']]) finalFiles.set(config.public_path + '/' + path, Buffer.from(bytes));
  for (const path of finalFiles.keys()) need(!path.split('/').slice(0, -1).some((_, n, parts) => finalFiles.has(parts.slice(0, n + 1).join('/'))), 'deployment file/directory collision');
  need(Boolean(config.hosting) === Boolean(inputs.hostingBytes), 'configured hosting profile snapshot missing or unexpected');
  const hosting = hostingInventory(inputs.hostingBytes, finalFiles);
  const hostingSummary = { ...hosting, served: hosting.served.map(file => file.file === config.public_path + '/publication.json' ? { file: file.file, path: file.path, bytes: null, sha256: null, pending_account_observation: true } : file) };
  const comparison = {
    baseline: baseline ? { kind: 'verified_previous_candidate_not_verified_deployment', candidate_sha256: baseline.sha } : { kind: 'initial_full_review' },
    selected_changes: semanticChanges(baseline?.result, result),
    build_changes: changes(baseline?.siteFiles ?? new Map(), inputs.siteFiles),
    configuration_changed: baseline ? hash(inputs.configBytes) !== hash(baseline.configBytes) : true,
    mapping_changed: baseline ? hash(inputs.mappingBytes) !== hash(baseline.mappingBytes) : true,
    hosting_changed: baseline ? hash(inputs.hostingBytes ?? '') !== hash(baseline.hostingBytes ?? '') : Boolean(inputs.hostingBytes),
    policy_changed: baseline ? stable(job.policy) !== stable(baseline.result.evidence.job.policy) : true,
    source_and_metadata_changes: result.evidence.comparison,
  };
  const status = 'PENDING — internal review only; not an approved deployable site';
  const summary = `# ResCap site review\n\n${status}\n\nSite: ${md(job.site.name)}\n\nDeclared revision: ${md(runtime.revision)}\n\nBaseline: ${md(comparison.baseline.kind)}\n\nSelected value changes: ${comparison.selected_changes.length}; build file changes: ${comparison.build_changes.length}.\n\n| Change | Item | Before | After |\n| --- | --- | --- | --- |\n${comparison.selected_changes.map(c => `| ${c.kind} | ${md((c.after ?? c.before).label)} | ${md(c.before?.text ?? 'absent')} | ${md(c.after?.text ?? 'absent')} |`).join('\n')}\n\nBuild changes:\n${comparison.build_changes.map(c => `- ${c.kind}: ${md(c.path)}`).join('\n')}\n\nHosting profile changed: ${comparison.hosting_changed}; hosting profile SHA: ${hosting.profile_sha256 ?? 'none (direct file routes)'}. Read the exact private hosting-profile.json before approving. Unserved configuration is byte-bound locally but cannot be verified by HTTP.\n\nConfiguration changed: ${comparison.configuration_changed}; mapping changed: ${comparison.mapping_changed}; policy changed: ${comparison.policy_changed}.\n\nRead review.html for complete source/metadata comparison and omissions. No GitHub approval or verified deployment history is claimed. The declared public build scope still requires human inspection.\n`;
  const rows = comparison.selected_changes.map(c => `<tr><td>${esc({ added: '追加', changed: '変更', removed: '削除' }[c.kind])}：${esc((c.after ?? c.before).label)}</td><td>${esc(c.before?.text ?? '掲載なし')}</td><td>${esc(c.after?.text ?? '掲載なし')}</td></tr>`).join('');
  const page = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>サイト公開候補の確認</title><style>body{font:16px/1.7 system-ui;max-width:960px;margin:32px auto;padding:0 20px;color:#172b28;background:#fafbf8}pre,td,li{overflow-wrap:anywhere}pre{white-space:pre-wrap}table{width:100%;table-layout:fixed;border-collapse:collapse}th,td{border:1px solid #ccd6d1;padding:10px;text-align:left;vertical-align:top}a{color:#155c4b}</style></head><body><h1>サイト公開候補の確認</h1><p><strong>未承認・内部確認用</strong>。公開サイトには配置しません。</p><p>比較元：${baseline ? '検証済みの前回候補。実際の公開履歴は未確認です。' : '初回。抽出内容全体を確認してください。'}</p><p>サイト：${esc(job.site.name)} / 申告された対象版：${esc(runtime.revision)}</p><p>画像・CSSを含むビルド全体が確認対象です。選択漏れと公開範囲も確認してください。</p><p><a href="review/review.html">元情報・抽出内容・ポリシー・詳細差分を確認</a> / <a href="comparison.json">差分JSON</a> / <a href="candidate.json">対象版の記録</a></p><h2>公開URLと配信設定</h2><p>プロファイル：${hosting.profile_sha256 ?? '指定なし（ファイルURL）'}。配信設定のファイルはHTTPでの確認対象外と明記します。</p><pre>${esc(stable(hostingSummary))}</pre><h2>抽出内容の差分</h2><p>${comparison.selected_changes.length} 件。設定・出典・日時などの変更は詳細差分も確認してください。</p>${rows ? `<table><thead><tr><th>項目</th><th>前回</th><th>今回</th></tr></thead><tbody>${rows}</tbody></table>` : '<p>選択した内容の変更はありません。</p>'}<h2>ビルド全体の差分</h2><p>${comparison.build_changes.length} ファイル。抽出対象以外の変更も含みます。</p><ul>${comparison.build_changes.map(c => `<li>${esc({ added: '追加', changed: '変更', removed: '削除' }[c.kind])}：${esc(c.path)}</li>`).join('')}</ul><details><summary>機械照合の詳細</summary><pre>${esc(summary)}</pre></details></body></html>\n`;

  const files = new Map([['site-config.json', inputs.configBytes], ['mapping.json', inputs.mappingBytes], ['comparison.json', Buffer.from(stable(comparison))], ['summary.md', Buffer.from(summary)], ['review.html', Buffer.from(page)]]);
  if (inputs.hostingBytes) files.set('hosting-profile.json', inputs.hostingBytes);
  for (const [path, bytes] of inputs.siteFiles) files.set('site/' + path, bytes);
  for (const [path, value] of result.files) files.set('review/' + path, Buffer.from(value));
  if (baseline) for (const [path, bytes] of baseline.files) files.set('baseline/' + path, bytes);
  const ordered = new Map([...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  const record = { format: CANDIDATE_FORMAT, hosting_profile_sha256: hosting.profile_sha256, status: 'pending_human_review', deployable: false, runtime, generator: identity(), baseline: baseline ? { candidate_sha256: baseline.sha } : null, config_sha256: hash(inputs.configBytes), mapping_sha256: hash(inputs.mappingBytes), site_files: inventory(inputs.siteFiles), rescap_candidate_sha256: result.candidateHash, rescap_evidence_sha256: result.evidenceHash, files: inventory(ordered) };
  const recordBytes = Buffer.from(stable(record)); ordered.set('candidate.json', recordBytes);
  return { files: ordered, sha: hash(recordBytes), record, result, comparison, ...inputs };
}

function writeNew(out, files) {
  mkdirSync(out); // Existing files/directories are never overwritten.
  try {
    for (const [path, bytes] of files) { const dest = join(out, relativePath(path)); mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, bytes, { flag: 'wx' }); }
  } catch (error) { rmSync(out, { recursive: true, force: true }); throw error; }
}

export async function prepareSite(configPath, output, options) {
  const inputs = getInputs(configPath), out = target(output);
  need(!existsSync(out), 'new output directory required'); overlap(out, inputs.buildPath);
  let baseline = null;
  if (options.baseline) {
    digest(options.baseline_sha256); overlap(out, realpathSync(options.baseline));
    baseline = await verifySite(options.baseline, { expected_sha256: options.baseline_sha256 });
  } else need(!options.baseline_sha256, 'baseline hash without baseline');
  const runtime = { revision: options.revision, generated_at: options.generated_at ?? new Date().toISOString(), producer: options.producer, job_id: options.job_id ?? 'site-' + hash(String(options.revision)).slice(0, 16) };
  const bundle = await assemble(inputs, runtime, baseline);
  const fresh = getInputs(configPath);
  need(sameFiles(inputs.siteFiles, fresh.siteFiles) && hash(inputs.configBytes) === hash(fresh.configBytes) && hash(inputs.mappingBytes) === hash(fresh.mappingBytes) && hash(inputs.hostingBytes ?? '') === hash(fresh.hostingBytes ?? ''), 'inputs changed while preparing; retry after build completes');
  writeNew(out, bundle.files); return bundle;
}

export async function verifySite(dir, options = {}, depth = 0) {
  need(depth <= 16, 'baseline history too deep; explicit history compaction requires a later contract');
  const files = snapshot(dir), recordBytes = files.get('candidate.json'); need(recordBytes, 'candidate record missing');
  const sha = hash(recordBytes); if (options.expected_sha256 !== undefined) { digest(options.expected_sha256); need(sha === options.expected_sha256, 'candidate differs from externally expected SHA-256'); }
  const record = JSON.parse(text(recordBytes)); need(record.format === CANDIDATE_FORMAT && record.deployable === false && record.status === 'pending_human_review', 'pending site candidate required');
  need(stable(record.generator) === stable(identity()), 'site generator changed; regenerate and obtain new review');
  const content = new Map([...files].filter(([p]) => p !== 'candidate.json'));
  need(stable(inventory(content)) === stable(record.files), 'candidate file inventory/bytes changed');
  let baseline = null;
  if (record.baseline) { digest(record.baseline.candidate_sha256); baseline = await verifySite(join(dir, 'baseline'), { expected_sha256: record.baseline.candidate_sha256 }, depth + 1); }
  const inputs = { configBytes: files.get('site-config.json'), mappingBytes: files.get('mapping.json'), hostingBytes: files.get('hosting-profile.json') ?? null, siteFiles: new Map([...files].filter(([p]) => p.startsWith('site/')).map(([p, v]) => [p.slice(5), v])) };
  need(inputs.configBytes && inputs.mappingBytes, 'config/mapping snapshot missing');
  const rebuilt = await assemble(inputs, record.runtime, baseline);
  need(sameFiles(files, rebuilt.files), 'candidate re-extraction/rebuild differs');
  if (options.config) {
    const live = getInputs(options.config);
    need(hash(live.configBytes) === hash(inputs.configBytes) && hash(live.mappingBytes) === hash(inputs.mappingBytes) && hash(live.hostingBytes ?? '') === hash(inputs.hostingBytes ?? '') && sameFiles(live.siteFiles, inputs.siteFiles), 'current config/mapping/build differs from reviewed candidate');
  }
  return rebuilt;
}
