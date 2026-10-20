'use strict';

// Notes belong to a project and chapter, independent of the current web origin.
(() => {
  const entries=new Map();
  const keyFor=cid=>`rewrite-notes:${cid}`;
  const scope=()=>state.project && typeof current==='function'?{pid:state.project.id,cid:current().id}:null;
  const matches=entry=>{const now=scope();return now?.pid===entry.pid&&now?.cid===entry.cid;};
  function entryFor({pid,cid}) {
    const key=`${pid}:${cid}`;
    if(!entries.has(key))entries.set(key,{pid,cid,value:'',serial:0,loaded:false,loading:null,error:null});
    return entries.get(key);
  }
  function paint(entry) {
    if(!matches(entry))return;
    const notice=$('#rewrite-notes-status');
    if(notice){notice.textContent=entry.error?`修订意见暂未保留，请先复制后重试：${entry.error.message}`:entry.loaded?'修订意见已在本机保留，重开后可继续。':'正在读取已保留的修订意见…';notice.classList?.toggle('warning-text',Boolean(entry.error));}
  }
  function apply(entry) {
    if(!matches(entry))return;
    state.rewriteNotes[entry.cid]=entry.value;
    const node=$('#rewrite-instructions');if(node)node.value=entry.value;
    paint(entry);
  }
  async function load(entry) {
    if(entry.loaded||!window.workDrafts)return;
    if(!entry.loading) {
      const serial=entry.serial;
      entry.loading=window.workDrafts.read(keyFor(entry.cid),entry.pid).then(saved=>{
        if(entry.serial===serial&&saved&&typeof saved.text==='string')entry.value=saved.text;
        entry.loaded=true;if(entry.serial===serial)entry.error=null;apply(entry);
      }).catch(error=>{entry.error=error;paint(entry);}).finally(()=>{entry.loading=null;});
    }
    await entry.loading;
  }
  window.decorateRewriteNotes=function() {
    const node=$('#rewrite-instructions'),currentScope=scope();if(!node||!currentScope)return;
    const entry=entryFor(currentScope);
    if(!$('#rewrite-notes-status'))node.insertAdjacentHTML('afterend','<small id="rewrite-notes-status" class="help" role="status"></small>');
    apply(entry);load(entry);
  };
  window.captureRewriteNotes=function(value) {
    const currentScope=scope();if(!currentScope)return Promise.resolve(false);
    const entry=entryFor(currentScope);entry.value=String(value);entry.serial++;
    state.rewriteNotes[entry.cid]=entry.value;
    if(!window.workDrafts)return Promise.resolve(false);
    const serial=entry.serial;
    return window.workDrafts.write(keyFor(entry.cid),{text:entry.value},entry.pid).then(()=>{
      if(entry.serial===serial){entry.loaded=true;entry.error=null;paint(entry);}return true;
    }).catch(error=>{if(entry.serial===serial){entry.error=error;paint(entry);}return false;});
  };
  // The final IME value may be visible before a normal input event is delivered.
  for(const type of ['compositionend','blur'])document.addEventListener(type,event=>{
    if(event.target.id==='rewrite-instructions')window.captureRewriteNotes(event.target.value);
  },true);
})();
