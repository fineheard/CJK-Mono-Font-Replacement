// ==UserScript==
// @name         CJK/Mono 字体替换
// @namespace    http://tampermonkey.net/
// @version      3.1.0
// @description  高性能、精准的 CJK 及等宽字体替换方案。通过三层防御机制（核心引擎、动态监听、哨兵轮询）实现对 iframe、Shadow DOM 及复杂动态内容的最强兼容。附带热键控制面板 (Ctrl+Shift+F)。
// @match        *://*/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(function () {
  'use strict';

  /*************************************************************************************************
   *
   *  设计哲学 (DESIGN PHILOSOPHY)
   *
   *  本脚本采用三层防御体系，以确保在各类静态、动态及复杂单页应用 (SPA) 中实现稳定可靠的字体替换。
   *
   *  1. 核心引擎 (Core Engine):
   *     - 使用 `TreeWalker` 高效遍历文本节点，结合 `requestIdleCallback` 在浏览器空闲时进行批量处理。
   *     - 这是脚本的基础，保证了在静态页面上的高性能和低资源占用。
   *
   *  2. 动态监听 (Dynamic Monitoring):
   *     - 通过 `MutationObserver` 实时监控 DOM 变化，捕获动态添加的内容（包括 iframe 和 Shadow DOM）。
   *     - 确保了在常规的动态页面（如 Ajax 加载、组件渲染）中的即时响应能力。
   *
   *  3. 哨兵轮询 (Sentinel Polling):
   *     - 作为一个强有力的“兜底”机制，它会在页面加载后的短时间内，周期性地巡视整个页面。
   *     - 主动寻找并处理那些可能因复杂加载逻辑（竞速条件）而被前两层防御遗漏的 iframe。
   *     - 这是应对 `babie.cc` 这类“疑难杂症”网站的终极武器，保证了最终的兼容性和稳定性。
   *
   *************************************************************************************************/

  /******************************
   * 1. 配置与常量
   ******************************/
  const STORAGE_KEY = 'CJK_MONO_FONT_CONFIG';
  const PATCH_ATTR = 'data-cjk-patched';
  const ORIG_ATTR = 'data-cjk-orig-font';
  const BATCH_SIZE = 300;
  const IDLE_TIMEOUT_MS = 200;
  const CURRENT_HOST = location.hostname;
  const CJK_REGEX = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

  const DEFAULT_CONFIG = {
    enabled: true,
    siteBlacklist: [],
    font: {
      cjk: 'KingHwaOldSong-GB',
      code: 'NewComputerModernMono10',
    },
    unicodeRange: [
      'U+2E80-2EFF', 'U+2F00-2FDF', 'U+3000-303F', 'U+31C0-31EF',
      'U+3400-4DBF', 'U+4E00-9FFF', 'U+F900-FAFF', 'U+20000-2A6DF',
      'U+2A700-2B73F', 'U+2B740-2B81F', 'U+2B820-2CEAF', 'U+2B820-2CEAF',
      'U+30000-3134F', 'U+31350-323AF'
    ].join(', '),
  };

  const FONT_CHOICES = {
    cjk: ['KingHwaOldSong-GB', 'Songti SC Regular', 'Noto Serif SC', 'FangSong', 'KaiTi', 'SimSun'],
    code: ['NewComputerModernMono10', 'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Courier New'],
  };

  const CONFIG = {};
  const processedIframes = new WeakSet(); // 跟踪已处理的iframe，避免重复工作

  /******************************
   * 2. 配置管理
   ******************************/
  async function loadConfig() {
    const saved = await GM_getValue(STORAGE_KEY, {});
    Object.assign(CONFIG, DEFAULT_CONFIG, saved, {
      font: { ...DEFAULT_CONFIG.font, ...(saved.font || {}) },
      siteBlacklist: saved.siteBlacklist || [],
    });
  }

  async function saveConfig() {
    await GM_setValue(STORAGE_KEY, CONFIG);
  }

  const isSiteBlacklisted = () => CONFIG.siteBlacklist.some(d => CURRENT_HOST.includes(d));
  const isPatchActive = () => CONFIG.enabled && !isSiteBlacklisted();

  /******************************
   * 3. 样式注入
   ******************************/
  function injectGlobalStyle(doc = document) {
    if (!doc.head) return;
    const oldStyle = doc.getElementById('cjk-mono-patch-style');
    if (oldStyle) oldStyle.remove();
    if (!isPatchActive()) return;

    const css = `
      @font-face {
        font-family: "CJKPatch";
        src: local("${CONFIG.font.cjk}");
        unicode-range: ${CONFIG.unicodeRange};
      }
      code, pre, kbd, samp {
        font-family: "${CONFIG.font.code}", monospace !important;
        font-variant-ligatures: none;
      }
    `;
    const newStyle = doc.createElement('style');
    newStyle.id = 'cjk-mono-patch-style';
    newStyle.textContent = css;
    doc.head.appendChild(newStyle);
  }

  /******************************
   * 4. 核心：扫描与修补
   ******************************/
  const pendingNodesMap = new WeakMap();
  const idleCallbackMap = new WeakMap();
  const ric = window.requestIdleCallback || ((cb) => setTimeout(() => cb({ timeRemaining: () => 50 }), IDLE_TIMEOUT_MS));
  const cancelRic = window.cancelIdleCallback || clearTimeout;

  function collectTextNodes(rootNode) {
    if (!rootNode || !isPatchActive()) return;

    const doc = rootNode.ownerDocument || rootNode;
    if (!pendingNodesMap.has(doc)) {
        pendingNodesMap.set(doc, []);
    }
    const pendingTextNodes = pendingNodesMap.get(doc);

    const effectiveRoot = rootNode.nodeType === 1 || rootNode.nodeType === 11 ? rootNode : doc.body;
    if (!effectiveRoot) return;

    const walker = doc.createTreeWalker(effectiveRoot, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeValue && CJK_REGEX.test(node.nodeValue)) {
          return NodeFilter.FILTER_ACCEPT;
        }
        return NodeFilter.FILTER_REJECT;
      }
    });

    while (walker.nextNode()) {
      pendingTextNodes.push(walker.currentNode);
    }

    if (typeof effectiveRoot.querySelectorAll === 'function') {
        try {
            effectiveRoot.querySelectorAll('*').forEach(el => {
                if (el.shadowRoot) {
                    collectTextNodes(el.shadowRoot);
                }
            });
        } catch(e) {}
    }
    scheduleProcessing(doc);
  }

  function scheduleProcessing(doc) {
    if (idleCallbackMap.has(doc) && idleCallbackMap.get(doc) !== null) return;
    const handle = ric(() => processPendingNodes(doc), { timeout: IDLE_TIMEOUT_MS });
    idleCallbackMap.set(doc, handle);
  }

  function findPatchableElement(textNode) {
    let el = textNode.parentElement;
    while (el) {
      const tag = el.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEXTAREA') return null;
      return el;
    }
    return null;
  }

  function applyPatchToElement(el) {
    if (!el || el.nodeType !== 1 || el.hasAttribute(PATCH_ATTR)) return;
    try {
      el.setAttribute(ORIG_ATTR, el.style.fontFamily);
      const computedFamily = getComputedStyle(el).fontFamily;
      if (computedFamily.includes('CJKPatch')) {
        el.setAttribute(PATCH_ATTR, 'computed'); return;
      }
      el.style.setProperty('font-family', `"CJKPatch", ${computedFamily}`, 'important');
      el.setAttribute(PATCH_ATTR, 'inlined');
    } catch (e) {}
  }

  function processPendingNodes(doc) {
    const pendingTextNodes = pendingNodesMap.get(doc);
    if (!pendingTextNodes) return;
    const batch = pendingTextNodes.splice(0, BATCH_SIZE);
    for (const node of batch) {
      if (!node || !node.parentElement) continue;
      const el = findPatchableElement(node);
      if (el) applyPatchToElement(el);
    }
    if (pendingTextNodes.length > 0) {
      scheduleProcessing(doc);
    } else {
      idleCallbackMap.set(doc, null);
    }
  }

  /******************************
   * 5. 动态监听与哨兵轮询
   ******************************/
  const observerMap = new WeakMap();

  function observeMutations(doc) {
    if (observerMap.has(doc)) observerMap.get(doc).disconnect();
    if (!isPatchActive() || !doc.body) return;

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (n.tagName === 'IFRAME') {
            processIframe(n);
          } else {
            if (n.querySelectorAll) n.querySelectorAll('iframe').forEach(processIframe);
          }
          collectTextNodes(n);
        }
      }
    });

    observer.observe(doc.body, { childList: true, subtree: true });
    observerMap.set(doc, observer);
  }

  function processIframe(iframe) {
    if (processedIframes.has(iframe)) return;
    try {
        const iframeDoc = iframe.contentDocument;
        if (iframeDoc && (iframeDoc.readyState === 'complete' || iframeDoc.readyState === 'interactive') && iframeDoc.body) {
            processedIframes.add(iframe);
            runOnDocument(iframeDoc);
        } else if (!iframe.dataset.loadListenerAttached) {
            iframe.addEventListener('load', () => processIframe(iframe), { once: true });
            iframe.dataset.loadListenerAttached = 'true';
        }
    } catch (e) {
        processedIframes.add(iframe);
    }
  }

  const originalAttachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function(options) {
    const shadowRoot = originalAttachShadow.call(this, options);
    if (isPatchActive()) {
        runOnDocument(shadowRoot);
    }
    return shadowRoot;
  };

  function startSentinelPolling() {
    const interval = 800;
    const duration = 12000;
    let elapsed = 0;

    const poller = setInterval(() => {
        if (!isPatchActive() || elapsed >= duration) {
            clearInterval(poller);
            return;
        }
        document.querySelectorAll('iframe').forEach(processIframe);
        elapsed += interval;
    }, interval);
  }

  /******************************
   * 6. 状态控制与核心执行
   ******************************/
  function undoAllPatches(doc = document) {
    if (!doc) return;
    if (observerMap.has(doc)) { observerMap.get(doc).disconnect(); observerMap.delete(doc); }
    const style = doc.getElementById('cjk-mono-patch-style'); if (style) style.remove();
    if (idleCallbackMap.has(doc) && idleCallbackMap.get(doc) !== null) { cancelRic(idleCallbackMap.get(doc)); idleCallbackMap.set(doc, null); }
    pendingNodesMap.delete(doc);
    doc.querySelectorAll(`[${PATCH_ATTR}]`).forEach(el => {
      try {
        const originalFont = el.getAttribute(ORIG_ATTR);
        el.style.fontFamily = originalFont || ''; el.removeAttribute(PATCH_ATTR); el.removeAttribute(ORIG_ATTR);
      } catch (e) {}
    });
    if(typeof doc.querySelectorAll === 'function') {
        doc.querySelectorAll('iframe').forEach(iframe => { try { undoAllPatches(iframe.contentDocument); } catch(e) {} });
    }
  }

  function refreshStyles(doc = document) {
    if (!doc) return;
    if (isPatchActive()) { injectGlobalStyle(doc); }
    if(typeof doc.querySelectorAll === 'function') {
        doc.querySelectorAll('iframe').forEach(iframe => { try { refreshStyles(iframe.contentDocument); } catch(e) {} });
    }
  }

  function runOnDocument(doc) {
      if (!isPatchActive() || !doc) return;
      const root = doc.body || doc;
      if (!root) return;
      injectGlobalStyle(doc);
      collectTextNodes(root);
      if (doc.body) observeMutations(doc);
  }

  function fullRescan() {
    undoAllPatches(document);
    runOnDocument(document);
    document.querySelectorAll('iframe').forEach(processIframe);
  }

  /******************************
   * 7. 控制面板 UI
   ******************************/
  let controlPanel = null;
  function createControlPanel() {
    if (document.getElementById('cjk-mono-panel')) return;
    controlPanel = document.createElement('div');
    controlPanel.id = 'cjk-mono-panel';
    controlPanel.style.cssText = `
      position: fixed; bottom: 20px; right: 20px; background: rgba(30, 30, 30, 0.95); color: #f0f0f0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 14px;
      padding: 15px; border-radius: 10px; z-index: 2147483647; line-height: 1.8; width: 280px;
      box-shadow: 0 8px 25px rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.15); backdrop-filter: blur(10px);
      display: none;
    `;
    controlPanel.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
        <b style="font-size:16px;">CJK/Mono 字体面板</b>
        <span id="cjkPanelClose" style="cursor:pointer; font-weight:bold; font-size:20px; padding:0 5px; line-height:1;">&times;</span>
      </div>
      <label style="display:flex; align-items:center; cursor:pointer;"><input type="checkbox" id="cjkToggle"> 启用脚本</label>
      <hr style="border:0; border-top:1px solid #555; margin:10px 0;">
      <div>正文 CJK 字体:</div>
      <select id="cjkFontSelect" style="width:100%; background:#333; color:#fff; border:1px solid #555; border-radius:4px; padding:4px;">
        ${FONT_CHOICES.cjk.map(f => `<option value="${f}">${f}</option>`).join('')}
      </select>
      <div style="margin-top:8px;">代码字体:</div>
      <select id="codeFontSelect" style="width:100%; background:#333; color:#fff; border:1px solid #555; border-radius:4px; padding:4px;">
        ${FONT_CHOICES.code.map(f => `<option value="${f}">${f}</option>`).join('')}
      </select>
      <hr style="border:0; border-top:1px solid #555; margin:10px 0;">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <b>站点黑名单</b>
        <button id="blacklistAddCurrent" style="font-size:11px; padding:3px 8px; background:#444; color:#fff; border:1px solid #666; border-radius:4px; cursor:pointer;">+ 添加当前站点</button>
      </div>
      <div id="blacklistContainer" style="margin-top:8px; max-height:80px; overflow-y:auto; font-size:12px; padding-right:5px;"></div>
    `;
    document.body.appendChild(controlPanel);
    const ui = {
      toggle: controlPanel.querySelector('#cjkToggle'), cjkSelect: controlPanel.querySelector('#cjkFontSelect'),
      codeSelect: controlPanel.querySelector('#codeFontSelect'), blContainer: controlPanel.querySelector('#blacklistContainer'),
      addBtn: controlPanel.querySelector('#blacklistAddCurrent'), closeBtn: controlPanel.querySelector('#cjkPanelClose'),
    };
    ui.toggle.checked = CONFIG.enabled; ui.cjkSelect.value = CONFIG.font.cjk; ui.codeSelect.value = CONFIG.font.code;
    ui.toggle.addEventListener('change', async () => { CONFIG.enabled = ui.toggle.checked; await saveConfig(); fullRescan(); });
    ui.cjkSelect.addEventListener('change', async () => { CONFIG.font.cjk = ui.cjkSelect.value; await saveConfig(); refreshStyles(document); });
    ui.codeSelect.addEventListener('change', async () => { CONFIG.font.code = ui.codeSelect.value; await saveConfig(); refreshStyles(document); });

    ui.closeBtn.addEventListener('click', () => { controlPanel.style.display = 'none'; });

    ui.addBtn.addEventListener('click', async () => { if (!CONFIG.siteBlacklist.includes(CURRENT_HOST)) { CONFIG.siteBlacklist.push(CURRENT_HOST); await saveConfig(); renderDomainList(); fullRescan(); } });

    function renderDomainList() {
      ui.blContainer.innerHTML = ''; if(CONFIG.siteBlacklist.length === 0) { ui.blContainer.innerHTML = '<span style="color:#888;">无</span>'; return; }
      CONFIG.siteBlacklist.forEach(domain => {
        const item = document.createElement('div');
        item.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:2px 0;';
        item.innerHTML = `<span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${domain}</span> <button style="font-size:10px; padding:1px 6px; background:#500; color:#fff; border:1px solid #800; border-radius:3px; cursor:pointer;">移除</button>`;
        item.querySelector('button').addEventListener('click', async () => { CONFIG.siteBlacklist = CONFIG.siteBlacklist.filter(d => d !== domain); await saveConfig(); renderDomainList(); fullRescan(); });
        ui.blContainer.appendChild(item);
      });
    }
    renderDomainList();
  }
  function togglePanel() { if (!controlPanel) createControlPanel(); controlPanel.style.display = (controlPanel.style.display === 'none') ? 'block' : 'none'; }

  /******************************
   * 8. 启动入口
   ******************************/
  function setupHotkey() {
    document.addEventListener('keydown', e => {
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyF') {
        e.preventDefault(); e.stopPropagation(); togglePanel();
      }
    }, true);
  }

  async function main() {
    await loadConfig();
    if (isPatchActive()) {
        runOnDocument(document);
        startSentinelPolling();
    }
    setupHotkey();
  }

  main().catch(console.error);

})();
