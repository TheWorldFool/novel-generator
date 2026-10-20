'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function setup() {
  const listeners = {}, messages = [], calls = [], timers = new Map();
  let timerId=0;
  const state = {project:{id:'book',revision:1,chapters:[{id:'ch',text:'第一句',status:'approved'}]},
    dirty:true,busy:false,editVersion:1,view:'write',canon:[]};
  const label = {};
  const context = {navigator:{userAgent:'NovelGeneratorAndroid/0.2.0'},state,
    document:{documentElement:{classList:{add(){}}},addEventListener(name,callback){listeners[name]=callback;}},
    $: selector => selector === '#save-state' ? label : {open:false},
    currentSaveOperation:()=>['save_chapter',state.project.chapters[0]],
    accept(result){state.project=result.project;state.dirty=false;state.canon=result.canon;},
    api(path,body){return new Promise((resolve,reject)=>calls.push({path,body,resolve,reject}));},
    toast(message){messages.push(message);},
    setTimeout(fn){timers.set(++timerId,fn);return timerId;},clearTimeout(id){timers.delete(id);},
    Promise,JSON};
  context.window=context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('static/mobile.js','utf8'),context);
  const result = text => ({project:{id:'book',revision:2,chapters:[{id:'ch',text,status:'needs_review',review:null,versions:[]}]},canon:[]});
  async function fireTimer(){const pending=[...timers.values()];timers.clear();for(const fn of pending)fn();await Promise.resolve();}
  return {context,state,calls,messages,result,label,listeners,timers,fireTimer};
}

test('typing while autosave is in flight keeps newer text and saves it next',async()=>{
  const {context,state,calls,result}=setup();
  const first=context.mobileFlush();
  state.project.chapters[0].text='第一句，继续写下第二句';
  state.editVersion++;
  assert.equal(calls[0].body.data.text,'第一句');
  calls[0].resolve(result('第一句'));
  await first;
  assert.equal(state.project.chapters[0].text,'第一句，继续写下第二句');
  assert.equal(state.project.chapters[0].status,'needs_review');
  assert.equal(state.project.revision,2);
  assert.equal(state.dirty,true);
  const second=context.mobileFlush();
  assert.equal(calls[1].body.revision,2);
  assert.equal(calls[1].body.data.text,'第一句，继续写下第二句');
  calls[1].resolve({...result('第一句，继续写下第二句'),project:{...result('第一句，继续写下第二句').project,revision:3}});
  await second;
  assert.equal(state.dirty,false);
});

test('concurrent flush is serialized and back waits for persistence',async()=>{
  const {context,calls,result}=setup();
  const first=context.mobileFlush(), second=context.mobileFlush();
  assert.equal(first,second);
  assert.equal(calls.length,1);
  assert.equal(context.mobileBack(),'stay');
  calls[0].resolve(result('第一句'));
  await first;
  assert.equal(context.mobileBack(),'exit');
});

test('failed save preserves draft and stops silent retry',async()=>{
  const {context,state,calls,label}=setup();
  const first=context.mobileFlush();
  calls[0].reject(new Error('revision conflict'));
  await first;
  await context.mobileFlush();
  assert.equal(calls.length,1);
  assert.equal(state.dirty,true);
  assert.equal(state.project.chapters[0].text,'第一句');
  assert.equal(state.project.revision,1);
  assert.match(label.textContent,/失败/);
});

test('busy model operations do not start a competing autosave',async()=>{
  const {context,state,calls}=setup();
  state.busy=true;
  await context.mobileFlush();
  assert.equal(calls.length,0);
});

test('Android back waits for unfinished input persistence before leaving',async()=>{
  const {context,state,messages}=setup();
  state.dirty=false;
  let complete, pending=true;
  context.workDrafts={hasPending:()=>pending,flush:()=>new Promise(resolve=>{complete=()=>{pending=false;resolve();};})};
  assert.equal(context.mobileBack(),'stay');
  assert.equal(pending,true);
  complete();await Promise.resolve();
  assert.match(messages.at(-1),/草稿已保留/);
  assert.equal(context.mobileBack(),'exit');
});

test('a new edit can retry a transient failure once without looping on unchanged input',async()=>{
  const h=setup();const first=h.context.mobileFlush();
  h.calls[0].reject(new Error('service temporarily unavailable'));await first;
  h.listeners.input();await h.fireTimer();
  assert.equal(h.calls.length,1,'an unrelated input event does not retry the same edit');
  h.state.project.chapters[0].text='新的输入仍保留';h.state.editVersion++;
  h.listeners.input();await h.fireTimer();
  assert.equal(h.calls.length,2);assert.equal(h.calls[1].body.data.text,'新的输入仍保留');
  h.calls[1].reject(new Error('service temporarily unavailable'));await h.context.mobileSavePending;
  await h.fireTimer();await h.context.mobileFlush();
  assert.equal(h.calls.length,2);assert.equal(h.state.dirty,true);assert.equal(h.state.project.revision,1);
});

test('newer typing during a transient failed request gets one later attempt',async()=>{
  const h=setup();const first=h.context.mobileFlush();
  h.state.project.chapters[0].text='在保存过程中继续输入';h.state.editVersion++;
  h.listeners.input();await h.fireTimer();assert.equal(h.calls.length,1);
  h.calls[0].reject(new Error('temporary failure'));await first;
  await h.fireTimer();assert.equal(h.calls.length,2);
  assert.equal(h.calls[1].body.revision,1);assert.equal(h.calls[1].body.data.text,'在保存过程中继续输入');
  h.calls[1].reject(new Error('temporary failure'));await h.context.mobileSavePending;
  await h.fireTimer();assert.equal(h.calls.length,2);
});

test('a revision conflict stays blocked across new input until an accepted save succeeds',async()=>{
  const h=setup();const first=h.context.mobileFlush();
  h.calls[0].reject(Object.assign(new Error('revision conflict'),{status:409}));await first;
  h.state.editVersion++;h.state.project.chapters[0].text='冲突后的输入';h.listeners.input();
  await h.fireTimer();assert.equal(h.calls.length,1);assert.equal(h.state.project.revision,1);
  h.context.mobileSaveSucceeded({projectId:'another',revision:1});
  h.context.mobileSaveSucceeded({projectId:'book',revision:2});
  await h.context.mobileFlush();assert.equal(h.calls.length,1,'unaccepted or other-project results do not unblock');
  // Only the caller which accepted a successful server response may report it.
  h.state.project.revision=3;h.context.mobileSaveSucceeded({projectId:'book',revision:3});
  await h.fireTimer();assert.equal(h.calls.length,2);assert.equal(h.calls[1].body.revision,3);
  h.calls[1].resolve({...h.result('冲突后的输入'),project:{...h.result('冲突后的输入').project,revision:4}});
  await h.context.mobileSavePending;assert.equal(h.state.dirty,false);
});

test('an explicit back retry preserves the stale revision and does not unlock a repeated conflict',async()=>{
  const h=setup();let pending=h.context.mobileFlush();
  h.calls[0].reject(Object.assign(new Error('revision conflict'),{status:409}));await pending;
  assert.equal(h.context.mobileBack(),'stay');assert.equal(h.calls.length,2);
  assert.equal(h.calls[1].body.revision,1);
  h.calls[1].reject(Object.assign(new Error('revision conflict'),{status:409}));await h.context.mobileSavePending;
  h.state.editVersion++;h.listeners.input();await h.fireTimer();assert.equal(h.calls.length,2);
  assert.equal(h.state.dirty,true);assert.equal(h.state.project.revision,1);
});

// Load the actual app save and input/navigation/keyboard listeners. Only visual
// rendering and busy decoration are replaced by a small DOM; persistence uses
// app.js's real api(), saveCurrent(), mutate(), and accept() implementations.
function appHarness() {
  const listeners={},nodes={},calls=[],timers=new Map();let timerId=0;
  const chapter=(id,text)=>({id,title:id,intent:'',outline:'',text,summary:'摘要',cast:[],changes:[],status:'draft'});
  const server={id:'book',revision:1,chapters:[chapter('one','第一章原文'),chapter('two','第二章原文')]};
  for(const key of ['title','intent','outline','text','summary'])nodes['#chapter-'+key]={id:'chapter-'+key,value:''};
  Object.assign(nodes,{'#save-state':{},'#word-count':{},'#toast':{},'#dialog':{open:false}});
  const input=nodes['#chapter-text'];
  input.closest=()=>null;input.matches=selector=>selector==='textarea, input';
  const context={navigator:{userAgent:'NovelGeneratorAndroid/0.2.5'},console,Promise,JSON,Map,
    document:{documentElement:{classList:{add(){}}},querySelector:selector=>nodes[selector]??null,querySelectorAll:()=>[],addEventListener(type,fn){(listeners[type]||=[]).push(fn);}},
    addEventListener(){},captureChapterOutline(){},
    setTimeout(fn,delay){timers.set(++timerId,{fn,delay});return timerId;},clearTimeout(id){timers.delete(id);},
    fetch(path,options){return new Promise(resolve=>calls.push({path,body:JSON.parse(options.body),respond(status,data){resolve({ok:status<400,status,json:async()=>data});}}));},
  };
  context.window=context;vm.createContext(context);
  const app=fs.readFileSync('static/app.js','utf8').replace(/\ninit\(\);\s*$/,'\n');
  vm.runInContext(app,context,{filename:'app.js'});
  vm.runInContext(`globalThis.testApp={state,saveCurrent,current};setBusy=function(value){state.busy=value;};render=function(){if(state.view==='write'){for(const key of ['title','intent','outline','text','summary'])$('#chapter-'+key).value=current()[key];}};`,context);
  context.testApp.state.project=structuredClone(server);context.testApp.state.chapterId='one';
  vm.runInContext('render();',context);
  vm.runInContext(fs.readFileSync('static/mobile.js','utf8'),context,{filename:'mobile.js'});
  async function drain(){for(let i=0;i<30;i++)await Promise.resolve();}
  function dispatch(type,event){for(const fn of listeners[type]||[])fn(event);}
  function type(text){input.value=text;dispatch('input',{target:input});}
  async function fireTimer(){const ready=[...timers.entries()].filter(([,t])=>t.delay===1800);for(const [id,t]of ready){timers.delete(id);t.fn();}await drain();}
  function succeed(index){const call=calls[index];assert.equal(call.body.revision,server.revision);Object.assign(server.chapters.find(c=>c.id===call.body.data.id),structuredClone(call.body.data));server.revision++;call.respond(200,{project:structuredClone(server),canon:[]});}
  async function failFirst(status=503){type('尚未保存的修改');const pending=context.mobileFlush();calls[0].respond(status,{error:status===409?'revision conflict':'service unavailable'});await pending;}
  return{context,state:context.testApp.state,nodes,calls,server,type,fireTimer,succeed,failFirst,drain,
    click(action,id){dispatch('click',{target:{closest(){return{dataset:{action,id}};}}});},
    ctrlS(){dispatch('keydown',{ctrlKey:true,key:'s',preventDefault(){}});}};
}

test('saving successfully before a chapter switch resumes autosave for later real edits',async()=>{
  const h=appHarness();await h.failFirst();
  h.click('chapter','two');await h.drain();assert.equal(h.calls.length,2);
  assert.equal(h.state.chapterId,'one');h.succeed(1);await h.drain();
  assert.equal(h.state.chapterId,'two');assert.equal(h.state.dirty,false);
  h.type('第二章继续修改');await h.fireTimer();
  assert.equal(h.calls.length,3);assert.equal(h.calls[2].body.data.id,'two');
  assert.equal(h.calls[2].body.revision,2);assert.equal(h.calls[2].body.data.text,'第二章继续修改');
  h.succeed(2);await h.drain();assert.equal(h.state.dirty,false);
  assert.equal(h.server.chapters[0].text,'尚未保存的修改');assert.equal(h.server.chapters[1].text,'第二章继续修改');
});

test('real editor typing during a recovered autosave keeps the newest text until the next save',async()=>{
  const h=appHarness();await h.failFirst();
  h.ctrlS();await h.drain();h.succeed(1);await h.drain();
  h.type('这一轮自动保存的原文');await h.fireTimer();assert.equal(h.calls.length,3);
  h.type('这一轮自动保存的原文，写入时又加了一句');
  h.succeed(2);await h.drain();
  assert.equal(h.nodes['#chapter-text'].value,'这一轮自动保存的原文，写入时又加了一句');
  assert.equal(h.state.dirty,true);assert.equal(h.state.project.revision,3);
  await h.fireTimer();assert.equal(h.calls.length,4);
  assert.equal(h.calls[3].body.revision,3);assert.equal(h.calls[3].body.data.text,h.nodes['#chapter-text'].value);
  h.succeed(3);await h.drain();assert.equal(h.state.dirty,false);
  assert.equal(h.server.chapters[0].text,'这一轮自动保存的原文，写入时又加了一句');
});

test('a successful Ctrl+S resumes autosave after a conflict without guessing a newer revision',async()=>{
  const h=appHarness();await h.failFirst(409);
  h.type('冲突后手工保留的文字');await h.fireTimer();assert.equal(h.calls.length,1);
  h.ctrlS();await h.drain();assert.equal(h.calls.length,2);assert.equal(h.calls[1].body.revision,1);
  h.succeed(1);await h.drain();assert.equal(h.state.dirty,false);
  h.type('保存后又新增一句');await h.fireTimer();assert.equal(h.calls.length,3);
  assert.equal(h.calls[2].body.revision,2);assert.equal(h.calls[2].body.data.text,'保存后又新增一句');
  h.succeed(2);await h.drain();assert.equal(h.state.dirty,false);
});

test('failed manual saves do not resume a conflicting autosave or lose the real editor text',async()=>{
  const h=appHarness();await h.failFirst(409);
  h.click('save');await h.drain();assert.equal(h.calls.length,2);
  h.calls[1].respond(409,{error:'revision conflict'});await h.drain();
  h.type('仍在编辑器中，不能被旧稿覆盖');await h.fireTimer();
  assert.equal(h.calls.length,2);assert.equal(h.state.project.revision,1);assert.equal(h.state.dirty,true);
  assert.equal(h.nodes['#chapter-text'].value,'仍在编辑器中，不能被旧稿覆盖');
  assert.equal(h.server.chapters[0].text,'第一章原文');
});
