# Hunger Numbers — Patched Build (One-Click)

This bundle applies the fixes discussed:
- Movement click → server now receives `move-to` (was `pick-target`).
- Host receives LAN IPs and generates a proper LAN QR.
- Default timers are 5 seconds (overridable in Host UI).
- Single Host page (`/index.html`); `/host.html` redirects to `/`.
- Project is flattened for easier start-up.

## Run
1. Extract this folder.
2. In a terminal inside this folder, run:
   ```bash
   npm install
   npm start
   ```
3. Open **http://localhost:3000** for the Host.
4. Players scan the QR or browse to the shown LAN URL.

> If you prefer a different port, edit `server.js` accordingly.
