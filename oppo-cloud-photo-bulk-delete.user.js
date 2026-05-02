// ==UserScript==
// @name         OPPO Cloud Photo Bulk Delete
// @name:zh-CN   OPPO 云相册批量删除
// @namespace    https://github.com/SajoLuo/oppo-cloud-photo-bulk-delete
// @version      0.2.1
// @description  Scan, export, clear, restore, and permanently delete photos from the OPPO/HeyTap cloud photo web app.
// @description:zh-CN 扫描、导出、清空、恢复和永久删除 OPPO/HeyTap/OnePlus 云相册照片与视频。
// @author       SajoL
// @license      MIT
// @homepageURL  https://github.com/SajoLuo/oppo-cloud-photo-bulk-delete
// @supportURL   https://github.com/SajoLuo/oppo-cloud-photo-bulk-delete/issues
// @updateURL    https://raw.githubusercontent.com/SajoLuo/oppo-cloud-photo-bulk-delete/main/oppo-cloud-photo-bulk-delete.user.js
// @downloadURL  https://raw.githubusercontent.com/SajoLuo/oppo-cloud-photo-bulk-delete/main/oppo-cloud-photo-bulk-delete.user.js
// @match        https://cloud.oppo.com/module.html*
// @match        https://cloud.oppo.com/*/module.html*
// @match        https://cloud.heytap.com/module.html*
// @match        https://cloud.heytap.com/*/module.html*
// @match        https://cloud.oneplus.com/module.html*
// @match        https://cloud.oneplus.com/*/module.html*
// @run-at       document-idle
// @grant        unsafeWindow
// @grant        GM_addStyle
// ==/UserScript==

(function () {
  "use strict";

  const W = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  const SCRIPT_NAME = "OPPO Cloud Photo Bulk Delete";
  const MAX_BATCH_SIZE = 200;

  const state = {
    busy: false,
    abort: false,
    req: null,
    http: null,
    api: null,
    photoVm: null,
    devices: [],
    currentDevice: null,
    items: [],
    recycleItems: [],
    counts: null,
    normalDone: 0,
    recycleDone: 0,
    restoreDone: 0,
    log: [],
  };

  const ui = {};

  function addStyle(css) {
    if (typeof GM_addStyle === "function") {
      GM_addStyle(css);
      return;
    }
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
  }

  function $(selector, root = document) {
    return root.querySelector(selector);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function nowTime() {
    return new Date().toLocaleTimeString();
  }

  function safeJson(value) {
    try {
      return JSON.stringify(value);
    } catch (_err) {
      return String(value);
    }
  }

  function log(message, level = "info") {
    const line = `[${nowTime()}] ${message}`;
    state.log.push({ line, level });
    if (state.log.length > 300) state.log.shift();
    if (ui.log) {
      const div = document.createElement("div");
      div.className = `ocp-log-line is-${level}`;
      div.textContent = line;
      ui.log.appendChild(div);
      ui.log.scrollTop = ui.log.scrollHeight;
    }
    console[level === "error" ? "error" : "log"](`[${SCRIPT_NAME}] ${message}`);
  }

  function setBusy(busy) {
    state.busy = busy;
    if (ui.root) ui.root.classList.toggle("is-busy", busy);
    renderActions();
  }

  function setStatus(text) {
    if (ui.status) ui.status.textContent = text;
  }

  function waitFor(predicate, timeoutMs = 30000, stepMs = 250) {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        let ok = false;
        try {
          ok = !!predicate();
        } catch (_err) {
          ok = false;
        }
        if (ok) {
          clearInterval(timer);
          resolve(true);
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          reject(new Error("Timed out waiting for OPPO cloud page runtime"));
        }
      }, stepMs);
    });
  }

  function captureWebpackRequire() {
    if (state.req) return state.req;
    if (W.__OPPO_CLOUD_BULK_WEBPACK_REQUIRE__) {
      state.req = W.__OPPO_CLOUD_BULK_WEBPACK_REQUIRE__;
      return state.req;
    }
    if (!isWebpackRuntimeReady()) {
      throw new Error("Cannot find OPPO webpack runtime. Open the cloud photo page first.");
    }

    const id = `__oppo_cloud_bulk_capture_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    W.webpackJsonp.push([
      [id],
      {
        [id]: function (_module, _exports, require) {
          W.__OPPO_CLOUD_BULK_WEBPACK_REQUIRE__ = require;
        },
      },
      [[id]],
    ]);
    if (!W.__OPPO_CLOUD_BULK_WEBPACK_REQUIRE__) {
      throw new Error("Webpack require capture failed. Refresh the page and try again.");
    }
    state.req = W.__OPPO_CLOUD_BULK_WEBPACK_REQUIRE__;
    return state.req;
  }

  function isWebpackRuntimeReady() {
    return (
      W.webpackJsonp &&
      typeof W.webpackJsonp.push === "function" &&
      !String(W.webpackJsonp.push).includes("[native code]")
    );
  }

  function ensureModules() {
    if (state.http && state.api) return;
    const require = captureWebpackRequire();
    const httpModule = require("ff59");
    const apiModule = require("9ca4");
    state.http = httpModule && httpModule.a;
    state.api = apiModule && apiModule.a;
    if (!state.http || !state.http.encryptPost || !state.api) {
      throw new Error("Cannot load OPPO request modules. The site bundle may have changed.");
    }
  }

  function findVueComponent(vm, predicate, seen = new Set()) {
    if (!vm || seen.has(vm)) return null;
    seen.add(vm);
    try {
      if (predicate(vm)) return vm;
      const children = Array.isArray(vm.$children) ? vm.$children : [];
      for (const child of children) {
        const hit = findVueComponent(child, predicate, seen);
        if (hit) return hit;
      }
    } catch (_err) {
      return null;
    }
    return null;
  }

  function getPhotoVm() {
    if (state.photoVm && state.photoVm._isVue) return state.photoVm;
    const root = W.globleVue;
    state.photoVm = findVueComponent(root, (vm) => {
      return (
        vm.currentDevice &&
        vm.tabdata &&
        vm.tabdata.tabs &&
        typeof vm.fetchData === "function" &&
        typeof vm.loadPhotoCount === "function"
      );
    });
    return state.photoVm;
  }

  function makeRequestId() {
    if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  async function encryptedPost(apiName, payload) {
    ensureModules();
    const url = state.api[apiName];
    if (!url) throw new Error(`Unknown OPPO API: ${apiName}`);
    const res = await state.http.encryptPost(url, payload || {});
    if (!res || res.code !== 200) {
      throw new Error(`${apiName} failed: ${safeJson(res).slice(0, 500)}`);
    }
    return res;
  }

  function normalizeDevices(data) {
    const lang = W.lang || {};
    const list = [];
    if (data && data.syncAmount) {
      list.push({
        deviceId: "syncAll",
        deviceName: lang.syncDataTitle || "同步数据",
        amount: data.syncAmount || 0,
        modeType: "sync",
      });
    }
    const backups = data && Array.isArray(data.backupDatas) ? data.backupDatas : [];
    backups.forEach((item) => {
      if (!item || !item.deviceId || !item.deviceName) return;
      list.push({
        deviceId: item.deviceId,
        deviceName: item.deviceName === "all" ? lang.backupDataAll || "全部备份数据" : item.deviceName,
        amount: item.backupAmount || 0,
        modeType: "backup",
      });
    });
    if (!list.length) {
      list.push({ deviceId: "syncAll", deviceName: lang.syncDataTitle || "同步数据", amount: 0, modeType: "sync" });
    }
    return list;
  }

  async function loadDevices() {
    const vm = getPhotoVm();
    if (vm && Array.isArray(vm.selectorList) && vm.selectorList.length) {
      state.devices = vm.selectorList.map((item) => ({ ...item }));
      state.currentDevice = vm.currentDevice || state.devices[0];
      renderDeviceSelect();
      return state.devices;
    }
    const res = await encryptedPost("deviceView", {});
    state.devices = normalizeDevices(res.data || {});
    state.currentDevice = state.devices[0];
    renderDeviceSelect();
    return state.devices;
  }

  function getSelectedDevice() {
    const selected = ui.deviceSelect && ui.deviceSelect.value;
    if (selected) {
      const found = state.devices.find((item) => `${item.modeType}:${item.deviceId}` === selected);
      if (found) state.currentDevice = found;
    }
    if (!state.currentDevice) {
      const vm = getPhotoVm();
      state.currentDevice = (vm && vm.currentDevice) || state.devices[0];
    }
    if (!state.currentDevice || !state.currentDevice.modeType || !state.currentDevice.deviceId) {
      throw new Error("No photo source selected.");
    }
    return state.currentDevice;
  }

  async function loadCounts() {
    const device = getSelectedDevice();
    const res = await encryptedPost("photocount", {
      businessType: device.modeType,
      deviceId: device.deviceId,
    });
    state.counts = res.data && res.data.fileCount ? res.data.fileCount : null;
    renderSummary();
    return state.counts;
  }

  function yyyymmddFromDateInput(value) {
    return value ? value.replace(/-/g, "") : "";
  }

  function normalizeDate(value, fallback) {
    if (!value && fallback) value = fallback;
    if (!value) return "";
    const text = String(value);
    if (/^\d{8}$/.test(text)) return text;
    const match = text.match(/^(\d{4})-?(\d{2})-?(\d{2})/);
    return match ? `${match[1]}${match[2]}${match[3]}` : "";
  }

  function normalizePhotoItem(raw, groupDate) {
    const globalId = raw.globalUniqId || raw.globalUniqueId || raw.globalId;
    const fileId = raw.oosId || raw.fileId;
    const fileName = raw.fileName || "";
    const date = normalizeDate(groupDate, raw.datetaken || raw.date);
    return {
      year: date ? date.slice(0, 4) : "",
      date,
      globalId,
      albumId: raw.albumId == null ? null : raw.albumId,
      fileId,
      fileName,
      fileMediaType: Number(raw.fileMediaType || raw.fileType || 0),
      fileSize: Number(raw.fileSize || 0),
      routeSN: raw.routeSN || "",
      source: "photo",
    };
  }

  function normalizeRecycleItem(raw) {
    const globalId = raw.globalUniqId || raw.globalUniqueId || raw.globalId;
    return {
      date: normalizeDate(raw.datetaken || raw.date || raw.deleteTime || ""),
      globalId,
      albumId: raw.albumId == null ? null : raw.albumId,
      fileId: raw.oosId || raw.fileId,
      fileName: raw.fileName || "",
      fileMediaType: Number(raw.fileMediaType || raw.fileType || 0),
      fileSize: Number(raw.fileSize || 0),
      routeSN: raw.routeSN || "",
      source: "recycle",
    };
  }

  function itemMatchesFilter(item) {
    const mediaType = ui.mediaType ? ui.mediaType.value : "all";
    const from = yyyymmddFromDateInput(ui.dateFrom && ui.dateFrom.value);
    const to = yyyymmddFromDateInput(ui.dateTo && ui.dateTo.value);
    const nameContains = ((ui.nameContains && ui.nameContains.value) || "").trim().toLowerCase();

    if (mediaType === "photo" && item.fileMediaType !== 1) return false;
    if (mediaType === "video" && item.fileMediaType !== 3) return false;
    if (from && item.date && item.date < from) return false;
    if (to && item.date && item.date > to) return false;
    if (nameContains && !String(item.fileName || "").toLowerCase().includes(nameContains)) return false;
    return !!item.globalId;
  }

  async function scanPhotos(options = {}) {
    const device = getSelectedDevice();
    const ignoreFilters = !!options.ignoreFilters;
    const matched = [];
    let transparent = "";
    let firstPage = true;
    let page = 0;
    let totalSeen = 0;

    state.abort = false;
    setBusy(true);
    setStatus(ignoreFilters ? "扫描整个普通相册中..." : "扫描普通相册中...");
    log(
      `开始扫描普通相册：${device.deviceName || device.deviceId} (${device.modeType}/${device.deviceId})${
        ignoreFilters ? "（忽略当前筛选条件）" : ""
      }`,
    );

    try {
      while (!state.abort) {
        page += 1;
        const res = await encryptedPost("photoNewMediaList", {
          transparent,
          firstPage,
          businessType: device.modeType,
          deviceId: device.deviceId,
        });
        const data = res.data || {};
        const groups = Array.isArray(data.items) ? data.items : [];
        groups.forEach((group) => {
          const groupDate = group.date || "";
          const list = Array.isArray(group.cloudAlbumItemList)
            ? group.cloudAlbumItemList
            : Array.isArray(group.items)
              ? group.items
              : [];
          list.forEach((raw) => {
            totalSeen += 1;
            const item = normalizePhotoItem(raw, groupDate);
            if (ignoreFilters ? item.globalId : itemMatchesFilter(item)) matched.push(item);
          });
        });

        transparent = data.transparent || "";
        state.items = matched;
        renderSummary();
        setStatus(`扫描普通相册：第 ${page} 页，命中 ${matched.length}，已看 ${totalSeen}`);
        log(`普通相册第 ${page} 页：累计 ${totalSeen}，命中 ${matched.length}`);
        if (data.final || !groups.length) break;
        firstPage = false;
        await sleep(getDelayMs());
      }
      if (state.abort) {
        log("扫描已中止", "warn");
      } else {
        log(`普通相册扫描完成：命中 ${matched.length} / 已看 ${totalSeen}`);
      }
      return matched;
    } finally {
      setBusy(false);
      setStatus("空闲");
    }
  }

  async function scanRecycle(options = {}) {
    const device = getSelectedDevice();
    const ignoreFilters = !!options.ignoreFilters;
    const matched = [];
    let version = "";
    let page = 0;
    let hasMore = true;

    state.abort = false;
    setBusy(true);
    setStatus(ignoreFilters ? "扫描整个回收站中..." : "扫描回收站中...");
    log(`开始扫描回收站：${device.deviceName || device.deviceId}${ignoreFilters ? "（忽略当前筛选条件）" : ""}`);

    try {
      while (!state.abort && hasMore) {
        page += 1;
        const payload = {
          businessType: device.modeType,
          deviceId: device.deviceId,
        };
        if (version) payload.version = version;
        const res = await encryptedPost("recycleList", payload);
        const data = res.data || {};
        const items = Array.isArray(data.items) ? data.items : [];
        items.forEach((raw) => {
          const item = normalizeRecycleItem(raw);
          if (ignoreFilters ? item.globalId : itemMatchesFilter(item)) matched.push(item);
        });
        version = data.version || "";
        hasMore = !!data.hasMore;
        state.recycleItems = matched;
        renderSummary();
        setStatus(`扫描回收站：第 ${page} 页，命中 ${matched.length}`);
        log(`回收站第 ${page} 页：新增 ${items.length}，累计命中 ${matched.length}`);
        if (hasMore) await sleep(getDelayMs());
      }
      if (state.abort) {
        log("回收站扫描已中止", "warn");
      } else {
        log(`回收站扫描完成：命中 ${matched.length}`);
      }
      return matched;
    } finally {
      setBusy(false);
      setStatus("空闲");
    }
  }

  async function deleteRecycleAllByList(reason) {
    log(`${reason}，改用扫描回收站 + 分批永久删除`, "warn");
    const items = await scanRecycle({ ignoreFilters: true });
    if (!items.length) {
      log("回收站扫描为空，跳过分批永久删除", "warn");
      return;
    }
    await deleteRecycleItems(items, { skipConfirm: true });
  }

  function chunk(items, size) {
    const out = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
  }

  function getBatchSize() {
    const raw = Number(ui.batchSize && ui.batchSize.value);
    if (!Number.isFinite(raw) || raw <= 0) return 100;
    return Math.max(1, Math.min(MAX_BATCH_SIZE, Math.floor(raw)));
  }

  function getDelayMs() {
    const raw = Number(ui.delayMs && ui.delayMs.value);
    if (!Number.isFinite(raw) || raw < 0) return 300;
    return Math.max(0, Math.floor(raw));
  }

  function assertPreflight() {
    if (!ui.confirmBackup.checked || !ui.confirmSyncOff.checked) {
      throw new Error("先勾选：已关闭手机相册云同步，且已有本地备份。");
    }
  }

  function confirmPhrase(title, phrase, detail) {
    const typed = W.prompt(`${title}\n\n${detail}\n\n请输入 ${phrase} 继续：`);
    return typed === phrase;
  }

  async function deleteNormalItems(items, options = {}) {
    assertPreflight();
    const device = getSelectedDevice();
    const target = items.filter((item) => item && item.globalId);
    if (!target.length) throw new Error("没有可移入回收站的筛选结果。先扫描普通相册。");
    if (
      !options.skipConfirm &&
      !confirmPhrase(
        "将筛选结果移入回收站",
        "DELETE",
        `即将把普通相册筛选结果中的 ${target.length} 个云端项目移入 OPPO 云相册回收站。手机同步未关闭时可能影响本地相册。`,
      )
    ) {
      log("已取消普通相册删除", "warn");
      return;
    }

    state.abort = false;
    state.normalDone = 0;
    setBusy(true);
    setStatus("删除普通相册中...");
    log(`开始分批删除普通相册项目：${target.length}`);

    try {
      const batches = chunk(target, getBatchSize());
      for (let i = 0; i < batches.length; i += 1) {
        if (state.abort) break;
        const batch = batches[i];
        await encryptedPost("softdeletepic", {
          gids: batch.map((item) => item.globalId),
          albumIds: batch.map((item) => (item.albumId == null ? null : item.albumId)),
          requestId: makeRequestId(),
          businessType: device.modeType,
          deviceId: device.deviceId,
        });
        state.normalDone += batch.length;
        setStatus(`普通相册删除：${state.normalDone}/${target.length}`);
        log(`普通相册删除批次 ${i + 1}/${batches.length}：${batch.length} 个`);
        await sleep(getDelayMs());
      }
      if (state.abort) {
        log("普通相册删除已中止", "warn");
      } else {
        state.items = [];
        log(`普通相册删除完成：${state.normalDone}/${target.length}，普通相册扫描结果已清空`);
      }
      await loadCounts().catch((err) => log(`刷新计数失败：${err.message}`, "warn"));
    } finally {
      setBusy(false);
      setStatus("空闲");
    }
  }

  async function deleteRecycleItems(items, options = {}) {
    assertPreflight();
    const device = getSelectedDevice();
    const target = items.filter((item) => item && item.globalId);
    if (!target.length) throw new Error("没有可永久删除的回收站筛选结果。先扫描回收站，或使用清空整个回收站。");
    if (
      !options.skipConfirm &&
      !confirmPhrase(
        "永久删除筛选的回收站项目",
        "EMPTY",
        `即将永久删除回收站筛选结果中的 ${target.length} 个项目。此操作不可恢复。`,
      )
    ) {
      log("已取消回收站永久删除", "warn");
      return;
    }

    state.abort = false;
    state.recycleDone = 0;
    setBusy(true);
    setStatus("永久删除回收站中...");
    log(`开始分批永久删除回收站项目：${target.length}`);

    try {
      const batches = chunk(target, getBatchSize());
      for (let i = 0; i < batches.length; i += 1) {
        if (state.abort) break;
        const batch = batches[i];
        await encryptedPost("deletepic", {
          gids: batch.map((item) => item.globalId),
          albumIds: batch.map((item) => (item.albumId == null ? null : item.albumId)),
          requestId: makeRequestId(),
          businessType: device.modeType,
          deviceId: device.deviceId,
        });
        state.recycleDone += batch.length;
        setStatus(`回收站永久删除：${state.recycleDone}/${target.length}`);
        log(`回收站删除批次 ${i + 1}/${batches.length}：${batch.length} 个`);
        await sleep(getDelayMs());
      }
      if (state.abort) {
        log("回收站永久删除已中止", "warn");
      } else {
        state.recycleItems = [];
        log(`回收站永久删除完成：${state.recycleDone}/${target.length}，回收站扫描结果已清空`);
      }
      await loadCounts().catch((err) => log(`刷新计数失败：${err.message}`, "warn"));
    } finally {
      setBusy(false);
      setStatus("空闲");
    }
  }

  async function restoreRecycleItems(items, options = {}) {
    if (!state.currentDevice && (!state.devices || !state.devices.length)) {
      await initRuntime();
    }
    const device = getSelectedDevice();
    const target = items.filter((item) => item && item.globalId);
    if (!target.length) throw new Error("没有可恢复的回收站筛选结果。先扫描回收站。");
    if (
      !options.skipConfirm &&
      !confirmPhrase(
        "恢复筛选的回收站项目",
        "RESTORE",
        `即将把回收站筛选结果中的 ${target.length} 个项目恢复到云端相册。`,
      )
    ) {
      log("已取消回收站恢复", "warn");
      return;
    }

    state.abort = false;
    state.restoreDone = 0;
    setBusy(true);
    setStatus("恢复回收站项目中...");
    log(`开始分批恢复回收站项目：${target.length}`);

    try {
      const batches = chunk(target, getBatchSize());
      for (let i = 0; i < batches.length; i += 1) {
        if (state.abort) break;
        const batch = batches[i];
        await encryptedPost("recyclepic", {
          gids: batch.map((item) => item.globalId),
          albumIds: batch.map((item) => (item.albumId == null ? null : item.albumId)),
          requestId: makeRequestId(),
          businessType: device.modeType,
          deviceId: device.deviceId,
        });
        state.restoreDone += batch.length;
        setStatus(`回收站恢复：${state.restoreDone}/${target.length}`);
        log(`回收站恢复批次 ${i + 1}/${batches.length}：${batch.length} 个`);
        await sleep(getDelayMs());
      }
      if (state.abort) {
        log("回收站恢复已中止", "warn");
      } else {
        state.recycleItems = [];
        log(`回收站恢复完成：${state.restoreDone}/${target.length}，回收站扫描结果已清空`);
      }
      await loadCounts().catch((err) => log(`刷新计数失败：${err.message}`, "warn"));
    } finally {
      setBusy(false);
      setStatus("空闲");
    }
  }

  async function restoreRecycleAllByList(reason) {
    log(`${reason}，改用扫描回收站 + 分批恢复`, "warn");
    const items = await scanRecycle({ ignoreFilters: true });
    if (!items.length) {
      log("回收站扫描为空，跳过恢复", "warn");
      return;
    }
    await restoreRecycleItems(items, { skipConfirm: true });
  }

  async function restoreRecycleAll(options = {}) {
    if (!state.currentDevice && (!state.devices || !state.devices.length)) {
      await initRuntime();
    }
    const device = getSelectedDevice();
    if (
      !options.skipConfirm &&
      !confirmPhrase(
        "恢复整个回收站",
        "RESTORE ALL",
        `即将把 ${device.deviceName || device.deviceId} 回收站中的全部项目恢复到云端相册。`,
      )
    ) {
      log("已取消恢复整个回收站", "warn");
      return;
    }

    setBusy(true);
    setStatus("恢复整个回收站中...");
    log("开始调用恢复整个回收站接口");
    state.restoreDone = 0;
    try {
      try {
        const expected = state.counts && Number(state.counts.recycle);
        await encryptedPost("recycleallrecovery", {
          businessType: device.modeType,
          deviceId: device.deviceId,
        });
        state.recycleItems = [];
        if (Number.isFinite(expected) && expected > 0) state.restoreDone = expected;
        log("恢复整个回收站完成");
        await loadCounts().catch((err) => log(`刷新计数失败：${err.message}`, "warn"));
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        await restoreRecycleAllByList(`恢复整个回收站接口失败：${message}`);
      }
    } finally {
      setBusy(false);
      setStatus("空闲");
      renderSummary();
    }
  }

  async function emptyRecycleAll(options = {}) {
    assertPreflight();
    if (!state.currentDevice && (!state.devices || !state.devices.length)) {
      await initRuntime();
    }
    const device = getSelectedDevice();
    if (
      !options.skipConfirm &&
      !confirmPhrase(
        "清空整个 OPPO 云相册回收站",
        "EMPTY ALL",
        `即将清空 ${device.deviceName || device.deviceId} 的整个云相册回收站。此操作不可恢复。`,
      )
    ) {
      log("已取消清空回收站", "warn");
      return;
    }

    setBusy(true);
    setStatus("清空回收站中...");
    log("开始调用清空回收站接口");
    state.recycleDone = 0;
    try {
      try {
        const expected = state.counts && Number(state.counts.recycle);
        await encryptedPost("recycleallrealdelete", {
          businessType: device.modeType,
          deviceId: device.deviceId,
        });
        state.recycleItems = [];
        if (Number.isFinite(expected) && expected > 0) state.recycleDone = expected;
        log("清空回收站完成");
        await loadCounts().catch((err) => log(`刷新计数失败：${err.message}`, "warn"));
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        await deleteRecycleAllByList(`清空回收站接口失败：${message}`);
      }
    } finally {
      setBusy(false);
      setStatus("空闲");
      renderSummary();
    }
  }

  async function clearCloudFlow() {
    assertPreflight();
    if (!state.currentDevice && (!state.devices || !state.devices.length)) {
      await initRuntime();
    }
    const device = getSelectedDevice();
    if (
      !confirmPhrase(
        "清空云端相册",
        "CLEAR CLOUD",
        `目标：${device.deviceName || device.deviceId}。\n流程：扫描整个普通相册 -> 移入回收站 -> 清空回收站。\n\n这个操作既可用于“清空后从本机重新同步”，也可用于“彻底删除云端副本”。脚本不会修改手机同步开关。`,
      )
    ) {
      log("已取消清空云端相册", "warn");
      return;
    }

    await scanPhotos({ ignoreFilters: true });
    if (!state.items.length) {
      log("扫描结果为空，没有普通相册项目需要删除", "warn");
    } else {
      await deleteNormalItems(state.items, { skipConfirm: true });
    }

    log("等待云端把普通相册删除结果落到回收站...");
    await sleep(Math.max(1500, getDelayMs() * 3));

    await emptyRecycleAll({ skipConfirm: true });
  }

  function exportJson(kind) {
    const device = getSelectedDevice();
    const payload = {
      exportedAt: new Date().toISOString(),
      tool: SCRIPT_NAME,
      source: {
        deviceId: device.deviceId,
        deviceName: device.deviceName,
        amount: device.amount,
        modeType: device.modeType,
      },
      filters: {
        mediaType: ui.mediaType.value,
        dateFrom: ui.dateFrom.value,
        dateTo: ui.dateTo.value,
        nameContains: ui.nameContains.value,
      },
      counts: state.counts,
      items: kind === "recycle" ? state.recycleItems : state.items,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `oppo_cloud_${kind}_manifest_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    log(`已导出 ${kind} 清单`);
  }

  function renderDeviceSelect() {
    if (!ui.deviceSelect) return;
    ui.deviceSelect.innerHTML = "";
    state.devices.forEach((device) => {
      const option = document.createElement("option");
      option.value = `${device.modeType}:${device.deviceId}`;
      option.textContent = `${device.deviceName || device.deviceId} (${device.modeType}, ${device.amount || 0})`;
      ui.deviceSelect.appendChild(option);
    });
    if (state.currentDevice) {
      ui.deviceSelect.value = `${state.currentDevice.modeType}:${state.currentDevice.deviceId}`;
    }
  }

  function renderSummary() {
    if (!ui.summary) return;
    const counts = state.counts || {};
    ui.summary.innerHTML = `
      <div class="ocp-metrics">
        <div><span>照片/视频</span><b>${counts.photo ?? "-"}</b></div>
        <div><span>相册</span><b>${counts.album ?? "-"}</b></div>
        <div><span>回收站</span><b>${counts.recycle ?? "-"}</b></div>
      </div>
      <div class="ocp-summary-line"><b>扫描</b> 普通相册 ${state.items.length}，回收站 ${state.recycleItems.length}</div>
      <div class="ocp-summary-line"><b>进度</b> 移入回收站 ${state.normalDone}，永久删除 ${state.recycleDone}，恢复 ${state.restoreDone}</div>
    `;
  }

  function renderActions() {
    if (!ui.root) return;
    const disabled = state.busy;
    ui.root.querySelectorAll("button[data-action]").forEach((button) => {
      const action = button.getAttribute("data-action");
      button.disabled = disabled && action !== "abort";
    });
    if (ui.abortButton) ui.abortButton.disabled = !state.busy;
  }

  async function runAction(action) {
    try {
      if (action === "open-photo") {
        W.location.hash = "#/photo";
        return;
      }
      if (action === "init") {
        await initRuntime();
      } else if (action === "counts") {
        if (!state.currentDevice && (!state.devices || !state.devices.length)) {
          await initRuntime();
        } else {
          setBusy(true);
          await loadCounts();
          log("云端计数已刷新");
          setBusy(false);
        }
      } else if (action === "scan-photo") {
        await scanPhotos();
      } else if (action === "scan-recycle") {
        await scanRecycle();
      } else if (action === "delete-photo") {
        await deleteNormalItems(state.items);
      } else if (action === "delete-recycle") {
        await deleteRecycleItems(state.recycleItems);
      } else if (action === "restore-recycle") {
        await restoreRecycleItems(state.recycleItems);
      } else if (action === "empty-recycle") {
        await emptyRecycleAll();
      } else if (action === "restore-recycle-all") {
        await restoreRecycleAll();
      } else if (action === "clear-cloud" || action === "full-delete" || action === "primary-goal") {
        await clearCloudFlow();
      } else if (action === "export-photo") {
        exportJson("photo");
      } else if (action === "export-recycle") {
        exportJson("recycle");
      } else if (action === "abort") {
        state.abort = true;
        log("收到中止请求，会在当前批次结束后停止", "warn");
      }
    } catch (err) {
      setBusy(false);
      setStatus("出错");
      log(err && err.message ? err.message : String(err), "error");
      W.alert(`${SCRIPT_NAME}\n\n${err && err.message ? err.message : String(err)}`);
    } finally {
      renderSummary();
      renderActions();
    }
  }

  async function initRuntime() {
    setBusy(true);
    setStatus("初始化中...");
    await waitFor(() => isWebpackRuntimeReady());
    ensureModules();
    getPhotoVm();
    await loadDevices();
    await loadCounts().catch((err) => log(`读取云端计数失败：${err.message}`, "warn"));
    setStatus("空闲");
    log("初始化完成");
    setBusy(false);
  }

  function buildUi() {
    addStyle(`
      .ocp-root{--ocp-danger:#b8002d;--ocp-line:#e4e6eb;--ocp-muted:#666;--ocp-soft:#f7f8fa;position:fixed;right:18px;bottom:18px;width:456px;max-width:calc(100vw - 36px);z-index:2147483647;background:#fff;color:#121212;border:1px solid rgba(0,0,0,.14);box-shadow:0 18px 54px rgba(0,0,0,.18);border-radius:10px;font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
      .ocp-root *{box-sizing:border-box}
      .ocp-head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid var(--ocp-line)}
      .ocp-title{font-weight:700;font-size:15px}
      .ocp-status{font-size:12px;color:var(--ocp-muted)}
      .ocp-collapse{border:0;background:#f2f3f5;border-radius:6px;padding:3px 8px;cursor:pointer}
      .ocp-body{padding:12px 14px 14px;display:grid;gap:12px}
      .ocp-root.is-collapsed .ocp-body{display:none}
      .ocp-purpose{padding:10px 11px;border:1px solid #dfe3e8;border-radius:8px;background:#f7f9fc}
      .ocp-purpose-title{font-weight:700;font-size:14px}
      .ocp-purpose-text{margin-top:4px;color:#555;font-size:12px}
      .ocp-row{display:grid;grid-template-columns:86px 1fr;gap:8px;align-items:center}
      .ocp-row label{color:#555}
      .ocp-row input,.ocp-row select{width:100%;height:34px;border:1px solid #d8d8d8;border-radius:7px;padding:0 9px;background:#fff;font:inherit}
      .ocp-throttle{display:grid;grid-template-columns:1fr 1fr;gap:8px}
      .ocp-throttle label{display:grid;gap:4px;color:#666}
      .ocp-throttle span{font-size:11px}
      .ocp-input-unit{display:flex;align-items:center;border:1px solid #d8d8d8;border-radius:7px;background:#fff;overflow:hidden}
      .ocp-input-unit input{border:0!important;border-radius:0!important;height:34px;padding-right:4px}
      .ocp-input-unit em{font-style:normal;color:#777;font-size:12px;padding-right:9px}
      .ocp-actions,.ocp-grid,.ocp-danger{display:grid;grid-template-columns:1fr 1fr;gap:8px}
      .ocp-actions button,.ocp-grid button,.ocp-danger button,.ocp-inline button{min-height:36px;border:1px solid #d8d8d8;border-radius:7px;background:#fff;cursor:pointer;font:inherit;line-height:1.25;padding:6px 8px;white-space:normal}
      .ocp-actions button:hover,.ocp-grid button:hover,.ocp-inline button:hover{background:var(--ocp-soft)}
      .ocp-primary{grid-column:1 / -1;min-height:42px!important;background:var(--ocp-danger)!important;color:#fff!important;border-color:var(--ocp-danger)!important;font-weight:700}
      .ocp-secondary-danger{border-color:#f0b8b8!important;color:#a00024!important;background:#fff8f8!important}
      .ocp-recovery{border-color:#9fc7ad!important;color:#0b6337!important;background:#f4fbf6!important}
      .ocp-danger{padding-top:8px;border-top:1px solid var(--ocp-line)}
      .ocp-danger button{border-color:#f0b8b8;color:#a00024;background:#fff8f8}
      .ocp-danger .ocp-recovery{grid-column:1 / -1}
      .ocp-inline{display:flex;gap:8px}
      .ocp-inline button{flex:1}
      .ocp-checks{display:grid;gap:7px;padding:9px 10px;background:#fff8e6;border:1px solid #ffe0a3;border-radius:8px}
      .ocp-checks-title{font-weight:700;font-size:12px;color:#7a4b00}
      .ocp-checks label{display:flex;gap:8px;align-items:flex-start}
      .ocp-checks input{margin-top:2px}
      .ocp-advanced{border-top:1px solid var(--ocp-line);padding-top:8px}
      .ocp-advanced summary{cursor:pointer;color:#333;font-weight:700;list-style:none}
      .ocp-advanced summary::-webkit-details-marker{display:none}
      .ocp-advanced summary:after{content:"+";float:right;color:#777}
      .ocp-advanced[open] summary:after{content:"-"}
      .ocp-advanced-body{display:grid;gap:10px;padding-top:10px}
      .ocp-summary{padding:9px;background:var(--ocp-soft);border-radius:8px;color:#333}
      .ocp-metrics{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:7px}
      .ocp-metrics div{display:grid;gap:1px;padding:6px 7px;background:#fff;border:1px solid #eceef2;border-radius:6px}
      .ocp-metrics span{font-size:11px;color:var(--ocp-muted)}
      .ocp-metrics b{font-size:15px}
      .ocp-summary-line{font-size:12px;color:#444}
      .ocp-log{height:128px;overflow:auto;background:#111;color:#ddd;border-radius:8px;padding:8px;font:12px/1.45 Consolas,"JetBrains Mono",monospace}
      .ocp-log-line.is-error{color:#ff8a8a}
      .ocp-log-line.is-warn{color:#ffd37a}
      .ocp-note{font-size:12px;color:var(--ocp-muted)}
      .ocp-root button:disabled{opacity:.48;cursor:not-allowed}
    `);

    const root = document.createElement("div");
    root.className = "ocp-root";
    root.innerHTML = `
      <div class="ocp-head">
        <div>
          <div class="ocp-title">OPPO 云相册批量删除</div>
          <div class="ocp-status">状态：<span data-ref="status">未初始化</span></div>
        </div>
        <button class="ocp-collapse" type="button" title="折叠">-</button>
      </div>
      <div class="ocp-body">
        <div class="ocp-purpose">
          <div class="ocp-purpose-title">清空云端当前数据源</div>
          <div class="ocp-purpose-text">用于重新同步或彻底删除云端副本；区别只在于你之后是否重新打开手机同步。</div>
        </div>
        <div class="ocp-row">
          <label>数据源</label>
          <select data-ref="device"></select>
        </div>
        <div class="ocp-row">
          <label>删除节奏</label>
          <div class="ocp-throttle">
            <label>
              <span>每批数量</span>
              <div class="ocp-input-unit">
                <input data-ref="batchSize" type="number" min="1" max="200" value="100" title="单次请求处理的项目数，最多 200" />
                <em>个</em>
              </div>
            </label>
            <label>
              <span>批间等待</span>
              <div class="ocp-input-unit">
                <input data-ref="delayMs" type="number" min="0" value="300" title="每批请求之间等待的毫秒数" />
                <em>ms</em>
              </div>
            </label>
          </div>
        </div>
        <div class="ocp-checks">
          <div class="ocp-checks-title">删除前确认</div>
          <label><input data-ref="confirmSyncOff" type="checkbox" /> <span>手机相册云同步/自动备份已关闭，避免云端删除反向同步影响本地。</span></label>
          <label><input data-ref="confirmBackup" type="checkbox" /> <span>本地副本/备份状态已确认，了解永久删除不可撤销。</span></label>
        </div>
        <div class="ocp-actions">
          <button class="ocp-primary" type="button" data-action="clear-cloud">清空云端相册</button>
          <button class="ocp-secondary-danger" type="button" data-action="empty-recycle">清空整个回收站</button>
          <button class="ocp-recovery" type="button" data-action="restore-recycle-all">恢复整个回收站</button>
          <button type="button" data-action="init">初始化并读取计数</button>
          <button type="button" data-action="counts">刷新计数</button>
          <button type="button" data-action="open-photo">打开相册页</button>
          <button type="button" data-action="abort">中止当前任务</button>
        </div>
        <details class="ocp-advanced">
          <summary>高级：局部筛选 / 扫描 / 导出</summary>
          <div class="ocp-advanced-body">
            <div class="ocp-row">
              <label>媒体类型</label>
              <select data-ref="mediaType">
                <option value="all">全部</option>
                <option value="photo">只照片</option>
                <option value="video">只视频</option>
              </select>
            </div>
            <div class="ocp-row">
              <label>日期起止</label>
              <div class="ocp-inline">
                <input data-ref="dateFrom" type="date" />
                <input data-ref="dateTo" type="date" />
              </div>
            </div>
            <div class="ocp-row">
              <label>文件名包含</label>
              <input data-ref="nameContains" type="text" placeholder="可留空" />
            </div>
            <div class="ocp-grid">
              <button type="button" data-action="scan-photo">扫描普通相册</button>
              <button type="button" data-action="scan-recycle">扫描回收站</button>
              <button type="button" data-action="export-photo">导出普通相册结果</button>
              <button type="button" data-action="export-recycle">导出回收站结果</button>
            </div>
            <div class="ocp-danger">
              <button type="button" data-action="delete-photo">将筛选结果移入回收站</button>
              <button type="button" data-action="delete-recycle">永久删除筛选的回收站项目</button>
              <button class="ocp-recovery" type="button" data-action="restore-recycle">恢复筛选的回收站项目</button>
            </div>
          </div>
        </details>
        <div class="ocp-summary" data-ref="summary"></div>
        <div class="ocp-log" data-ref="log"></div>
        <div class="ocp-note">主操作会全量处理当前数据源；高级筛选只影响扫描、导出和“筛选结果”操作。</div>
      </div>
    `;

    document.body.appendChild(root);

    ui.root = root;
    ui.status = $('[data-ref="status"]', root);
    ui.deviceSelect = $('[data-ref="device"]', root);
    ui.mediaType = $('[data-ref="mediaType"]', root);
    ui.dateFrom = $('[data-ref="dateFrom"]', root);
    ui.dateTo = $('[data-ref="dateTo"]', root);
    ui.nameContains = $('[data-ref="nameContains"]', root);
    ui.batchSize = $('[data-ref="batchSize"]', root);
    ui.delayMs = $('[data-ref="delayMs"]', root);
    ui.confirmSyncOff = $('[data-ref="confirmSyncOff"]', root);
    ui.confirmBackup = $('[data-ref="confirmBackup"]', root);
    ui.summary = $('[data-ref="summary"]', root);
    ui.log = $('[data-ref="log"]', root);
    ui.abortButton = $('[data-action="abort"]', root);

    $(".ocp-collapse", root).addEventListener("click", () => {
      root.classList.toggle("is-collapsed");
      $(".ocp-collapse", root).textContent = root.classList.contains("is-collapsed") ? "+" : "-";
    });

    root.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      event.preventDefault();
      runAction(button.getAttribute("data-action"));
    });

    ui.deviceSelect.addEventListener("change", () => {
      getSelectedDevice();
      state.items = [];
      state.recycleItems = [];
      state.counts = null;
      state.normalDone = 0;
      state.recycleDone = 0;
      state.restoreDone = 0;
      renderSummary();
      log("已切换数据源，旧扫描结果已清空");
    });

    renderSummary();
    renderActions();
  }

  async function main() {
    if (document.getElementById("oppo-cloud-photo-bulk-delete-root")) return;
    await waitFor(() => document.body, 15000);
    buildUi();
    ui.root.id = "oppo-cloud-photo-bulk-delete-root";
    log("脚本已加载。请先确认手机同步已关闭，再初始化。");
    if (W.location.hash && W.location.hash.startsWith("#/photo")) {
      initRuntime().catch((err) => log(`自动初始化失败：${err.message}`, "warn"));
    }
  }

  main().catch((err) => {
    console.error(`[${SCRIPT_NAME}]`, err);
  });
})();
