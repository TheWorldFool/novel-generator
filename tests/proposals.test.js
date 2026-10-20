'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'..','static','proposals.js'),'utf8');
const appSource=fs.readFileSync(path.join(__dirname,'..','static','app.js'),'utf8').replace(/\binit\(\);\s*$/,'');
const decode=text=>text.replace(/&(amp|lt|gt|quot|#39);/g,(_,key)=>({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"}[key]));
const clone=value=>structuredClone(value);

function outlineProposal(){return {kind:'outline',source_revision:3,source_hash:'outline-source',
  original:{text:'作者原文',ending:'作者结局',guardrails:'作者约束',nodes:[{id:'manual',title:'手改节点',goal:'手改目标'}]},
  draft:{text:'作者原文',ending:'作者结局',guardrails:'作者约束',nodes:[
    {id:'candidate-1',title:'候选一',goal:'目标一',must:'事件一',avoid:'禁区一',source_quote:''},
    {id:'candidate-2',title:'候选二',goal:'目标二',must:'事件二',avoid:'禁区二',source_quote:''}]}};}
function planProposal(){return {kind:'plan',chapter_id:'chapter-1',source_revision:3,source_hash:'scene-source',original:'手改场景方案',outline:'AI候选场景方案'};}
function rewriteProposal(){return {kind:'rewrite',chapter_id:'chapter-1',source_revision:3,source_hash:'rewrite-source',original:{text:'原正文',summary:'原摘要',changes:[]},
  text:'候选正文：他走出门。',summary:'候选摘要',changes:[{id:'change-1',entity_id:'character-1',field:'location',value:'门外',evidence:'他走出门。',selected:false}],warnings:[]};}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const flush=()=>new Promise(resolve=>setImmediate(resolve));

function harness(storage=new Map(),withApp=false){
  const nodes={},listeners={},calls=[],writes=[],errors=[],messages=[],dialogs=[];
  const dialog=nodes['#dialog']={id:'dialog',open:false,close(){this.open=false;dispatch('close',{type:'close',target:this});}};
  nodes['#proposal-resume']={hidden:true};
  const context={console,Map,Error,Promise,structuredClone,
    state:{busy:false,dirty:false,view:'outline',settings:{base_url:'https://model.invalid/v1',model:'configured'},
      fields:{character:{location:'位置',goal:'目标'},world:{fact:'事实'}},
      project:{id:'book-1',revision:3,book_outline:{draft:clone(outlineProposal().original)},entities:[{id:'character-1',kind:'character',name:'林照',locked:false},{id:'world-1',kind:'world',name:'雾港',locked:false}],chapters:[{id:'chapter-1',outline:'手改场景方案',text:'原正文',summary:'原摘要',changes:[]}]}} ,
    document:{addEventListener(type,fn){(listeners[type]||=[]).push(fn);},querySelector(selector){return nodes[selector]||null;},querySelectorAll(){return [];}},
    addEventListener(){},FormData(){throw new Error('Root submit handler must skip the proposal form.');},
    $(selector){return nodes[selector]||null;},
    current(){return context.state.project.chapters[0];},
    outlineNodeLabels:{title:'标题',goal:'目标',must:'事件',avoid:'禁区',source_quote:'依据'},
    esc(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));},
    showDialog(html){
      dialogs.push(html);dialog.open=true;
      for(const key of Object.keys(nodes))if(key.startsWith('#proposal-')&&key!=='#proposal-resume')delete nodes[key];
      const form=html.match(/<form id="proposal-form" data-session="([^"]+)"/);
      if(form){
        const submit={disabled:false};
        nodes['#proposal-form']={id:'proposal-form',dataset:{session:form[1]},
          querySelector(){return submit;},insertAdjacentHTML(position,html){dialogs[dialogs.length-1]+=html;}};
      }
      const pending=html.match(/id="proposal-pending" data-session="([^"]+)"/);
      if(pending)nodes['#proposal-pending']={id:'proposal-pending',dataset:{session:pending[1]}};
      for(const match of html.matchAll(/<textarea id="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g))addNode(match[1],decode(match[2]));
      for(const match of html.matchAll(/<input([^>]+)>/g)){
        const id=match[1].match(/id="([^"]+)"/)?.[1];if(!id)continue;
        const node=addNode(id,decode(match[1].match(/value="([^"]*)"/)?.[1]||''));
        node.checked=/\schecked(?:\s|$)/.test(match[1]);
      }
      if(html.includes('id="proposal-mode"'))addNode('proposal-mode',html.includes('value="append" selected')?'append':'replace');
      for(const match of html.matchAll(/<select id="([^"]+)"([^>]*)>([\s\S]*?)<\/select>/g)){
        const options=[...match[3].matchAll(/<option value="([^"]*)"([^>]*)>/g)];
        const option=options.find(item=>/\bselected\b/.test(item[2]))||options[0];
        const node=addNode(match[1],decode(option?.[1]||''));node.dataset={};
        const entity=match[2].match(/data-proposal-entity="([^"]*)"/);if(entity)node.dataset.proposalEntity=entity[1];
      }
    },
    toast(message,error){(error?errors:messages).push(message);},
    render(){context.renders=(context.renders||0)+1;},
    accept(result){context.state.project=result.project;context.state.dirty=false;},
    async saveCurrent(){context.saves=(context.saves||0)+1;context.state.dirty=false;},
    async api(url,body){
      calls.push({url,body:clone(body)});
      if(context.request)return context.request(url,body);
      if(!url.endsWith('/mutate'))return {proposal:body.action==='plan'?planProposal():body.action==='rewrite'?rewriteProposal():outlineProposal()};
      return updated(body);
    },
    run(fn){context.runs=(context.runs||0)+1;context.state.busy=true;context.pending=Promise.resolve().then(fn).catch(e=>errors.push(e.message)).finally(()=>{context.state.busy=false;});},
    workDrafts:{
      async read(key,pid){return clone(storage.get(`${pid}:${key}`)||null);},
      async write(key,payload,pid){writes.push({key,pid,payload:clone(payload)});if(context.writeError)throw new Error(context.writeError);storage.set(`${pid}:${key}`,clone(payload));if(context.writeRequest)await context.writeRequest(key,payload,pid);},
      async remove(key,pid){if(context.removeError)throw new Error(context.removeError);if(context.removeRequest)await context.removeRequest(key,pid);storage.delete(`${pid}:${key}`);},
    },
  };
  function addNode(id,value){return nodes['#'+id]={id,value,closest(selector){return selector==='#proposal-form'?nodes['#proposal-form']:selector==='#dialog'?dialog:null;}};}
  function updated(body){const project=clone(context.state.project);project.revision++;
    if(body.action==='apply_rewrite_proposal')Object.assign(project.chapters[0],{text:body.data.text,summary:body.data.summary,changes:body.data.changes});
    else if(body.action==='apply_plan_proposal')project.chapters[0].outline=body.data.outline;
    else project.book_outline.draft={...body.data.draft,nodes:body.data.mode==='append'?[...project.book_outline.draft.nodes,...body.data.draft.nodes]:body.data.draft.nodes};
    return {project,canon:[]};}
  context.window=context;vm.createContext(context);vm.runInContext(source,context,{filename:'proposals.js'});
  if(withApp){
    const intendedState=context.state;
    const helpers=Object.fromEntries(['showDialog','run','api','toast','render','saveCurrent','accept'].map(key=>[key,context[key]]));
    vm.runInContext(appSource,context,{filename:'app.js'});
    vm.runInContext('globalThis.actualWorkbenchState=state;',context);
    Object.assign(context.actualWorkbenchState,intendedState);context.state=context.actualWorkbenchState;
    Object.assign(context,helpers);
  }
  function dispatch(type,event){for(const fn of listeners[type]||[])fn(event);}
  function click(action,dataset={}){dispatch('click',{target:{closest(){return {dataset:{action,...dataset}};}},preventDefault(){}});return context.pending||Promise.resolve();}
  function input(id,value){const node=nodes['#'+id];node.value=value;dispatch('input',{target:node});}
  function submit(){dispatch('submit',{target:nodes['#proposal-form'],preventDefault(){}});return context.pending||Promise.resolve();}
  return {context,nodes,dialog,calls,writes,errors,messages,dialogs,storage,updated,click,input,submit,dispatch};
}

test('outline preview displays original and candidate without changing the working draft',async()=>{
  const h=harness(),before=clone(h.context.state.project);
  await h.context.showOutlineProposal(outlineProposal());
  assert.deepEqual(h.context.state.project,before);assert.equal(h.calls.length,0);
  assert.match(h.dialogs.at(-1),/手改节点/);assert.match(h.dialogs.at(-1),/候选一/);
  assert.equal(h.writes[0].key,'proposal:outline');assert.equal(h.writes[0].pid,'book-1');
});

test('author can select one node, edit its fields, and explicitly append it',async()=>{
  const h=harness();await h.context.showOutlineProposal(outlineProposal());
  h.nodes['#proposal-node-0-selected'].checked=false;
  h.input('proposal-node-1-title','作者改过的标题');h.input('proposal-node-1-goal','作者改过的目标');
  h.nodes['#proposal-mode'].value='append';
  await h.submit();
  assert.equal(h.calls.length,1);const body=h.calls[0].body;
  assert.equal(body.action,'apply_outline_proposal');assert.equal(body.data.mode,'append');
  assert.equal(body.data.draft.nodes.length,1);assert.equal(body.data.draft.nodes[0].title,'作者改过的标题');
  assert.equal(body.data.draft.nodes[0].goal,'作者改过的目标');
  assert.equal(h.context.state.project.book_outline.draft.nodes[0].id,'manual');
  assert.equal(h.storage.size,0);assert.equal(h.dialog.open,false);assert.deepEqual(h.errors,[]);
});

test('empty selection and stale source refuse adoption without an API mutation',async()=>{
  const h=harness();await h.context.showOutlineProposal(outlineProposal());
  h.nodes['#proposal-node-0-selected'].checked=false;h.nodes['#proposal-node-1-selected'].checked=false;
  await h.submit();assert.match(h.errors.at(-1),/至少勾选/);assert.equal(h.calls.length,0);
  h.nodes['#proposal-node-0-selected'].checked=true;h.context.state.project.revision++;
  await h.submit();assert.match(h.errors.at(-1),/过期/);assert.equal(h.calls.length,0);assert.equal(h.dialog.open,true);
});

test('edited proposal survives close and a fresh browser session through the durable draft API',async()=>{
  const h=harness();await h.context.showOutlineProposal(outlineProposal());
  h.input('proposal-node-0-goal','关闭前的手改');h.nodes['#proposal-node-1-selected'].checked=false;
  await h.click('proposal-close');assert.equal(h.dialog.open,false);
  const restarted=harness(h.storage);await restarted.click('proposal-resume');
  assert.equal(restarted.nodes['#proposal-node-0-goal'].value,'关闭前的手改');
  assert.equal(restarted.nodes['#proposal-node-1-selected'].checked,false);
  assert.equal(restarted.calls.length,0);assert.equal(restarted.dialog.open,true);
});

test('scene generation keeps original until author edits and adopts the candidate',async()=>{
  const h=harness();h.context.state.view='write';
  await h.context.previewScenePlan('只调节奏');
  assert.equal(h.calls[0].body.action,'plan');assert.equal(h.calls[0].body.instructions,'只调节奏');
  assert.equal(h.context.current().outline,'手改场景方案');
  h.input('proposal-plan','作者核对后的场景方案');await h.submit();
  assert.equal(h.calls[1].body.action,'apply_plan_proposal');
  assert.equal(h.context.current().outline,'作者核对后的场景方案');assert.equal(h.context.current().text,'原正文');
});

for(const kind of ['plan','outline'])test(`${kind} generation finishing after close stays closed and can be resumed`,async()=>{
  const h=harness();h.context.state.view=kind==='plan'?'write':'outline';
  const waiting=deferred();h.context.request=()=>waiting.promise;h.context.state.busy=true;
  const generated=kind==='plan'?h.context.previewScenePlan():h.context.previewOutlineNodes();
  await flush();assert.equal(h.dialog.open,true);
  await h.click('proposal-close-pending');assert.equal(h.dialog.open,false);
  waiting.resolve({proposal:kind==='plan'?planProposal():outlineProposal()});await generated;h.context.state.busy=false;
  assert.equal(h.dialog.open,false);assert.equal(h.nodes['#proposal-resume'].hidden,false);
  await h.click('proposal-resume');assert.equal(h.dialog.open,true);
});

test('model failure closes only its pending preview and leaves the original plan intact',async()=>{
  const h=harness();h.context.state.view='write';h.context.request=()=>Promise.reject(new Error('模型不可用'));
  await assert.rejects(()=>h.context.previewScenePlan(),/模型不可用/);
  assert.equal(h.dialog.open,false);assert.equal(h.context.current().outline,'手改场景方案');assert.equal(h.storage.size,0);
});

test('typing during adoption is retained while only the clicked candidate is applied',async()=>{
  const h=harness();h.context.state.view='write';await h.context.showOutlineProposal(planProposal());
  h.input('proposal-plan','点击时的方案');const waiting=deferred();h.context.request=()=>waiting.promise;
  const submitting=h.submit();await flush();
  h.input('proposal-plan','等待时继续输入的方案');
  waiting.resolve(h.updated(h.calls[0].body));await submitting;
  assert.equal(h.context.current().outline,'点击时的方案');
  assert.equal(h.nodes['#proposal-plan'].value,'等待时继续输入的方案');
  assert.match(h.dialogs.at(-1),/候选已过期/);assert.equal(h.dialog.open,true);
  assert.equal(h.storage.get('book-1:proposal:plan:chapter-1').candidate,'等待时继续输入的方案');
});

test('adoption finishing after dialog close never reopens it',async()=>{
  const h=harness();await h.context.showOutlineProposal(outlineProposal());
  const waiting=deferred();h.context.request=()=>waiting.promise;const submitting=h.submit();
  await flush();h.dialog.close();
  waiting.resolve(h.updated(h.calls[0].body));await submitting;
  assert.equal(h.dialog.open,false);assert.equal(h.context.state.project.revision,4);
});

test('cleanup failure reports a saved work and retains stale candidate instead of failing adoption',async()=>{
  const h=harness();await h.context.showOutlineProposal(outlineProposal());h.context.removeError='草稿服务暂不可用';
  await h.submit();
  assert.equal(h.context.state.project.revision,4);assert.equal(h.dialog.open,false);
  assert.match(h.messages.at(-1),/已保存到大纲草稿/);assert.match(h.errors.at(-1),/作品已保存/);
  assert.equal(h.storage.size,1);
  await h.click('proposal-resume');assert.match(h.dialogs.at(-1),/候选已过期/);
  await h.submit();assert.equal(h.calls.length,1);
});

test('durable write failure keeps the generated candidate visible for copying',async()=>{
  const h=harness();h.context.writeError='草稿空间不足';
  await assert.rejects(()=>h.context.showOutlineProposal(outlineProposal()),/草稿空间不足/);
  assert.equal(h.dialog.open,true);assert.equal(h.nodes['#proposal-node-0-title'].value,'候选一');
  assert.equal(h.context.state.project.book_outline.draft.nodes[0].id,'manual');
});

test('durable outline payload omits duplicate suggestions and fits the draft byte budget',async()=>{
  const h=harness(),p=outlineProposal();
  p.original.text='😀'.repeat(30000);p.original.ending='😀'.repeat(5000);p.original.guardrails='😀'.repeat(5000);
  p.original.nodes=[{id:'author',title:'原节点',goal:'😀'.repeat(3000),must:'',avoid:'',source_quote:''}];
  p.draft=clone(p.original);p.draft.nodes=[{id:'candidate',title:'候选',goal:'😀'.repeat(3000),must:'',avoid:'',source_quote:''}];
  await h.context.showOutlineProposal(p);
  const payload=h.writes.at(-1).payload;
  assert.equal(payload.proposal.draft,undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(payload),'utf8')<600000);
});

test('closing during the post-adoption draft write does not reopen the dialog',async()=>{
  const h=harness();h.context.state.view='write';await h.context.showOutlineProposal(planProposal());
  const response=deferred(),auxiliary=deferred();let auxiliaryStarted=false;
  h.context.request=()=>response.promise;
  h.context.writeRequest=()=>{if(h.context.state.project.revision===4&&!auxiliaryStarted){auxiliaryStarted=true;return auxiliary.promise;}};
  const submitting=h.submit();await flush();h.input('proposal-plan','采用时继续写的候选');
  response.resolve(h.updated(h.calls[0].body));await flush();assert.equal(auxiliaryStarted,true);
  h.nodes['#proposal-plan'].value='辅助写入期间最后的输入';h.dialog.close();
  auxiliary.resolve();await submitting;
  assert.equal(h.dialog.open,false);assert.equal(h.dialogs.length,1);
  assert.equal(h.writes.at(-1).payload.candidate,'辅助写入期间最后的输入');
});

test('successful adoption closes immediately before auxiliary cleanup and close cannot revive it',async()=>{
  const h=harness();h.context.state.view='write';await h.context.showOutlineProposal(planProposal());
  const cleanup=deferred();h.context.removeRequest=()=>cleanup.promise;
  const submitting=h.submit();await flush();
  assert.equal(h.context.current().outline,'AI候选场景方案');
  assert.equal(h.dialog.open,false);
  const writes=h.writes.length;
  // A delayed composition/input event from a detached control must not recreate
  // a suggestion the completed adoption is already deleting.
  h.input('proposal-plan','迟到的旧控件事件');
  h.dispatch('close',{type:'close',target:h.dialog});
  assert.equal(h.writes.length,writes);
  cleanup.resolve();await submitting;assert.equal(h.storage.size,0);
});

for(const type of ['cancel','close'])test(`${type} captures a final IME value without an input event`,async()=>{
  const h=harness();h.context.state.view='write';await h.context.showOutlineProposal(planProposal());
  h.nodes['#proposal-plan'].value='输入法最后确认的文字';
  if(type==='close')h.dialog.close();else h.dispatch(type,{type,target:h.dialog});
  await flush();
  const restarted=harness(h.storage);restarted.context.state.view='write';await restarted.click('proposal-resume');
  assert.equal(restarted.nodes['#proposal-plan'].value,'输入法最后确认的文字');
});

test('whole chapter rewrite compares original and separately editable body, summary and state candidates',async()=>{
  const h=harness();h.context.state.view='write';const original=clone(h.context.state.project);
  await h.context.previewChapterRewrite('减少解释，保留结尾');
  assert.equal(h.calls[0].body.action,'rewrite');assert.equal(h.calls[0].body.instructions,'减少解释，保留结尾');
  assert.deepEqual(h.context.state.project,original);assert.match(h.dialogs.at(-1),/原正文/);
  assert.match(h.dialogs.at(-1),/减少解释，保留结尾/);assert.equal(h.nodes['#proposal-change-0-selected'].checked,false);
  h.input('proposal-rewrite-text','作者手改：他走出门。');h.input('proposal-rewrite-summary','作者核对的摘要');
  h.input('proposal-change-0-value','门口');h.nodes['#proposal-change-0-selected'].checked=true;
  await h.submit();assert.equal(h.calls[1].body.action,'apply_rewrite_proposal');
  const adopted=h.context.current();assert.equal(adopted.text,'作者手改：他走出门。');assert.equal(adopted.summary,'作者核对的摘要');
  assert.equal(adopted.changes[0].value,'门口');assert.equal(adopted.changes[0].selected,true);assert.equal(h.dialog.open,false);
  assert.match(h.messages.at(-1),/另行确认正文/);assert.deepEqual(h.errors,[]);
});

test('rewrite can remove a state and change its associated entity and field',async()=>{
  const h=harness();h.context.state.view='write';const p=rewriteProposal();p.changes.push({...p.changes[0],id:'change-2'});
  await h.context.showOutlineProposal(p);
  h.nodes['#proposal-change-0-entity_id'].value='world-1';
  h.dispatch('change',{target:h.nodes['#proposal-change-0-entity_id']});
  assert.equal(h.nodes['#proposal-change-0-field'].value,'fact');
  await h.click('proposal-change-remove',{index:'1'});
  await h.submit();assert.equal(h.calls[0].body.data.changes.length,1);
  assert.equal(h.calls[0].body.data.changes[0].entity_id,'world-1');assert.equal(h.calls[0].body.data.changes[0].field,'fact');
});

test('edited whole rewrite and original comparison survive a fresh page session',async()=>{
  const h=harness();h.context.state.view='write';await h.context.previewChapterRewrite('保留结尾');
  h.input('proposal-rewrite-text','重开后保留的正文');h.input('proposal-rewrite-summary','重开后保留的摘要');
  h.input('proposal-change-0-evidence','待作者补充依据');await h.click('proposal-close');
  const restored=harness(h.storage);restored.context.state.view='write';await restored.click('proposal-rewrite-resume');
  assert.equal(restored.nodes['#proposal-rewrite-text'].value,'重开后保留的正文');
  assert.equal(restored.nodes['#proposal-rewrite-summary'].value,'重开后保留的摘要');
  assert.equal(restored.nodes['#proposal-change-0-evidence'].value,'待作者补充依据');assert.match(restored.dialogs.at(-1),/原正文/);
  assert.match(restored.dialogs.at(-1),/保留结尾/);assert.equal(restored.calls.length,0);
});

test('rewrite finishing after close stays closed and retains its candidate',async()=>{
  const h=harness();h.context.state.view='write';const response=deferred();h.context.request=()=>response.promise;
  h.context.state.busy=true;const generating=h.context.previewChapterRewrite('只调节奏');await flush();
  await h.click('proposal-close-pending');response.resolve({proposal:rewriteProposal()});await generating;h.context.state.busy=false;
  assert.equal(h.dialog.open,false);assert.ok(h.storage.has('book-1:proposal:rewrite:chapter-1'));
  await h.click('proposal-rewrite-resume');assert.equal(h.nodes['#proposal-rewrite-text'].value,'候选正文：他走出门。');
});

test('rewrite finishing after project switch is kept under its original project and never opens on another book',async()=>{
  const h=harness();h.context.state.view='write';const response=deferred();h.context.request=()=>response.promise;
  const generating=h.context.previewChapterRewrite();await flush();h.context.state.project.id='book-2';
  h.dialog.close();response.resolve({proposal:rewriteProposal()});await generating;
  assert.equal(h.dialog.open,false);assert.ok(h.storage.has('book-1:proposal:rewrite:chapter-1'));
  assert.equal(h.storage.has('book-2:proposal:rewrite:chapter-1'),false);
});

test('empty original, blank candidate body or summary and stale source cannot adopt a rewrite',async()=>{
  const h=harness();h.context.state.view='write';h.context.current().text=' ';
  await assert.rejects(()=>h.context.previewChapterRewrite(),/先写入正文/);assert.equal(h.calls.length,0);
  h.context.current().text='原文';await h.context.showOutlineProposal(rewriteProposal());
  h.input('proposal-rewrite-text',' ');await h.submit();assert.equal(h.calls.length,0);assert.match(h.errors.at(-1),/正文和摘要/);
  h.input('proposal-rewrite-text','候选正文');h.input('proposal-rewrite-summary',' ');await h.submit();assert.equal(h.calls.length,0);
  h.input('proposal-rewrite-summary','摘要');h.context.state.project.revision++;await h.submit();assert.equal(h.calls.length,0);assert.match(h.errors.at(-1),/过期/);
});

test('whole rewrite adoption uses clicked values and retains continued typing without reopening a dismissed dialog',async()=>{
  const h=harness();h.context.state.view='write';await h.context.showOutlineProposal(rewriteProposal());
  h.input('proposal-rewrite-text','点击时正文');h.input('proposal-rewrite-summary','点击时摘要');
  const response=deferred();h.context.request=()=>response.promise;const submitting=h.submit();await flush();
  h.input('proposal-rewrite-text','等待期间正文');h.nodes['#proposal-rewrite-summary'].value='输入法最后的摘要';h.dialog.close();
  response.resolve(h.updated(h.calls[0].body));await submitting;
  assert.equal(h.context.current().text,'点击时正文');assert.equal(h.context.current().summary,'点击时摘要');assert.equal(h.dialog.open,false);
  const saved=h.storage.get('book-1:proposal:rewrite:chapter-1');assert.equal(saved.candidate.text,'等待期间正文');assert.equal(saved.candidate.summary,'输入法最后的摘要');
});

test('rewrite storage failure keeps all candidate fields and the original available for copying',async()=>{
  const h=harness();h.context.state.view='write';h.context.writeError='空间不足';
  await assert.rejects(()=>h.context.previewChapterRewrite(),/空间不足/);
  assert.equal(h.dialog.open,true);assert.equal(h.nodes['#proposal-rewrite-text'].value,'候选正文：他走出门。');
  assert.equal(h.nodes['#proposal-rewrite-summary'].value,'候选摘要');assert.match(h.dialogs.at(-1),/原正文/);
  await h.submit();assert.equal(h.calls.length,1);assert.equal(h.context.current().text,'原正文');
});

test('durable rewrite payload stores editable candidates once and fits the complete chapter draft budget',async()=>{
  const h=harness();h.context.state.view='write';const p=rewriteProposal();p.text='😀'.repeat(100000);p.original.text='😀'.repeat(100000);
  const changes=Array.from({length:100},(_,i)=>({id:`c-${i}`,entity_id:'character-1',field:'location',value:'😀'.repeat(5000),evidence:'😀'.repeat(5000),selected:false}));
  p.changes=changes;p.original.changes=clone(changes);await h.context.showOutlineProposal(p);
  const payload=h.writes.at(-1).payload;assert.equal(payload.proposal.text,undefined);assert.equal(payload.proposal.changes,undefined);
  assert.equal(payload.proposal.original.changes,undefined);assert.equal(payload.proposal.original.change_count,100);
  assert.ok(Buffer.byteLength(JSON.stringify(payload),'utf8')<6000000);
});

test('discarding rewrite closes before draft deletion and delayed input cannot resurrect it',async()=>{
  const h=harness();h.context.state.view='write';await h.context.showOutlineProposal(rewriteProposal());
  const removing=deferred();h.context.removeRequest=()=>removing.promise;const discard=h.click('proposal-discard');await flush();
  assert.equal(h.dialog.open,false);const writes=h.writes.length;
  h.input('proposal-rewrite-text','迟到输入');assert.equal(h.writes.length,writes);
  removing.resolve();await discard;assert.equal(h.storage.size,0);
});

test('actual app and proposal listeners route the rewrite click and adoption exactly once',async()=>{
  const h=harness(new Map(),true);h.context.state.view='write';h.nodes['#rewrite-instructions']={id:'rewrite-instructions',value:'保留结尾，只减少解释',insertAdjacentHTML(){h.nodes['#proposal-rewrite-resume']={hidden:true};}};
  await h.click('rewrite');
  assert.equal(h.context.runs,1);assert.equal(h.calls.length,1);assert.equal(h.calls[0].body.action,'rewrite');
  assert.equal(h.calls[0].body.instructions,'保留结尾，只减少解释');assert.equal(h.context.current().text,'原正文');
  h.input('proposal-rewrite-text','跨模块核对后的正文');h.input('proposal-rewrite-summary','跨模块核对后的摘要');
  assert.equal(h.context.state.dirty,false);await h.submit();
  assert.equal(h.context.runs,2);assert.equal(h.calls.length,2);assert.equal(h.calls[1].body.action,'apply_rewrite_proposal');
  assert.equal(h.context.current().text,'跨模块核对后的正文');assert.equal(h.dialog.open,false);assert.deepEqual(h.errors,[]);
});

test('rewrite resume entry is independent of the scene plan entry',async()=>{
  const h=harness();h.context.state.view='write';delete h.nodes['#proposal-resume'];
  h.nodes['#rewrite-instructions']={insertAdjacentHTML(position,html){assert.match(html,/proposal-rewrite-resume/);h.nodes['#proposal-rewrite-resume']={hidden:true};}};
  await h.context.showOutlineProposal(rewriteProposal());assert.equal(h.nodes['#proposal-rewrite-resume'].hidden,false);
});
