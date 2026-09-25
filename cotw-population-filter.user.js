// ==UserScript==
// @name         DECA COTW 地图 · 种群分数筛选
// @namespace    cotw-kedior
// @version      1.2.0
// @description  按物种和分数区间筛选动物兽群，支持个体分数粒度
// @match        https://mathartbang.com/deca/hp/map.html*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // —— 基础工具 ——

    const $ = (sel, root = document) => root.querySelector(sel);
    const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
    const yieldToUI = () => new Promise((resolve) => setTimeout(resolve, 0));

    // 分片执行：按时间预算让出主线程，避免长任务卡住页面
    async function runBatches(items, worker, budgetMs = 8) {
        let t0 = performance.now();
        for (let i = 0; i < items.length; ++i) {
            worker(items[i], i);
            if (performance.now() - t0 > budgetMs) {
                await yieldToUI();
                t0 = performance.now();
            }
        }
    }

    // —— 种群树解析 ——

    // 行文本，如 "Group: 3, Max Score: 487.3 ⌊487⌋, Animal Count: 5"
    function rowText(cb) {
        let node = cb.nextSibling;
        while (node) {
            if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
                return node.textContent.trim();
            }
            if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'UL') break;
            node = node.nextSibling;
        }
        return '';
    }

    const parseScore = (cb) => {
        const m = rowText(cb).match(/Max Score:\s*([\d.]+)/i);
        return m ? parseFloat(m[1]) : NaN;
    };

    const populationName = (cb) => {
        const text = rowText(cb);
        const i = text.indexOf(', Max Score:');
        return (i >= 0 ? text.slice(0, i) : text).trim();
    };

    const populationRows = () =>
        $$(`#pop_nav input.nav-visible[data-population-id]:not([data-spawn-area-id])`);

    // 走页面自身的 click 事件，与手动点击等价
    const setChecked = (cb, want) => {
        if (cb.checked !== want) cb.click();
    };

    // —— 个体分数捕获 ——
    // 页面解析存档时个体 Score 算完 max 即被丢弃，这里挂钩子留存。
    // 组编号与页面一致：同一 (物种, 出生区) 内按存档组序 0,1,2...

    const scoresByReserve = new Map(); // reserveId -> Map<key, number[]>
    const keyOf = (name, spawnAreaId, groupIndex) => `${name}|${spawnAreaId}|${groupIndex}`;

    // 页面内部全局是 let 声明，标识符未就绪时抛 ReferenceError，统一兜底
    function resolveName(population, reserveId) {
        try {
            const rpi = reserve_population_info?.[reserveId]?.[population.NameHashId >>> 0];
            if (rpi?.population_name) return rpi.population_name;
            if (rpi?.population_id) {
                return population_infos?.[rpi.population_id]?.name ?? rpi.population_id;
            }
            // 页面的兜底逻辑：从出生区反推
            const reserveArea = JSON.parse(areas[reserveId] ?? '{}');
            for (const group of Object.values(population.Groups ?? {})) {
                const area = reserveArea?.[group.SpawnAreadId];
                if (area) return population_infos?.[area[1]]?.name ?? null;
            }
        } catch {
            // 页面结构变化时静默降级
        }
        return null;
    }

    let scoresVersion = 0;

    function captureScores(reserveData, saveName) {
        const reserveId = `r${saveName.match(/\d+/)?.[0] ?? ''}`;
        const table = new Map();

        for (const population of reserveData.Populations ?? []) {
            const name = resolveName(population, reserveId);
            if (!name) continue;

            const counters = new Map();
            for (const group of Object.values(population.Groups ?? {})) {
                const sa = String(group.SpawnAreadId);
                const idx = counters.get(sa) ?? 0;
                counters.set(sa, idx + 1);

                const scores = (group.Animals ?? [])
                    .map((a) => a.Score)
                    .filter((s) => typeof s === 'number')
                    .sort((x, y) => y - x);
                if (scores.length) table.set(keyOf(name, sa, idx), scores);
            }
        }

        if (table.size) {
            scoresByReserve.set(reserveId, table);
            scoresVersion += 1;
            queueRebuild();
        }
    }

    function hookSaveParser() {
        const original = window.processSaveReserve;
        if (typeof original !== 'function') return;

        window.processSaveReserve = function (saveName, reserveData) {
            const result = original.apply(this, arguments);
            try {
                captureScores(reserveData, saveName);
            } catch {
                // 捕获失败只影响个体粒度，页面自身处理不受影响
            }
            return result;
        };
    }

    const currentReserveId = () => {
        try {
            if (typeof current_reserve_id === 'string' && current_reserve_id) return current_reserve_id;
        } catch {
            // 无页面状态时用 URL 参数
        }
        return new URLSearchParams(location.search).get('r') ?? 'r0';
    };

    // —— 索引缓存：树重建时构建，预览/筛选不再反复查 DOM ——

    let groupCache = []; // [{cb, name, scores: number[]|null}]
    const popNameCache = new Map();

    function nameOfGroup(cb) {
        const pid = cb.dataset.populationId;
        if (popNameCache.has(pid)) return popNameCache.get(pid);

        const row = $(`#pop_nav input.nav-visible[data-population-id="${pid}"]:not([data-spawn-area-id])`);
        const name = row ? populationName(row) : null;
        popNameCache.set(pid, name);
        return name;
    }

    function lookupScores(name, { spawnAreaId, groupIndex }) {
        const table = scoresByReserve.get(currentReserveId());
        return table?.get(keyOf(name, spawnAreaId, groupIndex)) ?? null;
    }

    // —— 面板 ——

    const style = document.createElement('style');
    style.textContent = `
        #cotw-filter-panel {
            position: fixed; top: 12px; right: 12px; z-index: 10000;
            width: 250px; background: rgba(20, 24, 28, 0.88); color: #eee;
            border-radius: 8px; font: 13px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
            box-shadow: 0 2px 10px rgba(0,0,0,0.45); user-select: none;
        }
        #cotw-filter-header {
            padding: 8px 12px; cursor: move; font-weight: 600;
            display: flex; justify-content: space-between; align-items: center;
        }
        #cotw-filter-body { padding: 0 12px 12px; }
        #cotw-filter-panel.collapsed #cotw-filter-body { display: none; }
        #cotw-filter-body label {
            display: block; margin: 8px 0 2px; font-size: 12px; color: #bbb;
        }
        #cotw-filter-body select, #cotw-filter-body input {
            width: 100%; box-sizing: border-box; padding: 5px 6px;
            border: 1px solid #555; border-radius: 4px; background: #fff; color: #222;
            font-size: 13px;
        }
        #cotw-filter-body button {
            width: 100%; margin-top: 8px; padding: 7px 0; border: 0; border-radius: 4px;
            background: #2f8f3e; color: #fff; font-size: 13px; cursor: pointer;
        }
        #cotw-filter-body button:hover { filter: brightness(1.12); }
        #cotw-filter-body button:disabled { opacity: 0.5; cursor: default; }
        #cotw-filter-body button.cotw-secondary { background: #555f66; }
        .cotw-range { display: flex; gap: 8px; }
        .cotw-range > div { flex: 1; }
        #cotw-status { margin-top: 8px; font-size: 12px; color: #9fd3a4; min-height: 1.2em; word-break: break-all; }
        #pop_nav ul.cotw-animals { padding-left: 20px; }
        #pop_nav ul.cotw-animals > li { font-size: 12px; color: #555; padding: 1px 0; }
        #pop_nav ul.cotw-animals > li.cotw-hit { color: #0b7a34; font-weight: 600; }
        #pop_nav .cotw-caret { cursor: pointer; }
    `;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'cotw-filter-panel';
    panel.innerHTML = `
        <div id="cotw-filter-header"><span>🦌 种群分数筛选</span><span id="cotw-filter-toggle">−</span></div>
        <div id="cotw-filter-body">
            <label>物种</label>
            <select id="cotw-species"></select>
            <div class="cotw-range">
                <div><label>最小分数</label><input id="cotw-min" type="number" step="0.1" placeholder="不限"></div>
                <div><label>最大分数</label><input id="cotw-max" type="number" step="0.1" placeholder="不限"></div>
            </div>
            <button id="cotw-apply">筛选并勾选</button>
            <button id="cotw-clear" class="cotw-secondary">全部取消</button>
            <div id="cotw-status"></div>
        </div>
    `;
    document.body.appendChild(panel);

    const header = $('#cotw-filter-header', panel);
    const toggle = $('#cotw-filter-toggle', panel);
    const selSpecies = $('#cotw-species', panel);
    const inpMin = $('#cotw-min', panel);
    const inpMax = $('#cotw-max', panel);
    const btnApply = $('#cotw-apply', panel);
    const btnClear = $('#cotw-clear', panel);
    const status = $('#cotw-status', panel);

    // —— 拖拽 / 折叠 ——

    let drag = null;

    header.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        const rect = panel.getBoundingClientRect();
        drag = {
            dx: e.clientX - rect.left,
            dy: e.clientY - rect.top,
            x0: e.clientX,
            y0: e.clientY,
            w: rect.width,
            moved: false,
        };
        header.setPointerCapture(e.pointerId);
    });

    header.addEventListener('pointermove', (e) => {
        if (!drag) return;
        if (!drag.moved &&
            Math.abs(e.clientX - drag.x0) + Math.abs(e.clientY - drag.y0) < 5) return;
        drag.moved = true;

        const left = Math.min(Math.max(0, e.clientX - drag.dx), window.innerWidth - drag.w);
        const top = Math.min(Math.max(0, e.clientY - drag.dy), window.innerHeight - 40);
        panel.style.left = left + 'px';
        panel.style.top = top + 'px';
        panel.style.right = 'auto';
    });

    header.addEventListener('pointerup', (e) => {
        if (drag && !drag.moved) {
            panel.classList.toggle('collapsed');
            toggle.textContent = panel.classList.contains('collapsed') ? '+' : '−';
        }
        drag = null;
        header.releasePointerCapture(e.pointerId);
    });

    // —— 分数区间 ——

    const boundValue = (inp) => {
        const v = inp.value.trim();
        return v === '' ? null : parseFloat(v);
    };

    function inRange(score) {
        if (isNaN(score)) return false;
        const min = boundValue(inpMin);
        const max = boundValue(inpMax);
        return (min === null || score >= min) && (max === null || score <= max);
    }

    // —— 个体层渲染 ——

    function decorateGroupRow(li, scores) {
        const ul = document.createElement('ul');
        ul.className = 'nested cotw-animals';
        ul.append(...scores.map((s) => {
            const row = document.createElement('li');
            row.textContent = s.toFixed(1);
            row.dataset.score = s;
            return row;
        }));
        li.append(ul);

        // 行首占位符换成展开箭头，复用页面的 caret 样式
        const spacer = $(':scope > .nav-spacer', li);
        if (spacer) {
            spacer.className = 'nav-caret cotw-caret';
            spacer.addEventListener('click', () => {
                ul.classList.toggle('active');
                spacer.classList.toggle('nav-caret-down');
            });
        }
    }

    function refreshHighlights() {
        for (const row of $$('#pop_nav ul.cotw-animals > li')) {
            row.classList.toggle('cotw-hit', inRange(parseFloat(row.dataset.score)));
        }
    }

    let rebuildToken = 0;

    async function rebuildIndex() {
        const token = ++rebuildToken;
        popNameCache.clear();
        const cache = [];

        await runBatches($$('#pop_nav input.nav-visible[data-group-index]'), (cb) => {
            const li = cb.closest('li');
            const name = nameOfGroup(cb);
            const scores = name ? lookupScores(name, cb.dataset) : null;

            if (li && scores?.length && !$(':scope > ul.cotw-animals', li)) {
                decorateGroupRow(li, scores);
            }
            cache.push({ cb, name, scores: scores ?? null });
        });

        if (token !== rebuildToken) return; // 已有更新的重建，丢弃本次结果
        groupCache = cache;
        refreshHighlights();
    }

    // —— 物种下拉框 ——

    function refreshSpecies() {
        const names = [...new Set(groupCache.map((g) => g.name).filter(Boolean))]
            .sort((a, b) => a.localeCompare(b));
        const prev = selSpecies.value;

        selSpecies.innerHTML = '';
        if (names.length === 0) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = '暂无数据';
            selSpecies.appendChild(opt);
            btnApply.disabled = true;
            status.textContent = '';
            return;
        }

        btnApply.disabled = false;
        for (const name of names) {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            selSpecies.appendChild(opt);
        }
        if (names.includes(prev)) selSpecies.value = prev;
        updatePreview();
    }

    // —— 统计 ——

    function summarize() {
        const groups = groupCache.filter((g) => g.name === selSpecies.value);
        let passing = 0;
        let hits = 0;

        for (const g of groups) {
            if (g.scores) {
                const matched = g.scores.filter(inRange).length;
                if (matched > 0) { passing += 1; hits += matched; }
            } else if (inRange(parseScore(g.cb))) {
                passing += 1;
            }
        }
        return { total: groups.length, passing, hits, precise: groups.some((g) => g.scores) };
    }

    function updatePreview() {
        if (!selSpecies.value) { status.textContent = ''; return; }
        const { total, passing, hits, precise } = summarize();
        status.textContent = precise
            ? `${total} 群 · 达标 ${passing} · 命中 ${hits} 只`
            : `${total} 群 · 达标 ${passing} · 按最高分`;
    }

    // —— 主操作 ——

    async function applyFilter() {
        const groups = groupCache.filter((g) => g.name === selSpecies.value);
        if (!groups.length) {
            status.textContent = '无可用数据';
            return;
        }

        btnApply.disabled = true;
        const { passing, hits, precise } = summarize();

        await runBatches(groups, (g, i) => {
            const want = g.scores
                ? g.scores.some(inRange)
                : inRange(parseScore(g.cb));
            setChecked(g.cb, want);
            if (i % 16 === 0) status.textContent = `筛选中 ${i}/${groups.length}`;
        });

        // 展开该物种分支，方便查看勾选结果
        const popRow = populationRows()
            .find((cb) => populationName(cb) === selSpecies.value)
            ?.closest('li');
        if (popRow) {
            $$('.nav-caret', popRow).forEach((c) => c.classList.add('nav-caret-down'));
            $$('ul.nested', popRow).forEach((u) => u.classList.add('active'));
        }

        refreshHighlights();
        btnApply.disabled = false;
        status.textContent = precise
            ? `达标 ${passing}/${groups.length} 群 · 命中 ${hits} 只`
            : `达标 ${passing}/${groups.length} 群 · 按最高分`;
    }

    function clearAll() {
        $$('#pop_nav input.nav-visible').forEach((cb) => setChecked(cb, false));
        status.textContent = '已清空';
    }

    btnApply.addEventListener('click', () => void applyFilter());
    btnClear.addEventListener('click', clearAll);
    selSpecies.addEventListener('change', updatePreview);
    inpMin.addEventListener('input', updatePreview);
    inpMax.addEventListener('input', updatePreview);

    // —— 树重建（拖入存档 / 切换地图）后自动刷新 ——

    let rebuildTimer = null;
    function queueRebuild() {
        clearTimeout(rebuildTimer);
        rebuildTimer = setTimeout(() => void onTreeChanged(), 150);
    }

    // 记录已处理的树，自身 DOM 写入触发的变更不重复重建
    let processedTree = null;
    let processedVersion = -1;

    async function onTreeChanged() {
        const root = $('#pop_nav');
        if (root === processedTree && scoresVersion === processedVersion && groupCache.length) return;
        processedTree = root;
        processedVersion = scoresVersion;

        await rebuildIndex();
        refreshSpecies();
        updatePreview();
    }

    const dropzone = $('#dropzone');
    if (dropzone) {
        new MutationObserver(queueRebuild).observe(dropzone, { childList: true, subtree: true });
    }

    hookSaveParser();
    void onTreeChanged();
})();
