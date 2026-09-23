/**
 * Personal Tasks — PWA
 * Storage: localStorage + pipe-delimited .txt / JSON import-export
 *
 * File format (tasks.txt), one task per line:
 * id|title|dueISO|done|progress|total|notes
 * Lines starting with # are comments. dueISO is YYYY-MM-DDTHH:mm or empty.
 */

const STORAGE_KEY = "my-tasks-v1";
const FILE_SEP = "|";

/** @typedef {{ id: string, title: string, due: string|null, done: boolean, progress: number, total: number, notes: string }} Task */

const state = {
  tasks: /** @type {Task[]} */ ([]),
  filter: "all", // all | active | done
  query: "",
  sort: "due", // due | title | created
  editingId: null,
  expanded: new Set(),
};

// —— Persistence ——

function loadTasks() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return seedIfEmpty();
    const parsed = JSON.parse(raw);
    state.tasks = Array.isArray(parsed) ? parsed.map(normalizeTask) : [];
  } catch {
    state.tasks = [];
  }
}

function saveTasks() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.tasks));
}

function seedIfEmpty() {
  state.tasks = [
    {
      id: uid(),
      title: "Zikr Mama g: ayat e karima 125k every year: 2026",
      due: daysAgo(4) + "T14:00",
      done: false,
      progress: 0,
      total: 0,
      notes: "",
    },
    {
      id: uid(),
      title: "Zikr: Surah Yaseen: every day: 2026",
      due: daysAgo(4),
      done: false,
      progress: 0,
      total: 8,
      notes: "Daily recitation — mark progress as you go.",
    },
    {
      id: uid(),
      title: "Zikr: 1000 times: Surah Ikhlas: every day",
      due: daysAgo(3),
      done: false,
      progress: 0,
      total: 10,
      notes: "",
    },
  ];
  saveTasks();
}

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

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// —— File format ——

function tasksToDelimited(tasks) {
  const header = "# id|title|due|done|progress|total|notes";
  const lines = tasks.map((t) =>
    [
      t.id,
      escapeField(t.title),
      t.due || "",
      t.done ? "1" : "0",
      t.progress,
      t.total,
      escapeField(t.notes),
    ].join(FILE_SEP)
  );
  return [header, ...lines].join("\n") + "\n";
}

function escapeField(s) {
  return String(s).replace(/\|/g, "\\|").replace(/\n/g, "\\n");
}

function unescapeField(s) {
  return String(s).replace(/\\n/g, "\n").replace(/\\\|/g, "|");
}

function parseDelimited(text) {
  /** @type {Task[]} */
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = splitEscaped(trimmed);
    if (parts.length < 2) continue;
    out.push(
      normalizeTask({
        id: parts[0],
        title: unescapeField(parts[1] || ""),
        due: parts[2] || null,
        done: parts[3] === "1" || parts[3] === "true",
        progress: parts[4],
        total: parts[5],
        notes: unescapeField(parts[6] || ""),
      })
    );
  }
  return out;
}

function splitEscaped(line) {
  const parts = [];
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\" && i + 1 < line.length) {
      cur += line[i] + line[i + 1];
      i++;
      continue;
    }
    if (line[i] === FILE_SEP) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += line[i];
  }
  parts.push(cur);
  return parts;
}

function parseImportFile(text, name) {
  const trimmed = text.trim();
  if (name.endsWith(".json") || trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const data = JSON.parse(trimmed);
    const arr = Array.isArray(data) ? data : data.tasks;
    if (!Array.isArray(arr)) throw new Error("JSON must be an array of tasks");
    return arr.map(normalizeTask);
  }
  return parseDelimited(trimmed);
}

function exportFile() {
  const body = tasksToDelimited(state.tasks);
  const blob = new Blob([body], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "tasks.txt";
  a.click();
  URL.revokeObjectURL(url);
}

function importFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const imported = parseImportFile(String(reader.result), file.name.toLowerCase());
      if (!imported.length) {
        alert("No tasks found in that file.");
        return;
      }
      const replace = confirm(
        `Found ${imported.length} task(s).\n\nOK = replace all current tasks\nCancel = merge with existing`
      );
      if (replace) {
        state.tasks = imported;
      } else {
        const ids = new Set(state.tasks.map((t) => t.id));
        for (const t of imported) {
          if (ids.has(t.id)) {
            const i = state.tasks.findIndex((x) => x.id === t.id);
            state.tasks[i] = t;
          } else {
            state.tasks.push(t);
          }
        }
      }
      saveTasks();
      render();
      closeDrawer();
      closeMenu();
    } catch (e) {
      alert("Could not read file: " + (e.message || e));
    }
  };
  reader.readAsText(file);
}

// —— Date helpers ——

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function parseDue(due) {
  if (!due) return null;
  // Treat date-only as local midnight
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

const SECTION_ORDER = ["Overdue", "Today", "Upcoming", "No date", "Completed"];

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
    if (state.sort === "title") return a.title.localeCompare(b.title);
    const da = parseDue(a.due)?.getTime() ?? Infinity;
    const db = parseDue(b.due)?.getTime() ?? Infinity;
    if (da !== db) return da - db;
    return a.title.localeCompare(b.title);
  });
  return list;
}

// —— Icons (inline SVG) ——

const ICONS = {
  empty:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg>',
  checked:
    '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>',
  cal: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10zm0-12H5V6h14v2z"/></svg>',
  prog: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>',
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
  const open = state.expanded.has(t.id);
  const hasDetails = Boolean(t.notes) || t.total > 0;

  let meta = "";
  if (dueLabel) {
    meta += `<span class="meta-item${overdue && !t.done ? " overdue" : ""}">${ICONS.cal}${dueLabel}</span>`;
  }
  if (t.total > 0) {
    meta += `<span class="meta-item">${ICONS.prog}${t.progress}/${t.total}</span>`;
  }

  return `
    <article class="task-card" data-id="${t.id}">
      <div class="task-row${t.done ? " done" : ""}">
        <button type="button" class="check${t.done ? " checked" : ""}" data-action="toggle" aria-label="Mark complete">
          ${t.done ? ICONS.checked : ICONS.empty}
        </button>
        <div class="task-body" data-action="edit">
          <p class="task-title">${escapeHtml(t.title)}</p>
          ${meta ? `<div class="task-meta">${meta}</div>` : ""}
        </div>
        ${
          hasDetails
            ? `<button type="button" class="expand-btn${open ? " open" : ""}" data-action="expand" aria-label="Expand">${ICONS.chev}</button>`
            : `<button type="button" class="expand-btn" data-action="expand" aria-label="More">${ICONS.chev}</button>`
        }
      </div>
      <div class="task-details" ${open ? "" : "hidden"}>
        ${t.notes ? escapeHtml(t.notes) : "<em>No notes</em>"}
        ${
          t.total > 0
            ? `<div class="task-details-actions">
                <button type="button" class="chip-btn" data-action="bump">+1 progress (${t.progress}/${t.total})</button>
              </div>`
            : ""
        }
        <div class="task-details-actions">
          <button type="button" class="chip-btn" data-action="edit">Edit</button>
          <button type="button" class="chip-btn danger" data-action="delete">Delete</button>
        </div>
      </div>
    </article>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// —— CRUD ——

function openDialog(task) {
  const dlg = document.getElementById("task-dialog");
  document.getElementById("dialog-title").textContent = task ? "Edit task" : "New task";
  document.getElementById("field-id").value = task?.id || "";
  document.getElementById("field-title").value = task?.title || "";
  document.getElementById("field-notes").value = task?.notes || "";
  document.getElementById("field-progress").value = String(task?.progress ?? 0);
  document.getElementById("field-total").value = String(task?.total ?? 0);

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

  const task = normalizeTask({
    id,
    title,
    due,
    done: state.tasks.find((t) => t.id === id)?.done || false,
    progress: document.getElementById("field-progress").value,
    total: document.getElementById("field-total").value,
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
  state.expanded.delete(id);
  saveTasks();
  render();
}

function bumpProgress(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t || t.total <= 0) return;
  t.progress = Math.min(t.total, t.progress + 1);
  if (t.progress >= t.total) t.done = true;
  saveTasks();
  render();
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

function pickFile() {
  document.getElementById("file-input").click();
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

  document.getElementById("btn-sort").addEventListener("click", () => {
    state.sort = state.sort === "due" ? "title" : "due";
    render();
  });

  document.getElementById("btn-check-all").addEventListener("click", () => {
    const active = state.tasks.filter((t) => !t.done);
    if (!active.length) return;
    if (!confirm(`Mark all ${active.length} active task(s) complete?`)) return;
    for (const t of active) t.done = true;
    saveTasks();
    render();
  });

  document.getElementById("btn-more").addEventListener("click", openMenu);
  document.getElementById("menu-backdrop").addEventListener("click", closeMenu);
  document.getElementById("menu-import").addEventListener("click", () => {
    closeMenu();
    pickFile();
  });
  document.getElementById("menu-export").addEventListener("click", () => {
    closeMenu();
    exportFile();
  });
  document.getElementById("menu-clear-done").addEventListener("click", () => {
    closeMenu();
    const n = state.tasks.filter((t) => t.done).length;
    if (!n) return;
    if (!confirm(`Remove ${n} completed task(s)?`)) return;
    state.tasks = state.tasks.filter((t) => !t.done);
    saveTasks();
    render();
  });

  document.getElementById("btn-import").addEventListener("click", pickFile);
  document.getElementById("btn-export").addEventListener("click", exportFile);
  document.getElementById("file-input").addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) importFile(file);
  });

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
  document.getElementById("btn-dialog-cancel").addEventListener("click", () => {
    document.getElementById("task-dialog").close();
  });
  document.getElementById("task-form").addEventListener("submit", saveFromForm);

  document.getElementById("task-list").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    const card = e.target.closest(".task-card");
    if (!card) return;
    const id = card.getAttribute("data-id");
    const action = btn?.getAttribute("data-action");
    if (!action) return;
    e.stopPropagation();
    if (action === "toggle") toggleDone(id);
    else if (action === "expand") {
      if (state.expanded.has(id)) state.expanded.delete(id);
      else state.expanded.add(id);
      render();
    } else if (action === "edit") {
      const t = state.tasks.find((x) => x.id === id);
      if (t) openDialog(t);
    } else if (action === "delete") deleteTask(id);
    else if (action === "bump") bumpProgress(id);
  });
}

// —— Boot ——

loadTasks();
bindEvents();
render();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}
