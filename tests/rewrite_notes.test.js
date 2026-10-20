'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'..','static','rewrite-notes.js'),'utf8');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function harness(storage=new Map()) {
  const nodes={},events={},writes=[];
  const context={console,Map,Promise,String,state:{project:{id:'book-1'},chapterId:'chapter-1',rewriteNotes:{}},
    $(key){return nodes[key]||null;},current(){return {id:context.state.chapterId};},
    document:{addEventListener(type,fn){(events[type]||=[]).push(fn);}},
    workDrafts:{async read(key,pid){if(context.readRequest)return context.readRequest(key,pid);return structuredClone(storage.get(`${pid}:${key}`)||null);},
      async write(key,value,pid){writes.push({key,value:structuredClone(value),pid});if(context.writeError)throw new Error(context.writeError);storage.set(`${pid}:${key}`,structuredClone(value));}},
  };
  function textarea(){nodes['#rewrite-instructions']={id:'rewrite-instructions',value:'',insertAdjacentHTML(){nodes['#rewrite-notes-status']={textContent:'',classList:{toggle(){}}};}};return nodes['#rewrite-instructions'];}
  textarea();context.window=context;vm.createContext(context);vm.runInContext(source,context,{filename:'rewrite-notes.js'});
  function event(type,value){const target=nodes['#rewrite-instructions'];target.value=value;for(const fn of events[type]||[])fn({target});}
  return {context,nodes,writes,storage,event,textarea};
}

test('rewrite notes persist by project and chapter and restore after a new browser session',async()=>{
  const h=harness();h.context.decorateRewriteNotes();await flush();await h.context.captureRewriteNotes('保留结尾，删去解释');
  assert.deepEqual(h.writes[0],{key:'rewrite-notes:chapter-1',pid:'book-1',value:{text:'保留结尾，删去解释'}});
  const restarted=harness(h.storage);restarted.context.decorateRewriteNotes();await flush();
  assert.equal(restarted.nodes['#rewrite-instructions'].value,'保留结尾，删去解释');assert.match(restarted.nodes['#rewrite-notes-status'].textContent,/本机保留/);
});

test('notes from one chapter or another book cannot appear in the new editor',async()=>{
  const h=harness();h.context.decorateRewriteNotes();await h.context.captureRewriteNotes('第一章意见');
  h.context.state.chapterId='chapter-2';h.textarea();h.context.decorateRewriteNotes();await flush();
  assert.equal(h.nodes['#rewrite-instructions'].value,'');await h.context.captureRewriteNotes('第二章意见');
  h.context.state.project.id='book-2';h.context.state.chapterId='chapter-1';h.textarea();h.context.decorateRewriteNotes();await flush();
  assert.equal(h.nodes['#rewrite-instructions'].value,'');await h.context.captureRewriteNotes('另一本书意见');
  h.context.state.project.id='book-1';h.context.state.chapterId='chapter-1';h.textarea();h.context.decorateRewriteNotes();
  assert.equal(h.nodes['#rewrite-instructions'].value,'第一章意见');
  assert.equal(h.storage.get('book-1:rewrite-notes:chapter-2').text,'第二章意见');
});

test('a slow saved-note read cannot overwrite text typed after the view opened',async()=>{
  const h=harness(),reading=deferred();h.context.readRequest=()=>reading.promise;
  h.context.decorateRewriteNotes();h.nodes['#rewrite-instructions'].value='刚输入的新意见';
  await h.context.captureRewriteNotes('刚输入的新意见');reading.resolve({text:'读取中的旧意见'});await flush();
  assert.equal(h.nodes['#rewrite-instructions'].value,'刚输入的新意见');assert.equal(h.context.state.rewriteNotes['chapter-1'],'刚输入的新意见');
});

test('late reads for another project cannot overwrite the current editor',async()=>{
  const h=harness(),reading=deferred();h.context.readRequest=(key,pid)=>pid==='book-1'?reading.promise:Promise.resolve({text:'第二本书的意见'});
  h.context.decorateRewriteNotes();h.context.state.project.id='book-2';h.textarea();h.context.decorateRewriteNotes();await flush();
  reading.resolve({text:'旧作品意见'});await flush();assert.equal(h.nodes['#rewrite-instructions'].value,'第二本书的意见');
});

test('clearing notes stays cleared after restart instead of resurrecting old instructions',async()=>{
  const h=harness();h.context.decorateRewriteNotes();await h.context.captureRewriteNotes('原来的意见');await h.context.captureRewriteNotes('');
  const restarted=harness(h.storage);restarted.context.decorateRewriteNotes();await flush();assert.equal(restarted.nodes['#rewrite-instructions'].value,'');
});

test('a failed notes write leaves editable text for copying and a later successful write recovers',async()=>{
  const h=harness();h.context.decorateRewriteNotes();await flush();h.context.writeError='磁盘空间不足';
  h.nodes['#rewrite-instructions'].value='保留供复制的意见';assert.equal(await h.context.captureRewriteNotes('保留供复制的意见'),false);
  assert.equal(h.nodes['#rewrite-instructions'].value,'保留供复制的意见');assert.match(h.nodes['#rewrite-notes-status'].textContent,/复制后重试/);
  h.context.writeError=null;assert.equal(await h.context.captureRewriteNotes('恢复保存的意见'),true);assert.match(h.nodes['#rewrite-notes-status'].textContent,/本机保留/);
  assert.equal(h.storage.get('book-1:rewrite-notes:chapter-1').text,'恢复保存的意见');
});

test('a pending old read cannot erase the failure notice for newer unsaved input',async()=>{
  const h=harness(),reading=deferred();h.context.readRequest=()=>reading.promise;h.context.decorateRewriteNotes();
  h.context.writeError='空间不足';await h.context.captureRewriteNotes('更新但未保存');reading.resolve({text:'旧意见'});await flush();
  assert.equal(h.nodes['#rewrite-instructions'].value,'更新但未保存');assert.match(h.nodes['#rewrite-notes-status'].textContent,/空间不足/);
});

for(const type of ['compositionend','blur'])test(`${type} preserves the final visible IME value`,async()=>{
  const h=harness();h.context.decorateRewriteNotes();await flush();h.event(type,'输入法最后提交的意见');await flush();
  assert.equal(h.storage.get('book-1:rewrite-notes:chapter-1').text,'输入法最后提交的意见');
});
