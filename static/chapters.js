'use strict';

(() => {
  let dialogContext = null;
  const statusLabel = c => ({approved:'已确认',needs_review:'待复核',draft:'草稿'}[c.status] || '草稿');
  const chapterById = id => state.project.chapters.find(c=>c.id === id);
  const words = text => [...String(text || '').replace(/\s/g,'')].length;
  const orderNotice = '插入、移动或移走前文章节后，受影响的后文需按新顺序核对摘要、状态变化和大纲阶段，再逐章确认。标题和正文不会自动重写。';

  function showList() {
    dialogContext = {projectId:state.project.id,kind:'list'};
    const chapters = state.project.chapters, trash = state.project.chapter_trash || [];
    showDialog(`<section class="chapter-manager"><div class="eyebrow green">CHAPTERS</div><h2>管理章节</h2><p class="help">${orderNotice}</p><ol class="chapter-management-list">${chapters.map((c,index)=>`<li class="chapter-management-row"><div><strong>${index + 1}. ${esc(c.title)}</strong><span class="badge ${c.status === 'approved'?'approved':c.status === 'needs_review'?'needs_review':'draft'}">${statusLabel(c)}</span><p class="help">${words(c.text).toLocaleString()} 字 · ${c.versions?.length || 0} 份历史版本${c.id === state.chapterId?' · 当前章节':''}</p></div><div class="chapter-management-actions"><button class="button subtle small" type="button" data-action="chapter-open" data-id="${esc(c.id)}">打开</button><button class="button outline small" type="button" data-action="chapter-insert" data-id="${esc(c.id)}" data-position="before">之前插入</button><button class="button outline small" type="button" data-action="chapter-insert" data-id="${esc(c.id)}" data-position="after">之后插入</button><button class="button subtle small" type="button" data-action="chapter-move" data-id="${esc(c.id)}" data-direction="up" ${index === 0?'disabled':''} aria-label="上移《${esc(c.title)}》">上移</button><button class="button subtle small" type="button" data-action="chapter-move" data-id="${esc(c.id)}" data-direction="down" ${index === chapters.length - 1?'disabled':''} aria-label="下移《${esc(c.title)}》">下移</button><button class="button subtle small chapter-trash-button" type="button" data-action="chapter-delete" data-id="${esc(c.id)}" ${chapters.length === 1?'disabled':''}>移入回收站</button></div></li>`).join('')}</ol><details class="chapter-trash" ${trash.length?'open':''}><summary>章节回收站 · ${trash.length} / 30</summary><p class="help">正文、摘要、状态候选和历史版本会一起保留，也随 JSON 备份导出。恢复后仍需重新确认。</p>${trash.length?`<ul class="chapter-management-list">${trash.map(entry=>`<li class="chapter-management-row"><strong>${esc(entry.chapter.title)}</strong><p class="help">${words(entry.chapter.text).toLocaleString()} 字 · 原第 ${entry.index + 1} 章 · ${esc(date(entry.deleted_at))}</p><button class="button outline small" type="button" data-action="chapter-restore" data-id="${esc(entry.id)}">恢复为待确认章节</button></li>`).join('')}</ul>`:'<p class="help">回收站为空。</p>'}</details><div class="dialog-actions"><button type="button" class="button subtle" data-action="close-dialog">关闭</button></div></section>`);
  }

  function showInsert(c, position) {
    dialogContext = {projectId:state.project.id,kind:'insert',id:c.id,position};
    showDialog(`<section class="chapter-manager"><h2>在《${esc(c.title)}》${position === 'before'?'之前':'之后'}插入</h2><p class="help">${orderNotice}</p><label class="field" for="chapter-insert-title">新章节标题<input id="chapter-insert-title" maxlength="200" value="新的章节" autocomplete="off"></label><div class="dialog-actions"><button class="button subtle" type="button" data-action="chapter-manage">返回目录</button><button class="button primary" type="button" data-action="chapter-confirm-insert">插入空白章节</button></div></section>`);
    $('#chapter-insert-title')?.select();
  }

  function showDelete(c) {
    dialogContext = {projectId:state.project.id,kind:'delete',id:c.id,title:c.title};
    showDialog(`<section class="chapter-manager"><h2>将《${esc(c.title)}》移入回收站？</h2><p>这章有 <strong>${words(c.text).toLocaleString()} 字正文</strong>、${c.changes?.length || 0} 项状态候选和 ${c.versions?.length || 0} 份历史版本，将一起保留到回收站。</p>${c.text?.trim()?`<blockquote class="chapter-delete-preview">${esc(c.text.slice(0,180))}${c.text.length > 180?'…':''}</blockquote>`:'<p class="help">当前正文为空。</p>'}<div class="notice amber">移走后，这章的已确认状态不再进入正式记忆；后续章节需要重新复核。你可以从回收站恢复原章。</div><label class="check-line"><input type="checkbox" id="chapter-delete-checked">我已核对章节，并确认将《${esc(c.title)}》移入回收站。</label><div class="dialog-actions"><button type="button" class="button subtle" data-action="chapter-manage">返回目录</button><button type="button" class="button primary" data-action="chapter-confirm-delete">确认移入回收站</button></div></section>`);
  }

  function ensureProject(projectId) {
    if (!state.project || state.project.id !== projectId) throw new Error('作品已切换，请重新打开章节管理。');
  }

  window.decorateChapters = () => {
    if (!state.project || $('#chapter-manager-entry')) return;
    const heading = $('.chapter-heading');
    if (!heading) return;
    heading.insertAdjacentHTML('beforeend','<button type="button" id="chapter-manager-entry" class="text-button chapter-manager-entry" data-action="chapter-manage" aria-label="管理章节顺序与回收站">管理</button>');
  };

  document.addEventListener('click',event=>{
    const button = event.target.closest('[data-action]');
    if (!button || !button.dataset.action.startsWith('chapter-')) return;
    const {action,id,position,direction} = button.dataset;
    if (!['chapter-manage','chapter-open','chapter-insert','chapter-confirm-insert','chapter-move','chapter-delete','chapter-confirm-delete','chapter-restore'].includes(action)) return;
    event.preventDefault();
    if (state.busy || !state.project || button.disabled) return;
    const projectId = state.project.id, context = dialogContext;
    const title = action === 'chapter-confirm-insert'?$('#chapter-insert-title')?.value.trim():null;
    const checked = action === 'chapter-confirm-delete'?$('#chapter-delete-checked')?.checked:false;
    run(async()=>{
      if (action !== 'chapter-manage' && context?.projectId !== projectId) throw new Error('章节管理已过期，请重新打开。');
      if (action === 'chapter-confirm-insert' && (!context || context.kind !== 'insert' || !title)) throw new Error('请填写新章节标题。');
      if (action === 'chapter-confirm-delete' && (!context || context.kind !== 'delete' || !checked)) throw new Error('请先勾选确认，再将指定章节移入回收站。');
      await saveCurrent();
      ensureProject(projectId);
      if (action === 'chapter-manage') {showList();return;}
      if (action === 'chapter-open') {
        if (!chapterById(id)) throw new Error('章节已改变，请重新打开目录。');
        $('#dialog')?.close();state.chapterId = id;state.view = 'write';state.editorTab = 'text';render();return;
      }
      if (action === 'chapter-insert' || action === 'chapter-delete') {
        const chapter = chapterById(id);
        if (!chapter) throw new Error('章节已改变，请重新打开目录。');
        if (action === 'chapter-insert') {
          if (!['before','after'].includes(position)) throw new Error('插入位置无效，请重新选择。');
          showInsert(chapter,position);
        } else showDelete(chapter);
        return;
      }
      if (action === 'chapter-confirm-insert') {
        const oldIds = new Set(state.project.chapters.map(c=>c.id));
        await mutate('insert_chapter',{id:context.id,position:context.position,title});
        state.chapterId = state.project.chapters.find(c=>!oldIds.has(c.id))?.id || current().id;
        state.view = 'write';state.editorTab = 'outline';$('#dialog')?.close();dialogContext = null;render();toast('已插入空白章节。请设置本章意图和大纲阶段。');return;
      }
      if (action === 'chapter-move') await mutate('move_chapter',{id,direction});
      if (action === 'chapter-confirm-delete') {
        const chapter = chapterById(context.id);
        if (!chapter || chapter.title !== context.title) throw new Error('章节标题已改变，请重新核对后操作。');
        const index = state.project.chapters.indexOf(chapter);
        await mutate('delete_chapter',{id:context.id,confirm_title:context.title});
        if (!chapterById(state.chapterId)) state.chapterId = state.project.chapters[Math.min(index,state.project.chapters.length - 1)].id;
      }
      if (action === 'chapter-restore') await mutate('restore_chapter',{trash_id:id});
      render();showList();toast(state.project.events?.[0]?.message || '章节目录已更新；请按顺序核对受影响章节。');
    },'正在保存并整理章节…');
  });
})();
