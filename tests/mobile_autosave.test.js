'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function setup() {
  const listeners = {}, messages = [], calls = [];
  const state = {project:{id:'book',revision:1,chapters:[{id:'ch',text:'第一句',status:'approved'}]},
    dirty:true,busy:false,editVersion:1,view:'write',canon:[]};
  const label = {};
  const context = {navigator:{userAgent:'NovelGeneratorAndroid/0.2.0'},state,
    document:{documentElement:{classList:{add(){}}},addEventListener(name,callback){listeners[name]=callback;}},
    $: selector => selector === '#save-state' ? label : {open:false},
    currentSaveOperation:()=>['save_chapter',state.project.chapters[0]],
    accept(result){state.project=result.project;state.dirty=false;state.canon=result.canon;},
    api(path,body){return new Promise((resolve,reject)=>calls.push({path,body,resolve,reject}));},
    toast(message){messages.push(message);},setTimeout(){return 1;},clearTimeout(){},
    Promise,JSON};
  context.window=context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('static/mobile.js','utf8'),context);
  const result = text => ({project:{id:'book',revision:2,chapters:[{id:'ch',text,status:'needs_review',review:null,versions:[]}]},canon:[]});
  return {context,state,calls,messages,result,label};
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
