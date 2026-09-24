# Tasks — personal to-do app

Free, installable mobile task list. Looks like a native app, works offline, and backs up to a simple text file you can edit anywhere.

- **Guest mode:** tasks stay in that device’s browser storage (not shared).
- **Signed in:** the same email gets the same cloud-synced list on every device.
- `data/tasks.txt` in the repo is only a blank template / backup format.

## Features

- Task title, due date/time, notes, and optional progress (e.g. `0/10`)
- Groups: **Overdue**, **Today**, **Upcoming**, **Completed**
- Search, sort, mark all complete
- Offline Progressive Web App (PWA)
- Optional email/password sync via Firebase
- Import / export a pipe-delimited `tasks.txt` file (or JSON)

## Firebase setup (cloud sync)

Needed only if you want Sign in / Sign up. Without it, the app still works as a guest.

1. Create a project at [Firebase Console](https://console.firebase.google.com).
2. **Authentication** → Sign-in method → enable **Email/Password**.
3. **Firestore Database** → Create database (production mode is fine).
4. **Project settings** → Your apps → add a **Web** app → copy the config object into [`firebase-config.js`](firebase-config.js) (replace the `YOUR_…` placeholders).
5. **Authentication** → Settings → **Authorized domains** → add your Netlify domain (e.g. `your-site.netlify.app`). `localhost` is allowed by default.
6. **Firestore** → Rules → publish:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

Each signed-in user stores tasks in `users/{uid}` (`tasks` array + `updatedAt`).

**Login behavior:** cloud list loads for that account. If cloud is empty and this device has guest tasks, those are uploaded once. Guest `localStorage` is kept for when you sign out.

## Use on your phone (free)

Browsers only allow “Add to Home Screen” for sites served over **https** (or localhost). Easiest free options:

### Option A — GitHub Pages / Netlify

1. Push this folder to a GitHub repository
2. Connect the repo to Netlify (or GitHub Pages → deploy from `main` / root)
3. Open the site URL on your phone
4. **Android (Chrome):** menu → **Install app** / **Add to Home screen**
5. **iPhone (Safari):** Share → **Add to Home Screen**

### Option B — Local on the same Wi‑Fi (for testing)

On your computer, in this folder:

```bash
npx --yes serve .
```

Open the printed URL on your phone (same Wi‑Fi). For a lasting install, use Option A.

## Data file format

File: `data/tasks.txt` — blank template in the repo; Export downloads the same format with your tasks.

Example once populated:

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

Day-to-day: guests use browser storage; signed-in users sync via Firebase. The text file remains a portable backup / editor.

## Desktop / browser

Open `index.html` via a local server (not as a raw `file://` link) so modules, the service worker, and install prompt work:

```bash
npx --yes serve .
```

Then visit `http://localhost:3000`.
