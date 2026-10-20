'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'..','static','proposals.js'),'utf8');
const decode=text=>text.replace(/&(amp|lt|gt|quot|#39);/g,(_,key)=>({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"}[key]));
const clone=value=>structuredClone(value);

function outlineProposal(){return {kind:'outline',source_revision:3,source_hash:'outline-source',
  original:{text:'作者原文',ending:'作者结局',guardrails:'作者约束',nodes:[{id:'manual',title:'手改节点',goal:'手改目标'}]},
  draft:{text:'作者原文',ending:'作者结局',guardrails:'作者约束',nodes:[
    {id:'candidate-1',title:'候选一',goal:'目标一',must:'事件一',avoid:'禁区一',source_quote:''},
    {id:'candidate-2',title:'候选二',goal:'目标二',must:'事件二',avoid:'禁区二',source_quote:''}]}};}
function planProposal(){return {kind:'plan',chapter_id:'chapter-1',source_revision:3,source_hash:'scene-source',original:'手改场景方案',outline:'AI候选场景方案'};}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const flush=()=>new Promise(resolve=>setImmediate(resolve));

function harness(storage=new Map()){
  const nodes={},listeners={},calls=[],writes=[],errors=[],messages=[],dialogs=[];
  const dialog=nodes['#dialog']={id:'dialog',open:false,close(){this.open=false;dispatch('close',{type:'close',target:this});}};
  nodes['#proposal-resume']={hidden:true};
  const context={console,Map,Error,Promise,structuredClone,
    state:{busy:false,dirty:false,view:'outline',settings:{base_url:'https://model.invalid/v1',model:'configured'},
      project:{id:'book-1',revision:3,book_outline:{draft:clone(outlineProposal().original)},chapters:[{id:'chapter-1',outline:'手改场景方案',text:'原正文'}]}},
    document:{addEventListener(type,fn){(listeners[type]||=[]).push(fn);}},
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
    },
    toast(message,error){(error?errors:messages).push(message);},
    render(){context.renders=(context.renders||0)+1;},
    accept(result){context.state.project=result.project;context.state.dirty=false;},
    async saveCurrent(){context.saves=(context.saves||0)+1;context.state.dirty=false;},
    async api(url,body){
      calls.push({url,body:clone(body)});
      if(context.request)return context.request(url,body);
      if(!url.endsWith('/mutate'))return {proposal:body.action==='plan'?planProposal():outlineProposal()};
      return updated(body);
    },
    run(fn){context.state.busy=true;context.pending=Promise.resolve().then(fn).catch(e=>errors.push(e.message)).finally(()=>{context.state.busy=false;});},
    workDrafts:{
      async read(key,pid){return clone(storage.get(`${pid}:${key}`)||null);},
      async write(key,payload,pid){writes.push({key,pid,payload:clone(payload)});if(context.writeError)throw new Error(context.writeError);storage.set(`${pid}:${key}`,clone(payload));if(context.writeRequest)await context.writeRequest(key,payload,pid);},
      async remove(key,pid){if(context.removeError)throw new Error(context.removeError);if(context.removeRequest)await context.removeRequest(key,pid);storage.delete(`${pid}:${key}`);},
    },
  };
  function addNode(id,value){return nodes['#'+id]={id,value,closest(selector){return selector==='#proposal-form'?nodes['#proposal-form']:null;}};}
  function updated(body){const project=clone(context.state.project);project.revision++;
    if(body.action==='apply_plan_proposal')project.chapters[0].outline=body.data.outline;
    else project.book_outline.draft={...body.data.draft,nodes:body.data.mode==='append'?[...project.book_outline.draft.nodes,...body.data.draft.nodes]:body.data.draft.nodes};
    return {project,canon:[]};}
  context.window=context;vm.createContext(context);vm.runInContext(source,context,{filename:'proposals.js'});
  function dispatch(type,event){for(const fn of listeners[type]||[])fn(event);}
  function click(action){dispatch('click',{target:{closest(){return {dataset:{action}};}},preventDefault(){}});return context.pending||Promise.resolve();}
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
