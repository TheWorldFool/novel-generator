'use strict';

const outlineNodeLabels={title:'阶段名称',goal:'阶段目标 · 结束时应达到的状态',must:'必须发生的事件',avoid:'本阶段不能发生或提前揭示的内容',source_quote:'大纲原文依据（可选，填写时须逐字一致）'};

function currentBookOutline(){return state.project.book_outline;}
function collectBookOutline(){
  const book=currentBookOutline();
  if(state.view==='outline'&&$('#book-outline-text')){
    for(const key of ['text','ending','guardrails'])book.draft[key]=$(`#book-outline-${key}`).value;
  }
  return book.draft;
}

function renderBookOutline(){
  const book=currentBookOutline(),d=book.draft;
  const pending=JSON.stringify(d)!==JSON.stringify(book.active);
  const nodes=book.active?.nodes||[];
  const done=nodes.filter(n=>state.project.chapters.some(c=>c.status==='approved'&&c.node_id===n.id&&c.completes_node));
  return pageHeading('THE WHOLE STORY','先定走向，再写每一章。','你的大纲决定主线、转折和结局。模型负责在这条路上把故事写好。',`<div class="button-row"><button class="button subtle" data-action="save">保存大纲草稿</button><button class="button primary" data-action="out-publish">${icon('check')}确认大纲生效</button></div>`)+`
    <div class="outline-status"><div><span class="badge ${book.active?'approved':'needs_review'}">${book.active?'生效版本 v'+book.version:'尚未确认全书走向'}</span><strong>${book.active?`${done.length} / ${nodes.length} 个阶段已完成`:'先给故事一条明确的主线'}</strong></div><p>${book.active?(pending?'当前有待确认的大纲草稿；写作仍以生效版本为准。':'当前草稿与生效大纲一致。'):'章节 AI 规划、起草和修订将在大纲生效、章节绑定节点后开放。手动写作仍可使用。'}</p></div>
    <div class="outline-layout"><section class="form-card"><div class="form-heading"><span class="entity-symbol">${icon('book')}</span><div><h2>用户给出的全书大纲</h2><p>写清开端、主要转折、高潮和结局，可以直接粘贴已有大纲。</p></div></div><label class="field">全书大纲原文<textarea id="book-outline-text" rows="15" maxlength="30000" placeholder="开端：主角处于怎样的困境？\n发展：必须经历哪些事件与选择？\n转折：什么真相或代价改变局面？\n高潮：主角必须作出什么决定？\n结局：最终谁发生了什么变化？">${esc(d.text)}</textarea></label><label class="field">确定的结局<textarea id="book-outline-ending" rows="3" maxlength="5000" placeholder="明确写出最终结果，模型不能擅自改成其他结局。">${esc(d.ending)}</textarea></label><label class="field">不可改动的约束<textarea id="book-outline-guardrails" rows="4" maxlength="5000" placeholder="例如：主角不黑化；父亲在中段才出现；最终用证据揭开旧案，不能靠新能力解决。">${esc(d.guardrails)}</textarea></label><div class="button-row"><button class="button outline" data-action="out-split">${icon('spark')}按我的大纲拆解节点</button><button class="button subtle" data-action="out-add-node">${icon('plus')}手动添加节点</button></div><p class="help">AI 拆解只提出候选节点，不自动生效、不重写你的原文；没有明确结局时会留给你补充。无需模型也可以手动建立节点。</p></section>
    <section class="outline-nodes"><div class="section-header"><h2>阶段节点 · 大纲草稿</h2><span class="tiny muted">${d.nodes.length} 个节点 · 按故事顺序</span></div>${d.nodes.map((n,i)=>`<article class="outline-node"><div class="outline-node-heading"><span>${String(i+1).padStart(2,'0')}</span><h3>${esc(n.title||'未命名阶段')}</h3><button class="text-button" data-action="out-edit-node" data-id="${esc(n.id)}">编辑</button></div><dl>${[['goal','目标'],['must','必经事件'],['avoid','禁止提前']].map(([key,label])=>`<div><dt>${label}</dt><dd>${esc(n[key]||'尚未填写')}</dd></div>`).join('')}</dl>${n.source_quote?`<details class="analysis-evidence"><summary>查看大纲依据</summary><blockquote>${esc(n.source_quote)}</blockquote>${!d.text.includes(n.source_quote)?'<small class="warning-text">此引用不在当前大纲中，请编辑后再确认生效。</small>':''}</details>`:''}<div class="outline-node-actions"><button class="text-button" data-action="out-move-node" data-id="${esc(n.id)}" data-direction="-1" ${i===0?'disabled':''}>↑ 上移</button><button class="text-button" data-action="out-move-node" data-id="${esc(n.id)}" data-direction="1" ${i===d.nodes.length-1?'disabled':''}>↓ 下移</button><button class="text-button muted" data-action="out-remove-node" data-id="${esc(n.id)}">从草稿移除</button></div></article>`).join('')||'<div class="empty wide">'+icon('layers')+'<h3>把主线拆成可推进的阶段</h3><p>一个阶段可以写一章，也可以分成多章。<br>完成当前阶段后，才能开始下一个。</p></div>'}</section></div>
    ${book.active?`<section class="form-card outline-active"><div class="section-header"><h2>当前生效大纲与章节承接</h2><span class="badge approved">v${book.version}</span></div><p class="help">只有已确认正文中带有完成依据的阶段，才会显示为已完成。</p>${nodes.map((n,i)=>{const chapters=state.project.chapters.filter(c=>c.node_id===n.id);return `<div class="active-node-row"><span class="badge ${done.includes(n)?'approved':'draft'}">${done.includes(n)?'已完成':'待推进'}</span><div><strong>${i+1}. ${esc(n.title)}</strong><p>${esc(n.goal)}</p><small>${chapters.length?chapters.map(c=>`${esc(c.title)}（${statusName[c.status]}${c.completes_node?' · 拟完成节点':''}）`).join('、'):'尚未绑定章节'}</small></div></div>`;}).join('')}<details class="analysis-evidence"><summary>查看生效的大纲原文、结局与约束</summary><pre class="outline-source">${esc(book.active.text)}</pre><p><strong>结局：</strong>${esc(book.active.ending)}</p><p><strong>不可改动：</strong>${esc(book.active.guardrails||'未另行填写')}</p></details></section>`:''}
    ${book.history.length?`<section class="form-card outline-history"><h2>大纲历史版本</h2><p class="help">保留最近20个生效旧版本。恢复只替换草稿，需要再次确认才会生效。</p>${[...book.history].reverse().map(h=>`<div class="outline-history-row"><span>v${h.version} · ${date(h.at)} · ${h.outline.nodes.length} 个阶段</span><button class="text-button" data-action="out-restore" data-version="${h.version}">恢复为草稿</button></div>`).join('')}</section>`:''}`;
}

function nodeDetailMarkup(){
  const c=current(),book=currentBookOutline(),node=book.active?.nodes.find(n=>n.id===c.node_id);
  if(!node)return '<p class="help">选择一个当前生效的阶段节点，模型才能确定本章的推进范围。</p>';
  return `<div class="chapter-node-detail"><strong>${esc(node.title)}</strong><p><b>目标：</b>${esc(node.goal)}</p>${node.must?`<p><b>必经事件：</b>${esc(node.must)}</p>`:''}${node.avoid?`<p><b>禁止提前：</b>${esc(node.avoid)}</p>`:''}<small>节点计划不是已发生事实。本章${c.completes_node?'将完成':'只推进'}这个节点，不进入下一阶段。</small></div>`;
}

function decorateOutlineEntries(){
  const book=currentBookOutline();
  if(state.view==='story'){
    $('.page-heading').insertAdjacentHTML('afterend',`<div class="outline-entry"><div><strong>整体走向在「全书大纲」确定</strong><p>${book.active?`当前以大纲 v${book.version} 的结局为准，下面的故事设想不会覆盖生效大纲。`:'这里记录故事定位和文风。请先确认全书大纲，再让模型逐章推进。'}</p></div><button class="button primary" data-action="view" data-view="outline">打开全书大纲 ${icon('arrow')}</button></div>`);
  }
  if(state.view!=='write')return;
  const c=current(),nodes=book.active?.nodes||[],node=nodes.find(n=>n.id===c.node_id);
  $('.welcome').insertAdjacentHTML('afterend',`<div class="outline-entry ${!book.active||!node?'outline-warning':''}"><div><strong>${book.active?(node?`本章承接：${esc(node.title)}`:'本章尚未绑定大纲节点'):'先定全书大纲，再开始 AI 写作'}</strong><p>${book.active?(node?'遵守本阶段目标与禁区，后续节点不能提前兑现。':'在「场景方案」中选择阶段节点，确定本章要沿哪条主线推进。'):'粘贴你的大纲，确认阶段、必经事件和结局。模型会据此规划和写作。'}</p></div><button class="button outline small" data-action="view" data-view="outline">${book.active?'查看全书走向':'设置全书大纲'} ${icon('arrow')}</button></div>`);
  const pane=$('[data-pane="outline"]');
  pane.insertAdjacentHTML('afterbegin',`<section class="chapter-outline-binding"><label class="field">本章承接的大纲节点<select id="chapter-node-id" ${!nodes.length?'disabled':''}><option value="">${nodes.length?'请选择本章阶段':'请先确认全书大纲'}</option>${c.node_id&&!node?`<option value="${esc(c.node_id)}" selected>原节点已变更，请重新选择</option>`:''}${nodes.map((n,i)=>`<option value="${esc(n.id)}" ${c.node_id===n.id?'selected':''}>${i+1}. ${esc(n.title)}</option>`).join('')}</select></label><div id="chapter-node-detail">${nodeDetailMarkup()}</div><label class="check-line"><input type="checkbox" id="chapter-completes-node" ${c.completes_node?'checked':''}>本章结束时完成这个阶段节点</label><label class="field">阶段完成依据（完成节点时必填）<textarea id="chapter-node-evidence" rows="2" maxlength="5000" placeholder="写完正文后，复制能够说明阶段目标已达成的原句。">${esc(c.node_evidence)}</textarea><small>不勾选完成，可以用多章推进同一阶段。确认完成后，下一章才能进入后续阶段。</small></label></section>`);
  if(state.sideTab==='memory'&&node)$('.context-body').insertAdjacentHTML('afterbegin',`<div class="section-label">全书大纲 v${book.version} · 当前节点</div>${nodeDetailMarkup()}`);
}

function captureChapterOutline(){
  if(!$('#chapter-node-id'))return;
  const c=current();c.node_id=$('#chapter-node-id').value;c.completes_node=$('#chapter-completes-node').checked;c.node_evidence=$('#chapter-node-evidence').value;
}

function decorateOutlineApproval(){
  const book=currentBookOutline();
  if(!book.active)return;
  const node=book.active.nodes.find(n=>n.id===current().node_id);
  $('#dialog .dialog-actions').insertAdjacentHTML('beforebegin',`<div class="notice">全书大纲 v${book.version} · ${esc(node?.title||'本章尚未绑定节点')}<br>${current().completes_node?'本章拟完成当前阶段，必须提供正文依据。':'本章仅推进当前阶段，不标记阶段完成。'}</div><label class="check-line"><input id="approve-outline-checked" type="checkbox">我已核对本章符合当前大纲，没有改变走向或提前兑现后续剧情</label>`);
}

function outlineNodeDialog(id){
  const node=currentBookOutline().draft.nodes.find(n=>n.id===id)||{title:'',goal:'',must:'',avoid:'',source_quote:''};
  showDialog(`<form id="outline-node-form" data-id="${esc(id||'')}"><div class="eyebrow green">ONE STEP OF THE STORY</div><h2>${id?'编辑':'添加'}阶段节点</h2>${Object.entries(outlineNodeLabels).map(([key,label])=>`<label class="field">${label}${key==='title'?`<input name="${key}" required maxlength="200" value="${esc(node[key])}">`:`<textarea name="${key}" rows="3" maxlength="3000" ${key==='goal'?'required':''}>${esc(node[key])}</textarea>`}</label>`).join('')}<p class="help">修改只进入大纲草稿，点击「确认大纲生效」后才约束章节。</p><div class="dialog-actions"><button class="button subtle" type="button" data-action="close-dialog">取消</button><button class="button primary" type="submit">保存节点到草稿</button></div></form>`);
}

document.addEventListener('click',event=>{
  const button=event.target.closest('[data-action]');if(!button||state.busy||!button.dataset.action.startsWith('out-'))return;
  const {action,id,direction,version}=button.dataset;
  const draft=collectBookOutline();
  if(action==='out-add-node'||action==='out-edit-node'){outlineNodeDialog(id);return;}
  if(action==='out-remove-node'){draft.nodes=draft.nodes.filter(n=>n.id!==id);markDirty();render();return;}
  if(action==='out-move-node'){const i=draft.nodes.findIndex(n=>n.id===id),j=i+Number(direction);if(i>=0&&j>=0&&j<draft.nodes.length){[draft.nodes[i],draft.nodes[j]]=[draft.nodes[j],draft.nodes[i]];markDirty();render();}return;}
  if(action==='out-publish'){
    const book=currentBookOutline(),approved=state.project.chapters.filter(c=>c.status==='approved').length;
    if(JSON.stringify(draft)===JSON.stringify(book.active)){toast('当前大纲与生效版本一致，无需再次确认。');return;}
    showDialog(`<div class="eyebrow green">AUTHOR-OWNED DIRECTION</div><h2>以这份大纲约束全书。</h2><p>${draft.nodes.length} 个阶段节点，按此顺序推进。模型可以丰富场景，不能擅改主线与结局。</p><div class="note-card"><strong>确定的结局</strong><p>${esc(draft.ending||'尚未填写，请先确定结局。')}</p></div><ol>${draft.nodes.map(n=>`<li>${esc(n.title)}</li>`).join('')}</ol><p class="help">生效后，已有的 ${approved} 个已确认章节将需要按新大纲复核。${book.active?'旧生效大纲会保留在历史版本中。':'每章需要绑定一个阶段节点。'}</p><div class="dialog-actions"><button class="button subtle" data-action="close-dialog">继续修改</button><button class="button primary" data-action="out-confirm-publish">确认生效</button></div>`);return;
  }
  run(async()=>{
    await saveCurrent();
    if(action==='out-confirm-publish'){
      await mutate('publish_book_outline',{});$('#dialog').close();render();toast('全书大纲已生效。请按顺序绑定并复核章节。');
    }else if(action==='out-split'){
      if(!state.settings.base_url||!state.settings.model)throw new Error('大纲草稿已保存。请先配置模型，也可以手动添加阶段节点。');
      accept(await api(`/api/projects/${state.project.id}/outline-ai`,{revision:state.project.revision}));render();toast('已生成候选节点。请检查、修改后确认生效。');
    }else if(action==='out-restore'){
      await mutate('restore_book_outline',{version:Number(version)});render();toast('旧版大纲已恢复为草稿，尚未替换当前生效版本。');
    }
  },action==='out-split'?'正在按你的大纲拆解阶段节点…':'正在保存大纲…');
});

document.addEventListener('input',event=>{if(state.view==='outline'&&event.target.id.startsWith('book-outline-'))markDirty();});
document.addEventListener('change',event=>{
  if(['chapter-node-id','chapter-completes-node'].includes(event.target.id)){
    captureEditor();markDirty();$('#chapter-node-detail').innerHTML=nodeDetailMarkup();
  }
});
document.addEventListener('submit',event=>{
  if(event.target.id!=='outline-node-form')return;event.preventDefault();if(state.busy)return;
  const form=event.target,data=Object.fromEntries(new FormData(form)),draft=currentBookOutline().draft;
  if(!form.dataset.id&&draft.nodes.length>=30){toast('最多支持30个阶段节点。',true);return;}
  const node={...data,id:form.dataset.id||crypto.randomUUID()};
  const index=draft.nodes.findIndex(n=>n.id===node.id);if(index<0)draft.nodes.push(node);else draft.nodes[index]=node;
  markDirty();$('#dialog').close();render();
});
