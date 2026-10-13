import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, lstatSync, rmSync } from 'node:fs';
import { resolve, dirname, basename, join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { hash, stable } from './index.mjs';
import { verifySite, snapshot, validateConfig } from './site.mjs';
import { hostingInventory } from './hosting.mjs';

export const LOCAL_APPROVAL_FORMAT = 'rescap.site-human-approval.v1';
export const LOCAL_RELEASE_FORMAT = 'rescap.local-approved-site-release.v1';
export const CHECKS = ['source_accuracy', 'publication_scope', 'policy', 'changes'];
const labels = ['出典と内容が正しい', '公開してよい範囲である', '利用ポリシーを確認した', '今回の差分を確認した'];
const need = (ok, message) => { if (!ok) throw Error(message); };
const digest = value => need(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'explicit SHA-256 required');
const shape = (value, keys) => need(value && typeof value === 'object' && !Array.isArray(value) && stable(Object.keys(value).sort()) === stable([...keys].sort()), 'invalid approval keys');
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const within = (a, b) => a === b || a.startsWith(b + sep);
const inventory = files => [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, bytes]) => ({ path, bytes:bytes.length, sha256:hash(bytes) }));
const identity = () => ({ format:'rescap.local-approval-generator.v1', sha256:hash(readFileSync(new URL('./local-approval.mjs', import.meta.url))) });
function pinned(path, sha, maximum = 16384) {
  digest(sha); need(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 'regular approval file required');
  const bytes = readFileSync(path); need(bytes.length <= maximum && hash(bytes) === sha, 'input differs from expected SHA-256');
  return JSON.parse(new TextDecoder('utf-8', { fatal:true }).decode(bytes));
}
async function current(dir, options) {
  digest(options.candidate_sha256); need(options.config, 'current site config required');
  return verifySite(dir, { expected_sha256:options.candidate_sha256, config:options.config });
}
function target(path, dir, options, other = []) {
  const configPath = realpathSync(options.config), config = validateConfig(JSON.parse(readFileSync(configPath)));
  const out = join(realpathSync(dirname(resolve(path))), basename(resolve(path)));
  need(!existsSync(out), 'new output required');
  for (const root of [dir, resolve(dirname(configPath), config.build_dir), ...other]) {
    const real = realpathSync(root); need(!within(out, real) && !within(real, out), 'output overlaps private inputs or public build');
  }
  for (const file of [configPath, resolve(dirname(configPath), config.mapping), ...(config.hosting ? [resolve(dirname(configPath), config.hosting)] : [])]) need(!within(realpathSync(file), out), 'output overlaps current configuration');
  return out;
}
function bindings(candidate) {
  return { format:LOCAL_APPROVAL_FORMAT, decision:'approved', candidate_sha256:candidate.sha, rescap_candidate_sha256:candidate.result.candidateHash, evidence_sha256:candidate.result.evidenceHash, revision:candidate.record.runtime.revision };
}
export function validateLocalApproval(approval, candidate, now = Date.now()) {
  shape(approval, ['format','decision','candidate_sha256','rescap_candidate_sha256','evidence_sha256','revision','reviewer','approved_at','checks']);
  for (const [key, value] of Object.entries(bindings(candidate))) need(approval[key] === value, 'approval belongs to another candidate or review');
  shape(approval.reviewer, ['name','role','kind']);
  need(typeof approval.reviewer.name === 'string' && approval.reviewer.name.trim().length > 0 && approval.reviewer.name.length <= 200 && !/[\x00-\x1f\x7f]/.test(approval.reviewer.name), 'reviewer name required');
  need(approval.reviewer.kind === 'human' && approval.reviewer.role === 'publisher_or_delegate', 'publisher/delegate human declaration required');
  shape(approval.checks, CHECKS); need(CHECKS.every(key => approval.checks[key] === true), 'all four explicit human checks required');
  const time = Date.parse(approval.approved_at);
  need(typeof approval.approved_at === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(approval.approved_at) && Number.isFinite(time) && new Date(time).toISOString() === approval.approved_at, 'valid UTC approval time required');
  need(time >= Date.parse(candidate.record.runtime.generated_at) && time <= now, 'approval is future-dated or predates generation');
  need(now - time <= 86400000, 'approval expired; obtain a new explicit review');
  return approval;
}
export function terminalSummary(candidate) {
  const job = candidate.result.evidence.job;
  const names = { read_allowed:'読み取り', canonical_reference_allowed:'正本としての参照', search_answer_allowed:'検索回答への利用', model_training_allowed:'モデル学習', dataset_redistribution_allowed:'データセットとしての再配布' };
  const policy = Object.entries(job.policy).map(([key, value])=>`${names[key] ?? key}: ${value ? '許可' : '許可しない'}`).join('\n');
  const changes = candidate.comparison.selected_changes.map(c=>`${(c.after ?? c.before)?.label ?? c.id}\n  以前: ${c.before?.text ?? '掲載なし'}\n  今回: ${c.after?.text ?? '掲載なし'}`).join('\n');
  const build = candidate.comparison.build_changes.map(c=>`${{added:'追加',changed:'変更',removed:'削除'}[c.kind]}: ${c.path}`).join('\n');
  const value = `${job.site.name} / ${job.site.url}\n版: ${candidate.record.runtime.revision}\n確認対象: ${candidate.record.site_files.length} ファイル\n候補: ${candidate.sha}\n\n公開する内容:\n${candidate.result.evidence.claims.map(c => `${c.label}: ${c.text}\n出典: ${c.source_url}`).join('\n\n')}\n\n利用ポリシー:\n${policy}\n自動の申し込み・契約・支払い: 許可しない\n\n差分:\n${candidate.comparison.baseline.kind === 'initial_full_review' ? '初回です。全体を確認してください。' : '指定した前回候補との比較。公開履歴の証明ではありません。'}\n${changes || '抽出した内容の変更はありません。'}\n${build}\n\n公開ファイル（画像・CSSの変更は対象ファイルも確認してください）:\n${candidate.record.site_files.map(f=>`${f.path} (${f.bytes} bytes)`).join('\n')}`;
  // Source strings are literal evidence, never terminal control instructions.
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
}
export async function approveLocal(dir, out, options, io = { input:process.stdin, output:process.stdout }) {
  need(io.input.isTTY === true && io.output.isTTY === true, 'interactive terminal required; use the private browser review for nonterminal approval');
  const destination = target(out, dir, options), candidate = await current(dir, options);
  io.output.write('公開前の確認（まだ承認されていません）\n' + terminalSummary(candidate) + '\n');
  const readline = createInterface(io);
  try {
    const name = (await readline.question('確認者のお名前: ')).trim();
    const checks = {};
    for (let n = 0; n < CHECKS.length; n++) {
      need((await readline.question(`${labels[n]} — 確認した場合は「はい」: `)).trim() === 'はい', 'approval cancelled; no declaration written'); checks[CHECKS[n]] = true;
    }
    need((await readline.question('公開者または委任された確認者として、この版を承認する場合は「承認」: ')).trim() === '承認', 'approval cancelled; no declaration written');
    const approval = { ...bindings(candidate), reviewer:{ name, role:'publisher_or_delegate', kind:'human' }, approved_at:new Date().toISOString(), checks };
    validateLocalApproval(approval, candidate);
    await current(dir, options); // Reject edits while the human was reading.
    const bytes = stable(approval); writeFileSync(destination, bytes, { flag:'wx', mode:0o600 });
    return { approval_sha256:hash(bytes), proof_type:'declared_human_review_not_verified_identity', deployment_performed:false };
  } finally { readline.close(); }
}

export function browserReview(candidate) {
  const payload = JSON.stringify(bindings(candidate)).replace(/</g, '\\u003c');
  const script = `const base=${payload};const form=document.querySelector('form');const button=document.querySelector('#approve');const inputs=[...form.querySelectorAll('input[type=checkbox]')];const name=document.querySelector('#name');function ready(){button.disabled=!(name.value.trim()&&inputs.every(i=>i.checked));}form.addEventListener('input',ready);form.addEventListener('submit',event=>{event.preventDefault();if(button.disabled)return;const declaration={...base,reviewer:{name:name.value.trim(),role:'publisher_or_delegate',kind:'human'},approved_at:new Date().toISOString(),checks:Object.fromEntries(inputs.filter(i=>i.dataset.check).map(i=>[i.dataset.check,true]))};const url=URL.createObjectURL(new Blob([JSON.stringify(declaration,null,2)+'\\n'],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='rescap-approval.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);document.querySelector('#status').textContent='承認ファイルを保存しました。生成担当へ渡してください。サイトの公開はまだ行われていません。';});ready();`;
  const cspHash = createHash('sha256').update(script).digest('base64');
  const job = candidate.result.evidence.job;
  const policyNames = { read_allowed:'読み取り', canonical_reference_allowed:'正本としての参照', search_answer_allowed:'検索回答への利用', model_training_allowed:'モデル学習', dataset_redistribution_allowed:'データセットとしての再配布' };
  const policyTable = '<table><thead><tr><th>利用方法</th><th>設定</th></tr></thead><tbody>' + Object.entries(job.policy).map(([key,value])=>`<tr><th>${esc(policyNames[key] ?? key)}</th><td>${value ? '許可' : '許可しない'}</td></tr>`).join('') + '</tbody></table>';
  const diffRows = candidate.comparison.selected_changes.map(c=>`<tr><th>${esc((c.after ?? c.before)?.label ?? c.id)}</th><td>${esc(c.before?.text ?? '掲載なし')}</td><td>${esc(c.after?.text ?? '掲載なし')}</td></tr>`).join('');
  const diffTable = diffRows ? '<table><thead><tr><th>項目</th><th>以前</th><th>今回</th></tr></thead><tbody>' + diffRows + '</tbody></table>' : '<p>抽出した内容の変更はありません。</p>';
  const buildDiff = '<ul>' + candidate.comparison.build_changes.map(c=>`<li>${esc({added:'追加',changed:'変更',removed:'削除'}[c.kind])}：${esc(c.path)}</li>`).join('') + '</ul><p>画像・CSSの変更は、対象ファイルも確認してください。</p>';
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${cspHash}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; connect-src 'none'"><title>公開前の確認 | ${esc(job.site.name)}</title><style>body{font:16px/1.7 system-ui;max-width:960px;margin:32px auto;padding:0 20px;color:#172b28;background:#fafbf8}h1,h2{line-height:1.4}table{width:100%;border-collapse:collapse}th,td{border:1px solid #ccd6d1;padding:12px;text-align:left;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere}label{display:block;margin:18px 0}input[type=text]{box-sizing:border-box;width:100%;font:inherit;padding:10px}button{font:inherit;background:#155c4b;color:white;border:0;border-radius:6px;padding:14px 20px}button:disabled{background:#777}small{display:block}section{margin:32px 0}</style></head><body><h1>公開前の確認</h1><p>この確認ファイルは内部用です。公開サイトには置きません。</p><p>${esc(job.site.name)} / ${esc(job.site.url)}<br>公開者：${esc(job.site.publisher)}<br>今回の版：${esc(candidate.record.runtime.revision)}</p><section><h2>公開する内容と出典</h2><table><thead><tr><th>項目</th><th>内容と出典</th></tr></thead><tbody>${candidate.result.evidence.claims.map(c=>`<tr><th>${esc(c.label)}</th><td>${esc(c.text)}<small>${esc(c.source_url)} / ${esc(c.pointer)}<br>出典の作成日時：${esc(c.source_authored_at ?? '不明')}</small></td></tr>`).join('')}</tbody></table><details><summary>出典全体・抽出位置を確認する</summary><pre>${esc(stable(job.sources))}</pre></details></section><section><h2>利用ポリシー</h2><p>自動の申し込み・契約・支払いは許可しません。</p>${policyTable}</section><section><h2>前回との差分</h2><p>${candidate.comparison.baseline.kind === 'initial_full_review' ? '初回です。全体を確認してください。' : '指定した前回候補との比較です。公開履歴の証明ではありません。'}</p>${diffTable}${buildDiff}<details><summary>差分の詳細</summary><pre>${esc(stable(candidate.comparison))}</pre></details><details><summary>画像・CSSを含む公開ファイル全体を確認する</summary><pre>${esc(stable(candidate.record.site_files))}</pre></details><details><summary>配信ルートと設定</summary><pre>${esc(stable(candidate.hostingBytes ? JSON.parse(candidate.hostingBytes) : {provider:null,files:candidate.record.site_files}))}</pre></details></section><section><h2>確認して承認する</h2><p>内容が正しく、公開してよいことを確認してください。修正が必要な場合は生成担当へ戻してください。</p><form><label for="name">確認者のお名前</label><input id="name" type="text" maxlength="200" required autocomplete="name">${CHECKS.map((key,n)=>`<label><input type="checkbox" data-check="${key}"> ${labels[n]}</label>`).join('')}<label><input type="checkbox"> 公開者または委任された確認者として、この版の公開を承認します</label><button id="approve" type="submit" disabled>承認ファイルを保存</button></form><p id="status" role="status">未承認。確認して承認するまで、承認ファイルは作成されません。</p><p>保存したファイルを生成担当へ渡してください。この操作だけでサイトが公開されることはありません。</p><details><summary>確認対象の識別情報</summary><pre>${esc(stable(bindings(candidate)))}</pre><p>確認者の申告を記録します。本人確認や電子署名による証明ではありません。</p></details></section><noscript>承認にはブラウザのJavaScriptが必要です。無効な場合は生成担当へ連絡してください。</noscript><script>${script}</script></body></html>\n`;
}
export async function writeBrowserReview(dir, out, options) {
  const destination = target(out, dir, options), candidate = await current(dir, options);
  const bytes = browserReview(candidate); await current(dir, options);
  writeFileSync(destination, bytes, { flag:'wx', mode:0o600 });
  return { review_sha256:hash(bytes), candidate_sha256:candidate.sha, approval_performed:false, deployment_performed:false };
}
export async function checkLocalApproval(dir, approvalPath, options) {
  const approval = pinned(approvalPath, options.approval_sha256), candidate = await current(dir, options);
  validateLocalApproval(approval, candidate); pinned(approvalPath, options.approval_sha256);
  return { candidate, approval, proof_type:'declared_human_review_not_verified_identity' };
}
function contents(candidate, approval, options) {
  const config = validateConfig(JSON.parse(candidate.configBytes)), files = new Map(candidate.siteFiles);
  for (const [path, bytes] of candidate.result.publicFiles) files.set(config.public_path + '/' + path, Buffer.from(bytes));
  const publication = { format:'rescap.local-declared-publication.v1', candidate_sha256:candidate.sha, evidence_sha256:candidate.result.evidenceHash, approval_sha256:options.approval_sha256, approved_at:approval.approved_at, approval_expires_at:new Date(Date.parse(approval.approved_at)+86400000).toISOString(), proof_type:'declared_human_review_not_verified_identity', human_presence_verified:false, publisher_ownership_verified:false, deployment_performed:false };
  files.set(config.public_path + '/publication.json', Buffer.from(stable(publication)));
  const record = { format:LOCAL_RELEASE_FORMAT, status:'assembled_from_local_human_declaration', generator:identity(), pins:{ candidate_sha256:options.candidate_sha256, approval_sha256:options.approval_sha256 }, approval, proof_type:publication.proof_type, canonical_url:candidate.result.evidence.job.site.url, public_path:config.public_path, public_files:inventory(files), hosting:hostingInventory(candidate.hostingBytes, files), deployment_performed:false, deployment_authorized:false };
  return { files, record };
}
export async function assembleLocal(dir, approvalPath, out, options) {
  const destination = target(out, dir, options, [approvalPath]);
  const { candidate, approval } = await checkLocalApproval(dir, approvalPath, options);
  const { files, record } = contents(candidate, approval, options);
  await current(dir, options); pinned(approvalPath, options.approval_sha256); validateLocalApproval(approval, candidate);
  // Use verified immutable bytes; the final synchronous check catches current-build edits.
  const config = validateConfig(JSON.parse(candidate.configBytes)), build = resolve(dirname(realpathSync(options.config)), config.build_dir);
  need(stable(inventory(snapshot(build))) === stable(candidate.record.site_files), 'current build changed before assembly');
  need(hash(readFileSync(options.config)) === candidate.record.config_sha256 && hash(readFileSync(resolve(dirname(realpathSync(options.config)), config.mapping))) === candidate.record.mapping_sha256, 'current config or mapping changed before assembly');
  if (config.hosting) need(hash(readFileSync(resolve(dirname(realpathSync(options.config)), config.hosting))) === candidate.record.hosting_profile_sha256, 'current hosting profile changed before assembly');
  need(stable(inventory(snapshot(dir))) === stable(inventory(candidate.files)), 'candidate changed before assembly');
  mkdirSync(destination, { mode:0o700 });
  try {
    mkdirSync(join(destination, 'public'));
    for (const [path, bytes] of files) { const file = join(destination, 'public', path); mkdirSync(dirname(file), { recursive:true }); writeFileSync(file, bytes, { flag:'wx' }); }
    writeFileSync(join(destination, 'release.json'), stable(record), { flag:'wx', mode:0o600 });
  } catch (error) { rmSync(destination, { recursive:true, force:true }); throw error; }
  return { release_sha256:hash(stable(record)), proof_type:record.proof_type, local_public_files_assembled:true, deployment_authorized:false, deployment_performed:false };
}
export async function verifyLocalRelease(releaseDir, dir, approvalPath, options) {
  const record = pinned(join(releaseDir, 'release.json'), options.release_sha256, 16 * 1024 * 1024);
  const { candidate, approval } = await checkLocalApproval(dir, approvalPath, options), rebuilt = contents(candidate, approval, options);
  need(stable(record) === stable(rebuilt.record), 'local release differs from reconstructed artifact');
  const files = new Map([...rebuilt.files].map(([path, bytes]) => ['public/' + path, bytes])); files.set('release.json', Buffer.from(stable(rebuilt.record)));
  need(stable(inventory(snapshot(releaseDir))) === stable(inventory(files)), 'release files changed or private/extra files present');
  return { release_sha256:options.release_sha256, proof_type:record.proof_type, offline_only:true, deployment_authorized:false, deployment_performed:false };
}
