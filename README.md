# VOLAR desktop

VOLAR for the shop's computers: the dashboard and the till in their own window, printing
receipts and barcode labels straight to the branch's printers.

It is a thin, locked-down Electron window around the **hosted dashboard** (Volar-admin).
Every change deployed to the dashboard reaches every branch at once; the app itself only
needs a new version for things that touch the computer (printers, the window).

## Running it

```bash
npm install
npm run dev        # opens http://localhost:3002 (the dashboard's dev server)
npm start          # uses the address saved in this computer's settings
npm run dist       # builds the Windows installer: dist/VOLAR Setup <version>.exe
```

If `npm install` didn't download Electron itself (no `node_modules/electron/dist`), run
`node node_modules/electron/install.js`.

## On a branch computer

1. Run `VOLAR Setup <version>.exe`. Without a code-signing certificate Windows shows
   "unknown publisher": **More info → Run anyway**.
2. The first start opens **إعدادات الجهاز**: the dashboard's address, the receipt printer and
   the label printer (with a test print for each), full screen, start with Windows.
3. Open the settings again any time with **Ctrl + Shift + S**, or the screen icon next to
   the name at the top of the dashboard.

Settings live in `%APPDATA%\VOLAR\config.json` (nothing secret in it).

Keys: **F5** reload · **F11** full screen · **Ctrl + Shift + S** settings.

## What the dashboard gets (`window.volarDesktop`)

| | |
|---|---|
| `info()` | app version, this computer's id, whether a receipt / label printer is set |
| `print("receipt" \| "labels" \| "page")` | prints the page as its print styles lay it out; receipts and labels go to their printer with no dialog (the dialog when none is set); `page` always shows the dialog |
| `openSettings()` | this computer's settings window |

In a normal browser `window.volarDesktop` isn't there and the dashboard falls back to
`window.print()` (`src/lib/desktop.ts` in Volar-admin).

## Updates

The installed app checks this repo's **GitHub Releases** when it starts and every 4 hours.
A new version downloads in the background and installs when VOLAR closes (never in the
middle of a sale); **إعدادات الجهاز** shows it and can install it right away.

To publish a version:

```bash
npm version patch          # 0.1.0 → 0.1.1 (package.json + a git tag)
git push origin main --follow-tags
```

The tag starts `.github/workflows/release.yml`, which builds the installer on GitHub and
publishes the release. Nothing to upload by hand.

**The repo must be public for the apps to download releases.** A private repo's releases
need a GitHub token inside every installed app, which would let anyone with the app read
the repo. If the code should stay private, publish releases to a second, public repo
(`volar-desktop-releases`) instead: change `publish.repo` in package.json.

## Security

- The window shows only the dashboard's own address. Other links open in the normal browser.
- The page has no access to Node or Electron (`contextIsolation`, `sandbox`); the bridge
  answers only frames from the dashboard's address.
- Plain `http://` is accepted only for `localhost` (development).
- No permission is granted to the page except copying text.

## Not yet

- **Cash drawer:** most thermal printer drivers can open the drawer on every receipt
  (a "cash drawer" option in the printer's Windows settings). Direct control comes when
  the printer models are known.
- **App icon:** the default Electron icon until there's a 256×256 `.ico`.
- **QR sign-in at the till:** the computer's id (`deviceId`) is the base for it.
