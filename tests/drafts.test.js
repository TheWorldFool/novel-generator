'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname,'..','static','drafts.js'),'utf8');
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));

// Run the production service and listeners. This DOM represents ordinary forms,
// while the API fixture enforces the same optimistic versions as SQLite.
function harness({store=new Map(),fail}={}) {
  const listeners={},windowListeners={},calls=[],messages=[];
  const timers = new Map(); let timerId=0;
  let currentForm=null;
  function node(tag='div') {
    return {tagName:tag.toUpperCase(),dataset:{},children:[],classList:{toggle(){}},
      setAttribute(){},append(...children){this.children.push(...children);},prepend(child){this.children.unshift(child);}};
  }
  const dialog={open:false,querySelector(){return currentForm;},close(){this.open=false;}};
  const context={Map,Set,Promise,Math,Error,JSON,console,Event:class {constructor(type,options){this.type=type;Object.assign(this,options);}},
    document:{visibilityState:'visible',querySelector(selector){return selector==='#dialog'?dialog:null;},
      addEventListener(type,fn){(listeners[type]||=[]).push(fn);},createElement:node,createTextNode(text){return {textContent:text};}},
    state:{project:{id:'book-1'}},current(){return {id:'chapter-1',text:'原始正文'};},
    setTimeout(fn){const id=++timerId;timers.set(id,fn);return id;},clearTimeout(id){timers.delete(id);},
    toast(message,error){messages.push({message,error});},
    async api(url,body){
      calls.push({url,body:copy(body)});
      if(context.intercept)await context.intercept(url,body);
      if(fail?.(body))throw new Error('服务暂时不可用');
      const id=`${url}\n${body.key}`;
      const previous=store.get(id)||{key:body.key,value:null,version:0,updated_at:null};
      if(body.action==='read')return {draft:copy(previous)};
      if(body.expected_version!==previous.version)throw Object.assign(new Error('草稿已在其他窗口更新'),{status:409});
      const draft={key:body.key,value:body.action==='delete'?null:copy(body.value),version:previous.version+1,updated_at:'now'};
      store.set(id,draft);return {draft:copy(draft)};
    },
    addEventListener(type,fn){(windowListeners[type]||=[]).push(fn);},
  };
  context.window=context;
  vm.createContext(context);vm.runInContext(source,context,{filename:'drafts.js'});
  context.workDrafts.setProject('book-1');
  function dispatch(type,event={}){for(const fn of listeners[type]||[])fn(event);}
  function field(name,value,{type='text',checked=false,tag='input',id=''}={}){
    return {name,value,type,checked,tagName:tag.toUpperCase(),id,options:[],dispatchEvent(event){dispatch(event.type,{...event,target:this});}};
  }
  function form(id='entity-form',{kind='character',entityId='',values={name:'',description:''}}={}) {
    if(currentForm)currentForm.isConnected=false;
    const result=node('form');Object.assign(result,{id,dataset:{kind,id:entityId},isConnected:true,fields:[]});
    for(const [name,value] of Object.entries(values))result.fields.push(field(name,value));
    result.querySelectorAll=()=>result.fields;
    result.querySelector=selector=>selector==='[name="entity_id"]'?result.fields.find(f=>f.name==='entity_id'):null;
    result.contains=target=>result.fields.includes(target);
    currentForm=result;dialog.open=true;return result;
  }
  async function open(...args){const result=form(...args);await context.workDrafts.dialogOpened();return result;}
  function input(control,value){control.value=value;dispatch('input',{target:control});}
  async function tick(){for(const fn of [...timers.values()])fn();timers.clear();await context.workDrafts.flush();}
  return {context,service:context.workDrafts,store,calls,messages,dialog,open,form,field,input,dispatch,tick,
    windowEvent(type){for(const fn of windowListeners[type]||[])fn();}};
}

test('writes are serialized and project binding is captured before a switch',async()=>{
  const h=harness();
  const first=h.service.write('session:1',{text:'第一版'});
  const second=h.service.write('session:1',{text:'第二版'});
  h.service.setProject('book-2');
  await Promise.all([first,second]);
  assert.deepEqual(copy(await h.service.read('session:1','book-1')),{text:'第二版'});
  assert.equal(await h.service.read('session:1'),null);
  assert(h.calls.filter(c=>c.body.action==='write').every(c=>c.url.includes('book-1')));
  const versions=h.calls.filter(c=>c.body.action==='write').map(c=>c.body.expected_version);
  assert.deepEqual(versions,[0]); // Adjacent queued inputs can coalesce safely.
});

test('ordinary dialog input survives closing and a completely new page runtime',async()=>{
  const h=harness();const form=await h.open();
  h.input(form.fields[0],'林照😀');h.input(form.fields[1],'不愿透露来历。');
  assert.equal(await h.service.requestClose(),true);assert.equal(h.dialog.open,false);
  const restarted=harness({store:h.store});const restored=await restarted.open();
  assert.equal(restored.fields[0].value,'林照😀');
  assert.equal(restored.fields[1].value,'不愿透露来历。');
  assert.match(restored.workDraftSession.label.textContent,/找回未保存/);
});

test('all ordinary form types retain text and options but omit files and passwords',async()=>{
  for(const id of ['entity-form','project-form','change-form','style-reference-form','image-reference-form','outline-node-form']) {
    const h=harness();const form=await h.open(id,{values:{title:''}});
    form.fields.push(h.field('locked','on',{type:'checkbox',checked:true}),h.field('upload','C:\\private\\photo.png',{type:'file'}),h.field('api_key','private-key',{type:'password'}));
    h.input(form.fields[0],'未完成的内容');await h.service.captureDialog();
    const record=[...h.store.values()].find(r=>r.value);
    assert.equal(record.value.fields.title[0].value,'未完成的内容',id);
    assert.equal(record.value.fields.locked[0].checked,true,id);
    assert(!JSON.stringify(record.value).includes('private'),id);
    assert(!Object.hasOwn(record.value.fields,'upload'),id);
  }
});

test('new typing wins while a previous draft read is still in flight',async()=>{
  const h=harness();await h.service.write('dialog:entity-form:character:new',{formId:'entity-form',fields:{name:[{value:'旧草稿'}]},base:'{}',context:''});
  const next=harness({store:h.store});let resume;
  next.context.intercept=(_url,body)=>body.action==='read'?new Promise(resolve=>{resume=resolve;}):undefined;
  const form=next.form();const opening=next.service.dialogOpened();
  next.input(form.fields[0],'作者正在输入');resume();await opening;
  assert.equal(form.fields[0].value,'作者正在输入');
  await next.service.captureDialog();
  assert.equal([...next.store.values()][0].value.fields.name[0].value,'作者正在输入');
});

test('a changed official base is flagged and recovery changes only the form',async()=>{
  const h=harness();const first=await h.open('entity-form',{values:{name:'原设定',description:'原小传'}});
  h.input(first.fields[1],'未保存的小传');await h.service.requestClose();
  const resumed=harness({store:h.store});const form=await resumed.open('entity-form',{values:{name:'新版正式设定',description:'正式小传'}});
  assert.equal(form.fields[1].value,'未保存的小传');
  assert.match(form.workDraftSession.label.textContent,/基础资料或正文已变化/);
  assert.equal(resumed.calls.filter(c=>c.body.action==='write').length,0);
  assert.equal(resumed.context.state.project.id,'book-1');
});

test('autosave failure retains input and prevents closing until a retry succeeds',async()=>{
  let unavailable=true;
  const h=harness({fail:body=>unavailable&&body.action==='write'});const form=await h.open();
  h.input(form.fields[0],'不能丢掉的名字');
  assert.equal(await h.service.requestClose(),false);
  assert.equal(h.dialog.open,true);assert.equal(form.fields[0].value,'不能丢掉的名字');
  assert.match(form.workDraftSession.label.textContent,/保留失败/);
  unavailable=false;
  assert.equal(await h.service.requestClose(),true);
  assert.equal([...h.store.values()][0].value.fields.name[0].value,'不能丢掉的名字');
});

test('a stale window cannot overwrite a newer draft or resurrect a deletion',async()=>{
  const a=harness(),b=harness({store:a.store});
  assert.equal(await a.service.read('session:1'),null);assert.equal(await b.service.read('session:1'),null);
  await a.service.write('session:1',{text:'新版'});await a.service.remove('session:1');
  await assert.rejects(b.service.write('session:1',{text:'旧窗口'}),/其他窗口/);
  await assert.rejects(b.service.flush(),/其他窗口/);
  assert.deepEqual(copy(await b.service.read('session:1')),{text:'旧窗口'});
  assert.equal([...a.store.values()][0].value,null);
});

test('save cleanup uses the original form session key even after an id/project change',async()=>{
  const h=harness();const form=await h.open('outline-node-form',{values:{title:''}});
  h.input(form.fields[0],'第一阶段');await h.service.captureDialog();
  const originalKey=form.workDraftSession.key;
  form.dataset.id='new-official-id';h.service.setProject('book-2');
  assert.equal(await h.service.dialogSaved(form),true);
  const deletion=h.calls.find(c=>c.body.action==='delete');
  assert.equal(deletion.body.key,originalKey);assert(deletion.url.includes('book-1'));
});

test('failure to delete auxiliary input does not report the already completed formal save as failed',async()=>{
  const h=harness({fail:body=>body.action==='delete'});const form=await h.open();
  h.input(form.fields[0],'已保存的人物');await h.service.captureDialog();
  assert.equal(await h.service.dialogSaved(form),false);
  assert.equal(form.workDraftSession.saved,true);
  assert.match(h.messages.at(-1).message,/内容已保存/);
  assert.equal(await h.service.read(form.workDraftSession.key),null);
});

test('Escape and background lifecycle events preserve dirty dialog input',async()=>{
  const h=harness();const form=await h.open();h.input(form.fields[0],'后台草稿');
  h.context.document.visibilityState='hidden';h.dispatch('visibilitychange');await h.service.flush();
  assert.equal([...h.store.values()][0].value.fields.name[0].value,'后台草稿');
  let prevented=false;h.dispatch('cancel',{target:{id:'dialog'},preventDefault(){prevented=true;}});
  await h.service.flush();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(prevented,true);assert.equal(h.dialog.open,false);
  h.windowEvent('pagehide');
});

test('backup restoration blocks both direct close and Escape before any asynchronous flush',async()=>{
  const h=harness();h.dialog.open=true;
  h.context.backupImportBusy=()=>true;
  let prevented=false;
  h.dispatch('cancel',{target:{id:'dialog'},preventDefault(){prevented=true;}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(prevented,true);assert.equal(h.dialog.open,true);
  assert.equal(await h.service.requestClose(),false);
  assert.equal(h.dialog.open,true);
  h.context.backupImportBusy=()=>false;
  assert.equal(await h.service.requestClose(),true);assert.equal(h.dialog.open,false);
});

test('an import starting while a draft write waits prevents the pending close',async()=>{
  const h=harness();const form=await h.open();h.input(form.fields[0],'待保存输入');
  let resume,busy=false;h.context.backupImportBusy=()=>busy;
  h.context.intercept=(_url,body)=>body.action==='write'?new Promise(resolve=>{resume=resolve;}):undefined;
  const closing=h.service.requestClose();
  while(!resume)await new Promise(resolve=>setImmediate(resolve));
  busy=true;resume();
  assert.equal(await closing,false);assert.equal(h.dialog.open,true);
});
