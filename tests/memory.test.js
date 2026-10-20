'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'..','static','memory.js'),'utf8');
const appSource=fs.readFileSync(path.join(__dirname,'..','static','app.js'),'utf8').replace(/\binit\(\);\s*$/,'');
const revisionsSource=fs.readFileSync(path.join(__dirname,'..','static','revisions.js'),'utf8');
const clone=value=>structuredClone(value);
const decode=text=>text.replace(/&(amp|lt|gt|quot|#39);/g,(_,key)=>({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"}[key]));
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function preview(manual=false){
  const original={summary:'原来的摘要',changes:[{id:'old-1',entity_id:'person-1',field:'location',value:'在旧街',evidence:'他走进旧街。',selected:true}]};
  return {kind:'memory',chapter_id:'chapter-1',source_revision:3,source_hash:'source-body-and-context',manual,original,warnings:[],
    summary:manual?original.summary:'从正文提取的新摘要',changes:[{id:'candidate-1',entity_id:'person-1',field:'location',value:'在旧街',evidence:'他走进旧街。',selected:manual}]};
}

function harness(storage=new Map(),withApp=false){
  const nodes={},listeners={},calls=[],writes=[],errors=[],messages=[],dialogs=[];
  const dialog=nodes['#dialog']={id:'dialog',open:false,close(){this.open=false;dispatch('close',{type:'close',target:this});}};
  const context={console,Map,Error,Promise,structuredClone,
    state:{busy:false,dirty:false,view:'write',sideTab:'changes',settings:{base_url:'https://model.invalid/v1',model:'configured'},
      project:{id:'book-1',revision:3,entities:[{id:'person-1',name:'沈砚',kind:'character',locked:false},{id:'thread-1',name:'旧信',kind:'thread',locked:false}],
        chapters:[{id:'chapter-1',text:'他走进旧街。她接过旧信。',summary:'原来的摘要',changes:clone(preview().original.changes),status:'draft'}]},
      fields:{character:{location:'所在位置',goal:'当前目标'},thread:{status:'状态',detail:'细节'}}},
    document:{addEventListener(type,fn){(listeners[type]||=[]).push(fn);},querySelector(selector){return nodes[selector] || null;},querySelectorAll(selector){return selector==='.memory-resume'?Object.values(nodes).filter(node=>node.isResume):[];}},
    addEventListener(){},
    FormData(){throw new Error('The root submit listener must not handle the memory form.');},
    $(selector){return nodes[selector]||null;},current(){return context.state.project.chapters[0];},
    esc(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));},
    showDialog(html){
      dialogs.push(html);dialog.open=true;
      for(const key of Object.keys(nodes))if(key.startsWith('#memory-')&&!key.startsWith('#memory-entries'))delete nodes[key];
      const form=html.match(/<form id="memory-form" data-session="([^"]+)"/);
      if(form){const submit={disabled:/type="submit"[^>]*disabled/.test(html)};
        nodes['#memory-form']={id:'memory-form',dataset:{session:form[1]},querySelector(){return submit;},insertAdjacentHTML(position,html){dialogs[dialogs.length-1]+=html;}};
      }
      const pending=html.match(/id="memory-pending" data-session="([^"]+)"/);
      if(pending)nodes['#memory-pending']={id:'memory-pending',dataset:{session:pending[1]}};
      for(const match of html.matchAll(/<textarea id="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g))addNode(match[1],decode(match[2]));
      for(const match of html.matchAll(/<input([^>]+)>/g)){
        const id=match[1].match(/id="([^"]+)"/)?.[1];if(!id)continue;
        const node=addNode(id,'');node.checked=/\schecked(?:\s|$)/.test(match[1]);
      }
      for(const match of html.matchAll(/<select id="([^"]+)"([^>]*)>([\s\S]*?)<\/select>/g)){
        const options=[...match[3].matchAll(/<option value="([^"]*)"([^>]*)>/g)];
        const selected=options.find(option=>option[2].includes('selected')) || options[0];
        const node=addNode(match[1],decode(selected?.[1]||''));
        const index=match[2].match(/data-memory-entity="([^"]+)"/)?.[1];if(index!==undefined)node.dataset.memoryEntity=index;
      }
    },
    toast(message,error){(error?errors:messages).push(message);},render(){context.renders=(context.renders||0)+1;},
    accept(result){context.state.project=result.project;context.state.dirty=false;},
    async saveCurrent(){context.saves=(context.saves||0)+1;context.state.dirty=false;},
    async api(url,body){calls.push({url,body:clone(body)});if(context.request)return context.request(url,body);
      return url.endsWith('/memory-preview')?{memory:context.nextPreview || preview(body.manual)}:updated(body);},
    run(fn){if(context.state.busy)return;context.runs=(context.runs||0)+1;if(!withApp)context.state.busy=true;context.pending=Promise.resolve().then(fn).catch(error=>errors.push(error.message)).finally(()=>{context.state.busy=false;});return context.pending;},
    workDrafts:{
      async read(key,pid){return clone(storage.get(`${pid}:${key}`)||null);},
      async write(key,payload,pid){writes.push({key,pid,payload:clone(payload)});if(context.writeError)throw new Error(context.writeError);storage.set(`${pid}:${key}`,clone(payload));if(context.writeRequest)await context.writeRequest(key,payload,pid);},
      async remove(key,pid){if(context.removeError)throw new Error(context.removeError);if(context.removeRequest)await context.removeRequest(key,pid);storage.delete(`${pid}:${key}`);},
    },
  };
  function addNode(id,value){return nodes['#'+id]={id,value,dataset:{},closest(selector){return selector==='#memory-form'?nodes['#memory-form']:selector==='#dialog'?dialog:null;}};}
  function mountEntries(){
    const insert=(position,html)=>{for(const match of html.matchAll(/id="(memory-entries-[^"]+)"/g))nodes['#'+match[1]]={};
      const count=Object.values(nodes).filter(node=>node.isResume).length;nodes['#resume-'+count]={hidden:true,isResume:true};};
    nodes['#chapter-summary']={insertAdjacentHTML:insert};nodes['.context-body']={insertAdjacentHTML:insert};
  }
  function updated(body){const project=clone(context.state.project);project.revision++;
    project.chapters[0].summary=body.data.summary;project.chapters[0].changes=clone(body.data.changes);return {project,canon:[]};}
  context.window=context;vm.createContext(context);vm.runInContext(source,context,{filename:'memory.js'});
  if(withApp){
    const intendedState=context.state;
    const helpers=Object.fromEntries(['showDialog','run','api','toast','render','saveCurrent','accept'].map(key=>[key,context[key]]));
    vm.runInContext(revisionsSource,context,{filename:'revisions.js'});
    vm.runInContext(appSource,context,{filename:'app.js'});
    vm.runInContext('globalThis.actualWorkbenchState=state;',context);
    Object.assign(context.actualWorkbenchState,intendedState);context.state=context.actualWorkbenchState;
    Object.assign(context,helpers);
  }
  function dispatch(type,event){for(const fn of listeners[type]||[])fn(event);}
  function click(action,extra={}){dispatch('click',{target:{closest(){return {dataset:{action,...extra}};}},preventDefault(){}});return context.pending||Promise.resolve();}
  function input(id,value,type='input'){const node=nodes['#'+id];node.value=value;dispatch(type,{target:node});}
  function submit(){dispatch('submit',{target:nodes['#memory-form'],preventDefault(){}});return context.pending||Promise.resolve();}
  return {context,nodes,dialog,calls,writes,errors,messages,dialogs,storage,updated,click,input,submit,dispatch,mountEntries};
}

test('AI memory entry previews without replacing prose, old summary or candidates',async()=>{
  const h=harness(),before=clone(h.context.state.project);await h.click('memory-generate');
  assert.equal(h.calls[0].url,'/api/projects/book-1/memory-preview');assert.equal(h.calls[0].body.manual,false);
  assert.deepEqual(h.context.state.project,before);assert.match(h.dialogs.at(-1),/原来的摘要/);assert.match(h.dialogs.at(-1),/从正文提取的新摘要/);
  assert.equal(h.nodes['#memory-0-selected'].checked,false);assert.equal(h.writes[0].key,'memory:chapter-1');assert.equal(h.writes[0].pid,'book-1');
});

test('manual entry needs no configured model and preserves original selection',async()=>{
  const h=harness();h.context.state.settings={};await h.click('memory-edit-current');
  assert.equal(h.calls[0].body.manual,true);assert.equal(h.context.state.view,'write');assert.equal(h.nodes['#memory-0-selected'].checked,true);
  assert.equal(h.nodes['#memory-summary'].value,'原来的摘要');
});

test('author edits summary, state and evidence before a memory-only adoption',async()=>{
  const h=harness();await h.click('memory-generate');
  h.input('memory-summary','作者核对后的摘要');h.input('memory-0-value','拿到了旧信');h.input('memory-0-evidence','她接过旧信。');
  h.input('memory-0-entity','thread-1','change');assert.equal(h.nodes['#memory-0-field'].value,'status');
  h.nodes['#memory-0-selected'].checked=true;await h.submit();
  const body=h.calls[1].body;assert.equal(body.action,'apply_memory');assert.equal(body.data.source_revision,3);assert.equal(body.data.source_hash,'source-body-and-context');
  assert.equal(body.data.summary,'作者核对后的摘要');assert.equal(body.data.changes[0].entity_id,'thread-1');assert.equal(body.data.changes[0].field,'status');
  assert.equal(body.data.changes[0].value,'拿到了旧信');assert.equal(body.data.changes[0].evidence,'她接过旧信。');assert.equal(body.data.changes[0].selected,true);
  assert.equal(h.context.current().text,'他走进旧街。她接过旧信。');assert.equal(h.context.current().status,'draft');assert.equal(h.storage.size,0);assert.equal(h.dialog.open,false);
});

test('unselected invalid candidates remain editable and are sent without being silently discarded',async()=>{
  const h=harness();await h.click('memory-edit-current');
  h.input('memory-0-evidence','待补充的依据');h.input('memory-0-value','');h.nodes['#memory-0-selected'].checked=false;
  await h.submit();assert.equal(h.calls[1].body.data.changes.length,1);assert.equal(h.calls[1].body.data.changes[0].evidence,'待补充的依据');
  assert.equal(h.calls[1].body.data.changes[0].selected,false);
});

test('unknown association can be removed before adoption',async()=>{
  const h=harness();h.context.nextPreview=preview();h.context.nextPreview.changes.push({id:'gone',entity_id:'missing',field:'missing',value:'原错项',evidence:'未知',selected:false});
  await h.click('memory-generate');assert.match(h.dialogs.at(-1),/未知档案 · 请重新选择或移除/);
  await h.click('memory-remove',{index:'1'});await h.submit();assert.equal(h.calls[1].body.data.changes.length,1);
});

test('edited memory preview survives closing and a fresh browser session',async()=>{
  const h=harness();await h.click('memory-generate');h.input('memory-summary','关闭前核对的摘要');h.input('memory-0-evidence','她接过旧信。');
  await h.click('memory-close');assert.equal(h.dialog.open,false);
  const restarted=harness(h.storage);await restarted.click('memory-resume');
  assert.equal(restarted.nodes['#memory-summary'].value,'关闭前核对的摘要');assert.equal(restarted.nodes['#memory-0-evidence'].value,'她接过旧信。');
  assert.equal(restarted.calls.length,0);assert.match(restarted.dialogs.at(-1),/原来的摘要/);assert.match(restarted.dialogs.at(-1),/1 项原候选/);
});

test('stale source remains available to copy and rejects adoption without mutation',async()=>{
  const h=harness();await h.click('memory-generate');h.context.state.project.revision++;h.input('memory-summary','过期但要保留');
  await h.submit();assert.match(h.errors.at(-1),/过期/);assert.equal(h.calls.length,1);assert.equal(h.dialog.open,true);
  assert.equal(h.storage.get('book-1:memory:chapter-1').candidate.summary,'过期但要保留');
});

test('generation can close while busy and its result never reopens the dialog',async()=>{
  const h=harness();h.mountEntries();const waiting=deferred();h.context.request=()=>waiting.promise;
  const generated=h.click('memory-generate');await flush();assert.equal(h.dialog.open,true);assert.equal(h.context.state.busy,true);
  h.click('memory-close-pending');assert.equal(h.dialog.open,false);waiting.resolve({memory:preview()});await generated;
  assert.equal(h.dialog.open,false);assert.equal(h.nodes['#resume-0'].hidden,false);
  await h.click('memory-resume');assert.equal(h.dialog.open,true);
});

test('a generation finishing after project switch persists with its original project',async()=>{
  const h=harness();const waiting=deferred();h.context.request=()=>waiting.promise;
  const generated=h.click('memory-generate');await flush();h.context.state.project.id='book-2';
  waiting.resolve({memory:preview()});await generated;assert.ok(h.storage.has('book-1:memory:chapter-1'));
  assert.equal(h.storage.has('book-2:memory:chapter-1'),false);assert.equal(h.dialogs.length,1);
});

test('model failure closes its pending dialog and leaves current content intact',async()=>{
  const h=harness(),before=clone(h.context.state.project);h.context.request=()=>Promise.reject(new Error('模型不可用'));
  await h.click('memory-generate');assert.match(h.errors.at(-1),/模型不可用/);assert.deepEqual(h.context.state.project,before);assert.equal(h.dialog.open,false);
});

test('typing during adoption preserves new input while saving the clicked candidate',async()=>{
  const h=harness();await h.click('memory-generate');h.input('memory-summary','点击时的摘要');
  const waiting=deferred();h.context.request=()=>waiting.promise;const submitting=h.submit();await flush();h.input('memory-summary','等待期间继续修改的摘要');
  waiting.resolve(h.updated(h.calls[1].body));await submitting;
  assert.equal(h.context.current().summary,'点击时的摘要');assert.equal(h.nodes['#memory-summary'].value,'等待期间继续修改的摘要');
  assert.equal(h.nodes['#memory-form'].querySelector().disabled,true);assert.equal(h.dialog.open,true);assert.match(h.dialogs.at(-1),/候选已过期/);
  assert.equal(h.storage.get('book-1:memory:chapter-1').candidate.summary,'等待期间继续修改的摘要');
});

test('adoption finishing after close does not reopen the dialog',async()=>{
  const h=harness();await h.click('memory-generate');const waiting=deferred();h.context.request=()=>waiting.promise;
  const submitting=h.submit();await flush();h.dialog.close();waiting.resolve(h.updated(h.calls[1].body));await submitting;
  assert.equal(h.dialog.open,false);assert.equal(h.context.state.project.revision,4);
});

test('successful adoption closes before auxiliary cleanup and late input cannot recreate it',async()=>{
  const h=harness();await h.click('memory-generate');const cleanup=deferred();h.context.removeRequest=()=>cleanup.promise;
  const submitting=h.submit();await flush();assert.equal(h.context.state.project.revision,4);assert.equal(h.dialog.open,false);
  const writes=h.writes.length;h.input('memory-summary','迟到的旧控件输入');h.dispatch('close',{type:'close',target:h.dialog});
  assert.equal(h.writes.length,writes);cleanup.resolve();await submitting;assert.equal(h.storage.size,0);
});

test('discard closes before durable deletion and late input cannot recreate a discarded preview',async()=>{
  const h=harness();await h.click('memory-generate');const cleanup=deferred();h.context.removeRequest=()=>cleanup.promise;
  const discarding=h.click('memory-discard');await flush();assert.equal(h.dialog.open,false);const writes=h.writes.length;
  h.input('memory-summary','丢弃后迟到的输入');h.dispatch('close',{type:'close',target:h.dialog});assert.equal(h.writes.length,writes);
  cleanup.resolve();await discarding;assert.equal(h.storage.size,0);assert.equal(h.calls.length,1);
});

test('cleanup failure reports a saved chapter and safely retains a stale preview',async()=>{
  const h=harness();await h.click('memory-generate');h.context.removeError='草稿服务暂不可用';await h.submit();
  assert.equal(h.context.state.project.revision,4);assert.equal(h.dialog.open,false);assert.match(h.errors.at(-1),/章节记忆已保存/);
  await h.click('memory-resume');assert.match(h.dialogs.at(-1),/候选已过期/);await h.submit();assert.equal(h.calls.length,2);
});

test('draft write failure preserves generated inputs visibly for copying',async()=>{
  const h=harness();h.context.writeError='草稿空间已满';await h.click('memory-generate');
  assert.equal(h.dialog.open,true);assert.equal(h.nodes['#memory-summary'].value,'从正文提取的新摘要');assert.match(h.errors.at(-1),/草稿空间已满/);
  assert.equal(h.context.current().summary,'原来的摘要');
});

for(const type of ['cancel','close'])test(`${type} captures final IME values without an input event`,async()=>{
  const h=harness();await h.click('memory-generate');h.nodes['#memory-summary'].value='输入法最后确认的摘要';h.nodes['#memory-0-value'].value='输入法最后确认的状态';
  if(type==='close')h.dialog.close();else h.dispatch(type,{type,target:h.dialog});await flush();
  const restarted=harness(h.storage);await restarted.click('memory-resume');assert.equal(restarted.nodes['#memory-summary'].value,'输入法最后确认的摘要');
  assert.equal(restarted.nodes['#memory-0-value'].value,'输入法最后确认的状态');
});

test('close during the post-adoption write preserves final input without reopening',async()=>{
  const h=harness();await h.click('memory-generate');const response=deferred(),auxiliary=deferred();let started=false;
  h.context.request=()=>response.promise;h.context.writeRequest=()=>{if(h.context.state.project.revision===4&&!started){started=true;return auxiliary.promise;}};
  const submitting=h.submit();await flush();h.input('memory-summary','采用期间继续写');response.resolve(h.updated(h.calls[1].body));await flush();
  assert.equal(started,true);assert.equal(h.nodes['#memory-form'].querySelector().disabled,true);
  h.nodes['#memory-summary'].value='辅助写入期间最终输入';h.dialog.close();auxiliary.resolve();await submitting;
  assert.equal(h.dialog.open,false);assert.equal(h.dialogs.length,2);assert.equal(h.writes.at(-1).payload.candidate.summary,'辅助写入期间最终输入');
});

test('summary and changes have separate entries without duplicate injection',async()=>{
  const h=harness();h.mountEntries();h.context.decorateMemory();h.context.decorateMemory();
  assert.ok(h.nodes['#memory-entries-summary']);assert.ok(h.nodes['#memory-entries-changes']);assert.equal(Object.values(h.nodes).filter(node=>node.isResume).length,2);
});

test('durable payload avoids duplicate candidates and original state lists',async()=>{
  const h=harness();h.context.nextPreview=preview(true);h.context.nextPreview.changes=Array.from({length:100},(_,index)=>({id:String(index),entity_id:'person-1',field:'location',value:'字'.repeat(5000),evidence:'文'.repeat(5000),selected:false}));
  h.context.nextPreview.original.changes=clone(h.context.nextPreview.changes);await h.click('memory-edit-current');
  const payload=h.writes.at(-1).payload;assert.equal(payload.preview.changes,undefined);assert.equal(payload.preview.summary,undefined);
  assert.equal(payload.preview.original.changes,undefined);assert.equal(payload.preview.original.change_count,100);
  assert.ok(Buffer.byteLength(JSON.stringify(payload),'utf8')<4*1024*1024);
});

test('empty prose and empty adoption summary are rejected without a mutation',async()=>{
  const h=harness();h.context.current().text='';await h.click('memory-generate');assert.match(h.errors.at(-1),/先写下正文/);assert.equal(h.calls.length,0);
  h.context.current().text='他走进旧街。';await h.click('memory-edit-current');h.input('memory-summary','  ');await h.submit();
  assert.match(h.errors.at(-1),/补充章节事实摘要/);assert.equal(h.calls.length,1);assert.equal(h.dialog.open,true);
});

test('evidence warnings require the original whitespace to occur exactly in prose',async()=>{
  const h=harness();h.context.nextPreview=preview(true);h.context.nextPreview.changes[0].evidence=' 他走进旧街。 ';
  await h.click('memory-edit-current');assert.match(h.dialogs.at(-1),/依据未在当前正文找到/);
  const exact=harness();exact.context.current().text=' 他走进旧街。 ';
  exact.context.nextPreview=preview(true);exact.context.nextPreview.changes[0].evidence=' 他走进旧街。 ';
  await exact.click('memory-edit-current');assert.doesNotMatch(exact.dialogs.at(-1),/依据未在当前正文找到/);
});

test('actual app and memory listeners route a preview and adoption exactly once',async()=>{
  const h=harness(new Map(),true);await h.click('memory-generate');
  assert.equal(h.context.runs,1);assert.equal(h.calls.length,1);assert.equal(h.dialogs.length,2);
  h.input('memory-summary','跨模块核对的摘要');h.nodes['#memory-0-selected'].checked=true;await h.submit();
  assert.equal(h.context.runs,2);assert.equal(h.calls.length,2);assert.equal(h.calls[1].body.action,'apply_memory');
  assert.equal(h.context.current().summary,'跨模块核对的摘要');assert.equal(h.context.current().text,'他走进旧街。她接过旧信。');
  assert.equal(h.storage.size,0);assert.deepEqual(h.errors,[]);
});

test('actual app routing preserves memory drafts on close and refuses stale adoption after restart',async()=>{
  const h=harness(new Map(),true);await h.click('memory-edit-current');h.input('memory-summary','关闭后仍需保留的摘要');await h.click('memory-close');
  assert.equal(h.context.runs,2);assert.equal(h.dialog.open,false);assert.equal(h.storage.size,1);assert.deepEqual(h.errors,[]);
  const restarted=harness(h.storage,true);restarted.context.state.project.revision++;
  await restarted.click('memory-resume');assert.equal(restarted.context.runs,1);assert.equal(restarted.calls.length,0);
  assert.equal(restarted.nodes['#memory-summary'].value,'关闭后仍需保留的摘要');assert.match(restarted.dialogs.at(-1),/候选已过期/);
  await restarted.submit();assert.equal(restarted.context.runs,2);assert.equal(restarted.calls.length,0);assert.match(restarted.errors.at(-1),/过期/);
  assert.equal(restarted.dialog.open,true);assert.equal(restarted.storage.size,1);
});

test('actual app and revisions listeners open the list and navigate once per action',async()=>{
  const h=harness(new Map(),true);h.context.state.project.chapters.push({id:'chapter-2',title:'第二章',text:'第二章正文',status:'needs_review',summary:'第二章摘要',changes:[]});
  await h.click('revisions-open');assert.equal(h.context.runs,1);assert.equal(h.context.saves,1);assert.equal(h.dialogs.length,1);
  assert.match(h.dialogs.at(-1),/集中修稿与复核/);assert.match(h.dialogs.at(-1),/第二章/);
  await h.click('revisions-chapter',{id:'chapter-2',tab:'text'});assert.equal(h.context.runs,2);assert.equal(h.context.saves,2);
  assert.equal(h.context.state.chapterId,'chapter-2');assert.equal(h.context.state.editorTab,'text');assert.equal(h.dialog.open,false);
  await h.click('revisions-next');assert.equal(h.context.runs,3);assert.equal(h.context.saves,3);
  assert.equal(h.context.state.chapterId,'chapter-1');assert.equal(h.context.state.editorTab,'summary');assert.equal(h.context.state.sideTab,'changes');
  assert.equal(h.calls.length,0);assert.deepEqual(h.errors,[]);
});
