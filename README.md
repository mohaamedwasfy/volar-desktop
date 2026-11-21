# VOLAR desktop

VOLAR for the shop's computers: a program of its own, installed like any other, that keeps
working when the internet drops.

## How it works

| | |
|---|---|
| **The screens** | The new admin (Volar-admin), built as a self-contained server (`npm run build:ui`), packaged inside the program and served by it at `volar://app`. They open with no internet at all. Inside the program the admin runs in **desktop mode** (Volar-admin `src/lib/desktop.ts`): it finds the bridge (`src/preload.js`) and adds the pairing, sign-in and lock screens (Volar-admin `src/components/desktop`). |
| **The data** | The program calls the VOLAR API (`https://nnlqcfqvk6juiacdncat1el4.storiza.store`, built in: `src/config.js`; the paths carry `/v1`) itself (`src/api.js`), with `X-Client-Type: desktop`, as whoever signed in. Their tokens are kept encrypted with Windows' protection in the program's data folder (`session.bin`); the screens never see them and no cookie is used. |
| **Pairing** | First start: the program checks the server, then shows a **6-character code** for 5 minutes. An admin types it in **Settings → Devices → اربط كمبيوتر** (or approves it from the phone), choosing the branch, a name and the register. The computer then collects its device key by itself (once) and keeps it encrypted in `config.json`. Right after the shop's first-time setup (a fresh shop: the setup comes first), the owner can pair it on the same screen. Every few minutes the computer asks the API who it is (`GET /v1/core/devices/me`): stopped or removed in the admin, it goes back to the code; a renamed branch or a new till screen is picked up. |
| **Signing in** | The branch's sign-in screen shows a big QR (it changes every 2 minutes): scan it with the VOLAR phone app and approve, and the computer opens as you. Or **ادخل بكلمة المرور** (with the 2FA code when it's on). Only staff of this computer's branch get in (the owner and all-branch staff anywhere); anyone else is refused with the reason. The till opens straight on this computer's register. **Lock** (the lock button at the top, on the till, or **Ctrl + L**) brings the sign-in screen back for the next cashier. |
| **No internet** | When the API can't be reached the till works from what it saved and queues what it does; it's all sent when the API answers again (Volar-admin, the till's `offline.ts`). Signing in needs the internet. |
| **Printing** | Receipts and stickers go straight to the printers chosen on this computer (no dialog), on paper sized by the screen; with no printer chosen, the usual dialog. A4 papers (statements, transfer lists, a sticker sheet) show the dialog. |
| **Icon** | The phone app's VOLAR icon (`build/icon.ico`, made from Volar-app `assets/icon.png`, corners rounded). |
| **Updates** | From this repo's GitHub Releases, downloaded in the background, installed when the program closes. |

The program only ever shows its own screens; links to anything else open in the browser.

## Developing

```bash
npm install
npm run build:ui          # packages the screens from ../Volar-admin into ./ui (its build goes to .next-desktop)
npm run dev:packaged-ui   # the packaged screens + the API on localhost:4200
npm run dev               # an admin already running on localhost:3200 (next start) + the API on localhost:4200
npm run dist              # build:ui + the Windows installer: dist/VOLAR Setup <version>.exe
```

`--profile=<name>` gives a run its own data folder (`%APPDATA%\VOLAR-<name>`), so it never
clashes with an installed VOLAR. If `npm install` didn't download Electron itself
(no `node_modules/electron/dist`), run `node node_modules/electron/install.js`.

## On a branch computer

1. Run `VOLAR Setup <version>.exe` (without a code-signing certificate Windows says
   "unknown publisher": **More info → Run anyway**).
2. The printers are chosen in the settings. Settings any time: **Ctrl + Shift + S**, or the screen icon at the top.
3. The program shows a 6-character code: in the admin open **Settings → Devices → اربط كمبيوتر**, type it, choose the branch and the register. From then on the computer shows the branch's sign-in screen (the phone QR, or the password).
4. Upgrading from 0.5.x (the old system): the computer starts as new and is paired once with a code.

Keys: **F5** reload · **F11** full screen · **Ctrl + L** lock · **Ctrl + Shift + S** settings (printers, kiosk, start with Windows, updates, unpair).

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
  `Authorization`, cookie, device-key or origin header they send. The routes that hand out
  sessions or the device key (QR claim, pairing) are the program's own; the screens get answers
  without tokens.
- The device key goes only to the device routes (who am I, the sign-in QR), never with the
  screens' requests.
- Plain `http://` is accepted only for `localhost` (development).
