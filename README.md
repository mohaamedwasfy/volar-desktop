# VOLAR desktop

VOLAR for the shop's computers: a program of its own, installed like any other, that keeps
working when the internet drops.

## How it works

| | |
|---|---|
| **The screens** | Packaged inside the program (a production build of Volar-admin) and served by the program itself at `volar://app`. They open with no internet at all. |
| **The data** | The program calls the VOLAR API (`https://nnlqcfqvk6juiacdncat1el4.storiza.store/v1`, built in: `src/config.js`) itself (`src/api.js`), signed in as an app. Its tokens are kept encrypted with Windows' protection in the program's data folder; the screens never see them. |
| **No internet** | Every answer is also saved on the computer. When the API can't be reached (or answers that its database can't be: the API notices a silent database line within seconds and says so at once), the screens work from the saved copy, the till prices baskets itself, and sales, held bills, returns and drawer expenses go into a queue. When the API answers again the queue is sent in order (each sale dated when it happened) and everything is fetched fresh. That part lives in Volar-admin, `src/lib/offline`. |
| **Signing in** | The lock screen shows a QR: scan it with the VOLAR phone app ("ادخل على كمبيوتر الفرع") and confirm, and the computer opens as you. Each QR works once, for two minutes, and only for staff of this computer's branch the owner chose. Without internet, or by choice, the names and PINs. A PIN works offline only after it was used once on this computer with the internet on. |
| **Printing** | Receipts and labels go straight to the printers chosen on this computer. |
| **Icon** | The phone app's VOLAR icon (`build/icon.ico`, made from Volar-app `assets/icon.png`, corners rounded). |
| **Updates** | From this repo's GitHub Releases, downloaded in the background, installed when the program closes. |

The program only ever shows its own screens; links to anything else open in the browser.

## Developing

```bash
npm install
npm run dev               # the dashboard's dev server (localhost:3002) + the API on localhost:4000
npm run build:ui          # packages the screens from ../Volar-admin into ./ui
npm run dev:packaged-ui   # the packaged screens + the API on localhost:4000
npm run dist              # build:ui + the Windows installer: dist/VOLAR Setup <version>.exe
```

`--profile=<name>` gives a run its own data folder (`%APPDATA%\VOLAR-<name>`), so it never
clashes with an installed VOLAR. If `npm install` didn't download Electron itself
(no `node_modules/electron/dist`), run `node node_modules/electron/install.js`.

## On a branch computer

1. Run `VOLAR Setup <version>.exe` (without a code-signing certificate Windows says
   "unknown publisher": **More info → Run anyway**).
2. The printers are chosen in the settings. Settings any time: **Ctrl + Shift + S**, or the screen icon at the top.
3. The owner signs in once and chooses the branch and the staff. From then on the lock screen shows the phone QR (online) or the names and PINs.

Keys: **F5** reload · **F11** full screen · **Ctrl + Shift + S** settings.

## Publishing a version

```bash
npm version patch
git push origin main --follow-tags
```

The tag runs `.github/workflows/release.yml`, which builds the installer and publishes the
release; installed programs pick it up by themselves. The workflow needs to check out
Volar-admin (`mohaamedwasfy/volar-dashboard`) to package the screens: give it a token
(`ADMIN_REPO_TOKEN` secret) if that repo is private. The releases can be downloaded by the
programs only from a **public** repo (or a separate public releases repo, see `publish`).

## Security

- The screens have no access to Node or Electron (`contextIsolation`, `sandbox`); the bridge
  (`preload.js`) answers only the program's own screens.
- The screens can't set who is calling: the program adds the token and drops any
  `Authorization`, cookie or origin header they send.
- Plain `http://` is accepted only for `localhost` (development).
