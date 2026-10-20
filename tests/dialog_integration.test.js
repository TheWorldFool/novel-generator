'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const appSource = fs.readFileSync(path.join(__dirname,'..','static','app.js'),'utf8').replace(/\binit\(\);\s*$/,'');
const draftSource = fs.readFileSync(path.join(__dirname,'..','static','drafts.js'),'utf8');
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
const decode = value => value.replace(/&(amp|lt|gt|quot|#39);/g,(_,name)=>({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"}[name]));

// Two real production scripts share their real globals/listeners. Only DOM
// rendering and HTTP/SQLite transport are fixtures; run/submit/showDialog,
// accept, API error handling and workDrafts all execute unchanged.
function harness({draftStore=new Map(),project}={}) {
  const nodes={},listeners={},calls=[],timers=new Map();let timerId=0;
  let form=null,renders=0;
  function element(tag='div') {
    return {tagName:tag.toUpperCase(),dataset:{},children:[],classList:{toggle(){}},
      setAttribute(){},append(...children){this.children.push(...children);},prepend(child){this.children.unshift(child);},
      remove(){delete nodes['#'+this.id];}};
  }
  const body={classList:{toggle(){}},appendChild(node){nodes['#'+node.id]=node;}};
  const app=nodes['#app']={inert:false};nodes['#toast']={};
  const dialog=nodes['#dialog']={open:false,showModal(){this.open=true;},close(){this.open=false;},querySelector(q){return q==='form'?form:null;}};
  const attributes = source => Object.fromEntries([...source.matchAll(/([\w-]+)="([^"]*)"/g)].map(m=>[m[1],decode(m[2])]));
  Object.defineProperty(dialog,'innerHTML',{set(html){
    if(form)form.isConnected=false;
    const match=html.match(/<form\b([^>]*)>/);
    if(!match){form=null;return;}
    const attrs=attributes(match[1]);form=element('form');
    Object.assign(form,{id:attrs.id,dataset:{id:attrs['data-id']||'',kind:attrs['data-kind']||''},fields:[],isConnected:true,inert:false});
    for(const match of html.matchAll(/<input\b([^>]*)>|<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g)) {
      const attrs=attributes(match[1]||match[2]);if(!attrs.name)continue;
      const field={name:attrs.name,id:attrs.id||'',value:match[2]!==undefined?decode(match[3]||''):(attrs.value||''),
        type:attrs.type||'text',tagName:match[2]!==undefined?'TEXTAREA':'INPUT',checked:/\bchecked\b/.test(match[1]||match[2]),
        closest(q){return q==='#dialog'?dialog:null;},matches(){return true;}};
      form.fields.push(field);
    }
    form.querySelectorAll=()=>form.fields;
    form.querySelector=q=>{const match=q.match(/^\[name="([^"]+)"\]$/);return match?form.fields.find(f=>f.name===match[1])||null:null;};
    form.contains=target=>form.fields.includes(target);
  }});
  const context={console,Map,Set,Math,JSON,Promise,Date,Intl,Error,
    navigator:{userAgent:'Desktop'},
    document:{body,visibilityState:'visible',querySelector(q){return q==='#dialog form'?form:nodes[q]||null;},querySelectorAll(){return [];},
      createElement:element,createTextNode(text){return {textContent:text};},addEventListener(type,fn){(listeners[type]||=[]).push(fn);}},
    addEventListener(){},setTimeout(fn){const id=++timerId;timers.set(id,fn);return id;},clearTimeout(id){timers.delete(id);},
    FormData:class {constructor(form){this.entries=form.fields.filter(f=>!['checkbox','radio'].includes(f.type)||f.checked).map(f=>[f.name,f.value]);}[Symbol.iterator](){return this.entries[Symbol.iterator]();}},
    async fetch(url,options={}){
      const request=options.body?JSON.parse(options.body):null;calls.push({url,body:copy(request)});
      if(url.endsWith('/drafts')) {
        if(context.draftGate)await context.draftGate(request);
        const key=url+'\n'+request.key;
        const previous=draftStore.get(key)||{key:request.key,value:null,version:0,updated_at:null};
        if(request.action==='read')return response({draft:copy(previous)});
        if(request.expected_version!==previous.version)return response({error:'草稿已在其他窗口更新'},409);
        const draft={key:request.key,value:request.action==='delete'?null:copy(request.value),version:previous.version+1,updated_at:'now'};
        draftStore.set(key,draft);return response({draft:copy(draft)});
      }
      if(url.endsWith('/mutate')) {
        if(context.domainGate)await context.domainGate(request);
        const updated=copy(context.workbenchState.project),saved=updated.entities.find(e=>e.id===request.data.id);
        Object.assign(saved,request.data);updated.revision++;
        return response({project:updated,canon:[]});
      }
      throw new Error('Unexpected transport '+url);
    },
  };
  function response(data,status=200){return {ok:status===200,status,async json(){return copy(data);}};}
  context.window=context;vm.createContext(context);
  vm.runInContext(draftSource,context,{filename:'drafts.js'});
  vm.runInContext(appSource,context,{filename:'app.js'});
  vm.runInContext('globalThis.workbenchState=state;',context);
  const state=context.workbenchState;
  context.render=()=>{renders++;};
  state.fields={character:{goal:'目标'}};state.projects=[];
  context.accept({project:project||{id:'book-1',revision:7,entities:[{id:'person-1',kind:'character',name:'林照',description:'正式小传',base:{goal:'寻找线索'},locked:false}],chapters:[{id:'chapter-1',text:'正文'}]},canon:[]});
  state.chapterId='chapter-1';state.view='characters';
  function dispatch(type,target){const event={target,preventDefault(){},stopImmediatePropagation(){this.stopped=true;}};for(const fn of listeners[type]||[]){fn(event);if(event.stopped)break;}}
  function click(action,data={}){const button={dataset:{action,...data}};dispatch('click',{closest(q){return q==='[data-action]'?button:null;}});}
  function input(name,value){const field=form.fields.find(f=>f.name===name);field.value=value;dispatch('input',field);return field;}
  return {context,state,calls,dialog,app,draftStore,click,input,dispatch,get form(){return form;},get renders(){return renders;}};
}

async function until(predicate) {
  for(let attempt=0;attempt<30;attempt++) {if(predicate())return;await new Promise(resolve=>setImmediate(resolve));}
  assert.fail('production event handler did not reach the expected state');
}

test('real entity action and close route persist input before closing, then a fresh runtime restores it',async()=>{
  const h=harness();h.click('edit-entity',{id:'person-1'});
  await until(()=>h.form?.workDraftSession&&h.calls.some(c=>c.body?.action==='read'));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.form.fields.find(f=>f.name==='description').value,'正式小传');
  h.input('description','人物还有一处未保存的细节😀');
  let finishWrite;h.context.draftGate=request=>request.action==='write'?new Promise(resolve=>{finishWrite=resolve;}):undefined;
  h.click('close-dialog');await until(()=>finishWrite);
  assert.equal(h.dialog.open,true,'the close action must wait for durable storage');
  finishWrite();await until(()=>!h.dialog.open);
  assert.equal(h.calls.filter(c=>c.url.endsWith('/mutate')).length,0,'editing a draft never mutates the official character');
  const restarted=harness({draftStore:h.draftStore});restarted.click('edit-entity',{id:'person-1'});
  await until(()=>restarted.form?.fields.find(f=>f.name==='description').value==='人物还有一处未保存的细节😀');
  assert.match(restarted.form.workDraftSession.label.textContent,/找回未保存/);
  assert.equal(restarted.state.project.entities[0].description,'正式小传');
});

test('real submit/run keep the ordinary form inert and remove its original draft only after formal saving',async()=>{
  const h=harness();h.click('edit-entity',{id:'person-1'});
  await until(()=>h.form?.workDraftSession);await new Promise(resolve=>setImmediate(resolve));
  h.input('description','作者确认的新小传');await h.context.workDrafts.captureDialog();
  const savedForm=h.form,originalKey=savedForm.workDraftSession.key;
  let finishMutation;h.context.domainGate=()=>new Promise(resolve=>{finishMutation=resolve;});
  h.dispatch('submit',savedForm);await until(()=>finishMutation);
  assert.equal(h.state.busy,true);assert.equal(h.app.inert,true);assert.equal(savedForm.inert,true);
  assert.equal(h.calls.filter(c=>c.body?.action==='delete').length,0);
  h.dispatch('submit',savedForm);h.click('close-dialog');
  assert.equal(h.calls.filter(c=>c.url.endsWith('/mutate')).length,1,'busy submits cannot create duplicate saves');
  assert.equal(h.dialog.open,true);
  // The server may assign/normalize ids during a creation flow. Cleanup must
  // still target the draft session that was opened before that response.
  savedForm.dataset.id='server-normalized-id';finishMutation();await until(()=>!h.state.busy);
  assert.equal(h.dialog.open,false);assert.equal(savedForm.inert,false);assert.equal(h.app.inert,false);
  assert.equal(h.state.project.entities[0].description,'作者确认的新小传');assert.equal(h.state.project.revision,8);
  const deletion=h.calls.find(c=>c.body?.action==='delete');assert.equal(deletion.body.key,originalKey);
  assert.equal([...h.draftStore.values()][0].value,null);assert.equal(h.renders,1);
});

test('a submit while old draft recovery waits cannot erase unseen input, then saves after recovery',async()=>{
  const previous=harness();previous.click('edit-entity',{id:'person-1'});
  await until(()=>previous.form?.workDraftSession&&!previous.form.workDraftSession.loading);
  previous.input('description','先前未完成、还没给作者看到的草稿');await previous.context.workDrafts.captureDialog();
  const h=harness({draftStore:previous.draftStore});let finishRead;
  h.context.draftGate=request=>request.action==='read'?new Promise(resolve=>{finishRead=resolve;}):undefined;
  h.click('edit-entity',{id:'person-1'});await until(()=>finishRead);
  assert.equal(h.form.inert,true);assert.equal(h.form.workDraftSession.loading,true);
  h.dispatch('submit',h.form);
  assert.equal(h.calls.filter(c=>c.url.endsWith('/mutate')||c.body?.action==='delete').length,0);
  assert.equal(h.state.busy,false);assert.equal(h.dialog.open,true);
  finishRead();await until(()=>!h.form.workDraftSession.loading);
  assert.equal(h.form.fields.find(f=>f.name==='description').value,'先前未完成、还没给作者看到的草稿');
  assert.equal(h.form.inert,false);
  h.dispatch('submit',h.form);await until(()=>!h.dialog.open);
  assert.equal(h.state.project.entities[0].description,'先前未完成、还没给作者看到的草稿');
  assert.equal(h.calls.filter(c=>c.url.endsWith('/mutate')).length,1);
});
