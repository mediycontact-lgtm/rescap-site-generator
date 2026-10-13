import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, lstatSync, rmSync } from 'node:fs';
import { resolve, dirname, basename, join, sep } from 'node:path';
import { hash, stable } from './index.mjs';
import { snapshot, verifySite, validateConfig } from './site.mjs';
import { recheckGithubApproval, githubReader, RECEIPT_FORMAT } from './github-approval.mjs';
import { hostingInventory, hostedURL } from './hosting.mjs';
import { publicBase, publicFileURL, publicReader } from './public-reader.mjs';

export const RELEASE_FORMAT = 'rescap.approved-site-release.v1';
export const DEPLOYMENT_FORMAT = 'rescap.deployment-observation.v1';
const need = (ok, message) => { if (!ok) throw Error(message); };
const within = (a, b) => a === b || a.startsWith(b + sep);
const inventory = files => [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) }));
const identity = () => ({ format: 'rescap.site-release-generator.phase3c.v1', files: ['release.mjs', 'public-reader.mjs', 'hosting.mjs'].map(path => ({ path, sha256: hash(readFileSync(new URL(path, import.meta.url))) })) });
const pinned = (path, sha) => {
  need(typeof sha === 'string' && /^[a-f0-9]{64}$/.test(sha), 'externally pinned SHA-256 required');
  need(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 'regular pinned file required');
  const bytes = readFileSync(path); need(hash(bytes) === sha, 'input differs from externally pinned SHA-256'); return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
};
const output = (path, roots, files = []) => {
  const out = join(realpathSync(dirname(resolve(path))), basename(resolve(path)));
  need(!existsSync(out), 'new output required');
  for (const root of roots) { const p = realpathSync(root); need(!within(out, p) && !within(p, out), 'output overlaps private inputs or public build'); }
  for (const file of files) need(!within(realpathSync(file), out), 'output overlaps pinned input');
  return out;
};
const approvalFields = ['request_sha256', 'candidate_sha256', 'repository', 'pr_number', 'head_sha', 'policy_sha256', 'reviewers', 'human_presence_verified', 'publisher_ownership_verified', 'deployable', 'approval_scope', 'status', 'expires_at', 'gate'];
const sameApproval = (a, b) => approvalFields.every(k => stable(a[k]) === stable(b[k]));
async function inputs(candidateDir, requestPath, policyPath, receiptPath, options) {
  const request = pinned(requestPath, options.request_sha256), policy = pinned(policyPath, options.policy_sha256), receipt = pinned(receiptPath, options.receipt_sha256);
  need(request.policy_sha256 === options.policy_sha256 && request.candidate_sha256 === options.candidate_sha256 && receipt.format === RECEIPT_FORMAT && receipt.request_sha256 === options.request_sha256 && receipt.policy_sha256 === options.policy_sha256 && receipt.candidate_sha256 === options.candidate_sha256, 'release approval bindings differ');
  const candidate = await verifySite(candidateDir, { expected_sha256: options.candidate_sha256, config: options.config });
  need(request.head_sha === candidate.record.runtime.revision && request.rescap_candidate_sha256 === candidate.result.candidateHash && request.rescap_evidence_sha256 === candidate.result.evidenceHash, 'release request belongs to another candidate');
  need(receipt.status === 'github_account_approval_verified' && receipt.deployable === false && receipt.human_presence_verified === false && receipt.publisher_ownership_verified === false, 'bounded GitHub account observation required');
  return { candidate, request, policy, receipt };
}
function publicFiles(candidate, receipt, pins) {
  const config = validateConfig(JSON.parse(candidate.configBytes));
  const files = new Map(candidate.siteFiles);
  for (const [path, bytes] of candidate.result.publicFiles) files.set(config.public_path + '/' + path, Buffer.from(bytes));
  const publication = { format: 'rescap.github-approved-publication.v1', hosting_profile_sha256: candidate.record.hosting_profile_sha256, candidate_sha256: candidate.sha, rescap_candidate_sha256: candidate.result.candidateHash, rescap_evidence_sha256: candidate.result.evidenceHash, approval_receipt_sha256: pins.receipt_sha256, request_sha256: pins.request_sha256, policy_sha256: pins.policy_sha256, generated_at: candidate.record.runtime.generated_at, account_approval_observed_at: receipt.verified_at, approval_expires_at: receipt.expires_at, proof_type: 'observed_github_account_action_not_verified_human_or_owner', human_presence_verified: false, publisher_ownership_verified: false, deployment_performed: false };
  files.set(config.public_path + '/publication.json', Buffer.from(stable(publication)));
  return files;
}
const pinsFor = options => Object.fromEntries(['candidate_sha256', 'request_sha256', 'policy_sha256', 'receipt_sha256'].map(k => [k, options[k]]));
function finalInputs(candidateDir, requestPath, policyPath, receiptPath, options, candidate) {
  pinned(requestPath, options.request_sha256); pinned(policyPath, options.policy_sha256); pinned(receiptPath, options.receipt_sha256);
  need(stable(inventory(snapshot(candidateDir))) === stable(inventory(candidate.files)), 'candidate changed during final verification');
}
function recordFor(data, pins, fresh, files) {
  return { format: RELEASE_FORMAT, status: 'assembled_from_observed_account_approval', generator: identity(), pins, canonical_url: data.candidate.result.evidence.job.site.url, public_path: JSON.parse(data.candidate.configBytes).public_path, site_files: data.candidate.record.site_files, hosting: hostingInventory(data.candidate.hostingBytes, files), public_files: inventory(files), public_inventory_sha256: hash(stable(inventory(files))), approval_rechecked_at: fresh.verified_at, approval_observation: fresh, deployment_performed: false, physical_human_verified: false };
}
function writeRelease(out, files, record) {
  mkdirSync(out, { mode: 0o700 });
  try {
    mkdirSync(join(out, 'public'));
    for (const [path, bytes] of files) { const dest = join(out, 'public', path); mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, bytes, { flag: 'wx' }); }
    writeFileSync(join(out, 'release.json'), stable(record), { flag: 'wx', mode: 0o600 });
  } catch (error) { rmSync(out, { recursive: true, force: true }); throw error; }
}

export async function assembleApprovedSite(candidateDir, requestPath, policyPath, receiptPath, out, options, get = githubReader(process.env.RESCAP_GITHUB_TOKEN)) {
  need(options.config, 'current site config required for assembly');
  const config = validateConfig(JSON.parse(readFileSync(options.config))), buildRoot = resolve(dirname(realpathSync(options.config)), config.build_dir);
  out = output(out, [candidateDir, buildRoot], [requestPath, policyPath, receiptPath, options.config]);
  await inputs(candidateDir, requestPath, policyPath, receiptPath, options);
  const fresh = (await recheckGithubApproval(candidateDir, requestPath, policyPath, receiptPath, options, get)).current;
  const data = await inputs(candidateDir, requestPath, policyPath, receiptPath, options), pins = pinsFor(options), files = publicFiles(data.candidate, data.receipt, pins);
  need(Date.parse(fresh.expires_at) > Date.now() && Date.now() - Date.parse(fresh.verified_at) <= 30000 && sameApproval(data.receipt, fresh), 'approval expired or final observation too old');
  // Last check is synchronous: retain the verified frozen bytes, reject current build/config mutation.
  need(stable(inventory(snapshot(buildRoot))) === stable(data.candidate.record.site_files) && hash(readFileSync(options.config)) === data.candidate.record.config_sha256 && hash(readFileSync(resolve(dirname(realpathSync(options.config)), config.mapping))) === data.candidate.record.mapping_sha256, 'current build changed before assembly');
  if (config.hosting) need(hash(readFileSync(resolve(dirname(realpathSync(options.config)), config.hosting))) === data.candidate.record.hosting_profile_sha256, 'current hosting profile changed before assembly');
  finalInputs(candidateDir, requestPath, policyPath, receiptPath, options, data.candidate);
  const record = recordFor(data, pins, fresh, files); writeRelease(out, files, record);
  return { release_sha256: hash(stable(record)), public_inventory_sha256: record.public_inventory_sha256, publication_ready: true, deployment_performed: false };
}

export async function verifyApprovedRelease(releaseDir, candidateDir, requestPath, policyPath, receiptPath, options) {
  const record = pinned(join(releaseDir, 'release.json'), options.release_sha256);
  need(record.format === RELEASE_FORMAT && stable(record.generator) === stable(identity()) && stable(record.pins) === stable(pinsFor(options)), 'release generator or external pins differ');
  const data = await inputs(candidateDir, requestPath, policyPath, receiptPath, options), files = publicFiles(data.candidate, data.receipt, pinsFor(options));
  need(sameApproval(data.receipt, record.approval_observation), 'release approval differs');
  need(stable(record) === stable(recordFor(data, pinsFor(options), record.approval_observation, files)), 'release record differs from reconstructed artifact');
  const all = snapshot(releaseDir), expected = new Map([...files].map(([p, b]) => ['public/' + p, b])); expected.set('release.json', readFileSync(join(releaseDir, 'release.json')));
  need(stable(inventory(all)) === stable(inventory(expected)), 'release files changed or private/extra files present');
  pinned(join(releaseDir, 'release.json'), options.release_sha256);
  finalInputs(candidateDir, requestPath, policyPath, receiptPath, options, data.candidate);
  return { record, files, offline_only: true, deployment_performed: false };
}
export async function checkApprovedRelease(releaseDir, candidateDir, requestPath, policyPath, receiptPath, options, get = githubReader(process.env.RESCAP_GITHUB_TOKEN)) {
  await verifyApprovedRelease(releaseDir, candidateDir, requestPath, policyPath, receiptPath, options);
  const fresh = (await recheckGithubApproval(candidateDir, requestPath, policyPath, receiptPath, options, get)).current;
  const verified = await verifyApprovedRelease(releaseDir, candidateDir, requestPath, policyPath, receiptPath, options);
  need(Date.parse(fresh.expires_at) > Date.now() && Date.now() - Date.parse(fresh.verified_at) <= 30000, 'final approval observation expired or too old');
  return { ok: true, release_sha256: options.release_sha256, public_inventory_sha256: verified.record.public_inventory_sha256, current: fresh, deployment_performed: false };
}
export async function recordDeploymentObservation(releaseDir, candidateDir, requestPath, policyPath, receiptPath, out, options, get = githubReader(process.env.RESCAP_GITHUB_TOKEN), read = publicReader()) {
  need(options.config, 'current site config required for private observation output');
  const base = publicBase(options.base_url);
  const config = options.config ? validateConfig(JSON.parse(readFileSync(options.config))) : null;
  out = output(out, [releaseDir, candidateDir, ...(config ? [resolve(dirname(realpathSync(options.config)), config.build_dir)] : [])], [requestPath, policyPath, receiptPath]);
  const verified = await verifyApprovedRelease(releaseDir, candidateDir, requestPath, policyPath, receiptPath, options);
  need(verified.files.size <= 1000 && verified.record.public_files.reduce((n, f) => n + f.bytes, 0) <= 100 * 1024 * 1024, 'readback inventory exceeds bounded scope');
  const started = new Date().toISOString();
  for (let pass = 0; pass < 2; pass++) for (const file of verified.record.hosting.served) {
    need(Date.now() - Date.parse(started) <= 5 * 60 * 1000, 'deployment readback exceeded total time limit');
    const bytes = await read(hostedURL(base, file.path), file.bytes);
    need(Buffer.isBuffer(bytes) && bytes.length === file.bytes && hash(bytes) === file.sha256, 'remote public file bytes differ');
  }
  need(Date.now() - Date.parse(started) <= 5 * 60 * 1000, 'deployment readback exceeded total time limit');
  const fresh = await checkApprovedRelease(releaseDir, candidateDir, requestPath, policyPath, receiptPath, options, get);
  const record = { format: DEPLOYMENT_FORMAT, status: 'listed_public_bytes_observed_twice', hosting_profile_sha256: verified.record.hosting.profile_sha256, routed_files: verified.record.hosting.served, unserved_configuration: verified.record.hosting.unserved, unserved_configuration_provider_verified: false, base_url: base, canonical_url: verified.record.canonical_url, canonical_destination: base === new URL(verified.record.canonical_url).href, release_sha256: options.release_sha256, public_inventory_sha256: verified.record.public_inventory_sha256, files: verified.record.hosting.served.map(f => ({ path: f.file, bytes: f.bytes, sha256: f.sha256 })), started_at: started, verified_at: new Date().toISOString(), approval_observation: fresh.current, listing_passes: 2, extra_remote_files_checked: false, hosting_ownership_verified: false, deployment_performed_by_generator: false };
  const bytes = stable(record); writeFileSync(out, bytes, { flag: 'wx', mode: 0o600 });
  return { observation_sha256: hash(bytes), base_url: base, canonical_destination: record.canonical_destination, matched_files: record.files.length, deployment_performed: false };
}
