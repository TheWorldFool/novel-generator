'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname,'..','static','revisions.js'),'utf8');

function harness() {
  const listeners={},nodes={},entries=[],dialogs=[],errors=[],messages=[],focused=[];
  let saved=0,rendered=0,closed=0;
  const chapters=[
    {id:'one',title:'第一章 <img src=x>',text:'旧章需要核对。',status:'needs_review',node_id:'start'},
    {id:'two',title:'第二章',text:'后章也可以先微调。',status:'draft',node_id:'finish'},
    {id:'three',title:'第三章空稿',text:'',status:'draft',node_id:'finish'},
    {id:'four',title:'已确认的正文',text:'仍可以打开修改。',status:'approved',node_id:'finish'},
  ];
  nodes['.workspace']={insertAdjacentHTML(position,html){entries.push({position,html});nodes['#revisions-entry']={};}};
  nodes['#dialog']={close(){closed++;}};
  nodes['.editor-card']={scrollIntoView(){}};
  for (const selector of ['#chapter-text','#chapter-summary','#chapter-node-id']) nodes[selector]={focus(){focused.push(selector);}};
  const context={Map,Set,Error,Promise,
    document:{addEventListener(type,fn){(listeners[type]||=[]).push(fn);}},
    state:{project:{id:'book',chapters,book_outline:{active:{nodes:[{id:'start',title:'调查'},{id:'finish',title:'揭晓'}]}}},view:'write',chapterId:'two',editorTab:'text',sideTab:'memory',busy:false,dirty:false},
    $(selector){return nodes[selector]||null;},
    current(){return context.state.project.chapters.find(chapter=>chapter.id===context.state.chapterId);},
    esc(value){return String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));},
    showDialog(html){dialogs.push(html);},
    toast(message,error){(error?errors:messages).push(message);},
    async saveCurrent(){saved++;if(context.save)await context.save();context.state.dirty=false;},
    render(){rendered++;},
    run(fn){if(context.state.busy)return;context.state.busy=true;context.pending=Promise.resolve().then(fn).catch(error=>errors.push(error.message)).finally(()=>{context.state.busy=false;});},
  };
  context.window=context;vm.createContext(context);vm.runInContext(source,context,{filename:'revisions.js'});
  async function click(action,extra={}) {
    const button={dataset:{action,...extra}};
    for(const fn of listeners.click||[])fn({target:{closest(){return button;}},preventDefault(){}});
    await context.pending;
  }
  return {context,nodes,chapters,entries,dialogs,errors,messages,focused,click,
    get saved(){return saved;},get rendered(){return rendered;},get closed(){return closed;}};
}

test('workbench entry names pending chapters and is idempotent outside a fresh render',()=>{
  const h=harness();h.context.decorateRevisions();h.context.decorateRevisions();
  assert.equal(h.entries.length,1);
  assert.equal(h.entries[0].position,'beforebegin');
  assert.match(h.entries[0].html,/2 章已有正文等待处理/);
  assert.match(h.entries[0].html,/第一章 &lt;img src=x&gt;/);
  assert.match(h.entries[0].html,/data-action="revisions-open"/);
  assert.match(h.entries[0].html,/返回顺序复核/);
  const other=harness();other.context.state.view='story';other.context.decorateRevisions();assert.equal(other.entries.length,0);
});

test('real open event saves first and lists prior blockers without offering batch approval',async()=>{
  const h=harness();const before=structuredClone(h.context.state.project);
  await h.click('revisions-open');
  assert.equal(h.saved,1);assert.equal(h.dialogs.length,1);
  assert.match(h.dialogs[0],/待复核与已有正文的草稿 · 2 章/);
  assert.match(h.dialogs[0],/前文《第一章 &lt;img src=x&gt;》尚未确认/);
  assert.match(h.dialogs[0],/data-id="two" data-tab="text"/);
  assert.match(h.dialogs[0],/已确认正文 · 1 章/);
  assert.doesNotMatch(h.dialogs[0],/data-action="(?:approve|confirm-approve)"/);
  assert.doesNotMatch(h.dialogs[0],/<img src=x>/);
  assert.deepEqual(h.context.state.project,before);
});

test('later chapter navigation waits for saved text and does not confirm anything',async()=>{
  const h=harness();h.context.state.chapterId='one';h.context.state.dirty=true;
  let complete;h.context.save=()=>new Promise(resolve=>{complete=resolve;});
  const pending=h.click('revisions-chapter',{id:'two',tab:'text'});
  while(!complete)await Promise.resolve();
  assert.equal(h.context.state.chapterId,'one');assert.equal(h.rendered,0);
  complete();await pending;
  assert.equal(h.context.state.chapterId,'two');assert.equal(h.context.state.editorTab,'text');
  assert.deepEqual(h.focused,['#chapter-text']);assert.equal(h.closed,1);assert.equal(h.rendered,1);
  assert.equal(h.chapters[0].status,'needs_review');assert.equal(h.chapters[1].status,'draft');
});

test('return to sequential review opens the first unconfirmed memory and candidate changes',async()=>{
  const h=harness();await h.click('revisions-chapter',{id:'two',tab:'text'});
  await h.click('revisions-next');
  assert.equal(h.context.state.chapterId,'one');assert.equal(h.context.state.editorTab,'summary');
  assert.equal(h.context.state.sideTab,'changes');assert.equal(h.focused.at(-1),'#chapter-summary');
  assert.equal(h.chapters[0].status,'needs_review');
});

test('an earlier empty chapter is shown as a blocker and opens prose instead of pretending it is ready',async()=>{
  const h=harness();h.chapters[0].text='';
  await h.click('revisions-open');
  assert.match(h.dialogs.at(-1),/正文还为空/);
  assert.match(h.dialogs.at(-1),/待复核与已有正文的草稿 · 1 章/);
  await h.click('revisions-next');
  assert.equal(h.context.state.chapterId,'one');assert.equal(h.context.state.editorTab,'text');
  assert.match(h.messages.at(-1),/正文还为空/);
});

test('invalid stage binding and unfinished earlier milestone open the scene selector for review',async()=>{
  const h=harness();h.chapters[0].node_id='removed';
  await h.click('revisions-next');
  assert.equal(h.context.state.editorTab,'outline');assert.equal(h.focused.at(-1),'#chapter-node-id');
  assert.match(h.messages.at(-1),/尚未绑定有效大纲阶段/);
  h.chapters[0].status='approved';h.chapters[0].completes_node=false;
  await h.click('revisions-next');
  assert.equal(h.context.state.chapterId,'two');assert.equal(h.context.state.editorTab,'outline');
  assert.match(h.messages.at(-1),/前置阶段「调查」尚未确认完成/);
});

test('existing approved prose remains available for a deliberate edit',async()=>{
  const h=harness();await h.click('revisions-chapter',{id:'four',tab:'text'});
  assert.equal(h.context.state.chapterId,'four');assert.equal(h.context.state.editorTab,'text');
  assert.equal(h.chapters[3].status,'approved');
});

test('a failed save keeps the author at the old chapter and never closes their dialog',async()=>{
  const h=harness();h.context.save=async()=>{throw new Error('保存失败');};
  await h.click('revisions-chapter',{id:'one',tab:'summary'});
  assert.equal(h.context.state.chapterId,'two');assert.equal(h.rendered,0);assert.equal(h.closed,0);
  assert.deepEqual(h.errors,['保存失败']);
});

test('switching projects during save prevents stale chapter navigation',async()=>{
  const h=harness();h.context.save=async()=>{h.context.state.project.id='another-book';};
  await h.click('revisions-chapter',{id:'one',tab:'text'});
  assert.equal(h.context.state.chapterId,'two');assert.equal(h.rendered,0);
  assert.match(h.errors[0],/作品已切换/);
});

test('all approved state has no pending action and duplicate busy clicks do nothing',async()=>{
  const h=harness();h.chapters.forEach(chapter=>{chapter.status='approved';});
  await h.click('revisions-open');assert.match(h.dialogs.at(-1),/当前章节均已确认/);
  await h.click('revisions-next');assert.equal(h.rendered,0);assert.match(h.messages.at(-1),/没有等待按顺序复核/);
  h.context.state.busy=true;const saved=h.saved;
  await h.click('revisions-open');assert.equal(h.saved,saved);
});
