'use strict';

// Selection offsets stay in the browser's UTF-16 units, including emoji.
// The server validates the complete source before it applies a replacement.
(() => {
  const drafts = new Map();
  let remembered = null;
  let sequence = 0;
  const keyFor = () => state.project ? `${state.project.id}:${current().id}` : '';
  const editor = () => $('#chapter-text');

  function rememberSelection(clearCollapsed = false) {
    const input = editor();
    if (!input || !state.project || state.view !== 'write') return;
    const start = input.selectionStart, end = input.selectionEnd;
    if (end > start) remembered = {key:keyFor(), start, end, original:input.value.slice(start,end), sourceText:input.value};
    else if (clearCollapsed) remembered = null;
    const label = $('#local-edit-selection');
    if (label) label.textContent = end > start ? `已选 ${[...input.value.slice(start,end)].length} 字符` : '选中文字，或把光标放在要修改的段落';
  }

  function activeForm(draft) {
    const form = $('#local-edit-form');
    return form?.dataset.session === draft.session ? form : null;
  }

  function captureDraft(draft) {
    const form = activeForm(draft);
    if (!form) return;
    const instructions = $('#local-edit-instructions',form);
    const replacement = $('#local-edit-replacement',form);
    if (instructions) draft.instructions = instructions.value;
    if (replacement) draft.replacement = replacement.value;
  }

  function showDraft(draft) {
    const generated = draft.edit !== null;
    const stale = !draft.applied && (state.project.id !== draft.projectId || current().id !== draft.chapterId ||
      (editor()?.value ?? current().text) !== draft.sourceText);
    showDialog(`<form id="local-edit-form" data-session="${draft.session}" class="local-edit-form">
      <div class="eyebrow green">REFINE A PASSAGE</div><h2>只微调这一段文字</h2>
      <p class="help">先预览，再采用。选区之外的正文会保持原样；可以直接修改建议，也可以继续指出细节。</p>
      ${draft.notice?`<div class="notice local-edit-notice" role="status">${esc(draft.notice)}</div>`:''}
      ${stale?'<div class="notice amber">正文已变化，请关闭后重新选择要微调的文字。这里的意见和建议仍保留，尚未替换正文。</div>':''}
      <details class="local-edit-original" open><summary>选中的原文 · ${[...draft.original].length} 字符</summary><pre>${esc(draft.original)}</pre></details>
      ${generated || draft.replacement !== undefined?`<label class="field">修改建议 · 可直接编辑<textarea id="local-edit-replacement" rows="7" maxlength="30000" aria-label="修改建议">${esc(draft.replacement ?? '')}</textarea><small>采用时只替换上面的原文。清空建议会删除这段选区。</small></label>`:''}
      ${draft.alternative!==undefined?`<section class="local-edit-alternative"><h3>等待期间新生成的一版</h3><p class="help">你继续编辑的建议已保留在上方。可先比较，再选择使用这一版。</p><pre>${esc(draft.alternative)}</pre><button type="button" class="button outline small" data-action="local-edit-use-alternative">将这一版放入修改建议</button></section>`:''}
      <label class="field">${generated?'继续微调什么？':'需要修改哪些细节？'}<textarea id="local-edit-instructions" rows="3" maxlength="5000" placeholder="例如：把她的语气改得克制一些，保留动作、情节和其他对白。">${esc(draft.instructions)}</textarea></label>
      <div class="local-edit-chips" aria-label="常用微调要求">${['表达更自然，保留原意','减少解释，用动作表现','对白更符合人物性格','精简重复描写'].map(text=>`<button type="button" class="check-chip" data-action="local-edit-chip" data-value="${esc(text)}">${esc(text)}</button>`).join('')}</div>
      <p class="help">模型会参考当前人物、文风和全书大纲。采用后请核对章节记忆与状态变化。</p>
      <div class="dialog-actions local-edit-actions"><button type="button" class="button subtle" data-action="local-edit-cancel">${draft.applied?'关闭':generated?'保留原文并关闭':'取消'}</button><button type="submit" class="button ${generated?'outline':'primary'}" ${stale || draft.applied?'disabled':''}>${generated?'按意见再生成一版':'生成微调预览'}</button>${generated?`<button type="button" class="button primary" data-action="local-edit-apply" ${stale || draft.applied?'disabled':''}>采用建议，仅替换选区</button>`:''}</div>
    </form>`);
  }

  function openSelection(paragraph = false) {
    const input = editor();
    if (!input) return;
    rememberSelection();
    let selected = remembered;
    if (paragraph) {
      const caret = input.selectionStart ?? 0;
      // A blank line, including whitespace-only lines, separates paragraphs.
      const gaps = [...input.value.matchAll(/\r?\n[\t ]*\r?\n/g)];
      let start = 0, end = input.value.length;
      for (const gap of gaps) {
        if (gap.index + gap[0].length <= caret) start = gap.index + gap[0].length;
        else if (gap.index >= caret) { end = gap.index; break; }
        else { toast('光标在段落之间，请先点一下需要修改的段落。',true); return; }
      }
      selected = {key:keyFor(),start,end,original:input.value.slice(start,end),sourceText:input.value};
    }
    if (!selected || selected.key !== keyFor() || selected.sourceText !== input.value || !selected.original.trim()) {
      toast('请先在正文中选中文字；手机上可长按并拖动选区，或点一下段落后选择“微调当前段落”。',true);
      return;
    }
    if (selected.original.length > 20000) { toast('一次最多微调20000字符，请缩小选区。',true); return; }
    const key = keyFor();
    let draft = drafts.get(key);
    if (!draft || draft.start !== selected.start || draft.end !== selected.end || draft.sourceText !== selected.sourceText || draft.applied) {
      draft = {...selected,projectId:state.project.id,chapterId:current().id,session:String(++sequence),instructions:'',edit:null};
      drafts.set(key,draft);
    }
    showDraft(draft);
    $('#local-edit-instructions')?.focus();
  }

  function getDraft() {
    const draft = drafts.get(keyFor());
    return draft && activeForm(draft) ? draft : null;
  }

  async function preview(draft, submittedInstructions, submittedReplacement) {
    // Freeze the request at click time; typing in the dialog belongs to the next
    // round, even while an earlier draft save or the model request is pending.
    const rawInstructions = submittedInstructions;
    const instructions = rawInstructions.trim();
    // Browsers normalize CRLF in textarea values. Persist that displayed source
    // first so selection offsets also match imported or model-written text.
    if (editor() && editor().value !== current().text) { captureEditor(); markDirty(); }
    await saveCurrent();
    if (state.project.id !== draft.projectId || current().id !== draft.chapterId ||
        current().text !== draft.sourceText || editor()?.value !== draft.sourceText) {
      if (editor() && editor().value !== current().text) { captureEditor(); markDirty(); }
      throw new Error('正文已变化，请保留这里的意见，关闭后重新选择文字再生成。');
    }
    const payload = {revision:state.project.revision,chapter_id:draft.chapterId,start:draft.start,end:draft.end,
      selected_text:draft.original,instructions};
    if (submittedReplacement !== undefined) payload.previous_replacement = submittedReplacement;
    const result = await api(`/api/projects/${draft.projectId}/edit-preview`,payload);
    captureDraft(draft);
    const changedReplacement = draft.replacement !== submittedReplacement;
    draft.edit = result.edit;
    if (changedReplacement) {
      draft.alternative = result.edit.replacement;
      draft.notice = '你在等待期间编辑的建议已保留，新生成的一版放在下方供比较。';
    } else {
      draft.replacement = result.edit.replacement;
      delete draft.alternative;
      draft.notice = '';
    }
    if (draft.instructions === rawInstructions) draft.instructions = '';
    const visible = activeForm(draft) && $('#dialog')?.open;
    if (visible) showDraft(draft);
    else toast('微调预览已准备好，点击“继续上次微调”查看。');
    updateResume();
  }

  function updateResume() {
    const button = $('#local-edit-resume');
    if (button) button.hidden = !drafts.has(keyFor());
  }

  async function apply(draft, replacement) {
    if (!draft.edit) throw new Error('请先生成微调预览。');
    if (replacement.length > 30000) throw new Error('修改建议最多30000字符，请精简后采用。');
    if (state.project.id !== draft.projectId || current().id !== draft.chapterId || state.dirty ||
        state.project.revision !== draft.edit.source_revision || current().text !== draft.sourceText || editor()?.value !== draft.sourceText) {
      throw new Error('正文或作品已经更新，本轮预览已过期。请重新生成预览后再采用，你的意见和建议会保留。');
    }
    const sentInstructions = draft.instructions;
    const result = await api(`/api/projects/${draft.projectId}/mutate`,{revision:state.project.revision,action:'apply_local_edit',
      data:{...draft.edit,replacement}});
    captureDraft(draft);
    const hasNewInput = draft.instructions !== sentInstructions || draft.replacement !== replacement;
    const wasVisible = activeForm(draft) && $('#dialog')?.open;
    accept(result);
    remembered = null;
    if (hasNewInput) {
      draft.applied = true;
      draft.notice = '已采用点击时的建议。等待期间继续输入的意见和文字保留在这里，可以复制；再次修改请关闭后重新选择正文。';
      render();
      if (wasVisible) showDraft(draft);
    } else {
      drafts.delete(`${draft.projectId}:${draft.chapterId}`);
      $('#dialog').close();
      render();
    }
    toast(replacement === draft.original?'建议与原文相同，正文没有改动。':'已只替换选区并保存原稿版本。请核对章节记忆与状态变化后重新确认正文。');
  }

  window.decorateLocalEdit = function () {
    const input = editor();
    if (!input || $('#local-edit-toolbar')) return;
    const bar = document.createElement('div');
    bar.id = 'local-edit-toolbar';
    bar.className = 'local-edit-toolbar';
    bar.innerHTML = '<div class="local-edit-buttons"><button type="button" class="button outline small" data-action="local-edit-selection">微调选中文字</button><button type="button" class="button subtle small" data-action="local-edit-paragraph">微调当前段落</button><button type="button" class="text-button" id="local-edit-resume" data-action="local-edit-resume" hidden>继续上次微调</button></div><small id="local-edit-selection">选中文字，或把光标放在要修改的段落</small>' +
      (current().local_edit_review_required?'<div class="local-edit-pending">正文已修改，请复核摘要并重新勾选有效状态变化。<button type="button" class="text-button" data-action="editor-tab" data-tab="summary">核对章节记忆 →</button></div>':'');
    input.before(bar);
    updateResume();
  };

  for (const type of ['select','keyup','pointerup','focusout']) document.addEventListener(type,event=>{
    if (event.target.id === 'chapter-text') rememberSelection(type !== 'focusout');
  });
  document.addEventListener('selectionchange',()=>{ if (document.activeElement === editor()) rememberSelection(true); });
  document.addEventListener('pointerdown',event=>{
    if (event.target.closest('[data-action^="local-edit-"]')) rememberSelection();
  },true);
  document.addEventListener('input',event=>{
    if (event.target.id === 'chapter-text') remembered = null;
    if (event.target.closest('#local-edit-form')) {
      const draft = getDraft();
      if (draft) captureDraft(draft);
    }
  });
  document.addEventListener('click',event=>{
    const button = event.target.closest('[data-action]');
    if (!button || !button.dataset.action.startsWith('local-edit-')) return;
    event.preventDefault();
    const action = button.dataset.action;
    if (state.busy) return;
    if (action === 'local-edit-selection' || action === 'local-edit-paragraph') { openSelection(action === 'local-edit-paragraph'); return; }
    const draft = drafts.get(keyFor());
    if (!draft) return;
    captureDraft(draft);
    if (action === 'local-edit-resume') { showDraft(draft); return; }
    if (action === 'local-edit-cancel') { $('#dialog').close(); return; }
    if (action === 'local-edit-chip') {
      draft.instructions = draft.instructions.trim() ? `${draft.instructions.trim()}；${button.dataset.value}` : button.dataset.value;
      $('#local-edit-instructions').value = draft.instructions;
      $('#local-edit-instructions').focus();
    } else if (action === 'local-edit-use-alternative') {
      draft.replacement = draft.alternative;
      delete draft.alternative;
      draft.notice = '';
      showDraft(draft);
    } else if (action === 'local-edit-apply') {
      const replacement = draft.replacement ?? '';
      run(()=>apply(draft,replacement),'正在替换选区并保存原稿版本…');
    }
  });
  document.addEventListener('submit',event=>{
    if (event.target.id !== 'local-edit-form') return;
    event.preventDefault();
    if (state.busy) return;
    const draft = getDraft();
    if (!draft || draft.applied) return;
    captureDraft(draft);
    if (!draft.instructions.trim() || draft.instructions.length > 5000) {
      toast('请写下具体需要调整的细节，最多5000字符。',true);
      $('#local-edit-instructions')?.focus();
      return;
    }
    const instructions = draft.instructions, replacement = draft.replacement;
    run(()=>preview(draft,instructions,replacement),'正在微调选中的文字…');
  });
})();
