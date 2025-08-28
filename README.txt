Intersplice – Patched Server + SPA UI
====================================

Root:
- server.js        (patched: pre-game paint broadcast, center/Cornucore protection, legal-moves endpoint assumed)
- package.json     (scripts: start/dev/ui:dev/ui:build)

UI (Vite React app under /ui):
- Build output goes to ../public/ui so Express can serve /ui/ directly.

Dev quickstart:
1) npm i
2) cd ui && npm i
3) cd .. && npm run dev
4) Open http://localhost:3000/ui/host and http://localhost:3000/ui/join

SPA routes:
- /ui/join   -> joins, then /ui/verse -> /ui/exalted -> /ui/player
- /ui/host   -> host board + paint
- Player page shows Phase banner, Arena board, Number row, Leaderboard, Game Log.

Socket base auto-detects same-origin; override with ?server=http://LAN_IP:3000