'use strict';

// Unfinished input lives beside the work in SQLite, including on Android where
// each restarted local service can have a different browser origin/port.
(() => {
  const entries = new Map();
  const supportedForms = new Set(['entity-form','project-form','change-form','style-reference-form','image-reference-form','outline-node-form']);
  const forbiddenNames = new Set(['api_key','password','file','base64','path','token']);
  let projectId = null, dialogSession = null, inputTimer;
  const clone = value => value == null ? null : JSON.parse(JSON.stringify(value));
  const pidAtCall = explicit => explicit || projectId || (typeof state !== 'undefined' ? state.project?.id : null);

  function entryFor(key, explicit) {
    const pid = pidAtCall(explicit);
    if (!pid) throw new Error('请先打开作品，再保留草稿。');
    const id = `${pid}\n${key}`;
    if (!entries.has(id)) entries.set(id,{pid,key,value:null,version:0,loaded:false,loading:null,dirty:false,deleted:false,generation:0,chain:Promise.resolve(),error:null,blocked:false});
    return entries.get(id);
  }

  async function load(entry) {
    if (entry.loaded) return;
    if (!entry.loading) entry.loading = api(`/api/projects/${entry.pid}/drafts`,{action:'read',key:entry.key}).then(result => {
      entry.version = result.draft.version;
      if (!entry.dirty) { entry.value = clone(result.draft.value); entry.deleted = entry.value === null; }
      entry.loaded = true;
    }).finally(() => { entry.loading = null; });
    await entry.loading;
  }

  function persist(entry) {
    const task = entry.chain.catch(() => {}).then(async () => {
      if (entry.blocked) throw entry.error;
      if (!entry.dirty) return;
      const generation = entry.generation;
      const value = clone(entry.value), deleted = entry.deleted;
      try {
        await load(entry);
        const result = await api(`/api/projects/${entry.pid}/drafts`,{
          action:deleted?'delete':'write',key:entry.key,expected_version:entry.version,...(deleted?{}:{value}),
        });
        entry.version = result.draft.version;
        if (entry.generation === generation) entry.dirty = false;
        entry.error = null;
      } catch (error) {
        entry.error = error;
        entry.blocked = error.status === 409;
        throw error;
      }
    });
    entry.chain = task;
    // Keep rejection observable to callers without an unhandled rejection if a
    // lifecycle hook started a write immediately before the view disappeared.
    task.catch(() => {});
    return task;
  }

  async function read(key, explicit) {
    const entry = entryFor(key,explicit);
    await load(entry);
    return entry.deleted ? null : clone(entry.value);
  }

  function write(key, value, explicit) {
    const entry = entryFor(key,explicit);
    entry.value = clone(value); entry.deleted = false; entry.dirty = true; entry.generation++;
    return persist(entry);
  }

  function remove(key, explicit) {
    const entry = entryFor(key,explicit);
    entry.value = null; entry.deleted = true; entry.dirty = true; entry.generation++;
    return persist(entry);
  }

  async function flush(explicit) {
    const pid = explicit || null;
    if (dialogSession && (!pid || dialogSession.pid === pid)) await captureDialog();
    const pending = [...entries.values()].filter(entry => (!pid || entry.pid === pid) && entry.dirty);
    await Promise.all(pending.map(persist));
  }

  function controls(form) {
    return [...form.querySelectorAll('input[name],textarea[name],select[name]')].filter(node =>
      !['file','password','submit','button','reset'].includes(node.type) && !forbiddenNames.has(node.name.toLowerCase()));
  }

  function fields(form) {
    const result = {};
    for (const node of controls(form)) {
      const item = {value:node.value};
      if (['checkbox','radio'].includes(node.type)) item.checked = Boolean(node.checked);
      (result[node.name] ||= []).push(item);
    }
    return result;
  }

  function fingerprint(text) {
    let hash = 2166136261;
    for (let index=0; index<text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index),16777619);
    return (hash >>> 0).toString(16);
  }

  function formKey(form) {
    const suffix = form.dataset.id || (form.id === 'change-form' ? (typeof current === 'function' ? current().id : '') : '') || 'new';
    const kind = form.dataset.kind || '';
    const association = form.id === 'image-reference-form' ? (form.querySelector('[name="entity_id"]')?.value || 'new') : '';
    return `dialog:${form.id}:${kind}:${suffix}${association?':'+association:''}`;
  }

  function status(session, message, failed=false) {
    if (dialogSession !== session || !session.form.isConnected) return;
    if (!session.notice) {
      const notice = document.createElement('div');
      notice.className = 'notice';
      notice.setAttribute('role','status');
      const label = document.createElement('span');
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'text-button'; button.dataset.action = 'work-draft-discard';
      button.textContent = '放弃草稿并关闭';
      notice.append(label,document.createTextNode(' '),button);
      session.form.prepend(notice); session.notice = notice; session.label = label;
    }
    session.notice.classList.toggle('amber',failed);
    session.label.textContent = message;
  }

  function applyFields(form, saved) {
    // The entity selector controls the field selector in a state-change form.
    // Restore it first so the dependent options exist before their value is set.
    const nodes = controls(form), occurrence = {};
    for (const node of nodes) {
      const index = occurrence[node.name] || 0; occurrence[node.name] = index + 1;
      const item = saved[node.name]?.[index];
      if (!item || typeof item.value !== 'string') continue;
      if (node.tagName === 'SELECT' && ![...node.options].some(option => option.value === item.value)) {
        const option = document.createElement('option');
        option.value = item.value; option.textContent = '草稿中的选项已变更，请重新核对'; node.append(option);
      }
      node.value = item.value;
      if (typeof item.checked === 'boolean' && ['checkbox','radio'].includes(node.type)) node.checked = item.checked;
      if (node.id === 'change-entity') node.dispatchEvent(new Event('change',{bubbles:true}));
    }
  }

  async function dialogOpened() {
    clearTimeout(inputTimer);
    const dialog = document.querySelector('#dialog');
    const form = dialog?.querySelector('form');
    dialogSession = null;
    if (!form || !supportedForms.has(form.id)) return;
    const initial = fields(form);
    const context = form.id === 'change-form' && typeof current === 'function' ? fingerprint(current().text || '') : '';
    const session = {form,pid:pidAtCall(),key:formKey(form),base:JSON.stringify(initial),context,initial,serial:0,restoring:false,saved:false,loading:true};
    form.workDraftSession = session; dialogSession = session;
    form.inert = true;
    try {
      const saved = await read(session.key,session.pid);
      if (dialogSession !== session || !form.isConnected || session.saved) return;
      // Author typing while the read is in flight always wins over restoration.
      if (session.serial || !saved || saved.formId !== form.id || !saved.fields) return;
      session.restoring = true; applyFields(form,saved.fields); session.restoring = false;
      const stale = saved.base !== session.base || (saved.context || '') !== session.context;
      session.base = saved.base || session.base;
      session.context = saved.context || session.context;
      status(session,stale?'已找回未保存的草稿。基础资料或正文已变化，请核对后保存。':'已找回未保存的草稿，可继续编辑或放弃。',stale);
      if (form.id === 'image-reference-form') status(session,'已找回名称和设定方向。图片未保留，请重新选择图片。',stale);
    } catch (error) {
      status(session,'暂时无法读取旧草稿：'+error.message,true);
    } finally {
      session.loading = false;
      session.restoring = false;
      form.inert = Boolean(typeof state !== 'undefined' && state.busy);
    }
  }

  async function captureDialog() {
    const session = dialogSession;
    if (!session || session.saved || session.restoring || !session.form.isConnected) return;
    clearTimeout(inputTimer);
    const value = {formId:session.form.id,fields:fields(session.form),base:session.base,context:session.context};
    const serialized = JSON.stringify(value);
    if (serialized === session.lastCaptured) return;
    if (!session.lastCaptured && JSON.stringify(value.fields) === session.base) return;
    session.lastCaptured = serialized;
    status(session,'正在保留未保存的草稿…');
    try {
      await write(session.key,value,session.pid);
      status(session,'未保存的输入已保留；关闭后可在这里继续。');
    } catch (error) {
      session.lastCaptured = null;
      status(session,'草稿保留失败，请先复制输入并重试：'+error.message,true);
      throw error;
    }
  }

  async function requestClose() {
    if (window.backupImportBusy?.()) {
      if (typeof toast === 'function') toast('正在恢复作品，请稍候再关闭。');
      return false;
    }
    const session = dialogSession;
    try { await captureDialog(); await flush(session?.pid); }
    catch (error) { if(typeof toast === 'function') toast('草稿尚未保留：'+error.message,true); return false; }
    // Another listener can begin an import while an asynchronous flush yields.
    if (window.backupImportBusy?.()) return false;
    document.querySelector('#dialog')?.close();
    if (dialogSession === session) dialogSession = null;
    return true;
  }

  async function dialogSaved(form) {
    const session = form?.workDraftSession;
    if (!session) return;
    clearTimeout(inputTimer);
    // The caller invokes this only after the formal operation succeeded.
    // Do not re-capture the input while the delete is in flight.
    session.saved = true;
    try { await remove(session.key,session.pid); }
    catch (error) {
      // The real work was already saved. A failed auxiliary cleanup must not
      // invite another click that creates a second character/reference/book.
      if (typeof toast === 'function') toast('内容已保存，但旧输入草稿暂未清理：'+error.message,true);
      if (dialogSession === session) dialogSession = null;
      return false;
    }
    if (dialogSession === session) dialogSession = null;
    return true;
  }

  async function discardDialog() {
    const session = dialogSession;
    if (!session) return;
    clearTimeout(inputTimer);
    try {
      await remove(session.key,session.pid);
      if (dialogSession === session) dialogSession = null;
      document.querySelector('#dialog')?.close();
    } catch (error) { status(session,'草稿未能放弃，输入仍保留：'+error.message,true); }
  }

  function input(event) {
    const session = dialogSession;
    if (!session || session.restoring || !session.form.contains(event.target)) return;
    if (event.target.type === 'file' || event.target.type === 'password') return;
    session.serial++;
    clearTimeout(inputTimer);
    inputTimer = setTimeout(() => { captureDialog().catch(() => {}); },450);
  }

  document.addEventListener('input',input);
  document.addEventListener('change',input);
  document.addEventListener('submit',event => {
    if (!event.target.workDraftSession?.loading) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (typeof toast === 'function') toast('正在读取未完成的草稿，请稍候再保存。');
  },true);
  document.addEventListener('click',event => {
    if (event.target.closest('[data-action="work-draft-discard"]')) {
      event.preventDefault(); event.stopImmediatePropagation(); discardDialog();
    }
  });
  document.addEventListener('cancel',event => {
    if (event.target.id !== 'dialog') return;
    event.preventDefault();
    if (window.backupImportBusy?.()) return;
    requestClose();
  },true);
  document.addEventListener('visibilitychange',() => {
    if (document.visibilityState === 'hidden') flush().catch(error => { if(typeof toast === 'function') toast('草稿保留失败：'+error.message,true); });
  });
  window.addEventListener('pagehide',() => { flush().catch(() => {}); });

  window.workDrafts = {setProject(pid){projectId=pid;},read,write,remove,flush,
    hasPending(){return [...entries.values()].some(entry=>entry.dirty && !entry.deleted);},
    dialogOpened,captureDialog,requestClose,dialogSaved,discardDialog};
})();
