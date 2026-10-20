'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'references.js'), 'utf8');

function analysis(appearance, feedback) {
  return {
    observations:{appearance, clothing:'蓝色外套', posture:'站立', expression:'微笑'},
    uncertainties:[], character:{name:'林照', description:'虚构小传', base:{appearance, goal:'寻找线索'}},
    at:'2026-10-20T08:00:00Z', ...(feedback ? {feedback} : {}),
  };
}

// This harness executes the production event handlers and request code. The small
// DOM surface keeps the tests independent of a browser or a model provider.
function harness({fail=false,store,projectId='book-1',initialForm=true,read}={}) {
  const listeners={}, requests=[], errors=[], dialogs=[],adoptions=[];
  const original=analysis('黑色眼睛');
  const ref={id:'portrait-1',kind:'character',title:'林照参考',size:100,notes:'只参考外貌',analysis:original};
  const feedbackInput={id:'reference-feedback-input',value:'  眼睛是蓝色，请保留衣着。  ',focus(){},scrollIntoView(){}};
  const appearance={name:'value-appearance',value:'作者手动补充：右眉有一道疤'};
  const description={name:'value-description',value:original.character.description};
  const goal={name:'value-goal',value:original.character.base.goal};
  const checked=[{value:'appearance'},{value:'goal'}];
  const nameInput={name:'name',value:'作者取的名字'},entityInput={name:'entity_id',value:''};
  const form={id:'apply-character-reference-form',dataset:{id:ref.id,project:projectId},
    referenceCandidateValues:{...original.character.base,description:original.character.description,name:original.character.name,entity_id:''},
    elements:Object.assign([nameInput,entityInput,appearance,description,goal],{name:nameInput,entity_id:entityInput}),
  };
  let rendered=0,mounted=initialForm;
  const dialog={open:true,close(){this.open=false;for(const fn of listeners.close||[])fn({target:dialog});}};
  const context={
    Map, Error, console,
    FormData:class {
      constructor(){this.items=[...form.elements].map(input=>[input.name,input.value]).concat(checked.map(input=>['fields',input.value]),[['feedback',feedbackInput.value]]);}
      [Symbol.iterator](){return this.items[Symbol.iterator]();}
      get(name){return this.items.find(item=>item[0]===name)?.[1]??null;}
      getAll(name){return this.items.filter(item=>item[0]===name).map(item=>item[1]);}
    },
    document:{addEventListener(type,listener){(listeners[type]||=[]).push(listener);}},
    state:{project:{id:projectId,revision:4,entities:[],references:[ref]},settings:{base_url:'https://model.example/v1',model:'vision-model'},fields:{character:{appearance:'外貌',goal:'目标'}},busy:false},
    $(selector){
      if(selector==='#dialog')return dialog;
      if(selector==='#apply-character-reference-form')return mounted?form:null;
      if(selector==='#reference-feedback-input'||selector==='#apply-character-reference-form [name="feedback"]')return feedbackInput;
      return null;
    },
    $$(selector){
      if(selector==='[name^="value-"]')return [appearance,description,goal];
      if(selector==='[name="fields"]:checked')return checked;
      return [];
    },
    icon(){return '';},
    esc(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));},
    date(value){return value;},
    showDialog(html){dialogs.push(html);dialog.open=true;mounted=html.includes('id="apply-character-reference-form"');},
    render(){rendered++;},
    toast(message,error){if(error)errors.push(message);},
    async saveCurrent(){},
    async mutate(action,data){adoptions.push({action,data});if(context.adopt)await context.adopt();context.state.project.revision++;},
    async api(url,body){
      requests.push({url,body});
      if(fail)throw new Error('模型暂时不可用');
      const updated=structuredClone(context.state.project);
      updated.revision++;
      updated.references[0].analysis=analysis('蓝色眼睛',body.feedback);
      updated.references[0].analysis_history=[{analysis:original,replaced_at:'2026-10-20T08:01:00Z'}];
      return {project:updated};
    },
    accept(data){context.state.project=data.project;},
    run(fn){context.pending=Promise.resolve().then(fn).catch(error=>errors.push(error.message));},
  };
  if(store)context.workDrafts={
    async read(key,pid){return read?read(key,pid):structuredClone(store.get(`${pid}:${key}`)||null);},
    async write(key,value,pid){store.set(`${pid}:${key}`,structuredClone(value));},
  };
  context.window=context;
  vm.createContext(context);
  vm.runInContext(source,context,{filename:'references.js'});
  function click(action) {
    const button={dataset:{action,id:ref.id}};
    const event={target:{closest(selector){return selector==='[data-action]'?button:null;}}};
    listeners.click.forEach(listener=>listener(event));
    return context.pending||Promise.resolve();
  }
  return {context,click,form,appearance,description,goal,feedbackInput,checked,requests,errors,dialogs,dialog,adoptions,
    submit(){for(const fn of listeners.submit||[])fn({target:form,preventDefault(){}});return context.pending;},
    dispatch(type,event){for(const fn of listeners[type]||[])fn(event);},
    get rendered(){return rendered;},
    savedDraft(){return JSON.parse(vm.runInContext('JSON.stringify(characterReferenceDrafts.get(referenceDraftKey("portrait-1")))',context));},
    savedFeedback(){return vm.runInContext('referenceFeedbackDrafts.get(referenceDraftKey("portrait-1"))',context);},
  };
}

test('a correction sends user feedback and preserves hand-edited adoption fields',async()=>{
  const h=harness();
  await h.click('ref-correct');
  assert.equal(h.requests.length,1);
  assert.equal(h.requests[0].url,'/api/projects/book-1/analyze-reference');
  assert.equal(h.requests[0].body.feedback,'眼睛是蓝色，请保留衣着。');
  assert.equal(h.requests[0].body.revision,4);
  assert.equal(h.context.state.project.references[0].analysis.feedback,'眼睛是蓝色，请保留衣着。');
  assert.equal(h.feedbackInput.value,'');
  assert.equal(h.savedFeedback(),undefined);
  assert.deepEqual(h.savedDraft().values,{appearance:'作者手动补充：右眉有一道疤'});
  assert.deepEqual(h.savedDraft().selected,['appearance','goal']);
  assert.equal(h.savedDraft().name,'作者取的名字');
  assert.match(h.dialogs.at(-1),/作者手动补充：右眉有一道疤/);
  assert.match(h.dialogs.at(-1),/你手动编辑的采用内容和勾选已保留/);
  assert.match(h.dialogs.at(-1),/蓝色眼睛/);
  assert.match(h.dialogs.at(-1),/查看上次纠正意见/);
});

test('reference opinions and edited adoption fields survive restart without copying across projects',async()=>{
  const store=new Map(),h=harness({store});
  h.feedbackInput.value='重启后继续纠正眼睛';
  h.dispatch('input',{target:{...h.feedbackInput,closest(){return h.form;}}});
  h.dispatch('input',{target:{...h.appearance,closest(){return h.form;}}});
  await Promise.resolve();
  const reopened=harness({store,initialForm:false});
  await reopened.click('ref-preview');
  assert.match(reopened.dialogs.at(-1),/已恢复上次未采用/);
  assert.match(reopened.dialogs.at(-1),/重启后继续纠正眼睛/);
  assert.match(reopened.dialogs.at(-1),/作者手动补充：右眉有一道疤/);
  assert.deepEqual(reopened.savedDraft().selected,['appearance','goal']);
  const other=harness({store,projectId:'book-2',initialForm:false});
  await other.click('ref-preview');
  assert.doesNotMatch(other.dialogs.at(-1),/重启后继续纠正眼睛|作者手动补充：右眉有一道疤/);
  assert.equal(other.requests.length,0);
});

test('restored edits keep changed fields but take new analysis for untouched fields',async()=>{
  const store=new Map(),h=harness({store});
  h.dispatch('input',{target:{...h.appearance,closest(){return h.form;}}});
  await Promise.resolve();
  const reopened=harness({store,initialForm:false});
  reopened.context.state.project.references[0].analysis.character.base.goal='新一轮未编辑的目标建议';
  await reopened.click('ref-preview');
  assert.match(reopened.dialogs.at(-1),/作者手动补充：右眉有一道疤/);
  assert.match(reopened.dialogs.at(-1),/新一轮未编辑的目标建议/);
});

test('delayed draft reads cannot replace freshly typed reference opinions',async()=>{
  let complete;
  const h=harness({store:new Map(),read:()=>new Promise(resolve=>{complete=resolve;})});
  const pending=h.click('ref-preview');while(!complete)await Promise.resolve();
  h.feedbackInput.value='读取期间刚补充的新意见';
  h.dispatch('input',{target:{...h.feedbackInput,closest(){return h.form;}}});
  complete({feedback:'旧意见',adoption:null});await pending;
  assert.match(h.dialogs.at(-1),/读取期间刚补充的新意见/);
  assert.doesNotMatch(h.dialogs.at(-1),/>旧意见</);
});

test('a late reference preview read or model answer never reopens a closed modal',async()=>{
  let complete;
  const h=harness({store:new Map(),read:()=>new Promise(resolve=>{complete=resolve;})});
  const pending=h.click('ref-preview');while(!complete)await Promise.resolve();
  h.dialog.close();complete(null);await pending;
  assert.equal(h.dialogs.length,0);assert.equal(h.dialog.open,false);
  const model=harness();let answer;
  const originalAPI=model.context.api;
  model.context.api=async(url,body)=>{await new Promise(resolve=>{answer=resolve;});return originalAPI(url,body);};
  const correction=model.click('ref-correct');while(!answer)await Promise.resolve();
  model.dialog.close();answer();await correction;
  assert.equal(model.dialog.open,false);assert.equal(model.dialogs.length,0);
  assert.equal(model.context.state.project.references[0].analysis.observations.appearance,'蓝色眼睛');
});

test('closing a reference dialog captures final values without requiring an input event',async()=>{
  const store=new Map(),h=harness({store});
  h.feedbackInput.value='最后一次输入法提交';h.appearance.value='作者最后改成银发';h.dialog.close();
  const reopened=harness({store,initialForm:false});await reopened.click('ref-preview');
  assert.match(reopened.dialogs.at(-1),/最后一次输入法提交/);
  assert.match(reopened.dialogs.at(-1),/作者最后改成银发/);
});

test('adopting fields clears only the submitted adoption draft and keeps unsent opinions',async()=>{
  const store=new Map(),h=harness({store});
  h.feedbackInput.value='尚未发送的纠正意见';
  await h.submit();
  assert.equal(h.adoptions.length,1);
  assert.equal(h.dialog.open,false);
  assert.equal(h.savedFeedback(),'尚未发送的纠正意见');
  const saved=store.get('book-1:reference-session:portrait-1');
  assert.equal(saved.adoption,null);
  assert.equal(saved.feedback,'尚未发送的纠正意见');
});

test('adoption preserves hand edits made during the request for the next session',async()=>{
  const store=new Map(),h=harness({store});let complete;
  h.context.adopt=()=>new Promise(resolve=>{complete=resolve;});
  const pending=h.submit();while(!complete)await Promise.resolve();
  h.appearance.value='采用期间手改的新建议';h.feedbackInput.value='采用期间新写的意见';
  complete();await pending;
  assert.equal(h.adoptions[0].data.values.appearance,'作者手动补充：右眉有一道疤');
  const reopened=harness({store,initialForm:false});await reopened.click('ref-preview');
  assert.match(reopened.dialogs.at(-1),/采用期间手改的新建议/);
  assert.match(reopened.dialogs.at(-1),/采用期间新写的意见/);
});

test('reference adoption remains successful when auxiliary persistence fails',async()=>{
  const h=harness({store:new Map()});
  h.context.workDrafts.write=async()=>{throw new Error('disk full');};
  await h.submit();
  assert.equal(h.adoptions.length,1);assert.equal(h.dialog.open,false);
  assert.ok(h.errors.some(message=>message.includes('暂未保存到本机')));
  assert.equal(h.savedFeedback(),h.feedbackInput.value);
});

test('failed correction retains the feedback and all current adoption edits',async()=>{
  const h=harness({fail:true});
  const before=h.feedbackInput.value;
  await h.click('ref-correct');
  assert.equal(h.requests.length,1);
  assert.deepEqual(h.errors,['模型暂时不可用']);
  assert.equal(h.feedbackInput.value,before);
  assert.equal(h.savedFeedback(),before);
  assert.equal(h.appearance.value,'作者手动补充：右眉有一道疤');
  assert.equal(h.form.elements.name.value,'作者取的名字');
  assert.deepEqual(h.checked.map(input=>input.value),['appearance','goal']);
  assert.equal(h.rendered,0);
  assert.equal(h.dialogs.length,0);
  assert.equal(h.context.state.project.references[0].analysis.observations.appearance,'黑色眼睛');
});

test('feedback and adoption edits typed while a correction is pending survive the response',async()=>{
  const h=harness();
  const originalAPI=h.context.api;
  let complete;
  h.context.api=async(url,body)=>{
    await new Promise(resolve=>{complete=resolve;});
    return originalAPI(url,body);
  };
  const pending=h.click('ref-correct');
  // saveCurrent and the request setup each cross an async boundary.
  while(!complete)await Promise.resolve();
  h.feedbackInput.value='另外请纠正：手里拿的是书。';
  h.appearance.value='等待期间补充：右眉伤疤应更浅';
  h.form.elements.name.value='等待期间改的新名字';
  complete();
  await pending;
  assert.equal(h.requests[0].body.feedback,'眼睛是蓝色，请保留衣着。');
  assert.equal(h.feedbackInput.value,'另外请纠正：手里拿的是书。');
  assert.equal(h.savedFeedback(),'另外请纠正：手里拿的是书。');
  assert.match(h.dialogs.at(-1),/另外请纠正：手里拿的是书。/);
  assert.equal(h.savedDraft().values.appearance,'等待期间补充：右眉伤疤应更浅');
  assert.equal(h.savedDraft().name,'等待期间改的新名字');
  assert.match(h.dialogs.at(-1),/等待期间补充：右眉伤疤应更浅/);
});

test('next-round feedback typed while an earlier editor save is pending is also retained',async()=>{
  const h=harness();
  let finishSave;
  h.context.saveCurrent=()=>new Promise(resolve=>{finishSave=resolve;});
  const pending=h.click('ref-correct');
  while(!finishSave)await Promise.resolve();
  h.feedbackInput.value='保存还在等待时补充的下一条意见';
  finishSave();
  await pending;
  assert.equal(h.requests[0].body.feedback,'眼睛是蓝色，请保留衣着。');
  assert.equal(h.savedFeedback(),'保存还在等待时补充的下一条意见');
  assert.match(h.dialogs.at(-1),/保存还在等待时补充的下一条意见/);
});

test('starting from the original image requires a separate action and omits feedback',async()=>{
  const h=harness();
  h.context.state.project.references[0].analysis.feedback='之前要求保留黑色眼睛';
  await h.click('ref-reanalyze');
  assert.equal(h.requests.length,0);
  assert.match(h.dialogs.at(-1),/本轮不沿用之前的纠正意见/);
  await h.click('ref-reanalyze-confirm');
  assert.equal(h.requests.length,1);
  assert.equal(Object.hasOwn(h.requests[0].body,'feedback'),false);
  assert.equal(h.savedDraft().values.appearance,'作者手动补充：右眉有一道疤');
  assert.equal(h.context.state.project.references[0].analysis.feedback,undefined);
});

test('feedback must be nonempty and fit the 5000-character limit',async()=>{
  const h=harness();
  h.feedbackInput.value='   ';
  await h.click('ref-correct');
  h.feedbackInput.value='错'.repeat(5001);
  await h.click('ref-correct');
  assert.equal(h.requests.length,0);
  assert.equal(h.errors.length,2);
  assert.ok(h.errors.every(message=>message.includes('最多5000字符')));
});

test('resetting the adoption draft restores the current model suggestions',async()=>{
  const h=harness();
  await h.click('ref-correct');
  await h.click('ref-reset-draft');
  assert.match(h.dialogs.at(-1),/aria-label="采用的外貌与衣着">蓝色眼睛<\/textarea>/);
  assert.doesNotMatch(h.dialogs.at(-1),/你手动编辑的采用内容和勾选已保留/);
  assert.doesNotMatch(h.dialogs.at(-1),/作者手动补充：右眉有一道疤/);
  assert.equal(h.requests.length,1);
});
