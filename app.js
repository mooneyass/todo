// UI + state. Storage lives in drive.js.
//
// One Drive file holds every list. Which tab you're on is per-device, kept in
// localStorage rather than in the file, so the phone and the PC can sit on
// different lists without fighting each other.

(() => {
  const cfg = window.TODO_CONFIG;
  const SAVE_DELAY = 1200;

  // Mock mode gets its own storage namespace. Without this, lists invented
  // while testing share a cache with the real ones and could be written to the
  // real Drive file on the next sign-in.
  const NS = window.TODO_MOCK ? ".mock" : "";
  const CACHE_KEY = "todo.cache.v3" + NS;
  const ACTIVE_KEY = "todo.activeList.v2" + NS;
  const SIGNED_IN_KEY = "todo.signedIn.v2" + NS;

  // Older caches held mock state or a stale shape (they tracked Drive's version
  // counter rather than the file's contents). Drop them — Drive is the truth.
  try {
    ["todo.cache.v1", "todo.cache.v2", "todo.cache.v2.mock", "todo.activeList", "todo.signedIn"]
      .forEach((k) => localStorage.removeItem(k));
  } catch {
    /* private mode — nothing cached to clean up */
  }

  const $ = (id) => document.getElementById(id);
  const els = {
    status: $("status"),
    account: $("account-btn"),
    tabs: $("tabs"),
    signin: $("signin"),
    signinBtn: $("signin-btn"),
    signinError: $("signin-error"),
    originHint: $("origin-hint"),
    setup: $("setup"),
    app: $("app"),
    list: $("list"),
    empty: $("empty"),
    addBtn: $("add-btn"),
    fullNote: $("full-note"),
    conflictDlg: $("conflict-dlg"),
    deleteDlg: $("delete-dlg"),
    deleteWhat: $("delete-what"),
    deleteListDlg: $("delete-list-dlg"),
    deleteListWhat: $("delete-list-what"),
  };

  let doc = { schema: 2, updatedAt: null, lists: [] };
  let activeId = localStorage.getItem(ACTIVE_KEY) || null;
  let baseline = null;     // exact file text last seen in Drive, for conflict checks
  let dirty = false;       // local edits not yet in Drive
  let saving = false;
  let editSeq = 0;         // bumped on every edit, to detect edits during a save
  let expandedId = null;
  let renamingId = null;   // list currently being renamed inline
  let saveTimer = null;
  let pendingDeleteId = null;
  let pendingDeleteListId = null;

  // ------------------------------------------------------------- helpers

  const uid = () =>
    crypto.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  const now = () => new Date().toISOString();

  function setStatus(text, warn = false) {
    els.status.textContent = text;
    els.status.classList.toggle("warn", warn);
  }

  function shortErr(err) {
    return String(err?.message || err).split("\n")[0].slice(0, 120);
  }

  function setAppVisible(visible) {
    els.app.hidden = !visible;
    els.tabs.hidden = !visible;
  }

  // ------------------------------------------------------------- shape
  // Accepts anything that might be in the file — including a v1 single-list
  // file, or one hand-edited in Drive — and returns a valid document.

  function normalize(raw) {
    const mkItem = (it) => ({
      id: it?.id || uid(),
      rank: Number(it?.rank) || 0,
      title: typeof it?.title === "string" ? it.title : "",
      content: typeof it?.content === "string" ? it.content : "",
      createdAt: it?.createdAt || now(),
    });

    const mkList = (l, i) => {
      const items = (Array.isArray(l?.items) ? l.items : []).map(mkItem);
      items.sort((a, b) => a.rank - b.rank);
      items.forEach((it, n) => (it.rank = n + 1)); // ranks are always 1..n
      return {
        id: l?.id || uid(),
        name: typeof l?.name === "string" && l.name.trim() ? l.name.trim() : `List ${i + 1}`,
        createdAt: l?.createdAt || now(),
        items,
      };
    };

    let lists;
    if (Array.isArray(raw?.lists)) {
      lists = raw.lists.map(mkList);
    } else if (Array.isArray(raw?.items)) {
      lists = [mkList({ name: "To-Do", items: raw.items }, 0)]; // v1 file
    } else {
      lists = [];
    }
    if (!lists.length) lists = [mkList({ name: "To-Do", items: [] }, 0)];

    return { schema: 2, updatedAt: raw?.updatedAt || now(), lists };
  }

  const activeList = () => doc.lists.find((l) => l.id === activeId) || doc.lists[0];

  function setActive(id) {
    activeId = id;
    try {
      localStorage.setItem(ACTIVE_KEY, id ?? "");
    } catch {
      /* ignore */
    }
  }

  // Called after anything replaces `doc` — the active list may not exist there.
  function ensureActive() {
    if (!doc.lists.some((l) => l.id === activeId)) setActive(doc.lists[0]?.id ?? null);
    if (!activeList()?.items.some((i) => i.id === expandedId)) expandedId = null;
  }

  const sorted = () => (activeList()?.items ?? []).slice().sort((a, b) => a.rank - b.rank);

  // ------------------------------------------------------------- cache
  // Local mirror so the app opens instantly and keeps working offline.

  function saveCache() {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ doc, baseline, dirty }));
    } catch {
      /* private mode / quota — Drive is still the source of truth */
    }
  }

  function loadCache() {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY));
      if (!c?.doc) return false;
      doc = normalize(c.doc);
      baseline = typeof c.baseline === "string" ? c.baseline : null;
      dirty = Boolean(c.dirty);
      ensureActive();
      return true;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------- ranking

  // Ranks are always the contiguous run 1..n. Moving an item to rank R drops it
  // into that slot and pushes whatever was there (and everything below) down
  // one; the slot the item vacated closes up.
  function setRank(id, newRank) {
    const items = sorted();
    const from = items.findIndex((i) => i.id === id);
    if (from < 0) return;

    const [item] = items.splice(from, 1);
    const to = Math.min(Math.max(newRank, 1), items.length + 1);
    items.splice(to - 1, 0, item);
    items.forEach((it, i) => (it.rank = i + 1));
    activeList().items = items;
  }

  const renumber = () => sorted().forEach((it, i) => (it.rank = i + 1));

  // ------------------------------------------------------------- tabs

  function renderTabs() {
    const frag = document.createDocumentFragment();

    for (const list of doc.lists) {
      const tab = document.createElement("div");
      tab.className = "tab" + (list.id === activeId ? " active" : "");
      tab.dataset.id = list.id;

      if (list.id === renamingId) {
        tab.appendChild(renameField(list));
        frag.appendChild(tab);
        continue;
      }

      const name = document.createElement("button");
      name.type = "button";
      name.className = "tab-name";
      name.textContent = list.name;
      name.title = "Double-click to rename";
      name.addEventListener("click", () => selectList(list.id));
      name.addEventListener("dblclick", (e) => {
        e.preventDefault();
        startRename(list.id);
      });
      onLongPress(name, () => startRename(list.id)); // touch equivalent
      tab.appendChild(name);

      // Only the active tab carries a close button, and never the last list.
      if (list.id === activeId && doc.lists.length > 1) {
        tab.classList.add("has-x"); // CSS pads the label so it stays centred
        const x = document.createElement("button");
        x.type = "button";
        x.className = "tab-x";
        x.textContent = "×";
        x.setAttribute("aria-label", `Delete list ${list.name}`);
        x.addEventListener("click", (e) => {
          e.stopPropagation();
          askDeleteList(list.id);
        });
        tab.appendChild(x);
      }

      frag.appendChild(tab);
    }

    const add = document.createElement("button");
    add.type = "button";
    add.className = "tab-add";
    add.textContent = "+";
    add.title = "New list";
    add.setAttribute("aria-label", "New list");
    add.addEventListener("click", addList);
    frag.appendChild(add);

    els.tabs.replaceChildren(frag);
    els.tabs.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function renameField(list) {
    const input = document.createElement("input");
    input.className = "tab-edit";
    input.value = list.name;
    input.maxLength = 40;
    input.setAttribute("aria-label", "List name");

    let settled = false;
    const commit = (save) => {
      if (settled) return;
      settled = true;
      renamingId = null;
      const value = input.value.trim();
      if (save && value && value !== list.name) {
        list.name = value;
        touch();
      }
      renderTabs();
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        commit(false);
      }
    });
    input.addEventListener("blur", () => commit(true));

    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
    return input;
  }

  // Long-press stands in for double-click on touch screens. Ignores the mouse,
  // and bails if the finger moves — otherwise scrolling the tab strip would
  // start a rename.
  function onLongPress(el, fn, ms = 550) {
    let timer = null;
    let fired = false;
    let x0 = 0;
    let y0 = 0;

    const cancel = () => {
      clearTimeout(timer);
      timer = null;
    };

    el.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse") return;
      fired = false;
      x0 = e.clientX;
      y0 = e.clientY;
      timer = setTimeout(() => {
        fired = true;
        fn();
      }, ms);
    });

    el.addEventListener("pointermove", (e) => {
      if (timer && Math.hypot(e.clientX - x0, e.clientY - y0) > 10) cancel();
    });
    el.addEventListener("pointerup", cancel);
    el.addEventListener("pointercancel", cancel);
    el.addEventListener("pointerleave", cancel);

    // Swallow the click that follows a long-press, so it doesn't also switch tabs.
    el.addEventListener(
      "click",
      (e) => {
        if (!fired) return;
        fired = false;
        e.preventDefault();
        e.stopPropagation();
      },
      true
    );
  }

  function selectList(id) {
    if (id === activeId) return;
    setActive(id);
    expandedId = null;
    renderAll();
  }

  function startRename(id) {
    renamingId = id;
    renderTabs();
  }

  function addList() {
    const list = {
      id: uid(),
      name: `List ${doc.lists.length + 1}`,
      createdAt: now(),
      items: [],
    };
    doc.lists.push(list);
    setActive(list.id);
    expandedId = null;
    renamingId = list.id; // open straight into rename, so naming it is one step
    touch();
    renderAll();
  }

  function askDeleteList(id) {
    const list = doc.lists.find((l) => l.id === id);
    if (!list || doc.lists.length < 2) return;
    pendingDeleteListId = id;
    const n = list.items.length;
    els.deleteListWhat.textContent =
      `“${list.name}” and its ` + (n === 1 ? "1 item" : `${n} items`) + " will be removed.";
    els.deleteListDlg.showModal();
  }

  function doDeleteList() {
    doc.lists = doc.lists.filter((l) => l.id !== pendingDeleteListId);
    pendingDeleteListId = null;
    ensureActive();
    touch();
    renderAll();
  }

  // ------------------------------------------------------------- items

  function renderAll() {
    renderTabs();
    render();
  }

  function render() {
    const items = sorted();
    els.list.replaceChildren(...items.map(renderItem));
    els.empty.hidden = items.length > 0;
    els.addBtn.disabled = items.length >= cfg.MAX_ITEMS;
    els.fullNote.hidden = items.length < cfg.MAX_ITEMS;
  }

  function renderItem(item) {
    const count = activeList()?.items.length ?? 0;
    const li = document.createElement("li");
    li.className = "item" + (item.id === expandedId ? " open" : "");
    li.dataset.id = item.id;

    // --- rank dropdown: 1..MAX_ITEMS, with ranks past the end of the list
    // disabled so a pick can never land somewhere surprising. Grows beyond
    // MAX_ITEMS only if a hand-edited file arrived with more items than that.
    const rank = document.createElement("select");
    rank.className = "rank";
    rank.setAttribute("aria-label", `Ranking for ${item.title || "untitled item"}`);
    for (let n = 1; n <= Math.max(cfg.MAX_ITEMS, count); n++) {
      const opt = document.createElement("option");
      opt.value = String(n);
      opt.textContent = String(n);
      opt.disabled = n > count;
      opt.selected = n === item.rank;
      rank.appendChild(opt);
    }
    rank.addEventListener("change", () => {
      setRank(item.id, Number(rank.value));
      touch();
      render();
    });

    // --- collapsed title
    const titleBtn = document.createElement("button");
    titleBtn.type = "button";
    titleBtn.className = "title-btn" + (item.title ? "" : " placeholder");
    titleBtn.textContent = item.title || "Untitled";
    titleBtn.addEventListener("click", () => toggle(item.id));

    // --- expanded title, editable in place
    const titleInput = document.createElement("input");
    titleInput.className = "title-input";
    titleInput.value = item.title;
    titleInput.placeholder = "Title";
    titleInput.addEventListener("input", () => {
      item.title = titleInput.value;
      touch();
    });
    titleInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        li.querySelector(".content").focus();
      }
    });

    const chev = document.createElement("button");
    chev.type = "button";
    chev.className = "chev";
    chev.setAttribute("aria-label", item.id === expandedId ? "Collapse" : "Expand");
    chev.addEventListener("click", () => toggle(item.id));

    const row = document.createElement("div");
    row.className = "row";
    row.append(rank, titleBtn, titleInput, chev);

    // --- expanded panel
    const content = document.createElement("textarea");
    content.className = "content";
    content.value = item.content;
    content.placeholder = "Notes…";
    content.addEventListener("input", () => {
      item.content = content.value;
      autoGrow(content);
      touch();
    });

    const del = document.createElement("button");
    del.type = "button";
    del.className = "danger";
    del.textContent = "Delete";
    del.addEventListener("click", () => askDelete(item.id));

    const actions = document.createElement("div");
    actions.className = "panel-actions";
    actions.appendChild(del);

    const panel = document.createElement("div");
    panel.className = "panel";
    panel.append(content, actions);

    li.append(row, panel);
    if (item.id === expandedId) requestAnimationFrame(() => autoGrow(content));
    return li;
  }

  function autoGrow(ta) {
    ta.style.height = "auto";
    ta.style.height = Math.max(ta.scrollHeight + 2, 108) + "px";
  }

  function toggle(id) {
    expandedId = expandedId === id ? null : id;
    render();
    if (expandedId) {
      els.list.querySelector(`[data-id="${CSS.escape(expandedId)}"] .title-input`)?.focus();
    }
  }

  function touch() {
    doc.updatedAt = now();
    dirty = true;
    editSeq++;
    saveCache();
    scheduleSave();
  }

  function addItem() {
    const list = activeList();
    if (!list || list.items.length >= cfg.MAX_ITEMS) return;
    const item = {
      id: uid(),
      rank: list.items.length + 1,
      title: "",
      content: "",
      createdAt: now(),
    };
    list.items.push(item);
    expandedId = item.id;
    touch();
    render();
    els.list.querySelector(`[data-id="${CSS.escape(item.id)}"] .title-input`)?.focus();
  }

  function askDelete(id) {
    const item = activeList()?.items.find((i) => i.id === id);
    if (!item) return;
    pendingDeleteId = id;
    els.deleteWhat.textContent = item.title
      ? `“${item.title}” will be removed.`
      : "This untitled item will be removed.";
    els.deleteDlg.showModal();
  }

  function doDelete() {
    const list = activeList();
    if (!list) return;
    list.items = list.items.filter((i) => i.id !== pendingDeleteId);
    if (expandedId === pendingDeleteId) expandedId = null;
    pendingDeleteId = null;
    renumber();
    touch();
    render();
  }

  // ------------------------------------------------------------- syncing

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, SAVE_DELAY);
  }

  async function flush() {
    if (!dirty || saving) return;
    if (!Drive.hasConnection()) return;

    if (!navigator.onLine) {
      setStatus("Offline — saved on this device");
      return;
    }

    saving = true;
    const seqAtStart = editSeq;
    setStatus("Saving…");
    try {
      baseline = await Drive.save(doc, baseline);
      if (editSeq === seqAtStart) {
        dirty = false;
        setStatus("Saved");
      } else {
        scheduleSave(); // edits landed mid-save; write again
      }
      saveCache();
    } catch (err) {
      if (err instanceof Drive.ConflictError) {
        setStatus("Conflict — needs a decision", true);
        els.conflictDlg.showModal();
      } else if (!navigator.onLine) {
        setStatus("Offline — saved on this device");
      } else if (err instanceof Drive.AuthError) {
        // Token aged out and couldn't be renewed without a prompt. Edits stay
        // in the local cache and go up once the user signs in again.
        showSignedOut("Your session expired. Sign in again to save your changes.", true);
      } else {
        setStatus("Not saved — " + shortErr(err), true);
      }
    } finally {
      saving = false;
    }
  }

  function adopt(remote) {
    doc = normalize(remote.doc);
    baseline = remote.raw;
    renamingId = null;
    ensureActive();
    saveCache();
    setAppVisible(true);
    renderAll();
  }

  async function pullRemote() {
    const remote = await Drive.load();

    if (!dirty) {
      adopt(remote);
      setStatus("Saved");
      return;
    }

    // Local edits waiting. If they were made on top of what Drive still has,
    // just push them; otherwise the other device got there first.
    if (baseline != null && remote.raw === baseline) {
      await flush();
    } else {
      setStatus("Conflict — needs a decision", true);
      els.conflictDlg.showModal();
    }
  }

  async function resolveConflict(keepMine) {
    els.conflictDlg.close();
    try {
      if (keepMine) {
        baseline = await Drive.save(doc, null); // null = force overwrite
        dirty = false;
        saveCache();
      } else {
        adopt(await Drive.load());
        dirty = false;
        saveCache();
      }
      setStatus("Saved");
    } catch (err) {
      setStatus("Not saved — " + shortErr(err), true);
    }
  }

  // ------------------------------------------------------------- screens

  function showSignedIn() {
    els.signin.hidden = true;
    els.account.hidden = false;
    // Don't reveal an empty list before the data lands — there'd be an Add
    // button with no list behind it. adopt() reveals it once there is one.
    setAppVisible(doc.lists.length > 0);
  }

  // keepList: leave the list on screen and put the sign-in card above it. Used
  // when a session expires mid-edit — yanking the user's work off the screen
  // would look like data loss, even though the cache still has it.
  function showSignedOut(message, keepList = false) {
    if (!keepList) setAppVisible(false);
    els.signin.hidden = false;
    els.account.hidden = true;
    els.signinError.hidden = !message;
    els.signinError.textContent = message || "";

    // The desktop launcher may fall back to a different port, and Google matches
    // origins exactly — so when sign-in fails, say which origin needs allowing.
    els.originHint.hidden = !message;
    els.originHint.textContent = message
      ? `This app is running at ${location.origin}. That exact address has to be ` +
        `listed under "Authorized JavaScript origins" on your Google OAuth client.`
      : "";

    setStatus(keepList ? "Not saved — sign in again" : "Signed out", keepList);
  }

  async function connect() {
    setStatus("Loading…");
    showSignedIn();
    try {
      await pullRemote();
      localStorage.setItem(SIGNED_IN_KEY, "1");
    } catch (err) {
      setStatus("Couldn't reach Drive — " + shortErr(err), true);
    }
  }

  // ------------------------------------------------------------- boot

  async function boot() {
    if (!cfg.GOOGLE_CLIENT_ID) {
      els.setup.hidden = false;
      setStatus("Not configured");
      return;
    }

    // Paint from cache first so the app is usable before the network answers.
    if (loadCache()) {
      setAppVisible(true);
      renderAll();
      setStatus(dirty ? "Unsaved changes on this device" : "…");
    }

    if (localStorage.getItem(SIGNED_IN_KEY) === "1") {
      try {
        await Drive.signInSilently();
        await connect();
        return;
      } catch {
        /* consent expired or no live Google session — fall through */
      }
    }
    showSignedOut(dirty ? "Sign in to save the changes waiting on this device." : "", dirty);
  }

  // ------------------------------------------------------------- wiring

  els.signinBtn.addEventListener("click", async () => {
    els.signinError.hidden = true;
    try {
      await Drive.signIn();
      await connect();
    } catch (err) {
      showSignedOut(shortErr(err));
    }
  });

  els.account.addEventListener("click", () => {
    Drive.signOut();
    localStorage.removeItem(SIGNED_IN_KEY);
    showSignedOut();
  });

  els.addBtn.addEventListener("click", addItem);

  $("conflict-theirs").addEventListener("click", () => resolveConflict(false));
  $("conflict-mine").addEventListener("click", () => resolveConflict(true));

  $("delete-cancel").addEventListener("click", () => els.deleteDlg.close());
  $("delete-confirm").addEventListener("click", () => {
    els.deleteDlg.close();
    doDelete();
  });
  els.deleteDlg.addEventListener("close", () => (pendingDeleteId = null));

  $("delete-list-cancel").addEventListener("click", () => els.deleteListDlg.close());
  $("delete-list-confirm").addEventListener("click", () => {
    els.deleteListDlg.close();
    doDeleteList();
  });
  els.deleteListDlg.addEventListener("close", () => (pendingDeleteListId = null));

  // Pick up the other device's changes when this one comes back to the front.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (!Drive.hasConnection() || saving || renamingId) return;
    pullRemote().catch((err) => {
      if (err instanceof Drive.AuthError) {
        showSignedOut("Your session expired. Sign in again to keep syncing.", dirty);
      } else {
        setStatus("Refresh failed — " + shortErr(err), true);
      }
    });
  });

  window.addEventListener("online", () => {
    if (dirty) flush();
  });
  window.addEventListener("offline", () => {
    if (dirty) setStatus("Offline — saved on this device");
  });

  // Best-effort flush if the tab is closed with edits pending.
  window.addEventListener("beforeunload", (e) => {
    if (dirty) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () =>
      navigator.serviceWorker.register("sw.js").catch(() => {})
    );
  }

  boot();
})();
