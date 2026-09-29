// ==UserScript==
// @name         DECA COTW 地图 · 种群分数筛选
// @namespace    cotw-kedior
// @version      1.3.0
// @description  按物种和分数区间筛选动物兽群，支持个体分数与存档自动监听
// @match        https://mathartbang.com/deca/hp/map.html*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

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
      if (node.nodeType === Node.ELEMENT_NODE && node.tagName === "UL") break;
      node = node.nextSibling;
    }
    return "";
  }

  const parseScore = (cb) => {
    const m = rowText(cb).match(/Max Score:\s*([\d.]+)/i);
    return m ? parseFloat(m[1]) : NaN;
  };

  const populationName = (cb) => {
    const text = rowText(cb);
    const i = text.indexOf(", Max Score:");
    return (i >= 0 ? text.slice(0, i) : text).trim();
  };

  const populationRows = () =>
    $$(
      `#pop_nav input.nav-visible[data-population-id]:not([data-spawn-area-id])`,
    );

  // 走页面自身的 click 事件，与手动点击等价
  const setChecked = (cb, want) => {
    if (cb.checked !== want) cb.click();
  };

  // —— 个体分数捕获 ——
  // 页面解析存档时个体 Score 算完 max 即被丢弃，这里挂钩子留存。
  // group_index 按页面实际生成的地图组编号计算，跳过不会生成图层的原始群。

  const scoresByReserve = new Map(); // reserveId -> Map<key, number[]>
  const keyOf = (name, spawnAreaId, groupIndex) =>
    `${name}|${spawnAreaId}|${groupIndex}`;

  // 页面内部全局是 let 声明，标识符未就绪时抛 ReferenceError，统一兜底
  function resolveName(population, reserveId) {
    try {
      const rpi =
        reserve_population_info?.[reserveId]?.[population.NameHashId >>> 0];
      if (rpi?.population_name) return rpi.population_name;
      if (rpi?.population_id) {
        return population_infos?.[rpi.population_id]?.name ?? rpi.population_id;
      }
      // 页面的兜底逻辑：从出生区反推
      const reserveArea = JSON.parse(areas[reserveId] ?? "{}");
      for (const group of Object.values(population.Groups ?? {})) {
        const area = reserveArea?.[group.SpawnAreadId];
        if (area) return population_infos?.[area[1]]?.name ?? null;
      }
    } catch {
      // 页面结构变化时静默降级
    }
    return null;
  }

  let groupMappingWarningShown = false;

  function warnGroupMappingFailure(error) {
    if (groupMappingWarningShown) return;
    groupMappingWarningShown = true;
    console.warn(
      "[COTW 种群分数筛选] 无法对齐页面兽群编号，相关兽群将回退到最高分筛选。",
      error,
    );
  }

  function pageGroupIndices(population, reserveArea, spawnPointsByArea) {
    try {
      const groupToWarrenId = population.GroupToWarrenId;
      const nextIndexByArea = new Map();
      const pageIndexBySourceIndex = new Map();

      for (const [sourceIndex, group] of Object.entries(
        population.Groups ?? {},
      )) {
        const spawnAreaId = String(group.SpawnAreadId);
        if (!Object.prototype.hasOwnProperty.call(reserveArea, spawnAreaId))
          continue;

        let isRendered;
        if (groupToWarrenId?.length > 0) {
          const spawnPoints = spawnPointsByArea[spawnAreaId];
          const pointId = String(groupToWarrenId[sourceIndex]);
          isRendered = spawnPoints?.[pointId] !== undefined;
        } else {
          const needZoneIds = new Int32Array(group.NeedZonePathGuids ?? []);
          isRendered = [...needZoneIds].some(
            (id) =>
              id !== -1 &&
              Object.prototype.hasOwnProperty.call(reserveArea, id),
          );
        }

        if (!isRendered) continue;
        const pageIndex = nextIndexByArea.get(spawnAreaId) ?? 0;
        pageIndexBySourceIndex.set(sourceIndex, pageIndex);
        nextIndexByArea.set(spawnAreaId, pageIndex + 1);
      }
      return pageIndexBySourceIndex;
    } catch (error) {
      // 无法复现页面的图层筛选条件时，不冒险把分数关联到错误兽群。
      warnGroupMappingFailure(error);
      return null;
    }
  }

  let scoresVersion = 0;

  function captureScores(reserveData, saveName) {
    const reserveId = `r${saveName.match(/\d+/)?.[0] ?? ""}`;
    const table = new Map();
    let reserveArea = null;
    let spawnPointsByArea = {};

    try {
      if (typeof areas === "undefined" || !areas[reserveId]) {
        throw new Error(`Reserve geometry is unavailable for ${reserveId}`);
      }
      reserveArea = JSON.parse(areas[reserveId]);
      if (!reserveArea || typeof reserveArea !== "object") {
        throw new Error(`Invalid reserve geometry for ${reserveId}`);
      }
      if (typeof area_spawn_center_points !== "undefined") {
        spawnPointsByArea = area_spawn_center_points[reserveId] ?? {};
      }
    } catch (error) {
      warnGroupMappingFailure(error);
    }

    if (reserveArea) {
      for (const population of reserveData.Populations ?? []) {
        const name = resolveName(population, reserveId);
        if (!name) continue;

        const pageIndexBySourceIndex = pageGroupIndices(
          population,
          reserveArea,
          spawnPointsByArea,
        );
        if (!pageIndexBySourceIndex) continue;

        for (const [sourceIndex, group] of Object.entries(
          population.Groups ?? {},
        )) {
          const pageIndex = pageIndexBySourceIndex.get(sourceIndex);
          if (pageIndex === undefined) continue;

          const spawnAreaId = String(group.SpawnAreadId);
          const scores = (group.Animals ?? [])
            .map((animal) => animal.Score)
            .filter((score) => typeof score === "number")
            .sort((a, b) => b - a);
          if (scores.length)
            table.set(keyOf(name, spawnAreaId, pageIndex), scores);
        }
      }
    }

    // 覆盖空表也能清除该保护区先前缓存，避免新存档沿用旧分数。
    scoresByReserve.set(reserveId, table);
    scoresVersion += 1;
    queueRebuild();
  }

  function hookSaveParser() {
    const original = window.processSaveReserve;
    if (typeof original !== "function") return;

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
      if (typeof current_reserve_id === "string" && current_reserve_id)
        return current_reserve_id;
    } catch {
      // 无页面状态时用 URL 参数
    }
    return new URLSearchParams(location.search).get("r") ?? "r0";
  };

  // —— 索引缓存：树重建时构建，预览/筛选不再反复查 DOM ——

  let groupCache = []; // [{cb, name, scores: number[]|null}]
  const popNameCache = new Map();

  function nameOfGroup(cb) {
    const pid = cb.dataset.populationId;
    if (popNameCache.has(pid)) return popNameCache.get(pid);

    const row = $(
      `#pop_nav input.nav-visible[data-population-id="${pid}"]:not([data-spawn-area-id])`,
    );
    const name = row ? populationName(row) : null;
    popNameCache.set(pid, name);
    return name;
  }

  function lookupScores(name, { spawnAreaId, groupIndex }) {
    const table = scoresByReserve.get(currentReserveId());
    return table?.get(keyOf(name, spawnAreaId, groupIndex)) ?? null;
  }

  // —— 面板 ——

  const style = document.createElement("style");
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
        #cotw-area-info { margin-top: 10px; padding-top: 8px; border-top: 1px solid #566; }
        #cotw-area-results { max-height: 220px; overflow-y: auto; margin-top: 4px; user-select: text; }
        .cotw-area-empty { color: #aaa; font-size: 12px; }
        .cotw-area-group { padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.12); }
        .cotw-area-group:last-child { border-bottom: 0; }
        .cotw-area-name { font-weight: 600; color: #eee; }
        .cotw-area-meta { color: #bbb; font-size: 11px; }
        .cotw-area-scores { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
        .cotw-area-score { padding: 1px 4px; border-radius: 3px; background: rgba(255,255,255,0.12); }
        #pop_nav ul.cotw-animals { padding-left: 20px; }
        #pop_nav ul.cotw-animals > li { font-size: 12px; color: #555; padding: 1px 0; }
        #pop_nav .cotw-caret { cursor: pointer; }
    `;
  document.head.appendChild(style);

  const panel = document.createElement("div");
  panel.id = "cotw-filter-panel";
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
            <button id="cotw-watch-save" class="cotw-secondary">监听存档</button>
            <div id="cotw-status"></div>
            <div id="cotw-area-info" hidden>
                <div id="cotw-area-results"></div>
            </div>
        </div>
    `;
  document.body.appendChild(panel);

  const header = $("#cotw-filter-header", panel);
  const toggle = $("#cotw-filter-toggle", panel);
  const selSpecies = $("#cotw-species", panel);
  const inpMin = $("#cotw-min", panel);
  const inpMax = $("#cotw-max", panel);
  const btnApply = $("#cotw-apply", panel);
  const btnClear = $("#cotw-clear", panel);
  const btnWatchSave = $("#cotw-watch-save", panel);
  const status = $("#cotw-status", panel);
  const areaInfo = $("#cotw-area-info", panel);
  const areaResults = $("#cotw-area-results", panel);

  // —— 拖拽 / 折叠 ——

  let drag = null;

  header.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
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

  header.addEventListener("pointermove", (e) => {
    if (!drag) return;
    if (
      !drag.moved &&
      Math.abs(e.clientX - drag.x0) + Math.abs(e.clientY - drag.y0) < 5
    )
      return;
    drag.moved = true;

    const left = Math.min(
      Math.max(0, e.clientX - drag.dx),
      window.innerWidth - drag.w,
    );
    const top = Math.min(
      Math.max(0, e.clientY - drag.dy),
      window.innerHeight - 40,
    );
    panel.style.left = left + "px";
    panel.style.top = top + "px";
    panel.style.right = "auto";
  });

  header.addEventListener("pointerup", (e) => {
    if (drag && !drag.moved) {
      panel.classList.toggle("collapsed");
      toggle.textContent = panel.classList.contains("collapsed") ? "+" : "−";
    }
    drag = null;
    header.releasePointerCapture(e.pointerId);
  });

  // —— 分数区间 ——

  const boundValue = (inp) => {
    const v = inp.value.trim();
    return v === "" ? null : parseFloat(v);
  };

  function inRange(score) {
    if (isNaN(score)) return false;
    const min = boundValue(inpMin);
    const max = boundValue(inpMax);
    return (min === null || score >= min) && (max === null || score <= max);
  }

  // —— 地图点击区域的个体分数 ——

  let selectedAreaEntries = [];
  let areaEmptyText = "";

  function formatAreaTime(hours) {
    const minutes = Math.trunc(hours * 60);
    const normalized = ((minutes % 1440) + 1440) % 1440;
    return `${String(Math.trunc(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
  }

  function areaTypeName(type) {
    const names = {
      feeding: "觅食区",
      drinking: "饮水区",
      resting: "休息区",
      spawn: "出生区",
      feed: "觅食区",
      drink: "饮水区",
      rest: "休息区",
    };
    return names[type] ?? type ?? "种群区域";
  }

  function areaDescriptions(feature) {
    const info = feature.properties.zone_info;
    if (
      typeof info.zone_time_begin === "number" &&
      typeof info.zone_time_end === "number"
    ) {
      return [
        `${areaTypeName(feature.properties.zone_type)} [${formatAreaTime(info.zone_time_begin)}, ${formatAreaTime(info.zone_time_end)})`,
      ];
    }
    if (Array.isArray(info.need_schedule)) {
      return info.need_schedule.map((schedule) => {
        const [start, end, , type] = schedule;
        return `${areaTypeName(type)} [${formatAreaTime(start)}, ${formatAreaTime(end)})`;
      });
    }
    return [areaTypeName(feature.properties.zone_type)];
  }

  function groupsAtMapPoint(mapInstance, latlng) {
    const pip =
      typeof leafletPip !== "undefined" ? leafletPip : window.leafletPip;
    if (!pip?.pointInLayer)
      throw new Error("leafletPip.pointInLayer is unavailable");

    const hits = pip.pointInLayer(latlng, mapInstance);
    const entries = new Map();
    for (const hit of hits) {
      const feature = hit.feature;
      const properties = feature?.properties;
      const info = properties?.zone_info;
      if (
        !["need_zone", "spawn_center_point"].includes(properties?.type) ||
        !info
      )
        continue;
      if (
        info.population_id == null ||
        info.spawn_area_id == null ||
        info.group_index == null
      )
        continue;

      const key = [info.population_id, info.spawn_area_id, info.group_index]
        .map(String)
        .join("|");
      let entry = entries.get(key);
      if (!entry) {
        entry = {
          populationId: String(info.population_id),
          populationName: info.population_name ?? "",
          spawnAreaId: String(info.spawn_area_id),
          groupIndex: String(info.group_index),
          maxScore: info.max_score,
          areas: new Set(),
        };
        entries.set(key, entry);
      }
      for (const description of areaDescriptions(feature))
        entry.areas.add(description);
    }
    return [...entries.values()];
  }

  function findCachedGroup(entry) {
    return groupCache.find(
      (group) =>
        group.cb.isConnected &&
        String(group.cb.dataset.populationId) === entry.populationId &&
        String(group.cb.dataset.spawnAreaId) === entry.spawnAreaId &&
        String(group.cb.dataset.groupIndex) === entry.groupIndex,
    );
  }

  function renderSelectedArea() {
    areaResults.replaceChildren();
    areaInfo.hidden = selectedAreaEntries.length === 0 && !areaEmptyText;
    if (selectedAreaEntries.length === 0) {
      if (areaEmptyText) {
        const empty = document.createElement("div");
        empty.className = "cotw-area-empty";
        empty.textContent = areaEmptyText;
        areaResults.appendChild(empty);
      }
      return;
    }

    for (const entry of selectedAreaEntries) {
      const block = document.createElement("div");
      block.className = "cotw-area-group";

      const group = findCachedGroup(entry);
      const name =
        group?.name || entry.populationName || `物种 ${entry.populationId}`;
      const heading = document.createElement("div");
      heading.className = "cotw-area-name";
      heading.textContent = `${name} · 群 ${entry.groupIndex}`;
      block.appendChild(heading);

      const meta = document.createElement("div");
      meta.className = "cotw-area-meta";
      const details = [`出生区 ${entry.spawnAreaId}`, ...entry.areas];
      meta.textContent = details.join(" · ");
      block.appendChild(meta);

      if (group?.scores?.length) {
        const scoreTitle = document.createElement("div");
        scoreTitle.className = "cotw-area-meta";
        scoreTitle.textContent = `个体分数（${group.scores.length} 只）`;
        block.appendChild(scoreTitle);

        const scores = document.createElement("div");
        scores.className = "cotw-area-scores";
        for (const score of group.scores) {
          const chip = document.createElement("span");
          chip.className = "cotw-area-score";
          chip.textContent = score.toFixed(1);
          scores.appendChild(chip);
        }
        block.appendChild(scores);
      } else {
        const unavailable = document.createElement("div");
        unavailable.className = "cotw-area-meta";
        unavailable.textContent = "个体分数不可用";
        if (
          typeof entry.maxScore === "number" &&
          Number.isFinite(entry.maxScore)
        ) {
          unavailable.textContent += ` · 地图最高分 ${entry.maxScore.toFixed(1)}`;
        }
        block.appendChild(unavailable);
      }
      areaResults.appendChild(block);
    }
  }

  // —— 个体层渲染 ——

  function decorateGroupRow(li, scores) {
    const ul = document.createElement("ul");
    ul.className = "nested cotw-animals";
    ul.append(
      ...scores.map((s) => {
        const row = document.createElement("li");
        row.textContent = s.toFixed(1);
        row.dataset.score = s;
        return row;
      }),
    );
    li.append(ul);

    // 行首占位符换成展开箭头，复用页面的 caret 样式
    const spacer = $(":scope > .nav-spacer", li);
    if (spacer) {
      spacer.className = "nav-caret cotw-caret";
      spacer.addEventListener("click", () => {
        ul.classList.toggle("active");
        spacer.classList.toggle("nav-caret-down");
      });
    }
  }

  let rebuildToken = 0;

  async function rebuildIndex() {
    const token = ++rebuildToken;
    popNameCache.clear();
    const cache = [];

    await runBatches(
      $$("#pop_nav input.nav-visible[data-group-index]"),
      (cb) => {
        const li = cb.closest("li");
        const name = nameOfGroup(cb);
        const scores = name ? lookupScores(name, cb.dataset) : null;

        if (li && scores?.length && !$(":scope > ul.cotw-animals", li)) {
          decorateGroupRow(li, scores);
        }
        cache.push({ cb, name, scores: scores ?? null });
      },
    );

    if (token !== rebuildToken) return; // 已有更新的重建，丢弃本次结果
    groupCache = cache;
  }

  // —— 物种下拉框 ——

  function refreshSpecies() {
    const names = [
      ...new Set(groupCache.map((g) => g.name).filter(Boolean)),
    ].sort((a, b) => a.localeCompare(b));
    const prev = selSpecies.value;

    selSpecies.innerHTML = "";
    if (names.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "暂无数据";
      selSpecies.appendChild(opt);
      btnApply.disabled = true;
      status.textContent = "";
      return;
    }

    btnApply.disabled = false;
    for (const name of names) {
      const opt = document.createElement("option");
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
    let preciseGroups = 0;
    let fallbackGroups = 0;

    for (const group of groups) {
      if (group.scores?.length) {
        preciseGroups += 1;
        const matched = group.scores.filter(inRange).length;
        if (matched > 0) {
          passing += 1;
          hits += matched;
        }
      } else {
        fallbackGroups += 1;
        if (inRange(parseScore(group.cb))) passing += 1;
      }
    }
    return {
      total: groups.length,
      passing,
      hits,
      preciseGroups,
      fallbackGroups,
    };
  }

  function summaryText({
    total,
    passing,
    hits,
    preciseGroups,
    fallbackGroups,
  }) {
    const prefix = `${total} 群 · 达标 ${passing} 群`;
    if (fallbackGroups === 0) return `${prefix} · 命中 ${hits} 只`;
    if (preciseGroups === 0) return `${prefix} · 按最高分`;
    return `${prefix} · 个体分数 ${preciseGroups} 群 · 最高分回退 ${fallbackGroups} 群 · 精确命中 ${hits} 只`;
  }

  function updatePreview() {
    if (!selSpecies.value) {
      status.textContent = "";
      return;
    }
    status.textContent = summaryText(summarize());
  }

  // —— 主操作 ——

  async function applyFilter() {
    const groups = groupCache.filter((g) => g.name === selSpecies.value);
    if (!groups.length) {
      status.textContent = "无可用数据";
      return;
    }

    btnApply.disabled = true;
    const summary = summarize();

    await runBatches(groups, (g, i) => {
      const want = g.scores?.length
        ? g.scores.some(inRange)
        : inRange(parseScore(g.cb));
      setChecked(g.cb, want);
      if (i % 16 === 0) status.textContent = `筛选中 ${i}/${groups.length}`;
    });

    // 展开该物种分支，方便查看勾选结果
    const popRow = populationRows()
      .find((cb) => populationName(cb) === selSpecies.value)
      ?.closest("li");
    if (popRow) {
      $$(".nav-caret", popRow).forEach((c) =>
        c.classList.add("nav-caret-down"),
      );
      $$("ul.nested", popRow).forEach((u) => u.classList.add("active"));
    }

    btnApply.disabled = false;
    status.textContent = summaryText(summary);
  }

  function clearAll() {
    $$("#pop_nav input.nav-visible").forEach((cb) => setChecked(cb, false));
    status.textContent = "已清空";
  }

  // —— 单个存档文件自动监听 ——

  const SAVE_HANDLE_DB = "cotw-population-filter";
  const SAVE_HANDLE_STORE = "settings";
  const SAVE_HANDLE_KEY = "watched-population-file";
  const SAVE_FILE_PATTERN = /^animal_population_\d+$/;
  const SAVE_MAGIC = [0x53, 0x41, 0x56, 0x45]; // SAVE
  const ADF_ENVELOPE = [0x01, 0x01, 0x00, 0x00, 0x00, 0x20, 0x46, 0x44, 0x41];
  const ADF_MAGIC = [0x20, 0x46, 0x44, 0x41]; // " FDA"

  let watchedSaveHandle = null;
  let watchTimer = null;
  let watchActive = false;
  let watchPermissionPending = false;
  let watchPollInFlight = false;
  let watchLastSignature = null;
  let watchCandidateSignature = null;
  let watchCandidateSince = 0;
  let watchLastError = null;

  function openSaveHandleDatabase() {
    return new Promise((resolve, reject) => {
      const request = window.indexedDB.open(SAVE_HANDLE_DB, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(SAVE_HANDLE_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function readSavedHandle() {
    const db = await openSaveHandleDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(SAVE_HANDLE_STORE, "readonly");
      const request = transaction
        .objectStore(SAVE_HANDLE_STORE)
        .get(SAVE_HANDLE_KEY);
      let handle = null;
      request.onsuccess = () => {
        handle = request.result ?? null;
      };
      transaction.oncomplete = () => {
        db.close();
        resolve(handle);
      };
      transaction.onerror = () => {
        db.close();
        reject(transaction.error);
      };
      transaction.onabort = () => {
        db.close();
        reject(transaction.error);
      };
    });
  }

  async function writeSavedHandle(handle) {
    const db = await openSaveHandleDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(SAVE_HANDLE_STORE, "readwrite");
      transaction.objectStore(SAVE_HANDLE_STORE).put(handle, SAVE_HANDLE_KEY);
      transaction.oncomplete = () => {
        db.close();
        resolve();
      };
      transaction.onerror = () => {
        db.close();
        reject(transaction.error);
      };
      transaction.onabort = () => {
        db.close();
        reject(transaction.error);
      };
    });
  }

  async function deleteSavedHandle() {
    const db = await openSaveHandleDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(SAVE_HANDLE_STORE, "readwrite");
      transaction.objectStore(SAVE_HANDLE_STORE).delete(SAVE_HANDLE_KEY);
      transaction.oncomplete = () => {
        db.close();
        resolve();
      };
      transaction.onerror = () => {
        db.close();
        reject(transaction.error);
      };
      transaction.onabort = () => {
        db.close();
        reject(transaction.error);
      };
    });
  }

  function updateWatchButton() {
    if (watchActive && watchedSaveHandle) {
      btnWatchSave.textContent = "停止监听";
    } else if (watchPermissionPending && watchedSaveHandle) {
      btnWatchSave.textContent = "恢复监听";
    } else {
      btnWatchSave.textContent = "监听存档";
    }
  }

  function pageSaveMapping() {
    try {
      if (typeof save_to_reserve !== "undefined") return save_to_reserve;
    } catch {
      // 尝试页面 window 属性
    }
    return window.save_to_reserve ?? null;
  }

  function isPageReadyForSave(saveName) {
    const mapping = pageSaveMapping();
    const reserveId = mapping?.[saveName];
    if (!reserveId) return false;
    try {
      return (
        typeof areas !== "undefined" &&
        Boolean(areas[reserveId]) &&
        typeof reserve_population_info !== "undefined" &&
        Boolean(reserve_population_info[reserveId]) &&
        typeof area_spawn_center_points !== "undefined" &&
        Boolean(area_spawn_center_points[reserveId])
      );
    } catch {
      return false;
    }
  }

  function startsWithBytes(bytes, signature) {
    return (
      bytes.length >= signature.length &&
      signature.every((value, index) => bytes[index] === value)
    );
  }

  function parseAndApplySave(saveName, bytes) {
    if (!SAVE_FILE_PATTERN.test(saveName)) {
      throw new Error("请选择 animal_population_数字 格式的单个存档文件");
    }
    const mapping = pageSaveMapping();
    if (!mapping || !Object.prototype.hasOwnProperty.call(mapping, saveName)) {
      throw new Error("DECA 地图不识别这个存档文件");
    }

    let raw = bytes;
    if (startsWithBytes(raw, SAVE_MAGIC)) {
      const inflater = typeof pako !== "undefined" ? pako : window.pako;
      if (!inflater?.inflate) throw new Error("DECA 解压组件尚未就绪");
      raw = inflater.inflate(raw.slice(34), { windowBits: -15 });
    }
    if (startsWithBytes(raw, ADF_ENVELOPE)) raw = raw.slice(5);
    if (!startsWithBytes(raw, ADF_MAGIC))
      throw new Error("存档格式不符合 DECA 解析器预期");

    const parseAdf =
      typeof adfProcess !== "undefined" ? adfProcess : window.adfProcess;
    if (typeof parseAdf !== "function")
      throw new Error("DECA ADF 解析器尚未就绪");
    const reserveData = parseAdf(raw);
    if (!reserveData) throw new Error("ADF 存档解析失败");

    const processSave = window.processSaveReserve;
    if (typeof processSave !== "function")
      throw new Error("DECA 存档处理函数尚未就绪");
    processSave.call(window, saveName, reserveData);
  }

  function saveFileSignature(file) {
    return `${file.lastModified}:${file.size}`;
  }

  function stopSaveWatchTimer() {
    watchActive = false;
    clearInterval(watchTimer);
    watchTimer = null;
    watchCandidateSignature = null;
    updateWatchButton();
  }

  function startSaveWatch(handle) {
    clearInterval(watchTimer);
    watchedSaveHandle = handle;
    watchActive = true;
    watchPermissionPending = false;
    watchLastSignature = null;
    watchCandidateSignature = null;
    watchLastError = null;
    updateWatchButton();
    void pollWatchedSave(true);
    watchTimer = setInterval(() => void pollWatchedSave(false), 2500);
  }

  async function pollWatchedSave(force) {
    if (
      !watchActive ||
      !watchedSaveHandle ||
      watchPollInFlight ||
      document.hidden
    )
      return;
    watchPollInFlight = true;
    const handle = watchedSaveHandle;

    try {
      const permission = await handle.queryPermission({ mode: "read" });
      if (permission !== "granted") {
        stopSaveWatchTimer();
        watchPermissionPending = true;
        updateWatchButton();
        status.textContent = "需要重新授权";
        return;
      }

      const file = await handle.getFile();
      const signature = saveFileSignature(file);
      if (signature === watchLastSignature) {
        watchCandidateSignature = null;
        return;
      }

      if (!force) {
        if (signature !== watchCandidateSignature) {
          watchCandidateSignature = signature;
          watchCandidateSince = Date.now();
          return;
        }
        if (Date.now() - watchCandidateSince < 2000) return;
      }

      if (!isPageReadyForSave(file.name)) {
        status.textContent = "等待 DECA 地图数据就绪…";
        return;
      }

      const bytes = new Uint8Array(await file.arrayBuffer());
      const latestFile = await handle.getFile();
      if (saveFileSignature(latestFile) !== signature) {
        watchCandidateSignature = null;
        return;
      }
      if (!watchActive || watchedSaveHandle !== handle) return;

      parseAndApplySave(file.name, bytes);
      watchLastSignature = signature;
      watchCandidateSignature = null;
      watchLastError = null;
      status.textContent = `已同步：${file.name}`;
    } catch (error) {
      const errorKey = `${watchedSaveHandle?.name}:${error?.name}:${error?.message}`;
      if (errorKey !== watchLastError) {
        console.error(
          "[COTW 种群分数筛选] 自动读取存档失败，将继续重试",
          error,
        );
        watchLastError = errorKey;
      }
      status.textContent = "读取失败，将重试";
    } finally {
      watchPollInFlight = false;
    }
  }

  async function handleWatchSaveClick() {
    if (
      !window.isSecureContext ||
      typeof window.showOpenFilePicker !== "function"
    ) {
      status.textContent = "浏览器不支持文件监听";
      return;
    }

    if (watchActive) {
      stopSaveWatchTimer();
      watchedSaveHandle = null;
      watchPermissionPending = false;
      watchLastSignature = null;
      try {
        await deleteSavedHandle();
      } catch (error) {
        console.warn("[COTW 种群分数筛选] 无法清除已保存的存档文件句柄", error);
      }
      status.textContent = "已停止存档监听";
      updateWatchButton();
      return;
    }

    if (watchPermissionPending && watchedSaveHandle) {
      try {
        const permission = await watchedSaveHandle.requestPermission({
          mode: "read",
        });
        if (permission === "granted") {
          startSaveWatch(watchedSaveHandle);
        } else {
          watchedSaveHandle = null;
          watchPermissionPending = false;
          await deleteSavedHandle();
          updateWatchButton();
          status.textContent = "权限未授予，请重新选择文件";
        }
      } catch (error) {
        updateWatchButton();
        status.textContent = "恢复权限失败";
        console.warn("[COTW 种群分数筛选] 恢复存档权限失败", error);
      }
      return;
    }

    try {
      const [handle] = await window.showOpenFilePicker({ multiple: false });
      if (!handle) return;
      if (!SAVE_FILE_PATTERN.test(handle.name)) {
        status.textContent = "请选择 animal_population_* 文件";
        return;
      }
      const mapping = pageSaveMapping();
      if (
        !mapping ||
        !Object.prototype.hasOwnProperty.call(mapping, handle.name)
      ) {
        status.textContent = "存档文件不匹配";
        return;
      }

      watchedSaveHandle = handle;
      try {
        await writeSavedHandle(handle);
      } catch (error) {
        console.warn(
          "[COTW 种群分数筛选] 无法记住存档文件句柄，本次页面仍会监听",
          error,
        );
        status.textContent = "已开始监听；刷新后需重新选择";
      }
      startSaveWatch(handle);
    } catch (error) {
      if (error?.name !== "AbortError") {
        status.textContent = "选择失败";
        console.error("[COTW 种群分数筛选] 选择存档文件失败", error);
      }
    }
  }

  async function restoreSaveWatch() {
    if (
      !window.isSecureContext ||
      typeof window.showOpenFilePicker !== "function"
    ) {
      btnWatchSave.disabled = true;
      btnWatchSave.textContent = "不支持监听";
      return;
    }
    if (!window.indexedDB) {
      return;
    }

    try {
      const handle = await readSavedHandle();
      if (!handle || !SAVE_FILE_PATTERN.test(handle.name)) return;
      watchedSaveHandle = handle;
      const permission = await handle.queryPermission({ mode: "read" });
      if (permission === "granted") {
        startSaveWatch(handle);
      } else if (permission === "prompt") {
        watchPermissionPending = true;
        updateWatchButton();
      } else {
        watchedSaveHandle = null;
        await deleteSavedHandle();
        updateWatchButton();
      }
    } catch (error) {
      console.warn("[COTW 种群分数筛选] 无法恢复上次监听的存档文件", error);
    }
  }

  btnWatchSave.addEventListener("click", () => void handleWatchSaveClick());
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && watchActive) void pollWatchedSave(false);
  });

  btnApply.addEventListener("click", () => void applyFilter());
  btnClear.addEventListener("click", clearAll);
  selSpecies.addEventListener("change", updatePreview);
  inpMin.addEventListener("input", updatePreview);
  inpMax.addEventListener("input", updatePreview);

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
    const root = $("#pop_nav");
    if (
      root === processedTree &&
      scoresVersion === processedVersion &&
      groupCache.length
    )
      return;
    processedTree = root;
    processedVersion = scoresVersion;

    await rebuildIndex();
    refreshSpecies();
    updatePreview();
    renderSelectedArea();
  }

  const attachedMaps = new WeakSet();

  function resolvePageMap() {
    try {
      return typeof map !== "undefined" ? map : null;
    } catch {
      return null;
    }
  }

  function attachMapClickListener() {
    const pageMap = resolvePageMap();
    if (
      !pageMap ||
      typeof pageMap.on !== "function" ||
      attachedMaps.has(pageMap)
    )
      return;
    attachedMaps.add(pageMap);

    selectedAreaEntries = [];
    areaEmptyText = "";
    renderSelectedArea();

    // 独立监听页面地图事件；不覆盖原有点击处理器或 map_info 内容。
    pageMap.on("click", (event) => {
      try {
        selectedAreaEntries = groupsAtMapPoint(pageMap, event.latlng);
        areaEmptyText = selectedAreaEntries.length
          ? ""
          : "本次点击未命中可显示的种群区域";
      } catch (error) {
        selectedAreaEntries = [];
        areaEmptyText = "区域信息读取失败；原地图信息栏仍可用";
        console.error("[COTW 种群分数筛选] 读取地图区域失败", error);
      }
      renderSelectedArea();
    });
  }

  const mapContainer = $("#map_display");
  attachMapClickListener();
  if (mapContainer) {
    // 切换保护区时页面会重建 Leaflet map；等新地图 DOM 就绪后绑定一次。
    new MutationObserver(attachMapClickListener).observe(mapContainer, {
      childList: true,
    });
  }

  const dropzone = $("#dropzone");
  if (dropzone) {
    new MutationObserver(queueRebuild).observe(dropzone, {
      childList: true,
      subtree: true,
    });
  }

  hookSaveParser();
  void onTreeChanged();
  void restoreSaveWatch();
})();
