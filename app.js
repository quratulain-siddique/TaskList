/**
 * Personal Tasks — PWA
 * Guest: localStorage. Signed in: Firestore sync per email.
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig, isFirebaseConfigured } from "./firebase-config.js";

const STORAGE_KEY = "my-tasks-v1";
const DEFAULT_LIST_ID = "default";
const DEFAULT_LIST_NAME = "Task list";

/** @typedef {{ id: string, title: string, done: boolean }} Subtask */
/** @typedef {{ id: string, name: string }} TaskList */
/** @typedef {{ id: string, listId: string, title: string, due: string|null, done: boolean, progress: number, total: number, notes: string, subtasks: Subtask[], updatedAt?: string }} Task */

const state = {
  tasks: /** @type {Task[]} */ ([]),
  lists: /** @type {TaskList[]} */ ([{ id: DEFAULT_LIST_ID, name: DEFAULT_LIST_NAME }]),
  activeListId: DEFAULT_LIST_ID,
  filter: "all", // all | active | done
  query: "",
  editingId: null,
  /** @type {Subtask[]} */
  dialogSubtasks: [],
  /** @type {{ uid: string, email: string } | null} */
  user: null,
};

/** @type {import("firebase/firestore").Unsubscribe | null} */
let unsubTasks = null;
/** @type {import("firebase/firestore").Firestore | null} */
let db = null;
/** @type {import("firebase/auth").Auth | null} */
let auth = null;
let applyingRemote = false;

// —— Firebase ——

function initFirebase() {
  if (!isFirebaseConfigured()) return false;
  try {
    const app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
    return true;
  } catch (e) {
    console.warn("Firebase init failed:", e);
    return false;
  }
}

function userDocRef(uid) {
  return doc(db, "users", uid);
}

function updateAccountUi() {
  const sub = document.getElementById("drawer-sub");
  const btnIn = document.getElementById("btn-sign-in");
  const btnOut = document.getElementById("btn-sign-out");
  if (state.user) {
    sub.textContent = state.user.email || "Signed in";
    btnIn.hidden = true;
    btnOut.hidden = false;
  } else {
    sub.textContent = "Guest — stored on this device";
    btnIn.hidden = false;
    btnOut.hidden = true;
  }
}

function stopCloudSync() {
  if (unsubTasks) {
    unsubTasks();
    unsubTasks = null;
  }
}

function defaultLists() {
  return [{ id: DEFAULT_LIST_ID, name: DEFAULT_LIST_NAME }];
}

function normalizeList(l) {
  const id = String(l?.id || uid());
  const name = String(l?.name || "").trim() || "Untitled list";
  return { id, name };
}

function mergeNamedLists(cloudLists, localLists) {
  const byId = new Map();
  const order = [];
  for (const raw of [...(cloudLists || []), ...(localLists || [])]) {
    const n = normalizeList(raw);
    if (!byId.has(n.id)) {
      byId.set(n.id, n);
      order.push(n.id);
    } else {
      byId.set(n.id, n);
    }
  }
  if (!byId.has(DEFAULT_LIST_ID)) {
    byId.set(DEFAULT_LIST_ID, { id: DEFAULT_LIST_ID, name: DEFAULT_LIST_NAME });
    order.unshift(DEFAULT_LIST_ID);
  }
  return order.map((id) => byId.get(id));
}

function ensureActiveList() {
  if (!state.lists.length) state.lists = defaultLists();
  if (!state.lists.some((l) => l.id === state.activeListId)) {
    state.activeListId = state.lists[0].id;
  }
}

function activeList() {
  ensureActiveList();
  return state.lists.find((l) => l.id === state.activeListId) || state.lists[0];
}

function parseStorageRaw(raw) {
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    return {
      lists: defaultLists(),
      activeListId: DEFAULT_LIST_ID,
      tasks: parsed.map((t) => normalizeTask({ ...t, listId: t.listId || DEFAULT_LIST_ID })),
    };
  }
  if (parsed && typeof parsed === "object") {
    const lists =
      Array.isArray(parsed.lists) && parsed.lists.length
        ? parsed.lists.map(normalizeList)
        : defaultLists();
    let activeListId = String(parsed.activeListId || lists[0].id);
    if (!lists.some((l) => l.id === activeListId)) activeListId = lists[0].id;
    const tasks = Array.isArray(parsed.tasks)
      ? parsed.tasks.map((t) => normalizeTask(t))
      : [];
    return { lists, activeListId, tasks };
  }
  return { lists: defaultLists(), activeListId: DEFAULT_LIST_ID, tasks: [] };
}

function persistPayload() {
  ensureActiveList();
  return {
    v: 2,
    lists: state.lists.map(normalizeList),
    activeListId: state.activeListId,
    tasks: state.tasks.map(normalizeTask),
  };
}

function writeLocalReplica() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(persistPayload()));
}

const REPLICA_CHECK_KEY = "my-tasks-replica-day";

function markReplicaCheckedToday() {
  localStorage.setItem(REPLICA_CHECK_KEY, formatLocalDate(new Date()));
}

/** While signed in, keep localStorage as a copy of the account list (daily + on changes). */
function maybeDailyReplicaCheck() {
  if (!state.user) return;
  const today = formatLocalDate(new Date());
  if (localStorage.getItem(REPLICA_CHECK_KEY) === today) return;
  writeLocalReplica();
  markReplicaCheckedToday();
}

function nowIso() {
  return new Date().toISOString();
}

function mergeSubtaskLists(a, b) {
  const byId = new Map();
  const order = [];
  for (const raw of [...(a || []), ...(b || [])]) {
    const s = normalizeSubtask(raw);
    if (!s.id) continue;
    if (!byId.has(s.id)) {
      byId.set(s.id, s);
      order.push(s.id);
    } else {
      const prev = byId.get(s.id);
      byId.set(s.id, {
        id: s.id,
        title: s.title || prev.title,
        done: Boolean(s.done || prev.done),
      });
    }
  }
  return order.map((id) => byId.get(id));
}

/** Deep-merge one task: union subtasks; scalars from newer updatedAt (local wins ties). */
function mergeTwoTasks(cloud, local) {
  const c = normalizeTask(cloud);
  const l = normalizeTask(local);
  const cTime = Date.parse(c.updatedAt || "") || 0;
  const lTime = Date.parse(l.updatedAt || "") || 0;
  const newer = lTime >= cTime ? l : c;
  const older = newer === l ? c : l;
  return normalizeTask({
    id: c.id || l.id,
    listId: newer.listId || older.listId || DEFAULT_LIST_ID,
    title: newer.title || older.title,
    due: newer.due !== undefined && newer.due !== null ? newer.due : older.due,
    done: newer.done,
    progress: newer.progress,
    total: newer.total,
    notes: newer.notes || older.notes,
    subtasks: mergeSubtaskLists(c.subtasks, l.subtasks),
    updatedAt: newer.updatedAt || older.updatedAt || nowIso(),
  });
}

/**
 * Merge by task id. Local-only tasks are added.
 * Same id → deep merge (keeps local subtasks cloud is missing).
 */
function mergeTaskLists(cloudTasks, localTasks) {
  const byId = new Map();
  for (const t of cloudTasks || []) {
    const n = normalizeTask(t);
    byId.set(n.id, n);
  }
  for (const t of localTasks || []) {
    const n = normalizeTask(t);
    if (!byId.has(n.id)) byId.set(n.id, n);
    else byId.set(n.id, mergeTwoTasks(byId.get(n.id), n));
  }
  return Array.from(byId.values());
}

function tasksFingerprint(tasks, lists) {
  return JSON.stringify({
    lists: (lists || [])
      .map((l) => ({ id: l.id, name: l.name }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id))),
    tasks: (tasks || [])
      .map((t) => ({
        id: t.id,
        listId: t.listId || DEFAULT_LIST_ID,
        title: t.title,
        due: t.due,
        done: t.done,
        updatedAt: t.updatedAt || "",
        subtasks: (t.subtasks || []).map((s) => ({ id: s.id, title: s.title, done: s.done })),
      }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id))),
  });
}

let cloudPushTimer = null;

async function saveTasksCloud() {
  if (!state.user || !db || applyingRemote) return;
  try {
    await setDoc(
      userDocRef(state.user.uid),
      {
        tasks: state.tasks,
        lists: state.lists,
        updatedAt: nowIso(),
        email: state.user.email,
      },
      { merge: true }
    );
  } catch (e) {
    console.warn("Cloud save failed (will retry when online):", e);
    if (navigator.onLine) {
      // Avoid noisy alerts while offline; only warn when we think we're online
      console.warn(e);
    }
  }
}

function scheduleCloudPush() {
  if (!state.user || applyingRemote) return;
  clearTimeout(cloudPushTimer);
  cloudPushTimer = setTimeout(() => {
    saveTasksCloud();
  }, 300);
}

/**
 * Persist: always write localStorage. When signed in, also write Firestore.
 */
function saveTasks() {
  // Ensure every task/subtask has an id before persist
  state.tasks = state.tasks.map((t) => normalizeTask(t));
  state.lists = state.lists.map(normalizeList);
  ensureActiveList();
  writeLocalReplica();
  if (state.user) {
    markReplicaCheckedToday();
    scheduleCloudPush();
  }
}

function loadLocalTasks() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      state.tasks = [];
      state.lists = defaultLists();
      state.activeListId = DEFAULT_LIST_ID;
      return;
    }
    const data = parseStorageRaw(raw);
    state.lists = data.lists;
    state.activeListId = data.activeListId;
    state.tasks = data.tasks;
    ensureActiveList();
    // Persist so newly assigned ids / migrated shape stay stable
    writeLocalReplica();
  } catch {
    state.tasks = [];
    state.lists = defaultLists();
    state.activeListId = DEFAULT_LIST_ID;
  }
}

function readLocalSnapshot() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { lists: defaultLists(), activeListId: DEFAULT_LIST_ID, tasks: [] };
    }
    return parseStorageRaw(raw);
  } catch {
    return { lists: defaultLists(), activeListId: DEFAULT_LIST_ID, tasks: [] };
  }
}

function readLocalTasksSnapshot() {
  return readLocalSnapshot().tasks;
}

function setLoading(on, message = "Loading tasks…") {
  const el = document.getElementById("loading-overlay");
  const text = el?.querySelector(".loading-text");
  if (!el) return;
  if (text) text.textContent = message;
  el.hidden = !on;
}

/** Apply Firebase state as source of truth; localStorage is only a cache. Never push local into cloud here. */
function applyCloudState(cloudTasks, cloudLists) {
  applyingRemote = true;
  const prevActive = state.activeListId;
  state.tasks = (cloudTasks || []).map(normalizeTask);
  state.lists = (cloudLists?.length ? cloudLists : defaultLists()).map(normalizeList);
  if (prevActive && state.lists.some((l) => l.id === prevActive)) {
    state.activeListId = prevActive;
  } else {
    ensureActiveList();
  }
  writeLocalReplica();
  markReplicaCheckedToday();
  applyingRemote = false;
  setLoading(false);
  render();
}

async function startCloudSync(user) {
  stopCloudSync();
  // Show cached replica while offline / until cloud loads
  loadLocalTasks();
  render();

  if (!navigator.onLine) {
    setLoading(false);
    return;
  }

  setLoading(true, "Syncing tasks…");
  try {
    const ref = userDocRef(user.uid);
    const snap = await getDoc(ref);
    const cloudTasks =
      snap.exists() && Array.isArray(snap.data()?.tasks)
        ? snap.data().tasks.map(normalizeTask)
        : [];
    const cloudLists =
      snap.exists() && Array.isArray(snap.data()?.lists) && snap.data().lists.length
        ? snap.data().lists.map(normalizeList)
        : defaultLists();

    // Signed in: Firebase only — do not merge localStorage back into the account
    applyCloudState(cloudTasks, cloudLists);

    if (!snap.exists()) {
      await setDoc(ref, {
        tasks: [],
        lists: defaultLists(),
        updatedAt: nowIso(),
        email: user.email || "",
      });
    }

    unsubTasks = onSnapshot(
      ref,
      (docSnap) => {
        if (!docSnap.exists()) return;
        const remote = Array.isArray(docSnap.data()?.tasks)
          ? docSnap.data().tasks.map(normalizeTask)
          : [];
        const remoteLists =
          Array.isArray(docSnap.data()?.lists) && docSnap.data().lists.length
            ? docSnap.data().lists.map(normalizeList)
            : defaultLists();
        applyCloudState(remote, remoteLists);
      },
      (err) => {
        console.warn("Cloud sync error:", err);
        setLoading(false);
        loadLocalTasks();
        render();
      }
    );
  } catch (e) {
    console.warn("Cloud sync unavailable, using local cache:", e);
    setLoading(false);
    loadLocalTasks();
    render();
  }
}

function handleAuthUser(user) {
  stopCloudSync();
  if (user) {
    state.user = { uid: user.uid, email: user.email || "" };
    updateAccountUi();
    // Cache first for offline, then replace with Firebase (source of truth)
    loadLocalTasks();
    render();
    startCloudSync(state.user).catch((e) => {
      console.warn(e);
      setLoading(false);
      loadLocalTasks();
      render();
    });
  } else {
    state.user = null;
    updateAccountUi();
    loadLocalTasks();
    setLoading(false);
    render();
  }
}

function syncWhenOnline() {
  if (!navigator.onLine || !state.user) return;
  startCloudSync(state.user).catch((e) => console.warn(e));
}

// —— Normalize / ids ——

function normalizeSubtask(s) {
  const title = String(s?.title || "").trim();
  let id = s?.id != null && String(s.id) ? String(s.id) : "";
  if (!id && title) {
    id = "st_" + title.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 48);
  }
  if (!id) id = uid();
  return {
    id,
    title,
    done: Boolean(s?.done),
  };
}

function normalizeTask(t) {
  const id = String(t?.id || uid());
  const subtasks = Array.isArray(t?.subtasks) ? t.subtasks.map(normalizeSubtask) : [];
  const listId = String(t?.listId || DEFAULT_LIST_ID);
  return {
    id,
    listId,
    title: String(t?.title || "").trim() || "Untitled",
    due: t?.due ? String(t.due) : null,
    done: Boolean(t?.done),
    progress: Math.max(0, Number(t?.progress) || 0),
    total: Math.max(0, Number(t?.total) || 0),
    notes: String(t?.notes || ""),
    subtasks,
    updatedAt: t?.updatedAt ? String(t.updatedAt) : "",
  };
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// —— Date helpers ——

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function parseDue(due) {
  if (!due) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(due)) {
    const [y, m, day] = due.split("-").map(Number);
    return new Date(y, m - 1, day);
  }
  const d = new Date(due);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDue(due) {
  const d = parseDue(due);
  if (!d) return null;
  const days = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  let s = `${days[d.getDay()]}, ${d.getDate()} ${months[d.getMonth()]}`;
  const hasTime = due.includes("T") && !due.endsWith("T00:00") && due.length > 10;
  if (hasTime) {
    let h = d.getHours();
    const min = String(d.getMinutes()).padStart(2, "0");
    const ampm = h >= 12 ? "pm" : "am";
    h = h % 12 || 12;
    s += ` ${String(h).padStart(2, "0")}:${min} ${ampm}`;
  }
  return s;
}

function addSevenDaysToDateFieldAndSave() {
  const dateEl = document.getElementById("field-date");
  let base;
  if (dateEl.value && /^\d{4}-\d{2}-\d{2}$/.test(dateEl.value)) {
    const [y, m, day] = dateEl.value.split("-").map(Number);
    base = new Date(y, m - 1, day);
  } else {
    base = new Date();
  }
  base.setDate(base.getDate() + 7);
  dateEl.value = formatLocalDate(base);
  saveFromForm(new Event("submit", { cancelable: true }));
}

function formatLocalDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatLocalDateTime(d) {
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${formatLocalDate(d)}T${h}:${min}`;
}

/** Add one calendar day; keep time if present. No due → tomorrow (date only). */
function addOneDayToDue(due) {
  if (!due) {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return formatLocalDate(d);
  }
  const keepTime = due.includes("T") && due.length > 10;
  const d = parseDue(due);
  if (!d) {
    const n = new Date();
    n.setDate(n.getDate() + 1);
    return formatLocalDate(n);
  }
  d.setDate(d.getDate() + 1);
  if (keepTime) {
    const timePart = due.split("T")[1].slice(0, 5);
    return `${formatLocalDate(d)}T${timePart}`;
  }
  return formatLocalDate(d);
}

function deferTaskOneDay(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t || t.done) return;
  t.due = addOneDayToDue(t.due);
  t.updatedAt = nowIso();
  saveTasks();
  render();
}

function setTaskDueToNow(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t || t.done) return;
  t.due = formatLocalDateTime(new Date());
  t.updatedAt = nowIso();
  saveTasks();
  render();
}

function isOverdue(task) {
  if (task.done || !task.due) return false;
  const d = parseDue(task.due);
  if (!d) return false;
  return d < startOfDay(new Date()) || (task.due.includes("T") && d < new Date());
}

function isToday(task) {
  if (!task.due || task.done) return false;
  const d = parseDue(task.due);
  if (!d) return false;
  return startOfDay(d).getTime() === startOfDay(new Date()).getTime();
}

function sectionFor(task) {
  if (task.done) return "Completed";
  if (isOverdue(task)) return "Overdue";
  if (isToday(task)) return "Today";
  if (task.due) return "Upcoming";
  return "No date";
}

const SECTION_ORDER = ["No date", "Overdue", "Today", "Upcoming", "Completed"];

// —— Filtering / sorting ——

function tasksInActiveList() {
  ensureActiveList();
  return state.tasks.filter((t) => (t.listId || DEFAULT_LIST_ID) === state.activeListId);
}

function visibleTasks() {
  let list = tasksInActiveList();
  if (state.filter === "active") list = list.filter((t) => !t.done);
  if (state.filter === "done") list = list.filter((t) => t.done);
  if (state.query) {
    const q = state.query.toLowerCase();
    list = list.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.notes.toLowerCase().includes(q) ||
        (t.subtasks || []).some((s) => s.title.toLowerCase().includes(q))
    );
  }
  list.sort((a, b) => {
    const da = parseDue(a.due)?.getTime() ?? Infinity;
    const db = parseDue(b.due)?.getTime() ?? Infinity;
    if (da !== db) return da - db;
    return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
  });
  return list;
}

// —— Icons ——

const ICONS = {
  empty:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg>',
  checked:
    '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>',
  cal: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10zm0-12H5V6h14v2z"/></svg>',
  subdone:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="10.5" cy="12" r="9.2"/><path d="M6.5 12.4 10.2 16 21 5.5"/></svg>',
  chev: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>',
};

// —— Render ——

function renderDrawerLists() {
  const host = document.getElementById("drawer-lists");
  if (!host) return;
  ensureActiveList();
  host.innerHTML = state.lists
    .map((l) => {
      const count = state.tasks.filter((t) => (t.listId || DEFAULT_LIST_ID) === l.id).length;
      const active = l.id === state.activeListId ? " active" : "";
      return `<button type="button" class="drawer-item drawer-subitem${active}" data-list-id="${escapeHtml(l.id)}">${escapeHtml(l.name)} (${count})</button>`;
    })
    .join("");
}

function setActiveList(listId) {
  if (!state.lists.some((l) => l.id === listId)) return;
  state.activeListId = listId;
  saveTasks();
  render();
}

function openListDialog() {
  const dlg = document.getElementById("list-dialog");
  const input = document.getElementById("list-name");
  if (!dlg || !input) return;
  input.value = "";
  closeDrawer();
  if (typeof dlg.showModal === "function") dlg.showModal();
  else dlg.setAttribute("open", "");
  setTimeout(() => input.focus(), 50);
}

function closeListDialog() {
  const dlg = document.getElementById("list-dialog");
  if (!dlg) return;
  if (typeof dlg.close === "function") dlg.close();
  else dlg.removeAttribute("open");
}

function submitListForm(e) {
  e.preventDefault();
  const input = document.getElementById("list-name");
  const trimmed = (input?.value || "").trim();
  if (!trimmed) return;
  const list = normalizeList({ id: uid(), name: trimmed });
  state.lists.push(list);
  state.activeListId = list.id;
  saveTasks();
  closeListDialog();
  render();
}

function render() {
  const listEl = document.getElementById("task-list");
  const emptyEl = document.getElementById("empty-state");
  const tasks = visibleTasks();
  const titleEl = document.querySelector(".app-title");
  if (titleEl) titleEl.textContent = activeList().name;
  renderDrawerLists();

  if (!tasks.length) {
    listEl.innerHTML = "";
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;

  /** @type {Record<string, Task[]>} */
  const groups = {};
  for (const t of tasks) {
    const s = sectionFor(t);
    (groups[s] ||= []).push(t);
  }

  let html = "";
  for (const section of SECTION_ORDER) {
    const items = groups[section];
    if (!items?.length) continue;
    html += `<h2 class="section-label">${section}</h2>`;
    for (const t of items) html += renderCard(t, section === "Overdue");
  }
  listEl.innerHTML = html;
}

function renderCard(t, forceOverdueStyle) {
  const dueLabel = formatDue(t.due);
  const overdue = forceOverdueStyle || isOverdue(t);

  let meta = "";
  if (dueLabel) {
    meta += `<span class="meta-item${overdue && !t.done ? " overdue" : ""}">${ICONS.cal}${dueLabel}</span>`;
  }
  let subCount = "";
  if (t.subtasks?.length) {
    const doneN = t.subtasks.filter((s) => s.done).length;
    subCount = `<span class="meta-subcount">${ICONS.subdone}${doneN}/${t.subtasks.length}</span>`;
  }

  return `
    <div class="task-card-wrap" data-id="${t.id}">
      <div class="task-swipe-label swipe-now">Set to now</div>
      <div class="task-swipe-label swipe-delete">Delete</div>
      <article class="task-card" data-id="${t.id}">
        <div class="task-row${t.done ? " done" : ""}">
          <button type="button" class="check${t.done ? " checked" : ""}" data-action="toggle" aria-label="Mark complete">
            ${t.done ? ICONS.checked : ICONS.empty}
          </button>
          <div class="task-body" data-action="edit">
            <p class="task-title">${escapeHtml(t.title)}</p>
            ${
              meta || subCount
                ? `<div class="task-meta">${meta}${subCount}</div>`
                : ""
            }
          </div>
          <button type="button" class="defer-btn" data-action="defer" aria-label="Postpone one day">${ICONS.chev}</button>
        </div>
      </article>
    </div>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// —— CRUD ——

function autosizeTitleField() {
  const el = document.getElementById("field-title");
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.max(el.scrollHeight, 44)}px`;
}

function readDialogSubtasksFromDom(keepEmpty = false) {
  const list = document.getElementById("subtask-list");
  if (!list) return state.dialogSubtasks.slice();
  /** @type {Subtask[]} */
  const out = [];
  list.querySelectorAll(".subtask-item").forEach((li) => {
    const id = li.getAttribute("data-id") || uid();
    const input = /** @type {HTMLInputElement|null} */ (li.querySelector(".subtask-title"));
    const bullet = li.querySelector(".subtask-bullet");
    const title = (input?.value || "").trim();
    const done = bullet?.classList.contains("done") || false;
    if (title || keepEmpty) out.push({ id, title: input?.value || "", done });
  });
  return out;
}

function renderSubtaskList() {
  const list = document.getElementById("subtask-list");
  const empty = document.getElementById("subtasks-empty");
  if (!list) return;
  list.innerHTML = state.dialogSubtasks
    .map(
      (s) => `
    <li class="subtask-item" data-id="${escapeHtml(s.id)}">
      <button type="button" class="subtask-bullet${s.done ? " done" : ""}" data-action="toggle-sub" aria-label="Toggle sub task">
        <span class="subtask-dot"></span>
      </button>
      <input type="text" class="subtask-title" maxlength="300" value="${escapeHtml(s.title)}" placeholder="Sub task…" title="Drag to reorder" />
      <button type="button" class="subtask-remove" data-action="remove-sub" aria-label="Remove sub task">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
      </button>
    </li>`
    )
    .join("");
  if (empty) empty.hidden = state.dialogSubtasks.length > 0;
  bindSubtaskDragHandles();
}

function addDialogSubtask() {
  state.dialogSubtasks = readDialogSubtasksFromDom(true).map(normalizeSubtask);
  state.dialogSubtasks.push({ id: uid(), title: "", done: false });
  renderSubtaskList();
  const inputs = document.querySelectorAll("#subtask-list .subtask-title");
  const last = /** @type {HTMLInputElement|undefined} */ (inputs[inputs.length - 1]);
  if (last) last.focus();
}

/** @type {{ item: HTMLElement, pointerId: number, startX: number, startY: number, started: boolean, handle: HTMLElement } | null} */
let subDrag = null;
const SUBTASK_DRAG_THRESHOLD = 8;

function bindSubtaskDragHandles() {
  const list = document.getElementById("subtask-list");
  if (!list) return;
  list.querySelectorAll(".subtask-title").forEach((handle) => {
    const el = /** @type {HTMLElement} */ (handle);
    el.addEventListener("pointerdown", (e) => {
      const ev = /** @type {PointerEvent} */ (e);
      if (ev.button != null && ev.button !== 0) return;
      const item = /** @type {HTMLElement} */ (el.closest(".subtask-item"));
      if (!item) return;
      subDrag = {
        item,
        pointerId: ev.pointerId,
        startX: ev.clientX,
        startY: ev.clientY,
        started: false,
        handle: el,
      };
    });
    el.addEventListener("pointermove", onSubtaskPointerMove);
    el.addEventListener("pointerup", onSubtaskPointerUp);
    el.addEventListener("pointercancel", onSubtaskPointerUp);
  });
}

function onSubtaskPointerMove(e) {
  if (!subDrag) return;
  const list = document.getElementById("subtask-list");
  if (!list) return;
  const ev = /** @type {PointerEvent} */ (e);
  if (ev.pointerId !== subDrag.pointerId) return;

  if (!subDrag.started) {
    const dx = ev.clientX - subDrag.startX;
    const dy = ev.clientY - subDrag.startY;
    if (Math.hypot(dx, dy) < SUBTASK_DRAG_THRESHOLD) return;
    subDrag.started = true;
    subDrag.item.classList.add("dragging");
    subDrag.handle.blur();
    try {
      subDrag.handle.setPointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }
    ev.preventDefault();
  }

  const el = document.elementFromPoint(ev.clientX, ev.clientY);
  const over = el?.closest(".subtask-item");
  if (!over || over === subDrag.item || !list.contains(over)) return;
  const rect = over.getBoundingClientRect();
  const before = ev.clientY < rect.top + rect.height / 2;
  list.insertBefore(subDrag.item, before ? over : over.nextSibling);
}

function onSubtaskPointerUp(e) {
  if (!subDrag) return;
  const ev = /** @type {PointerEvent} */ (e);
  if (ev.pointerId !== subDrag.pointerId) return;
  const wasDragging = subDrag.started;
  subDrag.item.classList.remove("dragging");
  subDrag = null;
  if (wasDragging) {
    state.dialogSubtasks = readDialogSubtasksFromDom(true).map(normalizeSubtask);
  }
}

function lockTaskEditorHeight() {
  const dlg = document.getElementById("task-dialog");
  if (!dlg) return;
  const h = Math.round(window.visualViewport?.height || window.innerHeight);
  dlg.style.height = `${h}px`;
  dlg.style.maxHeight = `${h}px`;
}

function unlockTaskEditorHeight() {
  const dlg = document.getElementById("task-dialog");
  if (!dlg) return;
  dlg.style.height = "";
  dlg.style.maxHeight = "";
}

function openDialog(task) {
  const dlg = document.getElementById("task-dialog");
  const deleteBtn = document.getElementById("btn-dialog-delete");
  const deleteSpacer = document.getElementById("btn-dialog-delete-spacer");
  document.getElementById("dialog-title").textContent = task ? "Edit Task" : "New Task";
  document.getElementById("field-id").value = task?.id || "";
  document.getElementById("field-title").value = task?.title || "";
  deleteBtn.hidden = !task;
  if (deleteSpacer) deleteSpacer.hidden = !!task;

  state.dialogSubtasks = (task?.subtasks || []).map(normalizeSubtask);
  renderSubtaskList();

  let date = "";
  let time = "";
  if (task?.due) {
    if (task.due.includes("T")) {
      const [d, t] = task.due.split("T");
      date = d;
      time = (t || "").slice(0, 5);
    } else {
      date = task.due;
    }
  }
  document.getElementById("field-date").value = date;
  document.getElementById("field-time").value = time;
  state.editingId = task?.id || null;
  lockTaskEditorHeight();
  dlg.showModal();
  autosizeTitleField();
  document.getElementById("field-title").focus();
}

function saveFromForm(e) {
  e.preventDefault();
  const id = document.getElementById("field-id").value || uid();
  const title = document.getElementById("field-title").value.trim();
  if (!title) return;
  const date = document.getElementById("field-date").value;
  const time = document.getElementById("field-time").value;
  let due = null;
  if (date && time) due = `${date}T${time}`;
  else if (date) due = date;

  const existing = state.tasks.find((t) => t.id === id);
  const task = normalizeTask({
    id,
    listId: existing?.listId || state.activeListId || DEFAULT_LIST_ID,
    title,
    due,
    done: existing?.done || false,
    progress: existing?.progress ?? 0,
    total: existing?.total ?? 0,
    notes: existing?.notes || "",
    subtasks: readDialogSubtasksFromDom(false),
    updatedAt: nowIso(),
  });

  const idx = state.tasks.findIndex((t) => t.id === id);
  if (idx >= 0) state.tasks[idx] = task;
  else state.tasks.unshift(task);

  saveTasks();
  unlockTaskEditorHeight();
  document.getElementById("task-dialog").close();
  render();
}

function toggleDone(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  t.done = !t.done;
  t.updatedAt = nowIso();
  saveTasks();
  render();
}

function deleteTask(id) {
  if (!confirm("Delete this task?")) return;
  state.tasks = state.tasks.filter((t) => t.id !== id);
  saveTasks();
  render();
}

// —— Auth UI ——

/** @type {"signin" | "signup"} */
let authMode = "signin";

function setAuthMode(mode) {
  authMode = mode;
  const isSignUp = mode === "signup";
  document.getElementById("auth-dialog-title").textContent = isSignUp ? "Sign up" : "Sign in";
  document.getElementById("auth-hint").textContent = isSignUp
    ? "Create an account to sync tasks across your devices."
    : "Use the same email on any device to sync your tasks.";
  document.getElementById("btn-auth-switch").textContent = isSignUp ? "Sign in" : "Sign up";
  document.getElementById("btn-auth-submit").textContent = isSignUp ? "Sign up" : "Sign in";
  document.getElementById("auth-password").autocomplete = isSignUp ? "new-password" : "current-password";
  document.getElementById("auth-error").hidden = true;
  document.getElementById("auth-error").textContent = "";
}

function openAuthDialog() {
  document.getElementById("auth-email").value = "";
  document.getElementById("auth-password").value = "";
  const pw = document.getElementById("auth-password");
  const toggle = document.getElementById("btn-password-toggle");
  pw.type = "password";
  toggle.textContent = "Show";
  toggle.setAttribute("aria-label", "Show password");
  toggle.setAttribute("aria-pressed", "false");
  setAuthMode("signin");
  const dlg = document.getElementById("auth-dialog");
  if (typeof dlg.showModal === "function") {
    dlg.showModal();
  } else {
    dlg.setAttribute("open", "");
  }
  document.getElementById("auth-email").focus();
}

function closeAuthDialog() {
  const dlg = document.getElementById("auth-dialog");
  if (typeof dlg.close === "function") {
    dlg.close();
  } else {
    dlg.removeAttribute("open");
  }
}

function authErrorMessage(err) {
  const code = err?.code || "";
  if (code === "auth/email-already-in-use") return "That email already has an account. Sign in instead.";
  if (code === "auth/invalid-email") return "Enter a valid email address.";
  if (code === "auth/weak-password") return "Password must be at least 6 characters.";
  if (code === "auth/user-not-found" || code === "auth/wrong-password" || code === "auth/invalid-credential")
    return "Wrong email or password.";
  if (code === "auth/too-many-requests") return "Too many attempts. Try again later.";
  if (code === "auth/network-request-failed") return "Network error. Check your connection.";
  return err?.message || "Something went wrong.";
}

function showAuthError(err) {
  const el = document.getElementById("auth-error");
  el.textContent = authErrorMessage(err);
  el.hidden = false;
}

function requireFirebaseReady() {
  if (!isFirebaseConfigured() || !auth) {
    showAuthError({
      message:
        "Cloud sync is not set up yet. Add your Firebase config to firebase-config.js (see README), then try again.",
    });
    return false;
  }
  return true;
}

async function doSignIn(e) {
  if (e) e.preventDefault();
  if (!requireFirebaseReady()) return;
  const email = document.getElementById("auth-email").value.trim();
  const password = document.getElementById("auth-password").value;
  try {
    await signInWithEmailAndPassword(auth, email, password);
    closeAuthDialog();
    closeDrawer();
  } catch (err) {
    showAuthError(err);
  }
}

async function doSignUp() {
  if (!requireFirebaseReady()) return;
  const email = document.getElementById("auth-email").value.trim();
  const password = document.getElementById("auth-password").value;
  if (!email || password.length < 6) {
    showAuthError({ message: "Enter email and a password of at least 6 characters." });
    return;
  }
  try {
    await createUserWithEmailAndPassword(auth, email, password);
    closeAuthDialog();
    closeDrawer();
  } catch (err) {
    showAuthError(err);
  }
}

async function submitAuthForm(e) {
  e.preventDefault();
  if (authMode === "signup") await doSignUp();
  else await doSignIn();
}

async function doSignOut() {
  if (!auth) {
    closeDrawer();
    return;
  }
  try {
    await signOut(auth);
    closeDrawer();
  } catch (err) {
    alert("Could not sign out: " + (err.message || err));
  }
}

// —— UI chrome ——

function openDrawer() {
  document.getElementById("drawer").classList.add("open");
  document.getElementById("drawer").setAttribute("aria-hidden", "false");
  document.getElementById("drawer-backdrop").hidden = false;
}

function closeDrawer() {
  document.getElementById("drawer").classList.remove("open");
  document.getElementById("drawer").setAttribute("aria-hidden", "true");
  document.getElementById("drawer-backdrop").hidden = true;
}

function openMenu() {
  document.getElementById("overflow-menu").hidden = false;
  document.getElementById("menu-backdrop").hidden = false;
}

function closeMenu() {
  document.getElementById("overflow-menu").hidden = true;
  document.getElementById("menu-backdrop").hidden = true;
}

function showSearch(show) {
  document.getElementById("search-bar").hidden = !show;
  if (show) {
    document.getElementById("search-input").focus();
  } else {
    state.query = "";
    document.getElementById("search-input").value = "";
    render();
  }
}

// —— Events ——

function bindEvents() {
  document.getElementById("btn-menu").addEventListener("click", openDrawer);
  document.getElementById("drawer-backdrop").addEventListener("click", closeDrawer);
  document.getElementById("btn-search").addEventListener("click", () => showSearch(true));
  document.getElementById("btn-search-close").addEventListener("click", () => showSearch(false));
  document.getElementById("search-input").addEventListener("input", (e) => {
    state.query = e.target.value;
    render();
  });

  document.getElementById("btn-more").addEventListener("click", openMenu);
  document.getElementById("menu-backdrop").addEventListener("click", closeMenu);
  document.getElementById("menu-clear-done").addEventListener("click", () => {
    closeMenu();
    const n = tasksInActiveList().filter((t) => t.done).length;
    if (!n) return;
    if (!confirm(`Remove ${n} completed task(s)?`)) return;
    state.tasks = state.tasks.filter(
      (t) => (t.listId || DEFAULT_LIST_ID) !== state.activeListId || !t.done
    );
    saveTasks();
    render();
  });

  document.getElementById("btn-sign-in").addEventListener("click", () => {
    closeDrawer();
    openAuthDialog();
  });
  document.getElementById("btn-sign-out").addEventListener("click", doSignOut);
  document.getElementById("btn-auth-cancel").addEventListener("click", closeAuthDialog);
  document.getElementById("btn-auth-switch").addEventListener("click", () => {
    setAuthMode(authMode === "signin" ? "signup" : "signin");
  });
  document.getElementById("btn-password-toggle").addEventListener("click", () => {
    const input = document.getElementById("auth-password");
    const btn = document.getElementById("btn-password-toggle");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    btn.textContent = show ? "Hide" : "Show";
    btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
    btn.setAttribute("aria-pressed", show ? "true" : "false");
  });
  document.getElementById("auth-form").addEventListener("submit", submitAuthForm);

  document.getElementById("btn-add-list").addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openListDialog();
  });
  document.getElementById("btn-list-cancel").addEventListener("click", closeListDialog);
  document.getElementById("list-form").addEventListener("submit", submitListForm);
  document.getElementById("drawer-lists").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-list-id]");
    if (!btn) return;
    setActiveList(btn.getAttribute("data-list-id"));
    closeDrawer();
  });

  document.getElementById("btn-add").addEventListener("click", () => openDialog(null));
  document.getElementById("btn-add-fab").addEventListener("click", () => openDialog(null));
  document.getElementById("btn-dialog-close").addEventListener("click", () => {
    unlockTaskEditorHeight();
    document.getElementById("task-dialog").close();
  });
  document.getElementById("btn-dialog-delete").addEventListener("click", () => {
    const id = document.getElementById("field-id").value;
    if (!id) return;
    unlockTaskEditorHeight();
    document.getElementById("task-dialog").close();
    deleteTask(id);
  });
  document.getElementById("task-dialog").addEventListener("close", unlockTaskEditorHeight);
  document.getElementById("field-title").addEventListener("input", autosizeTitleField);
  document.getElementById("btn-add-subtask").addEventListener("click", addDialogSubtask);
  document.getElementById("btn-plus-7days").addEventListener("click", addSevenDaysToDateFieldAndSave);
  ["field-date", "field-time"].forEach((id) => {
    const input = document.getElementById(id);
    if (!input) return;
    const openPicker = () => {
      if (typeof input.showPicker === "function") {
        try {
          input.showPicker();
        } catch {
          /* ignore */
        }
      }
    };
    input.addEventListener("click", openPicker);
    input.closest(".editor-field-row")?.querySelector(".editor-field-icon")?.addEventListener("click", (e) => {
      e.preventDefault();
      input.focus();
      openPicker();
    });
  });
  document.getElementById("subtask-list").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.getAttribute("data-action");
    if (action === "toggle-sub") {
      e.preventDefault();
      btn.classList.toggle("done");
      return;
    }
    if (action === "remove-sub") {
      e.preventDefault();
      const item = btn.closest(".subtask-item");
      if (!item) return;
      item.remove();
      state.dialogSubtasks = readDialogSubtasksFromDom(true).map(normalizeSubtask);
      const empty = document.getElementById("subtasks-empty");
      if (empty) empty.hidden = state.dialogSubtasks.length > 0;
    }
  });
  document.getElementById("task-form").addEventListener("submit", saveFromForm);

  const listEl = document.getElementById("task-list");
  listEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    const card = e.target.closest(".task-card");
    if (!card) return;
    const id = card.getAttribute("data-id");
    const action = btn?.getAttribute("data-action");
    if (!action) return;
    e.stopPropagation();
    if (action === "toggle") toggleDone(id);
    else if (action === "defer") deferTaskOneDay(id);
    else if (action === "edit") {
      const t = state.tasks.find((x) => x.id === id);
      if (t) openDialog(t);
    }
  });

  bindSwipe(listEl);
}

/** Swipe right → set due to now. Swipe left → delete (with confirm). */
function bindSwipe(listEl) {
  const THRESHOLD = 72;
  /** @type {{ wrap: HTMLElement, card: HTMLElement, id: string, x0: number, y0: number, dx: number, active: boolean } | null} */
  let gesture = null;

  function clearSwipeClasses(wrap) {
    wrap?.classList.remove("swiping-right", "swiping-left");
  }

  function resetCard(card, wrap) {
    card.style.transition = "transform 0.2s ease";
    card.style.transform = "";
    clearSwipeClasses(wrap);
  }

  listEl.addEventListener(
    "touchstart",
    (e) => {
      const card = e.target.closest(".task-card");
      if (!card || e.target.closest("[data-action='toggle'], [data-action='defer']")) {
        gesture = null;
        return;
      }
      const wrap = card.closest(".task-card-wrap");
      if (!wrap) return;
      const t = e.changedTouches[0];
      gesture = {
        wrap,
        card,
        id: card.getAttribute("data-id") || "",
        x0: t.clientX,
        y0: t.clientY,
        dx: 0,
        active: false,
      };
      card.style.transition = "none";
    },
    { passive: true }
  );

  listEl.addEventListener(
    "touchmove",
    (e) => {
      if (!gesture) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - gesture.x0;
      const dy = t.clientY - gesture.y0;
      if (!gesture.active) {
        if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 8) {
          gesture = null;
          return;
        }
        if (Math.abs(dx) > 10) gesture.active = true;
        else return;
      }
      gesture.dx = dx;
      const pull = Math.max(-120, Math.min(120, dx));
      gesture.card.style.transform = `translateX(${pull}px)`;
      clearSwipeClasses(gesture.wrap);
      if (pull > 24) gesture.wrap.classList.add("swiping-right");
      else if (pull < -24) gesture.wrap.classList.add("swiping-left");
    },
    { passive: true }
  );

  function endSwipe() {
    if (!gesture) return;
    const { card, wrap, id, dx, active } = gesture;
    gesture = null;
    if (active && dx >= THRESHOLD) {
      resetCard(card, wrap);
      setTaskDueToNow(id);
      return;
    }
    if (active && dx <= -THRESHOLD) {
      resetCard(card, wrap);
      deleteTask(id);
      return;
    }
    resetCard(card, wrap);
  }

  listEl.addEventListener("touchend", endSwipe, { passive: true });
  listEl.addEventListener("touchcancel", endSwipe, { passive: true });
}

// —— Boot ——

bindEvents();
updateAccountUi();
// Show local tasks immediately (works offline even while signed in)
loadLocalTasks();
render();

if (initFirebase() && auth) {
  setLoading(true, "Syncing tasks…");
  onAuthStateChanged(auth, (user) => {
    handleAuthUser(user);
  });
  window.addEventListener("online", syncWhenOnline);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      maybeDailyReplicaCheck();
      if (navigator.onLine && state.user) syncWhenOnline();
    }
  });
} else {
  setLoading(false);
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch((err) => {
      console.warn("Service worker registration failed:", err);
    });
  });
}
