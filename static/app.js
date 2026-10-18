'use strict';

const $ = (q, root = document) => root.querySelector(q);
const $$ = (q, root = document) => [...root.querySelectorAll(q)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[ch]));
const icons = {
  book: '<path d="M4 4h11a5 5 0 0 1 5 5v12H9a5 5 0 0 0-5 0V4Zm0 13h11a5 5 0 0 1 5 4M9 8h6M9 12h4"/>',
  pen: '<path d="m15 4 5 5M4 20l5-1L21 7a3.5 3.5 0 0 0-5-5L4 14v6ZM13 21h8"/>',
  users: '<circle cx="9" cy="8" r="4"/><path d="M2 21v-2a7 7 0 0 1 14 0v2M17 4a4 4 0 0 1 0 8M20 21v-2a7 7 0 0 0-3-6"/>',
  layers: '<path d="m12 3 10 6-10 6L2 9l10-6Zm-9 11 9 5 9-5M3 19l9 5 9-5"/>',
  sliders: '<path d="M4 4v16M12 4v16M20 4v16M1 9h6M9 15h6M17 8h6"/>',
  spark: '<path d="m12 3 2.7 6.3L21 12l-6.3 2.7L12 21l-2.7-6.3L3 12l6.3-2.7L12 3ZM20 2v4M18 4h4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  check: '<path d="m5 12 4 4L20 5"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  leaf: '<path d="M20 3C6 1 1 9 6 16s16 3 14-13ZM4 21l11-12"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
};
const icon = name => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.book}</svg>`;
const statusName = {draft:'草稿', approved:'已确认', needs_review:'待复核'};
const state = {project:null, canon:[], projects:[], fields:{}, settings:{}, view:'write', chapterId:null, editorTab:'text', sideTab:'memory', rewriteNotes:{}, dirty:false, busy:false};
const current = () => state.project.chapters.find(c => c.id === state.chapterId) || state.project.chapters[0];
const count = text => [...(text || '').replace(/\s/g, '')].length;
const date = value => new Date(value).toLocaleString('zh-CN', {month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'});

async function api(path, body) {
  const options = body === undefined ? {} : {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)};
  let response;
  try { response = await fetch(path, options); }
  catch { throw new Error('无法连接本地服务，请确认 app.py 仍在运行。未保存的文字仍保留在页面中。'); }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '操作失败，请重试。');
  return data;
}

function toast(message, error = false) {
  const node = $('#toast');
  node.textContent = message;
  node.className = `visible ${error ? 'error' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.className = '', error ? 12000 : 4500);
}

function markDirty() {
  state.dirty = true;
  const label = $('#save-state');
  if (label) label.textContent = '有未保存修改';
}

function setBusy(value, label = '正在保存…') {
  state.busy = value;
  document.body.classList.toggle('busy', value);
  $('#busy-label')?.remove();
  if (value) {
    const node = document.createElement('div');
    node.id = 'busy-label';
    node.setAttribute('role', 'status');
    node.innerHTML = `<span class="spinner"></span>${esc(label)}`;
    document.body.appendChild(node);
  }
  $('#app').inert = value;
}

async function run(fn, label) {
  if (state.busy) return;
  setBusy(true, label);
  try { await fn(); }
  catch (err) { toast(err.message, true); }
  finally { setBusy(false); }
}

function accept(data) {
  state.project = data.project;
  state.canon = data.canon;
  const entry = state.projects.find(p => p.id === data.project.id);
  if (entry) entry.title = data.project.title;
  state.dirty = false;
}

async function mutate(action, data) {
  accept(await api(`/api/projects/${state.project.id}/mutate`, {revision:state.project.revision, action, data}));
}

function captureEditor() {
  if (state.view !== 'write' || !$('#chapter-text')) return;
  const c = current();
  for (const key of ['title', 'intent', 'outline', 'text', 'summary']) c[key] = $(`#chapter-${key}`).value;
  c.cast = $$('[name="cast"]:checked').map(n => n.value);
  captureChapterOutline();
}

async function saveCurrent() {
  if (!state.dirty) return;
  if (state.view === 'write') {
    captureEditor();
    const c = current();
    await mutate('save_chapter', Object.fromEntries(['id','title','intent','outline','text','summary','cast','changes','node_id','completes_node','node_evidence'].map(k => [k, c[k]])));
  } else if (state.view === 'outline') {
    await mutate('save_book_outline', collectBookOutline());
  } else if (state.view === 'story') {
    const data = {title:$('#story-title').value, brief:{}, style:{}};
    for (const node of $$('[data-section]')) data[node.dataset.section][node.name] = node.value;
    await mutate('save_story', data);
  }
}

function canonicalBefore() {
  const p = state.project;
  const entities = p.entities.map(e => ({...e, state:{...e.base}, sources:{}}));
  for (const c of p.chapters) {
    if (c.id === current().id) break;
    if (c.status !== 'approved') continue;
    for (const change of c.accepted_changes || []) {
      const e = entities.find(x => x.id === change.entity_id);
      if (e) { e.state[change.field] = change.value; e.sources[change.field] = {title:c.title, evidence:change.evidence}; }
    }
  }
  return entities;
}

function sidebar() {
  const p = state.project;
  const nav = [['write','pen','创作台'], ['outline','layers','全书大纲'], ['characters','users','人物档案'], ['world','layers','世界与伏笔'], ['story','book','故事与文风'], ['references','spark','创作参考库']];
  return `<aside class="sidebar">
    <a class="brand" href="/">${icon('book')}<span>叙事工坊<small>STORY ATELIER</small></span></a>
    <div class="project-picker"><span class="eyebrow">当前作品</span><select id="project-switch" aria-label="选择作品">${state.projects.map(x => `<option value="${x.id}" ${p.id === x.id ? 'selected' : ''}>${esc(x.title)}</option>`).join('')}</select><button class="icon-button" data-action="new-project" title="新建作品" aria-label="新建作品">${icon('plus')}</button></div>
    <nav aria-label="主要导航">${nav.map(([view, glyph, label]) => `<button data-action="view" data-view="${view}" class="nav-item ${state.view === view ? 'active' : ''}">${icon(glyph)}${label}${state.view === view ? '<span class="nav-dot"></span>' : ''}</button>`).join('')}</nav>
    <div class="chapter-heading"><span class="eyebrow">章节目录</span><button class="icon-button" data-action="add-chapter" aria-label="新建章节" title="新建章节">${icon('plus')}</button></div>
    <div class="chapter-list">${p.chapters.map((c,i) => `<button class="chapter-link ${state.chapterId === c.id && state.view === 'write' ? 'selected' : ''}" data-action="chapter" data-id="${c.id}"><span class="chapter-number">${String(i+1).padStart(2,'0')}</span><span>${esc(c.title)}<small><i class="status-dot ${c.status}"></i>${statusName[c.status]} · ${count(c.text).toLocaleString()} 字</small></span></button>`).join('')}</div>
    <div class="sidebar-bottom"><div class="local-note">${icon('leaf')}<span>灵感在远方，故事在本地<small>确认后的记忆，陪你写下一章</small></span></div><button class="nav-item ${state.view === 'settings' ? 'active' : ''}" data-action="view" data-view="settings">${icon('sliders')}模型设置<span class="connection-dot ${state.settings.model && state.settings.base_url ? 'ready' : ''}"></span></button></div>
  </aside>`;
}

function render() {
  if (!state.project) return;
  const p = state.project;
  const titles = {write:'创作台', outline:'全书大纲', characters:'人物档案', world:'世界与伏笔', story:'故事与文风', references:'创作参考库', settings:'模型设置'};
  $('#app').innerHTML = `${sidebar()}<main class="main"><header class="topbar"><div class="breadcrumb">我的书桌<span>/</span>${esc(p.title)}${p.is_demo?'<b class="badge draft">示例作品</b>':''}<span>/</span><strong>${titles[state.view]}</strong></div><div class="topbar-actions"><span class="save-state" id="save-state">${state.dirty ? '有未保存修改' : '已保存到本地'}</span><button class="button subtle small" data-action="export">${icon('download')}导出作品</button></div></header><div class="page">${({write:renderWrite, outline:renderBookOutline, characters:renderCharacters, world:renderWorld, story:renderStory, references:renderReferences, settings:renderSettings}[state.view])()}</div><footer class="footer"><span>叙事工坊 · 作者掌舵，灵感同行</span><span>本地存储 · ${p.chapters.filter(c=>c.status==='approved').length} 章已确认</span></footer></main>`;
  decorateReferenceEntries();
  decorateOutlineEntries();
  if ($('#rewrite-instructions')) $('#rewrite-instructions').value = state.rewriteNotes[current().id] || '';
}

function renderWrite() {
  const p = state.project, c = current();
  const total = p.chapters.reduce((n,x)=>n+count(x.text),0);
  const target = Number(p.brief.target) || 50000;
  const approved = p.chapters.filter(x=>x.status==='approved').length;
  const warnings = p.chapters.filter(x=>x.status==='needs_review').length;
  const characters = p.entities.filter(e=>e.kind==='character');
  return `<section class="welcome"><div><div class="eyebrow green">YOUR NEXT CHAPTER</div><h1>让每一次改变，都有来处。</h1><p>把注意力留给故事。人物、伏笔与记忆，在这里慢慢生长。</p></div><div class="welcome-mark">${icon('pen')}</div></section>
    <section class="stats" aria-label="作品进度"><div class="stat"><span>创作进度</span><strong>${total.toLocaleString()}<small>/ ${target.toLocaleString()} 字</small></strong><progress value="${Math.min(total,target)}" max="${target}" aria-label="目标字数进度"></progress></div><div class="stat"><span>正式记忆</span><strong>${approved}<small>章已确认 · ${p.entities.filter(e=>e.kind==='character').length} 位人物</small></strong><div class="stat-note">${warnings ? `${warnings} 章等待重新复核` : '每一次状态变化，都保留原文依据'}</div></div><div class="stat accent"><span>${icon('spark')} 写作提醒</span><p>先让人物作出选择，<br>再让故事发生变化。</p></div></section>
    ${warnings ? `<div class="notice amber">${icon('clock')}大纲、前文或基础档案有修改，${warnings} 章需要复核。待复核章节不进入正式记忆，请从前往后重新确认。</div>` : ''}
    <div class="workspace"><section class="editor-card"><div class="editor-heading"><div><span class="eyebrow">CHAPTER ${String(p.chapters.indexOf(c)+1).padStart(2,'0')}</span><input id="chapter-title" class="chapter-title" value="${esc(c.title)}" aria-label="章节标题" maxlength="200"></div><span class="badge ${c.status}">${statusName[c.status]}</span></div>
    <div class="chapter-intent"><label for="chapter-intent">本章意图</label><textarea id="chapter-intent" rows="2" placeholder="谁想得到什么？遇到什么阻碍？这一章结束时，什么发生了改变？">${esc(c.intent)}</textarea></div>
    <div class="editor-tabs" role="tablist">${[['text','正文'],['outline','场景方案'],['summary','章节记忆']].map(([id,label])=>`<button role="tab" aria-selected="${state.editorTab===id}" data-action="editor-tab" data-tab="${id}" class="${state.editorTab===id?'active':''}">${label}</button>`).join('')}<span id="word-count">${count(c.text).toLocaleString()} 字</span></div>
    <div class="editor-pane" ${state.editorTab!=='text'?'hidden':''} data-pane="text"><div class="paper-meta">${esc(p.style.perspective || '自由视角')}<span>让文字留下呼吸的空间</span></div><textarea id="chapter-text" class="manuscript" spellcheck="false" placeholder="故事从这里继续。\n\n你可以直接开始写，或先完善场景方案，再让模型起草这一章。">${esc(c.text)}</textarea></div>
    <div class="editor-pane padded" ${state.editorTab!=='outline'?'hidden':''} data-pane="outline"><label class="field-label" for="chapter-outline">场景方案</label><p class="help">按场景写清：目标 → 阻碍 → 选择 → 后果。生成的方案可以自由调整。</p><textarea id="chapter-outline" class="outline-area" placeholder="场景一：\n视角人物：\n目标与阻碍：\n选择与后果：\n需要埋下或回收的线索：">${esc(c.outline)}</textarea><div class="field-label cast-label">本章相关人物</div><div class="cast-list">${characters.length ? characters.map(e=>`<label class="check-chip"><input type="checkbox" name="cast" value="${e.id}" ${c.cast.includes(e.id)?'checked':''}>${esc(e.name)}</label>`).join('') : '<p class="help">先在人物档案中添加角色。</p>'}</div><p class="help">选择后仅携带这些人物的完整状态；不选则携带所有人物。</p><button class="button subtle" data-action="ai" data-task="plan">${icon('spark')}生成场景方案</button></div>
    <div class="editor-pane padded" ${state.editorTab!=='summary'?'hidden':''} data-pane="summary"><label class="field-label" for="chapter-summary">章节事实摘要</label><p class="help">记录实际发生的事、人物选择和新线索。确认正文后，这段摘要会成为后续写作的记忆。</p><textarea id="chapter-summary" class="outline-area" placeholder="用150—300字概括本章发生的事件，不加入猜测或尚未发生的剧情。">${esc(c.summary)}</textarea><div class="notice">摘要与正文一同确认。修改已确认的内容，会触发后续章节复核。</div></div>
    <div class="editor-actions"><button class="button subtle" data-action="save">保存草稿<span class="shortcut">Ctrl S</span></button><div><button class="button outline" data-action="ai" data-task="draft">${icon('spark')}AI 起草</button><button class="button primary" data-action="approve">${icon('check')}确认正文</button></div></div></section>
    <aside class="context-card"><div class="context-heading"><span>${icon('layers')}故事伴写</span><small>与你的文字保持一致</small></div><div class="context-tabs">${[['memory','记忆'],['review','审稿'],['changes','变化'],['history','版本']].map(([id,label])=>`<button data-action="side-tab" data-tab="${id}" class="${state.sideTab===id?'active':''}">${label}${id==='changes'&&c.changes.length?`<b>${c.changes.length}</b>`:''}</button>`).join('')}</div><div class="context-body">${({memory:renderMemory,review:renderReview,changes:renderChanges,history:renderHistory}[state.sideTab])()}</div></aside></div>`;
}

function renderMemory() {
  const c = current();
  const entities = canonicalBefore().filter(e => e.kind !== 'character' || !c.cast.length || c.cast.includes(e.id));
  const chars = entities.filter(e=>e.kind==='character');
  const threads = entities.filter(e=>e.kind==='thread');
  const worlds = entities.filter(e=>e.kind==='world');
  const charCard = e => `<details class="memory-card" open><summary><span class="avatar">${esc(e.name.slice(0,1))}</span><strong>${esc(e.name)}</strong><span class="tiny muted">人物</span></summary><div class="memory-fields">${['goal','location','knowledge','beliefs'].filter(k=>e.state[k]).map(k=>`<div><span>${state.fields.character[k]}</span><p>${esc(e.state[k])}</p>${e.sources[k]?`<small class="source">来自 ${esc(e.sources[k].title)}</small>`:''}</div>`).join('')}</div></details>`;
  return `<div class="context-caption"><span class="live-dot"></span>本章开始前的正式记忆</div><p class="help">只读取前面已确认的章节，当前草稿不会改变这些事实。</p>${chars.map(charCard).join('')}${!chars.length?'<div class="empty small-empty">还没有相关人物。<button class="text-button" data-action="view" data-view="characters">建立人物档案 →</button></div>':''}${worlds.length?`<div class="section-label">世界规则</div>${worlds.map(e=>`<div class="note-card"><strong>${e.locked?icon('lock'):''}${esc(e.name)}</strong><p>${esc(e.state.fact)}</p><small>读者已知：${esc(e.state.reader || '未记录')}</small></div>`).join('')}`:''}${threads.length?`<div class="section-label">留意这些伏笔</div>${threads.map(e=>`<div class="thread-card"><div><span class="thread-dot"></span><strong>${esc(e.name)}</strong></div><p>${esc(e.state.detail)}</p><small>${esc(e.state.status)} · ${esc(e.state.payoff)}</small></div>`).join('')}`:''}<div class="style-hint">${icon('pen')}<div><strong>文风提醒</strong><p>${esc(state.project.style.avoid)}</p></div></div>`;
}

function renderReview() {
  const review = current().review;
  return `<div class="context-caption">让审稿意见落到具体文字</div><div class="button-row"><button class="button subtle small" data-action="preflight">规则预检</button><button class="button primary small" data-action="ai" data-task="review">${icon('spark')}AI 审稿</button></div>${review?`<div class="review-overview"><span class="badge ${review.source==='ai'?'approved':'draft'}">${review.source==='ai'?'AI 审稿':'本地规则预检'}</span><p>${esc(review.overview)}</p><small>${date(review.at)}</small></div>${review.issues.length?review.issues.map(i=>`<article class="issue"><div><span class="badge ${i.severity==='问题'?'needs_review':'draft'}">${esc(i.severity||'建议')}</span><strong>${esc(i.kind)}</strong></div>${i.quote?`<blockquote>${esc(i.quote)}</blockquote>${!current().text.includes(i.quote)?'<small class="warning-text">此引文未在当前正文找到，请人工核对。</small>':''}`:''}<p>${esc(i.message)}</p>${i.suggestion?`<div class="suggestion">修改建议：${esc(i.suggestion)}</div>`:''}</article>`).join(''):'<div class="empty small-empty">未发现规则覆盖范围内的问题。<small>这不代表情节与文风已经通过审核。</small></div>'}`:'<div class="empty">'+icon('pen')+'<h3>给故事一次回看</h3><p>预检格式、重复段落和状态依据；<br>使用模型检查人物动机与戏剧效果。</p></div>'}<div class="rewrite-box"><label for="rewrite-instructions" class="field-label">定向修订意见</label><textarea id="rewrite-instructions" rows="4" placeholder="例如：保留结尾，减少对话中的解释，让沈砚的回避通过动作表现。"></textarea><button class="button outline full" data-action="rewrite">${icon('spark')}按意见修订</button><p class="help">修订前自动保留版本，结果仍是待确认草稿。</p></div>`;
}

function renderChanges() {
  const c = current();
  return `<div class="context-caption">${c.changes.filter(x=>x.selected).length} / ${c.changes.length} 项变化已勾选</div><p class="help">只勾选有原文支持的变化。点击「确认正文」时，勾选项才会进入正式记忆。</p><button class="button outline small full" data-action="new-change">${icon('plus')}手动添加变化</button>${c.changes.length?c.changes.map(x=>{const e=state.project.entities.find(e=>e.id===x.entity_id);const valid=x.evidence&&c.text.includes(x.evidence);return `<article class="change-card"><label class="change-title"><input type="checkbox" name="change-select" data-id="${esc(x.id)}" ${x.selected?'checked':''}><strong>${esc(e?.name||'未知档案')}</strong><span>${esc(state.fields[e?.kind]?.[x.field]||x.field)}</span></label><p>${esc(x.value)}</p><blockquote>${esc(x.evidence||'未提供原文依据')}</blockquote>${!valid?'<small class="warning-text">依据未在当前正文找到，不能入库。</small>':''}${e?.locked?'<small class="warning-text">该档案已锁定，不能自动变更。</small>':''}<button class="text-button muted" data-action="remove-change" data-id="${esc(x.id)}">移除建议</button></article>`;}).join(''):'<div class="empty">'+icon('leaf')+'<h3>变化，值得被记住</h3><p>模型起草时会提出状态变化。<br>你也可以从正文中手动记录。</p></div>'}`;
}

function renderHistory() {
  return `<div class="context-caption">回到某个更好的句子</div><p class="help">保留最近100个版本。恢复会产生草稿，需要重新确认；现有版本仍然保留。</p>${[...current().versions].reverse().map(v=>`<div class="version"><span>${icon('clock')}</span><div><strong>${esc(v.reason)}</strong><small>${date(v.at)} · ${count(v.text)} 字</small><p>${esc(v.text.slice(0,65)||'空白草稿')}${v.text.length>65?'…':''}</p><button class="text-button" data-action="preview-version" data-id="${v.id}">查看与恢复 →</button></div></div>`).join('')||'<div class="empty small-empty">保存修改、生成正文或确认章节后，会在这里保留版本。</div>'}`;
}

function pageHeading(eyebrow, title, description, action='') {
  return `<section class="page-heading"><div><div class="eyebrow green">${eyebrow}</div><h1>${title}</h1><p>${description}</p></div>${action}</section>`;
}

function renderCharacters() {
  const entities = state.canon.filter(e=>e.kind==='character');
  return pageHeading('CHARACTER NOTES','人物不止是一个名字。','记录他们想要什么、相信什么，以及每一次选择留下的改变。',`<button class="button primary" data-action="new-entity" data-kind="character">${icon('plus')}建立人物</button>`)+`<div class="notice">这里显示作品最新的正式状态。编辑基础档案会让已确认章节进入待复核；只切换锁定状态不会改变剧情。</div><div class="entity-grid">${entities.map(e=>`<article class="entity-card"><div class="entity-heading"><span class="avatar large">${esc(e.name.slice(0,1))}</span><div><h2>${esc(e.name)}</h2><span class="tiny muted">${e.locked?'已锁定 · 不接收状态变化':'人物档案'}</span></div><button class="button subtle small" data-action="edit-entity" data-id="${e.id}">编辑</button></div><p class="entity-description">${esc(e.description||'还没有人物小传。')}</p><dl>${Object.entries(state.fields.character).map(([key,label])=>`<div><dt>${label}</dt><dd>${esc(e.state[key]||'尚未记录')}${e.sources[key]?`<details class="evidence"><summary>${icon('book')}${esc(e.sources[key].title)}</summary><blockquote>${esc(e.sources[key].evidence)}</blockquote></details>`:''}</dd></div>`).join('')}</dl></article>`).join('')||'<div class="empty wide">'+icon('users')+'<h3>从一个有欲望的人物开始</h3><p>创建主角，写下他想得到的东西，以及不愿付出的代价。</p></div>'}</div>`;
}

function renderWorld() {
  return pageHeading('WORLD & THREADS','世界有边界，伏笔有回声。','把客观事实、读者认知和待回收的线索分别记下来。')+['world','thread'].map(kind=>`<section class="entity-section"><div class="section-header"><h2>${kind==='world'?'世界设定':'伏笔追踪'}</h2><button class="button outline small" data-action="new-entity" data-kind="${kind}">${icon('plus')}${kind==='world'?'添加设定':'记录伏笔'}</button></div><div class="entity-grid">${state.canon.filter(e=>e.kind===kind).map(e=>`<article class="entity-card"><div class="entity-heading"><div class="entity-symbol">${icon(kind==='world'?'layers':'leaf')}</div><div><h2>${esc(e.name)}</h2><small class="muted">${e.locked?'锁定设定':'可由确认的剧情推进'}</small></div><button class="button subtle small" data-action="edit-entity" data-id="${e.id}">编辑</button></div><p class="entity-description">${esc(e.description)}</p><dl>${Object.entries(state.fields[kind]).map(([key,label])=>`<div><dt>${label}</dt><dd>${esc(e.state[key]||'尚未记录')}${e.sources[key]?`<details class="evidence"><summary>来自 ${esc(e.sources[key].title)}</summary><blockquote>${esc(e.sources[key].evidence)}</blockquote></details>`:''}</dd></div>`).join('')}</dl></article>`).join('')||'<div class="empty small-empty wide">还没有记录，添加第一条吧。</div>'}</div></section>`).join('');
}

const briefLabels = {premise:'故事种子', genre:'题材与类型', audience:'目标读者与阅读体验', conflict:'核心冲突与代价', ending:'结局方向', target:'目标字数'};
const styleLabels = {perspective:'叙述视角与距离', rhythm:'句式与节奏', dialogue:'对白特点', description:'描写与修辞', avoid:'避免的表达', sample:'文风参考片段'};
function renderStory() {
  const p = state.project;
  return pageHeading('STORY BIBLE','先找到故事的方向。','把创作意图写清楚，模型才知道哪些文字值得留下。',`<button class="button primary" data-action="save">${icon('check')}保存设定</button>`)+`<div class="story-form"><section class="form-card"><div class="form-heading"><span class="entity-symbol">${icon('book')}</span><div><h2>故事航向</h2><p>这本书，为谁讲，为什么值得读。</p></div></div><label class="field">作品名称<input id="story-title" value="${esc(p.title)}" maxlength="200"></label>${Object.entries(briefLabels).map(([key,label])=>`<label class="field">${label}${['target','genre'].includes(key)?`<input data-section="brief" name="${key}" value="${esc(p.brief[key])}" ${key==='target'?'type="number" min="1" max="10000000"':''}>`:`<textarea data-section="brief" name="${key}" rows="${key==='premise'?4:2}">${esc(p.brief[key])}</textarea>`}</label>`).join('')}</section><section class="form-card"><div class="form-heading"><span class="entity-symbol">${icon('pen')}</span><div><h2>文风卡</h2><p>让声音稳定，也给不同场景留出变化。</p></div></div>${Object.entries(styleLabels).map(([key,label])=>`<label class="field">${label}<textarea data-section="style" name="${key}" rows="${key==='sample'?5:2}" placeholder="${key==='sample'?'放入你自己写的，或有权使用的参考片段。':''}">${esc(p.style[key])}</textarea></label>`).join('')}</section></div><div class="notice">修改故事方向和文风卡会影响下一次模型请求，不会自动改写现有正文。世界事实与人物初始状态请在各自档案中维护。</div>`;
}

function renderSettings() {
  const s = state.settings;
  return pageHeading('YOUR WRITING PARTNER','选择你的写作搭档。','接入兼容 Chat Completions 的模型服务，也可以连接本机模型。')+`<div class="settings-layout"><section class="form-card"><div class="form-heading"><span class="entity-symbol">${icon('spark')}</span><div><h2>模型连接</h2><p>地址与模型名以你的服务提供方说明为准。</p></div></div><form id="settings-form"><label class="field">API 基础地址<input name="base_url" type="url" value="${esc(s.base_url||'')}" placeholder="https://你的服务地址/v1"><small>系统会在后面添加 /chat/completions，也支持填写完整接口地址。</small></label><label class="field">模型名称<input name="model" value="${esc(s.model||'')}" placeholder="填写服务提供方给出的模型 ID"></label><label class="field">API 密钥<input name="api_key" type="password" autocomplete="new-password" placeholder="${s.has_key?'本次服务已设置密钥；留空则保留':'本机无鉴权服务可以留空'}"><small>密钥只保存在服务进程内存中，重启后需重新填写；不会写入作品或浏览器存储。</small></label><label class="field">单次输出 token 上限<input name="max_tokens" type="number" min="512" max="32000" value="${s.max_tokens||6000}"><small>建议先用6000；实际可用上限由你的模型决定。</small></label><label class="check-line"><input type="checkbox" name="clear_key">清除本次会话已保存的密钥</label><button class="button primary" type="submit">保存模型设置${icon('arrow')}</button></form></section><aside><div class="note-card setup-note"><span class="eyebrow green">LOCAL FIRST</span><h2>你的书桌，在本地。</h2><p>作品、档案与历史版本保存在本机 SQLite 数据库。</p><p>点击 AI 功能时，相关正文、设定与文风卡才会发送至你配置的模型服务，可能产生该服务的使用费用。</p><p>未配置模型时，仍可手动写作、管理状态、运行规则预检并导出作品。</p></div><div class="note-card setup-note"><h3>一个完整的创作循环</h3><ol><li>写下章节意图，选择相关人物</li><li>生成并调整场景方案</li><li>起草、审稿、定向修订</li><li>核对摘要和候选状态变化</li><li>确认正文，接着写下一章</li></ol></div><button class="button outline full" data-action="backup">${icon('download')}导出作品 JSON 备份</button></aside></div>`;
}

function showDialog(html) {
  const dialog = $('#dialog');
  dialog.innerHTML = `<button class="dialog-close icon-button" data-action="close-dialog" aria-label="关闭">${icon('close')}</button>${html}`;
  if (!dialog.open) dialog.showModal();
}

function entityDialog(kind, id) {
  const e = state.project.entities.find(x=>x.id===id) || {kind, name:'', description:'', base:{}, locked:false};
  showDialog(`<form id="entity-form" data-kind="${kind}" data-id="${esc(id||'')}"><div class="eyebrow green">STORY NOTES</div><h2>${id?'编辑':'建立'}${{character:'人物档案',world:'世界设定',thread:'伏笔'}[kind]}</h2>${id?'<p class="help">以下是故事开始前的基础档案。剧情推进产生的变化，请在章节中记录。</p>':''}<label class="field">名称<input name="name" required maxlength="100" value="${esc(e.name)}"></label><label class="field">${kind==='character'?'人物小传 · 欲望、恐惧、底线与说话方式':'说明'}<textarea name="description" rows="3">${esc(e.description)}</textarea></label><div class="dialog-fields">${Object.entries(state.fields[kind]).map(([key,label])=>`<label class="field">${label}<textarea name="base-${key}" rows="2">${esc(e.base[key]||'')}</textarea></label>`).join('')}</div><label class="check-line"><input type="checkbox" name="locked" ${e.locked?'checked':''}>锁定此档案，不接受章节中的状态变化</label><div class="dialog-actions"><button type="button" class="button subtle" data-action="close-dialog">取消</button><button class="button primary" type="submit">保存档案</button></div></form>`);
}

function changeDialog() {
  const entities = state.project.entities;
  if (!entities.length) { toast('先创建人物、世界设定或伏笔，才能记录状态变化。', true); return; }
  showDialog(`<form id="change-form"><div class="eyebrow green">A CHANGE WITH EVIDENCE</div><h2>记下一个变化</h2><p class="help">填写变化后的完整状态，并从正文中复制一句原文作为依据。</p><label class="field">相关档案<select name="entity_id" id="change-entity">${entities.map(e=>`<option value="${e.id}">${esc(e.name)}${e.locked?'（已锁定）':''}</option>`).join('')}</select></label><label class="field">状态字段<select name="field" id="change-field"></select></label><label class="field">变化后的状态<textarea name="value" required rows="3"></textarea></label><label class="field">原文依据<textarea name="evidence" required rows="3" placeholder="从当前正文复制一句完全一致的文字"></textarea></label><div class="dialog-actions"><button type="button" class="button subtle" data-action="close-dialog">取消</button><button class="button primary" type="submit">添加待确认变化</button></div></form>`);
  updateChangeFields();
}

function updateChangeFields() {
  const e = state.project.entities.find(e=>e.id===$('#change-entity').value);
  $('#change-field').innerHTML = Object.entries(state.fields[e.kind]).map(([key,label])=>`<option value="${key}">${label}</option>`).join('');
}

async function aiAction(action, instructions='') {
  await saveCurrent();
  if (!state.settings.model || !state.settings.base_url) {
    state.view = 'settings'; render();
    toast('先填写模型地址与名称，即可使用 AI 写作。');
    return;
  }
  const data = await api(`/api/projects/${state.project.id}/ai`, {revision:state.project.revision, action, chapter_id:current().id, instructions});
  accept(data);
  if (action==='review') state.sideTab = 'review';
  if (action==='plan') state.editorTab = 'outline';
  if (action==='draft' || action==='rewrite') { state.editorTab='text'; state.sideTab='changes'; }
  render(); toast('已完成。请审阅结果，正文与状态仍由你确认。');
}

document.addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (!button || state.busy) return;
  const {action, id, view, tab, task, kind} = button.dataset;
  if (action.startsWith('ref-') || action.startsWith('out-')) return;
  if (action==='close-dialog') { $('#dialog').close(); return; }
  if (action==='editor-tab') {
    captureEditor(); state.editorTab=tab; render(); return;
  }
  if (action==='side-tab') {
    captureEditor(); state.sideTab=tab; render(); return;
  }
  if (action==='new-project') {
    showDialog('<form id="project-form"><div class="eyebrow green">A NEW STORY</div><h2>给新故事一个名字。</h2><label class="field">作品名称<input name="title" required maxlength="200" placeholder="暂定书名也很好" autofocus></label><p class="help">创建后，先给出全书大纲，确定阶段与结局，再建立人物和文风。</p><div class="dialog-actions"><button class="button primary" type="submit">打开新书桌 →</button></div></form>'); return;
  }
  if (action==='new-entity' || action==='edit-entity') { entityDialog(kind||state.project.entities.find(e=>e.id===id).kind,id); return; }
  if (action==='new-change') { captureEditor(); changeDialog(); return; }
  if (action==='remove-change') { captureEditor(); current().changes=current().changes.filter(c=>c.id!==id); markDirty(); render(); return; }
  if (action==='preview-version') {
    const v=current().versions.find(v=>v.id===id);
    showDialog(`<div class="eyebrow green">VERSION HISTORY</div><h2>${esc(v.reason)}</h2><p class="help">${date(v.at)} · 恢复后仍需重新确认正文。</p><pre class="version-prose">${esc(v.text||'（空白草稿）')}</pre><div class="dialog-actions"><button class="button subtle" data-action="close-dialog">关闭</button><button class="button primary" data-action="restore" data-id="${v.id}">恢复为草稿</button></div>`); return;
  }
  if (action==='approve') {
    captureEditor();
    const c=current();
    showDialog(`<div class="eyebrow green">AUTHOR'S APPROVAL</div><h2>把这一章写进正式记忆。</h2><p>《${esc(c.title)}》 · ${count(c.text)} 字</p><div class="note-card"><strong>章节摘要</strong><p>${esc(c.summary||'尚未填写摘要，请先在「章节记忆」中补充。')}</p></div><p>本次将写入 <strong>${c.changes.filter(x=>x.selected).length}</strong> 项勾选的状态变化。未勾选的建议不会生效。</p><p class="help">如果前文仍有未确认章节，请先完成前文。修改已确认内容会使后续章节进入待复核。</p><div class="dialog-actions"><button class="button subtle" data-action="close-dialog">继续检查</button><button class="button primary" data-action="confirm-approve">确认入库</button></div>`); decorateOutlineApproval(); return;
  }
  const instructions = action==='rewrite' ? ($('#rewrite-instructions')?.value || '') : '';
  if (action==='rewrite' && !instructions.trim() && !current().review) { toast('请填写修订意见，或先完成一次审稿。',true); return; }
  if ((action==='ai' && task==='draft') && current().text.trim()) {
    showDialog('<h2>重新起草这一章？</h2><p>现有正文会先存为历史版本，生成成功后替换为新草稿。生成失败则保留原稿。</p><div class="dialog-actions"><button class="button subtle" data-action="close-dialog">取消</button><button class="button primary" data-action="redraft">保留版本并起草</button></div>'); return;
  }
  run(async () => {
    if (action==='view' || action==='chapter') {
      await saveCurrent();
      if (action==='view') state.view=view;
      else { state.view='write'; state.chapterId=id; state.editorTab='text'; }
      render();
    } else if (action==='save') {
      await saveCurrent(); render(); toast('已保存到本地。');
    } else if (action==='add-chapter') {
      await saveCurrent(); await mutate('add_chapter',{}); state.chapterId=state.project.chapters.at(-1).id; state.view='write'; state.editorTab='outline'; render();
    } else if (action==='confirm-approve') {
      const outlineChecked = $('#approve-outline-checked')?.checked === true;
      if (state.project.book_outline.active && !outlineChecked) throw new Error('请先勾选已核对本章与全书大纲一致。');
      await saveCurrent(); await mutate('approve',{id:current().id,outline_checked:outlineChecked}); $('#dialog').close(); render(); toast('正文已确认，选中的状态变化已进入正式记忆。');
    } else if (action==='preflight') {
      await saveCurrent(); await mutate('preflight',{id:current().id}); state.sideTab='review'; render();
    } else if (action==='ai' || action==='rewrite' || action==='redraft') {
      if(action==='redraft') $('#dialog').close();
      await aiAction(action==='rewrite'?'rewrite':action==='redraft'?'draft':task,instructions);
    } else if (action==='restore') {
      $('#dialog').close(); await saveCurrent(); await mutate('restore',{id:current().id, version_id:id}); render(); toast('已恢复为待确认草稿。');
    } else if (action==='export' || action==='backup') {
      await saveCurrent();
      const a=document.createElement('a'); a.href=`/api/projects/${state.project.id}/${action}`; a.download=action==='export'?'novel.md':'novel-backup.json'; a.click();
      toast(action==='export'?'正在导出当前工作稿，草稿与待复核章节会带有标记。':'正在导出作品与版本记录。');
    }
  }, ['ai','rewrite','redraft'].includes(action)?'模型正在写作，请稍候… 通常需要数十秒':'正在保存…');
});

document.addEventListener('input', event => {
  if(event.target.id==='rewrite-instructions') {state.rewriteNotes[current().id]=event.target.value;return;}
  if(event.target.closest('#dialog') || event.target.closest('#settings-form') || event.target.id==='rewrite-instructions') return;
  if(event.target.matches('textarea, input') && ['write','story'].includes(state.view)) {
    markDirty();
    if(event.target.id==='chapter-text') $('#word-count').textContent=count(event.target.value).toLocaleString()+' 字';
  }
});

document.addEventListener('change', event => {
  if(event.target.id==='change-entity') updateChangeFields();
  if(event.target.name==='change-select') {
    current().changes.find(x=>x.id===event.target.dataset.id).selected=event.target.checked; markDirty();
  }
  if(event.target.id==='project-switch') {
    const pid=event.target.value;
    run(async()=>{await saveCurrent(); accept(await api(`/api/projects/${pid}`)); state.chapterId=state.project.chapters.find(c=>c.status!=='approved')?.id||state.project.chapters[0].id; state.view='write'; render();});
  }
});

document.addEventListener('submit', event => {
  if (event.target.id.includes('reference-form') || event.target.id==='outline-node-form') return;
  event.preventDefault();
  const form=event.target;
  const data=Object.fromEntries(new FormData(form));
  if(form.id==='change-form') {
    const e=state.project.entities.find(e=>e.id===data.entity_id);
    if(e.locked) {toast('该档案已锁定，请先解锁或选择其他档案。',true);return;}
    if(!current().text.includes(data.evidence.trim())) {toast('请从当前正文复制完全一致的原文依据。',true);return;}
    current().changes.push({...data,id:crypto.randomUUID(),evidence:data.evidence.trim(),selected:false});
    markDirty(); state.sideTab='changes'; $('#dialog').close();render();return;
  }
  run(async()=>{
    if(form.id==='entity-form') {
      const kind=form.dataset.kind;
      const base=Object.fromEntries(Object.keys(state.fields[kind]).map(key=>[key,data['base-'+key]||'']));
      await mutate('save_entity',{id:form.dataset.id,kind,name:data.name,description:data.description,locked:data.locked==='on',base});
      $('#dialog').close();render();toast('档案已保存。');
    } else if(form.id==='project-form') {
      await saveCurrent(); const result=await api('/api/projects',{title:data.title});
      state.projects.unshift({id:result.project.id,title:result.project.title});accept(result);state.chapterId=state.project.chapters[0].id;state.view='outline';$('#dialog').close();render();
    } else if(form.id==='settings-form') {
      state.settings=await api('/api/settings',{...data,max_tokens:Number(data.max_tokens),clear_key:data.clear_key==='on'});render();toast('模型设置已保存；首次生成时会验证连接。');
    }
  });
});

document.addEventListener('keydown', event=>{
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s') {event.preventDefault();run(async()=>{await saveCurrent();render();toast('已保存到本地。');});}
});
window.addEventListener('beforeunload',event=>{if(state.dirty||state.busy){event.preventDefault();event.returnValue='';}});

async function init() {
  try {
    const [list, settings]=await Promise.all([api('/api/projects'),api('/api/settings')]);
    state.projects=list.projects;state.fields=list.fields;state.settings=settings;
    accept(await api(`/api/projects/${list.projects[0].id}`));
    state.chapterId=state.project.chapters.find(c=>c.status!=='approved')?.id||state.project.chapters[0].id;
    render();
  } catch(err) {$('#app').innerHTML=`<div class="boot"><h1>暂时无法打开书桌</h1><p>${esc(err.message)}</p><a href="/">重新加载</a></div>`;}
}
init();
