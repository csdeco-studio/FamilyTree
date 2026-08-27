(() => {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];
  const canvas = $('#canvas');
  const frameLayer = $('#frameLayer');
  const relationLayer = $('#relationLayer');
  const nodeLayer = $('#nodeLayer');
  const textLayer = $('#textLayer');
  const metaLayer = $('#metaLayer');
  const selectionLayer = $('#selectionLayer');
  const inspector = $('#inspector');
  const statusText = $('#statusText');
  const toast = $('#toast');

  const GRID_SIZE = 20;
  const APP_VERSION = '5.1.0';
  const BUILD_DATE = '2026-07-28';
  const EXPORT_PADDING = 70;

  const defaultState = () => ({
    version: 5.1,
    nodes: [],
    relations: [],
    frames: [],
    texts: [],
    meta: {title:'家系圖', subtitle:'', showRiskMarkers:true, snapToGrid:true, gridSize:GRID_SIZE, anonymize:false, anonymizeMode:'code', anonymizeHideNotes:true, touchLongPress:true, nudgeStep:2},
    selected: null,
    zoom: 1,
    panX: 0,
    panY: 0
  });

  let state = defaultState();
  let history = [];
  let future = [];
  let drag = null;
  let pan = null;
  let toastTimer = null;
  let persistTimer = null;
  let touchPending = null;

  const uid = (prefix) => prefix + '_' + Math.random().toString(36).slice(2, 9);
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const gridSize = () => Number(state.meta?.gridSize) || GRID_SIZE;
  const isGridEnabled = () => state.meta?.snapToGrid !== false;
  const snapValue = value => isGridEnabled() ? Math.round(Number(value) / gridSize()) * gridSize() : Number(value);
  const snapPoint = (x,y) => ({x:snapValue(x),y:snapValue(y)});
  const esc = (s='') => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const lossTypeName = type => ({miscarriage:'自然流產',abortion:'人工流產',stillbirth:'死產',unknown:'流產／死產'}[type] || '流產／死產');
  const sexName = sex => ({male:'男性',female:'女性',unknown:'性別未明',pregnancy:'懷孕',loss:'流產／死產'}[sex] || '成員');
  const nodeLabel = n => {
    const stage = n.sex==='pregnancy' ? (n.gestationWeeks ? `孕${n.gestationWeeks}週` : '懷孕') : n.sex==='loss' ? lossTypeName(n.lossType) : (n.age ? `${n.age}歲` : '');
    return [n.name || '', stage, n.note || ''].filter(Boolean).join('／') || `${sexName(n.sex)}成員`;
  };

  const alphaCode = index => {
    let n=index+1,s='';
    while(n>0){n--;s=String.fromCharCode(65+(n%26))+s;n=Math.floor(n/26);}
    return s;
  };
  const sexShort = sex => ({male:'男',female:'女',unknown:'人',pregnancy:'孕',loss:'胎'}[sex]||'人');
  function displayNodeName(n){
    if(!state.meta?.anonymize) return n.name||'';
    if(state.meta.anonymizeMode==='hide') return '';
    const idx=Math.max(0,state.nodes.findIndex(x=>x.id===n.id));
    return `${alphaCode(idx)}${sexShort(n.sex)}`;
  }
  function displayNodeNote(n){
    return state.meta?.anonymize && state.meta?.anonymizeHideNotes!==false ? '' : (n.note||'');
  }
  function schedulePersist(){
    clearTimeout(persistTimer);
    persistTimer=setTimeout(persist,180);
  }


  function normalizeRelation(r){
    return {
      id:r.id || uid('r'), from:r.from, to:r.to, type:r.type || 'partner',
      status:r.status || 'married', subtype:r.subtype || (r.type==='parent'?'biological':''),
      label:r.label || '', unionId:r.unionId || '', routing:r.routing || ((r.points||[]).length?'manual':'auto'),
      points:Array.isArray(r.points)?r.points.map(p=>({x:Number(p.x)||0,y:Number(p.y)||0})):[]
    };
  }

  function normalizeState(data={}){
    const base=defaultState();
    return {
      ...base, ...data, version:5.1, selected:null,
      nodes:(data.nodes||[]).map(normalizeNode),
      relations:(data.relations||[]).map(normalizeRelation),
      frames:(data.frames||[]).map(f=>({id:f.id||uid('f'),x:Number(f.x??420),y:Number(f.y??240),width:Number(f.width??560),height:Number(f.height??360),label:f.label||'同住／家庭範圍',dashed:!!f.dashed,rounded:f.rounded!==false})),
      texts:(data.texts||[]).map(t=>({id:t.id||uid('t'),x:Number(t.x??700),y:Number(t.y??150),text:t.text||'文字說明',fontSize:Number(t.fontSize??22),bold:!!t.bold})),
      meta:{...base.meta,...(data.meta||{}),gridSize:GRID_SIZE}
    };
  }

  function snapshot(){
    history.push(JSON.stringify({...state, selected:null}));
    if(history.length > 80) history.shift();
    future = [];
  }

  function undo(){
    if(!history.length) return showToast('沒有可復原的動作');
    future.push(JSON.stringify({...state, selected:null}));
    state = JSON.parse(history.pop());
    render(); persist();
  }

  function redo(){
    if(!future.length) return showToast('沒有可重做的動作');
    history.push(JSON.stringify({...state, selected:null}));
    state = JSON.parse(future.pop());
    render(); persist();
  }

  function persist(){
    try{ localStorage.setItem('genogram-builder-state', JSON.stringify({...state, selected:null})); }catch(e){}
  }

  function restore(){
    let sourceVersion=0;
    try{
      const raw = localStorage.getItem('genogram-builder-state');
      if(raw){
        const parsed = JSON.parse(raw);
        sourceVersion=Number(parsed?.version)||0;
        if(parsed && parsed.nodes) state = normalizeState(parsed);
      }
    }catch(e){}
    return sourceVersion;
  }

  function showToast(msg){
    clearTimeout(toastTimer);
    toast.textContent = msg;
    toast.classList.add('show');
    toastTimer = setTimeout(() => toast.classList.remove('show'), 1800);
  }

  function svgEl(name, attrs={}){
    const el = document.createElementNS(SVG_NS, name);
    Object.entries(attrs).forEach(([k,v]) => {
      if(v !== undefined && v !== null) el.setAttribute(k, v);
    });
    return el;
  }

  function getSvgPoint(evt){
    const pt = canvas.createSVGPoint();
    pt.x = evt.clientX; pt.y = evt.clientY;
    const ctm = canvas.getScreenCTM();
    return pt.matrixTransform(ctm.inverse());
  }

  function normalizeNode(n){
    return {
      id:n.id || uid('n'),
      name:n.name || '',
      sex:n.sex || 'unknown',
      age:n.age || '',
      deceased:!!n.deceased,
      proband:!!n.proband,
      risk:!!n.risk,
      riskNote:n.riskNote || '',
      lossType:n.lossType || 'unknown',
      gestationWeeks:n.gestationWeeks || '',
      note:n.note || '',
      fillColor:n.fillColor || '',
      x:Number(n.x ?? 700),
      y:Number(n.y ?? 450),
      size:Number(n.size ?? 58)
    };
  }

  function addNode(sex='unknown', props={}){
    snapshot();
    const n = normalizeNode({sex, x:700, y:450, ...props});
    state.nodes.push(n);
    state.selected = {kind:'node', id:n.id};
    render(); persist();
    return n;
  }

  function addFrame(){
    snapshot();
    const f = {id:uid('f'), x:420, y:240, width:560, height:360, label:'同住／家庭範圍', dashed:false, rounded:true};
    state.frames.push(f);
    state.selected = {kind:'frame', id:f.id};
    render(); persist();
  }

  function addText(){
    snapshot();
    const t = {id:uid('t'), x:700, y:150, text:'文字說明', fontSize:22, bold:false};
    state.texts.push(t);
    state.selected = {kind:'text', id:t.id};
    render(); persist();
  }

  function addRelation(from, to, type='partner', opts={}){
    if(!from || !to || from === to) return;
    const r = {
      id:uid('r'), from, to, type,
      status:opts.status || 'married',
      subtype:opts.subtype || (type==='parent'?'biological':''),
      label:opts.label || '', unionId:opts.unionId || '', routing:'auto', points:[]
    };
    state.relations.push(r);
    state.selected = {kind:'relation', id:r.id};
    return r;
  }

  function getNode(id){ return state.nodes.find(n => n.id === id); }
  function getRelation(id){ return state.relations.find(r => r.id === id); }
  function getFrame(id){ return state.frames.find(f => f.id === id); }
  function getText(id){ return state.texts.find(t => t.id === id); }

  function updateGridVisual(){
    const enabled=isGridEnabled();
    const bg=$('#gridBackground');
    const pattern=$('#gridPattern');
    if(pattern){ pattern.setAttribute('width',gridSize()); pattern.setAttribute('height',gridSize()); }
    if(bg) bg.style.display=enabled?'':'none';
    const toggle=$('#gridToggleBtn');
    if(toggle){
      toggle.textContent=enabled?'網格：開':'網格：關';
      toggle.setAttribute('aria-pressed',String(enabled));
      toggle.classList.toggle('toggle-on',enabled);
    }
    const checkbox=$('#snapToGrid');
    if(checkbox) checkbox.checked=enabled;
    $('#gridSettingCard')?.classList.toggle('enabled',enabled);
  }

  function snapAllObjects(){
    const size=gridSize();
    state.nodes.forEach(n=>{n.x=Math.round(n.x/size)*size;n.y=Math.round(n.y/size)*size;});
    state.texts.forEach(t=>{t.x=Math.round(t.x/size)*size;t.y=Math.round(t.y/size)*size;});
    state.frames.forEach(f=>{
      f.x=Math.round(f.x/size)*size; f.y=Math.round(f.y/size)*size;
      f.width=Math.max(120,Math.round(f.width/size)*size);
      f.height=Math.max(80,Math.round(f.height/size)*size);
    });
  }

  function alignAllToGrid(withSnapshot=true){
    if(withSnapshot) snapshot();
    snapAllObjects();
    render();persist();
    if(withSnapshot) showToast('已將現有物件對齊 20px 網格');
  }

  function setGridEnabled(enabled){
    snapshot();
    state.meta={...(state.meta||{}),snapToGrid:!!enabled,gridSize:GRID_SIZE};
    if(enabled) snapAllObjects();
    render();persist();
    showToast(enabled?'已開啟 20px 網格吸附':'已關閉網格吸附');
  }

  function render(skipInspector=false){
    frameLayer.innerHTML = '';
    relationLayer.innerHTML = '';
    nodeLayer.innerHTML = '';
    textLayer.innerHTML = '';
    metaLayer.innerHTML = '';
    selectionLayer.innerHTML = '';

    state.frames.forEach(drawFrame);
    drawAllRelations();
    state.nodes.forEach(drawNode);
    state.texts.forEach(drawText);
    drawMetaLayer();
    drawSelection();
    updateGridVisual();
    if(!skipInspector) renderInspector();
    updateStatus();
  }

  function drawFrame(f){
    const g = svgEl('g', {'data-kind':'frame','data-id':f.id, class:'draggable'});
    const rect = svgEl('rect', {
      x:f.x,y:f.y,width:f.width,height:f.height,rx:f.rounded?24:0,
      fill:'none',stroke:'#111','stroke-width':2.2,'stroke-dasharray':f.dashed?'9 6':''
    });
    const labelBg = svgEl('rect', {x:f.x+12,y:f.y-14,width:Math.max(92,(f.label||'').length*17),height:28,rx:7,fill:'#fff'});
    const label = svgEl('text', {x:f.x+20,y:f.y+6,'font-size':17,'font-weight':600,fill:'#111'});
    label.textContent = f.label || '外框';
    g.append(rect,labelBg,label);
    g.addEventListener('pointerdown', startDrag);
    g.addEventListener('click', selectFromEvent);
    frameLayer.appendChild(g);
  }

  function nodeEdgePoint(n, toward){
    const dx = toward.x - n.x;
    const dy = toward.y - n.y;
    const len = Math.hypot(dx,dy) || 1;
    const r = n.size/2 + 2;
    if(n.sex === 'male'){
      const scale = r / Math.max(Math.abs(dx), Math.abs(dy), 1);
      return {x:n.x + dx*scale, y:n.y + dy*scale};
    }
    return {x:n.x + dx/len*r, y:n.y + dy/len*r};
  }


  function getObstacleRects(excludeIds=[]){
    const excluded=new Set(excludeIds);
    return state.nodes.filter(n=>!excluded.has(n.id)).map(n=>{
      const pad=18,r=n.size/2+pad;
      return {x1:n.x-r,y1:n.y-r,x2:n.x+r,y2:n.y+r};
    });
  }
  function pointInRect(p,r){return p.x>r.x1&&p.x<r.x2&&p.y>r.y1&&p.y<r.y2}
  function orient(a,b,c){return Math.sign((b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x))}
  function onSegment(a,b,p){return Math.min(a.x,b.x)<=p.x&&p.x<=Math.max(a.x,b.x)&&Math.min(a.y,b.y)<=p.y&&p.y<=Math.max(a.y,b.y)}
  function segmentsIntersect(a,b,c,d){
    const o1=orient(a,b,c),o2=orient(a,b,d),o3=orient(c,d,a),o4=orient(c,d,b);
    if(o1!==o2&&o3!==o4) return true;
    return (!o1&&onSegment(a,b,c))||(!o2&&onSegment(a,b,d))||(!o3&&onSegment(c,d,a))||(!o4&&onSegment(c,d,b));
  }
  function segmentHitsRect(a,b,r){
    if(pointInRect(a,r)||pointInRect(b,r)) return true;
    const tl={x:r.x1,y:r.y1},tr={x:r.x2,y:r.y1},br={x:r.x2,y:r.y2},bl={x:r.x1,y:r.y2};
    return segmentsIntersect(a,b,tl,tr)||segmentsIntersect(a,b,tr,br)||segmentsIntersect(a,b,br,bl)||segmentsIntersect(a,b,bl,tl);
  }
  function compactRoute(points){
    const out=[];
    points.forEach(p=>{
      const last=out[out.length-1];
      if(!last||Math.abs(last.x-p.x)>.01||Math.abs(last.y-p.y)>.01) out.push({x:p.x,y:p.y});
    });
    for(let i=out.length-2;i>0;i--){
      const a=out[i-1],b=out[i],c=out[i+1];
      if((Math.abs(a.x-b.x)<.01&&Math.abs(b.x-c.x)<.01)||(Math.abs(a.y-b.y)<.01&&Math.abs(b.y-c.y)<.01)) out.splice(i,1);
    }
    return out;
  }
  function routeScore(points,obstacles){
    let length=0,hits=0;
    for(let i=1;i<points.length;i++){
      const a=points[i-1],b=points[i];length+=Math.hypot(b.x-a.x,b.y-a.y);
      obstacles.forEach(r=>{if(segmentHitsRect(a,b,r))hits++;});
    }
    return length+(points.length-2)*18+hits*100000;
  }
  function autoRoute(p1,p2,excludeIds=[]){
    const obstacles=getObstacleRects(excludeIds);
    const mx=(p1.x+p2.x)/2,my=(p1.y+p2.y)/2;
    const allX=[p1.x,p2.x,...obstacles.flatMap(r=>[r.x1,r.x2])];
    const allY=[p1.y,p2.y,...obstacles.flatMap(r=>[r.y1,r.y2])];
    const minX=Math.min(...allX)-42,maxX=Math.max(...allX)+42,minY=Math.min(...allY)-42,maxY=Math.max(...allY)+42;
    const candidates=[
      [p1,{x:p2.x,y:p1.y},p2],
      [p1,{x:p1.x,y:p2.y},p2],
      [p1,{x:mx,y:p1.y},{x:mx,y:p2.y},p2],
      [p1,{x:p1.x,y:my},{x:p2.x,y:my},p2],
      [p1,{x:p1.x,y:minY},{x:p2.x,y:minY},p2],
      [p1,{x:p1.x,y:maxY},{x:p2.x,y:maxY},p2],
      [p1,{x:minX,y:p1.y},{x:minX,y:p2.y},p2],
      [p1,{x:maxX,y:p1.y},{x:maxX,y:p2.y},p2]
    ].map(compactRoute);
    if(Math.abs(p1.x-p2.x)<3||Math.abs(p1.y-p2.y)<3)candidates.unshift(compactRoute([p1,p2]));
    return candidates.sort((a,b)=>routeScore(a,obstacles)-routeScore(b,obstacles))[0];
  }
  function relationRoutePoints(r,p1,p2,excludeIds=[]){
    if(r.routing==='manual'&&Array.isArray(r.points)&&r.points.length) return compactRoute([p1,...r.points,p2]);
    return autoRoute(p1,p2,excludeIds);
  }
  function partnerRoutePoints(r,a,b,p1,p2){
    if(r.routing==='manual'&&Array.isArray(r.points)&&r.points.length)return compactRoute([p1,...r.points,p2]);
    const obstacles=getObstacleRects([a.id,b.id]);
    const direct=compactRoute([p1,p2]);
    if(routeScore(direct,obstacles)<100000)return direct;
    // 多次婚配時以同世代附近的平行線繞過中間配偶，避免路線跑到整張圖的最上／最下方。
    const up=a.y-72,down=a.y+72;
    const candidates=[
      compactRoute([p1,{x:p1.x,y:up},{x:p2.x,y:up},p2]),
      compactRoute([p1,{x:p1.x,y:down},{x:p2.x,y:down},p2]),
      compactRoute([p1,{x:p1.x,y:a.y-108},{x:p2.x,y:a.y-108},p2]),
      compactRoute([p1,{x:p1.x,y:a.y+108},{x:p2.x,y:a.y+108},p2])
    ];
    return candidates.sort((x,y)=>routeScore(x,obstacles)-routeScore(y,obstacles))[0];
  }
  const routePathD=points=>points.map((p,i)=>`${i?'L':'M'} ${p.x} ${p.y}`).join(' ');
  function pointOnRoute(points,t=.5){
    const segs=[];let total=0;
    for(let i=1;i<points.length;i++){const len=Math.hypot(points[i].x-points[i-1].x,points[i].y-points[i-1].y);segs.push(len);total+=len;}
    let target=total*t;
    for(let i=0;i<segs.length;i++){
      if(target<=segs[i]||i===segs.length-1){const q=segs[i]?target/segs[i]:0,a=points[i],b=points[i+1];return {x:a.x+(b.x-a.x)*q,y:a.y+(b.y-a.y)*q,angle:Math.atan2(b.y-a.y,b.x-a.x)};}
      target-=segs[i];
    }
    return {...points[0],angle:0};
  }

  function drawAllRelations(){
    // 先畫伴侶與情感關係，再畫由婚姻線中點向下延伸的親子結構線。
    state.relations.filter(r=>r.type!=='parent').forEach(drawRelation);
    drawParentFamilyConnections();
  }

  function findPartnerRelation(aId,bId){
    return state.relations.find(r=>r.type==='partner'&&((r.from===aId&&r.to===bId)||(r.from===bId&&r.to===aId)));
  }

  function partnerUnionAnchor(a,b,relationOverride=null){
    const relation=relationOverride||findPartnerRelation(a.id,b.id);
    if(!relation) return {x:(a.x+b.x)/2,y:(a.y+b.y)/2};
    const p1=nodeEdgePoint(a,b),p2=nodeEdgePoint(b,a);
    const route=partnerRoutePoints(relation,a,b,p1,p2);
    // 子女必須從該段婚姻線的水平中點向下，而不是用整條折線的路徑長度中點。
    // 多次婚配需要繞開其他配偶時，優先取最長的水平婚姻線段作為家庭聯結點。
    const horizontal=[];
    for(let i=1;i<route.length;i++){
      const p=route[i-1],q=route[i];
      if(Math.abs(p.y-q.y)<1){
        horizontal.push({x:(p.x+q.x)/2,y:p.y,length:Math.abs(q.x-p.x)});
      }
    }
    if(horizontal.length){
      horizontal.sort((x,y)=>y.length-x.length);
      return {x:horizontal[0].x,y:horizontal[0].y};
    }
    const anchor=pointOnRoute(route,.5);
    return {x:anchor.x,y:anchor.y};
  }

  function birthOrderScore(n){
    const name=n?.name||'';
    const map=[['長',1],['大',1],['次',2],['二',2],['三',3],['四',4],['五',5],['六',6],['七',7],['八',8],['九',9],['么',10]];
    for(const [key,value] of map){if(name.startsWith(key))return value;}
    const age=Number(n?.age);
    return Number.isFinite(age)&&age>0 ? 100-age/1000 : 500;
  }

  function repairMissingCoParentsByGeometry(){
    const byChild=new Map();
    state.relations.filter(r=>r.type==='parent').forEach(r=>{
      if(!byChild.has(r.to))byChild.set(r.to,[]);
      byChild.get(r.to).push(r);
    });
    let repaired=0;
    byChild.forEach((rels,childId)=>{
      if(rels.length!==1)return;
      const child=getNode(childId),primary=getNode(rels[0].from);
      if(!child||!primary)return;
      const partnerLinks=state.relations.filter(r=>r.type==='partner'&&(r.from===primary.id||r.to===primary.id));
      const candidates=partnerLinks.map(union=>({
        union,
        partner:getNode(union.from===primary.id?union.to:union.from)
      })).filter(x=>x.partner);
      if(!candidates.length)return;
      let chosen=null;
      if(candidates.length===1){
        chosen=candidates[0];
      }else{
        // 僅在多任配偶已有明確「第N任」名稱，且孩子原位置明顯落在某段婚姻線下方時才推定。
        if(!candidates.every(x=>/^第[一二三四五六七八九十\d]+任配偶$/.test(x.partner.name||'')))return;
        const scored=candidates.map(x=>{
          const unionMidX=(primary.x+x.partner.x)/2;
          const horizontal=Math.abs(child.x-unionMidX);
          const vertical=Math.max(0,child.y-Math.max(primary.y,x.partner.y));
          return {...x,score:horizontal+vertical*.12};
        }).sort((a,b)=>a.score-b.score);
        if(scored.length===1||scored[0].score+35<scored[1].score||scored[0].score<scored[1].score*.7)chosen=scored[0];
      }
      if(!chosen)return;
      rels[0].unionId=chosen.union.id;
      state.relations.push(normalizeRelation({
        id:uid('r'),from:chosen.partner.id,to:child.id,type:'parent',subtype:rels[0].subtype||'biological',unionId:chosen.union.id,label:''
      }));
      repaired++;
    });
    return repaired;
  }

  function inferParentUnionIds(){
    const byChild=new Map();
    state.relations.filter(r=>r.type==='parent').forEach(r=>{
      if(!byChild.has(r.to))byChild.set(r.to,[]);
      byChild.get(r.to).push(r);
    });
    let repaired=0;
    byChild.forEach(rels=>{
      const explicit=rels.find(r=>r.unionId&&getRelation(r.unionId)?.type==='partner')?.unionId;
      if(explicit){
        const union=getRelation(explicit);
        const endpoints=new Set(union?[union.from,union.to]:[]);
        rels.forEach(r=>{if(!r.unionId&&endpoints.has(r.from)){r.unionId=explicit;repaired++;}});
        return;
      }
      const parentIds=[...new Set(rels.map(r=>r.from))];
      if(parentIds.length===2){
        const union=findPartnerRelation(parentIds[0],parentIds[1]);
        if(union)rels.forEach(r=>{r.unionId=union.id;repaired++;});
      }
    });
    return repaired;
  }

  function parentFamilyGroups(){
    const byChild=new Map();
    state.relations.filter(r=>r.type==='parent').forEach(r=>{
      if(!byChild.has(r.to))byChild.set(r.to,[]);
      byChild.get(r.to).push(r);
    });
    const groups=new Map();
    byChild.forEach((rels,childId)=>{
      const child=getNode(childId);if(!child)return;
      const explicitUnionId=rels.map(r=>r.unionId).find(id=>id&&getRelation(id)?.type==='partner')||'';
      let parents=[],union=null,key='';
      if(explicitUnionId){
        union=getRelation(explicitUnionId);
        parents=[getNode(union.from),getNode(union.to)].filter(Boolean);
        key=`union:${explicitUnionId}`;
      }else{
        const uniqueParents=[...new Set(rels.map(r=>r.from))].map(getNode).filter(Boolean);
        if(!uniqueParents.length)return;
        parents=uniqueParents.slice(0,2);
        if(uniqueParents.length>1){
          outer:for(let i=0;i<uniqueParents.length;i++)for(let j=i+1;j<uniqueParents.length;j++){
            const candidate=findPartnerRelation(uniqueParents[i].id,uniqueParents[j].id);
            if(candidate){parents=[uniqueParents[i],uniqueParents[j]];union=candidate;break outer;}
          }
        }
        parents.sort((a,b)=>a.id.localeCompare(b.id));
        key=union?`union:${union.id}`:`parents:${parents.map(p=>p.id).join('|')}`;
      }
      if(!parents.length)return;
      if(!groups.has(key))groups.set(key,{key,parents,union,children:[]});
      const relevant=rels.filter(r=>parents.some(p=>p.id===r.from));
      groups.get(key).children.push({node:child,relations:relevant});
    });
    return [...groups.values()];
  }

  function familyLineStyle(childInfo){
    const subtype=childInfo.relations.find(r=>r.subtype&&r.subtype!=='biological')?.subtype||'biological';
    return {subtype,dash:subtype==='adopted'?'9 6':subtype==='foster'?'3 6':''};
  }

  function relationClickableGroup(id){
    const g=svgEl('g',{'data-kind':'relation','data-id':id});
    g.addEventListener('click',selectFromEvent);
    return g;
  }

  function drawParentFamilyConnections(){
    parentFamilyGroups().forEach(group=>{
      const children=[...group.children].sort((a,b)=>birthOrderScore(a.node)-birthOrderScore(b.node)||Number(b.node.age||0)-Number(a.node.age||0)||a.node.x-b.node.x);
      if(!children.length)return;
      const parents=group.parents;
      let source;
      if(parents.length>=2) source=partnerUnionAnchor(parents[0],parents[1],group.union);
      else source={x:parents[0].x,y:parents[0].y+parents[0].size/2+2};
      const endpoints=children.map(c=>({x:c.node.x,y:c.node.y-c.node.size/2-2,info:c}));
      const nearestTop=Math.min(...endpoints.map(p=>p.y));
      const available=Math.max(90,nearestTop-source.y);
      const rawSiblingY=Math.min(nearestTop-52,source.y+Math.max(62,available*.46));
      const siblingY=isGridEnabled()?snapValue(rawSiblingY):rawSiblingY;
      const representative=children[0].relations[0];
      if(!representative)return;

      // 共同主幹與手足線：父母婚姻線中點向下，手足由左至右排列。
      if(endpoints.length>1){
        const shared=relationClickableGroup(representative.id);
        const minX=Math.min(source.x,...endpoints.map(p=>p.x));
        const maxX=Math.max(source.x,...endpoints.map(p=>p.x));
        const sharedD=`M ${source.x} ${source.y} V ${siblingY} M ${minX} ${siblingY} H ${maxX}`;
        shared.appendChild(svgEl('path',{d:sharedD,fill:'none',stroke:'#111','stroke-width':2.2,'stroke-linejoin':'round'}));
        shared.appendChild(svgEl('path',{d:sharedD,fill:'none',stroke:'transparent','stroke-width':20}));
        relationLayer.appendChild(shared);
      }

      endpoints.forEach((p,index)=>{
        const representativeRel=p.info.relations[0]||representative;
        const style=familyLineStyle(p.info);
        const branch=relationClickableGroup(representativeRel.id);
        const d=endpoints.length===1
          ? (Math.abs(p.x-source.x)<1?`M ${source.x} ${source.y} V ${p.y}`:`M ${source.x} ${source.y} V ${siblingY} H ${p.x} V ${p.y}`)
          : `M ${p.x} ${siblingY} V ${p.y}`;
        branch.appendChild(svgEl('path',{d,fill:'none',stroke:'#111','stroke-width':2.2,'stroke-dasharray':style.dash,'stroke-linejoin':'round'}));
        branch.appendChild(svgEl('path',{d,fill:'none',stroke:'transparent','stroke-width':20}));
        const branchLabel=representativeRel.label||(style.subtype==='adopted'?'收養':style.subtype==='foster'?'寄養':'');
        if(branchLabel){
          const label=svgEl('text',{x:p.x+10,y:(siblingY+p.y)/2,'font-size':14,fill:'#111'});
          label.textContent=branchLabel;branch.appendChild(label);
        }
        relationLayer.appendChild(branch);
      });
    });
  }

  function drawRelation(r){
    if(r.type==='parent')return;
    const a=getNode(r.from),b=getNode(r.to);if(!a||!b)return;
    const g=svgEl('g',{'data-kind':'relation','data-id':r.id});
    let p1=nodeEdgePoint(a,b),p2=nodeEdgePoint(b,a),route=r.type==='partner'?partnerRoutePoints(r,a,b,p1,p2):relationRoutePoints(r,p1,p2,[a.id,b.id]);
    let path=null,hitD=routePathD(route);

    if(r.type==='twins'){
      const apex={x:(p1.x+p2.x)/2,y:Math.min(p1.y,p2.y)-55};
      const d1=`M ${apex.x} ${apex.y} L ${p1.x} ${p1.y}`,d2=`M ${apex.x} ${apex.y} L ${p2.x} ${p2.y}`;
      g.append(svgEl('path',{d:d1,fill:'none',stroke:'#111','stroke-width':2.2}),svgEl('path',{d:d2,fill:'none',stroke:'#111','stroke-width':2.2}));
      if(r.subtype==='identical'){const t=.68;g.appendChild(svgEl('line',{x1:apex.x+(p1.x-apex.x)*t,y1:apex.y+(p1.y-apex.y)*t,x2:apex.x+(p2.x-apex.x)*t,y2:apex.y+(p2.y-apex.y)*t,stroke:'#111','stroke-width':2}));}
      hitD=`M ${p1.x} ${p1.y} L ${apex.x} ${apex.y} L ${p2.x} ${p2.y}`;route=[p1,apex,p2];
    }else if(r.type==='care'){
      path=svgEl('path',{d:hitD,fill:'none',stroke:'#111','stroke-width':2.2,'marker-end':'url(#arrow)','stroke-linejoin':'round'});
    }else if(r.type==='conflict'){
      path=zigzagPath(p1,p2);hitD=path.getAttribute('d');route=[p1,p2];
    }else if(r.type==='close'){
      const p=parallelLine(p1,p2,5);g.append(svgEl('path',{d:p[0],fill:'none',stroke:'#111','stroke-width':2}),svgEl('path',{d:p[1],fill:'none',stroke:'#111','stroke-width':2}));route=[p1,p2];
    }else if(r.type==='closeConflict'){
      const p=parallelLine(p1,p2,6);g.append(svgEl('path',{d:p[0],fill:'none',stroke:'#111','stroke-width':2}),svgEl('path',{d:p[1],fill:'none',stroke:'#111','stroke-width':2}));const zig=zigzagPath(p1,p2);zig.setAttribute('stroke-width','1.8');g.appendChild(zig);route=[p1,p2];
    }else if(r.type==='abuse'){
      path=zigzagPath(p1,p2);path.setAttribute('stroke','#b42318');path.setAttribute('stroke-width','2.8');path.setAttribute('marker-end','url(#redArrow)');hitD=path.getAttribute('d');route=[p1,p2];
    }else{
      path=svgEl('path',{d:hitD,fill:'none',stroke:'#111','stroke-width':2.2,'stroke-dasharray':r.status==='cohabiting'?'8 5':'','stroke-linejoin':'round'});
      const mid=pointOnRoute(route,.5);
      if(r.type==='cutoff'){
        const dx=Math.cos(mid.angle+Math.PI/2)*12,dy=Math.sin(mid.angle+Math.PI/2)*12;
        g.appendChild(svgEl('line',{x1:mid.x-dx,y1:mid.y-dy,x2:mid.x+dx,y2:mid.y+dy,stroke:'#111','stroke-width':2.4}));
      }
      if(r.type==='partner'&&(r.status==='separated'||r.status==='divorced')){
        const count=r.status==='divorced'?2:1;
        for(let i=0;i<count;i++){
          const off=(i-(count-1)/2)*8,cx=mid.x+Math.cos(mid.angle)*off,cy=mid.y+Math.sin(mid.angle)*off;
          const dx=Math.cos(mid.angle+Math.PI/2)*10,dy=Math.sin(mid.angle+Math.PI/2)*10;
          g.appendChild(svgEl('line',{x1:cx-dx,y1:cy-dy,x2:cx+dx,y2:cy+dy,stroke:'#111','stroke-width':2.3}));
        }
      }
    }
    if(path)g.prepend(path);
    const subtypeLabels={identical:'同卵',fraternal:'異卵',unknownTwins:'類型未明',physical:'身體暴力',emotional:'精神暴力',sexual:'性暴力',economic:'經濟控制',neglect:'疏忽／遺棄',otherAbuse:'其他暴力'};
    const visibleLabel=r.label||subtypeLabels[r.subtype]||'';
    if(visibleLabel){const mid=pointOnRoute(route,.5);const txt=svgEl('text',{x:mid.x,y:mid.y-12,'font-size':15,'text-anchor':'middle',fill:r.type==='abuse'?'#b42318':'#111','font-weight':r.type==='abuse'?700:400});txt.textContent=visibleLabel;g.appendChild(txt);}
    g.appendChild(svgEl('path',{d:hitD,fill:'none',stroke:'transparent','stroke-width':22,'stroke-linejoin':'round'}));
    g.addEventListener('click',selectFromEvent);relationLayer.appendChild(g);
  }

  function zigzagPath(p1,p2){
    const n=10, pts=[];
    const dx=p2.x-p1.x, dy=p2.y-p1.y, len=Math.hypot(dx,dy)||1;
    const nx=-dy/len, ny=dx/len;
    for(let i=0;i<=n;i++){
      const t=i/n, amp=(i===0||i===n)?0:(i%2?7:-7);
      pts.push([p1.x+dx*t+nx*amp,p1.y+dy*t+ny*amp]);
    }
    return svgEl('path',{d:pts.map((p,i)=>(i?'L':'M')+p[0]+' '+p[1]).join(' '),fill:'none',stroke:'#111','stroke-width':2.2});
  }

  function parallelLine(p1,p2,offset){
    const dx=p2.x-p1.x,dy=p2.y-p1.y,len=Math.hypot(dx,dy)||1;
    const nx=-dy/len*offset,ny=dx/len*offset;
    return [
      `M ${p1.x+nx} ${p1.y+ny} L ${p2.x+nx} ${p2.y+ny}`,
      `M ${p1.x-nx} ${p1.y-ny} L ${p2.x-nx} ${p2.y-ny}`
    ];
  }

  function drawNode(n){
    const g = svgEl('g', {'data-kind':'node','data-id':n.id, class:'draggable', transform:`translate(${n.x},${n.y})`});
    const r=n.size/2;
    const effectiveFill=n.fillColor || (n.proband?'#e4e9ed':'#fff');
    const common={fill:effectiveFill,stroke:'#111','stroke-width':2.4};
    let shape;
    if(n.sex==='male') shape=svgEl('rect',{x:-r,y:-r,width:n.size,height:n.size,...common});
    else if(n.sex==='female') shape=svgEl('circle',{cx:0,cy:0,r,...common});
    else if(n.sex==='pregnancy') shape=svgEl('polygon',{points:`0,${-r} ${r},${r} ${-r},${r}`,...common});
    else if(n.sex==='loss'){
      const small=r*.82;
      shape=svgEl('polygon',{points:`0,${-small} ${small},${small} ${-small},${small}`,fill:n.fillColor || (n.lossType==='miscarriage'?'#111':'#fff'),stroke:'#111','stroke-width':2.4});
    }else shape=svgEl('polygon',{points:`0,${-r} ${r},0 0,${r} ${-r},0`,...common});
    g.appendChild(shape);

    if(n.proband){
      let inner;
      if(n.sex==='male') inner=svgEl('rect',{x:-r+6,y:-r+6,width:n.size-12,height:n.size-12,fill:'none',stroke:'#111','stroke-width':1.7});
      else if(n.sex==='female') inner=svgEl('circle',{cx:0,cy:0,r:r-6,fill:'none',stroke:'#111','stroke-width':1.7});
      else if(n.sex==='pregnancy'||n.sex==='loss') inner=svgEl('polygon',{points:`0,${-r+8} ${r-8},${r-8} ${-r+8},${r-8}`,fill:'none',stroke:'#111','stroke-width':1.7});
      else inner=svgEl('polygon',{points:`0,${-r+7} ${r-7},0 0,${r-7} ${-r+7},0`,fill:'none',stroke:'#111','stroke-width':1.7});
      g.appendChild(inner);
    }

    if(n.sex==='loss'){
      const small=r*.82;
      if(n.lossType==='abortion') g.appendChild(svgEl('line',{x1:-small*.55,y1:small*.42,x2:small*.55,y2:-small*.42,stroke:'#111','stroke-width':2.5}));
      if(n.lossType==='stillbirth'){
        g.append(svgEl('line',{x1:-small*.45,y1:-small*.2,x2:small*.45,y2:small*.55,stroke:'#111','stroke-width':2.4}),svgEl('line',{x1:-small*.45,y1:small*.55,x2:small*.45,y2:-small*.2,stroke:'#111','stroke-width':2.4}));
      }
      if(n.lossType==='unknown'){
        const q=svgEl('text',{x:0,y:11,'font-size':23,'text-anchor':'middle',fill:'#111','font-weight':700});q.textContent='?';g.appendChild(q);
      }
    }

    if(n.deceased && !['pregnancy','loss'].includes(n.sex)){
      g.append(svgEl('line',{x1:-r+5,y1:-r+5,x2:r-5,y2:r-5,stroke:'#111','stroke-width':2.3}),svgEl('line',{x1:-r+5,y1:r-5,x2:r-5,y2:-r+5,stroke:'#111','stroke-width':2.3}));
    }

    if(n.sex==='pregnancy'){
      const label=svgEl('text',{x:0,y:14,'font-size':18,'text-anchor':'middle',fill:'#111','font-weight':600});
      label.textContent=n.gestationWeeks?`${n.gestationWeeks}週`:'孕';g.appendChild(label);
    }else if(!['loss'].includes(n.sex) && n.age){
      const age=svgEl('text',{x:0,y:8,'font-size':23,'text-anchor':'middle',fill:'#111','font-weight':500});age.textContent=n.age;g.appendChild(age);
    }

    const typeCaption=n.sex==='loss'?lossTypeName(n.lossType):'';
    const caption=[displayNodeName(n),typeCaption,displayNodeNote(n)].filter(Boolean).join('・');
    if(caption){
      const txt=svgEl('text',{x:0,y:r+25,'font-size':16,'text-anchor':'middle',fill:'#111'});txt.textContent=caption;g.appendChild(txt);
    }
    g.addEventListener('pointerdown',startDrag);
    g.addEventListener('click',selectFromEvent);
    nodeLayer.appendChild(g);
  }

  function drawMetaLayer(){
    const meta=state.meta||{};
    if(meta.title){
      const title=svgEl('text',{x:700,y:48,'font-size':30,'font-weight':700,'text-anchor':'middle',fill:'#111'});title.textContent=meta.title;metaLayer.appendChild(title);
    }
    if(meta.subtitle){
      const sub=svgEl('text',{x:700,y:75,'font-size':16,'text-anchor':'middle',fill:'#667085'});sub.textContent=meta.subtitle;metaLayer.appendChild(sub);
    }
    if(meta.anonymize){const tag=svgEl('text',{x:1360,y:40,'font-size':14,'text-anchor':'end',class:'anonymized-indicator'});tag.textContent='匿名模式';metaLayer.appendChild(tag);}
    if(meta.showRiskMarkers!==false){
      state.nodes.filter(n=>n.risk).forEach(n=>{
        const r=n.size/2;
        const sx=n.x-r-46,sy=n.y-r-42;
        const ex=n.x-r*.55,ey=n.y-r*.55;
        metaLayer.appendChild(svgEl('path',{d:`M ${sx} ${sy} L ${ex} ${ey}`,fill:'none',stroke:'#b42318','stroke-width':3,'marker-end':'url(#redArrow)','pointer-events':'none'}));
        const label=svgEl('text',{x:sx-4,y:sy-7,'font-size':14,'text-anchor':'middle',fill:'#b42318','font-weight':700,'pointer-events':'none'});label.textContent=n.riskNote||'風險';metaLayer.appendChild(label);
      });
    }
  }

  function drawText(t){
    const g=svgEl('g',{'data-kind':'text','data-id':t.id,class:'draggable',transform:`translate(${t.x},${t.y})`});
    const txt=svgEl('text',{x:0,y:0,'font-size':t.fontSize||22,'font-weight':t.bold?700:400,fill:'#111'});
    txt.textContent=t.text||'文字';
    g.appendChild(txt);
    g.addEventListener('pointerdown',startDrag);
    g.addEventListener('click',selectFromEvent);
    textLayer.appendChild(g);
  }

  function drawSelection(){
    if(!state.selected) return;
    const {kind,id}=state.selected;
    let box=null;
    if(kind==='node'){
      const n=getNode(id); if(!n) return;
      const pad=10,r=n.size/2;
      box={x:n.x-r-pad,y:n.y-r-pad,w:n.size+pad*2,h:n.size+pad*2};
    }else if(kind==='frame'){
      const f=getFrame(id); if(!f) return;
      box={x:f.x-7,y:f.y-7,w:f.width+14,h:f.height+14};
    }else if(kind==='text'){
      const t=getText(id); if(!t) return;
      box={x:t.x-8,y:t.y-(t.fontSize||22)-8,w:Math.max(80,(t.text||'').length*(t.fontSize||22)*.95),h:(t.fontSize||22)+18};
    }
    if(box){
      selectionLayer.appendChild(svgEl('rect',{x:box.x,y:box.y,width:box.w,height:box.h,rx:6,fill:'none',stroke:'#355b7d','stroke-width':2,'stroke-dasharray':'6 4','pointer-events':'none'}));
      if(kind==='frame'){
        const handle=svgEl('rect',{x:box.x+box.w-7,y:box.y+box.h-7,width:14,height:14,fill:'#fff',stroke:'#355b7d','stroke-width':2,'data-resize-frame':id});
        handle.style.cursor='nwse-resize';handle.addEventListener('pointerdown',startResizeFrame);selectionLayer.appendChild(handle);
      }
    }
    if(kind==='relation'){
      const r=getRelation(id);if(!r||r.type==='parent')return;
      (r.points||[]).forEach((p,index)=>{
        const handle=svgEl('circle',{cx:p.x,cy:p.y,r:8,fill:'#fff',stroke:'#355b7d','stroke-width':3,class:'route-point-handle','data-relation-point':id,'data-point-index':index});
        handle.addEventListener('pointerdown',startRelationPointDrag);selectionLayer.appendChild(handle);
      });
    }
  }


  function redrawRelationsOnly(){relationLayer.innerHTML='';drawAllRelations();}
  function redrawMetaOnly(){metaLayer.innerHTML='';drawMetaLayer();}
  function redrawSelectionOnly(){selectionLayer.innerHTML='';drawSelection();}
  function replaceLayerItem(layer,kind,id,drawer,obj){
    layer.querySelector(`[data-kind="${kind}"][data-id="${id}"]`)?.remove();
    if(obj)drawer(obj);
  }
  function refreshVisual(kind,id,{relations=false,meta=false,selection=true}={}){
    if(kind==='node')replaceLayerItem(nodeLayer,'node',id,drawNode,getNode(id));
    else if(kind==='frame')replaceLayerItem(frameLayer,'frame',id,drawFrame,getFrame(id));
    else if(kind==='text')replaceLayerItem(textLayer,'text',id,drawText,getText(id));
    else if(kind==='relation')relations=true;
    if(relations)redrawRelationsOnly();
    if(meta)redrawMetaOnly();
    if(selection)redrawSelectionOnly();
    updateStatus();
  }

  function selectFromEvent(evt){
    evt.stopPropagation();
    const g=evt.currentTarget;
    state.selected={kind:g.dataset.kind,id:g.dataset.id};
    redrawSelectionOnly();renderInspector();updateStatus();
    if(window.matchMedia('(max-width:1080px)').matches) $('#rightPanel').classList.add('open');
  }

  function beginObjectDrag(kind,id,point,pointerId){
    const obj=kind==='node'?getNode(id):kind==='frame'?getFrame(id):getText(id);if(!obj)return;
    snapshot();drag={kind,id,startX:point.x,startY:point.y,origX:obj.x,origY:obj.y,moved:false,pointerId};state.selected={kind,id};
    try{canvas.setPointerCapture(pointerId)}catch(e){}
  }
  function startDrag(evt){
    if(evt.button!==0)return;evt.stopPropagation();
    const g=evt.currentTarget,kind=g.dataset.kind,id=g.dataset.id,point=getSvgPoint(evt);
    if(evt.pointerType==='touch'&&state.meta?.touchLongPress!==false){
      state.selected={kind,id};redrawSelectionOnly();renderInspector();
      const pending={kind,id,point,startClientX:evt.clientX,startClientY:evt.clientY,pointerId:evt.pointerId};
      pending.timer=setTimeout(()=>{if(touchPending!==pending)return;beginObjectDrag(kind,id,point,evt.pointerId);touchPending=null;showToast('可拖曳移動');},360);
      touchPending=pending;return;
    }
    beginObjectDrag(kind,id,point,evt.pointerId);
  }
  function startRelationPointDrag(evt){
    evt.stopPropagation();const id=evt.currentTarget.dataset.relationPoint,index=Number(evt.currentTarget.dataset.pointIndex);const r=getRelation(id);if(!r||!r.points[index])return;
    snapshot();const p=getSvgPoint(evt);drag={kind:'relationPoint',id,index,startX:p.x,startY:p.y,origX:r.points[index].x,origY:r.points[index].y,moved:false};state.selected={kind:'relation',id};
    try{canvas.setPointerCapture(evt.pointerId)}catch(e){}
  }

  function startResizeFrame(evt){
    evt.stopPropagation();
    const id=evt.currentTarget.dataset.resizeFrame;
    const f=getFrame(id); if(!f) return;
    snapshot();
    const p=getSvgPoint(evt);
    drag={kind:'resizeFrame',id,startX:p.x,startY:p.y,origW:f.width,origH:f.height,moved:false};
    canvas.setPointerCapture(evt.pointerId);
  }

  canvas.addEventListener('pointermove',evt=>{
    if(touchPending&&evt.pointerId===touchPending.pointerId){
      if(Math.hypot(evt.clientX-touchPending.startClientX,evt.clientY-touchPending.startClientY)>10){clearTimeout(touchPending.timer);touchPending=null;}
      return;
    }
    if(drag){
      const p=getSvgPoint(evt);drag.moved=true;
      if(drag.kind==='resizeFrame'){
        const f=getFrame(drag.id);if(!f)return;const rawW=clamp(drag.origW+(p.x-drag.startX),120,2400),rawH=clamp(drag.origH+(p.y-drag.startY),80,1800);
        f.width=isGridEnabled()?Math.max(120,snapValue(rawW)):rawW;f.height=isGridEnabled()?Math.max(80,snapValue(rawH)):rawH;refreshVisual('frame',f.id);
      }else if(drag.kind==='relationPoint'){
        const r=getRelation(drag.id);if(!r||!r.points[drag.index])return;const q=snapPoint(drag.origX+(p.x-drag.startX),drag.origY+(p.y-drag.startY));r.points[drag.index]=q;r.routing='manual';redrawRelationsOnly();redrawSelectionOnly();
      }else{
        const obj=drag.kind==='node'?getNode(drag.id):drag.kind==='frame'?getFrame(drag.id):getText(drag.id);if(!obj)return;
        const q=snapPoint(drag.origX+(p.x-drag.startX),drag.origY+(p.y-drag.startY));obj.x=q.x;obj.y=q.y;
        refreshVisual(drag.kind,drag.id,{relations:drag.kind==='node',meta:drag.kind==='node'});
      }
    }else if(pan){
      const dx=evt.clientX-pan.x,dy=evt.clientY-pan.y,vb=canvas.viewBox.baseVal;vb.x=pan.vx-dx/vb.width*1400;vb.y=pan.vy-dy/vb.height*900;
    }
  });

  canvas.addEventListener('pointerup',evt=>{
    if(touchPending&&evt.pointerId===touchPending.pointerId){clearTimeout(touchPending.timer);touchPending=null;renderInspector();if(window.matchMedia('(max-width:1080px)').matches)$('#rightPanel').classList.add('open');}
    if(drag){persist();drag=null;}pan=null;try{canvas.releasePointerCapture(evt.pointerId)}catch(e){}
  });
  canvas.addEventListener('pointercancel',evt=>{if(touchPending){clearTimeout(touchPending.timer);touchPending=null;}drag=null;pan=null;});

  canvas.addEventListener('pointerdown',evt=>{
    const isCanvasBackground=evt.target===canvas||(evt.target.tagName==='rect'&&evt.target.parentElement===canvas);
    if(isCanvasBackground){state.selected=null;redrawSelectionOnly();renderInspector();}
    if(evt.button===1||evt.altKey||(evt.pointerType==='touch'&&isCanvasBackground)){
      const vb=canvas.viewBox.baseVal;pan={x:evt.clientX,y:evt.clientY,vx:vb.x,vy:vb.y};try{canvas.setPointerCapture(evt.pointerId)}catch(e){}
    }
  });

  canvas.addEventListener('wheel',evt=>{
    evt.preventDefault();
    const factor=evt.deltaY<0?.9:1.1;
    const vb=canvas.viewBox.baseVal;
    const p=getSvgPoint(evt);
    const nw=clamp(vb.width*factor,500,2800),nh=nw*900/1400;
    vb.x=p.x-(p.x-vb.x)*(nw/vb.width);
    vb.y=p.y-(p.y-vb.y)*(nh/vb.height);
    vb.width=nw;vb.height=nh;
    updateZoomButton();
  },{passive:false});

  function renderInspector(){
    if(!state.selected){ inspector.className='empty'; inspector.innerHTML='請先點選人物、關係線、文字或外框。'; return; }
    inspector.className='section';
    const {kind,id}=state.selected;
    if(kind==='node') renderNodeInspector(getNode(id));
    if(kind==='relation') renderRelationInspector(getRelation(id));
    if(kind==='frame') renderFrameInspector(getFrame(id));
    if(kind==='text') renderTextInspector(getText(id));
  }


  function nudgeControlsHtml(){
    return `<div class="nudge-panel"><div class="nudge-title"><span>位置微調</span><span>${Number(state.meta?.nudgeStep)||2}px／次</span></div><div class="nudge-grid"><button class="btn small" type="button" data-nudge="up">↑</button><button class="btn small" type="button" data-nudge="left">←</button><button class="btn small" type="button" data-nudge="right">→</button><button class="btn small" type="button" data-nudge="down">↓</button></div></div>`;
  }

  function renderNodeInspector(n){
    if(!n) return;
    const isPregnancy=n.sex==='pregnancy', isLoss=n.sex==='loss';
    inspector.innerHTML=`
      <div class="stack">
        <div class="field"><label>姓名／代號</label><input data-k="name" value="${esc(n.name)}" placeholder="例如：案主、長男、A女" /></div>
        <div class="grid2">
          <div class="field"><label>人物／事件類型</label><select data-k="sex"><option value="male" ${n.sex==='male'?'selected':''}>男性</option><option value="female" ${n.sex==='female'?'selected':''}>女性</option><option value="unknown" ${n.sex==='unknown'?'selected':''}>性別未明</option><option value="pregnancy" ${isPregnancy?'selected':''}>懷孕</option><option value="loss" ${isLoss?'selected':''}>流產／死產</option></select></div>
          ${isPregnancy?`<div class="field"><label>孕週</label><input data-k="gestationWeeks" value="${esc(n.gestationWeeks)}" inputmode="numeric" placeholder="例如：20" /></div>`:`<div class="field"><label>年齡</label><input data-k="age" value="${esc(n.age)}" inputmode="numeric" placeholder="例如：80" /></div>`}
        </div>
        ${isLoss?`<div class="field"><label>流產／死產類型</label><select data-k="lossType"><option value="unknown" ${n.lossType==='unknown'?'selected':''}>未明</option><option value="miscarriage" ${n.lossType==='miscarriage'?'selected':''}>自然流產</option><option value="abortion" ${n.lossType==='abortion'?'selected':''}>人工流產</option><option value="stillbirth" ${n.lossType==='stillbirth'?'selected':''}>死產</option></select></div>`:''}
        <div class="field"><label>備註</label><textarea data-k="note" placeholder="例如：在家照顧、主要照顧者">${esc(n.note)}</textarea></div>
        <label class="check"><input type="checkbox" data-k="proband" ${n.proband?'checked':''}/> 案主／個案（雙框）</label>
        ${!isPregnancy&&!isLoss?`<label class="check"><input type="checkbox" data-k="deceased" ${n.deceased?'checked':''}/> 已歿（圖形內加叉）</label>`:''}
        <label class="check"><input type="checkbox" data-k="risk" ${n.risk?'checked':''}/> 高風險／需注意（紅色箭頭）</label>
        <div class="field"><label>風險標籤（選填）</label><input data-k="riskNote" value="${esc(n.riskNote)}" placeholder="例如：自傷風險、家暴風險" /></div>
        <div class="field">
          <label>節點填色</label>
          <div class="color-control">
            <input type="color" data-k="fillColor" value="${esc(n.fillColor||'#ffffff')}" aria-label="自訂節點填色" />
            <div class="hint">可用於區分同住家庭、不同居住地或需特別辨識的成員。</div>
          </div>
          <div class="color-palette" aria-label="常用色彩">
            <button type="button" class="color-swatch" data-fill-preset="#fff1a8" style="background:#fff1a8" title="淡黃"></button>
            <button type="button" class="color-swatch" data-fill-preset="#dceeff" style="background:#dceeff" title="淡藍"></button>
            <button type="button" class="color-swatch" data-fill-preset="#dff3e4" style="background:#dff3e4" title="淡綠"></button>
            <button type="button" class="color-swatch" data-fill-preset="#f9dddd" style="background:#f9dddd" title="淡紅"></button>
            <button type="button" class="color-swatch" data-fill-preset="#eadff7" style="background:#eadff7" title="淡紫"></button>
            <button type="button" class="btn color-reset" data-reset-fill>恢復預設</button>
          </div>
        </div>
        <div class="field"><label>符號大小</label><input type="range" min="42" max="84" value="${n.size}" data-k="size" /></div>
        ${nudgeControlsHtml()}
        <div class="inspector-actions"><button class="btn danger" data-delete>刪除此人物／事件</button></div>
      </div>`;
    bindInspector(n,'node');
    inspector.querySelectorAll('[data-fill-preset]').forEach(btn=>btn.addEventListener('click',()=>{
      snapshot();n.fillColor=btn.dataset.fillPreset;render();persist();
    }));
    inspector.querySelector('[data-reset-fill]')?.addEventListener('click',()=>{
      snapshot();n.fillColor='';render();persist();
    });
  }

  function relationSubtypeOptions(type,current=''){
    const sets={
      parent:[['biological','親生'],['adopted','收養'],['foster','寄養']],
      twins:[['unknownTwins','類型未明'],['identical','同卵'],['fraternal','異卵']],
      abuse:[['physical','身體暴力'],['emotional','精神暴力'],['sexual','性暴力'],['economic','經濟控制'],['neglect','疏忽／遺棄'],['otherAbuse','其他暴力']]
    };
    return (sets[type]||[]).map(([v,l])=>`<option value="${v}" ${current===v?'selected':''}>${l}</option>`).join('');
  }

  function renderRelationInspector(r){
    if(!r) return;
    const types=[['partner','婚姻／伴侶'],['parent','親子'],['twins','雙胞胎／多胞胎'],['care','照顧／支持箭頭'],['close','親密'],['conflict','衝突'],['closeConflict','親密但衝突'],['abuse','施暴／受暴'],['cutoff','關係中斷']];
    const hasSubtype=['parent','twins','abuse'].includes(r.type);
    inspector.innerHTML=`
      <div class="stack">
        <div class="field"><label>關係類型</label><select data-k="type">${types.map(([v,l])=>`<option value="${v}" ${r.type===v?'selected':''}>${l}</option>`).join('')}</select></div>
        ${r.type==='partner'?`<div class="field"><label>伴侶狀態</label><select data-k="status"><option value="married" ${r.status==='married'?'selected':''}>婚姻</option><option value="cohabiting" ${r.status==='cohabiting'?'selected':''}>同居</option><option value="separated" ${r.status==='separated'?'selected':''}>分居</option><option value="divorced" ${r.status==='divorced'?'selected':''}>離婚</option></select></div>`:''}
        ${hasSubtype?`<div class="field"><label>關係細類</label><select data-k="subtype">${relationSubtypeOptions(r.type,r.subtype)}</select></div>`:''}
        <div class="field"><label>標籤</label><input data-k="label" value="${esc(r.label)}" placeholder="例如：主要照顧"/></div>
        <div class="hint">起點：${esc(nodeLabel(getNode(r.from)||{}))}<br>終點：${esc(nodeLabel(getNode(r.to)||{}))}${r.type==='abuse'?'<br><strong>施暴關係的起點為施暴者，終點為受暴者。</strong>':''}</div>
        ${r.type==='parent'?`<div class="route-tools"><div class="setting-line"><strong style="font-size:12px">親子結構線</strong><span class="setting-value">社工標準排列</span></div><div class="hint">親子線會自動由父母婚姻線中點向下，連到同胞手足線；請使用「依社工原則排列」調整整體位置。</div></div>`:`<div class="route-tools">
          <div class="setting-line"><strong style="font-size:12px">線路控制</strong><span class="setting-value">${r.routing==='manual'?'手動轉折':'自動避障'}</span></div>
          <div class="row wrap"><button class="btn small" type="button" data-add-route-point>新增轉折點</button><button class="btn small" type="button" data-remove-route-point ${!(r.points||[]).length?'disabled':''}>移除最後轉折</button><button class="btn small" type="button" data-reset-route>恢復自動路由</button></div>
          <div class="hint">選取關係線後，畫布上的藍色圓點可拖曳調整折彎位置。</div>
        </div>`}
        <div class="inspector-actions"><button class="btn danger" data-delete>刪除此關係</button></div>
      </div>`;
    bindInspector(r,'relation');
    inspector.querySelector('[data-add-route-point]')?.addEventListener('click',()=>{
      const a=getNode(r.from),b=getNode(r.to);if(!a||!b)return;snapshot();
      const route=relationRoutePoints({...r,routing:'auto',points:[]},nodeEdgePoint(a,b),nodeEdgePoint(b,a),[a.id,b.id]);
      const mid=pointOnRoute(route,.5);r.points.push(snapPoint(mid.x,mid.y));r.routing='manual';render();persist();
    });
    inspector.querySelector('[data-remove-route-point]')?.addEventListener('click',()=>{if(!(r.points||[]).length)return;snapshot();r.points.pop();r.routing=r.points.length?'manual':'auto';render();persist();});
    inspector.querySelector('[data-reset-route]')?.addEventListener('click',()=>{snapshot();r.points=[];r.routing='auto';render();persist();});
  }

  function renderFrameInspector(f){
    if(!f) return;
    inspector.innerHTML=`
      <div class="stack">
        <div class="field"><label>框線標題</label><input data-k="label" value="${esc(f.label)}" /></div>
        <div class="grid2"><div class="field"><label>寬度</label><input type="number" data-k="width" value="${Math.round(f.width)}" /></div><div class="field"><label>高度</label><input type="number" data-k="height" value="${Math.round(f.height)}" /></div></div>
        <label class="check"><input type="checkbox" data-k="dashed" ${f.dashed?'checked':''}/> 虛線框</label>
        <label class="check"><input type="checkbox" data-k="rounded" ${f.rounded?'checked':''}/> 圓角</label>
        ${nudgeControlsHtml()}
        <div class="inspector-actions"><button class="btn danger" data-delete>刪除此外框</button></div>
      </div>`;
    bindInspector(f,'frame');
  }

  function renderTextInspector(t){
    if(!t) return;
    inspector.innerHTML=`
      <div class="stack">
        <div class="field"><label>文字內容</label><textarea data-k="text">${esc(t.text)}</textarea></div>
        <div class="field"><label>字級</label><input type="range" min="12" max="48" value="${t.fontSize}" data-k="fontSize" /></div>
        <label class="check"><input type="checkbox" data-k="bold" ${t.bold?'checked':''}/> 粗體</label>
        ${nudgeControlsHtml()}
        <div class="inspector-actions"><button class="btn danger" data-delete>刪除此文字</button></div>
      </div>`;
    bindInspector(t,'text');
  }

  function bindInspector(obj,kind){
    inspector.querySelectorAll('[data-k]').forEach(el=>{
      const event=(el.type==='checkbox'||el.tagName==='SELECT'||el.type==='range')?'change':'input';let snapTaken=false;
      const takeSnapshot=()=>{if(!snapTaken){snapshot();snapTaken=true;}};el.addEventListener('focus',takeSnapshot,{once:true});
      el.addEventListener(event,()=>{
        takeSnapshot();let val=el.type==='checkbox'?el.checked:el.value;if(['size','width','height','fontSize'].includes(el.dataset.k))val=Number(val);obj[el.dataset.k]=val;
        const structural=(kind==='relation'&&['type','status','subtype'].includes(el.dataset.k))||(kind==='node'&&el.dataset.k==='sex');
        if(kind==='relation'&&el.dataset.k==='type')obj.subtype=val==='parent'?'biological':val==='twins'?'unknownTwins':val==='abuse'?'physical':'';
        if(structural)render(event==='input');
        else refreshVisual(kind,obj.id,{relations:kind==='relation'||(kind==='node'&&el.dataset.k==='size'),meta:kind==='node'&&['risk','riskNote','name','note'].includes(el.dataset.k)});
        schedulePersist();
      });
    });
    inspector.querySelectorAll('[data-nudge]').forEach(btn=>btn.addEventListener('click',()=>{
      if(!('x' in obj)||!('y' in obj))return;snapshot();const step=Number(state.meta?.nudgeStep)||2,dir=btn.dataset.nudge;
      if(dir==='up')obj.y-=step;if(dir==='down')obj.y+=step;if(dir==='left')obj.x-=step;if(dir==='right')obj.x+=step;
      refreshVisual(kind,obj.id,{relations:kind==='node',meta:kind==='node'});persist();
    }));
    inspector.querySelector('[data-delete]')?.addEventListener('click',()=>deleteSelected(kind,obj.id));
  }

  function deleteSelected(kind,id){
    snapshot();
    if(kind==='node'){
      state.nodes=state.nodes.filter(n=>n.id!==id);
      state.relations=state.relations.filter(r=>r.from!==id&&r.to!==id);
    }else if(kind==='relation') state.relations=state.relations.filter(r=>r.id!==id);
    else if(kind==='frame') state.frames=state.frames.filter(f=>f.id!==id);
    else if(kind==='text') state.texts=state.texts.filter(t=>t.id!==id);
    state.selected=null; render();persist();
  }

  function updateStatus(){
    const n=state.nodes.length,r=state.relations.length,risk=state.nodes.filter(x=>x.risk).length;
    statusText.textContent=`V${APP_VERSION}｜人物／事件 ${n}｜關係 ${r}${risk?`｜風險標記 ${risk}`:''}｜網格 ${isGridEnabled()?'開':'關'}${state.meta?.anonymize?'｜匿名模式':''}｜點選可編輯`;
  }

  function populateRelationSelects(){
    const opts=state.nodes.map(n=>`<option value="${n.id}">${esc(nodeLabel(n))}</option>`).join('');
    $('#relationFrom').innerHTML=opts;
    $('#relationTo').innerHTML=opts;
  }

  function cnNumber(raw=''){
    if(/^\d+$/.test(raw))return Number(raw);const digit={'零':0,'〇':0,'一':1,'二':2,'兩':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9};
    if(raw==='十')return 10;if(raw.includes('十')){const [a,b]=raw.split('十');return (a?digit[a]:1)*10+(b?digit[b]:0);}return digit[raw]??NaN;
  }
  function parseAge(text){
    const s=String(text);let m=s.match(/(?:年齡\s*)?[（(]?\s*(\d{1,3})\s*[)）]?\s*歲/);if(m)return m[1];
    m=s.match(/(?:年齡\s*)?([一二兩三四五六七八九十]{1,3})\s*歲/);if(m){const n=cnNumber(m[1]);return Number.isFinite(n)?String(n):'';}return '';
  }
  function parseWeeks(text){const m=String(text).match(/(\d{1,2})\s*(?:週|周)/);return m?m[1]:'';}
  function inferSex(label,text=''){
    if(/女兒|女|姊|姐|妹|妻|太太|母/.test(label))return'female';
    if(/兒子|男|兄|弟|夫|先生|父|子/.test(label))return'male';
    if(/女兒|女性|女童|太太|妻子|母親/.test(text))return'female';
    if(/兒子|男性|男童|丈夫|先生|父親/.test(text))return'male';
    return'unknown';
  }
  function normalizeQuickText(raw){return String(raw).replace(/\r/g,'').replace(/[；;]/g,'，').replace(/[，、]/g,'，').replace(/[：:]/g,'：').replace(/^\s*[•・●\-*]\s*/gm,'').trim();}
  function splitRoleLine(line){
    if(line.includes('：')){const [h,...r]=line.split('：');return [h.trim(),r.join('：').trim()];}
    const roles=['個案','案主','服務對象','主要個案','配偶','丈夫','先生','太太','妻子','長男','長子','大兒子','長女','大女兒','次男','次子','二兒子','次女','二女兒','三男','三子','三女','四男','四女','么子','么女'];
    const role=roles.find(x=>line.startsWith(x));if(role)return[role,line.slice(role.length).replace(/^\s*[，,]?\s*/,'')];return['',line];
  }
  function extractChildSpecs(text){
    const out=[],seen=new Set(),push=(sex,age)=>{const key=sex+'-'+age;if(!seen.has(key)){seen.add(key);out.push({sex,age:String(age)});}};
    const patterns=[
      /(\d{1,3})\s*歲(?:的)?\s*(兒子|女兒|男童|女童|子|女)/g,
      /(兒子|女兒|男童|女童|子|女)\s*[（(]?\s*(\d{1,3})\s*歲?\s*[)）]?/g,
      /(?:一|1)\s*(子|女)[，,\s]*(\d{1,3})\s*歲/g
    ];
    patterns.forEach((re,idx)=>{for(const m of text.matchAll(re)){const age=idx===0?m[1]:m[2],word=idx===0?m[2]:m[1];push(/女/.test(word)?'female':'male',age);}});return out;
  }
  function parseMarriageCount(text){
    const m=String(text).match(/(?:婚配|結婚|婚姻|婚過)\s*([一二兩三四五六七八九十\d]+)\s*(?:次|段|任)/);if(m){const n=cnNumber(m[1]);return Number.isFinite(n)?n:0;}
    return /已婚|有配偶|同居/.test(text)?1:0;
  }
  function marriageSegments(body,count){
    const result=[];for(let i=1;i<=count;i++){
      const chars=['一','二','三','四','五','六','七','八','九','十'],ord=chars[i-1]||String(i);
      const re=new RegExp(`(?:第${ord}(?:次|任|段)|第${i}(?:次|任|段))(?:婚姻|婚配|配偶)?[：:\\s]*([\\s\\S]*?)(?=(?:第[一二三四五六七八九十\\d]+|[一二三四五六七八九十]+)(?:次|任|段)|$)`);const m=body.match(re);result.push(m?m[1]:'');
    }return result;
  }
  function parseQuickInput(raw){
    const lines=normalizeQuickText(raw).split(/\n+/).map(s=>s.trim()).filter(Boolean),nodes=[],relations=[],warnings=[];let proband=null,spouse=null;const children=[];
    const newNode=p=>{const n=normalizeNode({...p,id:uid('n')});nodes.push(n);return n;};
    const rel=(a,b,type='partner',opts={})=>{
      const r=normalizeRelation({id:uid('r'),from:a.id,to:b.id,type,status:opts.status||'married',subtype:opts.subtype||(type==='parent'?'biological':''),label:opts.label||'',unionId:opts.unionId||''});
      relations.push(r);return r;
    };
    const isChildRole=h=>/(長|大|次|二|三|四|五|六|七|八|九|么).*(男|子|女|兒)|^(長男|長女|次男|次女|三男|三女)/.test(h);
    for(const original of lines){
      const [head,bodyRaw]=splitRoleLine(original),body=bodyRaw||'';let handled=false;
      if(/個案|案主|服務對象|主要個案/.test(head||original)){
        const source=head?body:original,sex=inferSex(head,source);proband=newNode({name:'個案',sex,age:parseAge(source),deceased:/已歿|死亡|過世/.test(source),proband:true,note:/在家照顧/.test(source)?'在家照顧':''});handled=true;
      }else if(/^(配偶|丈夫|先生|太太|妻子)$/.test(head)){
        const sex=head==='丈夫'||head==='先生'?'male':head==='太太'||head==='妻子'?'female':inferSex(head,body);spouse=newNode({name:'配偶',sex,age:parseAge(body),deceased:/已歿|死亡|過世/.test(body)});handled=true;
      }else if(/懷孕/.test(head+body)){
        newNode({name:head||'懷孕',sex:'pregnancy',gestationWeeks:parseWeeks(body),note:body.replace(/懷孕|\d+\s*(?:週|周)/g,'').replace(/[，,]/g,' ').trim()});handled=true;
      }else if(/流產|死產/.test(head+body)){
        const lossType=/死產/.test(head+body)?'stillbirth':/人工/.test(head+body)?'abortion':/自然/.test(head+body)?'miscarriage':'unknown';newNode({name:head||lossTypeName(lossType),sex:'loss',lossType,note:body.replace(/自然流產|人工流產|流產|死產/g,'').replace(/[，,]/g,' ').trim()});handled=true;
      }else if(isChildRole(head)){
        const sex=inferSex(head,body),child=newNode({name:head,sex,age:parseAge(body),note:/未婚/.test(body)?'未婚':''});children.push(child);handled=true;
        const count=parseMarriageCount(body),segments=marriageSegments(body,count),partners=[];
        for(let i=0;i<count;i++){
          const partner=newNode({name:count===1?'配偶':`第${['一','二','三','四','五','六'][i]||i+1}任配偶`,sex:sex==='male'?'female':sex==='female'?'male':'unknown'});partners.push(partner);
          const union=rel(child,partner,'partner',{status:/離婚/.test(segments[i])?'divorced':/分居/.test(segments[i])?'separated':/同居/.test(segments[i])?'cohabiting':'married'});
          extractChildSpecs(segments[i]).forEach(spec=>{
            const c=newNode({name:spec.sex==='male'?'子':'女',sex:spec.sex,age:spec.age});
            rel(child,c,'parent',{unionId:union.id});rel(partner,c,'parent',{unionId:union.id});
          });
        }
        const general=extractChildSpecs(body);general.forEach(spec=>{
          const exists=nodes.some(n=>n.age===spec.age&&n.sex===spec.sex&&relations.some(r=>r.type==='parent'&&r.to===n.id&&r.from===child.id));if(exists)return;
          const c=newNode({name:spec.sex==='male'?'子':'女',sex:spec.sex,age:spec.age});
          const union=partners.length===1?relations.find(r=>r.type==='partner'&&((r.from===child.id&&r.to===partners[0].id)||(r.to===child.id&&r.from===partners[0].id))):null;
          rel(child,c,'parent',{unionId:union?.id||''});if(partners.length===1)rel(partners[0],c,'parent',{unionId:union?.id||''});
        });
      }
      if(!handled)warnings.push(original);
    }
    const rootUnion=proband&&spouse?rel(spouse,proband,'partner',{status:'married'}):null;
    if(proband)children.forEach(c=>{
      rel(proband,c,'parent',{unionId:rootUnion?.id||''});
      if(spouse)rel(spouse,c,'parent',{unionId:rootUnion?.id||''});
    });
    return {nodes,relations,warnings,total:lines.length};
  }
  function getTempNode(nodes,id){return nodes.find(n=>n.id===id)}
  function applyParsed(raw){
    const parsed=parseQuickInput(raw),report=$('#parseReport');
    if(!parsed.nodes.length){report.textContent='未辨識到人物資料。請參考輸入格式範例。';report.className='parse-report show warning';return showToast('沒有辨識到人物資料');}
    snapshot();state=defaultState();state.nodes=parsed.nodes;state.relations=parsed.relations;autoLayout(false);render();persist();syncMetaControls();
    if(parsed.warnings.length){report.innerHTML=`已建立 ${parsed.nodes.length} 個人物／事件、${parsed.relations.length} 條關係。<br>未辨識：${parsed.warnings.map(esc).join('；')}`;report.className='parse-report show warning';showToast('已產生，部分句子需手動確認');}
    else{report.textContent=`已辨識 ${parsed.total} 行，建立 ${parsed.nodes.length} 個人物／事件與 ${parsed.relations.length} 條關係。`;report.className='parse-report show';showToast('已產生家系圖，可繼續拖曳與編輯');}
  }

  function partnerComponentLayout(members,partnerRels){
    const relationIndex=r=>state.relations.indexOf(r);
    if(members.length===1)return{width:150,offsets:new Map([[members[0].id,0]])};
    if(members.length===2){
      const ordered=[...members].sort((a,b)=>{
        const rank=n=>n.sex==='male'?0:n.sex==='female'?1:2;
        return rank(a)-rank(b)||(a.proband?-1:0)-(b.proband?-1:0);
      });
      return{width:250,offsets:new Map([[ordered[0].id,-75],[ordered[1].id,75]])};
    }
    const degree=id=>partnerRels.filter(r=>r.from===id||r.to===id).length;
    const focal=[...members].sort((a,b)=>degree(b.id)-degree(a.id)||(b.proband?1:0)-(a.proband?1:0))[0];
    const linked=partnerRels.filter(r=>r.from===focal.id||r.to===focal.id).sort((a,b)=>relationIndex(a)-relationIndex(b));
    const partners=linked.map(r=>getNode(r.from===focal.id?r.to:r.from)).filter(n=>n&&members.some(m=>m.id===n.id));
    members.filter(n=>n.id!==focal.id&&!partners.some(p=>p.id===n.id)).forEach(n=>partners.push(n));
    const offsets=new Map([[focal.id,0]]);
    const preferred=focal.sex==='female'?-1:1;
    partners.forEach((p,i)=>{
      const sign=i===0?preferred:(i%2===1?-preferred:preferred);
      const ring=Math.floor(i/2)+1;
      const distance=150+(ring-1)*175+(i%2===1?20:0);
      offsets.set(p.id,sign*distance);
    });
    const values=[...offsets.values()];
    return{width:Math.max(290,Math.max(...values)-Math.min(...values)+190),offsets};
  }

  function autoLayout(withSnapshot=true){
    if(withSnapshot)snapshot();
    const nodes=state.nodes;if(!nodes.length)return;
    const repairedMissingParents=repairMissingCoParentsByGeometry();
    inferParentUnionIds();
    const partnerRels=state.relations.filter(r=>r.type==='partner');
    const parentRels=state.relations.filter(r=>r.type==='parent');

    // 伴侶視為同一世代；親子關係固定下一世代。
    const parent={};nodes.forEach(n=>parent[n.id]=n.id);
    const find=id=>parent[id]===id?id:(parent[id]=find(parent[id]));
    const union=(a,b)=>{a=find(a);b=find(b);if(a!==b)parent[b]=a;};
    partnerRels.forEach(r=>union(r.from,r.to));
    const comps=new Map();nodes.forEach(n=>{const root=find(n.id);if(!comps.has(root))comps.set(root,[]);comps.get(root).push(n);});
    const compOf=id=>find(id);
    const incoming=new Map(),outgoing=new Map();comps.forEach((_,id)=>{incoming.set(id,new Set());outgoing.set(id,new Set());});
    parentRels.forEach(r=>{const a=compOf(r.from),b=compOf(r.to);if(a!==b){outgoing.get(a).add(b);incoming.get(b).add(a);}});
    const generation=new Map();
    const roots=[...comps.keys()].filter(id=>incoming.get(id).size===0);
    (roots.length?roots:[...comps.keys()].slice(0,1)).forEach(id=>generation.set(id,0));
    let changed=true,guard=0;
    while(changed&&guard++<40){changed=false;outgoing.forEach((targets,from)=>{if(!generation.has(from))return;targets.forEach(to=>{const next=(generation.get(from)||0)+1;if(!generation.has(to)||generation.get(to)<next){generation.set(to,next);changed=true;}});});}
    comps.forEach((_,id)=>{if(!generation.has(id))generation.set(id,0);});

    const rows={};
    comps.forEach((members,id)=>{const g=generation.get(id)||0;(rows[g]||=[]).push({id,members,layout:partnerComponentLayout(members,partnerRels)});});
    const compBirthOrder=comp=>Math.min(...comp.members.map(birthOrderScore));
    const desiredParentCenter=comp=>{
      const anchors=[];
      comp.members.forEach(member=>parentRels.filter(r=>r.to===member.id).forEach(r=>{const p=getNode(r.from);if(p)anchors.push(p.x);}));
      return anchors.length?anchors.reduce((a,b)=>a+b,0)/anchors.length:null;
    };

    Object.keys(rows).map(Number).sort((a,b)=>a-b).forEach(g=>{
      const row=rows[g];
      row.sort((a,b)=>{
        const ax=desiredParentCenter(a),bx=desiredParentCenter(b);
        if(ax!==null&&bx!==null&&Math.abs(ax-bx)>24)return ax-bx;
        return compBirthOrder(a)-compBirthOrder(b)||a.members.map(n=>n.name||'').join('').localeCompare(b.members.map(n=>n.name||'').join(''),'zh-Hant');
      });
      const gap=90,total=row.reduce((s,c)=>s+c.layout.width,0)+Math.max(0,row.length-1)*gap;
      const baseY=150+g*270;
      const centers=[];
      if(g===0||!row.some(c=>desiredParentCenter(c)!==null)){
        let cursor=700-total/2;
        row.forEach(comp=>{centers.push(cursor+comp.layout.width/2);cursor+=comp.layout.width+gap;});
      }else{
        let previousRight=-Infinity;
        row.forEach(comp=>{
          const desired=desiredParentCenter(comp)??700;
          const center=Math.max(desired,previousRight+gap+comp.layout.width/2);
          centers.push(center);previousRight=center+comp.layout.width/2;
        });
        const left=Math.min(...centers.map((c,i)=>c-row[i].layout.width/2));
        const right=Math.max(...centers.map((c,i)=>c+row[i].layout.width/2));
        let shift=0;
        if(right>1340)shift=1340-right;
        if(left+shift<60)shift+=60-(left+shift);
        for(let i=0;i<centers.length;i++)centers[i]+=shift;
      }
      row.forEach((comp,index)=>{
        const center=centers[index];
        comp.members.forEach(n=>{n.x=center+(comp.layout.offsets.get(n.id)||0);n.y=baseY;});
      });
    });

    // 最後強制同世代共用相同 Y 座標，並依網格校正。
    if(isGridEnabled())snapAllObjects();
    state.relations.filter(r=>r.type==='parent').forEach(r=>{r.points=[];r.routing='auto';});
    render();persist();
    if(withSnapshot)showToast(repairedMissingParents?`已補回 ${repairedMissingParents} 條缺漏的另一位父母連線，並重新排列`:'已修正多次婚配家庭聯結，並依同代同列、長左幼右重新排列');
  }

  function clearAll(){
    if(!confirm('確定要清空目前家系圖嗎？')) return;
    snapshot(); state=defaultState();render();persist();
  }

  function download(filename,content,type){
    const blob=new Blob([content],{type});
    const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=filename;a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  }

  function getContentBounds(padding=EXPORT_PADDING){
    const boxes=[];
    state.nodes.forEach(n=>{const r=n.size/2,caption=[displayNodeName(n),n.sex==='loss'?lossTypeName(n.lossType):'',displayNodeNote(n)].filter(Boolean).join('・');boxes.push({x:n.x-r-50,y:n.y-r-55,w:n.size+100,h:n.size+55+(caption?35:0)});});
    state.frames.forEach(f=>boxes.push({x:f.x-15,y:f.y-22,w:f.width+30,h:f.height+37}));
    state.texts.forEach(t=>boxes.push({x:t.x-10,y:t.y-(t.fontSize||22)-10,w:Math.max(90,(t.text||'').length*(t.fontSize||22)*.92),h:(t.fontSize||22)+24}));
    state.relations.forEach(r=>(r.points||[]).forEach(p=>boxes.push({x:p.x-5,y:p.y-5,w:10,h:10})));
    if(state.meta?.title)boxes.push({x:430,y:10,w:540,h:70});
    if(!boxes.length)return{x:0,y:0,w:800,h:520};
    const minX=Math.min(...boxes.map(b=>b.x))-padding,minY=Math.min(...boxes.map(b=>b.y))-padding,maxX=Math.max(...boxes.map(b=>b.x+b.w))+padding,maxY=Math.max(...boxes.map(b=>b.y+b.h))+padding;
    return{x:Math.floor(minX),y:Math.floor(minY),w:Math.max(320,Math.ceil(maxX-minX)),h:Math.max(240,Math.ceil(maxY-minY))};
  }
  function getCleanSvgData(){
    const bounds=getContentBounds(),clone=canvas.cloneNode(true);clone.querySelector('#selectionLayer')?.remove();clone.querySelector('#gridBackground')?.remove();
    clone.querySelector('#canvasBackground')?.remove();
    const bg=document.createElementNS(SVG_NS,'rect');bg.setAttribute('x',bounds.x);bg.setAttribute('y',bounds.y);bg.setAttribute('width',bounds.w);bg.setAttribute('height',bounds.h);bg.setAttribute('fill','#fff');clone.insertBefore(bg,clone.firstChild.nextSibling);
    clone.setAttribute('xmlns',SVG_NS);clone.setAttribute('viewBox',`${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}`);clone.setAttribute('width',bounds.w);clone.setAttribute('height',bounds.h);
    return{svg:new XMLSerializer().serializeToString(clone),bounds};
  }
  function exportName(ext){return `家系圖${state.meta?.anonymize?'_匿名':''}.${ext}`;}
  function exportSvg(){const data=getCleanSvgData();download(exportName('svg'),data.svg,'image/svg+xml;charset=utf-8');}
  function exportPng(){
    const data=getCleanSvgData(),blob=new Blob([data.svg],{type:'image/svg+xml'}),url=URL.createObjectURL(blob),img=new Image();
    img.onload=()=>{const maxDim=Math.max(data.bounds.w,data.bounds.h),scale=Math.min(2.2,5000/maxDim),c=document.createElement('canvas');c.width=Math.max(1,Math.round(data.bounds.w*scale));c.height=Math.max(1,Math.round(data.bounds.h*scale));const ctx=c.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,c.width,c.height);ctx.drawImage(img,0,0,c.width,c.height);URL.revokeObjectURL(url);c.toBlob(b=>{const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=exportName('png');a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)},'image/png');};img.src=url;
  }

  function saveProject(){ download(`家系圖專案_V${APP_VERSION}.json`,JSON.stringify({...state,selected:null},null,2),'application/json;charset=utf-8'); }

  function loadProject(file){
    const reader=new FileReader();
    reader.onload=()=>{
      try{
        const data=JSON.parse(reader.result);
        if(!data.nodes||!data.relations) throw new Error('格式錯誤');
        snapshot();state=normalizeState(data);render();persist();syncMetaControls();showToast('專案已載入');
      }catch(e){showToast('無法載入：檔案格式不正確')}
    };
    reader.readAsText(file);
  }

  function setZoom(factor){
    const vb=canvas.viewBox.baseVal;
    const cx=vb.x+vb.width/2,cy=vb.y+vb.height/2;
    const nw=clamp(vb.width*factor,500,2800),nh=nw*900/1400;
    vb.x=cx-nw/2;vb.y=cy-nh/2;vb.width=nw;vb.height=nh;updateZoomButton();
  }
  function resetZoom(){canvas.setAttribute('viewBox','0 0 1400 900');updateZoomButton()}
  function fitContent(){
    const els=[...state.nodes.map(n=>({x:n.x-50,y:n.y-50,w:100,h:110})),...state.frames.map(f=>({x:f.x,y:f.y,w:f.width,h:f.height})),...state.texts.map(t=>({x:t.x,y:t.y-40,w:Math.max(100,(t.text||'').length*24),h:60}))];
    if(!els.length) return resetZoom();
    const minX=Math.min(...els.map(e=>e.x))-70,minY=Math.min(...els.map(e=>e.y))-70,maxX=Math.max(...els.map(e=>e.x+e.w))+70,maxY=Math.max(...els.map(e=>e.y+e.h))+70;
    const w=maxX-minX,h=maxY-minY,ratio=1400/900;
    let vw=w,vh=h;if(vw/vh>ratio)vh=vw/ratio;else vw=vh*ratio;
    canvas.setAttribute('viewBox',`${minX-(vw-w)/2} ${minY-(vh-h)/2} ${vw} ${vh}`);updateZoomButton();
  }
  function updateZoomButton(){const vb=canvas.viewBox.baseVal;$('#zoomResetBtn').textContent=Math.round(1400/vb.width*100)+'%'}

  function syncMetaControls(){
    $('#metaTitle').value=state.meta?.title||'';$('#metaSubtitle').value=state.meta?.subtitle||'';$('#showRiskMarkers').checked=state.meta?.showRiskMarkers!==false;$('#snapToGrid').checked=isGridEnabled();
    $('#anonymizeToggle').checked=!!state.meta?.anonymize;$('#anonymizeMode').value=state.meta?.anonymizeMode||'code';$('#anonymizeHideNotes').checked=state.meta?.anonymizeHideNotes!==false;
    $('#touchLongPress').checked=state.meta?.touchLongPress!==false;$('#nudgeStep').value=String(Number(state.meta?.nudgeStep)||2);updateGridVisual();updatePrivacyControls();
  }
  function bindMetaInput(selector,key,event='input',transform=v=>v){
    const el=$(selector);let snapped=false;el.addEventListener('focus',()=>{if(!snapped){snapshot();snapped=true;}},{once:true});
    el.addEventListener(event,e=>{if(!snapped){snapshot();snapped=true;}state.meta={...(state.meta||{}),[key]:transform(e.target.type==='checkbox'?e.target.checked:e.target.value)};redrawMetaOnly();updateStatus();schedulePersist();});
  }
  function updatePrivacyControls(){
    const enabled=!!state.meta?.anonymize,$btn=$('#anonymizeBtn');$btn.textContent=enabled?'匿名化：開':'匿名化：關';$btn.setAttribute('aria-pressed',String(enabled));$('#anonymizeToggle').checked=enabled;
  }
  function setAnonymize(enabled){snapshot();state.meta={...(state.meta||{}),anonymize:!!enabled};render();persist();syncMetaControls();showToast(enabled?'已啟用匿名顯示與匯出':'已關閉匿名顯示');}
  bindMetaInput('#metaTitle','title');bindMetaInput('#metaSubtitle','subtitle');bindMetaInput('#showRiskMarkers','showRiskMarkers','change',Boolean);
  $('#snapToGrid').addEventListener('change',e=>setGridEnabled(e.target.checked));
  $('#gridToggleBtn').addEventListener('click',()=>setGridEnabled(!isGridEnabled()));
  $('#alignAllToGridBtn').addEventListener('click',()=>alignAllToGrid(true));
  $('#anonymizeBtn').addEventListener('click',()=>setAnonymize(!state.meta?.anonymize));
  $('#anonymizeToggle').addEventListener('change',e=>setAnonymize(e.target.checked));
  $('#anonymizeMode').addEventListener('change',e=>{snapshot();state.meta.anonymizeMode=e.target.value;render();persist();});
  $('#anonymizeHideNotes').addEventListener('change',e=>{snapshot();state.meta.anonymizeHideNotes=e.target.checked;render();persist();});
  $('#touchLongPress').addEventListener('change',e=>{snapshot();state.meta.touchLongPress=e.target.checked;persist();});
  $('#nudgeStep').addEventListener('change',e=>{snapshot();state.meta.nudgeStep=Number(e.target.value)||2;persist();renderInspector();});
  const versionDialog=$('#versionDialog');$('#versionBtn').addEventListener('click',()=>versionDialog.showModal());$('#closeVersionBtn').addEventListener('click',()=>versionDialog.close());

  $('#parseBtn').addEventListener('click',()=>applyParsed($('#quickInput').value));
  $('#sampleBtn').addEventListener('click',()=>{$('#quickInput').value=`個案：女性，80歲，在家照顧\n配偶：男性，已歿\n長男：55歲，婚配三次，第一次有1子28歲，第二次無子女，第三次有1女16歲\n次女：50歲，未婚\n三女：48歲，已婚，育有一子(15歲)`;});
  $$('[data-add-node]').forEach(b=>b.addEventListener('click',()=>addNode(b.dataset.addNode)));
  $('#addFrameBtn').addEventListener('click',addFrame);
  $('#addTextBtn').addEventListener('click',addText);
  $('#autoLayoutBtn').addEventListener('click',()=>autoLayout(true));
  $('#undoBtn').addEventListener('click',undo);
  $('#redoBtn').addEventListener('click',redo);
  $('#clearBtn').addEventListener('click',clearAll);
  $('#saveProjectBtn').addEventListener('click',saveProject);
  $('#loadProjectInput').addEventListener('change',e=>{if(e.target.files[0])loadProject(e.target.files[0]);e.target.value=''});
  $('#exportSvgBtn').addEventListener('click',exportSvg);
  $('#exportPngBtn').addEventListener('click',exportPng);
  $('#printBtn').addEventListener('click',()=>window.print());
  $('#zoomInBtn').addEventListener('click',()=>setZoom(.85));
  $('#zoomOutBtn').addEventListener('click',()=>setZoom(1.18));
  $('#zoomResetBtn').addEventListener('click',resetZoom);
  $('#fitBtn').addEventListener('click',fitContent);

  const relationDialog=$('#relationDialog');
  $('#addRelationBtn').addEventListener('click',()=>{
    if(state.nodes.length<2) return showToast('至少需要兩位人物');
    populateRelationSelects();updateRelationDialogFields();relationDialog.showModal();
  });
  $('#cancelRelationBtn').addEventListener('click',()=>relationDialog.close());
  function updateRelationDialogFields(){
    const type=$('#relationType').value;
    $('#partnerStatusField').style.display=type==='partner'?'grid':'none';
    const subtypeField=$('#relationSubtypeField');
    const config={
      parent:{label:'親子關係細類',options:[['biological','親生'],['adopted','收養'],['foster','寄養']],hint:'收養以長虛線、寄養以點狀虛線表示。'},
      twins:{label:'雙胞胎類型',options:[['unknownTwins','類型未明'],['identical','同卵'],['fraternal','異卵']],hint:'請將起點與終點選為兩名雙胞胎手足。'},
      abuse:{label:'施暴／受暴類型',options:[['physical','身體暴力'],['emotional','精神暴力'],['sexual','性暴力'],['economic','經濟控制'],['neglect','疏忽／遺棄'],['otherAbuse','其他暴力']],hint:'起點＝施暴者，終點＝受暴者；圖面以紅色鋸齒箭頭表示。'}
    }[type];
    subtypeField.style.display=config?'grid':'none';
    if(config){
      $('#relationSubtypeLabel').textContent=config.label;
      $('#relationSubtype').innerHTML=config.options.map(([v,l])=>`<option value="${v}">${l}</option>`).join('');
      $('#relationSubtypeHint').textContent=config.hint;
    }
  }
  $('#relationType').addEventListener('change',updateRelationDialogFields);
  $('#confirmRelationBtn').addEventListener('click',()=>{
    const from=$('#relationFrom').value,to=$('#relationTo').value;
    if(from===to) return showToast('起點與終點不能相同');
    snapshot();
    addRelation(from,to,$('#relationType').value,{status:$('#partnerStatus').value,subtype:$('#relationSubtypeField').style.display==='none'?'':$('#relationSubtype').value,label:$('#relationLabel').value.trim()});
    relationDialog.close();render();persist();
  });

  $('#inspectorToggleBtn').addEventListener('click',()=>$('#rightPanel').classList.toggle('open'));
  $('#closeInspectorBtn').addEventListener('click',()=>$('#rightPanel').classList.remove('open'));

  document.addEventListener('keydown',evt=>{
    const tag=document.activeElement?.tagName;
    if((evt.key==='Delete'||evt.key==='Backspace') && state.selected && !['INPUT','TEXTAREA','SELECT'].includes(tag)){
      const {kind,id}=state.selected;deleteSelected(kind,id);
    }
    if((evt.ctrlKey||evt.metaKey)&&evt.key.toLowerCase()==='z'){evt.preventDefault();evt.shiftKey?redo():undo()}
    if((evt.ctrlKey||evt.metaKey)&&evt.key.toLowerCase()==='y'){evt.preventDefault();redo()}
  });

  $('#versionBadge').textContent=`V${APP_VERSION}`;
  const restoredVersion=restore();
  syncMetaControls();
  if(!state.nodes.length){
    applyParsed($('#quickInput').value);history=[];future=[];
  }else if(restoredVersion<5.1){
    // V5.1 首次載入會修補舊專案缺少的「婚姻聯結 ID」，並重新對齊同世代。
    repairMissingCoParentsByGeometry();inferParentUnionIds();autoLayout(false);history=[];future=[];persist();
    showToast('已升級為 V5.1：修正第三任配偶子女的婚姻線中點連接');
  }else{
    inferParentUnionIds();render();persist();
  }
  window.__GENOGRAM_DEBUG__={
    version:APP_VERSION,
    getState:()=>JSON.parse(JSON.stringify({...state,selected:null})),
    repair:()=>{repairMissingCoParentsByGeometry();inferParentUnionIds();autoLayout(false);return true;}
  };

})();
