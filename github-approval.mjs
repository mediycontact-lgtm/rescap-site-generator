import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { join, dirname, resolve, sep, basename } from 'node:path';
import { hash, stable } from './index.mjs';
import { verifySite, validateConfig } from './site.mjs';

export const POLICY_FORMAT = 'rescap.github-approval-policy.v1';
export const REQUEST_FORMAT = 'rescap.github-approval-request.v1';
export const RECEIPT_FORMAT = 'rescap.github-approval-receipt.v1';
export const API_VERSION = '2026-03-10';
const need = (ok, message) => { if (!ok) throw Error(message); };
const shape = (v, keys) => need(v && typeof v === 'object' && !Array.isArray(v) && stable(Object.keys(v).sort()) === stable([...keys].sort()), 'invalid approval contract keys');
const digest = v => need(typeof v === 'string' && /^[a-f0-9]{64}$/.test(v), 'externally pinned SHA-256 required');
const commit = v => need(typeof v === 'string' && /^[a-f0-9]{40}$/.test(v), 'exact Git commit SHA required');
const positive = v => need(Number.isSafeInteger(v) && v > 0, 'positive GitHub identifier required');
const login = v => need(typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(v), 'GitHub User login required');
const time = v => {
  need(typeof v === 'string', 'valid approval timestamp required');
  const m = v.match(/^(\d{4}-\d\d-\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{3})?(?:Z|[+-]\d\d:\d\d)$/);
  need(m && Number.isFinite(Date.parse(v)) && new Date(m[1] + 'T00:00:00Z').toISOString().slice(0, 10) === m[1] && Number(m[2]) < 24 && Number(m[3]) < 60 && Number(m[4]) < 60, 'valid approval timestamp required'); return Date.parse(v);
};
const read = path => readFileSync(path);
const pinned = (path, expected) => { digest(expected); const bytes = read(path); need(hash(bytes) === expected, 'input differs from externally pinned SHA-256'); return { bytes, value: JSON.parse(bytes.toString('utf8')) }; };
const checks = ['source_accuracy', 'publication_scope', 'policy', 'changes'];
const privateOutput = (out, candidateDir) => { const path = join(realpathSync(dirname(resolve(out))), basename(out)), root = realpathSync(candidateDir); need(path !== root && !path.startsWith(root + sep), 'approval output must stay outside candidate'); return path; };
const identity = () => ({ version: 'rescap.github-approval.phase3b.v1', source_sha256: hash(readFileSync(new URL('./github-approval.mjs', import.meta.url))) });

export function validateApprovalPolicy(policy) {
  shape(policy, ['format', 'repository', 'base_ref', 'method', 'approvers', 'required_approvals', 'allow_pr_author', 'maximum_age_seconds']);
  need(policy.format === POLICY_FORMAT, 'unsupported approval policy');
  shape(policy.repository, ['full_name', 'id']); positive(policy.repository.id);
  need(typeof policy.repository.full_name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9_.-]{1,100}$/.test(policy.repository.full_name), 'exact GitHub repository required');
  need(typeof policy.base_ref === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/.test(policy.base_ref) && !policy.base_ref.includes('..'), 'explicit base branch required');
  need(['review', 'comment'].includes(policy.method), 'explicit review/comment method required');
  need(typeof policy.allow_pr_author === 'boolean' && (policy.method !== 'review' || !policy.allow_pr_author), 'PR author approval is an explicit comment-mode choice only');
  need(Array.isArray(policy.approvers) && policy.approvers.length > 0 && policy.approvers.length <= 10, 'one to ten explicit approver accounts required');
  const ids = new Set(), names = new Set();
  for (const account of policy.approvers) { shape(account, ['id', 'login']); positive(account.id); login(account.login); need(!ids.has(account.id) && !names.has(account.login.toLowerCase()), 'duplicate approver'); ids.add(account.id); names.add(account.login.toLowerCase()); }
  positive(policy.required_approvals); need(policy.required_approvals <= policy.approvers.length, 'approval quorum exceeds configured accounts');
  need(Number.isInteger(policy.maximum_age_seconds) && policy.maximum_age_seconds > 0 && policy.maximum_age_seconds <= 604800, 'explicit approval age within seven days required');
  return policy;
}

function validateRequest(request, policy, policySha) {
  shape(request, ['format', 'repository', 'base_ref', 'pr_number', 'head_sha', 'candidate_sha256', 'rescap_candidate_sha256', 'rescap_evidence_sha256', 'candidate_generated_at', 'policy_sha256']);
  need(request.format === REQUEST_FORMAT && stable(request.repository) === stable(policy.repository) && request.base_ref === policy.base_ref, 'request repository/base does not match trusted policy');
  positive(request.pr_number); commit(request.head_sha);
  for (const key of ['candidate_sha256', 'rescap_candidate_sha256', 'rescap_evidence_sha256', 'policy_sha256']) digest(request[key]);
  need(request.policy_sha256 === policySha, 'request belongs to another trusted policy'); time(request.candidate_generated_at);
}

export function declarationTemplate(request, requestSha) {
  return '```rescap-approval\n' + stable({ format: 'rescap.github-approval-declaration.v1', request_sha256: requestSha, candidate_sha256: request.candidate_sha256, head_sha: request.head_sha, decision: 'pending', checks: Object.fromEntries(checks.map(k => [k, false])) }).trimEnd() + '\n```\n';
}

export function parseDeclaration(body) {
  if (typeof body !== 'string' || !body.includes('```rescap-approval')) return null;
  const blocks = [...body.matchAll(/```rescap-approval\r?\n([\s\S]*?)\r?\n```/g)];
  need(blocks.length === 1 && (body.match(/```rescap-approval/g) ?? []).length === 1, 'exactly one explicit approval declaration required');
  let d; try { d = JSON.parse(blocks[0][1]); } catch { throw Error('malformed explicit approval declaration'); }
  shape(d, ['format', 'request_sha256', 'candidate_sha256', 'head_sha', 'decision', 'checks']);
  need(d.format === 'rescap.github-approval-declaration.v1' && ['pending', 'approved', 'revoked'].includes(d.decision), 'unsupported declaration decision');
  digest(d.request_sha256); digest(d.candidate_sha256); commit(d.head_sha); shape(d.checks, checks);
  need(Object.values(d.checks).every(v => typeof v === 'boolean'), 'explicit boolean checks required'); return d;
}

// This pure evaluator takes testable snapshots, not authenticated files. The CLI only uses fresh API reads.
export function evaluateGithubApproval(request, requestSha, policy, policySha, state, now) {
  validateApprovalPolicy(policy); validateRequest(request, policy, policySha); digest(requestSha);
  need(hash(stable(request)) === requestSha, 'request hash does not bind the canonical request');
  const clock = time(now), pr = state.pull;
  need(pr.number === request.pr_number && pr.state === 'open' && pr.draft === false, 'current open non-draft PR required');
  positive(pr.author_id);
  need(pr.head_sha === request.head_sha && pr.base_ref === request.base_ref, 'PR head/base changed');
  need(pr.base_repository_id === policy.repository.id && pr.head_repository_id === policy.repository.id && pr.base_full_name.toLowerCase() === policy.repository.full_name.toLowerCase(), 'same configured repository required; forks unsupported');
  const approved = [];
  for (const actor of policy.approvers) {
    const permission = state.permissions.find(p => p.id === actor.id && p.login.toLowerCase() === actor.login.toLowerCase());
    const events = state.events.filter(e => e.state !== 'PENDING' && e.user?.id === actor.id && e.user.login?.toLowerCase() === actor.login.toLowerCase() && e.user.type === 'User');
    let latest = null;
    const effectiveTime = e => policy.method === 'comment' ? e.updated_at : e.submitted_at;
    for (const event of [...events].sort((a, b) => time(effectiveTime(a)) - time(effectiveTime(b)) || a.id - b.id)) {
      const declaration = parseDeclaration(event.body);
      const forRequest = declaration?.request_sha256 === requestSha;
      if ((policy.method === 'review' && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(event.state)) || forRequest) latest = { event, declaration, forRequest };
    }
    if (!latest) continue;
    const { event, declaration, forRequest } = latest;
    if (event.state === 'CHANGES_REQUESTED' || forRequest && declaration.decision === 'revoked') throw Error('configured approver requested changes or revoked approval');
    if (!forRequest || declaration.decision !== 'approved' || !Object.values(declaration.checks).every(v => v === true)) continue;
    if (policy.method === 'review' && event.state !== 'APPROVED') continue;
    need(policy.method !== 'review' || event.commit_id === request.head_sha, 'review belongs to another commit');
    need(policy.allow_pr_author || event.user.id !== pr.author_id, 'PR author is not authorized by policy');
    need(permission && permission.type === 'User' && ['write', 'admin'].includes(permission.permission), 'approver lacks current write/admin permission or exact User identity');
    positive(event.id);
    const approvedAt = policy.method === 'comment' ? event.updated_at : event.submitted_at;
    const when = time(approvedAt);
    need(when >= time(event.submitted_at) && when >= time(request.candidate_generated_at) && when <= clock && clock - when <= policy.maximum_age_seconds * 1000, 'approval is stale, future or predates candidate');
    need(declaration.candidate_sha256 === request.candidate_sha256 && declaration.head_sha === request.head_sha, 'declaration belongs to another candidate/head');
    const expectedUrl = policy.method === 'review' ? `https://github.com/${policy.repository.full_name}/pull/${request.pr_number}#pullrequestreview-${event.id}` : `https://github.com/${policy.repository.full_name}/pull/${request.pr_number}#issuecomment-${event.id}`;
    need(event.url === expectedUrl, 'approval action URL does not match configured PR');
    approved.push({ id: actor.id, login: actor.login, permission: permission.permission, method: policy.method, action_id: event.id, action_url: event.url, approved_at: approvedAt, submitted_at: event.submitted_at, body_sha256: hash(event.body) });
  }
  need(approved.length >= policy.required_approvals, 'not enough current explicit approvals');
  return { reviewers: approved.sort((a, b) => a.id - b.id), expires_at: new Date(Math.min(...approved.map(a => time(a.approved_at) + policy.maximum_age_seconds * 1000))).toISOString() };
}

export function githubReader(token, fetchImpl = globalThis.fetch) {
  need(typeof token === 'string' && token.trim().length > 0 && !/[\r\n]/.test(token), 'RESCAP_GITHUB_TOKEN read token required');
  return async path => {
    need(typeof path === 'string' && /^\/repos\/[a-zA-Z0-9_.\/-]+(?:\?per_page=100&page=\d+)?$/.test(path) && !path.includes('..'), 'fixed repository GET path required');
    let response;
    try { response = await fetchImpl('https://api.github.com' + path, { method: 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000), headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token, 'X-GitHub-Api-Version': API_VERSION } }); }
    catch { throw Error('GitHub read failed; no approval recorded'); }
    need(response.status === 200, `GitHub read failed (HTTP ${response.status}); no approval recorded`);
    try { return await response.json(); } catch { throw Error('GitHub returned invalid JSON; no approval recorded'); }
  };
}

export async function readGithubState(policy, prNumber, get) {
  validateApprovalPolicy(policy); positive(prNumber); const prefix = '/repos/' + policy.repository.full_name;
  const raw = await get(prefix + '/pulls/' + prNumber);
  const pull = { number: raw.number, state: raw.state, draft: raw.draft, head_sha: raw.head?.sha, head_repository_id: raw.head?.repo?.id, base_repository_id: raw.base?.repo?.id, base_full_name: raw.base?.repo?.full_name, base_ref: raw.base?.ref, author_id: raw.user?.id };
  const events = [], endpoint = policy.method === 'review' ? `/pulls/${prNumber}/reviews` : `/issues/${prNumber}/comments`;
  for (let page = 1; ; page++) {
    need(page <= 100, 'GitHub action pagination limit exceeded'); const rows = await get(prefix + endpoint + `?per_page=100&page=${page}`); need(Array.isArray(rows), 'GitHub actions must be a paginated array');
    for (const r of rows) events.push({ id: r.id, user: { id: r.user?.id, login: r.user?.login, type: r.user?.type }, state: r.state ?? 'COMMENT', commit_id: r.commit_id ?? null, body: r.body, submitted_at: policy.method === 'review' ? r.submitted_at : r.created_at, updated_at: policy.method === 'review' ? r.submitted_at : r.updated_at, url: r.html_url });
    if (rows.length < 100) break;
  }
  const permissions = [];
  for (const actor of policy.approvers) {
    const p = await get(prefix + '/collaborators/' + actor.login + '/permission');
    permissions.push({ id: p.user?.id, login: p.user?.login ?? '', type: p.user?.type, permission: p.permission });
  }
  // A draft review is not a submitted action and its timestamp may be null.
  return { pull, events: events.filter(e => e.state !== 'PENDING').sort((a, b) => a.id - b.id), permissions };
}

export async function freshGithubApproval(request, requestSha, policy, policySha, get, now = () => new Date().toISOString()) {
  const first = await readGithubState(policy, request.pr_number, get);
  const second = await readGithubState(policy, request.pr_number, get);
  need(stable(first) === stable(second), 'GitHub approval state changed during verification; retry');
  const verifiedAt = now(), decision = evaluateGithubApproval(request, requestSha, policy, policySha, second, verifiedAt);
  return { format: RECEIPT_FORMAT, status: 'github_account_approval_verified', request_sha256: requestSha, candidate_sha256: request.candidate_sha256, repository: request.repository, pr_number: request.pr_number, head_sha: request.head_sha, policy_sha256: policySha, ...decision, verified_at: verifiedAt, github_state_sha256: hash(stable(second)), gate: identity(), human_presence_verified: false, publisher_ownership_verified: false, deployable: false, approval_scope: 'exact_candidate_only_no_deployment' };
}

export async function prepareGithubRequest(candidateDir, policyPath, out, options) {
  out = privateOutput(out, candidateDir);
  need(typeof options.config === 'string' && options.config.length > 0, 'current site config required before preparing approval request');
  const config = validateConfig(JSON.parse(read(options.config).toString('utf8'))), buildRoot = realpathSync(resolve(dirname(realpathSync(options.config)), config.build_dir));
  need(out !== buildRoot && !out.startsWith(buildRoot + sep), 'private approval request must stay outside public build');
  const policyInput = pinned(policyPath, options.policy_sha256), policy = validateApprovalPolicy(policyInput.value);
  digest(options.candidate_sha256); positive(options.pr_number); commit(options.head_sha);
  const candidate = await verifySite(candidateDir, { expected_sha256: options.candidate_sha256, config: options.config });
  need(candidate.record.runtime.revision === options.head_sha, 'candidate declared revision differs from requested PR head');
  const request = { format: REQUEST_FORMAT, repository: policy.repository, base_ref: policy.base_ref, pr_number: options.pr_number, head_sha: options.head_sha, candidate_sha256: candidate.sha, rescap_candidate_sha256: candidate.result.candidateHash, rescap_evidence_sha256: candidate.result.evidenceHash, candidate_generated_at: candidate.record.runtime.generated_at, policy_sha256: options.policy_sha256 };
  const bytes = stable(request), sha = hash(bytes), template = declarationTemplate(request, sha);
  const summary = `# ResCap approval request\n\nInternal review only. No approval has been generated.\n\nPR: https://github.com/${policy.repository.full_name}/pull/${options.pr_number}\n\nHead: ${options.head_sha}\n\nFull-site candidate: ${candidate.sha}\n\nRequest: ${sha}\n\nMethod: ${policy.method}; required accounts: ${policy.required_approvals}.\n\nInspect the frozen site, exact source conditions, publication scope, policy and complete changes. Then change decision to approved and all four checks to true in the template, and submit it ${policy.method === 'review' ? 'as an APPROVE pull-request review' : 'as an explicit PR conversation comment'}. Account identity and current permissions are checked online. This is not proof of physical human presence or publisher ownership.\n\n${candidate.files.get('summary.md').toString('utf8')}\n\n## Pending declaration template\n\n${template}`;
  need(!existsSync(out), 'new request directory required'); mkdirSync(out);
  try { for (const [name, content] of [['request.json', bytes], ['approval-template.md', template], ['summary.md', summary]]) writeFileSync(join(out, name), content, { flag: 'wx' }); }
  catch (error) { rmSync(out, { recursive: true, force: true }); throw error; }
  return { request, request_sha256: sha, candidate_sha256: candidate.sha, approval_performed: false, deployment_performed: false };
}

async function checkedInputs(candidateDir, requestPath, policyPath, options) {
  const requestInput = pinned(requestPath, options.request_sha256), policyInput = pinned(policyPath, options.policy_sha256);
  const policy = validateApprovalPolicy(policyInput.value), request = requestInput.value; validateRequest(request, policy, options.policy_sha256);
  const candidate = await verifySite(candidateDir, { expected_sha256: request.candidate_sha256 });
  need(candidate.record.runtime.revision === request.head_sha && candidate.record.runtime.generated_at === request.candidate_generated_at && candidate.result.candidateHash === request.rescap_candidate_sha256 && candidate.result.evidenceHash === request.rescap_evidence_sha256, 'request belongs to another candidate/review');
  return { request, policy };
}

export async function checkGithubApproval(candidateDir, requestPath, policyPath, options, get = githubReader(process.env.RESCAP_GITHUB_TOKEN)) {
  const { request, policy } = await checkedInputs(candidateDir, requestPath, policyPath, options);
  const receipt = await freshGithubApproval(request, options.request_sha256, policy, options.policy_sha256, get);
  await checkedInputs(candidateDir, requestPath, policyPath, options); // Detect local replacement while API reads were in flight.
  return receipt;
}

export async function recordGithubApproval(candidateDir, requestPath, policyPath, out, options) {
  out = privateOutput(out, candidateDir);
  need(!existsSync(out), 'new receipt file required'); const receipt = await checkGithubApproval(candidateDir, requestPath, policyPath, options);
  const bytes = stable(receipt); writeFileSync(out, bytes, { flag: 'wx' }); return { receipt, receipt_sha256: hash(bytes), deployment_performed: false };
}

export async function recheckGithubApproval(candidateDir, requestPath, policyPath, receiptPath, options, get = githubReader(process.env.RESCAP_GITHUB_TOKEN)) {
  const previous = pinned(receiptPath, options.receipt_sha256).value;
  need(previous.format === RECEIPT_FORMAT && stable(previous.gate) === stable(identity()), 'receipt gate changed or unsupported');
  need(time(previous.expires_at) >= Date.now() && time(previous.verified_at) <= Date.now(), 'receipt observation expired or future');
  const current = await checkGithubApproval(candidateDir, requestPath, policyPath, options, get);
  for (const key of ['request_sha256', 'candidate_sha256', 'repository', 'pr_number', 'head_sha', 'policy_sha256', 'reviewers', 'human_presence_verified', 'publisher_ownership_verified', 'deployable', 'approval_scope', 'status']) need(stable(previous[key]) === stable(current[key]), 'receipt no longer matches current account approvals');
  pinned(receiptPath, options.receipt_sha256); return { ok: true, current, deployment_performed: false };
}
