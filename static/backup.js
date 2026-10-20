'use strict';

// A backup is checked before a separate, explicit restore creates a new book.
// Each file read and preflight belongs to the dialog session that requested it.
(() => {
  const maxBytes = 80000000;
  let sequence = 0;
  let draft = null;

  function newImportKey() {
    const secure = window.crypto;
    if (typeof secure?.randomUUID === 'function') return secure.randomUUID();
    if (typeof secure?.getRandomValues !== 'function') throw new Error('Secure randomness is unavailable');
    const bytes = secure.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  }

  function visible(item) {
    return draft === item && $('#dialog')?.open &&
      $('#backup-import-panel')?.dataset.session === item.session;
  }

  function update(item) {
    if (!visible(item)) return;
    const candidate = item.candidate;
    const preview = candidate?.preview;
    const status = $('#backup-import-status');
    const total = value => esc(Number.isSafeInteger(value) && value >= 0 ? value : 0);
    status.innerHTML = `${candidate ? `<p class="help">已选择：${esc(candidate.filename)}</p>` : ''}
      ${item.loading ? '<p class="notice" role="status">正在读取并检查备份，请稍候…</p>' : ''}
      ${item.importing ? '<p class="notice" role="status">正在恢复为新作品，请稍候…</p>' : ''}
      ${item.error ? `<p class="notice amber" role="alert">${esc(item.error)}</p>` : ''}
      ${preview ? `<div class="note-card"><strong>${esc(preview.title)}</strong><p>${total(preview.chapter_count)} 章 · ${total(preview.approved_count)} 章已确认<br>${total(preview.entity_count)} 份档案 · ${total(preview.image_count)} 张参考图片 · ${total(preview.version_count)} 条历史版本</p></div><p class="help">恢复后会新增一部作品，保留当前作品。模型连接与密钥不会随备份导入。</p>` : ''}`;
    const file = $('#backup-import-file');
    if (file) file.disabled = item.importing;
    const confirm = $('#backup-import-confirm');
    if (confirm) confirm.disabled = !preview || item.loading || item.importing;
    const retry = $('#backup-import-retry');
    if (retry) {
      retry.hidden = !candidate?.backup || !!preview || item.loading || item.importing;
      retry.disabled = item.loading || item.importing;
    }
    const cancel = $('#backup-import-cancel');
    if (cancel) cancel.disabled = item.importing;
  }

  function open() {
    // Keep a failed preflight/import available for retry. A read still pending
    // when its dialog was closed cannot become the next dialog's chosen file.
    const retained = draft && !draft.loading ? draft.candidate : null;
    draft = {session:String(++sequence), generation:0, candidate:retained, loading:false, importing:false, error:''};
    showDialog(`<section id="backup-import-panel" data-session="${draft.session}">
      <div class="eyebrow green">RESTORE YOUR STORY</div><h2>从 JSON 备份恢复作品</h2>
      <p class="help">选择之前导出的作品 JSON 备份，检查内容后再恢复。单个文件最多 80 MB。</p>
      <label class="field">备份文件<input id="backup-import-file" type="file" accept="application/json,.json"><small>只选择文件和检查备份不会写入作品。</small></label>
      <div id="backup-import-status" aria-live="polite"></div>
      <div class="dialog-actions"><button type="button" class="button subtle" id="backup-import-cancel" data-action="backup-cancel-import">取消</button><button type="button" class="button outline" id="backup-import-retry" data-action="backup-preview-retry" hidden>重新检查</button><button type="button" class="button primary" id="backup-import-confirm" data-action="backup-confirm-import" disabled>恢复为新作品</button></div>
    </section>`);
    update(draft);
  }

  const currentRequest = (item, generation) => visible(item) && item.generation === generation;

  async function preflight(item, generation, candidate) {
    try {
      const result = await api('/api/backups/preview', candidate.backup);
      if (!currentRequest(item, generation)) return;
      if (!result.preview) throw new Error('Missing preview');
      candidate.preview = result.preview;
      item.error = '';
    } catch {
      if (!currentRequest(item, generation)) return;
      item.error = '这份备份暂时无法通过检查。请确认文件是作品 JSON 备份，也可以稍后重新检查。';
    } finally {
      if (currentRequest(item, generation)) {
        item.loading = false;
        update(item);
      }
    }
  }

  async function choose(file) {
    const item = draft;
    if (!file || !item || !visible(item) || item.importing) return;
    const generation = ++item.generation;
    item.candidate = null;
    item.error = '';
    item.loading = true;
    update(item);
    if (!Number.isFinite(file.size) || file.size > maxBytes) {
      item.loading = false;
      item.error = '备份文件超过 80 MB，请选择较小的作品备份。';
      update(item);
      return;
    }
    let backup;
    try { backup = JSON.parse(await file.text()); }
    catch {
      if (!currentRequest(item, generation)) return;
      item.loading = false;
      item.error = '无法读取这份 JSON 备份，请重新选择完整的作品备份文件。';
      update(item);
      return;
    }
    if (!currentRequest(item, generation)) return;
    let importKey;
    try { importKey = newImportKey(); }
    catch {
      item.loading = false;
      item.error = '当前环境无法准备恢复请求，请更新 Android 系统 WebView 或使用较新的浏览器后重试。';
      update(item);
      return;
    }
    const candidate = {filename:file.name || '作品备份.json', backup, preview:null, importKey};
    item.candidate = candidate;
    await preflight(item, generation, candidate);
  }

  async function restore(item, candidate) {
    try {
      try { await saveCurrent(); }
      catch { throw new Error('当前作品尚未保存，未开始恢复。请保存当前修改后重试。'); }
      if (!visible(item) || item.candidate !== candidate) return;
      let result;
      try { result = await api('/api/backups/import', candidate.backup, {'Idempotency-Key':candidate.importKey}); }
      catch { throw new Error('恢复未完成，文件和预览已保留。请检查应用内服务后重试。'); }
      // Once creation succeeds, a failed list refresh must not offer a second
      // restore of the same file as though the first request had failed.
      accept(result);
      let listed = false;
      try {
        const list = await api('/api/projects');
        if (Array.isArray(list.projects)) { state.projects = list.projects; listed = true; }
      } catch { /* The created project is already usable. */ }
      if (!listed && !state.projects.some(project => project.id === result.project.id)) {
        state.projects.unshift({id:result.project.id,title:result.project.title,
          revision:result.project.revision,updated_at:result.project.updated_at});
      }
      state.view = 'write';
      state.chapterId = result.project.chapters[0].id;
      state.editorTab = 'text';
      state.sideTab = 'memory';
      if (visible(item)) $('#dialog').close();
      if (draft === item) draft = null;
      render();
      toast('已恢复为新作品，原作品已保留。');
    } catch (error) {
      item.error = error.message;
      toast(item.error, true);
    } finally {
      item.importing = false;
      update(item);
    }
  }

  window.decorateBackup = function () {
    if (state.view !== 'settings' || $('#backup-import-button')) return;
    const exportButton = $('[data-action="backup"]');
    if (!exportButton) return;
    const row = document.createElement('div');
    row.className = 'button-row';
    row.innerHTML = '<button type="button" id="backup-import-button" class="button outline full" data-action="backup-import">从 JSON 备份恢复作品</button>';
    exportButton.after(row);
  };

  window.backupImportBusy = () => !!(draft?.importing && visible(draft));

  document.addEventListener('change', event => {
    if (event.target.id === 'backup-import-file') choose(event.target.files?.[0]);
  });
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-action]');
    if (!button || !button.dataset.action.startsWith('backup-')) return;
    event.preventDefault();
    if (state.busy) return;
    const action = button.dataset.action;
    if (action === 'backup-import') { open(); return; }
    const item = draft;
    if (!item || !visible(item) || item.importing) return;
    if (action === 'backup-cancel-import') { $('#dialog').close(); return; }
    if (action === 'backup-preview-retry' && item.candidate?.backup && !item.loading) {
      item.loading = true; item.error = ''; update(item);
      preflight(item, ++item.generation, item.candidate);
    } else if (action === 'backup-confirm-import' && item.candidate?.preview && !item.loading) {
      item.importing = true; item.error = ''; update(item);
      const candidate = item.candidate;
      run(() => restore(item, candidate), '正在从备份恢复新作品…');
    }
  });
  document.addEventListener('cancel', event => {
    if (draft?.importing && visible(draft) && event.target === $('#dialog')) {
      event.preventDefault();
      toast('正在恢复作品，请稍候再关闭。');
    }
  }, true);
})();
