(function(){
'use strict';
const cfg=window.SELNET_DASHBOARD||{};
const $=(selector,root=document)=>root.querySelector(selector);
const $$=(selector,root=document)=>Array.from(root.querySelectorAll(selector));
const state={listType:'all',listPage:1,listPages:1,listRows:[],currentCustomer:null,chart:null,chartType:'total',modemTimer:null};

function escapeHtml(value){return String(value??'').replace(/[&<>'"]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));}
function boolArchive(value){if(typeof value==='boolean')return value;return ['hə','he','true','1','bəli','yes'].includes(String(value??'').trim().toLowerCase());}
function isProblem(row){return String(row?.qeyd||'').toLowerCase().includes('problem');}
function customerType(row){
  if(boolArchive(row?.arxiv))return{label:'Arxivdə',className:'archive',icon:'fa-box-archive'};
  if(isProblem(row))return{label:'Problem',className:'problem',icon:'fa-triangle-exclamation'};
  const note=String(row?.qeyd||'').toLowerCase();
  if(note.includes('köç')||note.includes('koc'))return{label:'Köçürmə',className:'move',icon:'fa-truck-moving'};
  return{label:'Qoşulma',className:'join',icon:'fa-plug'};
}
function formatDate(value){
  if(!value)return'Tarix yoxdur';
  const text=String(value).trim();
  let match=text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if(match)return`${match[2].padStart(2,'0')}.${match[1].padStart(2,'0')}.${match[3]}`;
  match=text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if(match)return`${match[3].padStart(2,'0')}.${match[2].padStart(2,'0')}.${match[1]}`;
  const date=new Date(text);return Number.isNaN(date.getTime())?text:date.toLocaleDateString('az-AZ');
}
function phoneHref(value){const digits=String(value||'').replace(/\D/g,'');if(!digits)return'';return digits.startsWith('994')?digits:(digits.startsWith('0')?`994${digits.slice(1)}`:`994${digits}`);}
function setLocked(locked){document.body.classList.toggle('locked',locked);}
function showToast(message,error=false){const toast=$('#toast');if(!toast)return;toast.classList.toggle('error',error);toast.innerHTML=`<i class="fa-solid ${error?'fa-circle-exclamation':'fa-circle-check'}"></i><span>${escapeHtml(message)}</span>`;toast.classList.add('show');clearTimeout(showToast.timer);showToast.timer=setTimeout(()=>toast.classList.remove('show'),3200);}
function requestJson(url,options={}){return fetch(url,{credentials:'same-origin',headers:{'Content-Type':'application/json',...(options.headers||{})},...options}).then(async response=>{let data={};try{data=await response.json();}catch{}if(response.status===401){window.location.href='/login';throw new Error('Sessiya bitib.');}if(!response.ok||data.success===false)throw new Error(data.error||'Sorğu yerinə yetirilmədi.');return data;});}

function openSidebar(){const side=$('#sidebar'),backdrop=$('#sidebarBackdrop');side?.classList.add('open');backdrop?.classList.add('open');setLocked(true);}
function closeSidebar(){const side=$('#sidebar'),backdrop=$('#sidebarBackdrop');side?.classList.remove('open');backdrop?.classList.remove('open');if(!$('.overlay.open')&&!$('.modal-wrap.open'))setLocked(false);}
function openModal(id){const modal=$(`#${id}`);if(!modal)return;modal.classList.add('open');modal.setAttribute('aria-hidden','false');setLocked(true);}
function closeModal(id){const modal=$(`#${id}`);if(!modal)return;modal.classList.remove('open');modal.setAttribute('aria-hidden','true');if(!$('.overlay.open')&&!$('.modal-wrap.open')&&!$('#sidebar')?.classList.contains('open'))setLocked(false);}
function closeAll(){closeSidebar();$$('.modal-wrap.open').forEach(el=>closeModal(el.id));closeCustomerDrawer();}

async function openCustomer(code){
  if(!code)return;
  const overlay=$('#customerDrawerOverlay'),body=$('#customerDrawerBody'),actions=$('#customerDrawerActions');
  overlay?.classList.add('open');overlay?.setAttribute('aria-hidden','false');setLocked(true);
  if(body)body.innerHTML='<div class="loading"><div class="spinner"></div>Müştəri məlumatı yüklənir...</div>';
  if(actions)actions.innerHTML='';
  try{
    const payload=await requestJson(`/customer/${encodeURIComponent(code)}`);
    state.currentCustomer=payload.data;
    renderCustomer(payload.data);
  }catch(error){if(body)body.innerHTML=`<div class="empty-state"><i class="fa-solid fa-circle-exclamation"></i><strong>Məlumat yüklənmədi</strong><span>${escapeHtml(error.message)}</span></div>`;}
}
function closeCustomerDrawer(){const overlay=$('#customerDrawerOverlay');overlay?.classList.remove('open');overlay?.setAttribute('aria-hidden','true');state.currentCustomer=null;if(!$('.modal-wrap.open')&&!$('#sidebar')?.classList.contains('open'))setLocked(false);}
function detailItem(label,value,full=false){const printable=value===0?'0':(value||'-');return`<div class="detail-item${full?' full':''}"><span class="detail-label">${escapeHtml(label)}</span><span class="detail-value">${printable}</span></div>`;}
function renderCustomer(row){
  const type=customerType(row),body=$('#customerDrawerBody'),actions=$('#customerDrawerActions');
  const title=$('#customerDrawerTitle'),sub=$('#customerDrawerSubtitle');
  if(title)title.textContent=row.ad_soyad||'Adsız müştəri';if(sub)sub.textContent=`Ödəniş kodu: ${row.odeme_kodu||'-'} · ${formatDate(row.timestamp)}`;
  const phone=String(row.telefon||'').trim();const telHtml=phone?`<a href="tel:${escapeHtml(phone)}">${escapeHtml(phone)}</a>`:'-';
  const links=String(row.drive_links||'').split(/[\n,]+/).map(v=>v.trim()).filter(Boolean);
  const linksHtml=links.length?links.map((link,index)=>`<a href="${escapeHtml(link)}" target="_blank" rel="noopener"><i class="fa-solid fa-link"></i> Sənəd ${index+1}</a>`).join('<br>'):'-';
  const result=row.netice||((isProblem(row))?'Nəticə qeyd edilməyib':'-');
  if(body)body.innerHTML=`
    <div class="detail-status-row"><span class="type-badge ${type.className}"><i class="fa-solid ${type.icon}"></i> ${type.label}</span>${row.netice?`<span class="type-badge">${escapeHtml(row.netice)}</span>`:''}</div>
    <div class="detail-grid">
      ${detailItem('Ödəniş kodu',escapeHtml(row.odeme_kodu||'-'))}
      ${detailItem('Aylıq ödəniş',escapeHtml(row.ayliq_odenis||'-'))}
      ${detailItem('Telefon',telHtml)}
      ${detailItem('Komendant',escapeHtml(row.komendant||'-'))}
      ${detailItem('Ş/V FİN',escapeHtml(row.fin||'-'))}
      ${detailItem('Ş/V Seriya',escapeHtml(row.seriya||'-'))}
      ${detailItem('Modem S/N',escapeHtml(row.modem||'-'))}
      ${detailItem('TV Box',escapeHtml(row.tvbox||'-'))}
      ${detailItem('Ünvan',escapeHtml(row.unvan||'-'),true)}
      ${detailItem('Qeyd',escapeHtml(row.qeyd||'-'),true)}
      ${isProblem(row)?detailItem('Problemin səbəbi',escapeHtml(row.problem_sebebi||'-'),true):''}
      ${isProblem(row)?detailItem('Nəticə',escapeHtml(result),true):''}
      ${detailItem('Müqavilə və modem sənədləri',linksHtml,true)}
    </div>`;
  const whatsapp=phoneHref(phone);const archived=boolArchive(row.arxiv);const historyCount=Array.isArray(row.history)?row.history.length:0;
  if(actions)actions.innerHTML=`
    <a class="edit" href="/edit/${encodeURIComponent(row.odeme_kodu||'')}"><i class="fa-solid fa-pen"></i> Redaktə</a>
    <button type="button" data-action="history"><i class="fa-solid fa-clock-rotate-left"></i> Tarixçə${historyCount?` (${historyCount})`:''}</button>
    <button class="archive" type="button" data-action="archive"><i class="fa-solid ${archived?'fa-box-open':'fa-box-archive'}"></i> ${archived?'Arxivdən çıxar':'Arxivlə'}</button>
    <button class="delete" type="button" data-action="delete"><i class="fa-solid fa-trash"></i> Sil</button>
    ${whatsapp?`<a href="https://wa.me/${whatsapp}" target="_blank" rel="noopener"><i class="fa-brands fa-whatsapp"></i> WhatsApp</a>`:''}`;
}
function renderHistory(row){
  const list=$('#historyList');if(!list)return;const history=Array.isArray(row?.history)?[...row.history].reverse():[];
  if(!history.length){list.innerHTML='<div class="empty-state"><i class="fa-solid fa-clock-rotate-left"></i><strong>Tarixçə boşdur</strong><span>Bu müştəri üzrə fəaliyyət qeydi yoxdur.</span></div>';return;}
  list.innerHTML=history.map(item=>`<article class="history-item"><span class="history-icon"><i class="fa-solid fa-clock"></i></span><time>${escapeHtml(formatDate(item.date))}</time><strong>${escapeHtml(item.event||'Hadisə')}</strong>${item.note?`<p>${escapeHtml(item.note)}</p>`:''}</article>`).join('');
}
async function archiveCurrent(){
  const row=state.currentCustomer;if(!row)return;const archive=!boolArchive(row.arxiv);if(!confirm(archive?'Müştərini arxivə göndərmək istəyirsiniz?':'Müştərini arxivdən çıxarmaq istəyirsiniz?'))return;
  try{await requestJson(`/archive/${encodeURIComponent(row.id||row.odeme_kodu)}`,{method:'POST',body:JSON.stringify({archive,odemeKodu:row.odeme_kodu})});showToast(archive?'Müştəri arxivləndi.':'Müştəri arxivdən çıxarıldı.');closeCustomerDrawer();setTimeout(()=>window.location.reload(),450);}catch(error){showToast(error.message,true);}
}
async function deleteCurrent(){
  const row=state.currentCustomer;if(!row)return;if(!confirm(`${row.ad_soyad||'Bu müştəri'} birdəfəlik silinsin? Bu əməliyyatı geri qaytarmaq mümkün deyil.`))return;
  try{await requestJson(`/delete/${encodeURIComponent(row.id||row.odeme_kodu)}`,{method:'POST',body:JSON.stringify({odemeKodu:row.odeme_kodu})});showToast('Müştəri silindi.');closeCustomerDrawer();setTimeout(()=>window.location.reload(),450);}catch(error){showToast(error.message,true);}
}

const listConfig={
  all:{title:'Bütün müştərilər',subtitle:'Aktiv müştəri bazası',endpoint:'/api/all-customers'},
  today:{title:'Bu gün əlavə edilənlər',subtitle:'Bugünkü əməliyyatlar',endpoint:'/api/today-customers'},
  archive:{title:'Arxivdə olanlar',subtitle:'Arxiv statuslu müştərilər',endpoint:'/api/archive-customers'},
  problem:{title:'Problemlər',subtitle:'Problem qeydli müştərilər',endpoint:'/api/problem-customers'}
};
async function openList(type='all',page=1){
  const conf=listConfig[type]||listConfig.all;state.listType=type;state.listPage=page;
  $('#customerListTitle').textContent=conf.title;$('#customerListSubtitle').textContent=conf.subtitle;$('#customerListSearch').value='';
  openModal('customerListModal');const container=$('#customerList');container.innerHTML='<div class="loading"><div class="spinner"></div>Siyahı yüklənir...</div>';
  try{const payload=await requestJson(`${conf.endpoint}?page=${page}&limit=10`);state.listRows=payload.customers||payload.data||[];state.listPages=payload.totalPages||1;renderList(state.listRows);renderListPager(payload.currentPage||page,state.listPages,payload.totalCustomers||state.listRows.length);}catch(error){container.innerHTML=`<div class="empty-state"><i class="fa-solid fa-circle-exclamation"></i><strong>Siyahı yüklənmədi</strong><span>${escapeHtml(error.message)}</span></div>`;}
}
function renderList(rows){const container=$('#customerList');if(!container)return;if(!rows.length){container.innerHTML='<div class="empty-state"><i class="fa-solid fa-users-slash"></i><strong>Müştəri tapılmadı</strong><span>Bu bölmədə göstəriləcək məlumat yoxdur.</span></div>';return;}container.innerHTML=rows.map(row=>{const type=customerType(row);return`<article class="modal-list-item" data-customer-code="${escapeHtml(row.odeme_kodu||'')}"><div><strong>${escapeHtml(row.ad_soyad||'Adsız müştəri')}</strong><span>${escapeHtml(row.odeme_kodu||'-')} · ${escapeHtml(row.telefon||'-')} · ${escapeHtml(row.unvan||'-')}</span></div><span class="type-badge ${type.className}">${type.label}</span></article>`;}).join('');}
function renderListPager(page,pages,total){$('#customerListCounter').textContent=`${total} müştəri · ${page}/${pages}`;$('#listPrev').disabled=page<=1;$('#listNext').disabled=page>=pages;}
function filterList(term){const q=String(term||'').trim().toLowerCase().replace(/\s/g,'');if(!q)return renderList(state.listRows);renderList(state.listRows.filter(row=>[row.ad_soyad,row.odeme_kodu,row.telefon,row.unvan,row.modem].some(value=>String(value||'').toLowerCase().replace(/\s/g,'').includes(q))));}

function initChart(){
  if(typeof Chart==='undefined')return;const canvas=$('#monthlyChart'),data=cfg.chartData;if(!canvas||!data||!Array.isArray(data.labels)||!data.labels.length)return;
  const colors={total:'#60a5fa',qosulma:'#34d399',kocurme:'#f59e0b',problem:'#fb7185'};
  const labels={total:'Ümumi',qosulma:'Qoşulma',kocurme:'Köçürmə',problem:'Problemlər'};
  const ctx=canvas.getContext('2d');state.chart=new Chart(ctx,{type:'line',data:{labels:data.labels,datasets:[{label:labels.total,data:data.total||[],borderColor:colors.total,backgroundColor:'rgba(96,165,250,.12)',fill:true,tension:.35,borderWidth:2,pointRadius:3,pointHoverRadius:5}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{backgroundColor:'#07162e',borderColor:'rgba(148,163,184,.24)',borderWidth:1,titleColor:'#fff',bodyColor:'#cbd5e1'}},scales:{x:{grid:{display:false},ticks:{color:'#7185a2',font:{size:10}}},y:{beginAtZero:true,grid:{color:'rgba(148,163,184,.09)'},ticks:{precision:0,color:'#7185a2',font:{size:10}}}}}});
  $$('.chart-switch button').forEach(button=>button.addEventListener('click',()=>switchChart(button.dataset.chartType,colors,labels)));
}
function switchChart(type,colors,labels){if(!state.chart||!cfg.chartData?.[type])return;state.chartType=type;state.chart.data.datasets[0].data=cfg.chartData[type];state.chart.data.datasets[0].label=labels[type];state.chart.data.datasets[0].borderColor=colors[type];state.chart.data.datasets[0].backgroundColor=colors[type].replace(')',',.12)').replace('rgb','rgba');state.chart.update();$$('.chart-switch button').forEach(btn=>btn.classList.toggle('active',btn.dataset.chartType===type));}

function openModemSearch(){openModal('modemSearchModal');const input=$('#modemSearchInput');setTimeout(()=>input?.focus(),80);}
async function modemSearch(term){const container=$('#modemSearchResults');const q=String(term||'').trim();if(q.length<2){container.innerHTML='<div class="empty-state"><i class="fa-solid fa-router"></i><strong>Modem S/N yazın</strong><span>Axtarış üçün ən azı 2 simvol daxil edin.</span></div>';return;}container.innerHTML='<div class="loading"><div class="spinner"></div>Axtarılır...</div>';try{const data=await requestJson(`/api/modem-search?sn=${encodeURIComponent(q)}`);const rows=data.customers||[];if(!rows.length){container.innerHTML='<div class="empty-state"><i class="fa-solid fa-magnifying-glass"></i><strong>Nəticə yoxdur</strong><span>Bu S/N üzrə müştəri tapılmadı.</span></div>';return;}container.innerHTML=rows.map(row=>`<article class="modal-list-item" data-customer-code="${escapeHtml(row.odeme_kodu||'')}"><div><strong>${escapeHtml(row.ad_soyad||'Adsız müştəri')}</strong><span>${escapeHtml(row.modem||'-')} · ${escapeHtml(row.odeme_kodu||'-')} · ${escapeHtml(row.telefon||'-')}</span></div><i class="fa-solid fa-chevron-right"></i></article>`).join('');}catch(error){container.innerHTML=`<div class="empty-state"><i class="fa-solid fa-circle-exclamation"></i><strong>Axtarış alınmadı</strong><span>${escapeHtml(error.message)}</span></div>`;}}

function bindEvents(){
  $('#mobileMenu')?.addEventListener('click',openSidebar);$('#sidebarBackdrop')?.addEventListener('click',closeSidebar);
  $$('[data-close-modal]').forEach(button=>button.addEventListener('click',()=>closeModal(button.dataset.closeModal)));
  $$('.modal-wrap').forEach(wrap=>wrap.addEventListener('click',event=>{if(event.target===wrap)closeModal(wrap.id);}));
  $('#customerDrawerClose')?.addEventListener('click',closeCustomerDrawer);$('#customerDrawerOverlay')?.addEventListener('click',event=>{if(event.target.id==='customerDrawerOverlay')closeCustomerDrawer();});
  $$('[data-customer-code]').forEach(el=>el.addEventListener('click',()=>openCustomer(el.dataset.customerCode)));
  $$('[data-list-type]').forEach(el=>el.addEventListener('click',()=>openList(el.dataset.listType,1)));
  $('#customerList')?.addEventListener('click',event=>{const row=event.target.closest('[data-customer-code]');if(!row)return;closeModal('customerListModal');openCustomer(row.dataset.customerCode);});
  $('#customerListSearch')?.addEventListener('input',event=>filterList(event.target.value));
  $('#listPrev')?.addEventListener('click',()=>openList(state.listType,Math.max(1,state.listPage-1)));$('#listNext')?.addEventListener('click',()=>openList(state.listType,Math.min(state.listPages,state.listPage+1)));
  $('#customerDrawerActions')?.addEventListener('click',event=>{const action=event.target.closest('[data-action]')?.dataset.action;if(action==='history'){renderHistory(state.currentCustomer);openModal('historyModal');}if(action==='archive')archiveCurrent();if(action==='delete')deleteCurrent();});
  $('#modemSearchOpen')?.addEventListener('click',openModemSearch);$('#modemNavOpen')?.addEventListener('click',()=>{closeSidebar();openModemSearch();});
  $('#modemSearchInput')?.addEventListener('input',event=>{clearTimeout(state.modemTimer);state.modemTimer=setTimeout(()=>modemSearch(event.target.value),320);});
  $('#modemSearchResults')?.addEventListener('click',event=>{const row=event.target.closest('[data-customer-code]');if(!row)return;closeModal('modemSearchModal');openCustomer(row.dataset.customerCode);});
  document.addEventListener('keydown',event=>{if(event.key==='Escape')closeAll();});
}

document.addEventListener('DOMContentLoaded',()=>{bindEvents();initChart();});
})();
