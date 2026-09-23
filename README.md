# Tasks — personal to-do app

Free, installable mobile task list. Looks like a native app, works offline, and backs up to a simple text file you can edit anywhere.

## Features

- Task title, due date/time, notes, and optional progress (e.g. `0/10`)
- Groups: **Overdue**, **Today**, **Upcoming**, **Completed**
- Search, sort, mark all complete
- Offline Progressive Web App (PWA)
- Import / export a pipe-delimited `tasks.txt` file (or JSON)

## Use on your phone (free)

Browsers only allow “Add to Home Screen” for sites served over **https** (or localhost). Easiest free options:

### Option A — GitHub Pages (recommended)

1. Push this folder to a GitHub repository
2. Settings → Pages → Deploy from `main` / root
3. Open the Pages URL on your phone
4. **Android (Chrome):** menu → **Install app** / **Add to Home screen**
5. **iPhone (Safari):** Share → **Add to Home Screen**

### Option B — Local on the same Wi‑Fi (for testing)

On your computer, in this folder:

```bash
npx --yes serve .
```

Open the printed URL on your phone (same Wi‑Fi). For a lasting install, use Option A.

## Data file format

File: `data/tasks.txt` (also what Export downloads)

```
# id|title|due|done|progress|total|notes
t1|Buy milk|2026-09-25T18:30|0|0|0|From the corner shop
t2|Surah Yaseen|2026-09-20|0|3|8|Daily
```

| Field    | Meaning                                      |
|----------|----------------------------------------------|
| id       | Unique id                                    |
| title    | Task name                                    |
| due      | `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm` (or empty)|
| done     | `0` = active, `1` = completed                |
| progress | Current count (e.g. 3)                       |
| total    | Goal count (e.g. 8); `0` hides the counter   |
| notes    | Extra details                                |

Use `\|` for a pipe in text, `\n` for a newline in notes.

You can also import a JSON array of the same fields.

**Workflow:** edit `tasks.txt` on a PC → on the phone open the ⋮ menu → **Import tasks file**. Export anytime for backup.

Day-to-day use stores data in the phone’s browser storage so the app stays fast offline; the text file is your portable backup / editor.

## Desktop / browser

Open `index.html` via a local server (not as a raw `file://` link) so the service worker and install prompt work:

```bash
npx --yes serve .
```

Then visit `http://localhost:3000`.
