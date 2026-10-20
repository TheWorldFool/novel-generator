'use strict';

// Enabled only in the installed Android application. Desktop remains explicit-save.
if (navigator.userAgent.includes('NovelGeneratorAndroid/')) {
  document.documentElement.classList.add('android-app');
  let saveTimer;
  let lastError = '';
  let saveBlocked = false;

  window.decorateMobile = function () {
    const label = $('#save-state');
    if(label && !state.dirty) label.textContent = '已保存到手机';
    if(state.view === 'settings') {
      const note = document.createElement('div');
      note.className = 'notice mobile-storage-note';
      note.textContent = '安卓版 · 作品保存在这台手机，无需连接电脑。请定期导出备份；卸载或清除应用数据会删除本地作品。模型密钥仅在本次应用进程中保留。AI 生成期间请保持应用在前台。';
      $('.page-heading').after(note);
    }
  };

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => window.mobileFlush(), 1800);
  }

  window.mobileFlush = function () {
    if(window.mobileSavePending) return window.mobileSavePending;
    if(!state.project || !state.dirty || state.busy || saveBlocked || $('#dialog')?.open) return Promise.resolve();
    const operation = currentSaveOperation();
    if(!operation) return Promise.resolve();
    const version = state.editVersion;
    const pid = state.project.id;
    // Freeze this edit; newer keystrokes stay in the DOM and in the next save.
    const [action, data] = JSON.parse(JSON.stringify(operation));
    const pending = api(`/api/projects/${pid}/mutate`, {revision:state.project.revision, action, data})
      .then(result => {
        if(state.project.id !== pid) return;
        if(state.editVersion === version) {
          accept(result);
        } else {
          state.project.revision = result.project.revision;
          state.project.updated_at = result.project.updated_at;
          state.canon = result.canon;
          // Keep later edits while reflecting the server's invalidated approvals.
          for(const chapter of state.project.chapters) {
            const saved = result.project.chapters.find(c => c.id === chapter.id);
            if(saved) for(const key of ['status','review','versions','outline_checked_version']) chapter[key] = saved[key];
          }
          scheduleSave();
        }
        lastError = '';
        const label = $('#save-state');
        if(label) label.textContent = state.dirty ? '有未保存修改' : '已保存到手机';
      }).catch(error => {
        if(error.message !== lastError) toast('自动保存未完成：' + error.message, true);
        lastError = error.message;
        // Do not overwrite newer revisions or retry indefinitely after conflicts.
        saveBlocked = true;
        const label = $('#save-state');
        if(label) label.textContent = '保存失败，请手动保存';
      }).finally(() => { window.mobileSavePending = null; });
    window.mobileSavePending = pending;
    return pending;
  };

  window.mobileBack = function () {
    if(window.backupImportBusy?.()) { toast('正在恢复作品，请稍候再返回。'); return 'stay'; }
    if($('#dialog')?.open) { $('#dialog').close(); return 'stay'; }
    if(state.busy || window.mobileSavePending) { toast('正在处理，请稍候再返回。'); return 'stay'; }
    if(state.dirty) {
      saveBlocked = false;
      window.mobileFlush();
      toast('正在保存草稿，保存后再按返回即可退出。');
      return 'stay';
    }
    return 'exit';
  };
  document.addEventListener('input', scheduleSave);
  document.addEventListener('change', scheduleSave);
  document.addEventListener('click', event => {
    if(event.target.closest('[data-action="save"]')) saveBlocked = false;
  });
  document.addEventListener('visibilitychange', () => {
    if(document.visibilityState === 'hidden') window.mobileFlush();
  });
}
