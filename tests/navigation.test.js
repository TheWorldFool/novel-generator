'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const appSource = fs.readFileSync(path.join(__dirname, '..', 'static', 'app.js'), 'utf8').replace(/\binit\(\);\s*$/, '');
const localEditSource = fs.readFileSync(path.join(__dirname, '..', 'static', 'local-edit.js'), 'utf8');
const unescape = text => text.replace(/&(amp|lt|gt|quot|#39);/g, (_, name) => ({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"}[name]));

// Load both production event modules in their real script order. Individual
// module tests cannot catch one listener swallowing another module's action.
function harness() {
  const listeners = {}, nodes = {}, dialogs = [], calls = [], errors = [];
  let runs = 0, prevented = 0;
  const input = nodes['#chapter-text'] = {id:'chapter-text',value:'第一句话。后文保留。',selectionStart:0,selectionEnd:5,
    before(node) {
      nodes['#local-edit-toolbar'] = node;
      nodes['#local-edit-selection'] = {};
      nodes['#local-edit-resume'] = {hidden:true};
    }};
  const dialog = nodes['#dialog'] = {open:false,showModal(){this.open=true;},close(){this.open=false;}};
  Object.defineProperty(dialog, 'innerHTML', {set(html) {
    dialogs.push(html);
    const session = html.match(/id="local-edit-form" data-session="([^"]+)"/);
    if (!session) { delete nodes['#local-edit-form']; return; }
    nodes['#local-edit-form'] = {id:'local-edit-form',dataset:{session:session[1]},querySelector(q){return nodes[q] || null;}};
    for (const id of ['local-edit-instructions','local-edit-replacement']) {
      const value = html.match(new RegExp(`<textarea id="${id}"[^>]*>([\\s\\S]*?)<\\/textarea>`));
      if (value) nodes['#'+id] = {id,value:unescape(value[1]),focus(){}};
      else delete nodes['#'+id];
    }
  }});
  const context = {console,Promise,Map,Error,Date,Intl,
    document:{activeElement:input,querySelector(q){return nodes[q] || null;},querySelectorAll(){return [];},
      addEventListener(type, fn){(listeners[type] ||= []).push(fn);},createElement(){return {}; }},
    addEventListener(){},
    FormData(){throw new Error('The app submit listener must not handle the local-edit form.');},
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(localEditSource, context, {filename:'local-edit.js'});
  vm.runInContext(appSource, context, {filename:'app.js'});
  vm.runInContext('globalThis.workbenchState = state;', context);
  const state = context.workbenchState;
  state.project = {id:'book',revision:7,entities:['character','world','thread'].map(kind => ({
    id:kind+'-id',kind,name:'档案 '+kind,description:'基础设定',base:{note:'初始状态'},locked:false,
  })),chapters:[{id:'chapter',title:'第一章',text:input.value,summary:'原摘要',outline:'原场景方案',cast:[],changes:[],versions:[]}],book_outline:{active:null}};
  state.chapterId = 'chapter';
  state.fields = Object.fromEntries(['character','world','thread'].map(kind => [kind,{note:'记录'}]));
  state.canon = state.project.entities.map(entity => ({...entity,state:{...entity.base},sources:{}}));
  context.run = fn => {
    runs++;
    context.pending = Promise.resolve().then(fn).catch(error => errors.push(error.message));
  };
  context.toast = message => errors.push(message);
  context.api = async (url, body) => {
    calls.push({url,body});
    return {edit:{chapter_id:'chapter',start:body.start,end:body.end,original:body.selected_text,
      replacement:'只修改选区。',source_revision:7,source_hash:'hash'}};
  };
  function dispatch(type, target) {
    for (const listener of listeners[type] || []) listener({target,preventDefault(){prevented++;}});
    return context.pending || Promise.resolve();
  }
  function click(action, data={}) {
    const button = {dataset:{action,...data}};
    return dispatch('click', {closest(){return button;}});
  }
  return {context,state,input,dialog,nodes,dialogs,calls,errors,click,dispatch,
    get runs(){return runs;},get prevented(){return prevented;}};
}

test('character, world and thread edit buttons reach their actual populated forms', async () => {
  const h = harness();
  for (const kind of ['character','world','thread']) {
    const html = kind === 'character' ? h.context.renderCharacters() : h.context.renderWorld();
    const button = html.match(new RegExp(`data-action="edit-entity" data-id="(${kind}-id)"`));
    assert.ok(button, 'the rendered card exposes an edit action');
    const before = h.dialogs.length;
    await h.click('edit-entity', {id:button[1]});
    assert.equal(h.dialogs.length, before+1);
    assert.match(h.dialogs.at(-1), new RegExp(`id="entity-form" data-kind="${kind}" data-id="${kind}-id"`));
    assert.match(h.dialogs.at(-1), new RegExp(`value="档案 ${kind}"`));
    assert.match(h.dialogs.at(-1), /初始状态/);
  }
  assert.equal(h.runs, 0, 'opening an entity editor never starts an unrelated save');
  assert.equal(h.prevented, 0, 'the local-edit listener does not intercept entity actions');
  assert.deepEqual(h.errors, []);
});

test('new entity buttons still open the right empty form', async () => {
  const h = harness();
  for (const kind of ['character','world','thread']) {
    await h.click('new-entity', {kind});
    assert.match(h.dialogs.at(-1), new RegExp(`data-kind="${kind}" data-id=""`));
    assert.match(h.dialogs.at(-1), /name="name"[^>]*value=""/);
  }
  assert.equal(h.runs, 0);
});

test('local editing opens one dialog and submits exactly one preview across both listeners', async () => {
  const h = harness();
  h.context.decorateLocalEdit();
  assert.match(h.nodes['#local-edit-toolbar'].innerHTML, /data-action="local-edit-selection"/);
  await h.click('local-edit-selection');
  assert.equal(h.dialogs.length, 1);
  assert.equal(h.runs, 0);
  assert.equal(h.prevented, 1);
  h.nodes['#local-edit-instructions'].value = '语气更克制';
  await h.dispatch('submit', h.nodes['#local-edit-form']);
  assert.equal(h.runs, 1);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, '/api/projects/book/edit-preview');
  assert.equal(h.calls[0].body.instructions, '语气更克制');
  assert.equal(h.calls[0].body.selected_text, '第一句话。');
  assert.equal(h.state.project.chapters[0].text, h.input.value);
  assert.deepEqual(h.errors, []);
});

test('stale reviews display a warning and escape its reason', () => {
  const h = harness();
  h.state.project.chapters[0].review = {source:'ai',overview:'旧意见',issues:[],at:'2026-10-20T12:00:00Z',
    stale:true,stale_reason:'前文改动 <script>alert(1)</script>'};
  const html = h.context.renderReview();
  assert.match(html, /这份审稿已过期/);
  assert.match(html, /请重新运行预检或 AI 审稿/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  h.state.project.chapters[0].review.stale = false;
  assert.doesNotMatch(h.context.renderReview(), /这份审稿已过期/);
});

test('version preview explains restored memory candidates and legacy snapshot gaps', async () => {
  const h = harness();
  const chapter = h.state.project.chapters[0];
  chapter.versions = [{id:'version',reason:'确认正文前',at:'2026-10-20T12:00:00Z',text:'旧稿',
    summary:'旧摘要',outline:'旧场景方案',changes:[{value:'旧状态'}]}];
  await h.click('preview-version', {id:'version'});
  assert.match(h.dialogs.at(-1), /旧摘要/);
  assert.match(h.dialogs.at(-1), /旧场景方案/);
  assert.match(h.dialogs.at(-1), /包含 1 项候选状态变化；恢复后需要重新勾选/);
  delete chapter.versions[0].changes;
  await h.click('preview-version', {id:'version'});
  assert.match(h.dialogs.at(-1), /旧版本未记录候选状态变化/);
});

test('approval waits for unsaved prose and displays the new memory review requirement', async () => {
  const h = harness();
  let finishSave;
  h.state.dirty = true;
  h.context.saveCurrent = () => new Promise(resolve => { finishSave = () => {
    h.state.project.chapters[0].local_edit_review_required = true;
    h.state.project.chapters[0].changes = [{selected:false}];
    h.state.dirty = false;
    resolve();
  }; });
  let renders = 0, outlineChecks = 0;
  h.context.render = () => { renders++; };
  h.context.decorateOutlineApproval = () => { outlineChecks++; };
  const pending = h.click('approve');
  while (!finishSave) await Promise.resolve();
  assert.equal(h.dialogs.length, 0);
  finishSave();
  await pending;
  assert.match(h.dialogs.at(-1), /id="approve-local-edit-checked"/);
  assert.match(h.dialogs.at(-1), /写入 <strong>0<\/strong> 项/);
  assert.equal(renders, 1);
  assert.equal(outlineChecks, 1);
  assert.deepEqual(h.errors, []);
});

test('failed save leaves prose available and does not open a misleading approval dialog', async () => {
  const h = harness();
  h.context.saveCurrent = async () => { throw new Error('保存失败'); };
  await h.click('approve');
  assert.equal(h.dialogs.length, 0);
  assert.equal(h.state.project.chapters[0].text, h.input.value);
  assert.deepEqual(h.errors, ['保存失败']);
});
