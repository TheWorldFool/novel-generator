'use strict';

// AI planning is a preview. Only an explicit adoption request changes a draft.
(() => {
  const sessions = new Map();
  let serial = 0;
  const clone = value => JSON.parse(JSON.stringify(value));
  const keyFor = (kind, chapterId) => kind === 'outline' ? 'proposal:outline' : `proposal:${kind}:${chapterId}`;
  const sessionKey = (pid,key) => `${pid}:${key}`;
  const active = session => $('#proposal-form')?.dataset.session === session.session;

  async function persist(session) {
    if (!window.workDrafts || session.noCloseSave) return;
    // The editable candidate already contains the suggestion. Omitting the
    // duplicate keeps even emoji-heavy maximum outlines below the draft limit.
    const {draft,outline,text,summary,changes,...metadata}=session.proposal;
    if(session.proposal.kind==='rewrite')metadata.original={text:metadata.original.text,summary:metadata.original.summary,
      change_count:metadata.original.changes?.length ?? metadata.original.change_count ?? 0};
    await window.workDrafts.write(session.key, {proposal:metadata, mode:session.mode,
      candidate:session.candidate, selected:session.selected,instructions:session.instructions || ''}, session.projectId);
  }

  function capture(session) {
    if (!active(session)) return;
    if (session.proposal.kind === 'rewrite') {
      session.candidate.text=$('#proposal-rewrite-text').value;
      session.candidate.summary=$('#proposal-rewrite-summary').value;
      session.candidate.changes.forEach((item,index)=>{
        for(const key of ['entity_id','field','value','evidence'])item[key]=$(`#proposal-change-${index}-${key}`).value;
        item.selected=$(`#proposal-change-${index}-selected`).checked;
      });
    }
    else if (session.proposal.kind === 'plan') session.candidate = $('#proposal-plan').value;
    else {
      session.mode = $('#proposal-mode').value;
      const ending = $('#proposal-ending');
      if (ending) session.candidate.ending = ending.value;
      session.candidate.nodes.forEach((node,i) => {
        session.selected[i] = $(`#proposal-node-${i}-selected`).checked;
        for (const key of Object.keys(outlineNodeLabels)) node[key] = $(`#proposal-node-${i}-${key}`).value;
      });
    }
  }

  function rewriteChange(item,index,text) {
    const entities=state.project.entities || [],entity=entities.find(e=>e.id===item.entity_id);
    const fields=state.fields?.[entity?.kind] || {};
    const entitiesHTML=`${entity?'':`<option value="${esc(item.entity_id)}">未知档案 · 请重新选择或移除</option>`}${entities.map(e=>`<option value="${esc(e.id)}" ${e.id===item.entity_id?'selected':''}>${esc(e.name)}${e.locked?'（已锁定）':''}</option>`).join('')}`;
    const fieldsHTML=`${Object.hasOwn(fields,item.field)?'':`<option value="${esc(item.field)}">未知字段 · 请重新选择或移除</option>`}${Object.entries(fields).map(([key,label])=>`<option value="${esc(key)}" ${key===item.field?'selected':''}>${esc(label)}</option>`).join('')}`;
    const warning=!entity || !Object.hasOwn(fields,item.field)?'档案或字段已变化，请重新选择或移除此项。':entity.locked?'档案已锁定，不能勾选此项。':!item.value.trim()?'请补充完整状态。':!item.evidence.trim() || !text.includes(item.evidence)?'依据未在候选正文找到，请逐字核对。':'';
    return `<section class="proposal-node"><div class="proposal-change-heading"><label class="check-line"><input id="proposal-change-${index}-selected" type="checkbox" ${item.selected?'checked':''}>勾选状态候选 ${index+1}</label><button type="button" class="text-button" data-action="proposal-change-remove" data-index="${index}">移除此项</button></div><div class="proposal-change-target"><label class="field">相关档案<select id="proposal-change-${index}-entity_id" data-proposal-entity="${index}">${entitiesHTML}</select></label><label class="field">状态字段<select id="proposal-change-${index}-field">${fieldsHTML}</select></label></div><label class="field">变化后的完整状态<textarea id="proposal-change-${index}-value" rows="3" maxlength="5000">${esc(item.value)}</textarea></label><label class="field">候选正文中的原文依据<textarea id="proposal-change-${index}-evidence" rows="3" maxlength="5000">${esc(item.evidence)}</textarea></label>${warning?`<p class="warning-text">${esc(warning)}</p>`:''}</section>`;
  }

  function rewriteContent(session) {
    const p=session.proposal,original=p.original;
    return `<p class="help">原稿会保留到你点击采用。可分别调整候选正文、摘要和状态；采用后仍需另行确认入库。</p>${session.instructions?`<details class="proposal-original"><summary>本次修订意见</summary><pre>${esc(session.instructions)}</pre></details>`:''}${(p.warnings || []).length?`<details class="proposal-original"><summary>有 ${p.warnings.length} 项状态候选需要核对</summary>${p.warnings.map(w=>`<p>${esc(w)}</p>`).join('')}</details>`:''}<div class="proposal-comparison proposal-rewrite-comparison"><details open><summary>原正文 · 采用前保留</summary><pre>${esc(original.text)}</pre></details><label class="field">候选正文 · 可直接修改<textarea id="proposal-rewrite-text" rows="18" maxlength="100000">${esc(session.candidate.text)}</textarea></label></div><details class="proposal-original"><summary>原摘要与 ${original.changes?.length ?? original.change_count ?? 0} 项状态候选</summary><pre>${esc(original.summary || '（尚未填写）')}</pre><p class="help">原状态候选仍保留在本章“变化”中。采用时原正文、摘要和状态会一起保存到历史版本。</p></details><label class="field">候选章节摘要 · 可直接修改<textarea id="proposal-rewrite-summary" rows="5" maxlength="10000">${esc(session.candidate.summary)}</textarea></label><p class="help">AI 状态候选默认均未勾选。可修改或移除；未勾选项将保留为待修候选，勾选项也需要另行确认正文才会入库。</p>${session.candidate.changes.map((item,index)=>rewriteChange(item,index,session.candidate.text)).join('') || '<p class="help">没有状态变化候选，可采用正文后在“变化”中手动添加。</p>'}`;
  }

  function show(session) {
    session.noCloseSave = false;
    const p = session.proposal;
    const stale = state.project.id !== session.projectId || state.project.revision !== p.source_revision || state.dirty;
    let content;
    if (p.kind === 'rewrite')content=rewriteContent(session);
    else if (p.kind === 'plan') {
      content = `<div class="proposal-comparison"><details open><summary>当前场景方案 · 保留至采用</summary><pre>${esc(p.original || '（尚未填写）')}</pre></details><label class="field">候选场景方案 · 可直接修改<textarea id="proposal-plan" rows="13" maxlength="10000">${esc(session.candidate)}</textarea></label></div><p class="help">采用时只更新本章场景方案。原方案会保留在章节历史中，正文与正式记忆不会改变。</p>`;
    } else {
      content = `<details class="proposal-original" open><summary>当前草稿的 ${p.original.nodes.length} 个节点 · 采用前保留</summary>${p.original.nodes.map(n=>`<p><strong>${esc(n.title)}</strong> · ${esc(n.goal)}</p>`).join('') || '<p>当前草稿尚无节点。</p>'}</details><label class="field">采用方式<select id="proposal-mode"><option value="replace" ${session.mode==='replace'?'selected':''}>用选中的候选替换草稿节点</option><option value="append" ${session.mode==='append'?'selected':''}>追加到现有草稿节点末尾</option></select></label>${!p.original.ending?`<label class="field">候选结局 · 请作者核对<textarea id="proposal-ending" rows="2" maxlength="5000">${esc(session.candidate.ending)}</textarea><small>未填写时仍可采用节点，确认大纲生效前需要确定结局。</small></label>`:''}<p class="help">勾选要采用的节点，可以先改写标题、目标和事件。大纲原文、约束与已确定的结局仍以你的原稿为准。</p><div class="proposal-nodes">${session.candidate.nodes.map((node,i)=>`<section class="proposal-node"><label class="check-line"><input type="checkbox" id="proposal-node-${i}-selected" ${session.selected[i]?'checked':''}>采用候选节点 ${i+1}</label>${Object.entries(outlineNodeLabels).map(([key,label])=>`<label class="field">${label}${key==='title'?`<input id="proposal-node-${i}-${key}" maxlength="200" value="${esc(node[key])}">`:`<textarea id="proposal-node-${i}-${key}" rows="2" maxlength="3000">${esc(node[key])}</textarea>`}</label>`).join('')}</section>`).join('')}</div><p class="help">采用只进入大纲草稿，不会自动生效。当前草稿会先存为历史，可随时恢复。</p>`;
    }
    showDialog(`<form id="proposal-form" data-session="${session.session}" class="proposal-form"><div class="eyebrow green">REVIEW BEFORE ADOPTING</div><h2>${p.kind==='outline'?'先挑选和修改阶段节点':p.kind==='rewrite'?'先比较和修改整章修订':'先核对这份场景方案'}</h2>${stale?'<div class="notice amber">作品已更新，这份候选已过期。候选仍保留供复制参考，请重新生成后采用。</div>':''}${content}<div class="dialog-actions"><button type="button" class="button subtle" data-action="proposal-close">保留候选并关闭</button><button type="button" class="text-button" data-action="proposal-discard">丢弃这份候选</button><button type="submit" class="button primary" ${stale?'disabled':''}>${p.kind==='outline'?'采用选中的节点到草稿':p.kind==='rewrite'?'采用候选正文与章节记忆':'采用这份场景方案'}</button></div></form>`);
  }

  async function openProposal(proposal, reveal=true, projectId=state.project.id, instructions='') {
    const key = keyFor(proposal.kind, proposal.chapter_id);
    const session = {projectId,key,session:String(++serial),proposal,instructions,
      mode:'replace',candidate:clone(proposal.kind === 'outline' ? proposal.draft : proposal.kind==='rewrite'?{text:proposal.text,summary:proposal.summary,changes:proposal.changes}:proposal.outline),
      selected:proposal.kind === 'outline' ? proposal.draft.nodes.map(()=>true) : []};
    sessions.set(sessionKey(session.projectId,key),session);
    if(reveal)show(session);
    window.decorateProposalEntries();
    await persist(session);
    return session;
  }

  async function resume(kind, chapterId) {
    const pid = state.project.id, key = keyFor(kind, chapterId);
    let session = sessions.get(sessionKey(pid,key));
    if (!session && window.workDrafts) {
      const saved = await window.workDrafts.read(key,pid);
      if (!saved) { toast('没有待采用的候选。'); return; }
      session = {...saved,projectId:pid,key,session:String(++serial)};
      sessions.set(sessionKey(pid,key),session);
    }
    if (session && state.project.id === pid && (kind==='outline'||current().id===chapterId)) show(session);
  }

  window.showOutlineProposal = openProposal;
  window.previewOutlineNodes = async function() {
    const pid=state.project.id,pendingId=String(++serial);
    showDialog(`<div id="proposal-pending" data-session="${pendingId}"><div class="eyebrow green">OUTLINE PREVIEW</div><h2>正在拆解候选阶段节点…</h2><p class="help">当前大纲草稿会完整保留。你可以关闭，生成结束后再继续核对候选。</p><div class="dialog-actions"><button type="button" class="button subtle" data-action="proposal-close-pending">关闭，稍后核对</button></div></div>`);
    let result;
    try{result=await api(`/api/projects/${pid}/outline-ai`,{revision:state.project.revision});}
    catch(error){if($('#proposal-pending')?.dataset.session===pendingId&&$('#dialog').open)$('#dialog').close();throw error;}
    if(state.project.id!==pid)throw new Error('当前作品已切换，原大纲保持原样。');
    const visible=$('#proposal-pending')?.dataset.session===pendingId&&$('#dialog').open;
    await openProposal(result.proposal,visible);
    if(!visible)toast('候选节点已保留，点击“继续核对上次的候选节点”查看。');
  };
  window.previewScenePlan = async function(instructions='') {
    await saveCurrent();
    if (!state.settings.base_url || !state.settings.model) {
      state.view='settings';render();toast('先填写模型地址与名称，即可生成场景方案。');return;
    }
    const pid=state.project.id,cid=current().id,pendingId=String(++serial);
    showDialog(`<div id="proposal-pending" data-session="${pendingId}"><div class="eyebrow green">PLAN PREVIEW</div><h2>正在生成候选场景方案…</h2><p class="help">当前方案会完整保留。你可以关闭，生成结束后再继续核对候选。</p><div class="dialog-actions"><button type="button" class="button subtle" data-action="proposal-close-pending">关闭，稍后核对</button></div></div>`);
    let result;
    try{result=await api(`/api/projects/${pid}/ai`,{revision:state.project.revision,action:'plan',chapter_id:cid,instructions});}
    catch(error){if($('#proposal-pending')?.dataset.session===pendingId&&$('#dialog').open)$('#dialog').close();throw error;}
    if(state.project.id!==pid || current().id!==cid)throw new Error('当前章节已切换，原方案保持原样。');
    const visible=$('#proposal-pending')?.dataset.session===pendingId&&$('#dialog').open;
    await openProposal(result.proposal,visible);
    if(!visible)toast('候选场景方案已保留，点击“继续核对上次的场景方案”查看。');
  };

  window.previewChapterRewrite = async function(instructions='') {
    await saveCurrent();
    if (!state.settings.base_url || !state.settings.model) {
      state.view='settings';render();toast('先填写模型地址与名称，即可生成整章修订候选。');return;
    }
    const pid=state.project.id,cid=current().id,pendingId=String(++serial);
    if(!current().text.trim())throw new Error('请先写入正文，再按意见修订。');
    await window.captureRewriteNotes?.(instructions);
    showDialog(`<div id="proposal-pending" data-session="${pendingId}"><div class="eyebrow green">REWRITE PREVIEW</div><h2>正在生成整章修订候选…</h2><p class="help">原正文、摘要和状态候选完整保留。你可以先关闭，生成结束后再比较与采用。</p><div class="dialog-actions"><button type="button" class="button subtle" data-action="proposal-close-pending">关闭，稍后核对</button></div></div>`);
    let result;
    try{result=await api(`/api/projects/${pid}/ai`,{revision:state.project.revision,action:'rewrite',chapter_id:cid,instructions});}
    catch(error){if($('#proposal-pending')?.dataset.session===pendingId&&$('#dialog').open)$('#dialog').close();throw error;}
    const visible=state.project.id===pid && current().id===cid && $('#proposal-pending')?.dataset.session===pendingId && $('#dialog').open;
    await openProposal(result.proposal,visible,pid,instructions);
    if(!visible)toast('整章修订候选已保留，回到原章节可继续比较与采用。');
  };

  window.decorateProposalEntries = function() {
    const kind=state.view==='outline'?'outline':state.view==='write'?'plan':null;
    if(!kind)return;
    const pid=state.project.id,key=keyFor(kind,kind==='plan'?current().id:undefined);
    const button=$('#proposal-resume');
    if(button) {
      if(sessions.has(sessionKey(pid,key)))button.hidden=false;
      else if(window.workDrafts)window.workDrafts.read(key,pid).then(saved=>{if(saved&&state.project.id===pid)button.hidden=false;}).catch(error=>toast(error.message,true));
    }
    if(state.view==='write') {
      const cid=current().id,rewriteKey=keyFor('rewrite',cid);
      if($('#rewrite-instructions')&&!$('#proposal-rewrite-resume'))$('#rewrite-instructions').insertAdjacentHTML('afterend','<button type="button" id="proposal-rewrite-resume" class="text-button proposal-resume" data-action="proposal-rewrite-resume" hidden>继续核对上次的整章修订</button>');
      const resumeButton=$('#proposal-rewrite-resume');
      const reveal=()=>{if(resumeButton&&state.project.id===pid&&current().id===cid)resumeButton.hidden=false;};
      if(sessions.has(sessionKey(pid,rewriteKey)))reveal();
      else if(window.workDrafts)window.workDrafts.read(rewriteKey,pid).then(saved=>{if(saved)reveal();}).catch(error=>toast(error.message,true));
    }
  };

  function visibleSession() {
    const id=$('#proposal-form')?.dataset.session;
    return [...sessions.values()].find(session=>session.session===id);
  }

  function captureOnDismiss(event) {
    if(event.target.id!=='dialog' || (event.type==='close' && $('#dialog').open))return;
    const session=visibleSession();
    if(!session || session.noCloseSave)return;
    capture(session);
    persist(session).catch(error=>toast(`候选草稿尚未保留：${error.message}`,true));
  }
  // IME composition can finish without a final input event. Capture the DOM
  // value on Escape/native Back as well as on the explicit close action.
  document.addEventListener('cancel',captureOnDismiss,true);
  document.addEventListener('close',captureOnDismiss,true);

  for(const type of ['input','change'])document.addEventListener(type,event=>{
    if(!event.target.closest('#proposal-form'))return;
    const session=visibleSession();if(!session||session.noCloseSave)return;capture(session);
    if(type==='change'&&event.target.dataset?.proposalEntity!==undefined) {
      const item=session.candidate.changes[Number(event.target.dataset.proposalEntity)];
      const entity=(state.project.entities || []).find(e=>e.id===item.entity_id),fields=state.fields?.[entity?.kind] || {};
      if(!Object.hasOwn(fields,item.field))item.field=Object.keys(fields)[0] || '';
      show(session);
    }
    persist(session).catch(error=>toast(error.message,true));
  });
  document.addEventListener('click',event=>{
    const button=event.target.closest('[data-action]');
    if(!button||!button.dataset.action.startsWith('proposal-'))return;
    event.preventDefault();
    const action=button.dataset.action;
    if(action==='proposal-close-pending'){$('#dialog').close();return;}
    if(state.busy)return;
    if(action==='proposal-resume'){run(()=>resume(state.view==='outline'?'outline':'plan',current().id));return;}
    if(action==='proposal-rewrite-resume'){run(()=>resume('rewrite',current().id));return;}
    const session=visibleSession();if(!session)return;capture(session);
    if(action==='proposal-change-remove') {
      session.candidate.changes.splice(Number(button.dataset.index),1);show(session);
      persist(session).catch(error=>toast(error.message,true));return;
    }
    if(action==='proposal-close'){run(async()=>{await persist(session);$('#dialog').close();});}
    if(action==='proposal-discard'){run(async()=>{session.noCloseSave=true;$('#dialog').close();await window.workDrafts?.remove(session.key,session.projectId);sessions.delete(sessionKey(session.projectId,session.key));render();});}
  });
  document.addEventListener('submit',event=>{
    if(event.target.id!=='proposal-form')return;
    event.preventDefault();if(state.busy)return;
    const session=visibleSession();if(!session)return;capture(session);
    const sent=clone(session),p=sent.proposal;
    if(p.kind==='outline'&&!sent.selected.some(Boolean)){toast('请至少勾选一个候选节点。',true);return;}
    run(async()=>{
      await persist(session);
      if(state.project.id!==sent.projectId||state.dirty||state.project.revision!==p.source_revision)throw new Error('作品已更新，候选已过期。请保留候选并重新生成后再采用。');
      if(p.kind==='rewrite'&&(!sent.candidate.text.trim()||!sent.candidate.summary.trim()))throw new Error('请先补充候选正文和摘要。');
      const data=p.kind==='outline'?{source_revision:p.source_revision,source_hash:p.source_hash,mode:sent.mode,
        draft:{...sent.candidate,nodes:sent.candidate.nodes.filter((_,i)=>sent.selected[i])}}:
        p.kind==='rewrite'?{source_revision:p.source_revision,source_hash:p.source_hash,chapter_id:p.chapter_id,...sent.candidate}:
          {source_revision:p.source_revision,source_hash:p.source_hash,chapter_id:p.chapter_id,outline:sent.candidate};
      const result=await api(`/api/projects/${sent.projectId}/mutate`,{revision:state.project.revision,
        action:p.kind==='outline'?'apply_outline_proposal':p.kind==='rewrite'?'apply_rewrite_proposal':'apply_plan_proposal',data});
      capture(session);
      const changed=JSON.stringify([session.candidate,session.selected,session.mode])!==JSON.stringify([sent.candidate,sent.selected,sent.mode]);
      const visible=active(session)&&$('#dialog').open;
      accept(result);
      // A completed adoption must stay completed even when the separate draft
      // cleanup fails. Retained suggestions are then stale and safe to copy.
      let cleanupError;
      if(changed){
        try{await persist(session);}catch(error){cleanupError=error;}
        render();
        if(active(session)&&$('#dialog').open){
          // Keep the existing controls: rebuilding a form can discard a final
          // composition value typed while the auxiliary draft write awaited.
          const form=$('#proposal-form');
          form.querySelector('button[type="submit"]').disabled=true;
          form.insertAdjacentHTML('afterbegin','<div class="notice amber">作品已保存，这份候选已过期。继续修改的内容仍保留供复制参考。</div>');
        }
        toast(`已采用点击时的${p.kind==='rewrite'?'整章修订':'方案'}。等待期间继续修改的候选已保留，当前可复制参考。`);
      }else{
        session.noCloseSave=true;
        if(visible)$('#dialog').close();render();
        try{await window.workDrafts?.remove(session.key,session.projectId);sessions.delete(sessionKey(session.projectId,session.key));}
        catch(error){cleanupError=error;}
        toast(p.kind==='outline'?'选中的节点已保存到大纲草稿，请核对后确认生效。':p.kind==='rewrite'?'已采用整章修订，原稿保留在历史中。请核对摘要与状态后另行确认正文。':'已采用场景方案，原方案保留在章节历史中。');
      }
      if(cleanupError)toast(`作品已保存。候选草稿整理暂未完成：${cleanupError.message}。保留的候选仍可查看，不能重复采用。`,true);
    },'正在保存你选择的方案…');
  });
})();
