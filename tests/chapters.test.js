'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname,'..','static','chapters.js'),'utf8');
const plain = value=>JSON.parse(JSON.stringify(value));

function harness() {
  const listeners={},nodes={},dialogs=[],entries=[],errors=[],mutations=[],messages=[];
  let saved=0,rendered=0,closed=0;
  nodes['.chapter-heading']={insertAdjacentHTML(position,html){entries.push(html);nodes['#chapter-manager-entry']={};}};
  nodes['#dialog']={close(){closed++;}};
  const context={Set,Map,Error,Promise,
    document:{addEventListener(type,fn){(listeners[type]||=[]).push(fn);}},
    state:{project:{id:'book',revision:4,chapters:[
      {id:'one',title:'甲章 <img src=x>',text:'正文 <script>alert(1)</script>。',summary:'首章',status:'approved',changes:[{value:'码头'}],versions:[{text:'旧稿'}]},
      {id:'two',title:'乙章',text:'',summary:'',status:'draft',changes:[],versions:[]},
      {id:'three',title:'丙章',text:'待核对正文',summary:'后章',status:'needs_review',changes:[],versions:[]},
    ],chapter_trash:[]},view:'write',chapterId:'two',editorTab:'text',busy:false,dirty:true},
    $(selector){return nodes[selector]||null;},
    current(){return context.state.project.chapters.find(c=>c.id === context.state.chapterId) || context.state.project.chapters[0];},
    esc(value){return String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));},
    date(){return '10-20 12:00';},
    toast(message,error){(error?errors:messages).push(message);},
    showDialog(html){dialogs.push(html);if(html.includes('id="chapter-insert-title"'))nodes['#chapter-insert-title']={value:'新的章节',select(){}};if(html.includes('id="chapter-delete-checked"'))nodes['#chapter-delete-checked']={checked:false};},
    async saveCurrent(){saved++;if(context.save)await context.save();context.state.dirty=false;},
    async mutate(action,data){
      mutations.push([action,plain(data)]);
      if(context.mutation)return context.mutation(action,data);
      const project=structuredClone(context.state.project),chapters=project.chapters;
      if(action==='insert_chapter')chapters.splice(chapters.findIndex(c=>c.id === data.id)+(data.position==='after'?1:0),0,{id:'new',title:data.title,text:'',status:'draft',changes:[],versions:[]});
      if(action==='move_chapter'){const index=chapters.findIndex(c=>c.id === data.id),to=index+(data.direction==='up'?-1:1);[chapters[index],chapters[to]]=[chapters[to],chapters[index]];}
      if(action==='delete_chapter'){const index=chapters.findIndex(c=>c.id === data.id);project.chapter_trash.push({id:'trash',chapter:chapters[index],index,deleted_at:'2026-10-20'});chapters.splice(index,1);}
      if(action==='restore_chapter'){const index=project.chapter_trash.findIndex(e=>e.id === data.trash_id),entry=project.chapter_trash[index];chapters.splice(Math.min(entry.index,chapters.length),0,{...entry.chapter,status:'needs_review'});project.chapter_trash.splice(index,1);}
      project.revision++;context.state.project=project;
    },
    render(){rendered++;},
    run(fn){if(context.state.busy)return;context.state.busy=true;context.pending=Promise.resolve().then(fn).catch(error=>errors.push(error.message)).finally(()=>{context.state.busy=false;});},
  };
  context.window=context;vm.createContext(context);vm.runInContext(source,context,{filename:'chapters.js'});
  async function click(action,extra={},disabled=false){const button={dataset:{action,...extra},disabled};for(const fn of listeners.click||[])fn({target:{closest(){return button;}},preventDefault(){}});await context.pending;}
  return {context,nodes,dialogs,entries,errors,mutations,messages,click,get saved(){return saved;},get rendered(){return rendered;},get closed(){return closed;}};
}

test('chapter manager entry is available once and safely lists every chapter with boundaries',async()=>{
  const h=harness();h.context.decorateChapters();h.context.decorateChapters();assert.equal(h.entries.length,1);
  assert.match(h.entries[0],/chapter-manage/);await h.click('chapter-manage');
  assert.equal(h.saved,1);assert.equal(h.mutations.length,0);
  const html=h.dialogs.at(-1);assert.match(html,/甲章 &lt;img src=x&gt;/);assert.doesNotMatch(html,/<img src=x>/);
  assert.match(html,/data-id="one" data-direction="up" disabled/);
  assert.match(html,/data-id="three" data-direction="down" disabled/);
  assert.match(html,/回收站 · 0 \/ 30/);assert.match(html,/后文需按新顺序核对/);
});

test('inserting before a chosen chapter saves first and opens the new stable chapter',async()=>{
  const h=harness();await h.click('chapter-manage');await h.click('chapter-insert',{id:'three',position:'before'});
  assert.match(h.dialogs.at(-1),/在《丙章》之前插入/);assert.equal(h.mutations.length,0);
  h.nodes['#chapter-insert-title'].value='  中场  ';await h.click('chapter-confirm-insert');
  assert.deepEqual(h.mutations,[['insert_chapter',{id:'three',position:'before',title:'中场'}]]);
  assert.deepEqual(h.context.state.project.chapters.map(c=>c.id),['one','two','new','three']);
  assert.equal(h.context.state.chapterId,'new');assert.equal(h.context.state.editorTab,'outline');
  assert.equal(h.closed,1);assert.equal(h.rendered,1);assert.equal(h.saved,3);
});

test('insert after last works and empty title cannot mutate or close the author dialog',async()=>{
  const h=harness();await h.click('chapter-manage');await h.click('chapter-insert',{id:'three',position:'after'});
  h.nodes['#chapter-insert-title'].value='  ';await h.click('chapter-confirm-insert');
  assert.match(h.errors.at(-1),/填写新章节标题/);assert.equal(h.mutations.length,0);assert.equal(h.closed,0);
  h.nodes['#chapter-insert-title'].value='尾声';await h.click('chapter-confirm-insert');
  assert.equal(h.context.state.project.chapters.at(-1).title,'尾声');
});

test('adjacent move preserves current chapter selection and refreshes the concrete order',async()=>{
  const h=harness();await h.click('chapter-manage');await h.click('chapter-move',{id:'three',direction:'up'});
  assert.deepEqual(h.mutations,[['move_chapter',{id:'three',direction:'up'}]]);
  assert.deepEqual(h.context.state.project.chapters.map(c=>c.id),['one','three','two']);
  assert.equal(h.context.state.chapterId,'two');assert.equal(h.rendered,1);
  assert.match(h.dialogs.at(-1),/2\. 丙章/);assert.match(h.dialogs.at(-1),/3\. 乙章/);
});

test('delete first shows concrete prose, candidates and history, and requires author check',async()=>{
  const h=harness();await h.click('chapter-manage');await h.click('chapter-delete',{id:'one'});
  const html=h.dialogs.at(-1);assert.match(html,/1 项状态候选和 1 份历史版本/);
  assert.match(html,/正文 &lt;script&gt;alert\(1\)&lt;\/script&gt;/);assert.doesNotMatch(html,/<script>/);
  assert.match(html,/不再进入正式记忆/);assert.equal(h.mutations.length,0);
  await h.click('chapter-confirm-delete');assert.equal(h.mutations.length,0);assert.match(h.errors.at(-1),/勾选确认/);
  h.nodes['#chapter-delete-checked'].checked=true;await h.click('chapter-confirm-delete');
  assert.deepEqual(h.mutations,[['delete_chapter',{id:'one',confirm_title:'甲章 <img src=x>'}]]);
  assert.equal(h.context.state.project.chapter_trash[0].chapter.id,'one');
  assert.match(h.dialogs.at(-1),/回收站 · 1 \/ 30/);assert.match(h.dialogs.at(-1),/chapter-restore/);
});

test('moving current chapter into trash selects its next remaining neighbor and can restore it',async()=>{
  const h=harness();await h.click('chapter-manage');await h.click('chapter-delete',{id:'two'});
  h.nodes['#chapter-delete-checked'].checked=true;await h.click('chapter-confirm-delete');
  assert.equal(h.context.state.chapterId,'three');assert.deepEqual(h.context.state.project.chapters.map(c=>c.id),['one','three']);
  await h.click('chapter-restore',{id:'trash'});
  assert.deepEqual(h.mutations.at(-1),['restore_chapter',{trash_id:'trash'}]);
  assert.deepEqual(h.context.state.project.chapters.map(c=>c.id),['one','two','three']);
  assert.equal(h.context.state.project.chapters[1].status,'needs_review');assert.equal(h.context.state.project.chapter_trash.length,0);
});

test('the sole chapter and disabled boundary controls cannot be removed through the UI',async()=>{
  const h=harness();h.context.state.project.chapters=h.context.state.project.chapters.slice(0,1);await h.click('chapter-manage');
  assert.match(h.dialogs.at(-1),/data-action="chapter-delete" data-id="one" disabled/);
  await h.click('chapter-delete',{id:'one'},true);await h.click('chapter-move',{id:'one',direction:'up'},true);
  assert.equal(h.mutations.length,0);assert.equal(h.dialogs.length,1);
});

test('failed saves prevent insert, move and delete from changing the directory',async()=>{
  const h=harness();await h.click('chapter-manage');const original=structuredClone(h.context.state.project);
  h.context.save=async()=>{throw new Error('保存失败，正文保留');};
  await h.click('chapter-move',{id:'three',direction:'up'});
  assert.equal(h.mutations.length,0);assert.equal(h.rendered,0);assert.equal(h.closed,0);
  assert.deepEqual(h.context.state.project,original);assert.match(h.errors.at(-1),/保存失败/);
});

test('deletion is rejected if the title or project changes after concrete confirmation',async()=>{
  const h=harness();await h.click('chapter-manage');await h.click('chapter-delete',{id:'one'});
  h.nodes['#chapter-delete-checked'].checked=true;h.context.state.project.chapters[0].title='已改名';
  await h.click('chapter-confirm-delete');assert.equal(h.mutations.length,0);assert.match(h.errors.at(-1),/标题已改变/);
  h.context.state.project.id='another';await h.click('chapter-confirm-delete');
  assert.equal(h.mutations.length,0);assert.match(h.errors.at(-1),/管理已过期/);
});

test('switching project during save cannot mutate a new book or navigate to an old chapter',async()=>{
  const h=harness();await h.click('chapter-manage');h.context.save=async()=>{h.context.state.project.id='another';};
  await h.click('chapter-open',{id:'one'});assert.equal(h.context.state.chapterId,'two');assert.equal(h.rendered,0);
  assert.match(h.errors.at(-1),/作品已切换/);assert.equal(h.mutations.length,0);
});

test('open chapter keeps prose ready to edit without invoking a mutation',async()=>{
  const h=harness();await h.click('chapter-manage');await h.click('chapter-open',{id:'one'});
  assert.equal(h.context.state.chapterId,'one');assert.equal(h.context.state.view,'write');assert.equal(h.context.state.editorTab,'text');
  assert.equal(h.closed,1);assert.equal(h.mutations.length,0);
});

test('server rejection retains the author confirmation and busy double clicks do nothing',async()=>{
  const h=harness();await h.click('chapter-manage');await h.click('chapter-delete',{id:'one'});h.nodes['#chapter-delete-checked'].checked=true;
  h.context.mutation=async()=>{throw new Error('回收站已满');};await h.click('chapter-confirm-delete');
  assert.equal(h.rendered,0);assert.equal(h.closed,0);assert.equal(h.context.state.project.chapters.length,3);assert.match(h.errors.at(-1),/回收站已满/);
  const saved=h.saved;h.context.state.busy=true;await h.click('chapter-manage');assert.equal(h.saved,saved);
});

function appHarness() {
  const listeners={},nodes={},dialogs=[],requests=[],errors=[];
  let runs=0,saves=0;
  const dialog=nodes['#dialog']={open:false,showModal(){this.open=true;},close(){this.open=false;}};
  Object.defineProperty(dialog,'innerHTML',{set(html){
    dialogs.push(html);
    if(html.includes('id="chapter-insert-title"'))nodes['#chapter-insert-title']={value:'新的章节',select(){}};
    if(html.includes('id="chapter-delete-checked"'))nodes['#chapter-delete-checked']={checked:false};
  }});
  const context={console,Promise,Map,Set,Error,Date,Intl,
    document:{querySelector(selector){return nodes[selector]||null;},querySelectorAll(){return [];},addEventListener(type,fn){(listeners[type]||=[]).push(fn);}},
    addEventListener(){},FormData(){throw new Error('Chapter management does not use the app form submit handler.');},
  };
  context.window=context;vm.createContext(context);
  vm.runInContext(source,context,{filename:'chapters.js'});
  const appSource=fs.readFileSync(path.join(__dirname,'..','static','app.js'),'utf8').replace(/\binit\(\);\s*$/,'');
  vm.runInContext(appSource,context,{filename:'app.js'});
  vm.runInContext('globalThis.workbenchState=state;',context);
  const state=context.workbenchState;
  state.project={id:'book',title:'测试',revision:3,chapters:[{id:'one',title:'第一章',text:'已有正文。',summary:'已有摘要',status:'approved',changes:[],versions:[]},{id:'two',title:'第二章',text:'',summary:'',status:'draft',changes:[],versions:[]}],chapter_trash:[]};
  state.chapterId='one';
  context.run=fn=>{runs++;context.pending=Promise.resolve().then(fn).catch(error=>errors.push(error.message));};
  context.saveCurrent=async()=>{saves++;};context.render=()=>{};context.toast=()=>{};
  context.api=async(url,body)=>{
    requests.push({url,body:plain(body)});const project=structuredClone(state.project),{action,data}=body;
    if(action==='insert_chapter')project.chapters.splice(data.position==='before'?0:1,0,{id:'inserted',title:data.title,text:'',summary:'',status:'draft',changes:[],versions:[]});
    if(action==='delete_chapter'){const index=project.chapters.findIndex(c=>c.id === data.id);project.chapter_trash.push({id:'trash',chapter:project.chapters[index],index,deleted_at:'2026-10-20'});project.chapters.splice(index,1);}
    project.revision++;return {project,canon:[]};
  };
  async function click(action,extra={}) {const button={dataset:{action,...extra}};for(const fn of listeners.click||[])fn({target:{closest(){return button;}},preventDefault(){}});await context.pending;}
  return {context,state,nodes,dialogs,requests,errors,click,get runs(){return runs;},get saves(){return saves;}};
}

test('real app and chapter listeners open management once and insert through one actual mutate request',async()=>{
  const h=appHarness();await h.click('chapter-manage');
  assert.equal(h.dialogs.length,1);assert.equal(h.runs,1);assert.equal(h.saves,1);assert.equal(h.requests.length,0);
  await h.click('chapter-insert',{id:'one',position:'after'});h.nodes['#chapter-insert-title'].value='间章';
  await h.click('chapter-confirm-insert');
  assert.equal(h.runs,3);assert.equal(h.saves,3);assert.equal(h.requests.length,1);
  assert.deepEqual(h.requests[0],{url:'/api/projects/book/mutate',body:{revision:3,action:'insert_chapter',data:{id:'one',position:'after',title:'间章'}}});
  assert.equal(h.state.chapterId,'inserted');assert.equal(h.state.project.revision,4);assert.deepEqual(h.errors,[]);
});

test('real app and chapter listeners preserve the confirmation gate and send one deletion mutation',async()=>{
  const h=appHarness();await h.click('chapter-manage');await h.click('chapter-delete',{id:'one'});
  assert.equal(h.dialogs.length,2);assert.equal(h.requests.length,0);
  await h.click('chapter-confirm-delete');assert.equal(h.requests.length,0);assert.match(h.errors[0],/勾选确认/);
  h.nodes['#chapter-delete-checked'].checked=true;await h.click('chapter-confirm-delete');
  assert.equal(h.requests.length,1);assert.deepEqual(h.requests[0].body,{revision:3,action:'delete_chapter',data:{id:'one',confirm_title:'第一章'}});
  assert.equal(h.state.chapterId,'two');assert.equal(h.state.project.chapter_trash[0].chapter.text,'已有正文。');
  assert.equal(h.dialogs.length,3);assert.equal(h.runs,4);
});
