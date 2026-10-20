'use strict';

(() => {
  const hasText = chapter => typeof chapter.text === 'string' && chapter.text.trim().length > 0;
  const pendingChapters = () => state.project.chapters.filter(chapter=>chapter.status !== 'approved' && hasText(chapter));

  function nextReview() {
    const chapters = state.project.chapters;
    const chapter = chapters.find(item=>item.status !== 'approved');
    if (!chapter) return null;
    if (!hasText(chapter)) return {chapter,tab:'text',issue:'正文还为空。请先补写这一章，再按顺序确认。'};
    const nodes = state.project.book_outline?.active?.nodes;
    if (nodes) {
      const index = nodes.findIndex(node=>node.id === chapter.node_id);
      if (index < 0) return {chapter,tab:'outline',issue:'尚未绑定有效大纲阶段。请先在场景方案中选择节点。'};
      const previous = chapters.slice(0,chapters.indexOf(chapter));
      const done = new Set(previous.filter(item=>item.status === 'approved' && item.completes_node).map(item=>item.node_id));
      if (done.has(chapter.node_id)) return {chapter,tab:'outline',issue:'本章绑定的阶段已在前文完成。请核对节点绑定或前章的完成标记。'};
      const missing = nodes.slice(0,index).find(node=>!done.has(node.id));
      if (missing) return {chapter,tab:'outline',issue:`前置阶段「${missing.title}」尚未确认完成。请先核对前文的阶段完成标记。`};
    }
    return {chapter,tab:'summary',issue:''};
  }

  function chapterRow(chapter) {
    const chapters = state.project.chapters;
    const blocker = chapters.slice(0,chapters.indexOf(chapter)).find(item=>item.status !== 'approved');
    const status = {draft:'草稿',needs_review:'待复核',approved:'已确认'}[chapter.status] || '草稿';
    return `<li class="revisions-row"><div><strong>${esc(chapter.title)}</strong><span class="badge ${chapter.status === 'approved'?'approved':chapter.status === 'needs_review'?'needs_review':'draft'}">${status}</span><p class="help">${blocker?`前文《${esc(blocker.title)}》尚未确认；本章可先修稿，之后按顺序确认。`:chapter.status === 'approved'?'正文修改后，本章与后文需要重新复核。':'可按章节顺序核对摘要、状态变化和正文。'}</p></div><div class="revisions-row-actions"><button type="button" class="button outline small" data-action="revisions-chapter" data-id="${esc(chapter.id)}" data-tab="text">打开正文微调</button>${chapter.status !== 'approved'?`<button type="button" class="button subtle small" data-action="revisions-chapter" data-id="${esc(chapter.id)}" data-tab="summary">核对章节记忆</button>`:''}</div></li>`;
  }

  function showList() {
    const pending = pendingChapters(), next = nextReview();
    const approved = state.project.chapters.filter(chapter=>chapter.status === 'approved' && hasText(chapter));
    showDialog(`<section class="revisions-dialog"><div class="eyebrow green">REVISE AND REVIEW</div><h2>集中修稿与复核</h2><p class="help">可以先打开任意已有正文修改细节。摘要与状态变化仍按章节顺序逐章确认。</p>${next?`<div class="notice ${next.issue?'amber':''}"><strong>顺序复核从《${esc(next.chapter.title)}》开始</strong><p>${esc(next.issue || '先检查这一章的正文、章节记忆和状态变化，再确认入库。')}</p><button type="button" class="button primary small" data-action="revisions-next">${next.issue?'处理当前前置条件':'前往顺序复核'}</button></div>`:'<div class="notice">当前章节均已确认。仍可打开正文继续修改，改稿后将重新进入复核。</div>'}<h3>待复核与已有正文的草稿 · ${pending.length} 章</h3>${pending.length?`<ol class="revisions-list">${pending.map(chapterRow).join('')}</ol>`:'<p class="help">目前没有待处理的非空草稿。</p>'}${approved.length?`<details class="revisions-approved"><summary>已确认正文 · ${approved.length} 章</summary><ol class="revisions-list">${approved.map(chapterRow).join('')}</ol></details>`:''}<p class="help">修稿预览是临时建议；待确认的前章不进入正式记忆。这里不会自动确认或批量写入状态。</p><div class="dialog-actions"><button type="button" class="button subtle" data-action="close-dialog">关闭</button></div></section>`);
  }

  window.decorateRevisions = () => {
    if (!state.project || state.view !== 'write' || $('#revisions-entry')) return;
    const workspace = $('.workspace');
    if (!workspace) return;
    const pending = pendingChapters(), next = nextReview();
    workspace.insertAdjacentHTML('beforebegin',`<section id="revisions-entry" class="revisions-entry" aria-label="集中修稿与复核"><div><strong>集中修稿与复核</strong><p>${pending.length?`${pending.length} 章已有正文等待处理。`:'选一章修改细节，再逐章核对记忆。'}${next?` 顺序复核从《${esc(next.chapter.title)}》开始。`:''}</p></div><div class="button-row"><button type="button" class="button outline small" data-action="revisions-open">打开修稿清单</button>${next?`<button type="button" class="button subtle small" data-action="revisions-next">${current().id === next.chapter.id?'核对本章记忆':'返回顺序复核'}</button>`:''}</div></section>`);
  };

  document.addEventListener('click',event=>{
    const button = event.target.closest('[data-action]');
    if (!button || !button.dataset.action.startsWith('revisions-')) return;
    event.preventDefault();
    if (state.busy || !state.project) return;
    const {action,id,tab} = button.dataset, projectId = state.project.id;
    if (!['revisions-open','revisions-chapter','revisions-next'].includes(action)) return;
    run(async()=>{
      await saveCurrent();
      if (state.project.id !== projectId) throw new Error('当前作品已切换，请重新打开修稿清单。');
      if (action === 'revisions-open') { showList(); return; }
      const next = action === 'revisions-next'?nextReview():null;
      const chapter = next?.chapter || (action === 'revisions-chapter'?state.project.chapters.find(item=>item.id === id):null);
      if (!chapter) { toast('当前没有等待按顺序复核的章节。'); return; }
      const targetTab = next?.tab || (['text','summary'].includes(tab)?tab:'text');
      $('#dialog')?.close();
      state.chapterId = chapter.id;
      state.view = 'write';
      state.editorTab = targetTab;
      if (targetTab === 'summary') state.sideTab = 'changes';
      render();
      $(`#chapter-${targetTab === 'summary'?'summary':targetTab === 'outline'?'node-id':'text'}`)?.focus();
      $('.editor-card')?.scrollIntoView({block:'start',behavior:'smooth'});
      if (next?.issue) toast(next.issue);
    },'正在保存并打开修稿位置…');
  });
})();
