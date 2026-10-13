import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION = 'rescap.generator.phase1.v1';
export const hash = value => createHash('sha256').update(value).digest('hex');
export const stable = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v, 2) + '\n';
const fingerprint = () => hash(readFileSync(fileURLToPath(import.meta.url)));
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const need = (condition, message) => { if (!condition) throw Error(message); };
const string = (v, name) => need(typeof v === 'string' && v.trim().length > 0, `required string: ${name}`);
const shape = (v, keys, name) => need(v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v,k)), `invalid keys: ${name}`);
const date = (v, name) => {
  string(v,name); const m=v.match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{3})?(?:Z|[+-]\d\d:\d\d)$/);
  need(m && Number.isFinite(Date.parse(v)),`invalid timestamp: ${name}`);
  const d=new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  need(d.toISOString().slice(0,10)===v.slice(0,10) && Number(m[4])<24 && Number(m[5])<60 && Number(m[6])<60,`invalid calendar date: ${name}`);
};
const url = v => { string(v,'url'); const u = new URL(v); need(u.protocol === 'https:' && !u.username && !u.password, 'only credential-free HTTPS URLs supported'); };
const policies = ['read_allowed','canonical_reference_allowed','search_answer_allowed','model_training_allowed','dataset_redistribution_allowed'];
export function pointer(data, path) {
  need(typeof path === 'string' && path.startsWith('/') && !/~(?![01])/.test(path), 'invalid JSON pointer');
  for (const part of path.slice(1).split('/').map(p => p.replace(/~1/g,'/').replace(/~0/g,'~'))) {
    need(data !== null && typeof data === 'object' && Object.hasOwn(data, part), `missing pointer: ${path}`);
    data = data[part];
  }
  string(data, `claim ${path}`); return data;
}
export function validateJob(job) {
  shape(job,['format','job_id','generated_at','producer','site','sources','claims','policy'],'job');
  need(job.format === 'rescap.generation-job.v1','unsupported job format'); string(job.job_id,'job_id'); date(job.generated_at,'generated_at');
  // Producer is a descriptive string, deliberately not an AI/human/CI enum.
  string(job.producer,'producer'); shape(job.site,['id','name','url','publisher'],'site');
  for (const key of ['id','name','publisher']) string(job.site[key],key); url(job.site.url);
  need(Array.isArray(job.sources) && job.sources.length > 0,'sources required');
  const ids = new Set();
  for (const source of job.sources) {
    shape(source,['id','url','authored_at','public','data'],'source'); string(source.id,'source id');
    need(!ids.has(source.id),'duplicate source id'); ids.add(source.id); url(source.url); if(source.authored_at!==null)date(source.authored_at,'authored_at');
    need(source.public === true,'only explicitly public sources allowed');
    need(source.data && typeof source.data === 'object' && !Array.isArray(source.data),'source data object required');
  }
  need(Array.isArray(job.claims) && job.claims.length > 0,'claims required'); ids.clear();
  for (const claim of job.claims) {
    shape(claim,['id','label','source_id','pointer'],'claim'); string(claim.id,'claim id'); string(claim.label,'label');
    need(!ids.has(claim.id),'duplicate claim id'); ids.add(claim.id);
    const source = job.sources.find(s => s.id === claim.source_id); need(source,'missing source'); pointer(source.data,claim.pointer);
  }
  shape(job.policy,policies,'policy'); for (const key of policies) need(typeof job.policy[key] === 'boolean',`explicit boolean required: ${key}`);
  need(job.policy.read_allowed === true,'phase 1 only supports public readable information');
  return job;
}
const claimsOf = job => job.claims.map(c => {
  const s = job.sources.find(s => s.id === c.source_id), b = s.data.format === 'rescap.html-source.v1' ? s.data.bindings.find(b=>b.id===c.id) : null;
  return {...c,text:pointer(s.data,c.pointer),source_url:s.url,source_authored_at:s.authored_at,source_sha256:hash(stable(s.data)),...(b?{html_source:{html_sha256:s.data.html_sha256,group_selector:b.group_selector,group_index:b.group_index,selector:b.selector,exclude_selectors:b.exclude_selectors,disclosure:b.disclosure,adapter:s.data.adapter,browser_engine_version:s.data.browser_engine_version}}:{})};
});
const htmlLocation = c => c.html_source ? `<br>HTML：${esc(c.html_source.group_selector)}［${c.html_source.group_index+1}］ → ${esc(c.html_source.selector)}${c.html_source.exclude_selectors.length?'<br>明示した除外：'+esc(c.html_source.exclude_selectors.join('、')):''}${c.html_source.disclosure?'<br>明示した折りたたみ項目：'+esc(c.html_source.disclosure.container_selector):''}` : '';
export function compareJobs(previous, job) {
  if (!previous) return {baseline:'initial_publication',claim_changes:claimsOf(job).map(c=>({id:c.id,kind:'added',before:null,after:c})),other_changes:[]};
  validateJob(previous); need(previous.site.id === job.site.id && previous.site.url === job.site.url,'previous job belongs to another site');
  const old = new Map(claimsOf(previous).map(c=>[c.id,c])), current = new Map(claimsOf(job).map(c=>[c.id,c]));
  return {baseline:hash(stable(previous)),claim_changes:[...new Set([...old.keys(),...current.keys()])].sort().flatMap(id => {
    const before = old.get(id) ?? null, after = current.get(id) ?? null;
    return stable(before) === stable(after) ? [] : [{id,kind:!before?'added':!after?'removed':'changed',before,after}];
  }),other_changes:['job_id','generated_at','producer','site','sources','policy'].filter(k=>stable(previous[k])!==stable(job[k])).map(k=>({field:k,before:previous[k],after:job[k]}))};
}
const document = (title, body) => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${esc(title)}</title><style>body{font:16px/1.7 system-ui,sans-serif;max-width:960px;margin:32px auto;padding:0 20px;color:#172b28;background:#fafbf8}a{color:#155c4b}h1,h2{line-height:1.3}table{border-collapse:collapse;width:100%;table-layout:fixed}th,td{border:1px solid #ccd6d1;padding:10px;text-align:left;vertical-align:top;overflow-wrap:anywhere}pre,code{white-space:pre-wrap;overflow-wrap:anywhere}dt{font-weight:bold}dd{margin:0 0 16px}section{margin:32px 0}</style></head><body>${body}</body></html>\n`;
export function build(job, previous = null) {
  validateJob(job); const claims = claimsOf(job), sourceHash = hash(stable(job.sources)), jobHash = hash(stable(job));
  const identity = {version:VERSION,source_sha256:fingerprint()}, id = `rescap-${jobHash.slice(0,16)}`;
  const boundaries = {automated_submit_allowed:false,automated_contract_allowed:false,automated_payment_allowed:false};
  const capsule = {schema_version:'rescap.result_capsule.v0',implementation_profile:'rescap.generator.public-information.v1',capsule_id:id,capsule_type:'public_information',created_at:job.generated_at,scope:'public_readable',intent:{raw_text:`${job.site.name}の公開情報を参照する`,kind:'publisher_publication_purpose'},snapshot:{snapshot_id:sourceHash,generated_at:job.generated_at,time_basis:'declared_generation_time_not_source_creation_approval_or_deployment',flags:['bounded','unknown_freshness']},items:[{item_id:job.site.id,item_type:'public_information',title:job.site.name,fields:{claims},evidence:claims.map(c=>({source:c.source_url,pointer:c.pointer,supports:c.id,sha256:c.source_sha256})),available_actions:[],flags:['bounded','public_readable']}],available_actions:[],flags:['bounded','public_readable'],policy_refs:['policy.json'],action_boundaries:boundaries};
  const publicFiles = new Map([
    ['rescap.json',stable(capsule)],
    ['manifest.json',stable({format:'rescap.site-manifest.v1',site:job.site,capsule:'rescap.json',policy:'policy.json',publication:'publication.json',human_information:'public-information.html',source_sha256:sourceHash})],
    ['policy.json',stable({...job.policy,action_boundaries:boundaries,third_party_compliance_guaranteed:false})],
    ['public-information.html',document(`${job.site.name}の公開情報`,`<h1>${esc(job.site.name)}の公開情報</h1><p>公開者：${esc(job.site.publisher)}。掲載内容の正本は各出典です。価格や期間の条件を含めて参照してください。</p><dl>${claims.map(c=>`<dt>${esc(c.label)}</dt><dd>${esc(c.text)}<br><a href="${esc(c.source_url)}" rel="noreferrer">正本</a> · ${esc(c.pointer)} · 作成日時 ${esc(c.source_authored_at??'不明（推定しません）')}</dd>`).join('')}</dl><p>生成日時：${esc(job.generated_at)}。内容の最終更新・承認・デプロイ日時ではありません。</p><p>承認の有無と対象版は<a href="publication.json">公開記録</a>で確認してください。公開者本人の確認や電子署名による証明は行っていません。</p><p><a href="rescap.json">ResCap JSON</a> / <a href="manifest.json">manifest</a> / <a href="policy.json">公開ポリシー</a></p>`)]
  ]);
  const inventory = [...publicFiles].map(([path,value])=>({path,sha256:hash(value)}));
  const candidateHash = hash(stable({job_sha256:jobHash,generator:identity,files:inventory}));
  const evidence = {format:'rescap.review-evidence.v1',status:'pending_human_review',job,job_sha256:jobHash,generator:identity,candidate_sha256:candidateHash,source_sha256:sourceHash,claims,comparison:compareJobs(previous,job),previous_job:previous,files:inventory,checks:{direct_source_values:true,unique_claims:true,explicit_policy:true,no_mutation_actions:true},proof_type:'correspondence_not_truth_or_identity'};
  const evidenceHash = hash(stable(evidence));
  const policyLabels = {read_allowed:'読み取り',canonical_reference_allowed:'正本としての参照',search_answer_allowed:'検索回答への利用',model_training_allowed:'モデル学習',dataset_redistribution_allowed:'データセットとして再配布'};
  const fieldLabels = {job_id:'jobの識別子',generated_at:'生成日時',producer:'生成担当',site:'サイト・公開者',sources:'出典データ',policy:'公開ポリシー'};
  const diff = evidence.comparison;
  const diffRows = diff.claim_changes.map(c=>`<tr><td>${esc({added:'追加',changed:'変更',removed:'削除'}[c.kind])}：${esc((c.after??c.before).label)}</td><td>${esc(c.before?.text??'掲載なし')}<br>${esc(c.before?.source_url??'')}<br>${esc(c.before?.pointer??'')}</td><td>${esc(c.after?.text??'掲載なし')}<br>${esc(c.after?.source_url??'')}<br>${esc(c.after?.pointer??'')}</td></tr>`).join('');
  const review = document('ResCap 公開前の確認',`<h1>公開前の確認</h1><p><strong>未承認</strong>。公開者または委任されたhumanが、内容・公開範囲・ポリシー・差分を確認してください。</p><dl><dt>生成担当</dt><dd>${esc(job.producer)}</dd><dt>公開者・サイト</dt><dd>${esc(job.site.publisher)} / <a href="${esc(job.site.url)}">${esc(job.site.name)}</a></dd><dt>生成日時</dt><dd>${esc(job.generated_at)}（内容の作成・承認・デプロイ日時とは別です）</dd><dt>job</dt><dd>${esc(job.job_id)}</dd></dl><h2>出典と公開される内容</h2><p>価格や期間の条件を含めて確認してください。機械検証は出典との一致を示し、事実の正しさや本人確認を証明しません。</p><table><thead><tr><th>項目・出典</th><th>正本の値</th><th>生成された値</th></tr></thead><tbody>${claims.map(c=>`<tr><td>${esc(c.label)}<br><a href="${esc(c.source_url)}">正本を確認</a><br>${esc(c.pointer)}${htmlLocation(c)}<br>作成 ${esc(c.source_authored_at??'不明（推定しません）')}</td><td>${esc(c.text)}</td><td>${esc(c.text)}<br><small>機械検証：一致</small></td></tr>`).join('')}</tbody></table><details><summary>入力した出典全体を確認する</summary><p>公開ファイルに載るのは上の選択項目です。選択漏れや条件の欠落も確認してください。</p><pre>${esc(stable(job.sources))}</pre></details><h2>公開ポリシー・操作範囲</h2><table><thead><tr><th>利用方法</th><th>公開者の設定</th></tr></thead><tbody>${policies.map(k=>`<tr><td>${esc(policyLabels[k])}</td><td>${job.policy[k]?'許可':'許可しない'}</td></tr>`).join('')}</tbody></table><p>自動の申し込み・契約・支払い：許可しない。外部AIがこのポリシーに従うかは保証されません。</p><h2>前回との差分</h2><p>${previous?'指定した前回jobとの比較です。':'初回の生成です。前回jobは指定されていません。'}追加 ${diff.claim_changes.filter(c=>c.kind==='added').length} 件 / 変更 ${diff.claim_changes.filter(c=>c.kind==='changed').length} 件 / 削除 ${diff.claim_changes.filter(c=>c.kind==='removed').length} 件</p>${diffRows?`<table><thead><tr><th>変更項目</th><th>前回</th><th>今回</th></tr></thead><tbody>${diffRows}</tbody></table>`:'<p>公開項目と出典の変更はありません。</p>'}${diff.other_changes.length?`<p>その他の変更：${diff.other_changes.map(c=>esc(fieldLabels[c.field])).join('、')}</p>`:''}<details><summary>差分の詳細を確認する</summary><pre>${esc(stable(diff))}</pre></details><h2>検証結果と確認記録</h2><p>出典からの直接転記、項目の重複、明示されたポリシー、操作権限なし：検証済み。</p><p>確認する版：<code>${candidateHash}</code></p><details><summary>ハッシュと生成器の版を確認する</summary><p>evidence：<code>${evidenceHash}</code><br>生成器：<code>${identity.source_sha256}</code></p><pre>${esc(stable({files:inventory,checks:evidence.checks}))}</pre></details><p><a href="public/public-information.html">公開情報ページのプレビュー</a> / <a href="evidence.json">evidence JSON</a> / <a href="approval-template.json">未承認の確認記録テンプレート</a></p><p>確認後、テンプレートを別ファイルにコピーし、確認者・実際の確認日時・4項目の確認結果を記録してください。このページは承認を自動生成しません。実際のデプロイは別操作です。</p>`);
  const template = {format:'rescap.human-approval.v1',decision:'pending',candidate_sha256:candidateHash,evidence_sha256:evidenceHash,reviewer:{name:'',role:'publisher_or_delegate',kind:'human'},approved_at:null,checks:{source_accuracy:false,publication_scope:false,policy:false,changes:false}};
  return {publicFiles,files:new Map([['job.json',stable(job)],['evidence.json',stable(evidence)],['review.html',review],['approval-template.json',stable(template)],...[...publicFiles].map(([p,v])=>[`public/${p}`,v])]),evidence,evidenceHash,candidateHash};
}
function writeNew(dir, files) {
  need(!existsSync(dir),'output directory already exists; choose a new directory');
  mkdirSync(dir,{recursive:true});
  for (const [path,value] of files) { const p=join(dir,path); mkdirSync(dirname(p),{recursive:true}); writeFileSync(p,value,{flag:'wx'}); }
}
export function prepare(job, out, previous = null) { const result=build(job,previous); writeNew(out,result.files); return result; }
function list(dir, prefix = '') { return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?list(join(dir,e.name),prefix+e.name+'/'):[prefix+e.name]).sort(); }
export function verify(dir) {
  const job=JSON.parse(readFileSync(join(dir,'job.json'),'utf8')), evidence=JSON.parse(readFileSync(join(dir,'evidence.json'),'utf8'));
  const result=build(job,evidence.previous_job);
  need(stable(list(dir))===stable([...result.files.keys()].sort()),'unexpected or missing candidate files');
  for (const [path,value] of result.files) need(readFileSync(join(dir,path),'utf8')===value,`candidate tampered: ${path}`);
  return result;
}
function approvedFiles(result, approval) {
  shape(approval,['format','decision','candidate_sha256','evidence_sha256','reviewer','approved_at','checks'],'approval');
  need(approval.format==='rescap.human-approval.v1' && approval.decision==='approved','explicit approved human declaration required');
  need(approval.candidate_sha256===result.candidateHash && approval.evidence_sha256===result.evidenceHash,'approval belongs to another review/version');
  shape(approval.reviewer,['name','role','kind'],'reviewer'); string(approval.reviewer.name,'reviewer name');
  need(approval.reviewer.kind==='human' && approval.reviewer.role==='publisher_or_delegate','publisher/delegate human declaration required');
  date(approval.approved_at,'approved_at'); need(Date.parse(approval.approved_at)>=Date.parse(result.evidence.job.generated_at),'approval predates generation');
  shape(approval.checks,['source_accuracy','publication_scope','policy','changes'],'checks'); need(Object.values(approval.checks).every(v=>v===true),'all human checks required');
  const files=new Map(result.publicFiles);
  files.set('publication.json',stable({format:'rescap.approved-publication.v1',candidate_sha256:result.candidateHash,evidence_sha256:result.evidenceHash,job_sha256:result.evidence.job_sha256,generator:result.evidence.generator,source_sha256:result.evidence.source_sha256,files:result.evidence.files,approval,proof_type:'declared_human_review_not_verified_identity',owner_identity_cryptographically_verified:false,deployment_performed:false}));
  return files;
}
export function finalize(dir, approval, out) {
  const result=verify(dir); const files=approvedFiles(result,approval);
  writeNew(out,files); return result;
}
export function verifyExport(dir, exported) {
  const result=verify(dir), publication=JSON.parse(readFileSync(join(exported,'publication.json'),'utf8'));
  const files=approvedFiles(result,publication.approval);
  need(stable(list(exported))===stable([...files.keys()].sort()),'unexpected or missing export files');
  for (const [path,value] of files) need(readFileSync(join(exported,path),'utf8')===value,`export tampered: ${path}`);
  return result;
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  (async () => { try {
    const [command,...args]=process.argv.slice(2), read=p=>JSON.parse(readFileSync(p,'utf8')); let result;
    if (command==='prepare' && (args.length===2 || args.length===3)) result=prepare(read(args[0]),args[1],args[2]?read(args[2]):null);
    else if (command==='verify' && args.length===1) { const job=read(join(args[0],'job.json')); result=job.sources.some(s=>s.data?.format==='rescap.html-source.v1')?await (await import('./html-adapter.mjs')).verifyHtml(args[0]):verify(args[0]); }
    else if (command==='finalize' && args.length===3) { const job=read(join(args[0],'job.json')); result=job.sources.some(s=>s.data?.format==='rescap.html-source.v1')?await (await import('./html-adapter.mjs')).finalizeHtml(args[0],read(args[1]),args[2]):finalize(args[0],read(args[1]),args[2]); }
    else if (command==='verify-export' && args.length===2) { const job=read(join(args[0],'job.json')); if(job.sources.some(s=>s.data?.format==='rescap.html-source.v1'))await (await import('./html-adapter.mjs')).verifyHtml(args[0]); result=verifyExport(args[0],args[1]); }
    else throw Error('usage: node generator/index.mjs prepare job.json NEW_REVIEW_DIR [previous-job.json] | verify REVIEW_DIR | finalize REVIEW_DIR human-approval.json NEW_EXPORT_DIR | verify-export REVIEW_DIR EXPORT_DIR');
    console.log(stable({ok:true,command,candidate_sha256:result.candidateHash,evidence_sha256:result.evidenceHash,deployment_performed:false}));
  } catch (error) { console.error(String(error)); process.exitCode=1; } })();
}
