/**
 * Personal Tasks — PWA
 * Guest: localStorage. Signed in: Firestore sync per email.
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
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
const ALL_LISTS_ID = "__all__";

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
  const btnReplace = document.getElementById("btn-replace-from-firebase");
  if (state.user) {
    sub.textContent = state.user.email || "Signed in";
    btnIn.hidden = true;
    btnOut.hidden = false;
    if (btnReplace) btnReplace.hidden = false;
  } else {
    sub.textContent = "Guest — stored on this device";
    btnIn.hidden = false;
    btnOut.hidden = true;
    if (btnReplace) btnReplace.hidden = true;
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

/**
 * Build the lists the UI should show. Tasks are not moved between lists.
 * If Firebase is missing list metadata, recreate lists from each task's listId
 * and restore names from the local cache when possible.
 */
function resolveListsForAccount(cloudLists, tasks, localLists) {
  const cloud = Array.isArray(cloudLists) ? cloudLists.map(normalizeList) : [];
  const local = Array.isArray(localLists) ? localLists.map(normalizeList) : [];
  const nameHints = new Map(local.map((l) => [l.id, l.name]));
  for (const l of cloud) {
    if (!nameHints.has(l.id)) nameHints.set(l.id, l.name);
  }

  // Prefer cloud list defs when present; otherwise recover from local cache
  const base = cloud.length ? cloud : local.length ? local : defaultLists();
  const byId = new Map();
  const order = [];
  for (const raw of base) {
    const n = normalizeList(raw);
    if (byId.has(n.id)) continue;
    byId.set(n.id, n);
    order.push(n.id);
  }
  if (!byId.has(DEFAULT_LIST_ID)) {
    byId.set(DEFAULT_LIST_ID, { id: DEFAULT_LIST_ID, name: DEFAULT_LIST_NAME });
    order.unshift(DEFAULT_LIST_ID);
  }

  // Recreate any list that tasks still belong to
  for (const t of tasks || []) {
    const id = String(t?.listId || DEFAULT_LIST_ID);
    if (id === ALL_LISTS_ID || byId.has(id)) continue;
    byId.set(id, { id, name: nameHints.get(id) || "Untitled list" });
    order.push(id);
  }

  for (const id of order) {
    const hint = nameHints.get(id);
    const cur = byId.get(id);
    if (hint && cur && cur.name === "Untitled list") {
      byId.set(id, { id, name: hint });
    }
  }

  return order.map((id) => byId.get(id));
}

function isAllListsView() {
  return state.activeListId === ALL_LISTS_ID;
}

function ensureActiveList() {
  if (!state.lists.length) state.lists = defaultLists();
  if (isAllListsView()) return;
  if (!state.lists.some((l) => l.id === state.activeListId)) {
    state.activeListId = state.lists[0].id;
  }
}

function activeList() {
  ensureActiveList();
  if (isAllListsView()) return { id: ALL_LISTS_ID, name: "All tasks" };
  return state.lists.find((l) => l.id === state.activeListId) || state.lists[0];
}

function defaultListIdForNewTask() {
  // New tasks always belong to the default "Task list"
  if (!state.lists.some((l) => l.id === DEFAULT_LIST_ID)) {
    state.lists.unshift({ id: DEFAULT_LIST_ID, name: DEFAULT_LIST_NAME });
  }
  return DEFAULT_LIST_ID;
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
    if (activeListId !== ALL_LISTS_ID && !lists.some((l) => l.id === activeListId)) {
      activeListId = lists[0].id;
    }
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
    state.tasks = data.tasks;
    state.lists = resolveListsForAccount(data.lists, data.tasks, data.lists);
    state.activeListId = data.activeListId;
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

/**
 * Explicit restore only: copy Firebase → local.
 * Normal sync never does this; local is always the source of truth.
 */
function applyFirebaseToLocal(cloudTasks, cloudLists) {
  applyingRemote = true;
  const prevActive = state.activeListId;
  const tasks = (cloudTasks || []).map(normalizeTask);
  state.tasks = tasks;
  state.lists = resolveListsForAccount(cloudLists, tasks, cloudLists);
  if (prevActive === ALL_LISTS_ID) {
    state.activeListId = ALL_LISTS_ID;
  } else if (prevActive && state.lists.some((l) => l.id === prevActive)) {
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

/** Push current local state to Firebase (backup). Does not read cloud into local. */
async function pushLocalToFirebase() {
  if (!state.user || !db || !navigator.onLine) return;
  state.tasks = state.tasks.map(normalizeTask);
  state.lists = state.lists.map(normalizeList);
  ensureActiveList();
  writeLocalReplica();
  await setDoc(
    userDocRef(state.user.uid),
    {
      tasks: state.tasks,
      lists: state.lists,
      updatedAt: nowIso(),
      email: state.user.email || "",
    },
    { merge: true }
  );
  markReplicaCheckedToday();
}

/**
 * Local is source of truth. On login / back online: keep local, backup to Firebase.
 * Never overwrite local from Firebase here.
 */
async function startCloudSync(user) {
  stopCloudSync();
  loadLocalTasks();
  render();
  setLoading(false);

  // Backup local → Firebase in the background (no blocking overlay)
  if (!navigator.onLine || !user) return;
  try {
    await pushLocalToFirebase();
  } catch (e) {
    console.warn("Cloud backup unavailable, keeping local:", e);
  }
}

/** Manual restore: Firebase → local (only via drawer button). */
async function replaceLocalWithFirebase() {
  if (!state.user || !db) {
    alert("Sign in first to restore from Firebase.");
    return;
  }
  if (!navigator.onLine) {
    alert("You need to be online to load Firebase data.");
    return;
  }
  if (
    !confirm(
      "Replace all local tasks and lists with Firebase data?\n\nYour local changes on this device will be overwritten."
    )
  ) {
    return;
  }
  closeDrawer();
  setLoading(true, "Loading from Firebase…");
  try {
    const snap = await getDoc(userDocRef(state.user.uid));
    const cloudTasks =
      snap.exists() && Array.isArray(snap.data()?.tasks)
        ? snap.data().tasks.map(normalizeTask)
        : [];
    const cloudLists =
      snap.exists() && Array.isArray(snap.data()?.lists)
        ? snap.data().lists.map(normalizeList)
        : [];
    applyFirebaseToLocal(cloudTasks, cloudLists);
  } catch (e) {
    console.warn(e);
    setLoading(false);
    alert("Could not load Firebase data. Try again.");
  }
}

function handleAuthUser(user) {
  stopCloudSync();
  if (user) {
    state.user = { uid: user.uid, email: user.email || "" };
    updateAccountUi();
    // Keep local; push it up as backup
    loadLocalTasks();
    render();
    startCloudSync(state.user).catch((e) => {
      console.warn(e);
      setLoading(false);
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
  if (isAllListsView()) return state.tasks.slice();
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

const LIST_DRAG_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M9 5h2v2H9V5zm4 0h2v2h-2V5zM9 11h2v2H9v-2zm4 0h2v2h-2v-2zM9 17h2v2H9v-2zm4 0h2v2h-2v-2z"/></svg>';

function renderDrawerLists() {
  const host = document.getElementById("drawer-lists");
  const allBtn = document.getElementById("nav-all-tasks");
  ensureActiveList();
  if (allBtn) {
    allBtn.textContent = `All tasks (${state.tasks.length})`;
    allBtn.classList.toggle("active", isAllListsView());
  }
  if (!host) return;
  host.innerHTML = state.lists
    .map((l) => {
      const count = state.tasks.filter((t) => (t.listId || DEFAULT_LIST_ID) === l.id).length;
      const active = !isAllListsView() && l.id === state.activeListId ? " active" : "";
      return `<div class="drawer-list-row" data-list-row-id="${escapeHtml(l.id)}">
      <button type="button" class="drawer-item drawer-subitem${active}" data-list-id="${escapeHtml(l.id)}">${escapeHtml(l.name)} (${count})</button>
      <button type="button" class="drawer-list-drag" data-action="drag-list" aria-label="Reorder list" title="Drag to reorder">${LIST_DRAG_ICON}</button>
    </div>`;
    })
    .join("");
  bindDrawerListDragHandles();
}

/** @type {{ row: HTMLElement, pointerId: number } | null} */
let listDrag = null;

function bindDrawerListDragHandles() {
  const host = document.getElementById("drawer-lists");
  if (!host) return;
  host.querySelectorAll(".drawer-list-drag").forEach((handle) => {
    handle.addEventListener("pointerdown", (e) => {
      const ev = /** @type {PointerEvent} */ (e);
      if (ev.button != null && ev.button !== 0) return;
      const row = /** @type {HTMLElement} */ (handle.closest(".drawer-list-row"));
      if (!row) return;
      ev.preventDefault();
      ev.stopPropagation();
      listDrag = { row, pointerId: ev.pointerId };
      row.classList.add("dragging");
      try {
        handle.setPointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
    });
    handle.addEventListener("pointermove", onDrawerListPointerMove);
    handle.addEventListener("pointerup", onDrawerListPointerUp);
    handle.addEventListener("pointercancel", onDrawerListPointerUp);
  });
}

function onDrawerListPointerMove(e) {
  if (!listDrag) return;
  const host = document.getElementById("drawer-lists");
  if (!host) return;
  const ev = /** @type {PointerEvent} */ (e);
  if (ev.pointerId !== listDrag.pointerId) return;
  ev.preventDefault();
  const el = document.elementFromPoint(ev.clientX, ev.clientY);
  const over = el?.closest(".drawer-list-row");
  if (!over || over === listDrag.row || !host.contains(over)) return;
  const rect = over.getBoundingClientRect();
  const before = ev.clientY < rect.top + rect.height / 2;
  host.insertBefore(listDrag.row, before ? over : over.nextSibling);
}

function onDrawerListPointerUp(e) {
  if (!listDrag) return;
  const ev = /** @type {PointerEvent} */ (e);
  if (ev.pointerId !== listDrag.pointerId) return;
  listDrag.row.classList.remove("dragging");
  listDrag = null;
  const host = document.getElementById("drawer-lists");
  if (!host) return;
  const ids = [...host.querySelectorAll(".drawer-list-row")].map((r) => r.getAttribute("data-list-row-id"));
  const byId = new Map(state.lists.map((l) => [l.id, l]));
  const next = ids.map((id) => byId.get(id)).filter(Boolean);
  if (next.length === state.lists.length) {
    state.lists = next;
    saveTasks();
    renderDrawerLists();
  }
}

function setActiveList(listId) {
  if (listId === ALL_LISTS_ID) {
    state.activeListId = ALL_LISTS_ID;
    saveTasks();
    render();
    return;
  }
  if (!state.lists.some((l) => l.id === listId)) return;
  state.activeListId = listId;
  saveTasks();
  render();
}

function fitEditorListSelectWidth() {
  const select = /** @type {HTMLSelectElement|null} */ (document.getElementById("field-list-id"));
  if (!select) return;
  const label = select.selectedOptions[0]?.text || select.value || "";
  const canvas = fitEditorListSelectWidth._canvas || (fitEditorListSelectWidth._canvas = document.createElement("canvas"));
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const style = getComputedStyle(select);
  ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const textW = Math.ceil(ctx.measureText(label).width);
  // border-box: padding-right for the chevron must be included in width
  const chevronPad = 18;
  select.style.width = `${textW + chevronPad + 4}px`;
}

function fillEditorListSelect(selectedId) {
  const select = /** @type {HTMLSelectElement|null} */ (document.getElementById("field-list-id"));
  if (!select) return;
  const current = selectedId || defaultListIdForNewTask();
  select.innerHTML = state.lists
    .map((l) => {
      const sel = l.id === current ? " selected" : "";
      return `<option value="${escapeHtml(l.id)}"${sel}>${escapeHtml(l.name)}</option>`;
    })
    .join("");
  fitEditorListSelectWidth();
}

/** @type {string | null} null = create, else rename that list id */
let listDialogEditId = null;

function openListDialog(editId = null) {
  const dlg = document.getElementById("list-dialog");
  const input = document.getElementById("list-name");
  const titleEl = document.getElementById("list-dialog-title");
  const saveBtn = document.getElementById("btn-list-save");
  if (!dlg || !input) return;
  listDialogEditId = editId;
  const existing = editId ? state.lists.find((l) => l.id === editId) : null;
  input.value = existing?.name || "";
  if (titleEl) titleEl.textContent = existing ? "Rename list" : "New list";
  if (saveBtn) saveBtn.textContent = existing ? "Save" : "Create";
  closeDrawer();
  closeMenu();
  if (typeof dlg.showModal === "function") dlg.showModal();
  else dlg.setAttribute("open", "");
  setTimeout(() => {
    input.focus();
    input.select();
  }, 50);
}

function closeListDialog() {
  const dlg = document.getElementById("list-dialog");
  listDialogEditId = null;
  if (!dlg) return;
  if (typeof dlg.close === "function") dlg.close();
  else dlg.removeAttribute("open");
}

function submitListForm(e) {
  e.preventDefault();
  const input = document.getElementById("list-name");
  const trimmed = (input?.value || "").trim();
  if (!trimmed) return;
  if (listDialogEditId) {
    const list = state.lists.find((l) => l.id === listDialogEditId);
    if (!list) return;
    list.name = trimmed;
  } else {
    const list = normalizeList({ id: uid(), name: trimmed });
    state.lists.push(list);
    state.activeListId = list.id;
  }
  saveTasks();
  closeListDialog();
  render();
}

function deleteActiveList() {
  ensureActiveList();
  if (isAllListsView()) {
    alert("Switch to a list before deleting it.");
    return;
  }
  if (state.lists.length <= 1) {
    alert("You need at least one list.");
    return;
  }
  const list = activeList();
  const n = state.tasks.filter((t) => (t.listId || DEFAULT_LIST_ID) === list.id).length;
  const msg = n
    ? `Delete “${list.name}” and its ${n} task(s)?`
    : `Delete “${list.name}”?`;
  if (!confirm(msg)) return;
  const id = list.id;
  state.lists = state.lists.filter((l) => l.id !== id);
  state.tasks = state.tasks.filter((t) => (t.listId || DEFAULT_LIST_ID) !== id);
  state.activeListId = state.lists[0].id;
  saveTasks();
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
      <textarea class="subtask-title" maxlength="300" rows="1" readonly placeholder="Sub task…" title="Drag to reorder, tap to edit">${escapeHtml(s.title)}</textarea>
      <button type="button" class="subtask-remove" data-action="remove-sub" aria-label="Remove sub task">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
      </button>
    </li>`
    )
    .join("");
  if (empty) empty.hidden = state.dialogSubtasks.length > 0;
  list.querySelectorAll(".subtask-title").forEach((el) => {
    const ta = /** @type {HTMLTextAreaElement} */ (el);
    ta.addEventListener("input", () => autosizeSubtaskTitleHeight(ta));
    ta.addEventListener("blur", () => {
      ta.readOnly = true;
      ta.classList.remove("editing");
      autosizeSubtaskTitleHeight(ta);
    });
  });
  bindSubtaskDragHandles();
  // Measure after layout so wrap width is correct
  requestAnimationFrame(() => {
    list.querySelectorAll(".subtask-title").forEach((el) => {
      autosizeSubtaskTitleHeight(/** @type {HTMLTextAreaElement} */ (el));
    });
  });
}

function autosizeSubtaskTitleHeight(ta) {
  if (!ta) return;
  ta.style.height = "0px";
  ta.style.height = `${Math.max(ta.scrollHeight, 28)}px`;
}

function beginSubtaskEdit(ta) {
  if (!ta) return;
  ta.readOnly = false;
  ta.classList.add("editing");
  ta.focus();
  const len = ta.value.length;
  try {
    ta.setSelectionRange(len, len);
  } catch {
    /* ignore */
  }
}

function addDialogSubtask() {
  state.dialogSubtasks = readDialogSubtasksFromDom(true).map(normalizeSubtask);
  state.dialogSubtasks.push({ id: uid(), title: "", done: false });
  renderSubtaskList();
  const inputs = document.querySelectorAll("#subtask-list .subtask-title");
  const last = /** @type {HTMLTextAreaElement|undefined} */ (inputs[inputs.length - 1]);
  if (last) beginSubtaskEdit(last);
}

/** @type {{ item: HTMLElement, pointerId: number, startX: number, startY: number, started: boolean, handle: HTMLTextAreaElement } | null} */
let subDrag = null;
const SUBTASK_DRAG_THRESHOLD = 10;

function bindSubtaskDragHandles() {
  const list = document.getElementById("subtask-list");
  if (!list) return;
  list.querySelectorAll(".subtask-title").forEach((handle) => {
    const el = /** @type {HTMLTextAreaElement} */ (handle);

    el.addEventListener("selectstart", (e) => {
      if (el.readOnly) e.preventDefault();
    });

    el.addEventListener("pointerdown", (e) => {
      const ev = /** @type {PointerEvent} */ (e);
      if (ev.button != null && ev.button !== 0) return;
      // Already editing: allow normal caret / text selection, no drag
      if (!el.readOnly && document.activeElement === el) {
        subDrag = null;
        return;
      }
      const item = /** @type {HTMLElement} */ (el.closest(".subtask-item"));
      if (!item) return;
      // Stop browser text selection while deciding click vs drag
      ev.preventDefault();
      subDrag = {
        item,
        pointerId: ev.pointerId,
        startX: ev.clientX,
        startY: ev.clientY,
        started: false,
        handle: el,
      };
      try {
        el.setPointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
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
    subDrag.handle.readOnly = true;
    subDrag.handle.classList.remove("editing");
    subDrag.handle.blur();
    window.getSelection()?.removeAllRanges();
    ev.preventDefault();
  }

  ev.preventDefault();
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
  const handle = subDrag.handle;
  subDrag.item.classList.remove("dragging");
  subDrag = null;
  if (wasDragging) {
    state.dialogSubtasks = readDialogSubtasksFromDom(true).map(normalizeSubtask);
    window.getSelection()?.removeAllRanges();
    return;
  }
  // Tap → edit
  beginSubtaskEdit(handle);
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
  } else if (!task) {
    date = formatLocalDate(new Date());
  }
  document.getElementById("field-date").value = date;
  document.getElementById("field-time").value = time;
  fillEditorListSelect(task ? task.listId || DEFAULT_LIST_ID : defaultListIdForNewTask());
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
  const listSelect = /** @type {HTMLSelectElement|null} */ (document.getElementById("field-list-id"));
  const listId =
    listSelect?.value ||
    existing?.listId ||
    defaultListIdForNewTask() ||
    DEFAULT_LIST_ID;
  const task = normalizeTask({
    id,
    listId,
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

const SIGNUP_NOTIFY_EMAIL = "quratulainsiddique12@gmail.com";

/** @type {"signin" | "signup"} */
let authMode = "signin";

function setAuthMode(mode) {
  authMode = mode;
  const isRequest = mode === "signup";
  const pwWrap = document.getElementById("auth-password-wrap");
  const pw = document.getElementById("auth-password");
  document.getElementById("auth-dialog-title").textContent = isRequest ? "Request access" : "Sign in";
  document.getElementById("auth-hint").textContent = isRequest
    ? "New accounts are invite-only. Enter your email and the owner will be notified."
    : "Use the same email on any device to sync your tasks.";
  document.getElementById("btn-auth-switch").textContent = isRequest ? "Sign in" : "Request access";
  document.getElementById("btn-auth-submit").textContent = isRequest ? "Send request" : "Sign in";
  if (pwWrap) pwWrap.hidden = isRequest;
  if (pw) {
    pw.required = !isRequest;
    pw.autocomplete = "current-password";
  }
  const err = document.getElementById("auth-error");
  err.hidden = true;
  err.textContent = "";
  err.classList.remove("auth-success");
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

/** Notify owner instead of creating a Firebase account (invite-only). */
async function doRequestSignupAccess() {
  const email = document.getElementById("auth-email").value.trim();
  const errEl = document.getElementById("auth-error");
  const submitBtn = document.getElementById("btn-auth-submit");
  if (!email) {
    showAuthError({ message: "Enter your email address." });
    return;
  }
  errEl.hidden = true;
  errEl.classList.remove("auth-success");
  if (submitBtn) submitBtn.disabled = true;
  try {
    const res = await fetch(`https://formsubmit.co/ajax/${encodeURIComponent(SIGNUP_NOTIFY_EMAIL)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        _subject: `${email} wants to signup`,
        email,
        message: `${email} wants to sign up for TaskList.`,
      }),
    });
    if (!res.ok) throw new Error("Could not send request");
    errEl.textContent = "Request sent. The owner will contact you if access is granted.";
    errEl.classList.add("auth-success");
    errEl.hidden = false;
  } catch {
    // Fallback: open mail client so the request is still delivered
    const subject = encodeURIComponent(`${email} wants to signup`);
    const body = encodeURIComponent(`${email} wants to sign up for TaskList.`);
    window.location.href = `mailto:${SIGNUP_NOTIFY_EMAIL}?subject=${subject}&body=${body}`;
    errEl.textContent = "Opening your email app to send the request…";
    errEl.classList.add("auth-success");
    errEl.hidden = false;
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

async function submitAuthForm(e) {
  e.preventDefault();
  if (authMode === "signup") await doRequestSignupAccess();
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
  if (isAllListsView()) return;
  const renameBtn = document.getElementById("menu-rename-list");
  const deleteBtn = document.getElementById("menu-delete-list");
  if (renameBtn) renameBtn.hidden = false;
  if (deleteBtn) deleteBtn.hidden = false;
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
  document.getElementById("menu-rename-list").addEventListener("click", () => {
    closeMenu();
    if (isAllListsView()) return;
    openListDialog(state.activeListId);
  });
  document.getElementById("menu-delete-list").addEventListener("click", () => {
    closeMenu();
    deleteActiveList();
  });

  document.getElementById("btn-sign-in").addEventListener("click", () => {
    closeDrawer();
    openAuthDialog();
  });
  document.getElementById("btn-sign-out").addEventListener("click", doSignOut);
  document.getElementById("btn-replace-from-firebase")?.addEventListener("click", () => {
    replaceLocalWithFirebase();
  });
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
  document.querySelector(".drawer-nav")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-list-id]");
    if (!btn) return;
    setActiveList(btn.getAttribute("data-list-id"));
    closeDrawer();
  });
  document.getElementById("field-list-id")?.addEventListener("change", fitEditorListSelectWidth);
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

setLoading(false);
if (initFirebase() && auth) {
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
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch((err) => {
      console.warn("Service worker registration failed:", err);
    });
  });
}
