# VOLAR desktop

VOLAR for the shop's computers: a program of its own, installed like any other, that keeps
working when the internet drops.

## How it works

| | |
|---|---|
| **The screens** | The new admin (Volar-admin), built as a self-contained server (`npm run build:ui`), packaged inside the program and served by it at `volar://app`. They open with no internet at all. Inside the program the admin runs in **desktop mode** (Volar-admin `src/lib/desktop.ts`): it finds the bridge (`src/preload.js`, protocol 3) and adds the setup, sign-in and lock screens (Volar-admin `src/components/desktop`). |
| **The data** | The program calls the VOLAR API (`https://api.volar-eg.com/v1`, built in: `src/config.js`; a trailing `/v1` is dropped because the paths carry it) itself (`src/api.js`), with `X-Client-Type: desktop`, as whoever signed in. Their tokens are kept encrypted with Windows' protection in the program's data folder (`session.bin`); the screens never see them and no cookie is used. |
| **Setting it up** | First start: the program checks the server, then shows a big **setup QR** (good for 10 minutes, renewed by itself). A manager scans it with the VOLAR phone app and chooses the branch, a name, and **whether this computer is a cashier** (then the register: its till screen is made on it). Or **اربطه من هنا**: a settings administrator (or the owner) signs in on the computer itself (password, 2FA) and chooses the same; that sign-in is never written to disk and is signed out as soon as the computer is set up. The computer polls for its key (`/v1/auth/device/setup/claim`, with a poll secret that never leaves the program), keeps it encrypted in `config.json`, and shows the branch's sign-in screen. Right after the shop's first-time setup (a fresh shop: the setup comes first) the owner sets it up the same way. Every few minutes the computer asks the API who it is (`GET /v1/core/devices/me`): stopped or removed in the admin, it says so («الجهاز ده اتوقف من الإدارة») and goes back to the setup QR; **فك الربط** in its settings tells the server first (`POST /v1/core/devices/me/unpair`: stopped there, its sessions end, audited) and then forgets the key; a renamed branch or a new till screen (Settings → Devices → **خليه كاشير**) is picked up. |
| **Signing in** | The branch's sign-in screen shows a big QR (it changes every 2 minutes): scan it with the VOLAR phone app and approve, and the computer opens as you. Or **مفيش موبايل؟ اختار اسمك**: the branch's people (initials and names, a search when there are many), tap your name, type your password (and the 2FA code when it's on). The owner, who isn't on the list, uses **ادخل باسم المستخدم**. Password sign-ins carry the computer's key, so the API binds the session to this computer and refuses anyone not of its branch. A **cashier computer** opens straight on its own till screen; any other opens the admin's home (its till says «الجهاز ده مش كاشير»). **Lock** (the lock button at the top, on the till, or **Ctrl + L**) brings the sign-in screen back for the next cashier and ends that person's session on the server (retried when the connection is back). |
| **No internet** | When the API can't be reached the till works from what it saved and queues what it does; it's all sent when the API answers again (Volar-admin, the till's `offline.ts`). Signing in needs the internet. |
| **Printing** | Receipts and stickers go straight to the printers chosen on this computer (no dialog), on paper sized by the screen; with no printer chosen, the usual dialog. A4 papers (statements, transfer lists, a sticker sheet) show the dialog. |
| **Fingerprint device** | The shop's internet has no fixed or public address, so the ZKTeco device pushes (iclock/ADMS) to the **cashier computer** on the shop's network and the program passes it on (`src/iclock-relay.js`): it listens on `0.0.0.0:8081` (port in the settings) while a device is linked to this computer in the admin (Attendance → أجهزة البصمة → «عن طريق كمبيوتر الكاشير») or **استقبل البصمة من الجهاز** is on; serves only `/iclock/*` (404 otherwise, GET/POST, body ≤ 2 MB) and only to private addresses (10/8, 172.16/12, 192.168/16, 127.0.0.1); forwards each request as it came to `/v1/attendance/iclock-relay/<path>` with **this computer's key** and the device's LAN address (`X-Iclock-Device-Ip`), and returns the API's status and text verbatim (no answer: 503, so the device keeps its punches). The settings show the addresses to type in the device, when it last called, and the Windows firewall state: a rule `VOLAR fingerprint device` (this program, TCP port, local subnet) is added on first start when Windows allows it without an administrator, otherwise **افتح البورت في الجدار الناري** asks Windows once (UAC). Test: `npm run test:relay` (a fake API). Guide: Volar `docs/guide/fingerprint-device.md`. |
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
3. The program shows a setup QR: scan it with the VOLAR phone app (or press **اربطه من هنا** and sign in as a settings administrator), choose the branch, a name, whether it is a cashier, and the register. From then on the computer shows the branch's sign-in screen (the phone QR, or a name from the list and its password).
4. Upgrading from 0.5.x (the old system): the computer starts as new and is set up once with the QR. From 0.6.x it stays set up (a computer with a till screen counts as a cashier).

Keys: **Ctrl + R** reload (F1–F10 and Esc belong to the till) · **F11** full screen · **Ctrl + L** lock · **Ctrl + Shift + S** settings (printers, kiosk, start with Windows, updates, unpair).

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
  sessions or the device key, or need its key (sign-in QR claim, setup QR and its claim, the staff
  list, signing in from the list) are the program's own; the screens get answers without tokens.
- The device key goes only to the device routes (who am I, the sign-in QR, the staff list, signing in
  from it) and to the password sign-in (`/v1/auth/login`, so the API binds the session to this
  computer), never with the screens' other requests.
- The setup QR's poll secret never leaves the program; its id and secret are only in the QR.
- Plain `http://` is accepted only for `localhost` (development).
- The fingerprint relay listens on the shop's network, but takes only private addresses and only `/iclock/*`; it sends the computer's key only to the API's relay routes, and the API takes a device's punches through it only for a device linked to this very computer.
