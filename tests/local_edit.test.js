'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname,'..','static','local-edit.js'),'utf8');
const unescape = text => text.replace(/&(amp|lt|gt|quot|#39);/g,(_,name)=>({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"}[name]));

// Execute the real production listeners with the small DOM surface they need.
// Provider responses are controlled promises, so races are deterministic.
function harness(text='前😀句。\n\n后面保持。') {
  const listeners={}, nodes={}, dialogs=[], calls=[], errors=[], messages=[];
  let rendered=0, saves=0;
  const input = nodes['#chapter-text']={id:'chapter-text',value:text,selectionStart:1,selectionEnd:4,
    before(node){nodes['#local-edit-toolbar']=node;nodes['#local-edit-selection']={};nodes['#local-edit-resume']={hidden:true};}};
  const dialog=nodes['#dialog']={open:false,close(){this.open=false;}};
  const chapter={id:'chapter-1',text};
  const context={Map,Error,console,Promise,
    document:{activeElement:input,addEventListener(type,fn){(listeners[type]||=[]).push(fn);},createElement(){return {}; }},
    state:{project:{id:'book-1',revision:3,chapters:[chapter]},dirty:false,busy:false,view:'write'},
    $(selector){return nodes[selector]??null;},
    current(){return context.state.project.chapters[0];},
    esc(value){return String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));},
    showDialog(html){
      dialogs.push(html);dialog.open=true;
      nodes['#local-edit-form']={id:'local-edit-form',dataset:{session:html.match(/data-session="([^"]+)"/)[1]}};
      for(const id of ['local-edit-instructions','local-edit-replacement']) {
        const match=html.match(new RegExp(`<textarea id="${id}"[^>]*>([\\s\\S]*?)<\\/textarea>`));
        if(match)nodes['#'+id]={id,value:unescape(match[1]),focus(){},closest(selector){return selector==='#local-edit-form'?nodes['#local-edit-form']:null;}};
        else delete nodes['#'+id];
      }
    },
    toast(message,error){(error?errors:messages).push(message);},
    render(){rendered++;},
    captureEditor(){context.current().text=input.value;},
    markDirty(){context.state.dirty=true;},
    async saveCurrent(){
      saves++;
      if(context.state.dirty){context.current().text=input.value;context.state.dirty=false;context.state.project.revision++;}
    },
    async api(url,body){
      calls.push({url,body});
      if(context.request) return context.request(url,body);
      if(url.endsWith('/edit-preview')) return {edit:{chapter_id:chapter.id,start:body.start,end:body.end,
        original:body.selected_text,replacement:'更自然的文字',source_hash:'signed-source-hash',source_revision:body.revision}};
      const updated=structuredClone(context.state.project);
      updated.chapters[0].text=input.value.slice(0,body.data.start)+body.data.replacement+input.value.slice(body.data.end);
      updated.revision++;
      return {project:updated,canon:[]};
    },
    accept(result){context.state.project=result.project;context.state.dirty=false;},
    run(fn){
      context.state.busy=true;
      context.pending=Promise.resolve().then(fn).catch(error=>errors.push(error.message)).finally(()=>{context.state.busy=false;});
    },
  };
  context.window=context;
  vm.createContext(context);vm.runInContext(source,context,{filename:'local-edit.js'});
  context.decorateLocalEdit();
  function dispatch(type,event) {for(const fn of listeners[type]||[])fn(event);}
  function click(action,extra={}) {
    const button={dataset:{action,...extra}};
    dispatch('click',{target:{closest(){return button;}},preventDefault(){}});
    return context.pending||Promise.resolve();
  }
  function select(start,end){input.selectionStart=start;input.selectionEnd=end;dispatch('select',{target:input});}
  function submit(instructions) {
    if(instructions!==undefined)nodes['#local-edit-instructions'].value=instructions;
    dispatch('submit',{target:nodes['#local-edit-form'],preventDefault(){}});
    return context.pending||Promise.resolve();
  }
  return {context,input,dialog,nodes,dialogs,calls,errors,messages,click,select,submit,dispatch,
    get rendered(){return rendered;},get saves(){return saves;}};
}

test('emoji selection survives toolbar blur and preview does not mutate prose',async()=>{
  const h=harness();h.select(1,4);
  // Focusing a mobile toolbar can collapse the live selection.
  h.input.selectionStart=h.input.selectionEnd=0;
  await h.click('local-edit-selection');
  assert.equal(h.calls.length,0);
  await h.submit('  语气自然些，保留人物动作  ');
  assert.equal(h.calls[0].url,'/api/projects/book-1/edit-preview');
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0].body)),{revision:3,chapter_id:'chapter-1',start:1,end:4,selected_text:'😀句',instructions:'语气自然些，保留人物动作'});
  assert.equal(h.context.current().text,h.input.value);
  assert.equal(h.nodes['#local-edit-replacement'].value,'更自然的文字');
  assert.equal(h.nodes['#local-edit-instructions'].value,'');
  assert.equal(h.rendered,0);
});

test('current paragraph follows blank line boundaries and no selection is explained',async()=>{
  const h=harness();h.input.selectionStart=h.input.selectionEnd=9;
  await h.click('local-edit-selection');
  assert.match(h.errors[0],/长按/);
  await h.click('local-edit-paragraph');
  await h.submit('精简');
  assert.equal(h.calls[0].body.selected_text,'后面保持。');
  assert.equal(h.calls[0].body.start,7);
  assert.equal(h.calls[0].body.end,h.input.value.length);
});

test('manual changes are sent only on explicit adoption and original suffix stays exact',async()=>{
  const h=harness();await h.click('local-edit-selection');await h.submit('微调对白');
  h.nodes['#local-edit-replacement'].value='作者手改😀';
  await h.click('local-edit-apply');
  assert.equal(h.calls.length,2);
  assert.equal(h.calls[1].body.action,'apply_local_edit');
  assert.equal(h.calls[1].body.data.replacement,'作者手改😀');
  assert.equal(h.calls[1].body.data.source_hash,'signed-source-hash');
  assert.equal(h.context.current().text,'前作者手改😀。\n\n后面保持。');
  assert.equal(h.dialog.open,false);
  assert.equal(h.rendered,1);
});

test('empty replacement explicitly deletes just the selection',async()=>{
  const h=harness();await h.click('local-edit-selection');await h.submit('删除这部分');
  h.nodes['#local-edit-replacement'].value='';await h.click('local-edit-apply');
  assert.equal(h.calls[1].body.data.replacement,'');
  assert.equal(h.context.current().text,'前。\n\n后面保持。');
});

test('cancel leaves original and retained work can be resumed',async()=>{
  const h=harness();await h.click('local-edit-selection');await h.submit('微调');
  h.nodes['#local-edit-replacement'].value='尚未采用的手改';
  await h.click('local-edit-cancel');assert.equal(h.dialog.open,false);
  assert.equal(h.calls.length,1);
  await h.click('local-edit-resume');
  assert.equal(h.nodes['#local-edit-replacement'].value,'尚未采用的手改');
  assert.equal(h.context.current().text,h.input.value);
});

test('next round uses previous manually edited candidate and same original selection',async()=>{
  const h=harness();await h.click('local-edit-selection');await h.submit('更克制');
  h.nodes['#local-edit-replacement'].value='手改后的上一轮';
  await h.submit('再保留最后一个动作');
  assert.equal(h.calls[1].body.previous_replacement,'手改后的上一轮');
  assert.equal(h.calls[1].body.selected_text,'😀句');
  assert.equal(h.calls[1].body.start,1);
  assert.equal(h.calls[1].body.end,4);
});

test('feedback typed while the editor save is pending survives the result',async()=>{
  const h=harness();await h.click('local-edit-selection');
  let complete;
  h.context.saveCurrent=()=>new Promise(resolve=>{complete=resolve;});
  const pending=h.submit('点击时的要求');
  while(!complete)await Promise.resolve();
  h.nodes['#local-edit-instructions'].value='等待保存时继续输入的新要求';
  complete();await pending;
  assert.equal(h.calls[0].body.instructions,'点击时的要求');
  assert.equal(h.nodes['#local-edit-instructions'].value,'等待保存时继续输入的新要求');
});

test('candidate and new feedback typed while model is pending are retained alongside new version',async()=>{
  const h=harness();await h.click('local-edit-selection');await h.submit('第一轮');
  let complete;
  h.context.request=()=>new Promise(resolve=>{complete=resolve;});
  const pending=h.submit('第二轮');
  while(!complete)await Promise.resolve();
  h.nodes['#local-edit-replacement'].value='等待期间手动润色';
  h.nodes['#local-edit-instructions'].value='下一轮的意见';
  complete({edit:{...h.calls[0].body,source_revision:3,source_hash:'signed-source-hash',replacement:'第二轮模型新版'}});
  await pending;
  assert.equal(h.nodes['#local-edit-replacement'].value,'等待期间手动润色');
  assert.equal(h.nodes['#local-edit-instructions'].value,'下一轮的意见');
  assert.match(h.dialogs.at(-1),/第二轮模型新版/);
  await h.click('local-edit-use-alternative');
  assert.equal(h.nodes['#local-edit-replacement'].value,'第二轮模型新版');
});

test('closing while a preview is pending never reopens the old modal',async()=>{
  const h=harness();await h.click('local-edit-selection');
  let complete;h.context.request=()=>new Promise(resolve=>{complete=resolve;});
  const pending=h.submit('细调');while(!complete)await Promise.resolve();
  const before=h.dialogs.length;h.dialog.close();
  complete({edit:{...h.calls[0].body,source_revision:3,source_hash:'signed-source-hash',replacement:'已备好'}});
  await pending;
  assert.equal(h.dialog.open,false);assert.equal(h.dialogs.length,before);
  await h.click('local-edit-resume');assert.equal(h.nodes['#local-edit-replacement'].value,'已备好');
});

test('a real caret move in the manuscript clears an earlier remembered selection',async()=>{
  const h=harness();h.select(1,4);
  h.input.selectionStart=h.input.selectionEnd=9;
  h.dispatch('pointerup',{target:h.input});
  await h.click('local-edit-selection');
  assert.equal(h.dialog.open,false);
  assert.match(h.errors.at(-1),/请先在正文中选中文字/);
});

test('failed preview retains inputs and never changes chapter',async()=>{
  const h=harness();await h.click('local-edit-selection');
  h.context.request=async()=>{throw new Error('服务暂时不可用');};
  await h.submit('发色改成银灰色');
  assert.deepEqual(h.errors,['服务暂时不可用']);
  assert.equal(h.nodes['#local-edit-instructions'].value,'发色改成银灰色');
  assert.equal(h.context.current().text,h.input.value);
  assert.equal(h.rendered,0);
});

test('stale revision or new unsaved writing blocks adoption and keeps the candidate',async()=>{
  const h=harness();await h.click('local-edit-selection');await h.submit('微调');
  h.context.state.project.revision++;
  await h.click('local-edit-apply');
  assert.equal(h.calls.length,1);assert.match(h.errors.at(-1),/预览已过期/);
  assert.equal(h.nodes['#local-edit-replacement'].value,'更自然的文字');
  h.context.state.project.revision--;h.context.state.dirty=true;
  await h.click('local-edit-apply');assert.equal(h.calls.length,1);
});

test('normalizes displayed CRLF before preview so UTF16 offsets match persisted text',async()=>{
  const h=harness('第一句。\r\n\r\n第二句。');
  h.input.value='第一句。\n\n第二句。';h.input.selectionStart=6;h.input.selectionEnd=h.input.value.length;
  await h.click('local-edit-selection');await h.submit('更自然');
  assert.equal(h.calls[0].body.revision,4);
  assert.equal(h.context.current().text,h.input.value);
  assert.equal(h.calls[0].body.selected_text,'第二句。');
});

test('inputs made while applying stay available after the clicked version is saved',async()=>{
  const h=harness();await h.click('local-edit-selection');await h.submit('微调');
  let complete;h.context.request=()=>new Promise(resolve=>{complete=resolve;});
  const pending=h.click('local-edit-apply');while(!complete)await Promise.resolve();
  h.nodes['#local-edit-instructions'].value='等待采用时的新意见';
  h.nodes['#local-edit-replacement'].value='后输入的候选';
  const updated=structuredClone(h.context.state.project);updated.revision++;updated.chapters[0].text='前更自然的文字。\n\n后面保持。';
  complete({project:updated,canon:[]});await pending;
  assert.equal(h.context.current().text,'前更自然的文字。\n\n后面保持。');
  assert.equal(h.nodes['#local-edit-instructions'].value,'等待采用时的新意见');
  assert.equal(h.nodes['#local-edit-replacement'].value,'后输入的候选');
  assert.match(h.dialogs.at(-1),/等待期间继续输入的意见和文字保留/);
});

test('closing during adoption with new input does not reopen a completed dialog',async()=>{
  const h=harness();await h.click('local-edit-selection');await h.submit('微调');
  let complete;h.context.request=()=>new Promise(resolve=>{complete=resolve;});
  const pending=h.click('local-edit-apply');while(!complete)await Promise.resolve();
  h.nodes['#local-edit-instructions'].value='保留的新意见';h.dialog.close();
  const before=h.dialogs.length;
  const updated=structuredClone(h.context.state.project);updated.revision++;updated.chapters[0].text='前新字。\n\n后面保持。';
  complete({project:updated,canon:[]});await pending;
  assert.equal(h.dialog.open,false);assert.equal(h.dialogs.length,before);
  await h.click('local-edit-resume');assert.equal(h.nodes['#local-edit-instructions'].value,'保留的新意见');
});
