// Portable launcher. Serves the web app from inside the executable on a
// localhost port, then opens it in a chromeless browser window.
//
// Ports are a fixed list, not "any free port": Google matches OAuth origins
// exactly, so every port here must also be registered on the OAuth client or
// sign-in will be refused. See README.
//
// Each port is claimed on BOTH IPv4 and IPv6. `localhost` resolves to ::1 and
// 127.0.0.1, and browsers generally try ::1 first — and Windows will happily
// let us bind 127.0.0.1:8000 while another program holds [::]:8000. Binding one
// family only meant the browser could silently land on that other program.
//
// The packaged exe is patched to the Windows GUI subsystem, so there is no
// console window. Two consequences shape the code below:
//
//   * Nothing can be printed at the user. Problems go in a dialog — notify().
//   * Closing a console is no longer how you quit. The served page carries an
//     injected heartbeat, and this process exits once the beats stop.
//
// Runs either way:
//   node desktop/server.js     — reads the web files from disk, logs to console
//   RoundTuit.exe              — reads them from inside itself, no console

"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

// First one that's free wins. All of these must be authorized JavaScript
// origins on the Google OAuth client.
const PORTS = [8000, 47820, 47821];

const PING_PATH = "/__todo_ping";
const PING_BODY = "todo-launcher";
const PARSE_BASE = "http://localhost/"; // only used to parse request paths

// Overridable so the shutdown behaviour can be tested without a two-minute wait.
const BEAT_MS = Number(process.env.TODO_BEAT_MS) || 5000;   // page pings this often
const IDLE_MS = Number(process.env.TODO_IDLE_MS) || 30000;  // silence this long = window gone
const GRACE_MS = Number(process.env.TODO_GRACE_MS) || 90000; // let a slow browser start first

// node:sea only exists inside the packaged executable.
let sea = null;
try {
  const mod = require("node:sea");
  if (mod.isSea()) sea = mod;
} catch {
  /* running as a plain script */
}

const WEB_ROOT = path.join(__dirname, "..");
const EXE_DIR = path.dirname(process.execPath);

// With no console attached, writes to stdout can raise EBADF. Swallow them.
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const appUrl = (port) => `http://localhost:${port}/`;

// ------------------------------------------------------------------ output

// Packaged there is nowhere to print, so anything the user must see goes in a
// message box. spawnSync so the process doesn't exit before it's read.
function notify(message, isError = false) {
  if (!sea || process.env.TODO_NO_DIALOG === "1") {
    (isError ? console.error : console.log)(message);
    return;
  }
  const text = message.replace(/'/g, "''");
  const icon = isError ? "Error" : "Information";
  spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Add-Type -AssemblyName System.Windows.Forms;" +
        `[System.Windows.Forms.MessageBox]::Show('${text}','Round-Tuit',` +
        `[System.Windows.Forms.MessageBoxButtons]::OK,` +
        `[System.Windows.Forms.MessageBoxIcon]::${icon}) | Out-Null`,
    ],
    { windowsHide: true, stdio: "ignore" }
  );
}

// ------------------------------------------------------------------ assets

// Packaged, only the files listed in sea-config.json exist at all. Reading that
// same list in dev keeps the two modes serving exactly the same set, instead of
// dev quietly exposing the whole project directory.
let devAssets = null;

function isDeclared(key) {
  if (!devAssets) {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "sea-config.json"), "utf8"));
    devAssets = new Set(Object.keys(cfg.assets));
  }
  return devAssets.has(key);
}

// A file dropped beside the exe wins over the embedded copy. That's how you
// change the client ID in config.js without rebuilding.
function readAsset(key) {
  if (sea) {
    try {
      return fs.readFileSync(path.join(EXE_DIR, key));
    } catch {
      /* no override, use the embedded copy */
    }
    try {
      return Buffer.from(sea.getAsset(key));
    } catch {
      return null;
    }
  }
  if (!isDeclared(key)) return null;
  try {
    return fs.readFileSync(path.join(WEB_ROOT, key));
  } catch {
    return null;
  }
}

// The web app knows nothing about any of this — the heartbeat is added on the
// way out, so the browser build stays free of desktop-only code.
const HEARTBEAT = `
<script>
(() => {
  const beat = () => fetch(${JSON.stringify(PING_PATH)}, { cache: "no-store" }).catch(() => {});
  beat();
  setInterval(beat, ${BEAT_MS});
})();
</script>
`;

function withHeartbeat(html) {
  const text = html.toString("utf8");
  return Buffer.from(
    text.includes("</body>") ? text.replace("</body>", `${HEARTBEAT}</body>`) : text + HEARTBEAT,
    "utf8"
  );
}

// ------------------------------------------------------------------ serving

let lastBeat = Date.now();

function handler(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, PARSE_BASE).pathname);
  } catch {
    res.writeHead(400).end("Bad request");
    return;
  }

  if (pathname === PING_PATH) {
    lastBeat = Date.now();
    res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    res.end(PING_BODY);
    return;
  }

  let key = pathname.replace(/^\/+/, "").replace(/\\/g, "/");
  if (key === "") key = "index.html";

  // Nothing outside the bundle, whatever the URL says.
  if (key.split("/").includes("..")) {
    res.writeHead(400).end("Bad request");
    return;
  }

  let body = readAsset(key);
  if (!body) {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
    return;
  }
  if (key === "index.html") body = withHeartbeat(body);

  res.writeHead(200, {
    "Content-Type": MIME[path.extname(key)] || "application/octet-stream",
    // The service worker is network-first, so let it see fresh files.
    "Cache-Control": "no-cache",
  });
  res.end(body);
}

// ------------------------------------------------------------------ browser

function openWindow(port) {
  if (process.env.TODO_NO_BROWSER === "1") return; // for tests and headless runs

  const url = appUrl(port);
  const chromiums = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ];
  const exe = chromiums.find((p) => fs.existsSync(p));

  // App mode gives a window with no tabs or address bar. It uses the default
  // browser profile, so an existing Google session carries over and sign-in
  // stays silent.
  const cmd = exe
    ? [exe, [`--app=${url}`, "--window-size=560,900"]]
    : ["cmd", ["/c", "start", "", url]];

  spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

// ------------------------------------------------------------------ binding

function tryListen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener("listening", onOk);
      if (err.code === "EADDRINUSE") return resolve("inuse");
      // No IPv6 stack on this machine, or the address isn't usable.
      if (["EADDRNOTAVAIL", "EAFNOSUPPORT", "EINVAL"].includes(err.code)) {
        return resolve("unavailable");
      }
      reject(err);
    };
    const onOk = () => {
      server.removeListener("error", onError);
      resolve("ok");
    };
    server.once("error", onError);
    server.once("listening", onOk);
    server.listen(port, host);
  });
}

// Is whatever holds this port one of ours? Checked on both families, since the
// running instance may have claimed only one of them.
async function findOurInstance(port) {
  for (const host of ["127.0.0.1", "::1"]) {
    const ours = await new Promise((resolve) => {
      const req = http.get({ host, port, path: PING_PATH, timeout: 1200 }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve(body.trim() === PING_BODY));
      });
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
    });
    if (ours) return true;
  }
  return false;
}

// Claims a port on both families, or gives it up entirely. Holding just one
// family is what let the browser reach a different program on the other.
async function claim(port) {
  const v4 = http.createServer(handler);
  if ((await tryListen(v4, port, "127.0.0.1")) !== "ok") {
    v4.close();
    return null;
  }

  const v6 = http.createServer(handler);
  const r6 = await tryListen(v6, port, "::1");

  if (r6 === "inuse") {
    v6.close();
    v4.close();
    return null; // someone else owns the IPv6 side — the browser would find them
  }
  if (r6 !== "ok") v6.close(); // machine has no IPv6; IPv4 alone is fine here

  return { port, servers: r6 === "ok" ? [v4, v6] : [v4] };
}

// ------------------------------------------------------------------ startup

async function start() {
  for (const port of PORTS) {
    const claimed = await claim(port);
    if (claimed) return claimed;

    // Port's taken. If it's another copy of us, hand over and quit.
    if (await findOurInstance(port)) {
      openWindow(port);
      process.exit(0);
    }
  }

  notify(
    `Round-Tuit couldn't start: every port it can use is taken by another program.\n\n` +
      `Tried: ${PORTS.join(", ")}.\n\n` +
      `Round-Tuit can only use these specific ports, because they're the addresses ` +
      `registered with Google for sign-in — any other port would be rejected.\n\n` +
      `To see what's using them, run this in PowerShell:\n` +
      `    Get-NetTCPConnection -LocalPort ${PORTS.join(",")} -State Listen\n\n` +
      `Close that program, then try again.`,
    true
  );
  process.exit(1);
}

start().then(({ port, servers }) => {
  const startedAt = Date.now();
  lastBeat = startedAt;
  openWindow(port);

  if (!sea) {
    console.log(`\n  Round-Tuit is running at ${appUrl(port)}`);
    console.log("  Close the app window, or press Ctrl+C, to quit.\n");
  }

  const quit = () => {
    for (const s of servers) s.close();
    process.exit(0);
  };

  // The window is the app. Once it stops beating, there's nothing left to serve.
  setInterval(() => {
    if (Date.now() - startedAt < GRACE_MS) return;
    if (Date.now() - lastBeat < IDLE_MS) return;
    quit();
  }, BEAT_MS);

  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, quit);
});
