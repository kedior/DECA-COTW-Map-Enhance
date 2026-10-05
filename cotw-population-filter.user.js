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

  // 控制台输出统一带前缀，方便筛出本脚本的日志
  const LOG_PREFIX = "[COTW 种群分数筛选]";
  const logWarn = (message, error) =>
    console.warn(`${LOG_PREFIX} ${message}`, error);
  const logError = (message, error) =>
    console.error(`${LOG_PREFIX} ${message}`, error);

  // 建元素样板：标签 + 类名 + 文本。渲染函数里反复出现，抽出来避免淹没逻辑
  function el(tag, className = "", text = "") {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

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
  // 两种索引键：个体表只能按「物种名 + 出生区 + 群号」建（解析存档时没有 populationId），
  // 地图命中项则自带 populationId。各自成对使用，不要混用。
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
    logWarn("无法对齐页面兽群编号，相关兽群将回退到最高分筛选。", error);
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

  // 页面全局里该保护区的几何数据；拿不到时返回 null，调用方就不建个体表
  function reserveGeometry(reserveId) {
    try {
      if (typeof areas === "undefined" || !areas[reserveId]) {
        throw new Error(`Reserve geometry is unavailable for ${reserveId}`);
      }
      const reserveArea = JSON.parse(areas[reserveId]);
      if (!reserveArea || typeof reserveArea !== "object") {
        throw new Error(`Invalid reserve geometry for ${reserveId}`);
      }
      return {
        reserveArea,
        spawnPointsByArea:
          typeof area_spawn_center_points !== "undefined"
            ? (area_spawn_center_points[reserveId] ?? {})
            : {},
      };
    } catch (error) {
      warnGroupMappingFailure(error);
      return null;
    }
  }

  // 一个兽群的个体列表：分数从高到低，分数无效的丢掉
  function readIndividuals(group) {
    return (group.Animals ?? [])
      .map((animal) => ({
        score: Number(animal?.Score),
        weight: Number(animal?.Weight),
        gender: Number(animal?.Gender),
      }))
      .filter((individual) => Number.isFinite(individual.score))
      .sort((a, b) => b.score - a.score);
  }

  // 把存档里的个体按「物种名 + 出生区 + 页面群号」登记进个体表
  function collectIndividuals(table, reserveData, reserveId, geometry) {
    const { reserveArea, spawnPointsByArea } = geometry;
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

        const individuals = readIndividuals(group);
        if (individuals.length) {
          table.set(
            keyOf(name, String(group.SpawnAreadId), pageIndex),
            individuals,
          );
        }
      }
    }
  }

  function captureScores(reserveData, saveName) {
    const reserveId = `r${saveName.match(/\d+/)?.[0] ?? ""}`;
    const table = new Map();
    const geometry = reserveGeometry(reserveId);
    if (geometry) collectIndividuals(table, reserveData, reserveId, geometry);

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

  const DRAG_THRESHOLD_PX = 5; // 位移小于此值算点击，用于折叠面板
  const DRAG_MIN_VISIBLE_PX = 40; // 纵向至少留出标题栏，别把面板拖出视口

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
      Math.abs(e.clientX - drag.x0) + Math.abs(e.clientY - drag.y0) <
        DRAG_THRESHOLD_PX
    )
      return;
    drag.moved = true;

    const left = Math.min(
      Math.max(0, e.clientX - drag.dx),
      window.innerWidth - drag.w,
    );
    const top = Math.min(
      Math.max(0, e.clientY - drag.dy),
      window.innerHeight - DRAG_MIN_VISIBLE_PX,
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

  // 读取边界输入框：留空表示该侧不限（null），否则取数值
  const readBound = (inp) => {
    const value = inp.value.trim();
    return value === "" ? null : parseFloat(value);
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
    const scoreMin = readBound(inpMin);
    const scoreMax = readBound(inpMax);
    const weightMin = readBound(inpWeightMin);
    const weightMax = readBound(inpWeightMax);
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
      logWarn("无法读取保存的筛选条件", error);
      return [];
    }
  }

  function persistPresets() {
    try {
      localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(presets));
    } catch (error) {
      logWarn("无法保存筛选条件", error);
    }
  }

  // 当前面板上的四项条件，不含物种
  function currentConditions() {
    return {
      scoreMin: finiteOrNull(readBound(inpMin)),
      scoreMax: finiteOrNull(readBound(inpMax)),
      weightMin: finiteOrNull(readBound(inpWeightMin)),
      weightMax: finiteOrNull(readBound(inpWeightMax)),
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
    const placeholder = el(
      "option",
      "",
      presets.length ? "选择已保存条件" : "暂无保存的条件",
    );
    placeholder.value = ""; // 占位项必须是空值，否则会被当成一个预设名
    selPreset.replaceChildren(
      placeholder,
      ...presets.map((preset) => el("option", "", preset.name)),
    );
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

  const AREA_TYPE_NAMES = {
    feeding: "觅食区",
    drinking: "饮水区",
    resting: "休息区",
    spawn: "出生区",
    feed: "觅食区",
    drink: "饮水区",
    rest: "休息区",
  };

  const areaTypeName = (type) => AREA_TYPE_NAMES[type] ?? type ?? "种群区域";

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

  // 区域特征 → 命中项；不是种群区域或字段不全的返回 null
  function zoneEntryFromFeature(feature) {
    const properties = feature?.properties;
    const info = properties?.zone_info;
    if (
      !["need_zone", "spawn_center_point"].includes(properties?.type) ||
      !info
    )
      return null;
    if (
      info.population_id == null ||
      info.spawn_area_id == null ||
      info.group_index == null
    )
      return null;
    return {
      populationId: String(info.population_id),
      populationName: info.population_name ?? "",
      spawnAreaId: String(info.spawn_area_id),
      groupIndex: String(info.group_index),
      maxScore: info.max_score,
      areas: new Set(),
    };
  }

  function groupsAtMapPoint(mapInstance, latlng) {
    const pip =
      typeof leafletPip !== "undefined" ? leafletPip : window.leafletPip;
    if (!pip?.pointInLayer)
      throw new Error("leafletPip.pointInLayer is unavailable");

    const entries = new Map();
    for (const hit of pip.pointInLayer(latlng, mapInstance)) {
      const entry = zoneEntryFromFeature(hit.feature);
      if (!entry) continue;

      const key = mapGroupKey(
        entry.populationId,
        entry.spawnAreaId,
        entry.groupIndex,
      );
      let merged = entries.get(key);
      if (!merged) {
        merged = entry;
        entries.set(key, merged);
      }
      // 同一个兽群可能压着多个区域（觅食 / 饮水 / 休息），描述要合并
      for (const description of areaDescriptions(hit.feature))
        merged.areas.add(description);
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

  // 一个命中兽群的信息块：名称 / 区域 / 个体分数；缺个体数据时回退到地图最高分
  function buildAreaGroupBlock(entry) {
    const block = el("div", "cotw-area-group");
    const group = findCachedGroup(entry);
    const name =
      group?.name || entry.populationName || `物种 ${entry.populationId}`;
    block.appendChild(
      el("div", "cotw-area-name", `${name} · 群 ${entry.groupIndex}`),
    );
    block.appendChild(
      el(
        "div",
        "cotw-area-meta",
        [`出生区 ${entry.spawnAreaId}`, ...entry.areas].join(" · "),
      ),
    );

    if (!group?.individuals?.length) {
      let text = "个体数据不可用";
      if (Number.isFinite(entry.maxScore))
        text += ` · 地图最高分 ${entry.maxScore.toFixed(1)}`;
      block.appendChild(el("div", "cotw-area-meta", text));
      return block;
    }

    block.appendChild(
      el("div", "cotw-area-meta", `个体（${group.individuals.length} 只）`),
    );
    const chips = el("div", "cotw-area-scores");
    for (const individual of group.individuals) {
      const { text, className } = individualView(individual);
      chips.appendChild(
        el("span", `cotw-area-score ${className}`.trim(), text),
      );
    }
    block.appendChild(chips);
    return block;
  }

  function renderSelectedArea() {
    areaResults.replaceChildren();
    areaInfo.hidden = selectedAreaEntries.length === 0 && !areaEmptyText;
    if (selectedAreaEntries.length === 0) {
      if (areaEmptyText)
        areaResults.appendChild(el("div", "cotw-area-empty", areaEmptyText));
      return;
    }
    areaResults.replaceChildren(
      ...selectedAreaEntries.map(buildAreaGroupBlock),
    );
  }

  // —— 个体层渲染 ——

  // 个体显示：性别符号 + 分数/体重kg，公母各用一个颜色类
  // 返回的 className 由调用方挂到元素上，别叫 genderClass——会和同名函数撞名
  function individualView(individual) {
    const symbol = GENDER_SYMBOL[individual.gender] ?? "?";
    const weight = Number.isFinite(individual.weight)
      ? `/${individual.weight.toFixed(1)}kg`
      : "";
    return {
      text: `${symbol} ${individual.score.toFixed(1)}${weight}`,
      className: genderClass(individual.gender),
    };
  }

  // 把页面的空白占位换成可点的折叠箭头，并接管它的展开 / 收起
  function bindScoresCaret(caret, li, list) {
    caret.classList.remove("nav-spacer");
    caret.classList.add("nav-caret", "cotw-caret");
    caret.classList.toggle("nav-caret-down", list.classList.contains("active"));
    if (caret.dataset.cotwScoresToggleBound) return;
    caret.dataset.cotwScoresToggleBound = "true";
    caret.addEventListener("click", () => {
      const currentList = $(":scope > ul.cotw-animals", li);
      if (!currentList) return;
      const expanded = currentList.classList.toggle("active");
      caret.classList.toggle("nav-caret-down", expanded);
    });
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
      list = el("ul", "nested cotw-animals");
      li.append(list);
    }
    list.replaceChildren(
      ...individuals.map((individual) => {
        const { text, className } = individualView(individual);
        return el("li", className, text);
      }),
    );

    if (caret) bindScoresCaret(caret, li, list);
  }

  // —— 已选个体列表 ——
  // 列表是「筛选并加入列表」的暂存区：只追加命中的个体，只有「清空列表」才移除行。
  // 行与兽群勾选框双向同步：取消到一只不剩就取消兽群；手动勾选兽群只回灌已有行，不新增行。

  let selectedRows = []; // [{cb, index, name, gender, score, weight, checked}]
  let sortKey = "score";
  let sortDesc = true;
  let suppressTreeSync = 0; // 列表写回树时，抑制「树 → 列表」回灌

  // 列表 → 树方向统一走这里，避免 setChecked 触发的 change 事件又回灌列表
  function withTreeSyncSuppressed(action) {
    suppressTreeSync += 1;
    try {
      return action();
    } finally {
      suppressTreeSync -= 1;
    }
  }

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

  // 只在列表 → 树方向使用
  const setCheckedQuiet = (cb, want) =>
    withTreeSyncSuppressed(() => setChecked(cb, want));

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
    const label = el("label", "cotw-sel-row");
    label.dataset.group = groupKeyOf(row.cb);

    const box = el("input");
    box.type = "checkbox";
    box.checked = row.checked;
    box.addEventListener("change", () => toggleRow(row, box.checked));

    const name = el(
      "span",
      `cotw-sel-name ${genderClass(row.gender)}`.trim(),
      `${row.name} ${GENDER_SYMBOL[row.gender] ?? "?"}`,
    );
    name.title = name.textContent;

    label.append(
      box,
      name,
      el("span", "cotw-sel-score", row.score.toFixed(1)),
      el(
        "span",
        "cotw-sel-weight",
        Number.isFinite(row.weight) ? `${row.weight.toFixed(1)}kg` : "—",
      ),
    );
    return label;
  }

  const checkedRowCount = () =>
    selectedRows.filter((row) => row.checked).length;

  // 顶部信息：已选计数 + 存档名；筛选进行中用 progress 临时顶替
  function updateHeaderInfo(progress = "") {
    const parts = [];
    if (progress) parts.push(progress);
    else {
      if (selectedRows.length)
        parts.push(`已选 ${checkedRowCount()} / ${selectedRows.length} 只`);
      if (selectedSaveHandle) parts.push(selectedSaveHandle.name);
    }
    headerInfo.textContent = parts.join(" ｜ ");
  }

  function renderSortButtons() {
    btnSortScore.textContent = `分数${sortKey === "score" && !sortDesc ? "↑" : "↓"}`;
    btnSortWeight.textContent = `体重${sortKey === "weight" && !sortDesc ? "↑" : "↓"}`;
    btnSortScore.classList.toggle("cotw-sort-active", sortKey === "score");
    btnSortWeight.classList.toggle("cotw-sort-active", sortKey === "weight");
  }

  function updateListButtons() {
    btnSelectAll.disabled =
      operationInFlight || !selectedRows.some((row) => !row.checked);
    btnSelectNone.disabled =
      operationInFlight || !selectedRows.some((row) => row.checked);
    btnSortScore.disabled = operationInFlight;
    btnSortWeight.disabled = operationInFlight;
  }

  function renderSelectedList() {
    updateHeaderInfo();
    selectedEmpty.hidden = selectedRows.length > 0;
    selectedList.replaceChildren(
      ...[...selectedRows].sort(compareRows).map(renderSelectedRow),
    );
    renderSortButtons();
    updateListButtons();
  }

  // 列表里取消个体：群内还有别的被勾个体就保持兽群勾选，一只不剩才取消
  function toggleRow(row, checked) {
    row.checked = checked;
    setCheckedQuiet(
      row.cb,
      selectedRows.some((item) => item.cb === row.cb && item.checked),
    );
    // 行 DOM 已是用户点出的状态，只需刷新表头与按钮：整表重绘会丢掉焦点
    updateHeaderInfo();
    updateListButtons();
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
    withTreeSyncSuppressed(() =>
      groups.forEach((cb) => setChecked(cb, checked)),
    );
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

    selSpecies.replaceChildren();
    if (names.length === 0) {
      const empty = el("option", "", "暂无数据");
      empty.value = ""; // 显式空值：按钮可用性看 selSpecies.value 的真假
      selSpecies.replaceChildren(empty);
      updateActionControls();
      status.textContent = "";
      return;
    }

    // option 不写 value 时，value 就等于文本
    selSpecies.replaceChildren(...names.map((name) => el("option", "", name)));
    if (names.includes(prev)) selSpecies.value = prev;
    updateActionControls();
    updatePreview();
  }

  // —— 提示 ——
  // 底部提示只在需要用户注意时出现，正常流程不占用界面

  // 出错时的统一出口：底部给用户一句人话，控制台留完整信息。
  // 带 userMessage 的错误（格式不符、组件未就绪…）消息本身就是给用户看的，优先展示
  function reportProblem(message, error, logMessage = message) {
    status.textContent = error?.userMessage ?? message;
    logError(logMessage, error);
  }

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

  const PROGRESS_EVERY = 16; // 每处理多少群刷新一次顶部进度

  // 命中判定：有个体数据就逐只判断；否则只有分数条件能靠行文本的最高分回退
  function groupMatchesFilter(group, filter) {
    if (group.individuals?.length) return group.individuals.some(filter.test);
    return (
      !filter.needsIndividuals && filter.testFallback(parseScore(group.cb))
    );
  }

  // 展开该物种分支，方便查看勾选结果
  function expandSpeciesBranch(species) {
    const popRow = populationRows()
      .find((cb) => populationName(cb) === species)
      ?.closest("li");
    if (!popRow) return;
    $$(".nav-caret", popRow).forEach((caret) =>
      caret.classList.add("nav-caret-down"),
    );
    $$("ul.nested", popRow).forEach((list) => list.classList.add("active"));
  }

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
        // 只追加：不取消已有勾选，也不覆盖列表里手动取消过的行
        if (groupMatchesFilter(group, filter)) {
          if (!group.cb.checked) setCheckedQuiet(group.cb, true);
          appendGroupIndividuals(group, filter.test);
        }
        if (index % PROGRESS_EVERY === 0)
          updateHeaderInfo(`筛选中 ${index}/${groups.length}`);
      });
      if (!completed) {
        status.textContent = "种群列表已更新，请重新筛选";
        return;
      }

      expandSpeciesBranch(species);
      renderSelectedList();
    } catch (error) {
      reportProblem("筛选失败", error, "应用筛选失败");
    } finally {
      operationInFlight = false;
      updateActionControls();
    }
  }

  function clearAll() {
    if (operationInFlight) return;
    withTreeSyncSuppressed(() =>
      $$("#pop_nav input.nav-visible").forEach((cb) => setChecked(cb, false)),
    );
    selectedRows = [];
    renderSelectedList();
  }

  // —— 单个存档文件选择与手动刷新 ——

  const SAVE_HANDLE_DB = "cotw-population-filter";
  const SAVE_HANDLE_STORE = "settings";
  const SAVE_HANDLE_KEY = "selected-population-file";
  const SAVE_FILE_PATTERN = /^animal_population_\d+$/;
  const SAVE_MAGIC = [0x53, 0x41, 0x56, 0x45]; // SAVE
  // SAVE 文件 = 32 字节头 + 2 字节，其后是 raw deflate 数据
  const SAVE_ZLIB_OFFSET = 34;
  // ADF 载荷前 5 字节是信封，紧跟 " FDA" 魔数；检测看 9 字节，剥离只去信封
  const ADF_ENVELOPE = [0x01, 0x01, 0x00, 0x00, 0x00];
  const ADF_MAGIC = [0x20, 0x46, 0x44, 0x41]; // " FDA"
  const ADF_SIGNATURE = [...ADF_ENVELOPE, ...ADF_MAGIC];

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

  // 条件类控件统一跟着「是否忙碌」禁用
  const conditionControls = [
    selSpecies,
    inpMin,
    inpMax,
    inpWeightMin,
    inpWeightMax,
    chkMale,
    chkFemale,
  ];

  function updateActionControls() {
    const busy = operationInFlight;
    conditionControls.forEach((control) => {
      control.disabled = busy;
    });
    selPreset.disabled = busy || presets.length === 0;
    btnApply.disabled = busy || !selSpecies.value;
    btnClear.disabled = busy;
    btnSelectSave.disabled = busy;
    btnReselectSave.disabled = busy || !selectedSaveHandle;
    btnRefreshSave.disabled = busy || !selectedSaveHandle;
    btnSavePreset.disabled = busy;
    btnDeletePreset.disabled = busy || !selPreset.value;
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

  // 页面只认自己注册过的存档名，返回它对应的保护区编号
  function pageReserveId(saveName) {
    const mapping = pageSaveMapping();
    return mapping && Object.prototype.hasOwnProperty.call(mapping, saveName)
      ? mapping[saveName]
      : null;
  }

  function isPageReadyForSave(saveName) {
    const reserveId = pageReserveId(saveName);
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

  // 可预期的失败（格式不符、组件未就绪…）：消息本身就是给用户看的
  function saveFailure(message) {
    const error = new Error(message);
    error.userMessage = message;
    return error;
  }

  function parseAndApplySave(saveName, bytes) {
    if (!SAVE_FILE_PATTERN.test(saveName)) {
      throw saveFailure("请选择 animal_population_数字 格式的单个存档文件");
    }
    if (!pageReserveId(saveName)) {
      throw saveFailure("DECA 地图不识别这个存档文件");
    }

    let raw = bytes;
    if (startsWithBytes(raw, SAVE_MAGIC)) {
      const inflater = typeof pako !== "undefined" ? pako : window.pako;
      if (!inflater?.inflate) throw saveFailure("DECA 解压组件尚未就绪");
      raw = inflater.inflate(raw.slice(SAVE_ZLIB_OFFSET), { windowBits: -15 });
    }
    if (startsWithBytes(raw, ADF_SIGNATURE))
      raw = raw.slice(ADF_ENVELOPE.length);
    if (!startsWithBytes(raw, ADF_MAGIC))
      throw saveFailure("存档格式不符合 DECA 解析器预期");

    const parseAdf =
      typeof adfProcess !== "undefined" ? adfProcess : window.adfProcess;
    if (typeof parseAdf !== "function")
      throw saveFailure("DECA ADF 解析器尚未就绪");
    const reserveData = parseAdf(raw);
    if (!reserveData) throw saveFailure("ADF 存档解析失败");

    const processSave = window.processSaveReserve;
    if (typeof processSave !== "function")
      throw saveFailure("DECA 存档处理函数尚未就绪");
    processSave.call(window, saveName, reserveData);
  }

  function saveFileSignature(file) {
    return `${file.lastModified}:${file.size}`;
  }

  function validateSaveHandle(handle) {
    if (!SAVE_FILE_PATTERN.test(handle.name)) {
      throw saveFailure("请选择 animal_population_* 文件");
    }
    if (!pageReserveId(handle.name)) {
      throw saveFailure("存档文件不匹配");
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
        logWarn("无法保存文件选择", error);
      }
    } catch (error) {
      if (error?.name === "AbortError") return;
      reportProblem(
        error instanceof Error ? error.message : "选择失败",
        error,
        "选择存档文件失败",
      );
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
      reportProblem("刷新失败", error, "手动刷新存档失败");
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
      logWarn("无法恢复存档选择", error);
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

  const TREE_REBUILD_DELAY_MS = 150; // 页面分批重建树，等它停手再重建索引

  let rebuildTimer = null;
  function queueRebuild() {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(
      () => void onTreeChanged(),
      TREE_REBUILD_DELAY_MS,
    );
  }

  // 上次处理过的树快照：输入节点与标签都没变时，
  // 跳过由自身分数列表 DOM 更新触发的重建。
  let processedTree = null; // { root, version, inputs, signatures }

  function groupInputSignature(cb) {
    const { populationId, spawnAreaId, groupIndex } = cb.dataset;
    return JSON.stringify([
      populationId ?? "",
      spawnAreaId ?? "",
      groupIndex ?? "",
      rowText(cb),
    ]);
  }

  function isSameTreeAsProcessed(root, inputs, signatures) {
    const snapshot = processedTree;
    return (
      snapshot !== null &&
      snapshot.root === root &&
      snapshot.version === individualsVersion &&
      snapshot.inputs.length === inputs.length &&
      inputs.every(
        (input, index) =>
          input === snapshot.inputs[index] &&
          signatures[index] === snapshot.signatures[index],
      )
    );
  }

  async function onTreeChanged() {
    try {
      const root = $("#pop_nav");
      const inputs = $$("#pop_nav input.nav-visible[data-group-index]");
      const signatures = inputs.map(groupInputSignature);
      if (isSameTreeAsProcessed(root, inputs, signatures)) return;
      processedTree = { root, version: individualsVersion, inputs, signatures };

      const hadRows = selectedRows.length > 0;
      if (!(await rebuildIndex(inputs))) return;
      refreshSpecies();
      updatePreview();
      renderSelectedArea();
      // 树重建（刷新存档 / 切换保护区）后个体数据已变，列表作废
      if (hadRows) clearSelectedRows();
    } catch (error) {
      processedTree = null;
      reportProblem("种群索引更新失败", error, "更新种群索引失败");
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
        logError("读取地图区域失败", error);
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
