// Dev-only fake Drive, active ONLY with ?mock=1 in the URL. Lets you exercise
// the whole app without a Google client ID. Inert in every other case.
//
// State lives in localStorage, so a reload behaves like a second visit and you
// can force a conflict by editing todo.mockDrive in devtools between saves.

(() => {
  if (new URLSearchParams(location.search).get("mock") !== "1") return;

  const KEY = "todo.mockDrive";
  console.warn("[mock] Fake Drive active. No data leaves this browser.");

  // Tells app.js to namespace its storage, so test lists made here can never
  // be mistaken for real ones and pushed to the real Drive.
  window.TODO_MOCK = true;

  window.TODO_CONFIG.GOOGLE_CLIENT_ID ||= "mock.apps.googleusercontent.com";

  // --- fake Google Identity Services --------------------------------------

  window.google = {
    accounts: {
      oauth2: {
        initTokenClient: () => ({
          callback: null,
          error_callback: null,
          requestAccessToken() {
            setTimeout(
              () => this.callback({ access_token: "mock-token", expires_in: 3600 }),
              50
            );
          },
        }),
        revoke: (_token, done) => done?.(),
      },
    },
  };

  // --- fake Drive backing store -------------------------------------------

  const read = () => {
    try {
      return JSON.parse(localStorage.getItem(KEY)) || {};
    } catch {
      return {};
    }
  };
  const write = (s) => localStorage.setItem(KEY, JSON.stringify(s));

  const ok = (body) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  const realFetch = window.fetch.bind(window);

  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    if (!/googleapis\.com$/.test(url.hostname)) return realFetch(input, init);

    const state = read();
    const method = (init.method || "GET").toUpperCase();
    const query = url.searchParams.get("q") || "";
    const isUpload = url.pathname.startsWith("/upload/");
    const idMatch = url.pathname.match(/\/files\/([^/?]+)/);

    // search
    if (method === "GET" && !idMatch) {
      const wantsFolder = query.includes("apps.folder");
      const id = wantsFolder ? state.folderId : state.fileId;
      return ok({ files: id ? [{ id, name: wantsFolder ? "tododata" : "todos.json" }] : [] });
    }

    // create folder
    if (method === "POST" && !isUpload) {
      state.folderId = "mock-folder";
      write(state);
      return ok({ id: state.folderId });
    }

    // create file (multipart)
    if (method === "POST" && isUpload) {
      const parts = String(init.body).split("\r\n\r\n");
      state.fileId = "mock-file";
      state.version = 1;
      state.content = parts[parts.length - 1].split("\r\n--")[0];
      write(state);
      return ok({ id: state.fileId, version: state.version });
    }

    // metadata
    if (method === "GET" && idMatch && url.searchParams.get("alt") !== "media") {
      return ok({ version: state.version ?? 1 });
    }

    // download
    if (method === "GET" && idMatch) {
      return ok(state.content ?? '{"schema":1,"items":[]}');
    }

    // overwrite
    if (method === "PATCH" && isUpload) {
      state.version = (state.version ?? 1) + 1;
      state.content = String(init.body);
      write(state);
      return ok({ version: state.version });
    }

    return new Response("mock: unhandled " + method + " " + url.pathname, { status: 400 });
  };
})();
