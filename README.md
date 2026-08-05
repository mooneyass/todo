# Round-Tuit

A ranked to-do list that stores its data as a single JSON file in your own Google Drive,
so Windows and Android read and write the same list.

- **One item = a rank, a title, and a content box.** Collapsed, you see only the rank and title.
  Click the title to open the content box.
- **Rank dropdown is 1–20.** Pick a rank and the item that held it — plus everything below —
  shifts down one. The slot the item came from closes up. The cap is per list.
- **Tabs across the top are your lists.** `+` adds one. Double-click a tab to rename it, or
  press and hold on a phone. The active tab gets a `×` to delete that list; the last remaining
  list can't be deleted. Which tab you're on is remembered per device, so the phone and the PC
  can sit on different lists.
- **Storage** is `tododata/todos.json` in your Drive — every list in the one file. Both devices
  use that same file.
- **Conflicts** are detected, not guessed at: if the other device saved first, you're asked
  which version to keep.
- **Offline** edits are kept on the device and pushed when the connection is back.

It's a PWA — plain HTML/CSS/JS, no build step, no npm install. Deploy by copying files.

---

## Try it first, no setup

Open `index.html` through a local server (see [Run it locally](#run-it-locally)) with `?mock=1`:

```
http://localhost:8000/?mock=1
```

That runs the whole app against a fake in-browser Drive. Nothing touches Google and nothing
leaves the machine — it's just to see the thing work before you do the setup below.

---

## 1. Google setup (once, ~10 minutes)

You need an OAuth client ID so the app can ask for permission to your Drive.

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and create a project
   (name it anything, e.g. `todo-app`).

2. **Enable the Drive API.** *APIs & Services → Library →* search **Google Drive API** → **Enable**.

3. **Configure the consent screen.** *APIs & Services → OAuth consent screen*. Choose
   **External**, fill in an app name, and use your own Gmail address for both the support
   and developer contact fields.

4. **Publish it.** On the consent screen / Audience page, click **Publish app**. There's no
   review to wait for — this app only asks for the `drive.file` permission, which Google
   classes as non-sensitive. Leaving it in *Testing* mode instead means periodically
   re-granting access, so publish.

5. **Create the client ID.** *Credentials → Create credentials → OAuth client ID →
   Application type: **Web application***. Under **Authorized JavaScript origins**, add both:

   ```
   http://localhost:8000
   http://localhost:47820
   http://localhost:47821
   https://YOUR-GITHUB-USERNAME.github.io
   ```

   The two odd-numbered ports are fallbacks for the desktop executable. Port 8000 is a
   popular one — plenty of other software grabs it — and if Round-Tuit can't have it, it moves
   to the next in the list. Sign-in only works on origins listed here, so register all
   three or a fallback will fail to sign in.

   (Add the second one after you know your GitHub Pages address — you can edit this later.
   Origins only: no paths, no trailing slash. No redirect URI is needed.)

6. **Paste the client ID into `config.js`:**

   ```js
   GOOGLE_CLIENT_ID: "1234567890-abcdefg.apps.googleusercontent.com",
   ```

That client ID is not a secret. Browser OAuth client IDs are public by design — the
authorized-origins list is what stops anyone else using it.

### What the app can see

The permission requested is `drive.file`, the narrowest one Drive offers: an app can only
open files it created itself. This app creates `tododata/todos.json` and can touch nothing
else in your Drive — not your documents, not your photos, not even a `tododata` folder you
made by hand. That last part is why the app creates its own folder on first run.

---

## 2. Run it locally

`file://` won't work — Google sign-in requires a real origin. From the project folder:

```bash
python -m http.server 8000
```

Then open <http://localhost:8000>.

---

## 3. Put it online

Any static host works. GitHub Pages is free and fine:

1. Create a repo and push these files to `main`.
2. *Settings → Pages → Source: Deploy from a branch → `main` / `(root)`.*
3. Wait a minute, then visit `https://YOUR-USERNAME.github.io/REPO-NAME/`.
4. Go back to step 1.5 above and make sure `https://YOUR-USERNAME.github.io` is in the
   authorized JavaScript origins.

The repo will be public unless you pay for private Pages — that's fine, there are no secrets
in it. Your to-do data lives in your Drive, never in the repo.

---

## 4. Windows executable (portable)

`dist/RoundTuit.exe` is one self-contained file, about 80MB, holding the web app and a Node
runtime. Copy it to any Windows PC — USB stick, network share, wherever — and double-click.
No install, no admin rights, nothing left behind.

It serves the app on `http://localhost:8000` and opens it in a chromeless Edge or Chrome
window, so it looks like a desktop app rather than a browser tab. There's no console window;
closing the app window quits it, via a heartbeat the launcher injects into the page.

To rebuild after changing any web file:

```bash
./desktop/build.ps1
```

Things worth knowing:

- **It needs one of ports 8000, 47820 or 47821**, and tries them in that order. It can't just
  grab any free port, because Google only accepts sign-in from origins registered on the OAuth
  client. If all three are taken, it explains which and exits.
- **Each port is claimed on both IPv4 and IPv6.** `localhost` resolves to `::1` and
  `127.0.0.1`, and browsers usually try `::1` first — while Windows will happily let you bind
  `127.0.0.1:8000` when another program already holds `[::]:8000`. Binding only IPv4 meant the
  browser could land on that other program instead, showing *its* page inside the Round-Tuit
  window. If either family is unavailable, the port is skipped entirely.
- **Running it twice is harmless.** The second copy notices the first and just opens a window.
- **Windows SmartScreen may warn on first run**, because the exe isn't code-signed. *More info
  → Run anyway*. Some antivirus is also suspicious of unsigned Node executables.
- **It doesn't auto-update.** Rebuild and re-copy after changing the app.
- **`config.js` beside the exe overrides the embedded one**, so you can change the client ID
  without rebuilding.
- **Your data isn't in the exe.** It's in Drive, so every PC shows the same lists.

## 5. Install it as a web app

Easiest on every platform: open the site and press the **Install** button in the top bar. It
appears only when the browser considers the app installable and it isn't installed already, so
if you can see it, it will work.

Failing that, the browser menus still do it. **Windows** — *⋯ menu → Apps → Install this site
as an app*. **Android** — *⋮ menu → Add to Home screen*. **iPhone** — Safari doesn't support
the Install button, so it's *Share → Add to Home Screen*.

Either way you get a real window, no browser chrome, and an entry in the Start Menu or on the
home screen.

Both installs are just the website, so a push to `main` updates both. Reopen the app to pick
up a change.

---

## How syncing works

The app keeps the exact text of the file as it last saw it. Before every write it re-reads the
file and compares. If the contents have changed, your phone and PC have diverged and you're
asked which version to keep, rather than one silently overwriting the other.

(An earlier version compared Drive's `version` counter instead. Don't go back to that: Drive
bumps that counter for its own server-side metadata changes, which produces phantom conflicts
on a file that nothing else has touched.)

Saves are automatic, about a second after you stop typing. Bringing the app back to the
foreground re-reads from Drive, so opening it on your phone picks up what you did on the PC.

There is a narrow race — if both devices write in the same fraction of a second, the check can
pass on both. For one person on two devices it isn't a practical concern.

---

## The data file

`tododata/todos.json` is readable JSON; you can open it in Drive and edit it by hand if you
ever want to.

```json
{
  "schema": 2,
  "updatedAt": "2026-08-04T18:20:11.000Z",
  "lists": [
    {
      "id": "3b7e…",
      "name": "To-Do",
      "createdAt": "2026-08-04T18:18:40.000Z",
      "items": [
        {
          "id": "9f2c…",
          "rank": 1,
          "title": "Renew passport",
          "content": "Form DS-82.\nPhoto place on 5th closes at 6.",
          "createdAt": "2026-08-04T18:19:02.000Z"
        }
      ]
    }
  ]
}
```

Ranks are always the contiguous run `1..n` within each list.

The app repairs whatever it finds: a `schema: 1` file (a flat `items` array, from before
lists existed) is migrated into a single list named "To-Do", missing fields get defaults, and
ranks are renumbered. So hand-editing is safe — you can't corrupt it into a state that won't
load. Which tab is active is *not* stored here; that's per-device, in browser storage.

---

## Files

| File | What it does |
| --- | --- |
| `index.html` | Markup and screens |
| `app.css` | Styling, light and dark |
| `app.js` | State, rendering, ranking, auto-save |
| `drive.js` | Google auth and the Drive read/write calls |
| `config.js` | Your client ID and the folder/file names |
| `sw.js` | Service worker — makes it installable and work offline |
| `dev/mock.js` | Fake Drive for `?mock=1`. Dev only; inert otherwise |
| `manifest.webmanifest`, `icons/` | Install metadata and app icons |
| `desktop/server.js` | The portable exe: serves the embedded app, opens the window |
| `desktop/sea-config.json` | Which files get embedded. Also the dev-mode allowlist |
| `desktop/build.ps1` | Builds `dist/RoundTuit.exe` |

Changing a shell file? Bump `CACHE` in `sw.js` so devices drop the old copy.
