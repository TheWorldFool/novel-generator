'use strict';

// Reference materials stay separate from author-approved style and character facts.
const referenceStyleLabels = {perspective:'叙述视角与距离', rhythm:'句式与段落节奏', dialogue:'对白与潜台词', description:'描写、意象与修辞', avoid:'需要避免的表达'};
const observationLabels = {appearance:'外貌', clothing:'衣着与配饰', posture:'姿态与持物', expression:'表情'};
let referenceTab = 'style';
let pendingReferenceImage = null;
let imageSelectionVersion = 0;
const referenceFeedbackDrafts = new Map();
const characterReferenceDrafts = new Map();

const referenceDraftKey = id => `${state.project.id}:${id}`;

function rememberCharacterReferenceDraft(id) {
  const form=$('#apply-character-reference-form');
  if(!form || form.dataset.id!==id || form.dataset.project!==state.project.id || !form.referenceCandidateValues) return;
  const initial=form.referenceCandidateValues, values={};
  for(const input of $$('[name^="value-"]',form)) {
    const key=input.name.slice(6);
    if(input.value!==(initial[key]||'')) values[key]=input.value;
  }
  const selected=$$('[name="fields"]:checked',form).map(input=>input.value);
  const draft={values,selected};
  if(form.elements.name.value!==initial.name) draft.name=form.elements.name.value;
  if(form.elements.entity_id.value!==initial.entity_id) draft.entity_id=form.elements.entity_id.value;
  draft.modified=Object.keys(values).length>0 || 'name' in draft || 'entity_id' in draft || selected.length!==1 || selected[0]!=='appearance';
  characterReferenceDrafts.set(referenceDraftKey(id),draft);
}

function referenceFeedbackSection(r) {
  const feedback=referenceFeedbackDrafts.get(referenceDraftKey(r.id))||'';
  const history=(r.analysis_history||[]).slice().reverse();
  return `<section class="reference-feedback" aria-labelledby="reference-feedback-heading"><h3 id="reference-feedback-heading">有不准确的地方？指出问题并修正。</h3><p class="help">说明哪里看错、应该是什么，以及哪些内容需要保留。模型会结合原图、上一轮分析和你的纠正继续修改。</p>${r.analysis.feedback?`<details class="reference-last-feedback"><summary>查看上次纠正意见</summary><p>${esc(r.analysis.feedback)}</p></details>`:''}<label class="field">这次需要纠正什么？<textarea name="feedback" id="reference-feedback-input" rows="3" maxlength="5000" placeholder="例如：眼睛是蓝色，不是黑色；手里拿的是书，不是手机。请只修正这两处，保留发型和衣着描述。">${esc(feedback)}</textarea><small>最多5000字符。修正结果仍需核对并选择采用。</small></label><button type="button" class="button primary" data-action="ref-correct" data-id="${r.id}">${icon('spark')}按我的意见修正</button>${history.length?`<details class="reference-analysis-history"><summary>查看先前分析（${history.length}）</summary>${history.map(entry=>`<article><strong>${date(entry.analysis?.at||entry.replaced_at)}</strong><p>${entry.analysis?.feedback?'本轮纠正：'+esc(entry.analysis.feedback):'从原图开始的分析'}</p>${Object.entries(observationLabels).map(([key,label])=>`<p><span>${label}：</span>${esc(entry.analysis?.observations?.[key]||'未明确观察到')}</p>`).join('')}</article>`).join('')}</details>`:''}</section>`;
}

function referenceImageURL(id) {
  return `/api/projects/${state.project.id}/references/${id}/image`;
}

function decorateReferenceEntries() {
  if(state.view==='characters') {
    const heading=$('.page-heading'), original=$('.page-heading > .button');
    const actions=document.createElement('div');actions.className='button-row';
    if(original)actions.appendChild(original);
    actions.insertAdjacentHTML('afterbegin',`<button class="button outline" data-action="ref-upload">${icon('spark')}从图片设定人物</button>`);
    heading.appendChild(actions);
    const entities=state.canon.filter(e=>e.kind==='character');
    $$('.entity-card').forEach((card,i)=>card.insertAdjacentHTML('beforeend',renderEntityReferences(entities[i])));
  }
  if(state.view==='story') {
    $('.page-heading').insertAdjacentHTML('afterend',`<div class="reference-entry"><div><strong>有喜欢的文风？让模型先分析。</strong><p>贴入原文或上传文件，提炼写法，再选择采用哪些规则。</p></div><button class="button outline" data-action="ref-open" data-tab="style">${icon('spark')}打开文风参考库</button></div>`);
  }
  if(state.view==='settings') {
    $('#settings-form [name="model"]').closest('.field').insertAdjacentHTML('afterend',`<label class="field">读图模型名称（可选）<input name="vision_model" value="${esc(state.settings.vision_model||'')}" placeholder="留空则使用上面的模型"><small>使用同一服务地址和密钥。请填写支持图片输入的模型 ID；纯文本模型无法读图。</small></label>`);
  }
}

function renderEntityReferences(entity) {
  const refs = (state.project.references || []).filter(r => r.kind === 'character' && (entity.reference_ids || []).includes(r.id));
  return `<div class="entity-reference-strip">${refs.map(r=>`<button class="reference-thumbnail" data-action="ref-preview" data-id="${r.id}" title="${esc(r.title)}"><img src="${referenceImageURL(r.id)}" alt="${esc(r.title)}" loading="lazy"></button>`).join('')}<button class="text-button" data-action="ref-upload" data-entity="${entity.id}">${icon('plus')}添加人物参考图</button></div>`;
}

function renderReferences() {
  const p = state.project, refs = p.references || [];
  const styleRefs = refs.filter(r=>r.kind === 'style');
  const imageRefs = refs.filter(r=>r.kind === 'character');
  const selected = referenceTab === 'style' ? styleRefs : imageRefs;
  return pageHeading('CREATIVE REFERENCES', '从喜欢的文字，到鲜活的人物。', '保存参考，分析特点，再把你认可的部分带进故事。', `<button class="button primary" data-action="${referenceTab==='style'?'ref-new-style':'ref-upload'}">${icon('plus')}${referenceTab==='style'?'添加文字参考':'上传人物参考图'}</button>`)+`
    <div class="reference-tabs"><button data-action="ref-tab" data-tab="style" class="${referenceTab==='style'?'active':''}">${icon('pen')}文风参考 <span>${styleRefs.length}</span></button><button data-action="ref-tab" data-tab="character" class="${referenceTab==='character'?'active':''}">${icon('users')}人物图片 <span>${imageRefs.length}</span></button></div>
    ${referenceTab==='style'?`<section class="reference-mode"><div><strong>写作时如何使用参考</strong><p>分析提炼的是文风规则，原文仅在你选择启用后用于写作。</p></div><select id="reference-mode" aria-label="文风参考模式"><option value="card" ${p.style_reference_mode==='card'?'selected':''}>只使用文风卡</option><option value="samples" ${p.style_reference_mode==='samples'?'selected':''}>文风卡 + 启用的原文样例</option></select></section><p class="help">最多同时启用3份样例，每份携带前4000字符；「故事与文风」中的手写参考片段也受此模式控制。样例只用于借鉴表达，不作为本书剧情事实。</p>`:`<div class="notice">上传或粘贴 PNG、JPEG、WebP 图片，单张不超过4MB。点击「读图分析」会把图片发给你配置的模型服务；请使用支持图片输入的模型。外貌观察与虚构人设建议分开呈现。</div>`}
    <div class="reference-grid">${selected.map(r=>referenceCard(r)).join('') || `<div class="empty wide">${icon(referenceTab==='style'?'pen':'users')}<h3>${referenceTab==='style'?'留下一段你喜欢的文字':'给人物一个可见的起点'}</h3><p>${referenceTab==='style'?'粘贴片段，或上传 TXT / Markdown 文件。\n模型会分析写法，你决定采用哪些特点。':'选择图片或从剪贴板粘贴。\n先看见外貌，再一起想象这个人的故事。'}</p></div>`}</div>
    <div class="notice reference-footnote">这里是创作参考库。「分析学习」会产生可编辑的候选设定，不会训练模型，也不会自动改写小说正文。</div>`;
}

function referenceCard(r) {
  const entity = state.project.entities.find(e=>e.id===r.entity_id);
  const canCorrect=r.kind==='character'&&r.analysis;
  return `<article class="reference-card">${r.kind==='character'?`<button class="reference-cover" data-action="ref-preview" data-id="${r.id}" aria-label="查看${esc(r.title)}"><img src="${referenceImageURL(r.id)}" alt="${esc(r.title)}" loading="lazy"></button>`:''}<div class="reference-card-content"><div class="reference-card-heading"><h2>${esc(r.title)}</h2><span class="badge ${r.analysis?'approved':'draft'}">${r.analysis?'已分析':'未分析'}</span></div>${r.kind==='style'?`<blockquote class="reference-excerpt">${esc(r.text.slice(0,170))}${r.text.length>170?'…':''}</blockquote><small class="muted">${r.text.length.toLocaleString()} 字符 · 分析时读取完整材料</small>`:`<small class="muted">${Math.ceil(r.size/1024)} KB · ${entity?'关联 '+esc(entity.name):'尚未关联人物'}</small>`}${r.notes?`<p class="reference-notes">参考重点：${esc(r.notes)}</p>`:''}${r.applied_at?`<p class="source">曾于 ${date(r.applied_at)} 采用分析结果</p>`:''}<div class="reference-actions"><button class="button primary small" data-action="${canCorrect?'ref-feedback':'ref-analyze'}" data-id="${r.id}">${icon('spark')}${canCorrect?'指出问题并修正':r.analysis?'重新分析':r.kind==='style'?'分析文风':'读图分析'}</button><button class="button outline small" data-action="ref-preview" data-id="${r.id}">${r.analysis?'审阅与采用':'查看材料'}</button>${r.kind==='style'?`<button class="text-button" data-action="ref-edit-style" data-id="${r.id}">编辑</button>`:canCorrect?`<button class="text-button" data-action="ref-reanalyze" data-id="${r.id}">完全重新分析</button>`:''}</div>${r.kind==='style'?`<label class="reference-activate"><input type="checkbox" data-reference-active="${r.id}" ${r.active?'checked':''}>启用为写作样例${r.active&&state.project.style_reference_mode==='card'?'<small>当前仅用文风卡，原文暂不发送</small>':''}</label>`:''}</div></article>`;
}

function styleReferenceDialog(id) {
  const r = state.project.references?.find(r=>r.id===id) || {title:'', text:'', notes:''};
  showDialog(`<form id="style-reference-form" data-id="${esc(id||'')}"><div class="eyebrow green">STYLE REFERENCE</div><h2>${id?'编辑':'添加'}文风参考</h2><label class="field">参考名称<input name="title" required maxlength="200" value="${esc(r.title)}" placeholder="例如：冷静克制的悬疑叙述"></label><label class="field">从文件读取（可选）<input type="file" id="style-reference-file" accept=".txt,.md,text/plain,text/markdown"><small>支持 TXT / Markdown，优先按 UTF-8 读取；也可直接粘贴文字。</small></label><label class="field">参考原文<textarea name="text" required rows="9" maxlength="30000" placeholder="粘贴想让模型分析的文字，最多30000字符。">${esc(r.text)}</textarea></label><label class="field">想学习哪些方面？<textarea name="notes" rows="2" maxlength="3000" placeholder="例如：主要学习对白中的潜台词，不采用原文的第一人称视角。">${esc(r.notes)}</textarea></label><p class="help">分析时会将这份原文发送至配置的模型服务。分析结果须由你确认；修改材料会清除旧分析并停用其样例。</p><div class="dialog-actions"><button type="submit" name="mode" value="save" class="button subtle">仅保存参考</button><button type="submit" name="mode" value="analyze" class="button primary">保存并分析</button></div></form>`);
}

function imageReferenceDialog(entityId='') {
  pendingReferenceImage = null;
  imageSelectionVersion++;
  showDialog(`<form id="image-reference-form"><div class="eyebrow green">CHARACTER FROM AN IMAGE</div><h2>从一张图片，开始一个人物。</h2><div class="image-dropzone" id="image-dropzone" tabindex="0"><span>${icon('users')}</span><strong>选择、拖入图片，或在这里粘贴</strong><small>PNG / JPEG / WebP · 单张最多4MB</small><input id="reference-image-file" type="file" accept="image/png,image/jpeg,image/webp" aria-label="选择人物参考图"><img id="reference-image-preview" alt="待上传的参考图片" hidden></div><label class="field">参考名称<input name="title" required maxlength="200" placeholder="例如：林照的外貌参考"></label><label class="field">关联人物<select name="entity_id"><option value="">先作为新人物参考</option>${state.project.entities.filter(e=>e.kind==='character').map(e=>`<option value="${e.id}" ${entityId===e.id?'selected':''}>${esc(e.name)}</option>`).join('')}</select></label><label class="field">你的设定方向<textarea name="notes" rows="3" maxlength="3000" placeholder="例如：只参考中间人物的发型和衣着；故事背景是架空海港。">${entityId?'以关联人物的既有设定为准，提出相容的外貌与创作建议。':''}</textarea></label><p class="help">读图只把可见特征作为观察。性格、动机与经历会作为虚构建议单列，默认不写入档案。</p><div class="dialog-actions"><button type="submit" name="mode" value="save" class="button subtle">仅保存参考</button><button type="submit" name="mode" value="analyze" class="button primary">保存并读图</button></div></form>`);
}

async function chooseReferenceImage(file) {
  const version = ++imageSelectionVersion;
  pendingReferenceImage = null;
  const preview = $('#reference-image-preview');
  if(preview) { preview.hidden=true; preview.removeAttribute('src'); }
  if(!file) return;
  if(file.size>4*1024*1024 || !/\.(png|jpe?g|webp)$/i.test(file.name) && !['image/png','image/jpeg','image/webp'].includes(file.type)) throw new Error('请选择不超过4MB的 PNG、JPEG 或 WebP 图片。');
  const url = await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('图片读取失败，请重新选择。'));reader.readAsDataURL(file);});
  if(version!==imageSelectionVersion || !$('#image-reference-form')) return;
  pendingReferenceImage = {base64:url.split(',')[1]};
  $('#reference-image-preview').src=url;
  $('#reference-image-preview').hidden=false;
  const title=$('#image-reference-form [name="title"]');
  if(!title.value) title.value=file.name.replace(/\.[^.]+$/, '').slice(0,200) || '人物参考图';
}

function referencePreview(id) {
  const r=state.project.references.find(r=>r.id===id), a=r.analysis;
  if(!a) {
    showDialog(`<div class="eyebrow green">REFERENCE MATERIAL</div><h2>${esc(r.title)}</h2>${r.kind==='style'?`<pre class="version-prose">${esc(r.text)}</pre>`:`<img class="reference-preview-large" src="${referenceImageURL(r.id)}" alt="${esc(r.title)}">`}<p class="help">${esc(r.notes||'尚未填写参考重点。')}</p><div class="dialog-actions"><button class="button primary" data-action="ref-analyze" data-id="${r.id}">${icon('spark')}${r.kind==='style'?'分析文风':'读图分析'}</button></div>`);return;
  }
  if(r.kind==='style') {
    showDialog(`<form id="apply-style-reference-form" data-id="${r.id}"><div class="eyebrow green">REVIEW BEFORE APPLYING</div><h2>从「${esc(r.title)}」提炼的文风</h2><p class="help">${esc(a.overview)}</p><div class="notice">勾选的维度将替换当前文风卡的对应内容。原文样例是否参与写作，需要另行启用。</div>${Object.entries(referenceStyleLabels).map(([key,label])=>`<div class="reference-field"><label class="check-line"><input type="checkbox" name="fields" value="${key}" checked>${label}</label><textarea name="value-${key}" rows="3" maxlength="5000" aria-label="${label}">${esc(a.style[key])}</textarea></div>`).join('')}<details class="analysis-evidence"><summary>查看分析的原文依据（${a.evidence.length}）</summary>${a.evidence.map(e=>`<blockquote>${esc(e.quote)}</blockquote><p class="help">${esc(e.observation)}</p>${e.verified?'':'<small class="warning-text">此引文未在参考文本找到，请核对这条分析。</small>'}`).join('')}</details><div class="dialog-actions"><button type="button" class="button subtle" data-action="close-dialog">先保留分析</button><button class="button primary" type="submit">采用勾选的文风规则</button></div></form>`);return;
  }
  rememberCharacterReferenceDraft(id);
  const c=a.character, draft=characterReferenceDrafts.get(referenceDraftKey(id));
  const entityId=draft&&'entity_id' in draft?draft.entity_id:r.entity_id;
  const value=key=>esc(draft&&key in draft.values?draft.values[key]:key==='description'?c.description:c.base[key]||'');
  const selected=key=>(draft?draft.selected.includes(key):key==='appearance')?'checked':'';
  showDialog(`<form id="apply-character-reference-form" data-id="${r.id}" data-project="${state.project.id}">
    <div class="eyebrow green">OBSERVE, THEN IMAGINE</div><h2>先看见，再设定。</h2>
    <div class="image-analysis-intro"><img src="${referenceImageURL(r.id)}" alt="${esc(r.title)}"><div><h3>图中可见特征 · 待你核对</h3>${Object.entries(observationLabels).map(([key,label])=>`<p><strong>${label}：</strong>${esc(a.observations[key]||'未明确观察到')}</p>`).join('')}</div></div>
    ${a.uncertainties.length?`<div class="notice amber">${a.uncertainties.map(esc).join('<br>')}</div>`:''}
    ${referenceFeedbackSection(r)}
    <h3 class="reference-adoption-heading">核对本轮建议，再选择采用</h3>
    ${draft?.modified?`<div class="notice reference-draft-notice">你手动编辑的采用内容和勾选已保留，未编辑的建议会随分析更新。<button type="button" class="text-button" data-action="ref-reset-draft" data-id="${r.id}">恢复本轮分析的全部建议</button></div>`:''}
    <label class="field">应用到哪个人物？<select name="entity_id"><option value="">建立新人物</option>${state.project.entities.filter(e=>e.kind==='character').map(e=>`<option value="${e.id}" ${e.id===entityId?'selected':''}>${esc(e.name)}${e.locked?'（已锁定）':''}</option>`).join('')}</select></label>
    <label class="field">新人物名称（选择已有角色时不改名）<input name="name" value="${esc(draft&&'name' in draft?draft.name:c.name)}" maxlength="100"></label>
    <div class="notice">默认只采用可见特征。下方小传、目标、经历与关系均为虚构创作建议，请按需要勾选。修改已有基础档案会触发章节复核。</div>
    <div class="reference-field"><label class="check-line"><input type="checkbox" name="fields" value="appearance" ${selected('appearance')}>采用外貌与衣着（根据图片观察整理）</label><textarea name="value-appearance" rows="5" maxlength="5000" aria-label="采用的外貌与衣着">${value('appearance')}</textarea></div>
    <div class="reference-field"><label class="check-line"><input type="checkbox" name="fields" value="description" ${selected('description')}>采用虚构人物小传</label><textarea name="value-description" rows="4" maxlength="5000" aria-label="虚构人物小传">${value('description')}</textarea></div>
    <details class="analysis-evidence"><summary>展开更多虚构初始设定建议</summary>${Object.entries(state.fields.character).filter(([key])=>key!=='appearance').map(([key,label])=>`<div class="reference-field"><label class="check-line"><input type="checkbox" name="fields" value="${key}" ${selected(key)}>采用${label}建议</label><textarea name="value-${key}" rows="2" maxlength="5000" aria-label="${label}建议">${value(key)}</textarea></div>`).join('')}</details>
    <div class="reference-analysis-tools"><button type="button" class="text-button" data-action="ref-reanalyze" data-id="${r.id}">完全重新分析原图</button><small>从原图与参考重点开始，不沿用纠正意见。</small></div>
    <div class="dialog-actions"><button type="button" class="button subtle" data-action="close-dialog">先保留分析</button><button class="button primary" type="submit">采用勾选的人物设定</button></div></form>`);
  $('#apply-character-reference-form').referenceCandidateValues={...c.base,description:c.description,name:c.name,entity_id:r.entity_id||''};
}

async function analyzeReference(id, feedback, feedbackAtSubmit) {
  const r=state.project.references.find(r=>r.id===id);
  const model=r.kind==='character'?(state.settings.vision_model||state.settings.model):state.settings.model;
  if(!state.settings.base_url||!model) throw new Error('参考材料已保存。请先在「模型设置」配置模型；读图需要支持图片输入的模型。');
  rememberCharacterReferenceDraft(id);
  const payload={revision:state.project.revision,id};
  if(feedback!==undefined) payload.feedback=feedback;
  const activeForm=$('#apply-character-reference-form');
  const feedbackInput=activeForm?.dataset.id===id?$('#apply-character-reference-form [name="feedback"]'):null;
  const submittedFeedback=feedbackAtSubmit===undefined?feedbackInput?.value:feedbackAtSubmit;
  accept(await api(`/api/projects/${state.project.id}/analyze-reference`, payload));
  // The dialog remains editable while the request is running. Only clear the
  // submitted text; any new feedback belongs to the next correction round.
  if(feedbackInput && feedbackInput.value!==submittedFeedback) {
    referenceFeedbackDrafts.set(referenceDraftKey(id),feedbackInput.value);
  } else {
    referenceFeedbackDrafts.delete(referenceDraftKey(id));
    if(feedbackInput)feedbackInput.value='';
  }
  render();referencePreview(id);
  toast(feedback!==undefined?'已按你的意见修正。请核对本轮建议，再选择采用。':'分析已保存。请选择要采用的部分，现有设定还没有改变。');
}

document.addEventListener('click',event=>{
  const button=event.target.closest('[data-action]');
  if(!button||state.busy||!button.dataset.action.startsWith('ref-'))return;
  const {action,id,entity,tab}=button.dataset;
  if(action==='ref-tab'){referenceTab=tab;render();return;}
  if(action==='ref-new-style'||action==='ref-edit-style'){styleReferenceDialog(id);return;}
  if(action==='ref-upload'){imageReferenceDialog(entity);return;}
  if(action==='ref-preview'){referencePreview(id);return;}
  if(action==='ref-feedback') {
    referencePreview(id);
    const input=$('#reference-feedback-input');
    input?.scrollIntoView({block:'center'});input?.focus({preventScroll:true});return;
  }
  if(action==='ref-reset-draft') {
    const form=$('#apply-character-reference-form');
    if(form)form.referenceCandidateValues=null;
    characterReferenceDrafts.delete(referenceDraftKey(id));referencePreview(id);return;
  }
  if(action==='ref-correct') {
    const input=$('#reference-feedback-input'), rawFeedback=input?.value||'', feedback=rawFeedback.trim();
    if(!feedback || feedback.length>5000) {toast('请填写具体的纠正意见，最多5000字符。',true);input?.focus();return;}
    referenceFeedbackDrafts.set(referenceDraftKey(id),input.value);
    rememberCharacterReferenceDraft(id);
    run(async()=>{await saveCurrent();await analyzeReference(id,feedback,rawFeedback);},'正在根据你的意见修正人物分析…');return;
  }
  if(action==='ref-reanalyze') {
    rememberCharacterReferenceDraft(id);
    showDialog(`<div class="eyebrow green">START FROM THE IMAGE</div><h2>完全重新分析这张图片？</h2><p>模型将从原图和参考重点重新开始，本轮不沿用之前的纠正意见。旧结果会保留在分析历史中，手动编辑的采用内容也会保留。</p><div class="dialog-actions"><button type="button" class="button subtle" data-action="ref-preview" data-id="${id}">返回审阅</button><button type="button" class="button primary" data-action="ref-reanalyze-confirm" data-id="${id}">完全重新分析</button></div>`);return;
  }
  if(action==='ref-reanalyze-confirm') {
    run(async()=>{await saveCurrent();try{await analyzeReference(id);}catch(error){referencePreview(id);throw error;}},'正在从原图重新分析…');return;
  }
  if(action==='ref-open') {run(async()=>{await saveCurrent();referenceTab=tab||'style';state.view='references';render();});return;}
  if(action==='ref-analyze') {run(async()=>{await saveCurrent();await analyzeReference(id);},'正在分析参考材料，请稍候…');}
});

document.addEventListener('input',event=>{
  if(event.target.id==='reference-feedback-input') {
    const form=event.target.closest('#apply-character-reference-form');
    if(form)referenceFeedbackDrafts.set(referenceDraftKey(form.dataset.id),event.target.value);
    return;
  }
  const form=event.target.closest('#apply-character-reference-form');
  if(form)rememberCharacterReferenceDraft(form.dataset.id);
});

document.addEventListener('change',event=>{
  const characterForm=event.target.closest('#apply-character-reference-form');
  if(characterForm)rememberCharacterReferenceDraft(characterForm.dataset.id);
  if(event.target.id==='reference-image-file')chooseReferenceImage(event.target.files[0]).catch(err=>toast(err.message,true));
  if(event.target.id==='style-reference-file') {
    const file=event.target.files[0], form=$('#style-reference-form');
    if(!file)return;
    (async()=>{
      if(!/\.(txt|md)$/i.test(file.name)||file.size>1000000)throw new Error('请选择不超过1MB的 TXT 或 Markdown 文件。');
      const bytes=await file.arrayBuffer();
      let text;
      try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{text=new TextDecoder('gb18030',{fatal:true}).decode(bytes);}
      if(text.length>30000)throw new Error('文件超过30000字符，请截取希望学习的片段后上传。');
      if(!form.isConnected)return;
      form.elements.text.value=text;
      if(!form.elements.title.value)form.elements.title.value=file.name.replace(/\.[^.]+$/,'').slice(0,200);
    })().catch(err=>toast(err.message,true));
  }
  if(event.target.id==='reference-mode')run(async()=>{try{await mutate('set_reference_mode',{mode:event.target.value});}finally{render();}});
  if(event.target.dataset.referenceActive)run(async()=>{try{await mutate('toggle_style_reference',{id:event.target.dataset.referenceActive,active:event.target.checked});}finally{render();}});
});

document.addEventListener('paste',event=>{
  if(!$('#image-reference-form')||state.busy)return;
  const item=[...event.clipboardData.items].find(item=>item.type.startsWith('image/'));
  if(item){event.preventDefault();chooseReferenceImage(item.getAsFile()).catch(err=>toast(err.message,true));}
});
document.addEventListener('dragover',event=>{if(event.target.closest('#image-dropzone'))event.preventDefault();});
document.addEventListener('drop',event=>{
  if(!event.target.closest('#image-dropzone'))return;
  event.preventDefault();
  if(!state.busy)chooseReferenceImage(event.dataTransfer.files[0]).catch(err=>toast(err.message,true));
});

document.addEventListener('submit',event=>{
  const form=event.target;
  if(!['style-reference-form','image-reference-form','apply-style-reference-form','apply-character-reference-form'].includes(form.id))return;
  event.preventDefault();
  if(state.busy)return;
  const fd=new FormData(form),data=Object.fromEntries(fd),mode=event.submitter?.value;
  const image=pendingReferenceImage;
  run(async()=>{
    await saveCurrent();
    let id=form.dataset.id;
    if(form.id==='style-reference-form'){
      await mutate('save_style_reference',{...data,id});
      id=id||state.project.references.at(-1).id;
      referenceTab='style';state.view='references';$('#dialog').close();render();
      if(mode==='analyze')await analyzeReference(id);else toast('文字参考已保存，尚未启用为写作样例。');
    }else if(form.id==='image-reference-form'){
      if(!image)throw new Error('请先选择或粘贴人物参考图。');
      accept(await api(`/api/projects/${state.project.id}/reference-image`,{...data,...image,revision:state.project.revision}));
      id=state.project.references.at(-1).id;
      referenceTab='character';state.view='references';$('#dialog').close();render();
      if(mode==='analyze')await analyzeReference(id);else toast('人物参考图已保存，尚未影响人物设定。');
    }else{
      const fields=fd.getAll('fields');
      const values=Object.fromEntries(fields.map(key=>[key,data['value-'+key]]));
      await mutate(form.id==='apply-style-reference-form'?'apply_style_analysis':'apply_character_reference',{id,fields,values,entity_id:data.entity_id,name:data.name});
      if(form.id==='apply-character-reference-form')characterReferenceDrafts.delete(referenceDraftKey(id));
      $('#dialog').close();render();toast('已采用勾选的设定。未勾选的建议仍保留在参考分析中。');
    }
  },mode==='analyze'?'正在保存并分析参考材料…':'正在保存…');
});
