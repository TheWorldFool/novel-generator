'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'backup.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let attempt = 0; attempt < 50 && !predicate(); attempt++) await tick();
  assert.ok(predicate(), 'expected the operation to reach its next boundary');
}
const preview = title => ({title,chapter_count:2,entity_count:3,image_count:1,
  version_count:7,approved_count:1,format:'story-workbench-v2'});
const file = (title='备份书名', options={}) => ({name:title+'.json',size:100,
  async text(){return JSON.stringify({format:'story-workbench-v2',project:{title}});},...options});

// Run the shipped listeners with controlled File.text / API promises. The tests
// exercise selection, preflight and explicit adoption as separate user actions.
function harness({android=false}={}) {
  const listeners={}, nodes={}, calls=[], notices=[], dialogs=[];
  let rendered=0, saved=0, importSequence=0;
  const dialog=nodes['#dialog']={open:false,close(){this.open=false;}};
  const context={console,Number,JSON,Error,Promise,
    crypto:{randomUUID(){return `00000000-0000-4000-8000-${String(++importSequence).padStart(12,'0')}`;}},
    navigator:{userAgent:android?'NovelGeneratorAndroid/0.2.3':'Desktop'},
    setTimeout(){return 1;},clearTimeout(){},
    state:{project:{id:'original',title:'当前作品',revision:3,chapters:[{id:'old-chapter'}]},
      projects:[{id:'original',title:'当前作品'}],view:'settings',dirty:false,busy:false},
    document:{documentElement:{classList:{add(){}}},
      addEventListener(type,listener){(listeners[type]||=[]).push(listener);},createElement(){return {}; }},
    $(selector){return nodes[selector] ?? null;},
    esc(value){return String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));},
    showDialog(html){
      dialogs.push(html);dialog.open=true;
      nodes['#backup-import-panel']={dataset:{session:html.match(/data-session="([^"]+)"/)[1]}};
      for(const id of ['backup-import-status','backup-import-file','backup-import-confirm','backup-import-retry','backup-import-cancel']) {
        nodes['#'+id]={id,disabled:false,hidden:false,innerHTML:''};
      }
    },
    toast(message,error=false){notices.push({message,error});},
    render(){rendered++;},
    async saveCurrent(){saved++;if(context.save)await context.save();context.state.dirty=false;},
    accept(result){context.state.project=result.project;context.state.dirty=false;},
    async api(url,body,headers){
      calls.push({url,body,headers});
      if(context.request)return context.request(url,body,headers);
      if(url.endsWith('/preview'))return {preview:preview(body.project.title)};
      if(url.endsWith('/import'))return {project:{id:'restored',title:body.project.title,revision:1,chapters:[{id:'restored-chapter'}]},canon:[]};
      return {projects:[{id:'restored',title:'备份书名'},{id:'original',title:'当前作品'}]};
    },
    run(fn){
      if(context.state.busy)return;
      context.state.busy=true;
      context.pending=Promise.resolve().then(fn).finally(()=>{context.state.busy=false;});
    },
  };
  context.window=context;
  vm.createContext(context);vm.runInContext(source,context,{filename:'backup.js'});
  if(android) vm.runInContext(fs.readFileSync(path.join(__dirname,'..','static','mobile.js'),'utf8'),context,{filename:'mobile.js'});
  const dispatch=(type,event)=>{for(const listener of listeners[type]||[])listener(event);};
  function click(action){
    const button={dataset:{action}};
    dispatch('click',{target:{closest(){return button;}},preventDefault(){}});
    return context.pending||Promise.resolve();
  }
  function choose(selected){dispatch('change',{target:{id:'backup-import-file',files:[selected]}});}
  const status=()=>nodes['#backup-import-status'].innerHTML;
  return {context,nodes,calls,notices,dialogs,dialog,click,choose,dispatch,status,
    get rendered(){return rendered;},get saved(){return saved;}};
}

test('file selection only preflights; explicit restore saves current work and opens the new project',async()=>{
  const h=harness();await h.click('backup-import');
  h.choose(file());await until(()=>h.calls.length===1 && !h.nodes['#backup-import-confirm'].disabled);
  assert.deepEqual(h.calls.map(call=>call.url),['/api/backups/preview']);
  assert.match(h.status(),/备份书名/);assert.match(h.status(),/2 章/);
  assert.match(h.status(),/3 份档案/);assert.match(h.status(),/1 张参考图片/);assert.match(h.status(),/7 条历史版本/);
  assert.equal(h.context.state.project.id,'original');assert.equal(h.saved,0);
  await h.click('backup-confirm-import');
  assert.equal(h.saved,1);assert.equal(h.calls[1].url,'/api/backups/import');
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[1].body)),{format:'story-workbench-v2',project:{title:'备份书名'}});
  assert.equal(h.context.state.project.id,'restored');
  assert.equal(h.context.state.chapterId,'restored-chapter');assert.equal(h.context.state.view,'write');
  assert.ok(h.context.state.projects.some(project=>project.id==='original'));
  assert.equal(h.dialog.open,false);assert.equal(h.rendered,1);
});

test('malformed JSON gives a fixed error without exposing the source text',async()=>{
  const h=harness();await h.click('backup-import');
  h.choose(file('损坏文件',{async text(){return '{"private":"PRIVATE_DRAFT_FRAGMENT"';}}));
  await until(()=>h.status().includes('无法读取'));
  assert.equal(h.calls.length,0);assert.doesNotMatch(h.status(),/PRIVATE_DRAFT_FRAGMENT/);
  assert.equal(h.nodes['#backup-import-confirm'].disabled,true);
});

test('oversize files are rejected before reading and clear an earlier accepted preview',async()=>{
  const h=harness();await h.click('backup-import');h.choose(file());
  await until(()=>!h.nodes['#backup-import-confirm'].disabled);
  let reads=0;h.choose(file('过大',{size:80000001,async text(){reads++;return '{}';}}));await tick();
  assert.equal(reads,0);assert.equal(h.calls.length,1);
  assert.match(h.status(),/超过 80 MB/);assert.equal(h.nodes['#backup-import-confirm'].disabled,true);
  await h.click('backup-confirm-import');assert.equal(h.calls.length,1);
});

test('preflight failure retains the parsed file for retry without exposing API error details',async()=>{
  const h=harness();await h.click('backup-import');
  let fails=true;
  h.context.request=async(url,body)=>{if(fails)throw new Error('PRIVATE_DRAFT_FRAGMENT');return {preview:preview(body.project.title)};};
  h.choose(file());await until(()=>h.status().includes('暂时无法通过检查'));
  assert.doesNotMatch(h.status(),/PRIVATE_DRAFT_FRAGMENT/);assert.equal(h.nodes['#backup-import-retry'].hidden,false);
  fails=false;await h.click('backup-preview-retry');await until(()=>!h.nodes['#backup-import-confirm'].disabled);
  assert.equal(h.calls.length,2);assert.equal(h.calls[1].body.project.title,'备份书名');
});

test('the latest selected file wins when an older File.text completes later',async()=>{
  const h=harness();await h.click('backup-import');let finish;
  h.choose(file('旧文件',{text(){return new Promise(resolve=>{finish=resolve;});}}));
  h.choose(file('新文件'));await until(()=>!h.nodes['#backup-import-confirm'].disabled);
  finish(JSON.stringify({project:{title:'旧文件'}}));await tick();
  assert.deepEqual(h.calls.map(call=>call.body.project.title),['新文件']);
  await h.click('backup-confirm-import');assert.equal(h.calls[1].body.project.title,'新文件');
});

test('an older server preview cannot replace the latest selected file',async()=>{
  const h=harness();await h.click('backup-import');let finish;
  h.context.request=async(url,body)=>{
    if(body.project.title==='旧文件')return new Promise(resolve=>{finish=resolve;});
    return {preview:preview(body.project.title)};
  };
  h.choose(file('旧文件'));await until(()=>!!finish);
  h.choose(file('新文件'));await until(()=>h.status().includes('<strong>新文件</strong>'));
  finish({preview:preview('旧文件')});await tick();
  assert.match(h.status(),/<strong>新文件<\/strong>/);assert.doesNotMatch(h.status(),/旧文件/);
});

test('closing a pending preflight never reopens the modal or attaches its result to a new session',async()=>{
  const h=harness();await h.click('backup-import');let finish;
  h.context.request=()=>new Promise(resolve=>{finish=resolve;});
  h.choose(file('旧会话'));await until(()=>!!finish);
  await h.click('backup-cancel-import');assert.equal(h.dialog.open,false);
  const count=h.dialogs.length;
  finish({preview:preview('旧会话')});await tick();
  assert.equal(h.dialogs.length,count);assert.equal(h.dialog.open,false);
  await h.click('backup-import');
  assert.doesNotMatch(h.status(),/旧会话/);assert.equal(h.nodes['#backup-import-confirm'].disabled,true);
});

test('failed import preserves the selected backup and preview for another explicit retry',async()=>{
  const h=harness();await h.click('backup-import');h.choose(file());
  await until(()=>!h.nodes['#backup-import-confirm'].disabled);
  let fail=true;
  h.context.request=async(url,body)=>{
    if(url.endsWith('/import') && fail)throw new Error('PRIVATE_DRAFT_FRAGMENT');
    if(url.endsWith('/import'))return {project:{id:'restored',title:body.project.title,chapters:[{id:'new'}]},canon:[]};
    return {projects:[{id:'original'},{id:'restored'}]};
  };
  await h.click('backup-confirm-import');
  assert.equal(h.context.state.project.id,'original');assert.equal(h.dialog.open,true);
  assert.match(h.status(),/文件和预览已保留/);assert.doesNotMatch(h.status(),/PRIVATE_DRAFT_FRAGMENT/);
  assert.match(h.status(),/备份书名/);assert.equal(h.nodes['#backup-import-confirm'].disabled,false);
  fail=false;await h.click('backup-confirm-import');assert.equal(h.context.state.project.id,'restored');
  assert.equal(h.calls.filter(call=>call.url.endsWith('/import')).length,2);
});

test('a lost import response reuses its key after closing and retrying; selecting a new file gets a new key',async()=>{
  const h=harness();await h.click('backup-import');h.choose(file());
  await until(()=>!h.nodes['#backup-import-confirm'].disabled);
  const committed=new Map();let creations=0, lost=true;
  h.context.request=async(url,body,headers)=>{
    if(url.endsWith('/preview'))return {preview:preview(body.project.title)};
    if(url.endsWith('/import')) {
      const key=headers['Idempotency-Key'];
      if(!committed.has(key))committed.set(key,{project:{id:`restored-${++creations}`,title:body.project.title,chapters:[{id:'new'}]},canon:[]});
      if(lost){lost=false;throw new Error('response lost after commit');}
      return committed.get(key);
    }
    return {projects:[{id:'original'},...Array.from(committed.values(),value=>({id:value.project.id}))]};
  };
  await h.click('backup-confirm-import');
  const first=h.calls.find(call=>call.url.endsWith('/import'));
  assert.match(first.headers['Idempotency-Key'],/^[0-9a-f-]{36}$/);
  assert.equal(creations,1);assert.equal(h.context.state.project.id,'original');
  await h.click('backup-cancel-import');await h.click('backup-import');
  await h.click('backup-confirm-import');
  const retries=h.calls.filter(call=>call.url.endsWith('/import'));
  assert.equal(retries[0].headers['Idempotency-Key'],retries[1].headers['Idempotency-Key']);
  assert.equal(creations,1);assert.equal(h.context.state.project.id,'restored-1');
  assert.equal(h.calls.find(call=>call.url.endsWith('/preview')).headers,undefined);
  await h.click('backup-import');h.choose(file());
  await until(()=>!h.nodes['#backup-import-confirm'].disabled);
  await h.click('backup-confirm-import');
  const last=h.calls.filter(call=>call.url.endsWith('/import')).at(-1);
  assert.notEqual(last.headers['Idempotency-Key'],first.headers['Idempotency-Key']);
  assert.equal(creations,2);
});

test('older WebViews use secure getRandomValues when randomUUID is unavailable',async()=>{
  const h=harness();h.context.crypto={getRandomValues(bytes){bytes.fill(171);return bytes;}};
  await h.click('backup-import');h.choose(file());await until(()=>!h.nodes['#backup-import-confirm'].disabled);
  await h.click('backup-confirm-import');
  const key=h.calls.find(call=>call.url.endsWith('/import')).headers['Idempotency-Key'];
  assert.equal(key,'abababab-abab-4bab-abab-abababababab');
});

test('busy import prevents duplicate adoption, new selection, cancel and Escape',async()=>{
  const h=harness();await h.click('backup-import');h.choose(file());
  await until(()=>!h.nodes['#backup-import-confirm'].disabled);
  let finish;h.context.request=()=>new Promise(resolve=>{finish=resolve;});
  const pending=h.click('backup-confirm-import');await until(()=>!!finish);
  assert.equal(h.context.backupImportBusy(),true);
  h.click('backup-confirm-import');h.click('backup-cancel-import');h.choose(file('误选文件'));
  let prevented=false;h.dispatch('cancel',{target:h.dialog,preventDefault(){prevented=true;}});
  assert.equal(prevented,true);assert.equal(h.dialog.open,true);
  assert.equal(h.nodes['#backup-import-file'].disabled,true);
  assert.equal(h.calls.filter(call=>call.url.endsWith('/import')).length,1);
  h.context.request=async()=>({projects:[{id:'original'},{id:'restored'}]});
  finish({project:{id:'restored',title:'备份书名',chapters:[{id:'new'}]},canon:[]});await pending;
  assert.equal(h.context.state.project.title,'备份书名');
  assert.equal(h.context.backupImportBusy(),false);
});

test('saving current work must succeed and the dialog must still be open before importing',async()=>{
  const h=harness();await h.click('backup-import');h.choose(file());
  await until(()=>!h.nodes['#backup-import-confirm'].disabled);
  h.context.save=async()=>{throw new Error('PRIVATE_DRAFT_FRAGMENT');};
  await h.click('backup-confirm-import');
  assert.equal(h.calls.length,1);assert.match(h.status(),/未开始恢复/);
  assert.doesNotMatch(h.status(),/PRIVATE_DRAFT_FRAGMENT/);
  let finish;h.context.save=()=>new Promise(resolve=>{finish=resolve;});
  const pending=h.click('backup-confirm-import');await until(()=>!!finish);
  h.dialog.close();finish();await pending;
  assert.equal(h.calls.length,1);assert.equal(h.context.state.project.id,'original');
});

test('a list refresh failure after successful creation uses a local entry and cannot duplicate the restore',async()=>{
  const h=harness();await h.click('backup-import');h.choose(file());
  await until(()=>!h.nodes['#backup-import-confirm'].disabled);
  h.context.request=async(url)=>{
    if(url.endsWith('/import'))return {project:{id:'restored',title:'备份书名',chapters:[{id:'new'}]},canon:[]};
    throw new Error('list unavailable');
  };
  await h.click('backup-confirm-import');
  assert.equal(h.context.state.project.id,'restored');assert.equal(h.context.state.projects[0].id,'restored');
  assert.equal(h.notices.at(-1).error,false);assert.equal(h.dialog.open,false);
  await h.click('backup-import');await h.click('backup-confirm-import');
  assert.equal(h.calls.filter(call=>call.url.endsWith('/import')).length,1);
});

test('backup module ignores unrelated app actions',async()=>{
  const h=harness();await h.click('edit-entity');await h.click('backup');
  assert.equal(h.dialogs.length,0);assert.equal(h.calls.length,0);
});

test('Android back keeps a real backup restore open until it finishes, then exits normally',async()=>{
  const h=harness({android:true});await h.click('backup-import');h.choose(file());
  await until(()=>!h.nodes['#backup-import-confirm'].disabled);
  let finish;
  h.context.request=()=>new Promise(resolve=>{finish=resolve;});
  const pending=h.click('backup-confirm-import');await until(()=>!!finish);
  assert.equal(h.context.mobileBack(),'stay');
  assert.equal(h.dialog.open,true);
  assert.match(h.notices.at(-1).message,/正在恢复作品/);
  assert.equal(h.calls.filter(call=>call.url.endsWith('/import')).length,1);
  h.context.request=async()=>({projects:[{id:'original'},{id:'restored'}]});
  finish({project:{id:'restored',title:'备份书名',chapters:[{id:'new'}]},canon:[]});
  await pending;
  assert.equal(h.context.mobileBack(),'exit');
  assert.equal(h.dialog.open,false);
});

test('Android back can close an idle or failed backup dialog and late preflight never reopens it',async()=>{
  const h=harness({android:true});await h.click('backup-import');
  let finish;h.context.request=()=>new Promise(resolve=>{finish=resolve;});
  h.choose(file());await until(()=>!!finish);
  assert.equal(h.context.mobileBack(),'stay');assert.equal(h.dialog.open,false);
  finish({preview:preview('迟到的结果')});await tick();
  assert.equal(h.dialog.open,false);assert.equal(h.context.backupImportBusy(),false);
  h.context.request=undefined;
  await h.click('backup-import');h.choose(file());await until(()=>!h.nodes['#backup-import-confirm'].disabled);
  h.context.request=async()=>{throw new Error('import failed');};
  await h.click('backup-confirm-import');
  assert.equal(h.context.backupImportBusy(),false);
  assert.equal(h.context.mobileBack(),'stay');assert.equal(h.dialog.open,false);
  await h.click('backup-import');
  assert.match(h.status(),/备份书名/);assert.equal(h.nodes['#backup-import-confirm'].disabled,false);
});

test('real app render and click listeners expose the import entry and route an explicit restore once',async()=>{
  const appSource=fs.readFileSync(path.join(__dirname,'..','static','app.js'),'utf8').replace(/\binit\(\);\s*$/,'');
  const listeners={}, nodes={}, calls=[];
  let exportRows=0, busyCalls=0;
  const dialog=nodes['#dialog']={open:false,showModal(){this.open=true;},close(){this.open=false;},
    set innerHTML(html){
      this.html=html;
      const match=html.match(/id="backup-import-panel" data-session="([^"]+)"/);
      if(!match)return;
      nodes['#backup-import-panel']={dataset:{session:match[1]}};
      for(const id of ['backup-import-status','backup-import-file','backup-import-confirm','backup-import-retry','backup-import-cancel']) {
        nodes['#'+id]={id,innerHTML:'',disabled:false,hidden:false};
      }
    }};
  nodes['#toast']={};
  nodes['#app']={inert:false,set innerHTML(html){
    this.html=html;
    delete nodes['#backup-import-button'];
    nodes['[data-action="backup"]']=html.includes('data-action="backup"')?{after(row){
      exportRows++;assert.match(row.innerHTML,/data-action="backup-import"/);
      nodes['#backup-import-button']={};
    }}:null;
  }};
  const restored={id:'restored',title:'恢复作品',revision:1,chapters:[{id:'new-chapter',title:'第一章',text:'正文',status:'draft'}]};
  const context={console,Number,JSON,Error,Promise,
    crypto:{randomUUID(){return '11111111-1111-4111-8111-111111111111';}},
    navigator:{userAgent:'Desktop'},
    document:{
      querySelector(selector){return nodes[selector]??null;},querySelectorAll(){return [];},
      addEventListener(type,listener){(listeners[type]||=[]).push(listener);},
      body:{classList:{toggle(name,enabled){if(enabled)busyCalls++;}},appendChild(node){nodes['#'+node.id]=node;}},
      createElement(){return {setAttribute(){},remove(){delete nodes['#'+this.id];}};},
    },
    addEventListener(){},setTimeout(){return 0;},clearTimeout(){},
    decorateReferenceEntries(){},decorateOutlineEntries(){},renderBookOutline(){return '';},renderReferences(){return '';},
    async fetch(url,options){
      const body=options?.body?JSON.parse(options.body):undefined;calls.push({url,body,headers:options?.headers});
      const result=url.endsWith('/preview')?{preview:preview('恢复作品')}:
        url.endsWith('/import')?{project:restored,canon:[]}:{projects:[{id:'restored',title:'恢复作品'},{id:'original',title:'当前作品'}]};
      return {ok:true,async json(){return result;}};
    },
  };
  context.window=context;
  vm.createContext(context);vm.runInContext(source,context,{filename:'backup.js'});
  vm.runInContext(appSource,context,{filename:'app.js'});
  vm.runInContext(`state.project={id:'original',title:'当前作品',revision:2,chapters:[{id:'old',title:'旧章',status:'draft',text:'旧正文'}]};
    state.projects=[{id:'original',title:'当前作品'}];state.view='settings';state.chapterId='old';
    renderWrite=()=>'<p>正文编辑</p>';render();`,context);
  assert.equal(exportRows,1);
  const click=action=>{for(const listener of listeners.click||[])listener({target:{closest(){return {dataset:{action}};}},preventDefault(){}});};
  click('backup-import');
  assert.equal(dialog.open,true);assert.equal(busyCalls,0,'the main listener must ignore the module action');
  const selected=file('恢复作品');
  for(const listener of listeners.change||[])listener({target:{id:'backup-import-file',files:[selected]}});
  await until(()=>!nodes['#backup-import-confirm'].disabled);
  click('backup-confirm-import');
  await until(()=>vm.runInContext('state.project.id',context)==='restored' && !vm.runInContext('state.busy',context));
  assert.equal(calls.filter(call=>call.url.endsWith('/import')).length,1);
  assert.equal(calls.find(call=>call.url.endsWith('/import')).headers['Idempotency-Key'],'11111111-1111-4111-8111-111111111111');
  assert.equal(calls.find(call=>call.url.endsWith('/import')).headers['Content-Type'],'application/json');
  assert.equal(calls.find(call=>call.url.endsWith('/preview')).headers['Idempotency-Key'],undefined);
  assert.equal(vm.runInContext('state.chapterId',context),'new-chapter');
  assert.equal(vm.runInContext('state.view',context),'write');
  assert.equal(dialog.open,false);assert.equal(nodes['#app'].inert,false);
});
