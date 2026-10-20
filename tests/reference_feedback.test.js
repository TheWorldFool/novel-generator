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
function harness({fail=false}={}) {
  const listeners={}, requests=[], errors=[], dialogs=[];
  const original=analysis('黑色眼睛');
  const ref={id:'portrait-1',kind:'character',title:'林照参考',size:100,notes:'只参考外貌',analysis:original};
  const feedbackInput={id:'reference-feedback-input',value:'  眼睛是蓝色，请保留衣着。  ',focus(){},scrollIntoView(){}};
  const appearance={name:'value-appearance',value:'作者手动补充：右眉有一道疤'};
  const description={name:'value-description',value:original.character.description};
  const goal={name:'value-goal',value:original.character.base.goal};
  const checked=[{value:'appearance'},{value:'goal'}];
  const form={dataset:{id:ref.id,project:'book-1'},
    referenceCandidateValues:{...original.character.base,description:original.character.description,name:original.character.name,entity_id:''},
    elements:{name:{value:'作者取的名字'},entity_id:{value:''}},
  };
  let rendered=0;
  const context={
    Map, Error, console,
    document:{addEventListener(type,listener){(listeners[type]||=[]).push(listener);}},
    state:{project:{id:'book-1',revision:4,entities:[],references:[ref]},settings:{base_url:'https://model.example/v1',model:'vision-model'},fields:{character:{appearance:'外貌',goal:'目标'}},busy:false},
    $(selector){
      if(selector==='#apply-character-reference-form')return form;
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
    showDialog(html){dialogs.push(html);},
    render(){rendered++;},
    toast(message,error){if(error)errors.push(message);},
    async saveCurrent(){},
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
  vm.createContext(context);
  vm.runInContext(source,context,{filename:'references.js'});
  function click(action) {
    const button={dataset:{action,id:ref.id}};
    const event={target:{closest(selector){return selector==='[data-action]'?button:null;}}};
    listeners.click.forEach(listener=>listener(event));
    return context.pending||Promise.resolve();
  }
  return {context,click,form,appearance,description,goal,feedbackInput,checked,requests,errors,dialogs,
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
