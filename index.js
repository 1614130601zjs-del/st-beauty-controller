import { extension_settings } from '/scripts/extensions.js';
import { saveSettingsDebounced } from '/script.js';

const EXT = 'stBeautyController';
const defaults = { enabled: true, adjustments: {}, images: {} };
const state = { picking: false, hit: null, panel: null, original: null, activeLayer: 'background' };
const cfg = () => {
    if (!extension_settings[EXT]) extension_settings[EXT] = structuredClone(defaults);
    const c = extension_settings[EXT];
    for (const [k, v] of Object.entries(defaults)) if (c[k] === undefined) c[k] = structuredClone(v);
    return c;
};
const save = () => { try { saveSettingsDebounced(); } catch {} };

// 图片命中逻辑移植自 duangduang/index.js：保留 iframe、开放 Shadow DOM、IMG、Canvas、SVG image 与 CSS 背景图识别。
function ddBgUrl(el) {
    const tag = el.tagName;
    if (tag === 'BODY' || tag === 'HTML' || el.id === 'bg1' || el.id === 'bg_custom') return '';
    const win = el.ownerDocument.defaultView;
    if (!win) return '';
    let bi = '';
    try { bi = win.getComputedStyle(el).backgroundImage; } catch { return ''; }
    const m = /url\((['"]?)(.*?)\1\)/.exec(bi || '');
    if (!m || !m[2]) return '';
    const r = el.getBoundingClientRect();
    if (r.width * r.height > .9 * win.innerWidth * win.innerHeight) return '';
    try { return new URL(m[2], el.ownerDocument.baseURI).href; } catch { return m[2]; }
}
function ddFlatList(root, x, y, depth = 0) {
    let list = [];
    try { list = root.elementsFromPoint(x, y); } catch {}
    const out = [];
    for (const el of list) {
        if (el.shadowRoot && depth < 4) { try { out.push(...ddFlatList(el.shadowRoot, x, y, depth + 1)); } catch {} }
        out.push(el);
    }
    return out;
}
function ddFindAt(x, y, doc = document, ox = 0, oy = 0, depth = 0) {
    const list = ddFlatList(doc, x, y);
    for (const el of list) {
        if (el.closest?.('.sbc-root,.sbc-picker,.sbc-highlight')) continue;
        const tag = el.tagName;
        if (tag === 'IFRAME') {
            if (depth >= 4) continue;
            try {
                const d = el.contentDocument;
                if (d) {
                    const r = el.getBoundingClientRect();
                    const hit = ddFindAt(x - r.left, y - r.top, d, ox + r.left, oy + r.top, depth + 1);
                    if (hit) return hit;
                }
            } catch {}
            continue;
        }
        if (tag === 'IMG' && (el.currentSrc || el.src)) return { kind: 'img', el, ox, oy };
        if (tag === 'CANVAS') return { kind: 'canvas', el, ox, oy };
        if (tag === 'image' && el.closest('svg')) {
            const href = el.getAttribute('href') || el.getAttribute('xlink:href');
            if (href) return { kind: 'svgimg', el, href, ox, oy };
        }
        const bg = ddBgUrl(el);
        if (bg) return { kind: 'bg', el, url: bg, ox, oy };
    }
    return null;
}
async function ddMaterialize(url) {
    if (!url) return '';
    if (/^(data|blob):/i.test(url)) return url;
    try { if (new URL(url, location.href).origin === location.origin) return url; } catch { return url; }
    try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 3000);
        const r = await fetch(url, { mode: 'cors', signal: ctl.signal });
        clearTimeout(timer);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return URL.createObjectURL(await r.blob());
    } catch { return url; }
}
async function ddSourceOf(hit) {
    if (hit.kind === 'img') return ddMaterialize(hit.el.currentSrc || hit.el.src);
    if (hit.kind === 'bg') return ddMaterialize(hit.url);
    if (hit.kind === 'svgimg') return ddMaterialize(hit.href);
    if (hit.kind === 'canvas') {
        try {
            return await new Promise((resolve, reject) => hit.el.toBlob(blob => blob ? resolve(URL.createObjectURL(blob)) : reject(new Error('empty')), 'image/png'));
        } catch {
            try { return hit.el.toDataURL('image/png'); } catch { return ''; }
        }
    }
    return '';
}

function dbOpen() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open('st-beauty-controller', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('images');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}
async function storeImage(key, blob) {
    const db = await dbOpen();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('images', 'readwrite');
        tx.objectStore('images').put(blob, key);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
    });
}
async function readImage(key) {
    const db = await dbOpen();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('images', 'readonly');
        const req = tx.objectStore('images').get(key);
        req.onsuccess = () => { db.close(); resolve(req.result || null); };
        req.onerror = () => { db.close(); reject(req.error); };
    });
}
function targetKey(el) {
    if (!el.dataset.sbcId) el.dataset.sbcId = 'sbc-' + Math.random().toString(36).slice(2, 10);
    return el.dataset.sbcId;
}
function getAdjustment(key, layer) {
    return cfg().adjustments[key]?.[layer] || { hue: 0, saturation: 100, brightness: 100, contrast: 100 };
}
function applyAdjustment(el, key) {
    const layers = ['background', 'decoration', 'overall'].map(layer => getAdjustment(key, layer));
    const hue = layers.reduce((n, a) => n + Number(a.hue || 0), 0);
    const sat = layers.reduce((n, a) => n * Number(a.saturation || 100) / 100, 1) * 100;
    const bright = layers.reduce((n, a) => n * Number(a.brightness || 100) / 100, 1) * 100;
    const contrast = layers.reduce((n, a) => n * Number(a.contrast || 100) / 100, 1) * 100;
    el.style.setProperty('filter', `hue-rotate(${hue}deg) saturate(${sat}%) brightness(${bright}%) contrast(${contrast}%)`, 'important');
    el.dataset.sbcAdjusted = '1';
}
function setControl(layer, field, value) {
    if (!state.hit) return;
    const key = targetKey(state.hit.el);
    const all = cfg().adjustments;
    if (!all[key]) all[key] = {};
    if (!all[key][layer]) all[key][layer] = { hue: 0, saturation: 100, brightness: 100, contrast: 100 };
    all[key][layer][field] = Number(value);
    save();
    applyAdjustment(state.hit.el, key);
    const out = state.panel?.querySelector(`[data-value="${field}"]`);
    if (out) out.textContent = field === 'hue' ? value + '°' : value + '%';
}
function renderPanel() {
    const root = document.createElement('div');
    root.className = 'sbc-root';
    root.innerHTML = `
      <section class="sbc-panel" role="dialog" aria-label="美化调节">
        <header><div><strong>美化调节</strong><small class="sbc-subtitle">选中页面元素，调整图片与色彩</small></div><button type="button" data-action="close" aria-label="关闭">×</button></header>
        <div class="sbc-actions"><button type="button" class="sbc-primary" data-action="pick">选择页面图片</button><label class="sbc-upload">替换为本地图片<input type="file" accept="image/*" hidden></label><button type="button" data-action="restore">恢复原图</button></div>
        <div class="sbc-selected">尚未选择元素</div>
        <nav class="sbc-layers">
          <button type="button" data-layer="background" class="active">背景层</button>
          <button type="button" data-layer="decoration">装饰层</button>
          <button type="button" data-layer="overall">整体层</button>
        </nav>
        <div class="sbc-controls">
          <label>色相 <output data-value="hue">0°</output><input data-field="hue" type="range" min="-180" max="180" value="0"></label>
          <label>饱和度 <output data-value="saturation">100%</output><input data-field="saturation" type="range" min="0" max="250" value="100"></label>
          <label>亮度 <output data-value="brightness">100%</output><input data-field="brightness" type="range" min="0" max="200" value="100"></label>
          <label>对比度 <output data-value="contrast">100%</output><input data-field="contrast" type="range" min="0" max="200" value="100"></label>
        </div>
        <footer><span>调整会自动保存</span><button type="button" data-action="reset">重置当前层</button></footer>
      </section>`;
    root.addEventListener('click', async e => {
        const button = e.target.closest('button');
        if (!button) return;
        const action = button.dataset.action;
        if (action === 'close') { stopPicking(); root.remove(); state.panel = null; }
        if (action === 'pick') startPicking();
        if (action === 'restore') restoreOriginal();
        if (action === 'reset' && state.hit) {
            const key = targetKey(state.hit.el);
            const all = cfg().adjustments[key] || {};
            delete all[state.activeLayer]; save(); applyAdjustment(state.hit.el, key); syncPanel();
        }
        if (button.dataset.layer) {
            state.activeLayer = button.dataset.layer;
            root.querySelectorAll('[data-layer]').forEach(b => b.classList.toggle('active', b === button));
            syncPanel();
        }
    });
    root.querySelector('input[type=file]').addEventListener('change', async e => {
        const file = e.target.files?.[0]; e.target.value = '';
        if (!file || !state.hit) return;
        const key = targetKey(state.hit.el);
        const blob = file.slice(0, file.size, file.type);
        try {
            await storeImage(key, blob);
            const url = URL.createObjectURL(blob);
            replaceTarget(state.hit, url);
            cfg().images[key] = { type: file.type, name: file.name }; save();
            root.querySelector('.sbc-selected').textContent = '已替换：' + file.name;
        } catch (err) { console.error('[美化调节] 图片保存失败', err); }
    });
    root.querySelectorAll('[data-field]').forEach(input => input.addEventListener('input', () => setControl(state.activeLayer, input.dataset.field, input.value)));
    document.body.append(root);
    state.panel = root;
    return root;
}
function replaceTarget(hit, url) {
    if (hit.kind === 'img') hit.el.src = url;
    else if (hit.kind === 'bg') hit.el.style.setProperty('background-image', `url("${url}")`, 'important');
    else if (hit.kind === 'svgimg') hit.el.setAttribute('href', url);
    else if (hit.kind === 'canvas') {
        const img = new Image();
        img.onload = () => { const c = hit.el.getContext('2d'); c.clearRect(0, 0, hit.el.width, hit.el.height); c.drawImage(img, 0, 0, hit.el.width, hit.el.height); };
        img.src = url;
    }
}
async function restoreOriginal() {
    if (!state.hit || !state.original) return;
    replaceTarget(state.hit, state.original);
    const key = targetKey(state.hit.el);
    const db = await dbOpen();
    await new Promise(resolve => { const tx = db.transaction('images', 'readwrite'); tx.objectStore('images').delete(key); tx.oncomplete = resolve; });
    db.close();
    delete cfg().images[key]; save();
    state.panel.querySelector('.sbc-selected').textContent = '已恢复页面原图';
}
function syncPanel() {
    if (!state.hit || !state.panel) return;
    const key = targetKey(state.hit.el);
    const a = getAdjustment(key, state.activeLayer);
    for (const field of ['hue', 'saturation', 'brightness', 'contrast']) {
        const input = state.panel.querySelector(`[data-field="${field}"]`);
        input.value = a[field];
        state.panel.querySelector(`[data-value="${field}"]`).textContent = field === 'hue' ? a[field] + '°' : a[field] + '%';
    }
}
function stopPicking() {
    if (!state.picking) return;
    state.picking = false;
    document.querySelector('.sbc-picker')?.remove();
    document.querySelector('.sbc-highlight')?.remove();
    window.removeEventListener('pointermove', onPickMove, true);
    window.removeEventListener('pointerdown', onPickDown, true);
}
let pickRaf = 0, lastPoint = null;
function onPickMove(e) {
    lastPoint = e;
    if (pickRaf) return;
    pickRaf = requestAnimationFrame(() => {
        pickRaf = 0;
        const hit = ddFindAt(lastPoint.clientX, lastPoint.clientY);
        const hl = document.querySelector('.sbc-highlight');
        if (!hl || !hit) { if (hl) hl.hidden = true; return; }
        const r = hit.el.getBoundingClientRect();
        hl.hidden = false;
        hl.style.cssText = `position:fixed;pointer-events:none;z-index:2147483646;left:${r.left + hit.ox}px;top:${r.top + hit.oy}px;width:${r.width}px;height:${r.height}px`;
    });
}
async function onPickDown(e) {
    if (e.target.closest?.('.sbc-root')) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    const hit = ddFindAt(e.clientX, e.clientY);
    if (!hit) return;
    stopPicking();
    state.hit = hit;
    state.original = await ddSourceOf(hit);
    const label = hit.kind === 'img' ? '图片元素' : hit.kind === 'bg' ? '背景图片' : hit.kind === 'canvas' ? 'Canvas 图片' : 'SVG 图片';
    state.panel.querySelector('.sbc-selected').textContent = '已选中：' + label;
    syncPanel();
}
function startPicking() {
    if (state.picking) return;
    state.picking = true;
    const cover = document.createElement('div');
    cover.className = 'sbc-picker';
    cover.innerHTML = '<span>点击要调整的图片或背景区域 · Esc 退出</span>';
    const hl = document.createElement('div'); hl.className = 'sbc-highlight'; hl.hidden = true;
    document.body.append(cover, hl);
    window.addEventListener('pointermove', onPickMove, true);
    window.addEventListener('pointerdown', onPickDown, true);
    const esc = e => { if (e.key === 'Escape') { stopPicking(); window.removeEventListener('keydown', esc, true); } };
    window.addEventListener('keydown', esc, true);
}
function mount() {
    if (document.querySelector('#sbc-magic-button')) return;
    const menu = document.querySelector('#extensionsMenu');
    if (!menu) return;
    const button = document.createElement('div');
    button.id = 'sbc-magic-button';
    button.className = 'list-group-item flex-container flexGap5';
    button.innerHTML = '<i class="fa-solid fa-sliders"></i><span>美化调节</span>';
    button.addEventListener('click', () => {
        if (state.panel) { state.panel.remove(); state.panel = null; stopPicking(); return; }
        renderPanel();
    });
    const container = document.createElement('div');
    container.id = 'sbc-wand-container';
    container.className = 'extension_container';
    container.append(button);
    menu.append(container);
}
function init() {
    cfg();
    mount();
    const observer = new MutationObserver(() => mount());
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('beforeunload', () => observer.disconnect(), { once: true });
    window.addEventListener('keydown', e => { if (e.key === 'Escape') stopPicking(); });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
