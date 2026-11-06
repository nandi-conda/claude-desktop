'use strict';
// In-app updates for the Claude Desktop AppImage.
//
// build.sh packs this file into app.asar and points package.json "main" at it.
// It adds "Check for Updates…" to the app menu and the tray menu, checks once
// shortly after start-up (and every few hours), and updates the AppImage in
// place with the bundled appimageupdatetool (zsync delta download from the
// GitHub release). Then it loads the app's real entry point unchanged.
//
// Environment:
//   CLAUDE_APPIMAGE_DISABLE_UPDATES=1   no menu items, no checks
//   CLAUDE_APPIMAGE_NO_AUTO_CHECK=1     keep the menu item, skip background checks

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const electron = require('electron');

const pkg = require('./package.json');
const cfg = pkg.appimageUpdater || {};

const ITEM_ID = 'appimage-check-for-updates';
const FIRST_CHECK_MS = 30 * 1000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

const APPIMAGE = process.env.APPIMAGE;
const TOOL = process.env.APPDIR
  ? path.join(process.env.APPDIR, 'usr', 'lib', 'appimageupdatetool', 'AppRun')
  : null;

const enabled =
  !!APPIMAGE &&
  !!TOOL &&
  fs.existsSync(TOOL) &&
  process.env.CLAUDE_APPIMAGE_DISABLE_UPDATES !== '1';

function log(...args) {
  console.log('[appimage-updater]', ...args);
}

function runTool(args) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    // Let the tool's own AppRun work out its location; these describe ours.
    for (const k of ['APPIMAGE', 'APPDIR', 'ARGV0', 'OWD']) delete env[k];
    let out = '';
    let child;
    try {
      child = spawn(TOOL, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: -1, out: String(err) });
      return;
    }
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (err) => resolve({ code: -1, out: out + String(err) }));
    child.on('close', (code) => resolve({ code, out }));
  });
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

async function installUpdate() {
  notify('Downloading the Claude update…');
  const { code, out } = await runTool(['-r', APPIMAGE]);
  log('update exited with', code, '\n' + tail(out, 40));
  if (code !== 0) {
    await box({
      type: 'error',
      message: 'Update failed',
      detail: tail(out) || `appimageupdatetool exited with code ${code}`,
      buttons: ['OK'],
    });
    return;
  }
  const m = /(?:New file created|Updated existing file):?\s*(.+)\s*$/m.exec(out);
  installedPath = m && fs.existsSync(m[1].trim()) ? m[1].trim() : APPIMAGE;
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
    const { code, out } = await runTool(['-j', APPIMAGE]);
    log('check exited with', code);
    if (code === 0) {
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
    if (code !== 1) {
      log('check failed:\n' + tail(out, 40));
      if (interactive) {
        await box({
          type: 'error',
          message: "Couldn't check for updates",
          detail: tail(out) || `appimageupdatetool exited with code ${code}`,
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
        'The update downloads in the background (only the changed parts of the AppImage) and takes effect after a restart.',
      buttons: ['Update', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) {
      declinedThisSession = true;
      return;
    }
    await installUpdate();
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

// Application menu: into Help (or the first submenu) at the end.
function injectAppMenu(menu) {
  if (!menu || hasItem(menu)) return;
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
  if (!menu || hasItem(menu)) return;
  const idx = menu.items.findIndex((i) => i.role === 'quit' || /^(quit|exit)\b/.test(plain(i.label)));
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
