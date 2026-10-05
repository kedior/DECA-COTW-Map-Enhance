// ==UserScript==
// @name         DECA COTW 地图 · 种群分数筛选
// @namespace    cotw-kedior
// @version      1.7.0
// @description  按物种、分数、体重、性别筛选动物兽群，支持个体分数、已选个体列表、筛选条件预设与手动刷新存档
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

  // 主操作（筛选 / 清空 / 存档读取）进行中，期间禁用按钮
  let operationInFlight = false;
  // 当前选中的存档文件句柄，顶部要显示它对应的存档名
  let selectedSaveHandle = null;

  // 分片执行：按时间预算让出主线程，避免长任务卡住页面
  async function runBatches(items, worker, budgetMs = 8) {
    let t0 = performance.now();
    for (let i = 0; i < items.length; ++i) {
      if (worker(items[i], i) === false) return false;
      if (performance.now() - t0 > budgetMs) {
        await yieldToUI();
        t0 = performance.now();
      }
    }
    return true;
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

  // —— 个体数据捕获 ——
  // 页面解析存档时个体数据算完 max 就被丢弃，这里挂钩子留存。
  // 每个个体记下 score / weight / gender（gender：1=公，2=母）。
  // group_index 按页面实际生成的地图组编号计算，跳过不会生成图层的原始群。

  const MALE = 1;
  const FEMALE = 2;
  const GENDER_SYMBOL = { [MALE]: "♂", [FEMALE]: "♀" };
  // 公母配色：蓝 = 公，粉 = 母
  const genderClass = (gender) =>
    gender === MALE ? "cotw-male" : gender === FEMALE ? "cotw-female" : "";
  const individualsByReserve = new Map(); // reserveId -> Map<key, Individual[]>
  const keyOf = (...parts) => JSON.stringify(parts.map(String));
  const mapGroupKey = (populationId, spawnAreaId, groupIndex) =>
    keyOf(populationId, spawnAreaId, groupIndex);

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

  let individualsVersion = 0;

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
      const populations = Array.isArray(reserveData?.Populations)
        ? reserveData.Populations
        : [];
      for (const population of populations) {
        if (!population || typeof population !== "object") continue;
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
          const individuals = (group.Animals ?? [])
            .map((animal) => ({
              score: Number(animal?.Score),
              weight: Number(animal?.Weight),
              gender: Number(animal?.Gender),
            }))
            .filter((individual) => Number.isFinite(individual.score))
            .sort((a, b) => b.score - a.score);
          if (individuals.length)
            table.set(keyOf(name, spawnAreaId, pageIndex), individuals);
        }
      }
    }

    // 覆盖空表也能清除该保护区先前缓存，避免新存档沿用旧数据。
    individualsByReserve.set(reserveId, table);
    individualsVersion += 1;
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

  let groupCache = []; // [{cb, name, individuals: Individual[]|null}]
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

  function lookupIndividuals(name, { spawnAreaId, groupIndex }) {
    const table = individualsByReserve.get(currentReserveId());
    return table?.get(keyOf(name, spawnAreaId, groupIndex)) ?? null;
  }

  // —— 面板 ——

  const style = document.createElement("style");
  style.textContent = `
        #cotw-filter-panel {
            position: fixed; top: 12px; right: 12px; z-index: 10000;
            display: flex; flex-direction: column; max-height: calc(100vh - 24px);
            background: rgba(20, 24, 28, 0.88); color: #eee;
            border-radius: 8px; font: 13px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
            box-shadow: 0 2px 10px rgba(0,0,0,0.45); user-select: none;
        }
        #cotw-filter-header {
            padding: 8px 12px; cursor: move; font-weight: 600;
            display: flex; align-items: center; gap: 8px;
        }
        #cotw-filter-header > span:first-child, #cotw-filter-toggle { flex: none; }
        #cotw-header-info {
            flex: 1 1 auto; min-width: 0; text-align: right; font-weight: 400; font-size: 12px;
            color: #9fd3a4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        #cotw-panel-columns { display: flex; position: relative; min-height: 0; }
        #cotw-filter-body {
            position: relative; width: 280px; box-sizing: border-box; padding: 0 12px 12px;
            margin-left: 236px; overflow-y: auto;
        }
        #cotw-filter-panel.collapsed #cotw-panel-columns { display: none; }
        /* 左栏脱离文档流：面板高度只由右栏撑开，列表再长也不会拉高面板 */
        #cotw-selected-panel {
            position: absolute; top: 0; bottom: 0; left: 0;
            display: flex; flex-direction: column; min-height: 0;
            width: 236px; box-sizing: border-box; padding: 0 8px 8px;
            border-right: 1px solid rgba(255, 255, 255, 0.14);
        }
        .cotw-selected-toolbar { display: flex; align-items: center; gap: 6px; }
        #cotw-selected-panel button {
            width: auto; margin-top: 0; padding: 4px 8px; border: 0; border-radius: 4px;
            background: #555f66; color: #fff; font-size: 12px; cursor: pointer;
        }
        #cotw-selected-panel button:hover { filter: brightness(1.12); }
        #cotw-selected-panel button:disabled { opacity: 0.45; cursor: default; filter: none; }
        #cotw-selected-panel button.cotw-sort-active { background: #2f8f3e; }
        .cotw-selected-sort { display: flex; gap: 4px; margin-left: auto; }
        #cotw-selected-list { margin-top: 6px; flex: 1; min-height: 0; overflow-y: auto; }
        .cotw-sel-row {
            display: grid; grid-template-columns: auto 7em 5ch 8ch;
            align-items: center; gap: 6px; padding: 2px 0; font-size: 12px; cursor: pointer;
        }
        .cotw-sel-row input { width: auto; margin: 0; }
        .cotw-sel-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .cotw-sel-name.cotw-male { color: #4a90e2; }
        .cotw-sel-name.cotw-female { color: #e26a9a; }
        .cotw-sel-score, .cotw-sel-weight {
            text-align: left; font-variant-numeric: tabular-nums;
        }
        #cotw-selected-empty { padding: 6px 0; color: #888; font-size: 12px; }
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
        #cotw-selected-save-actions:not([hidden]) { display: flex; gap: 8px; }
        #cotw-selected-save-actions button { flex: 1; width: auto; min-width: 0; }
        .cotw-range { display: flex; gap: 8px; }
        .cotw-range > div { flex: 1; }
        .cotw-genders { display: flex; gap: 18px; }
        #cotw-filter-body .cotw-genders label {
            display: inline-flex; align-items: center; gap: 4px;
            margin: 0; font-size: 12px; color: #eee;
        }
        #cotw-filter-body .cotw-genders input { width: auto; }
        #cotw-filter-body .cotw-preset-row { display: flex; gap: 8px; }
        #cotw-filter-body .cotw-preset-row select { flex: 1; min-width: 0; width: auto; }
        #cotw-filter-body .cotw-preset-row button {
            width: auto; flex: none; margin-top: 0; padding: 7px 10px; font-size: 12px;
        }
        .cotw-preset-dialog {
            position: absolute; inset: 0; z-index: 10; box-sizing: border-box;
            display: flex; align-items: center; justify-content: center; padding: 12px;
            background: rgba(0, 0, 0, 0.6); border-radius: 8px; user-select: text;
        }
        .cotw-preset-dialog[hidden] { display: none; }
        .cotw-dialog-card {
            width: 100%; padding: 10px; border: 1px solid #556; border-radius: 6px;
            background: #1b2026;
        }
        .cotw-dialog-title { margin-bottom: 6px; font-weight: 600; }
        .cotw-dialog-card input {
            width: 100%; box-sizing: border-box; padding: 5px 6px;
            border: 1px solid #555; border-radius: 4px; background: #fff; color: #222;
            font-size: 13px;
        }
        .cotw-dialog-error { min-height: 1.2em; margin-top: 4px; font-size: 12px; color: #ff8f8f; }
        .cotw-dialog-actions { display: flex; gap: 8px; margin-top: 2px; }
        .cotw-dialog-actions button {
            flex: 1; width: auto; margin-top: 0; padding: 7px 0; border: 0; border-radius: 4px;
            background: #2f8f3e; color: #fff; font-size: 13px; cursor: pointer;
        }
        .cotw-dialog-actions button.cotw-secondary { background: #555f66; }
        .cotw-dialog-actions button:hover { filter: brightness(1.12); }
        #cotw-status { margin-top: 8px; font-size: 12px; color: #ffcf7a; word-break: break-all; }
        #cotw-status:empty { display: none; }
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
        #pop_nav ul.cotw-animals > li.cotw-male { color: #4a90e2; }
        #pop_nav ul.cotw-animals > li.cotw-female { color: #e26a9a; }
        .cotw-area-score.cotw-male { color: #4a90e2; }
        .cotw-area-score.cotw-female { color: #e26a9a; }
        #pop_nav .cotw-caret { cursor: pointer; }
    `;
  document.head.appendChild(style);

  const panel = document.createElement("div");
  panel.id = "cotw-filter-panel";
  panel.innerHTML = `
        <div id="cotw-filter-header"><span>🦌 种群筛选</span><span id="cotw-header-info"></span><span id="cotw-filter-toggle">−</span></div>
        <div id="cotw-panel-columns">
            <div id="cotw-selected-panel">
                <div class="cotw-selected-toolbar">
                    <button id="cotw-select-all">全选</button>
                    <button id="cotw-select-none">全不选</button>
                    <span class="cotw-selected-sort">
                        <button id="cotw-sort-score">分数↓</button>
                        <button id="cotw-sort-weight">体重↓</button>
                    </span>
                </div>
                <div id="cotw-selected-list"></div>
                <div id="cotw-selected-empty">还没有加入的个体</div>
            </div>
            <div id="cotw-filter-body">
                <button id="cotw-select-save" class="cotw-secondary">选择存档文件</button>
                <div id="cotw-selected-save-actions" hidden>
                    <button id="cotw-reselect-save" class="cotw-secondary">重新选择存档</button>
                    <button id="cotw-refresh-save">刷新存档</button>
                </div>
                <label>物种</label>
                <select id="cotw-species"></select>
                <label>筛选条件</label>
                <div class="cotw-preset-row">
                    <select id="cotw-preset"></select>
                    <button id="cotw-preset-save" class="cotw-secondary">保存</button>
                    <button id="cotw-preset-delete" class="cotw-secondary">删除</button>
                </div>
                <div class="cotw-range">
                    <div><label>最小分数</label><input id="cotw-min" type="number" step="0.1" placeholder="不限"></div>
                    <div><label>最大分数</label><input id="cotw-max" type="number" step="0.1" placeholder="不限"></div>
                </div>
                <div class="cotw-range">
                    <div><label>最小体重</label><input id="cotw-weight-min" type="number" step="0.1" placeholder="不限"></div>
                    <div><label>最大体重</label><input id="cotw-weight-max" type="number" step="0.1" placeholder="不限"></div>
                </div>
                <label>性别</label>
                <div class="cotw-genders">
                    <label><input id="cotw-gender-male" type="checkbox" checked> 公 ♂</label>
                    <label><input id="cotw-gender-female" type="checkbox" checked> 母 ♀</label>
                </div>
                <button id="cotw-apply">筛选并加入列表</button>
                <button id="cotw-clear" class="cotw-secondary">清空列表</button>
                <div id="cotw-status"></div>
                <div id="cotw-area-info" hidden>
                    <div id="cotw-area-results"></div>
                </div>
                <div id="cotw-preset-dialog" class="cotw-preset-dialog" hidden>
                    <div class="cotw-dialog-card">
                        <div class="cotw-dialog-title">保存筛选条件</div>
                        <input id="cotw-preset-name" type="text" maxlength="20" placeholder="条件名称">
                        <div id="cotw-preset-error" class="cotw-dialog-error"></div>
                        <div class="cotw-dialog-actions">
                            <button id="cotw-preset-cancel" class="cotw-secondary">取消</button>
                            <button id="cotw-preset-confirm">保存</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
  document.body.appendChild(panel);

  const header = $("#cotw-filter-header", panel);
  const toggle = $("#cotw-filter-toggle", panel);
  const headerInfo = $("#cotw-header-info", panel);
  const selectedList = $("#cotw-selected-list", panel);
  const selectedEmpty = $("#cotw-selected-empty", panel);
  const btnSelectAll = $("#cotw-select-all", panel);
  const btnSelectNone = $("#cotw-select-none", panel);
  const btnSortScore = $("#cotw-sort-score", panel);
  const btnSortWeight = $("#cotw-sort-weight", panel);
  const selSpecies = $("#cotw-species", panel);
  const selPreset = $("#cotw-preset", panel);
  const btnSavePreset = $("#cotw-preset-save", panel);
  const btnDeletePreset = $("#cotw-preset-delete", panel);
  const presetDialog = $("#cotw-preset-dialog", panel);
  const inpPresetName = $("#cotw-preset-name", panel);
  const presetError = $("#cotw-preset-error", panel);
  const btnPresetCancel = $("#cotw-preset-cancel", panel);
  const btnPresetConfirm = $("#cotw-preset-confirm", panel);
  const inpMin = $("#cotw-min", panel);
  const inpMax = $("#cotw-max", panel);
  const inpWeightMin = $("#cotw-weight-min", panel);
  const inpWeightMax = $("#cotw-weight-max", panel);
  const chkMale = $("#cotw-gender-male", panel);
  const chkFemale = $("#cotw-gender-female", panel);
  const btnApply = $("#cotw-apply", panel);
  const btnClear = $("#cotw-clear", panel);
  const btnSelectSave = $("#cotw-select-save", panel);
  const selectedSaveActions = $("#cotw-selected-save-actions", panel);
  const btnReselectSave = $("#cotw-reselect-save", panel);
  const btnRefreshSave = $("#cotw-refresh-save", panel);
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

  // —— 筛选条件 ——

  const boundValue = (inp) => {
    const v = inp.value.trim();
    return v === "" ? null : parseFloat(v);
  };

  // 边界包含在范围内；两侧都留空表示该维度不限制
  const inRange = (value, min, max) => {
    if (min === null && max === null) return true;
    return (
      Number.isFinite(value) &&
      (min === null || value >= min) &&
      (max === null || value <= max)
    );
  };

  // 把面板上的三组条件收敛成一个过滤器。
  // 体重和性别只存在于个体数据里，地图行文本只有 Max Score，
  // 所以缺个体数据的兽群在这些条件生效时不能回退猜测。
  function makeFilter() {
    const scoreMin = boundValue(inpMin);
    const scoreMax = boundValue(inpMax);
    const weightMin = boundValue(inpWeightMin);
    const weightMax = boundValue(inpWeightMax);
    const genders = new Set();
    if (chkMale.checked) genders.add(MALE);
    if (chkFemale.checked) genders.add(FEMALE);
    // 两个都勾或都不勾都表示不限性别
    const onlyGenders = genders.size === 1 ? genders : null;
    const hasWeightRange = weightMin !== null || weightMax !== null;

    return {
      needsIndividuals: hasWeightRange || onlyGenders !== null,
      test: (individual) =>
        inRange(individual.score, scoreMin, scoreMax) &&
        inRange(individual.weight, weightMin, weightMax) &&
        (onlyGenders === null || onlyGenders.has(individual.gender)),
      testFallback: (maxScore) =>
        !hasWeightRange && inRange(maxScore, scoreMin, scoreMax),
    };
  }

  // —— 筛选条件预设 ——
  // 只存四个数值框和性别，物种不进预设；套用预设只替换数值，不触发勾选。

  const PRESET_STORAGE_KEY = "cotw-filter-presets";
  let presets = [];

  const finiteOrNull = (value) =>
    typeof value === "number" && Number.isFinite(value) ? value : null;

  function normalizePreset(raw) {
    if (!raw || typeof raw !== "object") return null;
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (!name) return null;
    return {
      name,
      scoreMin: finiteOrNull(raw.scoreMin),
      scoreMax: finiteOrNull(raw.scoreMax),
      weightMin: finiteOrNull(raw.weightMin),
      weightMax: finiteOrNull(raw.weightMax),
      male: raw.male !== false,
      female: raw.female !== false,
    };
  }

  function loadPresets() {
    try {
      const parsed = JSON.parse(
        localStorage.getItem(PRESET_STORAGE_KEY) ?? "[]",
      );
      if (!Array.isArray(parsed)) return [];
      return parsed.map(normalizePreset).filter(Boolean);
    } catch (error) {
      console.warn("[COTW 种群分数筛选] 无法读取保存的筛选条件", error);
      return [];
    }
  }

  function persistPresets() {
    try {
      localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(presets));
    } catch (error) {
      console.warn("[COTW 种群分数筛选] 无法保存筛选条件", error);
    }
  }

  // 当前面板上的四项条件，不含物种
  function currentConditions() {
    return {
      scoreMin: finiteOrNull(boundValue(inpMin)),
      scoreMax: finiteOrNull(boundValue(inpMax)),
      weightMin: finiteOrNull(boundValue(inpWeightMin)),
      weightMax: finiteOrNull(boundValue(inpWeightMax)),
      male: chkMale.checked,
      female: chkFemale.checked,
    };
  }

  const fillConditionInput = (inp, value) => {
    inp.value = value === null || value === undefined ? "" : String(value);
  };

  // 只替换数值和性别，不勾选也不取消；状态栏跟着刷新预览
  function applyPreset(preset) {
    fillConditionInput(inpMin, preset.scoreMin);
    fillConditionInput(inpMax, preset.scoreMax);
    fillConditionInput(inpWeightMin, preset.weightMin);
    fillConditionInput(inpWeightMax, preset.weightMax);
    chkMale.checked = preset.male;
    chkFemale.checked = preset.female;
    updatePreview();
  }

  function refreshPresetOptions(selectName = null) {
    const previous = selectName ?? selPreset.value;
    selPreset.replaceChildren();

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = presets.length
      ? "选择已保存条件"
      : "暂无保存的条件";
    selPreset.appendChild(placeholder);

    for (const preset of presets) {
      const option = document.createElement("option");
      option.value = preset.name;
      option.textContent = preset.name;
      selPreset.appendChild(option);
    }
    selPreset.value = presets.some((preset) => preset.name === previous)
      ? previous
      : "";
    updateActionControls();
  }

  // 手动改动任意条件后，下拉框退回默认项，避免显示与实际数值不符的预设名
  function resetPresetSelection() {
    if (!selPreset.value) return;
    selPreset.value = "";
    updateActionControls();
  }

  function openPresetDialog() {
    if (operationInFlight) return;
    inpPresetName.value = selPreset.value;
    presetError.textContent = "";
    presetDialog.hidden = false;
    inpPresetName.focus();
    inpPresetName.select();
  }

  function closePresetDialog() {
    presetDialog.hidden = true;
    presetError.textContent = "";
  }

  function confirmPresetSave() {
    const name = inpPresetName.value.trim();
    if (!name) {
      presetError.textContent = "请输入条件名称";
      return;
    }
    if (presets.some((preset) => preset.name === name)) {
      presetError.textContent = "已存在同名条件，请换一个名字";
      return;
    }

    presets.push({ name, ...currentConditions() });
    persistPresets();
    refreshPresetOptions(name);
    closePresetDialog();
  }

  function deleteSelectedPreset() {
    const name = selPreset.value;
    if (!name) return;
    presets = presets.filter((preset) => preset.name !== name);
    persistPresets();
    refreshPresetOptions("");
  }

  // —— 地图点击区域的个体信息 ——

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

      const key = mapGroupKey(
        info.population_id,
        info.spawn_area_id,
        info.group_index,
      );
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

  let groupCacheByMapKey = new Map();

  function findCachedGroup(entry) {
    const group = groupCacheByMapKey.get(
      mapGroupKey(entry.populationId, entry.spawnAreaId, entry.groupIndex),
    );
    return group?.cb.isConnected ? group : null;
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

      if (group?.individuals?.length) {
        const scoreTitle = document.createElement("div");
        scoreTitle.className = "cotw-area-meta";
        scoreTitle.textContent = `个体（${group.individuals.length} 只）`;
        block.appendChild(scoreTitle);

        const chips = document.createElement("div");
        chips.className = "cotw-area-scores";
        for (const individual of group.individuals) {
          const { text, genderClass } = individualView(individual);
          const chip = document.createElement("span");
          chip.className = `cotw-area-score ${genderClass}`.trim();
          chip.textContent = text;
          chips.appendChild(chip);
        }
        block.appendChild(chips);
      } else {
        const unavailable = document.createElement("div");
        unavailable.className = "cotw-area-meta";
        unavailable.textContent = "个体数据不可用";
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

  // 个体显示：性别符号 + 分数/体重kg，公母各用一个颜色类
  function individualView(individual) {
    const symbol = GENDER_SYMBOL[individual.gender] ?? "?";
    const weight = Number.isFinite(individual.weight)
      ? `/${individual.weight.toFixed(1)}kg`
      : "";
    return {
      text: `${symbol} ${individual.score.toFixed(1)}${weight}`,
      genderClass: genderClass(individual.gender),
    };
  }

  function syncGroupIndividuals(li, individuals) {
    let list = $(":scope > ul.cotw-animals", li);
    const caret = $(":scope > .nav-spacer, :scope > .cotw-caret", li);

    if (!individuals?.length) {
      list?.remove();
      if (caret) caret.className = "nav-spacer";
      return;
    }

    if (!list) {
      list = document.createElement("ul");
      list.className = "nested cotw-animals";
      li.append(list);
    }
    list.replaceChildren(
      ...individuals.map((individual) => {
        const { text, genderClass } = individualView(individual);
        const row = document.createElement("li");
        if (genderClass) row.className = genderClass;
        row.textContent = text;
        return row;
      }),
    );

    if (!caret) return;
    caret.classList.remove("nav-spacer");
    caret.classList.add("nav-caret", "cotw-caret");
    caret.classList.toggle("nav-caret-down", list.classList.contains("active"));
    if (!caret.dataset.cotwScoresToggleBound) {
      caret.dataset.cotwScoresToggleBound = "true";
      caret.addEventListener("click", () => {
        const currentList = $(":scope > ul.cotw-animals", li);
        if (!currentList) return;
        const expanded = currentList.classList.toggle("active");
        caret.classList.toggle("nav-caret-down", expanded);
      });
    }
  }

  // —— 已选个体列表 ——
  // 列表是被勾选兽群内全部个体的暂存区：筛选只往里追加，只有「清空列表」才移除行。
  // 行与兽群勾选框双向同步：取消到一只不剩就取消兽群，手动勾选兽群就补齐该群个体。

  let selectedRows = []; // [{cb, index, name, gender, score, weight, checked}]
  let sortKey = "score";
  let sortDesc = true;
  let suppressTreeSync = 0; // 列表写回树时，抑制「树 → 列表」回灌

  const findRow = (cb, index) =>
    selectedRows.find((row) => row.cb === cb && row.index === index);

  // 行上标记所属兽群，便于和树上的行对应
  const groupKeyOf = (cb) =>
    `${cb.dataset.spawnAreaId ?? ""}/${cb.dataset.groupIndex ?? ""}`;

  // 把某兽群中通过 test 的个体补进列表；recheck 为真时把已存在的行重新勾上
  function appendGroupIndividuals(group, test, recheck = false) {
    const individuals = group.individuals;
    if (!individuals?.length) return 0;
    let added = 0;
    individuals.forEach((individual, index) => {
      const row = findRow(group.cb, index);
      if (row) {
        if (recheck && test(individual) && !row.checked) row.checked = true;
        return;
      }
      if (!test(individual)) return;
      selectedRows.push({
        cb: group.cb,
        index,
        name: group.name,
        gender: individual.gender,
        score: individual.score,
        weight: individual.weight,
        checked: true,
      });
      added += 1;
    });
    return added;
  }

  // 只在列表 → 树方向使用：避开 setChecked 触发的 change 事件又回灌列表
  function setCheckedQuiet(cb, want) {
    suppressTreeSync += 1;
    try {
      setChecked(cb, want);
    } finally {
      suppressTreeSync -= 1;
    }
  }

  const sortValue = (row, key) => (key === "score" ? row.score : row.weight);

  // 主排序键之外再用另一个维度兜底；非有限值始终排在最后
  function compareRows(a, b) {
    for (const key of [sortKey, sortKey === "score" ? "weight" : "score"]) {
      const av = sortValue(a, key);
      const bv = sortValue(b, key);
      const am = !Number.isFinite(av);
      const bm = !Number.isFinite(bv);
      if (am !== bm) return am ? 1 : -1;
      if (am && bm) continue;
      if (av !== bv) return sortDesc ? bv - av : av - bv;
    }
    return a.name.localeCompare(b.name);
  }

  function renderSelectedRow(row) {
    const label = document.createElement("label");
    label.className = "cotw-sel-row";
    label.dataset.group = groupKeyOf(row.cb);

    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = row.checked;
    box.addEventListener("change", () => toggleRow(row, box.checked));

    const name = document.createElement("span");
    name.className = `cotw-sel-name ${genderClass(row.gender)}`.trim();
    name.textContent = `${row.name} ${GENDER_SYMBOL[row.gender] ?? "?"}`;
    name.title = name.textContent;

    const score = document.createElement("span");
    score.className = "cotw-sel-score";
    score.textContent = row.score.toFixed(1);

    const weight = document.createElement("span");
    weight.className = "cotw-sel-weight";
    weight.textContent = Number.isFinite(row.weight)
      ? `${row.weight.toFixed(1)}kg`
      : "—";

    label.append(box, name, score, weight);
    return label;
  }

  function renderSelectedList() {
    const checked = selectedRows.filter((row) => row.checked).length;
    const parts = [];
    if (selectedRows.length)
      parts.push(`已选 ${checked} / ${selectedRows.length} 只`);
    if (selectedSaveHandle) parts.push(selectedSaveHandle.name);
    headerInfo.textContent = parts.join(" ｜ ");
    selectedEmpty.hidden = selectedRows.length > 0;
    selectedList.replaceChildren(
      ...[...selectedRows].sort(compareRows).map(renderSelectedRow),
    );

    btnSortScore.textContent = `分数${sortKey === "score" && !sortDesc ? "↑" : "↓"}`;
    btnSortWeight.textContent = `体重${sortKey === "weight" && !sortDesc ? "↑" : "↓"}`;
    btnSortScore.classList.toggle("cotw-sort-active", sortKey === "score");
    btnSortWeight.classList.toggle("cotw-sort-active", sortKey === "weight");

    btnSelectAll.disabled =
      operationInFlight || !selectedRows.some((row) => !row.checked);
    btnSelectNone.disabled =
      operationInFlight || !selectedRows.some((row) => row.checked);
    btnSortScore.disabled = operationInFlight;
    btnSortWeight.disabled = operationInFlight;
  }

  // 列表里取消个体：群内还有别的被勾个体就保持兽群勾选，一只不剩才取消
  function toggleRow(row, checked) {
    row.checked = checked;
    setCheckedQuiet(
      row.cb,
      selectedRows.some((item) => item.cb === row.cb && item.checked),
    );
    renderSelectedList();
  }

  // 树 → 列表：手动勾选兽群不写入新行（列表只由「筛选并加入列表」写入），
  // 但会把列表里已有的该群个体重新勾上；手动取消则把该群的行取消勾选
  function syncRowsFromGroup(cb) {
    const rows = selectedRows.filter((row) => row.cb === cb);
    if (cb.checked) {
      if (!rows.some((row) => !row.checked)) return;
      rows.forEach((row) => {
        row.checked = true;
      });
    } else {
      if (!rows.some((row) => row.checked)) return;
      rows.forEach((row) => {
        row.checked = false;
      });
    }
    renderSelectedList();
  }

  function onTreeCheckboxChanged(event) {
    if (suppressTreeSync) return;
    const cb = event.target;
    if (!cb?.matches?.("input.nav-visible")) return;
    syncRowsFromGroup(cb);
  }

  // 只作用于列表里已有的行，并同步回树
  function setAllRowsChecked(checked) {
    if (!selectedRows.length) return;
    selectedRows.forEach((row) => {
      row.checked = checked;
    });
    const groups = new Set(selectedRows.map((row) => row.cb));
    suppressTreeSync += 1;
    try {
      groups.forEach((cb) => setChecked(cb, checked));
    } finally {
      suppressTreeSync -= 1;
    }
    renderSelectedList();
  }

  function setSortKey(key) {
    if (sortKey === key) sortDesc = !sortDesc;
    else {
      sortKey = key;
      sortDesc = true;
    }
    renderSelectedList();
  }

  function clearSelectedRows() {
    selectedRows = [];
    renderSelectedList();
  }

  let rebuildToken = 0;

  async function rebuildIndex(inputs) {
    const token = ++rebuildToken;
    const version = individualsVersion;
    popNameCache.clear();
    const cache = [];
    const cacheByMapKey = new Map();

    const completed = await runBatches(inputs, (cb) => {
      if (token !== rebuildToken || version !== individualsVersion)
        return false;
      const li = cb.closest("li");
      const name = nameOfGroup(cb);
      const individuals = name ? lookupIndividuals(name, cb.dataset) : null;

      if (li) syncGroupIndividuals(li, individuals);
      const group = { cb, name, individuals: individuals ?? null };
      cache.push(group);
      const { populationId, spawnAreaId, groupIndex } = cb.dataset;
      if (populationId && spawnAreaId && groupIndex) {
        cacheByMapKey.set(
          mapGroupKey(populationId, spawnAreaId, groupIndex),
          group,
        );
      }
    });

    if (!completed || token !== rebuildToken || version !== individualsVersion)
      return false;
    groupCache = cache;
    groupCacheByMapKey = cacheByMapKey;
    return true;
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
      updateActionControls();
      status.textContent = "";
      return;
    }

    for (const name of names) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      selSpecies.appendChild(opt);
    }
    if (names.includes(prev)) selSpecies.value = prev;
    updateActionControls();
    updatePreview();
  }

  // —— 提示 ——
  // 底部提示只在需要用户注意时出现，正常流程不占用界面

  // 缺个体数据又启用了体重/性别条件的兽群无法判断，不会被勾选
  function unjudgedCount(groups) {
    if (!makeFilter().needsIndividuals) return 0;
    return groups.filter((group) => !group.individuals?.length).length;
  }

  function updatePreview() {
    const species = selSpecies.value;
    if (!species) {
      status.textContent = "";
      return;
    }
    const unjudged = unjudgedCount(
      groupCache.filter((group) => group.name === species),
    );
    status.textContent = unjudged
      ? `有 ${unjudged} 群缺少个体数据，无法判断是否命中，不会勾选`
      : "";
  }

  // —— 主操作 ——

  async function applyFilter() {
    if (operationInFlight) return;
    const sourceCache = groupCache;
    const species = selSpecies.value;
    const groups = sourceCache.filter((group) => group.name === species);
    if (!groups.length) {
      status.textContent = "无可用数据";
      return;
    }

    const filter = makeFilter();
    operationInFlight = true;
    updateActionControls();

    try {
      const completed = await runBatches(groups, (group, index) => {
        if (groupCache !== sourceCache || !group.cb.isConnected) return false;
        const want = group.individuals?.length
          ? group.individuals.some(filter.test)
          : !filter.needsIndividuals &&
            filter.testFallback(parseScore(group.cb));
        // 只追加：不取消已有勾选，也不覆盖列表里手动取消过的行
        if (want) {
          if (!group.cb.checked) setCheckedQuiet(group.cb, true);
          appendGroupIndividuals(group, filter.test);
        }
        if (index % 16 === 0)
          headerInfo.textContent = `筛选中 ${index}/${groups.length}`;
      });
      if (!completed) {
        status.textContent = "种群列表已更新，请重新筛选";
        return;
      }

      // 展开该物种分支，方便查看勾选结果
      const popRow = populationRows()
        .find((cb) => populationName(cb) === species)
        ?.closest("li");
      if (popRow) {
        $$(".nav-caret", popRow).forEach((caret) =>
          caret.classList.add("nav-caret-down"),
        );
        $$("ul.nested", popRow).forEach((list) => list.classList.add("active"));
      }

      renderSelectedList();
    } catch (error) {
      status.textContent = "筛选失败";
      console.error("[COTW 种群分数筛选] 应用筛选失败", error);
    } finally {
      operationInFlight = false;
      updateActionControls();
    }
  }

  function clearAll() {
    if (operationInFlight) return;
    suppressTreeSync += 1;
    try {
      $$("#pop_nav input.nav-visible").forEach((cb) => setChecked(cb, false));
    } finally {
      suppressTreeSync -= 1;
    }
    selectedRows = [];
    renderSelectedList();
  }

  // —— 单个存档文件选择与手动刷新 ——

  const SAVE_HANDLE_DB = "cotw-population-filter";
  const SAVE_HANDLE_STORE = "settings";
  const SAVE_HANDLE_KEY = "selected-population-file";
  const SAVE_FILE_PATTERN = /^animal_population_\d+$/;
  const SAVE_MAGIC = [0x53, 0x41, 0x56, 0x45]; // SAVE
  const ADF_ENVELOPE = [0x01, 0x01, 0x00, 0x00, 0x00, 0x20, 0x46, 0x44, 0x41];
  const ADF_MAGIC = [0x20, 0x46, 0x44, 0x41]; // " FDA"

  let saveSelectionVersion = 0;

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

  async function transactSaveHandle(mode, operation) {
    const db = await openSaveHandleDatabase();
    return new Promise((resolve, reject) => {
      let settled = false;
      let request;
      let transaction;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        db.close();
        callback(value);
      };

      try {
        transaction = db.transaction(SAVE_HANDLE_STORE, mode);
        request = operation(transaction.objectStore(SAVE_HANDLE_STORE));
        transaction.oncomplete = () => finish(resolve, request?.result);
        transaction.onerror = () =>
          finish(reject, transaction.error ?? request?.error);
        transaction.onabort = () =>
          finish(reject, transaction.error ?? request?.error);
      } catch (error) {
        finish(reject, error);
      }
    });
  }

  async function readSavedHandle() {
    return (
      (await transactSaveHandle("readonly", (store) =>
        store.get(SAVE_HANDLE_KEY),
      )) ?? null
    );
  }

  async function writeSavedHandle(handle) {
    await transactSaveHandle("readwrite", (store) =>
      store.put(handle, SAVE_HANDLE_KEY),
    );
  }

  function updateSelectedSaveControls() {
    const hasSelection = Boolean(selectedSaveHandle);
    btnSelectSave.hidden = hasSelection;
    selectedSaveActions.hidden = !hasSelection;
    updateActionControls();
  }

  function updateActionControls() {
    btnApply.disabled = operationInFlight || !selSpecies.value;
    btnClear.disabled = operationInFlight;
    btnSelectSave.disabled = operationInFlight;
    btnReselectSave.disabled = operationInFlight || !selectedSaveHandle;
    btnRefreshSave.disabled = operationInFlight || !selectedSaveHandle;
    selSpecies.disabled = operationInFlight;
    inpMin.disabled = operationInFlight;
    inpMax.disabled = operationInFlight;
    inpWeightMin.disabled = operationInFlight;
    inpWeightMax.disabled = operationInFlight;
    chkMale.disabled = operationInFlight;
    chkFemale.disabled = operationInFlight;
    selPreset.disabled = operationInFlight || presets.length === 0;
    btnSavePreset.disabled = operationInFlight;
    btnDeletePreset.disabled = operationInFlight || !selPreset.value;
    renderSelectedList();
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

  function validateSaveHandle(handle) {
    if (!SAVE_FILE_PATTERN.test(handle.name)) {
      throw new Error("请选择 animal_population_* 文件");
    }
    const mapping = pageSaveMapping();
    if (
      !mapping ||
      !Object.prototype.hasOwnProperty.call(mapping, handle.name)
    ) {
      throw new Error("存档文件不匹配");
    }
  }

  async function chooseSaveFile() {
    if (operationInFlight) return;
    if (
      !window.isSecureContext ||
      typeof window.showOpenFilePicker !== "function"
    ) {
      status.textContent = "浏览器不支持文件选择";
      return;
    }

    try {
      const [handle] = await window.showOpenFilePicker({ multiple: false });
      if (!handle) return;
      validateSaveHandle(handle);
      selectedSaveHandle = handle;
      saveSelectionVersion += 1;
      updateSelectedSaveControls();
      try {
        await writeSavedHandle(handle);
      } catch (error) {
        console.warn("[COTW 种群分数筛选] 无法保存文件选择", error);
      }
    } catch (error) {
      if (error?.name !== "AbortError") {
        status.textContent =
          error instanceof Error ? error.message : "选择失败";
        console.error("[COTW 种群分数筛选] 选择存档文件失败", error);
      }
    }
  }

  async function refreshSelectedSave() {
    const handle = selectedSaveHandle;
    if (!handle || operationInFlight) return;
    if (!isPageReadyForSave(handle.name)) {
      status.textContent = "地图数据尚未就绪";
      return;
    }

    operationInFlight = true;
    updateActionControls();
    try {
      const permission = await handle.requestPermission({ mode: "read" });
      if (permission !== "granted") {
        status.textContent = "未获得读取权限";
        return;
      }

      const file = await handle.getFile();
      const signature = saveFileSignature(file);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const latestFile = await handle.getFile();
      if (saveFileSignature(latestFile) !== signature) {
        status.textContent = "存档仍在写入，请稍后刷新";
        return;
      }

      parseAndApplySave(file.name, bytes);
    } catch (error) {
      status.textContent = "刷新失败";
      console.error("[COTW 种群分数筛选] 手动刷新存档失败", error);
    } finally {
      operationInFlight = false;
      updateActionControls();
    }
  }

  async function restoreSelectedSave() {
    if (!window.indexedDB) return;
    try {
      const version = saveSelectionVersion;
      const handle = await readSavedHandle();
      if (
        version !== saveSelectionVersion ||
        !handle ||
        !SAVE_FILE_PATTERN.test(handle.name)
      )
        return;
      selectedSaveHandle = handle;
      updateSelectedSaveControls();
    } catch (error) {
      console.warn("[COTW 种群分数筛选] 无法恢复存档选择", error);
    }
  }

  btnSelectSave.addEventListener("click", () => void chooseSaveFile());
  btnReselectSave.addEventListener("click", () => void chooseSaveFile());
  btnRefreshSave.addEventListener("click", () => void refreshSelectedSave());

  btnApply.addEventListener("click", () => void applyFilter());
  btnClear.addEventListener("click", clearAll);
  selSpecies.addEventListener("change", updatePreview);
  [inpMin, inpMax, inpWeightMin, inpWeightMax].forEach((input) =>
    input.addEventListener("input", () => {
      resetPresetSelection();
      updatePreview();
    }),
  );
  [chkMale, chkFemale].forEach((checkbox) =>
    checkbox.addEventListener("change", () => {
      resetPresetSelection();
      updatePreview();
    }),
  );

  selPreset.addEventListener("change", () => {
    const preset = presets.find((item) => item.name === selPreset.value);
    if (preset) applyPreset(preset);
    updateActionControls();
  });
  btnSavePreset.addEventListener("click", openPresetDialog);
  btnDeletePreset.addEventListener("click", deleteSelectedPreset);
  btnPresetCancel.addEventListener("click", closePresetDialog);
  btnPresetConfirm.addEventListener("click", confirmPresetSave);
  inpPresetName.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      confirmPresetSave();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closePresetDialog();
    }
  });

  // —— 树重建（拖入存档 / 切换地图）后重建索引 ——

  let rebuildTimer = null;
  function queueRebuild() {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => void onTreeChanged(), 150);
  }

  // 输入节点和标签未变时，跳过由自身分数列表 DOM 更新触发的重建。
  let processedTree = null;
  let processedVersion = -1;
  let processedInputs = [];
  let processedSignatures = [];

  function groupInputSignature(cb) {
    const { populationId, spawnAreaId, groupIndex } = cb.dataset;
    return JSON.stringify([
      populationId ?? "",
      spawnAreaId ?? "",
      groupIndex ?? "",
      rowText(cb),
    ]);
  }

  async function onTreeChanged() {
    try {
      const root = $("#pop_nav");
      const inputs = $$("#pop_nav input.nav-visible[data-group-index]");
      const signatures = inputs.map(groupInputSignature);
      const unchanged =
        root === processedTree &&
        individualsVersion === processedVersion &&
        inputs.length === processedInputs.length &&
        inputs.every(
          (input, index) =>
            input === processedInputs[index] &&
            signatures[index] === processedSignatures[index],
        );
      if (unchanged) return;

      processedTree = root;
      processedVersion = individualsVersion;
      processedInputs = inputs;
      processedSignatures = signatures;

      const hadRows = selectedRows.length > 0;
      if (!(await rebuildIndex(inputs))) return;
      refreshSpecies();
      updatePreview();
      renderSelectedArea();
      // 树重建（刷新存档 / 切换保护区）后个体数据已变，列表作废
      if (hadRows) clearSelectedRows();
    } catch (error) {
      processedTree = null;
      processedVersion = -1;
      processedInputs = [];
      processedSignatures = [];
      status.textContent = "种群索引更新失败";
      console.error("[COTW 种群分数筛选] 更新种群索引失败", error);
    }
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
    // 手动点击树上的兽群勾选框时，同步到列表
    dropzone.addEventListener("change", onTreeCheckboxChanged);
  }

  btnSelectAll.addEventListener("click", () => setAllRowsChecked(true));
  btnSelectNone.addEventListener("click", () => setAllRowsChecked(false));
  btnSortScore.addEventListener("click", () => setSortKey("score"));
  btnSortWeight.addEventListener("click", () => setSortKey("weight"));

  // 恢复上次保存的筛选条件预设
  presets = loadPresets();
  refreshPresetOptions();
  renderSelectedList();

  hookSaveParser();
  void onTreeChanged();
  void restoreSelectedSave();
})();
