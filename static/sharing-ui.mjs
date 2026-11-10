// Shared UI for the website, Android WebView and macOS WKWebView.
export function createSharingUI({ runtime, tr, escapeHtml: h, saveDownload, onImported, addTask, persistTasks, currentShow }) {
  const $ = id => document.getElementById(id);
  const dialog = document.createElement("dialog");
  dialog.id = "sharing-dialog";
  dialog.setAttribute("aria-labelledby", "sharing-title");
  document.body.append(dialog);
  const file = document.createElement("input"); file.type = "file"; file.accept = ".zip,application/zip"; file.hidden = true;
  document.body.append(file);
  const model = { entries: [], loaded: false, refreshing: false, catalogError: "", filter: "", sequence: 0, mode: "", busy: false, error: "", preview: null, export: null, controller: null, returnFocus: null };
  const size = n => `${(n / 1024 / 1024).toFixed(1)} MB`;
  const attribution = a => a ? `<div class="source-credit"><strong>${h(tr("创作者署名"))}: ${h(a.author)}</strong><span>${h(tr("使用条款"))}: ${h(a.license)}</span>${a.source_url ? `<a href="${h(a.source_url)}" target="_blank" rel="noopener noreferrer">${h(tr("查看来源"))} ↗</a>` : ""}</div>` : `<p class="hint">${h(tr("这个备份没有公开署名信息。"))}</p>`;
  function open(mode) {
    model.sequence++;
    model.controller?.abort();
    runtime.discardImport();
    model.mode = mode; model.error = ""; model.preview = null; model.busy = false;
    if (!dialog.open) { model.returnFocus = document.activeElement; dialog.showModal(); }
    renderDialog();
    return model.sequence;
  }
  function close() {
    if (model.busy) return;
    model.sequence++; model.controller?.abort(); runtime.discardImport();
    model.preview = null; model.export = null; model.mode = ""; dialog.close();
    if (model.returnFocus?.isConnected && model.returnFocus.getClientRects().length) model.returnFocus.focus();
    else document.querySelector('#studio [data-play]')?.focus();
  }
  dialog.addEventListener("cancel", e => { e.preventDefault(); close(); });
  function renderDialog() {
    let body = "", title = tr("导入前预览"), footer = "";
    if (model.mode === "loading") body = `<p role="status"><span class="spinner"></span> ${h(tr("正在读取并校验文件…"))}</p><p class="hint">${h(tr("尚未写入节目库，可以取消。"))}</p>`;
    else if (model.mode === "error") body = `<p role="alert">${h(tr(model.error))}</p><p class="hint">${h(tr("已有节目仍保留。关闭后可以重新选择或重试。"))}</p>`;
    else if (model.mode === "export") {
      title = tr("分享这个频道"); const s = model.export;
      body = `<p class="hint">${h(tr("选择完整成片并填写公开署名。只保存到文件，不会自动上传。"))}</p>
        <form id="share-form"><label>${h(tr("创作者署名"))}<input id="share-author" name="author" maxlength="120" required value="${h(s.author)}" autocomplete="off"></label>
        <label>${h(tr("来源链接（可选）"))}<input id="share-source" name="source_url" type="url" maxlength="2048" value="${h(s.source_url)}" placeholder="https://…"></label>
        <label>${h(tr("使用条款"))}<input id="share-license" name="license" maxlength="600" required value="${h(s.license)}"></label>
        <label>${h(tr("公开简介（可选）"))}<textarea id="share-description" name="description" maxlength="1200" rows="2">${h(s.description)}</textarea></label>
        <label class="share-choice"><input type="checkbox" name="remember" ${s.remember ? "checked" : ""}><span>${h(tr("记住公开署名（仅本机）"))}</span></label>
        <fieldset><legend>${h(tr("包含哪些成片"))}</legend>${s.episodes.map(ep => `<label class="share-choice"><input type="checkbox" name="episode" value="${h(ep.id)}" ${s.selected.has(ep.id) ? "checked" : ""}><span>${h(ep.title)}</span></label>`).join("")}</fieldset>
        <p class="hint">${h(tr("包含混好 BGM 的音频、台本和资料。不会包含 Key、模型设置、私人愿望或制作中间文件。最多 50 集、100MB。"))}</p>
        <p class="hint">${h(tr("请仅分享你有权分发的内容，AI 合成与虚构情节应明确说明。"))}</p>
        <button type="submit" class="primary" ${model.busy ? "disabled" : ""}>${h(tr(model.busy ? "正在准备…" : "保存分享包"))}</button></form>`;
    } else if (model.mode === "preview" && model.preview) {
      const p = model.preview;
      body = `<p class="hint">${h(tr(p.kind === "backup" ? "整库备份预览：确认后合并导入，现有频道和模型设置保留。" : "频道分享包预览：确认后保存到本机，无需 Key。"))} · ${h(size(p.bytes))}</p>
        ${p.duplicate ? `<p class="share-note">${h(tr("相同内容已在本地，将打开已有频道，不重复添加。"))}</p>` : p.separateVersion ? `<p class="share-note">${h(tr("这个频道已有其他版本。本次另存一份，不覆盖已有节目。"))}</p>` : ""}
        ${p.channels.map(c => `<article class="preview-channel"><h3>${h(c.title)}</h3><p>${h(c.description || "")}</p><p class="hint">${h(c.language === "ja" ? tr("日语") : tr("英语"))} · ${c.episodes.length} ${h(tr("集"))}</p>${attribution(c.attribution)}${c.origin ? `<h4>${h(tr("原始来源"))}</h4>${attribution(c.origin)}` : ""}<ul class="preview-episodes">${c.episodes.map(ep => `<li><strong>${h(ep.title)}</strong><span class="hint">${Math.floor(ep.duration_seconds || 0)}s${ep.status === "failed" ? ` · ${h(tr("未完成"))}` : ""}</span>${ep.origin ? attribution(ep.origin) : ""}${ep.script ? `<details><summary>${h(tr("查看台本"))}</summary><pre>${h(ep.script)}</pre></details>` : ""}</li>`).join("")}</ul></article>`).join("")}
        <p class="hint">${h(tr("署名由分享者填写，并不代表身份认证。文件校验用于检查完整性。"))}</p>`;
      footer = `<button type="button" class="primary" id="confirm-import" ${model.busy ? "disabled" : ""}>${h(tr(model.busy ? "正在保存…" : p.duplicate ? "打开已有频道" : "加入本地"))}</button>`;
    }
    const cancelled = model.error === "保存已取消，原节目仍保留。";
    const inlineError = model.mode !== "error" && model.error ? `<p class="${cancelled ? "hint" : "sharing-error"}" role="${cancelled ? "status" : "alert"}">${h(tr(model.error))}</p>` : "";
    dialog.innerHTML = `<header class="sharing-head"><h2 id="sharing-title">${h(title)}</h2><button type="button" class="quiet" id="sharing-close" ${model.busy ? "disabled" : ""}>${h(tr("关闭"))}</button></header><div class="sharing-body">${body}${inlineError}</div><footer class="sharing-footer">${footer}</footer>`;
    $("sharing-close").onclick = close;
    if ($("confirm-import")) $("confirm-import").onclick = commit;
    const form = $("share-form");
    if (form) {
      form.oninput = () => {
        for (const key of ["author", "source_url", "license", "description"]) model.export[key] = form.elements[key].value;
        model.export.remember = form.elements.remember.checked;
        model.export.selected = new Set([...form.querySelectorAll('[name="episode"]:checked')].map(e => e.value));
      };
      form.onsubmit = e => { e.preventDefault(); exportFile(); };
      for (const el of form.elements) el.disabled = model.busy;
    }
  }
  function share() {
    const show = currentShow(); if (!show) return;
    const episodes = show.episodes.filter(e => e.status === "ready");
    if (!episodes.length) return;
    const saved = (() => { try { return JSON.parse(localStorage.getItem("diyfm:share-credit") || "null"); } catch { return null; } })();
    model.export = { id: show.id, episodes, selected: new Set(episodes.slice(0, 50).map(e => e.id)), author: saved?.author || "", source_url: saved?.source_url || "", license: saved?.license || "All rights reserved", description: show.description || "", remember: !!saved };
    open("export"); $("share-author")?.focus();
  }
  async function exportFile() {
    if (model.busy || !model.export) return;
    const s = model.export;
    if (!s.selected.size) { model.error = "请选择 1 至 50 集完整成片。"; renderDialog(); return; }
    model.busy = true; model.error = ""; renderDialog();
    const task = addTask({ kind: "share", title: tr("保存频道分享包"), showId: s.id });
    try {
      const blob = await runtime.exportChannel(s.id, { ...s, episodeIds: [...s.selected] });
      const saved = await saveDownload(blob, `diyfm-channel-${s.id}.zip`);
      task.status = saved ? "ready" : "cancelled";
      if (!saved) { model.error = "保存已取消，原节目仍保留。"; task.error = model.error; }
      if (saved) {
        try {
          if (s.remember) localStorage.setItem("diyfm:share-credit", JSON.stringify({ author: s.author, source_url: s.source_url, license: s.license }));
          else localStorage.removeItem("diyfm:share-credit");
        } catch {}
        model.busy = false; close();
      }
    } catch (e) { task.status = "failed"; task.error = e.message; model.error = e.message; }
    finally { model.busy = false; persistTasks(); if (dialog.open) renderDialog(); }
  }
  async function commit() {
    if (model.busy || !model.preview) return;
    const token = model.preview.token;
    model.busy = true; model.error = ""; renderDialog();
    try {
      const result = await runtime.commitImport(token);
      await onImported(result);
      model.busy = false; close();
    } catch (e) { model.error = e.message; }
    finally { model.busy = false; if (dialog.open) renderDialog(); }
  }
  async function prepareFile(selected) {
    const seq = open("loading");
    try {
      if (selected.size > 500 * 1024 * 1024) throw new Error("备份不能超过 500MB。");
      const bytes = await selected.arrayBuffer(); if (seq !== model.sequence) return;
      const preview = await runtime.prepareImport(bytes);
      if (seq !== model.sequence) { runtime.discardImport(preview.token); return; }
      model.preview = preview; model.mode = "preview"; renderDialog();
    } catch (e) { if (seq === model.sequence) { model.mode = "error"; model.error = e.message; renderDialog(); } }
  }
  file.onchange = () => { const selected = file.files?.[0]; file.value = ""; if (selected) prepareFile(selected); };
  function chooseFile() { file.click(); }
  async function fromCatalog(entry, immediately) {
    const seq = open("loading"), controller = new AbortController(); model.controller = controller;
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      const preview = await runtime.prepareCatalog(entry.id, controller.signal);
      if (seq !== model.sequence) { runtime.discardImport(preview.token); return; }
      model.preview = preview; model.mode = "preview";
      if (immediately) await commit(); else renderDialog();
    } catch (e) { if (seq === model.sequence) { model.mode = "error"; model.error = e.name === "AbortError" ? "资源下载超时，请稍后重试。" : e.message; renderDialog(); } }
    finally { clearTimeout(timer); }
  }
  function renderResources() {
    const mount = $("resources-view");
    const rows = model.entries.filter(e => !model.filter || e.language === model.filter);
    mount.innerHTML = `<header class="radio-heading resource-heading"><div><p class="eyebrow">${h(tr("FROM THE COMMUNITY"))}</p><h1>${h(tr("精选频道"))}</h1><p class="intro">${h(tr("下载喜欢的来信，加入自己的离线电台。无需 Key，也不会上传你的节目。"))}</p></div><span class="resource-stamp" aria-hidden="true">✉</span></header>
      <div class="resource-toolbar"><label>${h(tr("收听语言"))}<select id="resource-language"><option value="">${h(tr("全部语言"))}</option><option value="en" ${model.filter === "en" ? "selected" : ""}>${h(tr("英语"))}</option><option value="ja" ${model.filter === "ja" ? "selected" : ""}>${h(tr("日语"))}</option></select></label><button type="button" class="quiet" id="refresh-catalog" ${model.refreshing ? "disabled" : ""}>${h(tr(model.refreshing ? "正在刷新…" : "刷新目录"))}</button><button type="button" class="primary" id="import-channel-file">${h(tr("导入频道包"))}</button></div>
      ${model.catalogError ? `<p class="sharing-error" role="alert">${h(tr(model.catalogError))}</p>` : ""}
      <div class="resource-grid">${rows.length ? rows.map(e => `<article class="resource-card"><p class="station-tag">${h(e.language === "ja" ? tr("日语") : tr("英语"))} · ${h(tr({ beginner: "入门", basic: "基础", advanced: "进阶" }[e.difficulty]))}</p><h2>${h(e.title)}</h2><p>${h(e.description)}</p><p class="hint">${e.episodes} ${h(tr("集"))} · ${h(size(e.bytes))}</p>${attribution(e.attribution)}<div class="resource-actions"><button type="button" class="quiet" data-catalog-preview="${h(e.id)}">${h(tr("预览"))}</button><button type="button" class="primary" data-catalog-add="${h(e.id)}">${h(tr("加入本地"))}</button></div></article>`).join("") : `<div class="empty-episodes"><span aria-hidden="true">✉</span><p>${h(tr(model.refreshing ? "正在读取精选频道…" : model.entries.length ? "没有符合筛选条件的频道。" : model.loaded ? "精选频道将陆续上线。" : "刷新目录，发现可以离线收听的频道。"))}</p><small>${h(tr("也可以导入朋友分享的频道包，确认预览后保存到本机。"))}</small></div>`}</div>`;
    $("resource-language").onchange = e => { model.filter = e.target.value; renderResources(); };
    $("refresh-catalog").onclick = refresh;
    $("import-channel-file").onclick = chooseFile;
    for (const kind of ["preview", "add"]) mount.querySelectorAll(`[data-catalog-${kind}]`).forEach(b => { b.onclick = () => fromCatalog(model.entries.find(e => e.id === b.dataset[kind === "add" ? "catalogAdd" : "catalogPreview"]), kind === "add"); });
  }
  async function refresh() {
    if (model.refreshing) return;
    model.refreshing = true; model.catalogError = ""; renderResources();
    try { model.entries = await runtime.catalog(); model.loaded = true; }
    catch (e) { model.catalogError = e.message; }
    finally { model.refreshing = false; renderResources(); }
  }
  renderResources();
  return { share, chooseFile, prepareFile, refresh, isBusy: () => model.busy || (dialog.open && model.mode === "loading"), enter: () => { renderResources(); if (!model.loaded && !model.refreshing) refresh(); }, repaint: () => { renderResources(); if (dialog.open) renderDialog(); } };
}
