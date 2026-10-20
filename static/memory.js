'use strict';

// A memory suggestion is separate from prose and from the author's approval.
(() => {
  const sessions = new Map();
  let serial = 0;
  const clone = value => JSON.parse(JSON.stringify(value));
  const keyFor = chapterId => `memory:${chapterId}`;
  const sessionKey = (pid, key) => `${pid}:${key}`;
  const active = session => $('#memory-form')?.dataset.session === session.session;
  const entityFor = item => state.project.entities.find(entity => entity.id === item.entity_id);

  async function persist(session) {
    if (!window.workDrafts || session.noCloseSave) return;
    // Keep the editable candidate once; metadata holds only its source snapshot.
    const {summary, changes, original, ...metadata} = session.preview;
    const originalSummary = {summary:original.summary,change_count:original.changes?.length ?? original.change_count ?? 0};
    await window.workDrafts.write(session.key, {preview:{...metadata,original:originalSummary}, candidate:session.candidate}, session.projectId);
  }

  function capture(session) {
    if (!active(session) || session.noCloseSave) return;
    session.candidate.summary = $('#memory-summary').value;
    session.candidate.changes.forEach((item, index) => {
      item.entity_id = $(`#memory-${index}-entity`).value;
      item.field = $(`#memory-${index}-field`).value;
      item.value = $(`#memory-${index}-value`).value;
      item.evidence = $(`#memory-${index}-evidence`).value;
      item.selected = $(`#memory-${index}-selected`).checked;
    });
  }

  function targetOptions(item) {
    const exists = entityFor(item);
    return `${exists ? '' : `<option value="${esc(item.entity_id)}">未知档案 · 请重新选择或移除</option>`}${state.project.entities.map(entity =>
      `<option value="${esc(entity.id)}" ${entity.id===item.entity_id?'selected':''}>${esc(entity.name)}${entity.locked?'（已锁定）':''}</option>`).join('')}`;
  }

  function fieldOptions(item) {
    const fields = state.fields[entityFor(item)?.kind] || {};
    return `${Object.hasOwn(fields,item.field) ? '' : `<option value="${esc(item.field)}">未知字段 · 请重新选择或移除</option>`}${Object.entries(fields).map(([key,label]) =>
      `<option value="${esc(key)}" ${key===item.field?'selected':''}>${esc(label)}</option>`).join('')}`;
  }

  function row(item, index, text) {
    const entity = entityFor(item);
    const warning = !entity || !Object.hasOwn(state.fields[entity.kind] || {},item.field)
      ? '关联档案或字段已不存在，请重新选择或移除此项。'
      : entity.locked ? '此档案已锁定，此项可以保留待修，不能勾选入库。'
      : !item.value.trim() ? '请补充变化后的状态。'
      : !item.evidence.trim() || !text.includes(item.evidence) ? '依据未在当前正文找到。请从正文复制逐字一致的原文。' : '';
    return `<section class="memory-candidate"><div class="memory-candidate-heading"><label class="check-line"><input id="memory-${index}-selected" type="checkbox" ${item.selected?'checked':''}>保留为已勾选候选 ${index+1}</label><button type="button" class="text-button muted" data-action="memory-remove" data-index="${index}">移除此项</button></div><div class="memory-target"><label class="field">相关档案<select id="memory-${index}-entity" data-memory-entity="${index}">${targetOptions(item)}</select></label><label class="field">状态字段<select id="memory-${index}-field">${fieldOptions(item)}</select></label></div><label class="field">变化后的完整状态<textarea id="memory-${index}-value" rows="3" maxlength="5000">${esc(item.value)}</textarea></label><label class="field">原文依据<textarea id="memory-${index}-evidence" rows="3" maxlength="5000">${esc(item.evidence)}</textarea></label>${warning?`<p class="warning-text">${esc(warning)}</p>`:''}</section>`;
  }

  function show(session) {
    session.noCloseSave = false;
    const p = session.preview, c = state.project.chapters.find(chapter => chapter.id===p.chapter_id);
    const stale = state.project.id!==session.projectId || state.project.revision!==p.source_revision || state.dirty;
    const original = p.original;
    const originalChanges = original.changes || [];
    const originalCount = original.changes?.length ?? original.change_count ?? 0;
    showDialog(`<form id="memory-form" data-session="${session.session}" class="memory-form"><div class="eyebrow green">CHAPTER MEMORY</div><h2>${p.manual?'编辑当前摘要与状态候选':'核对从正文提取的章节记忆'}</h2><p class="help">采用只保存本章摘要与下面的状态候选，正文保持原样。勾选项也需要你另行“确认正文”后才会进入正式记忆。</p>${stale?'<div class="notice amber">作品已更新，这份候选已过期。仍可修改、复制和保留，请重新从当前正文生成或打开当前记忆后采用。</div>':''}${(p.warnings || []).length?`<details class="memory-warnings"><summary>有 ${(p.warnings || []).length} 项需要核对</summary>${p.warnings.map(warning=>`<p>${esc(warning)}</p>`).join('')}</details>`:''}<details class="memory-original"><summary>原摘要与 ${originalCount} 项原候选 · 采用前保留</summary><h3>原摘要</h3><pre>${esc(original.summary || '（尚未填写）')}</pre>${originalChanges.map(item=>{const entity=entityFor(item);return `<div class="memory-original-change"><strong>${esc(entity?.name || '未知档案')} · ${esc(state.fields[entity?.kind]?.[item.field] || item.field)}</strong><p>${esc(item.value)}</p><blockquote>${esc(item.evidence || '未提供依据')}</blockquote><small>${item.selected?'原来已勾选':'原来未勾选'}</small></div>`;}).join('')}${!original.changes&&originalCount?'<p class="help">重启恢复的预览仅保留原摘要和原候选数量。采用前可关闭此窗，在本章“变化”中查看原候选。</p>':''}</details><label class="field">${p.manual?'章节事实摘要':'候选摘要'} · 可直接修改<textarea id="memory-summary" rows="6" maxlength="10000">${esc(session.candidate.summary)}</textarea></label><p class="help">${p.manual?'已有勾选会保留；需要修正的条目会取消勾选。':'AI 新提取的状态候选默认均未勾选。'}可修改档案、字段、状态和依据；未勾选项会保存为待修候选。</p><div class="memory-candidates">${session.candidate.changes.map((item,index)=>row(item,index,c?.text || '')).join('') || '<p class="help">没有状态变化候选。你仍可保存摘要，稍后在“变化”中手动添加。</p>'}</div><div class="dialog-actions"><button type="button" class="button subtle" data-action="memory-close">保留候选并关闭</button><button type="button" class="text-button" data-action="memory-discard">丢弃这份候选</button><button type="submit" class="button primary" ${stale?'disabled':''}>保存摘要与候选</button></div></form>`);
  }

  async function openPreview(preview, reveal=true, projectId=state.project.id) {
    const key = keyFor(preview.chapter_id);
    const session = {projectId,key,session:String(++serial),preview,
      candidate:{summary:preview.summary,changes:clone(preview.changes)}};
    sessions.set(sessionKey(projectId,key),session);
    if (reveal) show(session);
    window.decorateMemory();
    await persist(session);
    return session;
  }

  async function resume() {
    const pid=state.project.id, cid=current().id, key=keyFor(cid);
    let session=sessions.get(sessionKey(pid,key));
    if (!session && window.workDrafts) {
      const saved=await window.workDrafts.read(key,pid);
      if (!saved) {toast('没有待核对的章节记忆。');return;}
      session={...saved,projectId:pid,key,session:String(++serial)};
      sessions.set(sessionKey(pid,key),session);
    }
    if (session && state.project.id===pid && current().id===cid) show(session);
  }

  window.previewChapterMemory = async function({manual=false,instructions=''}={}) {
    await saveCurrent();
    if (!manual && (!state.settings.base_url || !state.settings.model)) {
      state.view='settings';render();toast('先填写模型地址与名称，即可从正文更新记忆。');return;
    }
    const pid=state.project.id, cid=current().id, pendingId=String(++serial);
    if (!current().text.trim()) throw new Error('请先写下正文，再更新章节记忆。');
    showDialog(`<div id="memory-pending" data-session="${pendingId}"><div class="eyebrow green">CHAPTER MEMORY</div><h2>${manual?'正在打开当前章节记忆…':'正在从当前正文提取记忆…'}</h2><p class="help">正文、原摘要和状态候选会完整保留。你可以关闭，结束后继续核对。</p><div class="dialog-actions"><button type="button" class="button subtle" data-action="memory-close-pending">关闭，稍后核对</button></div></div>`);
    let result;
    try {result=await api(`/api/projects/${pid}/memory-preview`,{revision:state.project.revision,chapter_id:cid,manual,instructions});}
    catch(error){if($('#memory-pending')?.dataset.session===pendingId && $('#dialog').open)$('#dialog').close();throw error;}
    const visible=state.project.id===pid && current().id===cid && $('#memory-pending')?.dataset.session===pendingId && $('#dialog').open;
    await openPreview(result.memory,visible,pid);
    if(!visible)toast('章节记忆候选已保留，回到原章节可继续核对。');
  };

  window.decorateMemory = function() {
    if (state.view!=='write') return;
    const toolbar = location => `<div class="memory-entries" id="memory-entries-${location}"><button type="button" class="button outline small" data-action="memory-generate">从当前正文更新记忆</button><button type="button" class="button subtle small" data-action="memory-edit-current">编辑当前摘要与候选</button><button type="button" class="text-button memory-resume" data-action="memory-resume" hidden>继续核对上次的记忆候选</button><p class="help">先预览再采用，正文保持原样。</p></div>`;
    if ($('#chapter-summary') && !$('#memory-entries-summary')) $('#chapter-summary').insertAdjacentHTML('afterend',toolbar('summary'));
    if (state.sideTab==='changes' && $('.context-body') && !$('#memory-entries-changes')) $('.context-body').insertAdjacentHTML('afterbegin',toolbar('changes'));
    const pid=state.project.id,cid=current().id,key=keyFor(cid);
    const reveal=()=>{if(state.view==='write'&&state.project.id===pid&&current().id===cid)for(const button of document.querySelectorAll('.memory-resume'))button.hidden=false;};
    if(sessions.has(sessionKey(pid,key))){reveal();return;}
    if(window.workDrafts)window.workDrafts.read(key,pid).then(saved=>{if(saved)reveal();}).catch(error=>toast(error.message,true));
  };

  function visibleSession() {
    const id=$('#memory-form')?.dataset.session;
    return [...sessions.values()].find(session=>session.session===id);
  }

  function captureOnDismiss(event) {
    if(event.target.id!=='dialog' || (event.type==='close' && $('#dialog').open))return;
    const session=visibleSession();if(!session || session.noCloseSave)return;
    capture(session);persist(session).catch(error=>toast(`记忆候选尚未保留：${error.message}`,true));
  }
  document.addEventListener('cancel',captureOnDismiss,true);
  document.addEventListener('close',captureOnDismiss,true);

  for(const type of ['input','change'])document.addEventListener(type,event=>{
    if(!event.target.closest('#memory-form'))return;
    const session=visibleSession();if(!session || session.noCloseSave)return;
    capture(session);
    if(type==='change' && event.target.dataset?.memoryEntity!==undefined) {
      const item=session.candidate.changes[Number(event.target.dataset.memoryEntity)];
      const fields=state.fields[entityFor(item)?.kind] || {};
      if(!Object.hasOwn(fields,item.field))item.field=Object.keys(fields)[0] || '';
      show(session);
    }
    persist(session).catch(error=>toast(`记忆候选尚未保留：${error.message}`,true));
  });

  document.addEventListener('click',event=>{
    const button=event.target.closest('[data-action]');
    if(!button || !button.dataset.action.startsWith('memory-'))return;
    event.preventDefault();const action=button.dataset.action;
    if(action==='memory-close-pending'){$('#dialog').close();return;}
    if(state.busy)return;
    if(action==='memory-generate' || action==='memory-edit-current') {
      run(()=>window.previewChapterMemory({manual:action==='memory-edit-current'}),action==='memory-generate'?'正在提取章节记忆…':'正在打开章节记忆…');return;
    }
    if(action==='memory-resume'){run(resume);return;}
    const session=visibleSession();if(!session)return;capture(session);
    if(action==='memory-remove') {
      session.candidate.changes.splice(Number(button.dataset.index),1);show(session);
      persist(session).catch(error=>toast(error.message,true));
    }
    if(action==='memory-close')run(async()=>{await persist(session);$('#dialog').close();});
    if(action==='memory-discard')run(async()=>{
      // Close before deleting the auxiliary draft so detached input events
      // cannot recreate a suggestion the author has already discarded.
      session.noCloseSave=true;$('#dialog').close();
      await window.workDrafts?.remove(session.key,session.projectId);
      sessions.delete(sessionKey(session.projectId,session.key));render();
    });
  });

  document.addEventListener('submit',event=>{
    if(event.target.id!=='memory-form')return;
    event.preventDefault();if(state.busy)return;
    const session=visibleSession();if(!session)return;capture(session);
    const sent=clone(session),p=sent.preview;
    run(async()=>{
      await persist(session);
      if(state.project.id!==sent.projectId || state.dirty || state.project.revision!==p.source_revision)throw new Error('作品已更新，候选已过期。请保留候选并重新从当前正文生成或打开当前记忆。');
      if(!sent.candidate.summary.trim())throw new Error('请先补充章节事实摘要。');
      const result=await api(`/api/projects/${sent.projectId}/mutate`,{revision:state.project.revision,action:'apply_memory',
        data:{chapter_id:p.chapter_id,source_revision:p.source_revision,source_hash:p.source_hash,...sent.candidate}});
      capture(session);
      const changed=JSON.stringify(session.candidate)!==JSON.stringify(sent.candidate);
      const visible=active(session)&&$('#dialog').open;
      accept(result);
      let cleanupError;
      if(changed) {
        // These inputs now refer to an older source. Disable adoption before
        // awaiting auxiliary persistence, and keep the DOM for final IME input.
        if(visible) {
          const form=$('#memory-form');form.querySelector('button[type="submit"]').disabled=true;
          form.insertAdjacentHTML('afterbegin','<div class="notice amber">章节记忆已保存。等待期间继续修改的候选已过期，仍保留供复制参考。</div>');
        }
        render();
        try{await persist(session);}catch(error){cleanupError=error;}
        toast('已保存点击时的摘要与候选。继续修改的内容已保留供复制参考，正文保持原样。');
      } else {
        session.noCloseSave=true;if(visible)$('#dialog').close();render();
        try{await window.workDrafts?.remove(session.key,session.projectId);sessions.delete(sessionKey(session.projectId,session.key));}
        catch(error){cleanupError=error;}
        toast('摘要与状态候选已保存。请核对后另行确认正文。');
      }
      if(cleanupError)toast(`章节记忆已保存。候选草稿整理暂未完成：${cleanupError.message}。保留的候选可复制，不能重复采用。`,true);
    },'正在保存章节记忆…');
  });
})();
