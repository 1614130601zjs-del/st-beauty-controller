import { extension_settings } from '/scripts/extensions.js';
import { saveSettingsDebounced } from '/script.js';

const EXT = 'stBeautyController';
const defaults = { adjustments: {}, images: {}, themes: {}, activeTheme: null };
const state = {
    picking: false,
    hit: null,
    key: null,
    original: null,
    panel: null,
    activeLayer: 'background',
    scanHits: [],
    scanned: false,
};

const cfg = () => {
    if (!extension_settings[EXT]) extension_settings[EXT] = structuredClone(defaults);
    const c = extension_settings[EXT];
    for (const [k, v] of Object.entries(defaults)) if (c[k] === undefined) c[k] = structuredClone(v);
    return c;
};
const save = () => { try { saveSettingsDebounced(); } catch {} };

// ============================================================
// 命中检测：移植自 duangduang/index.js，页面全局通用（不限于聊天区）。
// 支持 IMG / CANVAS / SVG image / CSS 背景图，兼容同源 iframe 与开放 Shadow DOM，
// 并能从 <a><img></a> 这类图链常见结构里反查真正的图片（原版缺失，已补）。
// 有意排除 #chat .mes_text（角色对话正文里的叙事配图），本插件只管美化皮肤自身
// 注入的装饰图，不碰聊天内容图。
// ============================================================
function isOwnUi(el) {
    return !!el.closest?.('.sbc-panel,.sbc-picker,.sbc-highlight,.sbc-scan-layer');
}
function isChatContent(el) {
    return !!el.closest?.('#chat .mes_text');
}
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
        if (isOwnUi(el) || isChatContent(el)) continue;
        const tag = el.tagName;
        if (tag === 'A') {
            const linked = el.querySelectorAll('img, canvas, svg image');
            for (const child of linked) {
                const r = child.getBoundingClientRect();
                if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
                if (child.tagName === 'IMG' && (child.currentSrc || child.src)) return { kind: 'img', el: child, ox, oy };
                if (child.tagName === 'CANVAS') return { kind: 'canvas', el: child, ox, oy };
                if (child.tagName === 'image') {
                    const href = child.getAttribute('href') || child.getAttribute('xlink:href');
                    if (href) return { kind: 'svgimg', el: child, href, ox, oy };
                }
            }
        }
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

// ============================================================
// 稳定 key：用原始资源 URL 作为标识，而不是随机生成的 dataset id。
// 这样下次刷新页面、皮肤重新渲染出同一张图时，还能用 URL 对上号，
// 把保存过的换图/调色自动重新套用——这是"绑定美化、一键复用"能成立的前提。
// Canvas 没有可比较的原始 URL，退化为本次会话内的随机 id（不持久化，仅标注）。
// ============================================================
function originalUrlOf(hit) {
    if (hit.kind === 'css') return hit.url || '';
    if (hit.kind === 'img') return hit.el.currentSrc || hit.el.src || '';
    if (hit.kind === 'bg') return hit.url || '';
    if (hit.kind === 'svgimg') return hit.href || '';
    return '';
}
function targetKey(hit) {
    // CSS 规则来源的命中，用"选择器+属性"当 key——比 URL 更稳，同一条规则
    // 换图之后 URL 会变，但选择器+属性不会变，刷新/切皮肤后还能对上号。
    if (hit.kind === 'css') return 'c:' + hit.selector + '|' + hit.property;
    const url = originalUrlOf(hit);
    if (url) return 'u:' + url;
    if (!hit.el.dataset.sbcId) hit.el.dataset.sbcId = 'sbc-' + Math.random().toString(36).slice(2, 10);
    return 'e:' + hit.el.dataset.sbcId;
}

// ============================================================
// IndexedDB：保存用户上传的替换图二进制数据，key 为上面的稳定 key。
// ============================================================
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
async function deleteImage(key) {
    const db = await dbOpen();
    await new Promise(resolve => { const tx = db.transaction('images', 'readwrite'); tx.objectStore('images').delete(key); tx.oncomplete = resolve; });
    db.close();
}

// ============================================================
// 调色：三层（背景层/装饰层/整体层）各自独立的色相/饱和度/亮度/对比度，
// 叠加后用 CSS filter 直接作用在命中的元素本身——不是在页面上盖一层
// 半透明色块，所以不会有"蒙了层滤镜"那种发灰发脏的观感。
// ============================================================
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

// ============================================================
// CSS 规则覆盖层：直接读酒馆"自定义CSS"(#custom-style，即
// power_user.custom_css)的样式表源码，把换图/调色写成一条新规则，
// 追加到我们自己的 <style id="sbc-override-style">，用 !important
// 盖过原规则。比逐个 DOM 元素去改更稳：原选择器以后匹配到的任何
// 元素(包括还没渲染出来的、:hover、::before/::after 这类根本点
// 不到的伪元素)都会自动吃到这条覆盖规则，不需要监听 DOM 变化重新套用。
// ============================================================
const objectUrlCache = new Map();
function invalidateReplacementUrl(key) {
    const existing = objectUrlCache.get(key);
    if (existing) { try { URL.revokeObjectURL(existing); } catch {} }
    objectUrlCache.delete(key);
}
async function getReplacementUrl(key) {
    if (objectUrlCache.has(key)) return objectUrlCache.get(key);
    try {
        const blob = await readImage(key);
        if (!blob) return '';
        const url = URL.createObjectURL(blob);
        objectUrlCache.set(key, url);
        return url;
    } catch { return ''; }
}
function cssFilterString(key) {
    const layers = ['background', 'decoration', 'overall'].map(layer => getAdjustment(key, layer));
    const hue = layers.reduce((n, a) => n + Number(a.hue || 0), 0);
    const sat = layers.reduce((n, a) => n * Number(a.saturation || 100) / 100, 1) * 100;
    const bright = layers.reduce((n, a) => n * Number(a.brightness || 100) / 100, 1) * 100;
    const contrast = layers.reduce((n, a) => n * Number(a.contrast || 100) / 100, 1) * 100;
    const parts = [];
    if (hue) parts.push(`hue-rotate(${hue}deg)`);
    if (sat !== 100) parts.push(`saturate(${sat}%)`);
    if (bright !== 100) parts.push(`brightness(${bright}%)`);
    if (contrast !== 100) parts.push(`contrast(${contrast}%)`);
    return parts.join(' ');
}
async function rebuildOverrideStyle() {
    const c = cfg();
    const keys = new Set([...Object.keys(c.adjustments), ...Object.keys(c.images)].filter(k => k.startsWith('c:')));
    const lines = [];
    for (const key of keys) {
        const rest = key.slice(2);
        const sep = rest.lastIndexOf('|');
        if (sep < 0) continue;
        const selector = rest.slice(0, sep);
        const property = rest.slice(sep + 1);
        const decls = [];
        if (c.images[key]) {
            const url = await getReplacementUrl(key);
            if (url) decls.push(`${property}: url("${url}") !important`);
        }
        const filter = cssFilterString(key);
        if (filter) decls.push(`filter: ${filter} !important`);
        if (decls.length) lines.push(`${selector} { ${decls.join('; ')}; }`);
    }
    let el = document.getElementById('sbc-override-style');
    if (!el) { el = document.createElement('style'); el.id = 'sbc-override-style'; document.head.appendChild(el); }
    el.textContent = lines.join('\n');
}
let overrideRaf = 0;
function scheduleOverrideRebuild() {
    if (overrideRaf) return;
    overrideRaf = requestAnimationFrame(() => { overrideRaf = 0; rebuildOverrideStyle(); });
}

// ============================================================
// 自动复用：扫描到的元素如果 key 命中已保存的换图/调色，直接套用，
// 不需要用户重新手动点一遍——这是"刷新酒馆/切换美化后自动复用"的关键。
// 这部分只处理 DOM 元素来源的命中；CSS 规则来源的命中由上面的覆盖层
// 统一处理，不需要逐元素重新套用。
// ============================================================
async function autoApply(hit) {
    const key = targetKey(hit);
    const saved = cfg().images[key];
    if (saved) {
        try {
            const blob = await readImage(key);
            if (blob) replaceTarget(hit, URL.createObjectURL(blob));
        } catch {}
    }
    if (cfg().adjustments[key]) applyAdjustment(hit.el, key);
}
async function autoApplyAll() {
    for (const hit of scanPageTargets()) {
        if (hit.el.dataset.sbcApplied) continue;
        hit.el.dataset.sbcApplied = '1';
        await autoApply(hit);
    }
}

// ============================================================
// 扫描：在整个页面(排除聊天正文、排除插件自身 UI)里找候选装饰图，
// 用于"美化管理器"里的图片网格列表。手动点选(duangduang 式)仍保留，
// 作为扫描覆盖不到的情况(iframe、Shadow DOM 深层元素)的兜底。
// ============================================================
function scanHitFor(el) {
    if (isOwnUi(el) || isChatContent(el)) return null;
    const tag = el.tagName;
    if (tag === 'IMG' && (el.currentSrc || el.src)) return { kind: 'img', el };
    if (tag === 'CANVAS') return { kind: 'canvas', el };
    if (tag === 'image') {
        const href = el.getAttribute('href') || el.getAttribute('xlink:href');
        if (href) return { kind: 'svgimg', el, href };
    }
    const url = ddBgUrl(el);
    return url ? { kind: 'bg', el, url } : null;
}
function scanPageTargets() {
    const found = new Map();
    const candidates = document.querySelectorAll('img, canvas, svg image, [class], [style]');
    let checked = 0;
    for (const el of candidates) {
        if (found.has(el)) continue;
        if (++checked > 6000) break; // 一次性手动扫描的保护上限，避免超大页面卡顿
        const hit = scanHitFor(el);
        if (!hit) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) continue;
        found.set(el, hit);
    }
    return [...found.values()];
}

// ============================================================
// CSS 源扫描：直接读酒馆"自定义CSS"注入的样式表(#custom-style)，
// 逐条规则找 background/border-image/mask/list-style-image/content
// 里的 url(...)，连同它所在的选择器一起记下来。
// 比逐元素扫描更准——不依赖这条规则此刻有没有元素正在用它(:hover、
// 还没打开的弹窗、::before/::after 伪元素都抓得到)，这些是纯 DOM
// 点选完全够不到的。跟着 @import 追一层外部样式表，深度有限，
// 跨域且没开 CORS 的 @import 读不到内容时会跳过，不报错。
// ============================================================
const CSS_IMAGE_PROPS = {
    'background-image': 'background-image',
    'background': 'background-image',
    'border-image': 'border-image-source',
    'border-image-source': 'border-image-source',
    'mask-image': 'mask-image',
    'mask': 'mask-image',
    '-webkit-mask-image': '-webkit-mask-image',
    'list-style-image': 'list-style-image',
    'content': 'content',
};
function extractCssImageRefs(rule, acc) {
    if (!rule.selectorText || !rule.style) return;
    for (const [srcProp, overrideProp] of Object.entries(CSS_IMAGE_PROPS)) {
        let val = '';
        try { val = rule.style.getPropertyValue(srcProp); } catch {}
        if (!val || !val.includes('url(')) continue;
        const re = /url\((['"]?)(.*?)\1\)/g;
        let m;
        while ((m = re.exec(val))) {
            if (!m[2]) continue;
            let abs;
            try { abs = new URL(m[2], location.href).href; } catch { abs = m[2]; }
            acc.push({ selector: rule.selectorText, property: overrideProp, url: abs });
        }
    }
}
function walkCssRules(container, acc, depth = 0) {
    if (depth > 4) return;
    let rules;
    try { rules = container.cssRules; } catch { return; }
    if (!rules) return;
    for (const rule of rules) {
        if (typeof CSSImportRule !== 'undefined' && rule instanceof CSSImportRule) {
            if (rule.styleSheet) walkCssRules(rule.styleSheet, acc, depth + 1);
            continue;
        }
        if (rule.cssRules) { walkCssRules(rule, acc, depth + 1); continue; } // @media / @supports / @layer 等分组规则
        extractCssImageRefs(rule, acc);
    }
}
function scanCssTargets() {
    const acc = [];
    const styleEl = document.getElementById('custom-style');
    if (styleEl?.sheet) walkCssRules(styleEl.sheet, acc);
    const seen = new Set();
    const out = [];
    for (const e of acc) {
        const k = e.selector + '|' + e.property + '|' + e.url;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ kind: 'css', ...e });
    }
    return out;
}

// ============================================================
// 面板 UI
// ============================================================
function thumbFor(hit) {
    const url = originalUrlOf(hit);
    if (hit.kind === 'canvas') {
        try { return hit.el.toDataURL('image/png'); } catch { return ''; }
    }
    return url;
}
function labelFor(hit) {
    if (hit.kind === 'css') return 'CSS·' + hit.property;
    return hit.kind === 'img' ? '图片' : hit.kind === 'bg' ? '背景图' : hit.kind === 'canvas' ? 'Canvas' : 'SVG图';
}
function renderManagerGrid(panel) {
    const grid = panel.querySelector('.sbc-grid');
    grid.replaceChildren();
    if (!state.scanned) {
        grid.innerHTML = '<p class="sbc-hint">点击上方"扫描美化元素"查看当前页面的装饰图片</p>';
        return;
    }
    if (!state.scanHits.length) {
        grid.innerHTML = '<p class="sbc-hint">没有扫描到装饰图片，试试"手动选择"直接在页面上点</p>';
        return;
    }
    for (const hit of state.scanHits) {
        const key = targetKey(hit);
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'sbc-grid-item';
        const thumb = thumbFor(hit);
        cell.innerHTML = thumb
            ? `<img src="${thumb}" alt="" loading="lazy"><span>${labelFor(hit)}</span>`
            : `<span class="sbc-grid-empty">${labelFor(hit)}</span>`;
        if (cfg().images[key] || cfg().adjustments[key]) cell.classList.add('sbc-grid-item--edited');
        cell.addEventListener('click', () => selectHit(hit));
        grid.append(cell);
    }
}
function renderPanel() {
    const root = document.createElement('div');
    root.className = 'sbc-root';
    root.innerHTML = `
      <section class="sbc-panel" role="dialog" aria-label="美化管理器">
        <header><div><strong>美化管理器</strong><small class="sbc-subtitle">管理皮肤装饰图，调整色彩，不改动原文件</small></div><button type="button" data-action="close" aria-label="关闭">×</button></header>
        <div class="sbc-actions"><button type="button" class="sbc-primary" data-action="scan">扫描美化元素</button><button type="button" data-action="pick">手动选择</button></div>
        <div class="sbc-grid"></div>
        <div class="sbc-theme">
          <select class="sbc-theme-select"><option value="">未绑定方案</option></select>
          <button type="button" data-action="theme-save" title="把当前换图/调色保存为一个方案">保存方案</button>
          <button type="button" data-action="theme-export" title="导出为文件，不占用插件存储">导出</button>
          <label class="sbc-upload" title="导入之前导出的方案文件">导入<input type="file" accept="application/json" hidden class="sbc-theme-import"></label>
        </div>
        <div class="sbc-divider"></div>
        <div class="sbc-selected">尚未选择元素</div>
        <div class="sbc-edit" hidden>
          <div class="sbc-actions"><label class="sbc-upload">替换为本地图片<input type="file" accept="image/*" hidden class="sbc-replace-input"></label><button type="button" data-action="restore">恢复原图</button></div>
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
        </div>
      </section>`;
    const panel = root.querySelector('.sbc-panel');
    panel.addEventListener('click', e => {
        const button = e.target.closest('button');
        if (!button) return;
        const action = button.dataset.action;
        if (action === 'close') { stopPicking(); panel.remove(); state.panel = null; }
        if (action === 'scan') runScan(panel);
        if (action === 'pick') startPicking();
        if (action === 'restore') restoreOriginal(panel);
        if (action === 'theme-save') saveTheme(panel);
        if (action === 'theme-export') exportTheme();
        if (action === 'reset' && state.hit) {
            const all = cfg().adjustments[state.key] || {};
            delete all[state.activeLayer]; save();
            if (state.hit.kind === 'css') scheduleOverrideRebuild(); else applyAdjustment(state.hit.el, state.key);
            syncPanel(panel);
        }
        if (button.dataset.layer) {
            state.activeLayer = button.dataset.layer;
            panel.querySelectorAll('[data-layer]').forEach(b => b.classList.toggle('active', b === button));
            syncPanel(panel);
        }
    });
    panel.querySelector('.sbc-replace-input').addEventListener('change', async e => {
        const file = e.target.files?.[0]; e.target.value = '';
        if (!file || !state.hit) return;
        const blob = file.slice(0, file.size, file.type);
        try {
            await storeImage(state.key, blob);
            cfg().images[state.key] = { type: file.type, name: file.name }; save();
            if (state.hit.kind === 'css') {
                invalidateReplacementUrl(state.key);
                await rebuildOverrideStyle();
            } else {
                replaceTarget(state.hit, URL.createObjectURL(blob));
            }
            panel.querySelector('.sbc-selected').textContent = '已替换：' + file.name;
            renderManagerGrid(panel);
        } catch (err) { console.error('[美化管理器] 图片保存失败', err); }
    });
    panel.querySelector('.sbc-theme-import').addEventListener('change', e => {
        const file = e.target.files?.[0]; e.target.value = '';
        if (file) importTheme(file, panel);
    });
    panel.querySelector('.sbc-theme-select').addEventListener('change', e => applyTheme(e.target.value, panel));
    panel.querySelectorAll('[data-field]').forEach(input => input.addEventListener('input', () => setControl(input.dataset.field, input.value, panel)));
    document.body.append(panel);
    state.panel = panel;
    syncThemeSelect(panel);
    renderManagerGrid(panel);
    return root;
}
function setControl(field, value, panel) {
    if (!state.hit) return;
    const all = cfg().adjustments;
    if (!all[state.key]) all[state.key] = {};
    if (!all[state.key][state.activeLayer]) all[state.key][state.activeLayer] = { hue: 0, saturation: 100, brightness: 100, contrast: 100 };
    all[state.key][state.activeLayer][field] = Number(value);
    save();
    if (state.hit.kind === 'css') scheduleOverrideRebuild(); else applyAdjustment(state.hit.el, state.key);
    const out = panel.querySelector(`[data-value="${field}"]`);
    if (out) out.textContent = field === 'hue' ? value + '°' : value + '%';
}
function syncPanel(panel) {
    if (!state.hit) return;
    const a = getAdjustment(state.key, state.activeLayer);
    for (const field of ['hue', 'saturation', 'brightness', 'contrast']) {
        const input = panel.querySelector(`[data-field="${field}"]`);
        input.value = a[field];
        panel.querySelector(`[data-value="${field}"]`).textContent = field === 'hue' ? a[field] + '°' : a[field] + '%';
    }
}
async function selectHit(hit) {
    if (!hit || !state.panel) return;
    stopPicking();
    state.hit = hit;
    state.key = targetKey(hit);
    state.panel.querySelector('.sbc-edit').hidden = false;
    if (hit.kind === 'css') {
        state.original = hit.url;
        state.panel.querySelector('.sbc-selected').textContent = '已选中 CSS 规则：' + hit.selector;
    } else {
        state.panel.querySelector('.sbc-selected').textContent = '正在读取原图…';
        state.original = await ddSourceOf(hit);
        state.panel.querySelector('.sbc-selected').textContent = '已选中：' + labelFor(hit);
    }
    syncPanel(state.panel);
}
async function restoreOriginal(panel) {
    if (!state.hit) return;
    if (state.hit.kind === 'css') {
        invalidateReplacementUrl(state.key);
        await deleteImage(state.key).catch(() => {});
        delete cfg().images[state.key];
        delete cfg().adjustments[state.key];
        save();
        await rebuildOverrideStyle();
        panel.querySelector('.sbc-selected').textContent = '已清除这条 CSS 规则的改动';
    } else {
        if (!state.original) return;
        replaceTarget(state.hit, state.original);
        await deleteImage(state.key).catch(() => {});
        delete cfg().images[state.key]; save();
        panel.querySelector('.sbc-selected').textContent = '已恢复页面原图';
    }
    renderManagerGrid(panel);
}
function runScan(panel) {
    // CSS 源的规则排在前面：这是更可靠的来源，优先展示。
    state.scanHits = [...scanCssTargets(), ...scanPageTargets()];
    state.scanned = true;
    renderManagerGrid(panel);
}

// ---- 手动点选：扫描覆盖不到时的兜底（iframe / Shadow DOM 深层元素等） ----
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
    if (isOwnUi(e.target)) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    const hit = ddFindAt(e.clientX, e.clientY);
    if (!hit) return;
    stopPicking();
    await selectHit(hit);
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

// ============================================================
// 美化方案：把当前换图+调色打包保存在插件设置里，下次一键套用；
// 也可以导出成独立 json 文件（不占插件存储），以后再导入复用或分享备份。
// 图片以 base64 内嵌进导出文件，做到真正自包含、单文件可带走。
// ============================================================
function syncThemeSelect(panel) {
    const select = panel.querySelector('.sbc-theme-select');
    const themes = cfg().themes;
    const current = select.value;
    select.replaceChildren(new Option('未绑定方案', ''));
    for (const name of Object.keys(themes)) select.append(new Option(name, name));
    select.value = cfg().activeTheme && themes[cfg().activeTheme] ? cfg().activeTheme : current;
}
function saveTheme(panel) {
    const name = prompt('给这套换图/调色方案起个名字（会和当前皮肤绑定，方便以后一键复用）：', cfg().activeTheme || '');
    if (!name) return;
    const c = cfg();
    c.themes[name] = { adjustments: structuredClone(c.adjustments), images: structuredClone(c.images) };
    c.activeTheme = name;
    save();
    syncThemeSelect(panel);
    panel.querySelector('.sbc-theme-select').value = name;
}
async function applyTheme(name, panel) {
    const c = cfg();
    if (!name) { c.activeTheme = null; save(); return; }
    const theme = c.themes[name];
    if (!theme) return;
    c.adjustments = structuredClone(theme.adjustments);
    c.images = structuredClone(theme.images);
    c.activeTheme = name;
    save();
    [...objectUrlCache.keys()].forEach(invalidateReplacementUrl);
    document.querySelectorAll('[data-sbc-applied]').forEach(el => delete el.dataset.sbcApplied);
    await rebuildOverrideStyle();
    await autoApplyAll();
    panel.querySelector('.sbc-selected').textContent = '已套用方案：' + name;
    renderManagerGrid(panel);
}
async function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}
async function dataUrlToBlob(dataUrl) {
    const res = await fetch(dataUrl);
    return res.blob();
}
async function exportTheme() {
    const c = cfg();
    const images = {};
    for (const key of Object.keys(c.images)) {
        try {
            const blob = await readImage(key);
            if (blob) images[key] = { ...c.images[key], data: await blobToDataUrl(blob) };
        } catch {}
    }
    const payload = { version: 1, exportedAt: new Date().toISOString(), adjustments: c.adjustments, images };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `st-beauty-controller-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
}
async function importTheme(file, panel) {
    try {
        const payload = JSON.parse(await file.text());
        const c = cfg();
        c.adjustments = { ...c.adjustments, ...(payload.adjustments || {}) };
        for (const [key, info] of Object.entries(payload.images || {})) {
            if (!info.data) continue;
            const blob = await dataUrlToBlob(info.data);
            await storeImage(key, blob);
            c.images[key] = { type: info.type, name: info.name };
        }
        save();
        [...objectUrlCache.keys()].forEach(invalidateReplacementUrl);
        document.querySelectorAll('[data-sbc-applied]').forEach(el => delete el.dataset.sbcApplied);
        await rebuildOverrideStyle();
        await autoApplyAll();
        panel.querySelector('.sbc-selected').textContent = '已导入方案';
        syncThemeSelect(panel);
        renderManagerGrid(panel);
    } catch (err) {
        console.error('[美化管理器] 导入失败', err);
        window.toastr?.error?.('方案文件读取失败，请确认是本插件导出的 json');
    }
}

// ============================================================
// 入口：挂到魔法棒菜单。面板用 position:fixed 直接居中挂在 body 上，
// 不套未定宽高的包裹层——这是之前弹窗定位失败的根因，已验证修复。
// ============================================================
function mount() {
    if (document.querySelector('#sbc-magic-button')) return;
    const menu = document.querySelector('#extensionsMenu');
    if (!menu) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'sbc-magic-button';
    button.className = 'list-group-item flex-container flexGap5 sbc-wand-button';
    button.innerHTML = '<i class="fa-solid fa-sliders"></i><span>美化管理器</span>';
    const openPanel = (event) => {
        event.preventDefault();
        try {
            if (state.panel?.isConnected) {
                state.panel.remove();
                state.panel = null;
                stopPicking();
                return;
            }
            state.panel?.remove();
            state.panel = null;
            renderPanel();
        } catch (error) {
            console.error('[美化管理器] 面板打开失败', error);
            window.toastr?.error?.('美化管理器打开失败，请查看控制台错误');
        }
    };
    button.addEventListener('click', openPanel);
    button.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        openPanel(event);
    });
    const container = document.createElement('div');
    container.id = 'sbc-wand-container';
    container.className = 'extension_container';
    container.append(button);
    menu.append(container);
}
let autoApplyTimer = 0;
function scheduleAutoApply() {
    // 文生图/聊天消息渲染期间 DOM 变动很频繁，这里做防抖：
    // 变动停下来 500ms 后才扫一次，不在每次 mutation 都做全页查询。
    if (autoApplyTimer) clearTimeout(autoApplyTimer);
    autoApplyTimer = setTimeout(() => { autoApplyTimer = 0; autoApplyAll(); }, 500);
}
function init() {
    cfg();
    mount();
    rebuildOverrideStyle(); // CSS 规则覆盖层：全局生效一次就够，不用跟着 DOM 变化重复套用
    autoApplyAll();
    const observer = new MutationObserver(() => { mount(); scheduleAutoApply(); });
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('beforeunload', () => { observer.disconnect(); if (autoApplyTimer) clearTimeout(autoApplyTimer); }, { once: true });
    window.addEventListener('keydown', e => { if (e.key === 'Escape') stopPicking(); });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
