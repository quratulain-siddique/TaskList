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

/** @typedef {{ id: string, title: string, due: string|null, done: boolean, progress: number, total: number, notes: string }} Task */

const state = {
  tasks: /** @type {Task[]} */ ([]),
  filter: "all", // all | active | done
  query: "",
  editingId: null,
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

function writeLocalReplica(tasks) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
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
  writeLocalReplica(state.tasks);
  markReplicaCheckedToday();
}

/**
 * Account tasks win on the same id; local-only tasks are appended.
 */
function mergeTaskLists(cloudTasks, localTasks) {
  const byId = new Map();
  for (const t of cloudTasks) byId.set(t.id, normalizeTask(t));
  for (const t of localTasks) {
    const n = normalizeTask(t);
    if (!byId.has(n.id)) byId.set(n.id, n);
  }
  return Array.from(byId.values());
}

async function saveTasksCloud() {
  if (!state.user || !db || applyingRemote) return;
  try {
    await setDoc(
      userDocRef(state.user.uid),
      {
        tasks: state.tasks,
        updatedAt: new Date().toISOString(),
        email: state.user.email,
      },
      { merge: true }
    );
  } catch (e) {
    console.warn("Cloud save failed:", e);
    alert("Could not sync to the cloud. Check your connection.");
  }
}

/**
 * Persist: always write localStorage. When signed in, also write Firestore.
 * Local stays an account replica so logout still has the synced list.
 */
function saveTasks() {
  writeLocalReplica(state.tasks);
  if (state.user) {
    markReplicaCheckedToday();
    saveTasksCloud();
  }
}

function loadLocalTasks() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      state.tasks = [];
      return;
    }
    const parsed = JSON.parse(raw);
    state.tasks = Array.isArray(parsed) ? parsed.map(normalizeTask) : [];
  } catch {
    state.tasks = [];
  }
}

function readLocalTasksSnapshot() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(normalizeTask) : [];
  } catch {
    return [];
  }
}

async function startCloudSync(user) {
  stopCloudSync();
  const ref = userDocRef(user.uid);
  const snap = await getDoc(ref);
  const localGuest = readLocalTasksSnapshot();
  const cloudTasks =
    snap.exists() && Array.isArray(snap.data()?.tasks)
      ? snap.data().tasks.map(normalizeTask)
      : [];

  // Merge guest/local-only tasks into the account, then use that as the source of truth
  const merged = mergeTaskLists(cloudTasks, localGuest);

  applyingRemote = true;
  state.tasks = merged;
  writeLocalReplica(merged);
  markReplicaCheckedToday();
  applyingRemote = false;
  render();

  await setDoc(
    ref,
    {
      tasks: merged,
      updatedAt: new Date().toISOString(),
      email: user.email || "",
    },
    { merge: true }
  );

  unsubTasks = onSnapshot(
    ref,
    (docSnap) => {
      if (!docSnap.exists()) return;
      const remote = Array.isArray(docSnap.data()?.tasks)
        ? docSnap.data().tasks.map(normalizeTask)
        : [];
      applyingRemote = true;
      state.tasks = remote;
      writeLocalReplica(remote);
      markReplicaCheckedToday();
      applyingRemote = false;
      render();
    },
    (err) => {
      console.warn("Cloud sync error:", err);
    }
  );
}

function handleAuthUser(user) {
  stopCloudSync();
  if (user) {
    state.user = { uid: user.uid, email: user.email || "" };
    updateAccountUi();
    startCloudSync(state.user).catch((e) => {
      console.warn(e);
      alert("Signed in, but could not load cloud tasks.");
    });
  } else {
    // Local already holds last account replica (or prior guest list)
    state.user = null;
    updateAccountUi();
    loadLocalTasks();
    render();
  }
}

// —— Normalize / ids ——

function normalizeTask(t) {
  return {
    id: String(t.id || uid()),
    title: String(t.title || "").trim() || "Untitled",
    due: t.due ? String(t.due) : null,
    done: Boolean(t.done),
    progress: Math.max(0, Number(t.progress) || 0),
    total: Math.max(0, Number(t.total) || 0),
    notes: String(t.notes || ""),
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
  saveTasks();
  render();
}

function setTaskDueToNow(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t || t.done) return;
  t.due = formatLocalDateTime(new Date());
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

function visibleTasks() {
  let list = state.tasks.slice();
  if (state.filter === "active") list = list.filter((t) => !t.done);
  if (state.filter === "done") list = list.filter((t) => t.done);
  if (state.query) {
    const q = state.query.toLowerCase();
    list = list.filter(
      (t) => t.title.toLowerCase().includes(q) || t.notes.toLowerCase().includes(q)
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
  chev: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>',
};

// —— Render ——

function render() {
  const listEl = document.getElementById("task-list");
  const emptyEl = document.getElementById("empty-state");
  const tasks = visibleTasks();

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
            ${meta ? `<div class="task-meta">${meta}</div>` : ""}
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

function openDialog(task) {
  const dlg = document.getElementById("task-dialog");
  const deleteBtn = document.getElementById("btn-dialog-delete");
  document.getElementById("dialog-title").textContent = task ? "Edit task" : "New task";
  document.getElementById("field-id").value = task?.id || "";
  document.getElementById("field-title").value = task?.title || "";
  document.getElementById("field-notes").value = task?.notes || "";
  deleteBtn.hidden = !task;

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
    title,
    due,
    done: existing?.done || false,
    progress: existing?.progress ?? 0,
    total: existing?.total ?? 0,
    notes: document.getElementById("field-notes").value,
  });

  const idx = state.tasks.findIndex((t) => t.id === id);
  if (idx >= 0) state.tasks[idx] = task;
  else state.tasks.unshift(task);

  saveTasks();
  document.getElementById("task-dialog").close();
  render();
}

function toggleDone(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  t.done = !t.done;
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
    const n = state.tasks.filter((t) => t.done).length;
    if (!n) return;
    if (!confirm(`Remove ${n} completed task(s)?`)) return;
    state.tasks = state.tasks.filter((t) => !t.done);
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

  document.querySelectorAll(".drawer-item[data-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.filter = btn.getAttribute("data-filter");
      document.querySelectorAll(".drawer-item[data-filter]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      closeDrawer();
      render();
    });
  });

  document.getElementById("btn-add").addEventListener("click", () => openDialog(null));
  document.getElementById("btn-dialog-close").addEventListener("click", () => {
    document.getElementById("task-dialog").close();
  });
  document.getElementById("btn-dialog-delete").addEventListener("click", () => {
    const id = document.getElementById("field-id").value;
    if (!id) return;
    document.getElementById("task-dialog").close();
    deleteTask(id);
  });
  document.getElementById("field-title").addEventListener("input", autosizeTitleField);
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

if (initFirebase() && auth) {
  // Wait for auth before showing tasks so we don't flash old guest list then account list
  onAuthStateChanged(auth, (user) => {
    handleAuthUser(user);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") maybeDailyReplicaCheck();
  });
} else {
  loadLocalTasks();
  render();
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}
