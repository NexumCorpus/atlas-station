# Packaging ATLAS // station as a Windows `.exe`

This document describes how to turn this Electron app into a distributable Windows
installer (`.exe`) using **electron-builder**, and — critically — how to keep the
plain-Node sidecars working once the app is packed into an `asar` archive.

Read this in full before building. The non-obvious part (the `asarUnpack` block and
one required change in `main.cjs`) is what separates a build that *packages* from a
build that actually *runs*.

---

## 1. Why this app needs special care

The app runs as **two kinds of process**, and packaging treats them differently:

| Process | Started by | Can read inside `app.asar`? |
| --- | --- | --- |
| `main.cjs` (Electron main) | Electron | ✅ yes — Electron patches `fs` to read asar transparently |
| `preload.cjs` / `index.html` (renderer) | Electron | ✅ yes — same patched `fs` |
| `fleethost.mjs` (fleet sidecar) | **external `node.exe`** (`main.cjs` line 9, 26) | ❌ **no** — vanilla Node has zero asar awareness |
| `ptyhost.cjs` (PTY sidecar) | **external `node.exe`** + loads a native `.node` | ❌ **no** — and a native addon can't `dlopen` from inside an archive at all |

electron-builder, by default, packs all app code and production `node_modules` into
`resources/app.asar`. That is fine for the Electron-side code. It is **fatal** for:

1. **`@homebridge/node-pty-prebuilt-multiarch`** — ships a prebuilt native `.node`
   binary. Native modules must be a real file on disk to load. Inside an asar they
   cannot be `dlopen`'d. → must be **unpacked**.
2. **`@anthropic-ai/claude-agent-sdk`** — imported by `fleethost.mjs`, which is run
   by a *separate* `node.exe` (not Electron). Plain Node cannot resolve or read
   modules from inside `app.asar`. → must be **unpacked**.
3. **The sidecar scripts themselves** (`fleethost.mjs`, `ptyhost.cjs`) — handed as a
   file path to that external `node.exe`. Same reason. → must be **unpacked**.

> Note: `@xterm/xterm` and `@xterm/addon-fit` are consumed only by the Electron
> renderer (which *can* read asar), so they do **not** need unpacking.

`asarUnpack` copies the listed paths out to `resources/app.asar.unpacked/...` as
real files, while still leaving everything else compressed in `app.asar`.

---

## 2. The devDependency to add

```bash
npm install --save-dev electron-builder@^26
```

This adds (latest at time of writing is `26.15.3`):

```json
"devDependencies": {
  "electron": "^42.5.0",
  "electron-builder": "^26.15.3"
}
```

electron-builder downloads the Electron binary matching `devDependencies.electron`
(42.5.0) on first build and caches it.

---

## 3. The `package.json` `build` config block

Add this top-level `"build"` key to `package.json`. It is the exact, complete block
needed for an NSIS Windows installer with the sidecars correctly unpacked:

```json
"build": {
  "appId": "com.atlas.station",
  "productName": "ATLAS Station",
  "directories": {
    "output": "dist"
  },
  "asarUnpack": [
    "fleethost.mjs",
    "ptyhost.cjs",
    "node_modules/@homebridge/node-pty-prebuilt-multiarch/**",
    "node_modules/@anthropic-ai/claude-agent-sdk/**"
  ],
  "win": {
    "target": ["nsis"]
  },
  "nsis": {
    "oneClick": false,
    "perMachine": false,
    "allowToChangeInstallationDirectory": true
  }
}
```

What each piece does:

- **`appId`** — reverse-DNS application identifier. Required; Windows uses it as the
  AppUserModelID (taskbar grouping, notifications).
- **`productName`** — human name and the installed `.exe` name. The window title is
  `ATLAS // station`, but `//` is not filename-safe, so `ATLAS Station` is used here.
- **`directories.output`** — where builds land. `dist/` is already in `.gitignore`.
  (`dist` is also electron-builder's default, but it is stated explicitly here.)
- **`asarUnpack`** — **the critical block.** Pulls the native pty, the Agent SDK, and
  both sidecar scripts out of the asar so the external `node.exe` and the native
  loader can reach them as real files. See §1 for why each entry is here.
- **`win.target`** — produce an NSIS installer (`.exe`). Default arch is `x64`.
- **`nsis`** — assisted installer: not one-click, per-user (no admin prompt), and the
  user may choose the install directory. Drop this block entirely for the default
  one-click installer.

> `files` is intentionally omitted. electron-builder's default (`**/*`) already
> bundles all root source files (`main.cjs`, `preload.cjs`, `fleethost.mjs`,
> `ptyhost.cjs`, `index.html`) plus production dependencies, and automatically
> excludes devDependencies (`electron`, `electron-builder`). Overriding `files`
> here would only add a foot-gun.

While editing `package.json`, also fill in the currently-empty `author` and
`description` fields — electron-builder derives the NSIS *publisher* string from
`author`, and warns when it is blank:

```json
"description": "ATLAS // station — oversight surface for an autonomous agent fleet",
"author": "Daniel <nexumcorpus@gmail.com>"
```

---

## 4. The build script

Add these to the `scripts` block (keep the existing `start`):

```json
"scripts": {
  "start": "electron .",
  "pack": "electron-builder --dir",
  "dist": "electron-builder --win nsis"
}
```

- **`pack`** — builds the unpacked app into `dist/win-unpacked/` **without** producing
  an installer. Fast; use it to sanity-check that the app launches and the sidecars
  spawn before committing to a full installer build.
- **`dist`** — builds the full NSIS installer.

---

## 5. REQUIRED source change in `main.cjs` (not yet applied)

`asarUnpack` puts the sidecar files on disk at `app.asar.unpacked/…`, but it does
**not** change the path string `main.cjs` hands to the external `node.exe`. Today
`main.cjs` does:

```js
fleet = spawn(NODE, [path.join(__dirname, "fleethost.mjs")], {
  cwd: __dirname, env: process.env, stdio: ["pipe", "pipe", "pipe", "ipc"],
});
```

When packaged, `__dirname` resolves **inside** the archive
(`…\resources\app.asar`). So:

- the spawn path becomes `…\app.asar\fleethost.mjs` — which the external `node.exe`
  cannot read (it's inside the archive), and
- `cwd: __dirname` points at `…\app.asar`, which the OS sees as a *file*, not a
  directory — the spawn fails before the script even runs.

Both must point at the **unpacked** tree. Rewrite `app.asar` → `app.asar.unpacked`
in the directory once, and use it for both the script path and `cwd`:

```js
// `.replace` is a no-op in dev (the dev path contains no "app.asar"),
// and redirects to the unpacked tree once packaged.
const SIDECAR_DIR = __dirname.replace("app.asar", "app.asar.unpacked");

fleet = spawn(NODE, [path.join(SIDECAR_DIR, "fleethost.mjs")], {
  cwd: SIDECAR_DIR, env: process.env, stdio: ["pipe", "pipe", "pipe", "ipc"],
});
```

Apply the same `SIDECAR_DIR` rewrite anywhere `ptyhost.cjs` is later spawned.

> Module resolution still works: a sidecar at
> `app.asar.unpacked/fleethost.mjs` resolves `@anthropic-ai/claude-agent-sdk` from
> `app.asar.unpacked/node_modules/…`, which is exactly where `asarUnpack` places it.

This change is **safe to ship in dev** (the `.replace` does nothing when there is no
`app.asar` in the path) and is **required** for the packaged build to function. It is
called out here rather than applied so the packaging work and the `main.cjs` change
can be reviewed separately.

---

## 6. The exact command

After adding the devDependency, the `build` block, and the scripts:

```bash
# one-time, if not already installed
npm install --save-dev electron-builder@^26

# fast sanity check — unpacked app, no installer
npm run pack

# the real deliverable — NSIS installer
npm run dist
```

Equivalent without the npm script:

```bash
npx electron-builder --win nsis
```

---

## 7. What you get

`npm run dist` produces, in `dist/`:

- **`ATLAS Station Setup 1.0.0.exe`** — the distributable NSIS installer (version from
  `package.json`).
- `win-unpacked/` — the unpacked app (what the installer installs), including
  `resources/app.asar` and `resources/app.asar.unpacked/` with the pty, the SDK, and
  the two sidecars as real files.
- `latest.yml` and `.blockmap` — auto-update metadata (only relevant if you wire up
  electron-updater; otherwise ignorable).

---

## 8. Runtime prerequisites & known limitations

Packaging produces a valid installer, but the app has **external runtime
dependencies that are not bundled**. On a clean target machine the installed app
will launch but the fleet/PTY sidecars will fail unless these exist:

- **System Node.js.** `main.cjs` runs the sidecars with
  `NODE_BIN || "C:\\Program Files\\nodejs\\node.exe"`. The target machine must have
  Node installed at that path, or `NODE_BIN` must be set. electron-builder does **not**
  bundle a standalone Node runtime. (Electron embeds its own Node, but these sidecars
  deliberately use external Node for a Node-24 ABI — see `ptyhost.cjs` header.)
- **The `claude` CLI.** `ptyhost.cjs` runs
  `CLAUDE_BIN || "C:\\Users\\dalea\\.local\\bin\\claude.exe"`, and the Agent SDK in
  `fleethost.mjs` shells out to the Claude Code CLI. Both require `claude` to be
  installed/authenticated on the target machine.
- **Hardcoded user paths.** The defaults above point into a specific user profile.
  For a real distributable these should be discovered at runtime or made
  configurable; otherwise the build only runs on a machine matching those paths.
- **Code signing.** The installer is unsigned. Windows SmartScreen will warn on first
  run. Signing requires a code-signing certificate configured via
  `win.certificateFile` / `CSC_LINK` (out of scope here).

These are flagged honestly: the electron-builder config in this doc is correct and
complete for *producing* the `.exe`, but a build that runs on an arbitrary machine
also needs the runtime-path issues above resolved.

---

## 9. Sanity-check checklist

1. `npm install --save-dev electron-builder@^26` — devDependency present.
2. `build` block added to `package.json` (§3), `author`/`description` filled in.
3. `pack`/`dist` scripts added (§4).
4. `main.cjs` `SIDECAR_DIR` rewrite applied (§5) — **required**.
5. `npm run pack`, then launch `dist/win-unpacked/ATLAS Station.exe` — window opens,
   and (with Node + `claude` present) the fleet sidecar reports `ready`.
6. Confirm `dist/win-unpacked/resources/app.asar.unpacked/node_modules/` contains
   `@homebridge/node-pty-prebuilt-multiarch` and `@anthropic-ai/claude-agent-sdk`,
   and that `fleethost.mjs` / `ptyhost.cjs` are present there as real files.
7. `npm run dist` — `ATLAS Station Setup 1.0.0.exe` appears in `dist/`.
