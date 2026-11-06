'use strict';
// In-app updates for the Claude Desktop AppImage.
//
// build.sh packs this file into app.asar and points package.json "main" at it.
// It wires "Check for Updates…" in the app and tray menus to the AppImage
// release, checks shortly after start-up (and every few hours), and replaces
// the AppImage file in place. Then it loads the app's real entry point.
//
// The release's .zsync file is the update feed: its header has the SHA-1 and
// file name of the latest AppImage. The release server doesn't serve range
// requests, so an update is a whole-file download checked against that SHA-1.
//
// Environment:
//   CLAUDE_APPIMAGE_DISABLE_UPDATES=1   no menu items, no checks
//   CLAUDE_APPIMAGE_NO_AUTO_CHECK=1     keep the menu item, skip background checks

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const electron = require('electron');

const pkg = require('./package.json');
const cfg = pkg.appimageUpdater || {};

const ITEM_ID = 'appimage-check-for-updates';
const FIRST_CHECK_MS = 30 * 1000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const UA = 'claude-desktop-appimage-updater';

const APPIMAGE = process.env.APPIMAGE;

const enabled = !!APPIMAGE && !!cfg.zsyncUrl && process.env.CLAUDE_APPIMAGE_DISABLE_UPDATES !== '1';

// Straight to fd 2: the app redirects console and process.stderr to its own logger.
function log(...args) {
  const text = args.map((a) => (typeof a === 'string' ? a : require('util').inspect(a))).join(' ');
  try {
    fs.writeSync(2, `[appimage-updater] ${text}\n`);
  } catch (_) {
    /* no stderr */
  }
}

async function get(url) {
  const res = await electron.net.fetch(url, { headers: { 'User-Agent': UA }, cache: 'no-store' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

// { sha1, url } of the latest AppImage, from the .zsync header.
async function latest() {
  const res = await get(cfg.zsyncUrl);
  const head = Buffer.from(await res.arrayBuffer()).subarray(0, 4096).toString('latin1');
  const sha1 = (/^SHA-1:\s*([0-9a-f]{40})\s*$/im.exec(head) || [])[1];
  const file = (/^URL:\s*(\S+)\s*$/im.exec(head) || [])[1];
  if (!sha1 || !file) throw new Error(`${cfg.zsyncUrl} has no SHA-1 or URL`);
  return { sha1: sha1.toLowerCase(), url: new URL(file, cfg.zsyncUrl).href };
}

let ownHash = null; // { key, sha1 } of the AppImage file, so it's hashed once per change
function sha1File(file) {
  const st = fs.statSync(file);
  const key = `${st.size}:${st.mtimeMs}:${st.ino}`;
  if (ownHash && ownHash.key === key) return Promise.resolve(ownHash.sha1);
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => {
        ownHash = { key, sha1: h.digest('hex') };
        resolve(ownHash.sha1);
      });
  });
}

async function download({ sha1, url }) {
  const tmp = `${APPIMAGE}.download`;
  const res = await get(url);
  if (!res.body) throw new Error(`${url}: empty response`);
  const hash = crypto.createHash('sha1');
  const fd = fs.openSync(tmp, 'w', 0o755);
  try {
    for await (const chunk of res.body) {
      const buf = Buffer.from(chunk);
      hash.update(buf);
      fs.writeSync(fd, buf);
    }
  } catch (err) {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  fs.closeSync(fd);
  const got = hash.digest('hex');
  if (got !== sha1) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`checksum mismatch (expected ${sha1}, got ${got})`);
  }
  fs.chmodSync(tmp, fs.statSync(APPIMAGE).mode & 0o7777 || 0o755);
  // rename() swaps the file atomically; the running copy keeps its old inode.
  fs.renameSync(tmp, APPIMAGE);
  return APPIMAGE;
}

function tail(text, lines = 12) {
  return String(text).trim().split('\n').slice(-lines).join('\n');
}

function parentWindow() {
  const { BrowserWindow } = electron;
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows().find((w) => w.isVisible());
  return win || undefined;
}

async function box(options) {
  const win = parentWindow();
  const opts = { title: 'Claude', noLink: true, ...options };
  return win ? electron.dialog.showMessageBox(win, opts) : electron.dialog.showMessageBox(opts);
}

function notify(body) {
  try {
    if (electron.Notification.isSupported()) {
      new electron.Notification({ title: 'Claude', body, silent: true }).show();
    }
  } catch (_) {
    /* notifications are best-effort */
  }
}

let busy = false;
let declinedThisSession = false;
let installedPath = null;

async function promptRestart() {
  const { response } = await box({
    type: 'info',
    message: 'Update installed',
    detail: 'Restart Claude to start using the new version.',
    buttons: ['Restart Now', 'Later'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return;
  const { app } = electron;
  app.relaunch({ execPath: installedPath || APPIMAGE, args: [] });
  app.quit();
  // Claude may keep running in the tray when its windows close; make sure we exit.
  setTimeout(() => app.exit(0), 3000).unref();
}

async function installUpdate(target) {
  notify('Downloading the Claude update…');
  try {
    installedPath = await download(target);
    log('installed', installedPath);
  } catch (err) {
    log('update failed:', err);
    await box({
      type: 'error',
      message: 'Update failed',
      detail: String((err && err.message) || err),
      buttons: ['OK'],
    });
    return;
  }
  await promptRestart();
}

async function checkForUpdates({ interactive }) {
  if (!enabled) return;
  if (installedPath) {
    if (interactive) await promptRestart();
    return;
  }
  if (busy) return;
  busy = true;
  try {
    let target;
    let current;
    try {
      target = await latest();
      current = await sha1File(APPIMAGE);
    } catch (err) {
      log('check failed:', err);
      if (interactive) {
        await box({
          type: 'error',
          message: "Couldn't check for updates",
          detail: String((err && err.message) || err),
          buttons: ['OK'],
        });
      }
      return;
    }
    log('check: have', current, 'latest', target.sha1);
    if (current === target.sha1) {
      if (interactive) {
        await box({
          type: 'info',
          message: "You're up to date",
          detail: cfg.version ? `Claude ${cfg.version} is the latest version.` : 'This is the latest version.',
          buttons: ['OK'],
        });
      }
      return;
    }
    if (!interactive && declinedThisSession) return;
    const { response } = await box({
      type: 'info',
      message: 'A new version of Claude is available',
      detail:
        'Claude downloads the update in the background. It takes effect after a restart.',
      buttons: ['Update', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) {
      declinedThisSession = true;
      return;
    }
    await installUpdate(target);
  } catch (err) {
    log('error:', err);
  } finally {
    busy = false;
  }
}

function makeItem() {
  return new electron.MenuItem({
    id: ITEM_ID,
    label: 'Check for Updates…',
    click: () => checkForUpdates({ interactive: true }),
  });
}

function hasItem(menu) {
  try {
    return !!menu.getMenuItemById(ITEM_ID);
  } catch (_) {
    return false;
  }
}

const plain = (label) => String(label || '').replace(/&/g, '').trim().toLowerCase();

// The app ships its own "Check for Updates…" (it only says to use apt on
// Linux). Point it at the AppImage updater instead of adding a second one.
function takeOverExisting(menu, depth = 0) {
  let found = false;
  for (const item of menu.items) {
    if (item.id !== ITEM_ID && /^check for updates/.test(plain(item.label))) {
      item.click = () => checkForUpdates({ interactive: true });
      item.enabled = true;
      item.visible = true;
      found = true;
    }
    if (item.submenu && depth < 3 && takeOverExisting(item.submenu, depth + 1)) found = true;
  }
  return found;
}

// Application menu: into Help (or the first submenu) at the end.
function injectAppMenu(menu) {
  if (!menu || hasItem(menu) || takeOverExisting(menu)) return;
  const items = menu.items;
  const target =
    items.find((i) => i.submenu && (i.role === 'help' || plain(i.label) === 'help')) ||
    items.find((i) => i.submenu);
  const sub = target ? target.submenu : menu;
  if (sub.items.length) sub.append(new electron.MenuItem({ type: 'separator' }));
  sub.append(makeItem());
}

// Tray menu: just above Quit, or at the end.
function injectTrayMenu(menu) {
  if (!menu || hasItem(menu) || takeOverExisting(menu)) return;
  let idx = menu.items.findIndex((i) => i.role === 'quit' || /^(quit|exit)\b/.test(plain(i.label)));
  // Keep Quit in its own group: go above the separator before it.
  if (idx > 0 && menu.items[idx - 1].type === 'separator') idx -= 1;
  if (idx >= 0) menu.insert(idx, makeItem());
  else menu.append(makeItem());
}

function patch(obj, name, inject) {
  const orig = obj && obj[name];
  if (typeof orig !== 'function') return;
  obj[name] = function (menu, ...rest) {
    try {
      inject(menu);
    } catch (err) {
      log(`could not add menu item in ${name}:`, err);
    }
    return orig.call(this, menu, ...rest);
  };
}

if (enabled) {
  patch(electron.Menu, 'setApplicationMenu', injectAppMenu);
  if (electron.Tray) patch(electron.Tray.prototype, 'setContextMenu', injectTrayMenu);

  electron.app.whenReady().then(() => {
    // Electron's default menu (the app never called setApplicationMenu) doesn't
    // pass through the patched setter. A null menu means the app hid the menu
    // bar on purpose, so leave that alone; the tray item and the start-up check
    // still work.
    setTimeout(() => {
      const menu = electron.Menu.getApplicationMenu();
      if (menu && !hasItem(menu)) electron.Menu.setApplicationMenu(menu);
    }, 2000).unref();
    if (process.env.CLAUDE_APPIMAGE_NO_AUTO_CHECK !== '1') {
      setTimeout(() => checkForUpdates({ interactive: false }), FIRST_CHECK_MS).unref();
      setInterval(() => checkForUpdates({ interactive: false }), CHECK_EVERY_MS).unref();
    }
  });
}

// Hand over to the app's real entry point.
const entry = path.join(__dirname, cfg.originalMain || 'index.js');
try {
  require(entry);
} catch (err) {
  if (err && err.code === 'ERR_REQUIRE_ESM') {
    import(pathToFileURL(entry).href).catch((e) => {
      console.error(e);
      electron.app.exit(1);
    });
  } else {
    throw err;
  }
}
