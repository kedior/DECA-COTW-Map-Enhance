// ==UserScript==
// @name         DECA COTW 地图 · 种群分数筛选
// @namespace    cotw-kedior
// @version      2.0.2
// @description  按物种、分数、体重、性别筛选动物兽群，支持个体分数、已选个体列表、筛选条件预设与手动刷新存档
// @match        https://mathartbang.com/deca/hp/map.html*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  // —— 基础工具 ——

  // 轻量响应式 Store：只观察顶层状态，复杂缓存和 DOM 引用留在运行时模型中。
  // 常规状态更新驱动视图；正在编辑的文本可静默同步，避免重绘打断输入法。
  function createStore(initialState, onChange) {
    const changedKeys = new Set();
    let batchDepth = 0;
    let silentDepth = 0;

    const flush = () => {
      if (batchDepth || silentDepth || changedKeys.size === 0) return;
      const keys = [...changedKeys];
      changedKeys.clear();
      onChange(state, keys);
    };

    const state = new Proxy(
      { ...initialState },
      {
        set(target, key, value) {
          if (Object.is(target[key], value)) return true;
          target[key] = value;
          changedKeys.add(key);
          flush();
          return true;
        },
      },
    );

    return {
      state,
      batch(callback) {
        batchDepth += 1;
        try {
          return callback(state);
        } finally {
          batchDepth -= 1;
          flush();
        }
      },
      // 文本输入由浏览器直接更新当前控件；静默同步 Store 可避免打断 IME 和光标。
      silent(callback) {
        silentDepth += 1;
        try {
          return callback(state);
        } finally {
          silentDepth -= 1;
          if (silentDepth === 0 && batchDepth === 0) changedKeys.clear();
        }
      },
    };
  }

  // 控制台输出统一带前缀，方便筛出本脚本的日志
  const LOG_PREFIX = "[COTW 种群分数筛选]";
  const logWarn = (message, error) =>
    console.warn(`${LOG_PREFIX} ${message}`, error);
  const logError = (message, error) =>
    console.error(`${LOG_PREFIX} ${message}`, error);

  // 仅用于增强 DECA 原有种群树；本脚本面板由 AppView(state) 模板统一渲染。
  function el(tag, className = "", text = "") {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  // 页面索引、DECA DOM 引用和文件句柄属于运行时模型，不放入 UI Store。
  let selectedSaveHandle = null;
  // 分片执行：按时间预算让出主线程，避免长任务卡住页面
  async function runBatches(items, worker, budgetMs = 8) {
    let t0 = performance.now();
    for (let i = 0; i < items.length; ++i) {
      if (worker(items[i], i) === false) return false;
      if (performance.now() - t0 > budgetMs) {
        await new Promise((resolve) => setTimeout(resolve, 0));
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
    Array.from(
      document.querySelectorAll(
        `#pop_nav input.nav-visible[data-population-id]:not([data-spawn-area-id])`,
      ),
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

    const row = document.querySelector(
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

  const PANEL_CSS = `
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

  let panel;
  let store;
  let state;

  const escapeHtml = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (character) => {
      const entities = {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      };
      return entities[character];
    });

  // —— 拖拽 / 折叠 ——

  const DRAG_THRESHOLD_PX = 5; // 位移小于此值算点击，用于折叠面板
  const DRAG_MIN_VISIBLE_PX = 40; // 纵向至少留出标题栏，别把面板拖出视口

  let drag = null;

  // —— 筛选条件 ——

  // 留空边界解析为 null，否则按数值处理。
  const readBound = (value) => {
    const normalized = String(value ?? "")
      .trim()
      .replace(",", ".");
    if (!normalized) return null;
    if (
      !/^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:e[+-]?\d+)?$/i.test(normalized)
    )
      return NaN;
    const number = Number(normalized);
    return Number.isFinite(number) ? number : NaN;
  };

  function invalidFilterBoundLabel() {
    const labels = [
      ["scoreMin", "最小分数"],
      ["scoreMax", "最大分数"],
      ["weightMin", "最小体重"],
      ["weightMax", "最大体重"],
    ];
    for (const [key, label] of labels) {
      const rawValue = String(state.filters[key] ?? "").trim();
      if (rawValue && !Number.isFinite(readBound(rawValue))) return label;
    }
    return null;
  }

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
    const {
      scoreMin: rawScoreMin,
      scoreMax: rawScoreMax,
      weightMin: rawWeightMin,
      weightMax: rawWeightMax,
      male,
      female,
    } = state.filters;
    const scoreMin = readBound(rawScoreMin);
    const scoreMax = readBound(rawScoreMax);
    const weightMin = readBound(rawWeightMin);
    const weightMax = readBound(rawWeightMax);
    const genders = new Set();
    if (male) genders.add(MALE);
    if (female) genders.add(FEMALE);
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
      localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(state.presets));
    } catch (error) {
      logWarn("无法保存筛选条件", error);
    }
  }

  // 当前面板上的四项条件，不含物种
  function currentConditions() {
    return {
      scoreMin: finiteOrNull(readBound(state.filters.scoreMin)),
      scoreMax: finiteOrNull(readBound(state.filters.scoreMax)),
      weightMin: finiteOrNull(readBound(state.filters.weightMin)),
      weightMax: finiteOrNull(readBound(state.filters.weightMax)),
      male: state.filters.male,
      female: state.filters.female,
    };
  }

  function presetToFilters(preset) {
    return {
      scoreMin: preset.scoreMin === null ? "" : String(preset.scoreMin),
      scoreMax: preset.scoreMax === null ? "" : String(preset.scoreMax),
      weightMin: preset.weightMin === null ? "" : String(preset.weightMin),
      weightMax: preset.weightMax === null ? "" : String(preset.weightMax),
      male: preset.male,
      female: preset.female,
    };
  }

  // 只替换筛选状态，不触碰勾选列表；视图由 Store 自动更新。
  function applyPreset(preset) {
    state.filters = presetToFilters(preset);
    updatePreview();
  }

  function refreshPresetOptions(selectName = null) {
    const previous = selectName ?? state.presetSelection;
    state.presetSelection = state.presets.some(
      (preset) => preset.name === previous,
    )
      ? previous
      : "";
  }

  function openPresetDialog() {
    if (state.busy) return;
    store.batch((nextState) => {
      nextState.presetName = state.presetSelection;
      nextState.presetError = "";
      nextState.presetDialogOpen = true;
    });
    const nameInput = panel.querySelector("#cotw-preset-name");
    nameInput?.focus();
    nameInput?.select();
  }

  function closePresetDialog() {
    store.batch((nextState) => {
      nextState.presetDialogOpen = false;
      nextState.presetError = "";
    });
  }

  function confirmPresetSave() {
    const name = state.presetName.trim();
    const invalidBound = invalidFilterBoundLabel();
    if (invalidBound) {
      state.presetError = `${invalidBound}必须是有效数字`;
      return;
    }
    if (!name) {
      state.presetError = "请输入条件名称";
      return;
    }
    if (state.presets.some((preset) => preset.name === name)) {
      state.presetError = "已存在同名条件，请换一个名字";
      return;
    }

    store.batch((nextState) => {
      nextState.presets = [...state.presets, { name, ...currentConditions() }];
      nextState.presetSelection = name;
      nextState.presetDialogOpen = false;
      nextState.presetError = "";
    });
    persistPresets();
  }

  function deleteSelectedPreset() {
    const name = state.presetSelection;
    if (!name) return;
    state.presets = state.presets.filter((preset) => preset.name !== name);
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

  // 区域命中项是纯视图组件，只依赖传入的可渲染数据。
  function renderAreaGroupBlock(entry) {
    const name =
      entry.name || entry.populationName || `物种 ${entry.populationId}`;
    const metadata = [`出生区 ${entry.spawnAreaId}`, ...entry.areas]
      .map(escapeHtml)
      .join(" · ");

    if (!entry.individuals.length) {
      const fallback = Number.isFinite(entry.maxScore)
        ? ` · 地图最高分 ${entry.maxScore.toFixed(1)}`
        : "";
      return `
        <div class="cotw-area-group">
          <div class="cotw-area-name">${escapeHtml(name)} · 群 ${escapeHtml(entry.groupIndex)}</div>
          <div class="cotw-area-meta">${metadata}</div>
          <div class="cotw-area-meta">个体数据不可用${fallback}</div>
        </div>
      `;
    }

    const individuals = entry.individuals
      .map((individual) => {
        const { text, className } = individualView(individual);
        return `<span class="cotw-area-score ${className}">${escapeHtml(text)}</span>`;
      })
      .join("");

    return `
      <div class="cotw-area-group">
        <div class="cotw-area-name">${escapeHtml(name)} · 群 ${escapeHtml(entry.groupIndex)}</div>
        <div class="cotw-area-meta">${metadata}</div>
        <div class="cotw-area-meta">个体（${entry.individuals.length} 只）</div>
        <div class="cotw-area-scores">${individuals}</div>
      </div>
    `;
  }

  function renderSelectedArea() {
    const entries = selectedAreaEntries.map((entry) => {
      const group = findCachedGroup(entry);
      return {
        populationId: entry.populationId,
        populationName: entry.populationName,
        name: group?.name ?? "",
        spawnAreaId: entry.spawnAreaId,
        groupIndex: entry.groupIndex,
        maxScore: entry.maxScore,
        areas: [...entry.areas],
        individuals:
          group?.individuals?.map(({ score, weight, gender }) => ({
            score,
            weight,
            gender,
          })) ?? [],
      };
    });

    store.batch((nextState) => {
      nextState.areaEntries = entries;
      nextState.areaEmptyText = areaEmptyText;
    });
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
      const currentList = li.querySelector(":scope > ul.cotw-animals");
      if (!currentList) return;
      const expanded = currentList.classList.toggle("active");
      caret.classList.toggle("nav-caret-down", expanded);
    });
  }

  function syncGroupIndividuals(li, individuals) {
    let list = li.querySelector(":scope > ul.cotw-animals");
    const caret = li.querySelector(
      ":scope > .nav-spacer, :scope > .cotw-caret",
    );

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
    for (const key of [
      state.sortKey,
      state.sortKey === "score" ? "weight" : "score",
    ]) {
      const av = sortValue(a, key);
      const bv = sortValue(b, key);
      const am = !Number.isFinite(av);
      const bm = !Number.isFinite(bv);
      if (am !== bm) return am ? 1 : -1;
      if (am && bm) continue;
      if (av !== bv) return state.sortDescending ? bv - av : av - bv;
    }
    return a.name.localeCompare(b.name);
  }

  // 顶部进度也属于视图状态，赋值后由 AppView 统一重绘。
  function updateHeaderInfo(progress = "") {
    state.progress = progress;
  }

  // 将带树节点引用的运行时列表投影到视图状态，由 SelectedIndividualsView 渲染。
  function renderSelectedList() {
    store.batch((nextState) => {
      nextState.selectedRows = selectedRows.map((row) => ({
        groupKey: groupKeyOf(row.cb),
        name: row.name,
        gender: row.gender,
        score: row.score,
        weight: row.weight,
        checked: row.checked,
      }));
      nextState.progress = "";
    });
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
    withTreeSyncSuppressed(() =>
      groups.forEach((cb) => setChecked(cb, checked)),
    );
    renderSelectedList();
  }

  function setSortKey(key) {
    store.batch((nextState) => {
      if (nextState.sortKey === key) {
        nextState.sortDescending = !nextState.sortDescending;
      } else {
        nextState.sortKey = key;
        nextState.sortDescending = true;
      }
    });
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
      ...new Set(groupCache.map((group) => group.name).filter(Boolean)),
    ].sort((a, b) => a.localeCompare(b));
    const selectedSpecies = names.includes(state.selectedSpecies)
      ? state.selectedSpecies
      : (names[0] ?? "");

    store.batch((nextState) => {
      nextState.speciesOptions = names;
      nextState.selectedSpecies = selectedSpecies;
    });
    updatePreview();
  }

  // —— 提示 ——
  // 底部提示只在需要用户注意时出现，正常流程不占用界面

  // 出错时的统一出口：底部给用户一句人话，控制台留完整信息。
  // 带 userMessage 的错误（格式不符、组件未就绪…）消息本身就是给用户看的，优先展示
  function reportProblem(message, error, logMessage = message) {
    state.statusText = error?.userMessage ?? message;
    logError(logMessage, error);
  }

  // 缺个体数据又启用了体重/性别条件的兽群无法判断，不会被勾选
  function unjudgedCount(groups) {
    if (!makeFilter().needsIndividuals) return 0;
    return groups.filter((group) => !group.individuals?.length).length;
  }

  function updatePreview() {
    const species = state.selectedSpecies;
    if (!species) {
      state.statusText = "";
      return;
    }
    const unjudged = unjudgedCount(
      groupCache.filter((group) => group.name === species),
    );
    state.statusText = unjudged
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
    popRow
      .querySelectorAll(".nav-caret")
      .forEach((caret) => caret.classList.add("nav-caret-down"));
    popRow
      .querySelectorAll("ul.nested")
      .forEach((list) => list.classList.add("active"));
  }

  async function applyFilter() {
    if (state.busy) return;
    const invalidBound = invalidFilterBoundLabel();
    if (invalidBound) {
      state.statusText = `${invalidBound}必须是有效数字`;
      return;
    }
    updatePreview();
    const sourceCache = groupCache;
    const species = state.selectedSpecies;
    const groups = sourceCache.filter((group) => group.name === species);
    if (!groups.length) {
      state.statusText = "无可用数据";
      return;
    }

    const filter = makeFilter();
    state.busy = true;

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
        state.statusText = "种群列表已更新，请重新筛选";
        return;
      }

      expandSpeciesBranch(species);
    } catch (error) {
      reportProblem("筛选失败", error, "应用筛选失败");
    } finally {
      store.batch((nextState) => {
        nextState.busy = false;
        nextState.selectedRows = selectedRows.map((row) => ({
          groupKey: groupKeyOf(row.cb),
          name: row.name,
          gender: row.gender,
          score: row.score,
          weight: row.weight,
          checked: row.checked,
        }));
        nextState.progress = "";
      });
    }
  }

  function clearAll() {
    if (state.busy) return;
    withTreeSyncSuppressed(() =>
      document
        .querySelectorAll("#pop_nav input.nav-visible")
        .forEach((cb) => setChecked(cb, false)),
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
    if (state.busy) return;
    if (
      !window.isSecureContext ||
      typeof window.showOpenFilePicker !== "function"
    ) {
      state.statusText = "浏览器不支持文件选择";
      return;
    }

    try {
      const [handle] = await window.showOpenFilePicker({ multiple: false });
      if (!handle) return;
      validateSaveHandle(handle);
      selectedSaveHandle = handle;
      state.saveFileName = handle.name;
      saveSelectionVersion += 1;
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
    if (!handle || state.busy) return;
    if (!isPageReadyForSave(handle.name)) {
      state.statusText = "地图数据尚未就绪";
      return;
    }

    state.busy = true;
    try {
      const permission = await handle.requestPermission({ mode: "read" });
      if (permission !== "granted") {
        state.statusText = "未获得读取权限";
        return;
      }

      const file = await handle.getFile();
      const signature = saveFileSignature(file);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const latestFile = await handle.getFile();
      if (saveFileSignature(latestFile) !== signature) {
        state.statusText = "存档仍在写入，请稍后刷新";
        return;
      }

      parseAndApplySave(file.name, bytes);
    } catch (error) {
      reportProblem("刷新失败", error, "手动刷新存档失败");
    } finally {
      state.busy = false;
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
      state.saveFileName = handle.name;
    } catch (error) {
      logWarn("无法恢复存档选择", error);
    }
  }

  const actions = Object.freeze({
    "choose-save": () => void chooseSaveFile(),
    "refresh-save": () => void refreshSelectedSave(),
    "apply-filter": () => void applyFilter(),
    "clear-all": clearAll,
    "save-preset": openPresetDialog,
    "delete-preset": deleteSelectedPreset,
    "cancel-preset": closePresetDialog,
    "confirm-preset": confirmPresetSave,
    "select-all": () => setAllRowsChecked(true),
    "select-none": () => setAllRowsChecked(false),
    "sort-score": () => setSortKey("score"),
    "sort-weight": () => setSortKey("weight"),
  });

  function handlePanelClick(event) {
    const actionElement = event.target.closest?.("[data-action]");
    if (!actionElement || !panel.contains(actionElement)) return;
    actions[actionElement.dataset.action]?.(actionElement, event);
  }

  function handlePanelInput(event) {
    const input = event.target;
    if (input.matches?.("[data-filter]")) {
      const key = input.dataset.filter;
      const hadPresetSelection = Boolean(state.presetSelection);
      store.silent((nextState) => {
        nextState.filters = { ...state.filters, [key]: input.value };
        nextState.presetSelection = "";
      });
      if (hadPresetSelection) {
        const presetSelect = panel.querySelector("#cotw-preset");
        if (presetSelect) presetSelect.value = "";
      }
    } else if (input.matches?.("[data-preset-name]")) {
      store.silent((nextState) => {
        nextState.presetName = input.value;
      });
    }
  }

  function handlePanelChange(event) {
    const control = event.target;
    if (control.matches?.("[data-species-select]")) {
      store.batch((nextState) => {
        nextState.selectedSpecies = control.value;
        updatePreview();
      });
      return;
    }

    if (control.matches?.("[data-preset-select]")) {
      const preset = state.presets.find((item) => item.name === control.value);
      store.batch((nextState) => {
        nextState.presetSelection = control.value;
        if (preset) applyPreset(preset);
        else updatePreview();
      });
      return;
    }

    if (control.matches?.("[data-gender]")) {
      const gender = control.dataset.gender;
      store.batch((nextState) => {
        nextState.filters = { ...state.filters, [gender]: control.checked };
        nextState.presetSelection = "";
        updatePreview();
      });
      return;
    }

    if (control.matches?.("[data-row-index]")) {
      const row = selectedRows[Number(control.dataset.rowIndex)];
      if (row) toggleRow(row, control.checked);
    }
  }

  function handlePanelKeydown(event) {
    if (!event.target.matches?.("[data-preset-name]")) return;
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      event.preventDefault();
      confirmPresetSave();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closePresetDialog();
    }
  }

  function handlePanelPointerDown(event) {
    if (!event.target.closest?.("[data-drag-handle]")) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const rect = panel.getBoundingClientRect();
    drag = {
      dx: event.clientX - rect.left,
      dy: event.clientY - rect.top,
      x0: event.clientX,
      y0: event.clientY,
      w: rect.width,
      moved: false,
    };
    panel.setPointerCapture(event.pointerId);
  }

  function handlePanelPointerMove(event) {
    if (!drag) return;
    if (
      !drag.moved &&
      Math.abs(event.clientX - drag.x0) + Math.abs(event.clientY - drag.y0) <
        DRAG_THRESHOLD_PX
    )
      return;
    drag.moved = true;

    const left = Math.min(
      Math.max(0, event.clientX - drag.dx),
      window.innerWidth - drag.w,
    );
    const top = Math.min(
      Math.max(0, event.clientY - drag.dy),
      window.innerHeight - DRAG_MIN_VISIBLE_PX,
    );
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.right = "auto";
  }

  function handlePanelPointerUp(event) {
    if (drag && !drag.moved) state.collapsed = !state.collapsed;
    drag = null;
    if (panel.hasPointerCapture(event.pointerId))
      panel.releasePointerCapture(event.pointerId);
  }

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
      const root = document.querySelector("#pop_nav");
      const inputs = Array.from(
        document.querySelectorAll(
          "#pop_nav input.nav-visible[data-group-index]",
        ),
      );
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

  function HeaderView(currentState) {
    const information = currentState.progress
      ? currentState.progress
      : [
          currentState.selectedRows.length
            ? `已选 ${currentState.selectedRows.filter((row) => row.checked).length} / ${currentState.selectedRows.length} 只`
            : "",
          currentState.saveFileName,
        ]
          .filter(Boolean)
          .join(" ｜ ");

    return `
      <div id="cotw-filter-header" data-drag-handle>
        <span>🦌 种群筛选</span>
        <span id="cotw-header-info">${escapeHtml(information)}</span>
        <span id="cotw-filter-toggle">${currentState.collapsed ? "+" : "−"}</span>
      </div>
    `;
  }

  function SelectedIndividualRow({ row, index }) {
    const gender = GENDER_SYMBOL[row.gender] ?? "?";
    const weight = Number.isFinite(row.weight)
      ? `${row.weight.toFixed(1)}kg`
      : "—";
    const name = `${row.name} ${gender}`;

    return `
      <label class="cotw-sel-row" data-group="${escapeHtml(row.groupKey)}">
        <input id="cotw-selected-row-${index}" type="checkbox" data-row-index="${index}" ${row.checked ? "checked" : ""}>
        <span class="cotw-sel-name ${genderClass(row.gender)}" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
        <span class="cotw-sel-score">${row.score.toFixed(1)}</span>
        <span class="cotw-sel-weight">${weight}</span>
      </label>
    `;
  }

  function SelectedIndividualsView(currentState) {
    const rows = currentState.selectedRows
      .map((row, index) => ({ row, index }))
      .sort((a, b) => compareRows(a.row, b.row))
      .map(SelectedIndividualRow)
      .join("");
    const hasUnchecked = currentState.selectedRows.some((row) => !row.checked);
    const hasChecked = currentState.selectedRows.some((row) => row.checked);
    const disabled = currentState.busy ? "disabled" : "";

    return `
      <div id="cotw-selected-panel">
        <div class="cotw-selected-toolbar">
          <button id="cotw-select-all" data-action="select-all" ${disabled} ${!hasUnchecked ? "disabled" : ""}>全选</button>
          <button id="cotw-select-none" data-action="select-none" ${disabled} ${!hasChecked ? "disabled" : ""}>全不选</button>
          <span class="cotw-selected-sort">
            <button id="cotw-sort-score" data-action="sort-score" class="${currentState.sortKey === "score" ? "cotw-sort-active" : ""}" ${disabled}>分数${currentState.sortKey === "score" && !currentState.sortDescending ? "↑" : "↓"}</button>
            <button id="cotw-sort-weight" data-action="sort-weight" class="${currentState.sortKey === "weight" ? "cotw-sort-active" : ""}" ${disabled}>体重${currentState.sortKey === "weight" && !currentState.sortDescending ? "↑" : "↓"}</button>
          </span>
        </div>
        <div id="cotw-selected-list" data-scroll-key="selected-list">${rows}</div>
        <div id="cotw-selected-empty" ${currentState.selectedRows.length ? "hidden" : ""}>还没有加入的个体</div>
      </div>
    `;
  }

  function FilterControlsView(currentState) {
    const disabled = currentState.busy ? "disabled" : "";
    const speciesOptions = currentState.speciesOptions.length
      ? currentState.speciesOptions
          .map(
            (name) =>
              `<option value="${escapeHtml(name)}" ${name === currentState.selectedSpecies ? "selected" : ""}>${escapeHtml(name)}</option>`,
          )
          .join("")
      : '<option value="">暂无数据</option>';
    const presetOptions = [
      `<option value="">${currentState.presets.length ? "选择已保存条件" : "暂无保存的条件"}</option>`,
      ...currentState.presets.map(
        (preset) =>
          `<option value="${escapeHtml(preset.name)}" ${preset.name === currentState.presetSelection ? "selected" : ""}>${escapeHtml(preset.name)}</option>`,
      ),
    ].join("");
    const saveControls = currentState.saveFileName
      ? `
          <div id="cotw-selected-save-actions">
            <button id="cotw-reselect-save" class="cotw-secondary" data-action="choose-save" ${disabled}>重新选择存档</button>
            <button id="cotw-refresh-save" data-action="refresh-save" ${disabled}>刷新存档</button>
          </div>
        `
      : `<button id="cotw-select-save" class="cotw-secondary" data-action="choose-save" ${disabled}>选择存档文件</button>`;
    const dialog = `
      <div id="cotw-preset-dialog" class="cotw-preset-dialog" ${currentState.presetDialogOpen ? "" : "hidden"}>
        <div class="cotw-dialog-card">
          <div class="cotw-dialog-title">保存筛选条件</div>
          <input id="cotw-preset-name" data-preset-name data-focus-key="preset-name" type="text" maxlength="20" placeholder="条件名称" value="${escapeHtml(currentState.presetName)}">
          <div id="cotw-preset-error" class="cotw-dialog-error">${escapeHtml(currentState.presetError)}</div>
          <div class="cotw-dialog-actions">
            <button id="cotw-preset-cancel" class="cotw-secondary" data-action="cancel-preset">取消</button>
            <button id="cotw-preset-confirm" data-action="confirm-preset">保存</button>
          </div>
        </div>
      </div>
    `;

    return `
      <div id="cotw-filter-body" data-scroll-key="filter-body">
        ${saveControls}
        <label>物种</label>
        <select id="cotw-species" data-species-select data-focus-key="species" ${disabled}>${speciesOptions}</select>
        <label>筛选条件</label>
        <div class="cotw-preset-row">
          <select id="cotw-preset" data-preset-select data-focus-key="preset" ${disabled || !currentState.presets.length ? "disabled" : ""}>${presetOptions}</select>
          <button id="cotw-preset-save" class="cotw-secondary" data-action="save-preset" ${disabled}>保存</button>
          <button id="cotw-preset-delete" class="cotw-secondary" data-action="delete-preset" ${disabled || !currentState.presetSelection ? "disabled" : ""}>删除</button>
        </div>
        <div class="cotw-range">
          <div><label>最小分数</label><input id="cotw-min" data-filter="scoreMin" data-focus-key="score-min" type="text" inputmode="decimal" autocomplete="off" placeholder="不限" value="${escapeHtml(currentState.filters.scoreMin)}" ${disabled}></div>
          <div><label>最大分数</label><input id="cotw-max" data-filter="scoreMax" data-focus-key="score-max" type="text" inputmode="decimal" autocomplete="off" placeholder="不限" value="${escapeHtml(currentState.filters.scoreMax)}" ${disabled}></div>
        </div>
        <div class="cotw-range">
          <div><label>最小体重</label><input id="cotw-weight-min" data-filter="weightMin" data-focus-key="weight-min" type="text" inputmode="decimal" autocomplete="off" placeholder="不限" value="${escapeHtml(currentState.filters.weightMin)}" ${disabled}></div>
          <div><label>最大体重</label><input id="cotw-weight-max" data-filter="weightMax" data-focus-key="weight-max" type="text" inputmode="decimal" autocomplete="off" placeholder="不限" value="${escapeHtml(currentState.filters.weightMax)}" ${disabled}></div>
        </div>
        <label>性别</label>
        <div class="cotw-genders">
          <label><input id="cotw-gender-male" data-gender="male" type="checkbox" ${currentState.filters.male ? "checked" : ""} ${disabled}> 公 ♂</label>
          <label><input id="cotw-gender-female" data-gender="female" type="checkbox" ${currentState.filters.female ? "checked" : ""} ${disabled}> 母 ♀</label>
        </div>
        <button id="cotw-apply" data-action="apply-filter" ${disabled || !currentState.selectedSpecies ? "disabled" : ""}>筛选并加入列表</button>
        <button id="cotw-clear" class="cotw-secondary" data-action="clear-all" ${disabled}>清空列表</button>
        <div id="cotw-status">${escapeHtml(currentState.statusText)}</div>
        ${AreaDetailsView(currentState)}
        ${dialog}
      </div>
    `;
  }

  function AreaDetailsView(currentState) {
    const hasContent =
      currentState.areaEntries.length > 0 || currentState.areaEmptyText;
    const content = currentState.areaEntries.length
      ? currentState.areaEntries.map(renderAreaGroupBlock).join("")
      : currentState.areaEmptyText
        ? `<div class="cotw-area-empty">${escapeHtml(currentState.areaEmptyText)}</div>`
        : "";

    return `
      <div id="cotw-area-info" ${hasContent ? "" : "hidden"}>
        <div id="cotw-area-results" data-scroll-key="area-results">${content}</div>
      </div>
    `;
  }

  function AppView(currentState) {
    return `
      ${HeaderView(currentState)}
      <div id="cotw-panel-columns" ${currentState.collapsed ? "hidden" : ""}>
        ${SelectedIndividualsView(currentState)}
        ${FilterControlsView(currentState)}
      </div>
    `;
  }

  function render() {
    const activeElement = document.activeElement;
    const focusId = panel.contains(activeElement) ? activeElement.id : "";
    const selection =
      activeElement instanceof HTMLInputElement &&
      typeof activeElement.selectionStart === "number"
        ? [activeElement.selectionStart, activeElement.selectionEnd]
        : null;
    const scrollPositions = new Map(
      [...panel.querySelectorAll("[data-scroll-key]")].map((element) => [
        element.dataset.scrollKey,
        element.scrollTop,
      ]),
    );

    panel.classList.toggle("collapsed", state.collapsed);
    panel.innerHTML = AppView(state);

    let nextFocus = null;
    for (const element of panel.querySelectorAll("[id], [data-scroll-key]")) {
      if (
        element.dataset.scrollKey &&
        scrollPositions.has(element.dataset.scrollKey)
      )
        element.scrollTop = scrollPositions.get(element.dataset.scrollKey);
      if (element.id === focusId) nextFocus = element;
    }

    nextFocus?.focus({ preventScroll: true });
    if (selection && nextFocus instanceof HTMLInputElement) {
      try {
        nextFocus.setSelectionRange(...selection);
      } catch {
        // 某些浏览器输入类型不支持 selection range
      }
    }
  }

  // 应用入口：创建根节点与 Store，绑定事件、观察页面，再启动首次解析。
  function main() {
    const style = document.createElement("style");
    style.textContent = PANEL_CSS;
    document.head.appendChild(style);

    panel = document.createElement("div");
    panel.id = "cotw-filter-panel";
    document.body.appendChild(panel);

    store = createStore(
      {
        statusText: "",
        busy: false,
        saveFileName: "",
        progress: "",
        sortKey: "score",
        sortDescending: true,
        collapsed: false,
        presets: [],
        presetSelection: "",
        presetDialogOpen: false,
        presetName: "",
        presetError: "",
        filters: {
          scoreMin: "",
          scoreMax: "",
          weightMin: "",
          weightMax: "",
          male: true,
          female: true,
        },
        speciesOptions: [],
        selectedSpecies: "",
        selectedRows: [],
        areaEntries: [],
        areaEmptyText: "",
      },
      render,
    );
    state = store.state;

    panel.addEventListener("click", handlePanelClick);
    panel.addEventListener("input", handlePanelInput);
    panel.addEventListener("change", handlePanelChange);
    panel.addEventListener("keydown", handlePanelKeydown);
    panel.addEventListener("pointerdown", handlePanelPointerDown);
    panel.addEventListener("pointermove", handlePanelPointerMove);
    panel.addEventListener("pointerup", handlePanelPointerUp);
    panel.addEventListener("pointercancel", () => {
      drag = null;
    });

    const mapContainer = document.querySelector("#map_display");
    attachMapClickListener();
    if (mapContainer) {
      // 切换保护区时页面会重建 Leaflet map；等新地图 DOM 就绪后绑定一次。
      new MutationObserver(attachMapClickListener).observe(mapContainer, {
        childList: true,
      });
    }

    const dropzone = document.querySelector("#dropzone");
    if (dropzone) {
      new MutationObserver(queueRebuild).observe(dropzone, {
        childList: true,
        subtree: true,
      });
      // 手动点击树上的兽群勾选框时，同步到列表。
      dropzone.addEventListener("change", onTreeCheckboxChanged);
    }

    state.presets = loadPresets();
    refreshPresetOptions("");
    renderSelectedList();

    hookSaveParser();
    void onTreeChanged();
    void restoreSelectedSave();
  }

  main();
})();
