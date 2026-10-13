#!/usr/bin/env node
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { initConfig, prepareSite, verifySite } from './site.mjs';
import { stable } from './index.mjs';
import { writeBrowserReview, approveLocal, checkLocalApproval, assembleLocal, verifyLocalRelease } from './local-approval.mjs';
import { assembleApprovedSite, verifyApprovedRelease, checkApprovedRelease, recordDeploymentObservation } from './release.mjs';
import { prepareGithubRequest, recordGithubApproval, recheckGithubApproval } from './github-approval.mjs';

const usage = 'rescap-site init NEW_CONFIG | prepare CONFIG NEW_CANDIDATE --revision REV --producer ACTOR [--generated-at ISO_TIME] [--job-id ID] [--baseline CANDIDATE --baseline-sha SHA256] | verify CANDIDATE [--expect SHA256] [--config CONFIG] | browser-install | github-request CANDIDATE POLICY NEW_REQUEST_DIR --expect-candidate SHA --expect-policy SHA --pr NUMBER --head COMMIT --config CONFIG | github-check CANDIDATE REQUEST_JSON POLICY NEW_RECEIPT_JSON --expect-request SHA --expect-policy SHA | github-recheck CANDIDATE REQUEST_JSON POLICY RECEIPT_JSON --expect-request SHA --expect-policy SHA --expect-receipt SHA | assemble CANDIDATE REQUEST POLICY RECEIPT NEW_RELEASE --expect-candidate SHA --expect-request SHA --expect-policy SHA --expect-receipt SHA --config CONFIG | release-verify RELEASE CANDIDATE REQUEST POLICY RECEIPT --expect-release SHA --expect-candidate SHA --expect-request SHA --expect-policy SHA --expect-receipt SHA | release-check (same arguments, online) | deployment-check RELEASE CANDIDATE REQUEST POLICY RECEIPT NEW_OBSERVATION --base-url HTTPS_BASE (same pins)';
const flags = (args, allowed) => {
  const result = {};
  for (let n = 0; n < args.length; n += 2) {
    if (!allowed.includes(args[n]) || Object.hasOwn(result, args[n]) || !args[n + 1] || args[n + 1].startsWith('--')) throw Error(usage);
    result[args[n]] = args[n + 1];
  }
  return result;
};
try {
  const [command, ...args] = process.argv.slice(2); let result;
  if (['help', '--help', '-h'].includes(command) && args.length === 0) {
    console.log('ResCap site generator\n\nPrivate human review (GitHub is optional):\n  review CANDIDATE NEW_REVIEW.html --expect SHA --config CONFIG\n  approve CANDIDATE NEW_APPROVAL.json --expect SHA --config CONFIG\n  approval-check CANDIDATE APPROVAL.json --expect SHA --expect-approval SHA --config CONFIG\n  assemble-local CANDIDATE APPROVAL.json NEW_RELEASE --expect SHA --expect-approval SHA --config CONFIG\n  local-release-verify RELEASE CANDIDATE APPROVAL.json --expect SHA --expect-approval SHA --expect-release SHA --config CONFIG\n\nBrowser reviewers open the private HTML, check the content, and save an approval file. No terminal, GitHub account or hosted page is needed for review. Terminal approval is interactive; no --yes option. Local declarations do not prove identity or authorize deployment.\n\nExisting commands:\n' + usage);
  } else if (['review', 'approve', 'approval-check', 'assemble-local', 'local-release-verify'].includes(command)) {
    const count = ['review', 'approve', 'approval-check'].includes(command) ? 2 : 3;
    if (args.length < count) throw Error('Use rescap-site --help for private human review commands');
    const f = flags(args.slice(count), ['--expect', '--expect-approval', '--expect-release', '--config']);
    const options = { candidate_sha256:f['--expect'], approval_sha256:f['--expect-approval'], release_sha256:f['--expect-release'], config:f['--config'] };
    if (command === 'review') result = await writeBrowserReview(...args.slice(0, count), options);
    else if (command === 'approve') result = await approveLocal(...args.slice(0, count), options);
    else if (command === 'assemble-local') result = await assembleLocal(...args.slice(0, count), options);
    else if (command === 'local-release-verify') result = await verifyLocalRelease(...args.slice(0, count), options);
    else { const checked = await checkLocalApproval(...args.slice(0, count), options); result = { candidate_sha256:checked.candidate.sha, approval_sha256:options.approval_sha256, proof_type:checked.proof_type, deployment_authorized:false }; }
  } else if (command === 'init' && args.length === 1) { initConfig(args[0]); console.log(stable({ ok: true, command, configuration_complete: false, next: 'Set public_build deliberately, supply an explicit mapping, and run your existing build.' })); }
  else if (command === 'prepare' && args.length >= 2) {
    const f = flags(args.slice(2), ['--revision', '--producer', '--generated-at', '--job-id', '--baseline', '--baseline-sha']);
    result = await prepareSite(args[0], args[1], { revision: f['--revision'], producer: f['--producer'], generated_at: f['--generated-at'], job_id: f['--job-id'], baseline: f['--baseline'], baseline_sha256: f['--baseline-sha'] });
  } else if (command === 'verify' && args.length >= 1) {
    const f = flags(args.slice(1), ['--expect', '--config']); result = await verifySite(args[0], { expected_sha256: f['--expect'], config: f['--config'] });
  } else if (command === 'github-request' && args.length >= 3) {
    const f = flags(args.slice(3), ['--expect-candidate', '--expect-policy', '--pr', '--head', '--config']);
    result = await prepareGithubRequest(args[0], args[1], args[2], { candidate_sha256: f['--expect-candidate'], policy_sha256: f['--expect-policy'], pr_number: Number(f['--pr']), head_sha: f['--head'], config: f['--config'] });
  } else if (command === 'github-check' && args.length >= 4) {
    const f = flags(args.slice(4), ['--expect-request', '--expect-policy']);
    result = await recordGithubApproval(args[0], args[1], args[2], args[3], { request_sha256: f['--expect-request'], policy_sha256: f['--expect-policy'] });
  } else if (command === 'github-recheck' && args.length >= 4) {
    const f = flags(args.slice(4), ['--expect-request', '--expect-policy', '--expect-receipt']);
    result = await recheckGithubApproval(args[0], args[1], args[2], args[3], { request_sha256: f['--expect-request'], policy_sha256: f['--expect-policy'], receipt_sha256: f['--expect-receipt'] });
  } else if (['assemble', 'release-verify', 'release-check', 'deployment-check'].includes(command)) {
    const count = command === 'deployment-check' ? 6 : 5;
    if (args.length < count) throw Error(usage);
    const f = flags(args.slice(count), ['--expect-candidate', '--expect-request', '--expect-policy', '--expect-receipt', '--expect-release', '--config', '--base-url']);
    const options = { candidate_sha256: f['--expect-candidate'], request_sha256: f['--expect-request'], policy_sha256: f['--expect-policy'], receipt_sha256: f['--expect-receipt'], release_sha256: f['--expect-release'], config: f['--config'], base_url: f['--base-url'] };
    if (command === 'assemble') result = await assembleApprovedSite(...args.slice(0, 5), options);
    else if (command === 'deployment-check') result = await recordDeploymentObservation(...args.slice(0, 6), options);
    else if (command === 'release-check') result = await checkApprovedRelease(...args.slice(0, 5), options);
    else { const verified = await verifyApprovedRelease(...args.slice(0, 5), options); result = { ok: true, offline_only: true, release_sha256: options.release_sha256, public_inventory_sha256: verified.record.public_inventory_sha256, deployment_performed: false }; }
  } else if (command === 'browser-install' && args.length === 0) {
    const cli = join(dirname(createRequire(import.meta.url).resolve('playwright/package.json')), 'cli.js');
    const child = spawnSync(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit' });
    if (child.error) throw child.error; if (child.status !== 0) throw Error('Chromium installation failed');
  } else throw Error(usage);
  if (result?.record) console.log(stable({ ok: true, command, candidate_sha256: result.sha, rescap_candidate_sha256: result.result.candidateHash, baseline: result.comparison.baseline.kind, selected_changes: result.comparison.selected_changes.length, build_changes: result.comparison.build_changes.length, deployable: false, approval_performed: false, deployment_performed: false }));
  else if (result) console.log(stable({ ok: true, command, ...result, approval_submission_performed: false, deployment_performed: false }));
} catch (error) { console.error(String(error)); process.exitCode = 1; }
