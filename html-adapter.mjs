import { readFileSync, realpathSync } from 'node:fs';
import { resolve, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, stable, validateJob, prepare, verify, finalize } from './index.mjs';

export const FORMAT='rescap.html-adapter-job.v1';
export const SOURCE_FORMAT='rescap.html-source.v1';
const need=(ok,message)=>{if(!ok)throw Error(message);};
const keys=(v,names)=>need(v && typeof v==='object' && !Array.isArray(v) && Object.keys(v).length===names.length && names.every(k=>Object.hasOwn(v,k)),'invalid adapter keys');
const slug=v=>need(typeof v==='string' && /^[a-z0-9][a-z0-9_-]*$/.test(v),'invalid adapter identifier');
const selector=v=>need(typeof v==='string' && v.trim().length>0,'explicit CSS selector required');
const identity=()=>({version:'rescap.html-adapter.phase2.v1',sha256:hash(readFileSync(fileURLToPath(import.meta.url)))});
export function validateMapping(config) {
  keys(config,['format','job_id','generated_at','producer','site','policy','pages','mappings']);need(config.format===FORMAT,'unsupported HTML adapter format');
  need(Array.isArray(config.pages) && config.pages.length>0,'HTML pages required');const ids=new Set();
  for(const p of config.pages){keys(p,['id','url','authored_at','public','path']);slug(p.id);need(!ids.has(p.id),'duplicate page');ids.add(p.id);need(typeof p.path==='string' && !p.path.startsWith('/') && !p.path.includes('\\') && p.path.split('/').every(s=>s && s!=='.' && s!=='..'),'safe relative HTML path required');}
  need(Array.isArray(config.mappings) && config.mappings.length>0,'explicit mappings required');const groups=new Set();
  for(const m of config.mappings){keys(m,['id','page_id','selector','mode','min_matches','claims']);slug(m.id);need(!groups.has(m.id),'duplicate mapping');groups.add(m.id);need(ids.has(m.page_id),'mapping page missing');selector(m.selector);
    need(['one','each'].includes(m.mode) && Number.isInteger(m.min_matches) && m.min_matches>0 && (m.mode!=='one' || m.min_matches===1),'invalid cardinality');
    need(Array.isArray(m.claims) && m.claims.length>0,'mapping claims required');const claims=new Set();
    for(const c of m.claims){keys(c,['id','label','selector','exclude_selectors','disclosure']);slug(c.id);need(!claims.has(c.id),'duplicate mapping claim');claims.add(c.id);need(typeof c.label==='string' && c.label.trim(),'claim label required');selector(c.selector);need(Array.isArray(c.exclude_selectors),'explicit exclusions required');c.exclude_selectors.forEach(selector);if(c.disclosure!==null){keys(c.disclosure,['container_selector','trigger_selector']);selector(c.disclosure.container_selector);selector(c.disclosure.trigger_selector);}}
  }
  for(const p of config.pages)need(config.mappings.some(m=>m.page_id===p.id),'page has no extraction mapping');
  validateJob({format:'rescap.generation-job.v1',job_id:config.job_id,generated_at:config.generated_at,producer:config.producer,site:config.site,policy:config.policy,sources:config.pages.map(p=>({id:p.id,url:p.url,authored_at:p.authored_at,public:p.public,data:{placeholder:'validation only'}})),claims:[{id:'placeholder',label:'validation',source_id:config.pages[0].id,pointer:'/placeholder'}]});
  return config;
}
export function readPages(config, root) {
  validateMapping(config);const base=realpathSync(root);
  return Object.fromEntries(config.pages.map(p=>{const path=realpathSync(resolve(base,p.path));need(path.startsWith(base+sep),'HTML path escaped root');const bytes=readFileSync(path);const html=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);return[p.id,html];}));
}
export async function extract(config, documents) {
  validateMapping(config);need(stable(Object.keys(documents).sort())===stable(config.pages.map(p=>p.id).sort()),'source document inventory differs');
  for(const html of Object.values(documents))need(typeof html==='string' && html.length>0,'non-empty static HTML required');
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');const browser=await chromium.launch({headless:true});
  try{
    const context=await browser.newContext({javaScriptEnabled:false,offline:true,serviceWorkers:'block',acceptDownloads:false});
    await context.route('**/*',route=>route.abort());const page=await context.newPage();
    const sources=[],claims=[],engine=browser.version(),adapter=identity(),configHash=hash(stable(config));
    for(const p of config.pages){const html=documents[p.id],mappings=config.mappings.filter(m=>m.page_id===p.id);
      const bindings=await page.evaluate(({html,mappings,pageId})=>{
        const doc=new DOMParser().parseFromString(html,'text/html'),result=[];
        const require=(ok,message)=>{if(!ok)throw Error(message);};
        const hidden=(node,allowed)=>[...function*(n){while(n){yield n;n=n.parentElement;}}(node)].some(n=>n.matches('script,style,template,noscript') || (n!==allowed && (n.matches('[hidden],[aria-hidden="true"]') || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(n.getAttribute('style')??''))));
        for(const m of mappings){const groups=[...doc.querySelectorAll(m.selector)];require(groups.length>=m.min_matches && (m.mode!=='one' || groups.length===1),`group cardinality failed: ${m.id} (${groups.length})`);
          for(let n=0;n<groups.length;n++){const group=groups[n];for(const c of m.claims){
            const nodes=c.selector===':scope'?[group]:[...group.querySelectorAll(c.selector)];require(nodes.length===1,`claim cardinality failed: ${c.id} (${nodes.length})`);
            const node=nodes[0];let allowed=null,disclosure=null;
            if(c.disclosure){const containers=[...group.querySelectorAll(c.disclosure.container_selector)],triggers=[...group.querySelectorAll(c.disclosure.trigger_selector)];require(containers.length===1 && triggers.length===1,'disclosure cardinality failed');allowed=containers[0];const trigger=triggers[0],related=(allowed.id && trigger.getAttribute('aria-controls')===allowed.id) || trigger.nextElementSibling===allowed;require(related && allowed.contains(node) && (trigger.tagName==='BUTTON' || trigger.getAttribute('role')==='button') && ['true','false'].includes(trigger.getAttribute('aria-expanded')),'invalid declared disclosure');disclosure={...c.disclosure,trigger_expanded:trigger.getAttribute('aria-expanded'),container_hidden:allowed.getAttribute('aria-hidden'),relationship:allowed.id && trigger.getAttribute('aria-controls')===allowed.id?'aria_controls':'next_sibling'};}
            require(!hidden(node,allowed),'selected source is hidden or executable');const clone=node.cloneNode(true),excluded=[];
            for(const e of c.exclude_selectors){const matches=[...clone.querySelectorAll(e)];require(matches.length>0,`declared exclusion missing: ${e}`);excluded.push({selector:e,count:matches.length,text:matches.map(n=>n.textContent)});matches.forEach(n=>n.remove());}
            clone.querySelectorAll('script,style,template,noscript,[hidden],[aria-hidden="true"]').forEach(n=>n.remove());
            clone.querySelectorAll('[style]').forEach(n=>{if(/display\s*:\s*none|visibility\s*:\s*hidden/i.test(n.getAttribute('style')??''))n.remove();});
            clone.querySelectorAll('br').forEach(n=>n.replaceWith(doc.createTextNode(' ')));
            const text=(clone.textContent??'').replace(/\s+/g,' ').trim();require(text.length>0,'empty static claim');
            const id=`${pageId}-${m.id}${m.mode==='each'?'-'+n:''}-${c.id}`;
            result.push({id,label:m.mode==='each'?`${c.label} ${n+1}`:c.label,group_selector:m.selector,group_index:n,group_count:groups.length,selector:c.selector,exclude_selectors:c.exclude_selectors,disclosure,excluded,text,original_outer_html:node.outerHTML});
          }}
        }return result;
      },{html,mappings,pageId:p.id});
      const data={format:SOURCE_FORMAT,html,html_sha256:hash(html),configuration:config,configuration_sha256:configHash,adapter,browser_engine_version:engine,text_basis:'static_DOM_textContent_with_declared_exclusions_and_whitespace_collapse',bindings,values:Object.fromEntries(bindings.map(b=>[b.id,b.text]))};
      sources.push({id:p.id,url:p.url,authored_at:p.authored_at,public:p.public,data});claims.push(...bindings.map(b=>({id:b.id,label:b.label,source_id:p.id,pointer:'/values/'+b.id})));
    }
    await context.close();return validateJob({format:'rescap.generation-job.v1',job_id:config.job_id,generated_at:config.generated_at,producer:config.producer,site:config.site,policy:config.policy,sources,claims});
  }finally{await browser.close();}
}
export const hasHtmlSources=job=>job.sources.some(s=>s.data?.format===SOURCE_FORMAT);
export async function verifyHtml(dir) {
  const result=verify(dir),job=result.evidence.job;need(job.sources.every(s=>s.data.format===SOURCE_FORMAT),'HTML source inventory required');
  const config=job.sources[0].data.configuration,documents=Object.fromEntries(job.sources.map(s=>[s.id,s.data.html]));
  for(const s of job.sources){need(stable(s.data.configuration)===stable(config),'mixed HTML extraction configuration');need(s.data.html_sha256===hash(s.data.html),'HTML source hash mismatch');}
  const regenerated=await extract(config,documents);need(stable(regenerated)===stable(job),'HTML re-extraction differs; regenerate and obtain new human approval');return result;
}
export async function finalizeHtml(dir, approval, out) {await verifyHtml(dir);return finalize(dir,approval,out);}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try{const [command,...args]=process.argv.slice(2),read=p=>JSON.parse(readFileSync(p,'utf8'));let result;
    if(command==='prepare' && (args.length===3 || args.length===4)){const config=read(args[0]),job=await extract(config,readPages(config,args[1]));result=prepare(job,args[2],args[3]?read(args[3]):null);}
    else if(command==='verify' && args.length===1)result=await verifyHtml(args[0]);
    else if(command==='finalize' && args.length===3)result=await finalizeHtml(args[0],read(args[1]),args[2]);
    else throw Error('usage: node generator/html-adapter.mjs prepare mapping.json SOURCE_ROOT NEW_REVIEW_DIR [previous-job.json] | verify REVIEW_DIR | finalize REVIEW_DIR human-approval.json NEW_EXPORT_DIR');
    console.log(stable({ok:true,command,source_verification:'HTML_reextracted',candidate_sha256:result.candidateHash,evidence_sha256:result.evidenceHash,deployment_performed:false}));
  }catch(error){console.error(String(error));process.exitCode=1;}
}
