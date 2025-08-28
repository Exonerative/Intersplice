/* server.js — Intersplice / Hunger Numbers — patched for Fix Pack v0.10
 * ESM module (package.json should have "type":"module")
 */
import express from "express";
import http from "http";
import { Server } from "socket.io";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ------------------------------------------------------------------
// Static
// ------------------------------------------------------------------
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR));
app.use("/assets", express.static(path.join(PUBLIC_DIR, "ui", "assets")));
// React SPA (built by Vite) is served under /ui/
app.get("/ui/*", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "ui", "index.html")));
// Legacy fallbacks (optional)
app.get("/", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
app.get("/player", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "player.html")));
// LAN base URL for Host/QR
app.get("/api/lan-url", (req, res)=>{
  try{
    const addrs = getLanAddresses();
    const port = (process.env.PORT || 3000);
    const base = addrs && addrs.length ? `http://${addrs[0]}:${port}` : `http://localhost:${port}`;
    res.json({ addrs, base });
  }catch(e){
    res.json({ addrs: [], base: `http://localhost:${process.env.PORT||3000}` });
  }
});

// Legacy paths → React UI
app.get(['/host','/player','/join','/join.htm'], (req, res) => {
  if (req.path.includes('host')) return res.redirect('/ui/host');
  if (req.path.includes('join')) return res.redirect('/ui/join');
  return res.redirect('/ui/player');
});

// Generate a QR (302 redirect to a QR service)
app.get("/api/join-qr", (req, res)=>{
  const room = String(req.query.room || "default").slice(0,64);
  const port = (process.env.PORT || 3000);
  const addrs = getLanAddresses();
  const base = addrs && addrs.length ? `http://${addrs[0]}:${port}` : `http://localhost:${port}`;
  const url = `${base}/ui/join?room=${encodeURIComponent(room)}`;
  const qr = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(url)}`;
  res.redirect(qr);
});


// ------------------------------------------------------------------
// Config
// ------------------------------------------------------------------
const DEFAULT_BOARD_SIZE = 10;
const MAX_NUMBER = 6;
const REFRESH_INTERVAL = 6;                            // rounds between refresh waves
const DEFAULT_DURATIONS = { number: 5000, movement: 5000, resolution: 10000, refresh: 5000 };
const BUFF_TYPES = ["SWORD","SHIELD","WARP","RENOWN_CHIP", "SPEED" ]; // center tile uses SPACETIME_SEAL
const REFRESH_SPAWN_TYPES = ['SWORD','SHIELD','RENOWN_CHIP','SPEED']; // refresh spawns: sword, shield, chip, lightning (no WARP, no SEAL)
const PAINTABLE_TYPES = ['SWORD','SHIELD','RENOWN_CHIP','SPEED']; // host may only paint these (SEAL only at center)

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
// Board edge tiles (for respawn options)
function edgeTilesOfBoard(size){
  const out = [];
  const last = Math.max(0, (size|0) - 1);
  for (let x=0; x<=last; x++){ out.push({x, y:0}); out.push({x, y:last}); }
  for (let y=1; y<last; y++){ out.push({x:0, y}); out.push({x:last, y}); }
  return out;
}

// Cornucore ring (16 tiles = perimeter of the 5x5 inner area)
function ring16TilesCornucore(cc){
  if (!cc || !cc.center) return [];
  const cx = cc.center.x, cy = cc.center.y;
  const r = 2;
  const out = [];
  for (let x = cx - r; x <= cx + r; x++){ out.push({ x, y: cy - r }); out.push({ x, y: cy + r }); }
  for (let y = cy - r + 1; y <= cy + r - 1; y++){ out.push({ x: cx - r, y }); out.push({ x: cx + r, y }); }
  return out;
}

// Tile formatting for logs: (row#, col-letter) e.g., (5,c)
function fmtTile(x,y){ const row = (y|0) + 1; const col = String.fromCharCode('a'.charCodeAt(0) + (x|0)); return `(${row},${col})`; }
function fmtTileFromKey(k){ const {x,y} = fromKey(k); return fmtTile(x,y); }

const key = (x,y)=>`${x},${y}`;
const fromKey = k => { const [x,y]=k.split(",").map(Number); return {x,y}; };
const manhattan = (a,b)=>Math.abs(a.x-b.x)+Math.abs(a.y-b.y);
const clamp = (n,min,max)=>Math.max(min,Math.min(max,n));

function getLanAddresses(){
  const nets = os.networkInterfaces();
  const all = [];
  for (const name of Object.keys(nets)){
    for (const n of nets[name]||[]){
      if (n.family === "IPv4" && !n.internal) all.push(n.address);
    }
  }
  const isPrivate = ip => ip.startsWith("192.168.") || ip.startsWith("10.") || /^172\.(1[6-9]|2\\d|3[0-1])\\./.test(ip);
  return all.filter(isPrivate).concat(all.filter(ip=>!isPrivate(ip)));
}

function shuffle(arr){
  const a = arr.slice();
  for (let i=a.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]] = [a[j],a[i]];
  }
  return a;
}

function makeCornucore(size){
  const center = { x: Math.floor(size/2), y: Math.floor(size/2) };
  const half = 2; // 5x5
  return { center, minX: center.x-half, maxX: center.x+half, minY: center.y-half, maxY: center.y+half };
}
const inCornucore = (x,y,cc)=> x>=cc.minX && x<=cc.maxX && y>=cc.minY && y<=cc.maxY;
const isCenter = (x,y,cc)=> x===cc.center.x && y===cc.center.y;
// 5x5 Inner Sanctum checker (global). Keep in helpers scope for all callers.
function isInnerSanctum(x, y, cc){
  if (!cc || !cc.center) return false;
  const cx = cc.center.x, cy = cc.center.y;
  const r = 1; // 3x3 radius (middle nine tiles only)
  return x >= cx - r && x <= cx + r && y >= cy - r && y <= cy + r;
}


// ------------------------------------------------------------------
// Data structures
// ------------------------------------------------------------------
class Player {
  constructor(id, name, color){
    this.id = id;
    this.name = (name || `P${id.slice(0,4)}`).slice(0,24);
    this.color = color || "#00aaff";
    this.isAlive = true;
    this.isSponsor = false;
    this.pos = null;
    this.vp = 0;
    this.vpDelta = 0;
    this.kills = 0;
    this.usedNumbers = new Set();
    this.selectedNumber = null;
    this.lastRevealedNumber = null;
    this.movementTarget = null;
    this.buff = null;            // "SWORD"|"SHIELD"|"WARP"|"RENOWN_CHIP"|null
    this.cornucopia = false;
    this.hasShield = false;
    this.pendingBounty = false;  // next kill double
    this.speedSteps = 2;         // default 2; SPEED -> 3
    this.sponsorTargetId = null; // when sponsor
    this.clientId = null;        // reconnect token from client
    this.pin = ("" + (1000 + Math.floor(Math.random()*9000)));
    this.connected = true;
  }
}

class Game {
  constructor(room){
    this.room = room;
    this.hostId = null;
    this.players = {};        // socketId -> Player
    this.joinOrder = [];      // deterministic tiebreaks
    this.size = DEFAULT_BOARD_SIZE;
    this.cc = makeCornucore(this.size);
    this.board = { fire: new Set(), buffs: new Map() }; // Set<"x,y">, Map<"x,y","BUFF"> (SPACETIME_SEAL special)
    this.phase = "pregame";
    this.round = 0;
    this.timerEnd = 0;
    this.durations = { ...DEFAULT_DURATIONS };
    this.interval = null;
    this.gameLog = [];
    this.paused = false;
    this.pauseLeft = 0;
    this.endReason = null;

// Host-configurable settings
this.settings = {
  firesPerRefresh: 5,
  buffsPerRefresh: 5,
  showPhaseTimer: true,
  phaseDurations: { number: 5, movement: 5, resolution: 10 },
  centerTileVP: 0,
  refreshEvery: REFRESH_INTERVAL,  // 6

  // Scoring
  eliminationVP: 10,          // flat per elimination (combat)
  renownChipVP: 5,            // coin pickup

  // VP sources (per round)
  survivalPerRoundEnabled: true,
  survivalPerRoundVP: 1,
  innerSanctumEnabled: true,
  innerSanctumVP: 2
};
this.refreshIndex = 0;

this.recomputeDurations = () => {
  const pd = this.settings.phaseDurations || {};
  this.durations = {
    number: Math.max(0, (pd.number ?? 5)) * 1000,
    movement: Math.max(0, (pd.movement ?? 5)) * 1000,
    resolution: Math.max(0, (pd.resolution ?? 5)) * 1000,
    refresh: 3000
  };
};
this.recomputeDurations();

  }

  log(msg){
    const ts = new Date().toLocaleTimeString();
    this.gameLog.push(`[${ts}] ${msg}`);
    this.gameLog = this.gameLog.slice(-500);
  }

  // ---------------- Config ----------------
  setDurations(d){
    const norm = (v, fallback) => {
      let n = Number(v); if (!Number.isFinite(n)) return fallback;
      if (n <= 60) n = n * 1000;                      // allow seconds
      return clamp(n, 500, 600000);
    };
    if (!d) return;
    this.durations = {
      number: norm(d.number, this.durations.number),
      movement: norm(d.movement, this.durations.movement),
      resolution: norm(d.resolution, this.durations.resolution),
      refresh: norm(d.refresh, this.durations.refresh),
    };
  }

  setSize(n){
    const s = clamp(Number(n)||DEFAULT_BOARD_SIZE, 8, 64);
    this.size = s;
    this.cc = makeCornucore(this.size);

    // purge OOB fire/buffs
    this.board.fire = new Set(Array.from(this.board.fire).filter(k => {
      const {x,y} = fromKey(k);
      return x>=0 && y>=0 && x<this.size && y<this.size;
    }));
    this.board.buffs = new Map(Array.from(this.board.buffs.entries()).filter(([k]) => {
      const {x,y} = fromKey(k);
      return x>=0 && y>=0 && x<this.size && y<this.size;
    }));

    // Ensure SPACETIME_SEAL at the center if no one holds it
    const ck = key(this.cc.center.x, this.cc.center.y);
    if (![...Object.values(this.players)].some(p=>p.cornucopia)) {
      this.board.buffs.set(ck, "SPACETIME_SEAL");
    }
    this.broadcastState();
  }

  // ---------------- Spawns ----------------
  spawnPosition(){
    // Edge candidates, avoid Cornucore, fire, and existing occupied locations.
    const candidates = [];
    for (let x=0;x<this.size;x++){ candidates.push({x, y:0}, {x, y:this.size-1}); }
    for (let y=1;y<this.size-1;y++){ candidates.push({x:0, y}, {x:this.size-1, y}); }
    const occupied = new Set(Object.values(this.players).filter(p=>p.isAlive && !p.isSponsor && p.pos).map(p=>key(p.pos.x,p.pos.y)));
    const open = candidates.filter(p => !inCornucore(p.x,p.y,this.cc) && !this.board.fire.has(key(p.x,p.y)) && !occupied.has(key(p.x,p.y)));
    if (!open.length) return {x:0, y:0};
    const assigned = this.joinOrder.map(id => this.players[id]).filter(Boolean).map(p=>p.pos).filter(Boolean);
    const scored = open.map(c=> ({ c, score: assigned.length===0 ? 9999 : Math.min(...assigned.map(a=>manhattan(a,c))) }));
    scored.sort((a,b)=>b.score-a.score);
    return scored[0].c;
  }

  // ---------------- Lifecycle ----------------
  startGame({size}={}){
    if (size) this.setSize(size);            // recenter Cornucore
    this.phase = "number";
    this.round = 1;
    this.timerEnd = Date.now() + this.durations.number;
    this.startTicker();
    this.log(`Game started (${this.size}x${this.size}).`);
    this.broadcastState();
  }

  endGame(reason){
    this.phase = "gameover";
    this.timerEnd = Date.now();
    this.stopTicker();
    const lb = this.leaderboard();
    const winner = lb[0] || null;
    if (winner){
      this.log(`Winner by VP: ${winner.name} (${winner.vp} VP)`);
    } else {
      this.log("Winner by VP: —");
    }
    this.endReason = reason || this.endReason || null;
    io.to(this.room).emit("game-over", { leaderboard: lb, winner, reason: this.endReason });
    io.to(this.room).emit("game:over", { leaderboard: lb, winner, reason: this.endReason });
    this.broadcastState();
  }

  reset(){
    this.stopTicker();
    for (const p of Object.values(this.players)){
      p.isAlive = true;
      p.isSponsor = false;
      p.pos = this.spawnPosition();
      p.vp = 0; p.vpDelta = 0;
      p.usedNumbers = new Set();
      p.selectedNumber = null; // keep lastRevealedNumber until next Resolution
      p.movementTarget = null;
      p.buff = null; p.hasShield = false; p.pendingBounty = false;
      p.speedSteps = 2; p.cornucopia = false;
      p.sponsorTargetId = null;
    }
    if (this.board?.buffs) this.board.buffs.clear();
    if (this.board?.fire) this.board.fire.clear();
    const ck = key(this.cc.center.x, this.cc.center.y);
    this.board.fire.clear();
    this.board.buffs.set(ck, "SPACETIME_SEAL");
    this.phase = "pregame"; this.round = 0; this.timerEnd = 0; this.paused = false;
    this.pauseLeft = 0;
    this.endReason = null;
    this.log("Reset complete.");
    this.broadcastState();
    this.broadcastFullState();
  }

  startTicker(){ this.stopTicker(); this.interval = setInterval(()=>this.tick(), 200); }
  stopTicker(){ if (this.interval) clearInterval(this.interval); this.interval = null; }

  tick(){
    if (this.paused) { this.broadcastState(); return; }
    const now = Date.now();
    if (now >= this.timerEnd){
      if (this.phase === "number") this.startMovement();
      else if (this.phase === "movement") this.startResolution();
      else if (this.phase === "resolution"){
        if (this.round % (this.settings?.refreshEvery ?? REFRESH_INTERVAL) === 0) this.startRefresh();
        else this.advanceToNumber();
      } else if (this.phase === "refresh"){
        this.advanceToNumber();
      }
    } else {
      // mid-phase heartbeat
      this.broadcastState();
    }
  }

  advanceToNumber(){
    if (this.phase === 'resolution') { try { io.to(this.room).emit('phase:resolution:end', {}); } catch {} }
    this.phase = "number";
    this.round += 1;
    // reset per-round flags and clear selections
    for (const p of Object.values(this.players)){
      p.vpDelta = 0;
      p.selectedNumber = null;
      p.movementTarget = null;
      p.hadWarpThisRound = false;
      p.justRespawned = false; // will be set to true if they respawn now
      p.speedSteps = 2;
    }
    // Attempt respawns for players whose ascended timer has matured
    this.tryRespawnsForRound(this.round);

    this.timerEnd = Date.now() + this.durations.number;
    this.broadcastState();
  }

  
  // ---------------- Respawns ----------------
  tryRespawnsForRound(roundNo){
    // Collect occupied edge tiles to avoid placing on players
    const occupied = new Set(Object.values(this.players).filter(p=>p.isAlive && !p.isSponsor && p.pos).map(p=>key(p.pos.x,p.pos.y)));
    const edges = edgeTilesOfBoard(this.size).map(t=> ({...t, k: key(t.x,t.y)})).filter(t => !this.board.fire.has(t.k) && !occupied.has(t.k));

    const shuffled = shuffle(edges);
    for (const p of Object.values(this.players)){
      if (!p.isSponsor) continue; // only ascended
      if (typeof p.ascendedReturnRound === 'number' && p.ascendedReturnRound === roundNo){
        const spot = shuffled.pop();
        if (spot){
          p.isAlive = true;
          p.isSponsor = false;
          p.state = 'exalted';
          p.pos = { x: spot.x, y: spot.y };
          p.buff = 'WARP';           // grant WARP for this round
          p.justRespawned = true;
          p.hadWarpThisRound = false;
          this.log(`${p.name} respawned at ${fmtTile(spot.x,spot.y)} with WARP.`);
        } else {
          // remain ascended (no valid spawn)
          this.log(`${p.name} could not respawn (no safe edge tiles). Remains Ascended.`);
        }
      }
    }
  }


  // ---------------- Player mgmt ----------------
  findPlayerByClientOrPin(clientId, pin, allowClientId=false){
    const vals = Object.values(this.players);
    if (allowClientId && clientId){
      const byCid = vals.find(p => p.clientId && p.clientId === clientId);
      if (byCid) return byCid;
    }
    if (pin){
      const byPin = vals.find(p => p.pin && p.pin === pin);
      if (byPin) return byPin;
    }
    return null;
  }

  joinOrReconnect(socket, { name, color, clientId, pin }, { allowClientId=false } = {}){
    let p = this.findPlayerByClientOrPin(clientId, pin, allowClientId);
    if (!p){
      p = new Player(socket.id, name, color);
      p.clientId = clientId || null;
      try{
        const taken = new Set(Object.values(this.players).map(pp => (pp && pp.name) ? pp.name.toLowerCase() : ''));
        let base = (p.name || 'Player').slice(0,24);
        let tryName = base; let idx = 2;
        while (taken.has(tryName.toLowerCase())){ tryName = `${base} ${idx++}`; if (tryName.length > 24) tryName = tryName.slice(0,24); }
        p.name = tryName;
      }catch{};
    p.pos = this.spawnPosition();
      this.players[p.id] = p;
      this.joinOrder.push(p.id);
      this.log(`Player joined: ${p.name}`);
    } else {
      delete this.players[p.id];
      p.id = socket.id;
      p.clientId = clientId || p.clientId;
      this.players[p.id] = p;
      this.log(`Player reconnected: ${p.name}`);
    }
    p.connected = true;
    return p;
  }

  disconnect(socketId){
    const p = this.players[socketId];
    if (p){ p.connected = false; this.log(`Player disconnected: ${p.name}`); this.broadcastState(); }
  }

  clearGhosts(){
    let removed = 0;
    for (const [sid,p] of Object.entries({...this.players})){
      if (!p.connected){ delete this.players[sid]; removed++; }
    }
    if (removed) this.log(`Cleared ${removed} disconnected player(s).`);
    this.broadcastState();
  }

  // ---------------- Phase transitions ----------------
  
startMovement(){
    // Auto-fill numbers; Ascended auto-picks highest available; Exalted default lowest available
    for (const p of Object.values(this.players)){
      if (p.isSponsor){ // Ascended
        if (!p.selectedNumber){
          for (let n=MAX_NUMBER;n>=1;n--){ if (!p.usedNumbers.has(n)){ p.selectedNumber = n; break; } }
          if (!p.selectedNumber) p.selectedNumber = MAX_NUMBER;
        }
        p.speedSteps = 0; // no normal movement for ascended
        continue;
      }
      if (!p.isAlive) continue;
      if (!p.selectedNumber){
        for (let n=1;n<=MAX_NUMBER;n++){ if (!p.usedNumbers.has(n)){ p.selectedNumber = n; break; } }
        if (!p.selectedNumber) p.selectedNumber = 1 + Math.floor(Math.random()*MAX_NUMBER);
      }
      // if respawn WARP this round, validMovesFor will handle special warp targets
      p.speedSteps = (p.buff === "WARP" && p.justRespawned) ? 0 : ((p.buff === "SPEED") ? 3 : 2);
    }
    this.phase = "movement";
    this.timerEnd = Date.now() + this.durations.movement;
    this.broadcastState();
  }


  
validMovesFor(p){
    if (!p || !p.pos) {
      // Ascended do not move; Respawn WARP targets preview (handled client-side)
      if (p && p.buff === "WARP" && p.justRespawned && !p.hadWarpThisRound){
        return ring16TilesCornucore(this.cc);
      }
      return [];
    }
    // Respawn WARP: only ring16 teleport targets
    if (p.buff === "WARP" && p.justRespawned){
      if (!p.hadWarpThisRound) return ring16TilesCornucore(this.cc);
      if (p.movementTarget) return [ { x: p.movementTarget.x, y: p.movementTarget.y } ];
      return ring16TilesCornucore(this.cc);
    }
    const maxStep = p.speedSteps || 2;
    const out = [];
    for (let dx=-maxStep; dx<=maxStep; dx++){
      for (let dy=-maxStep; dy<=maxStep; dy++){
        const man = Math.abs(dx)+Math.abs(dy);
        if (man<=0 || man>maxStep) continue; // must move at least 1
        const x = p.pos.x + dx, y = p.pos.y + dy;
        if (x<0||y<0||x>=this.size||y>=this.size) continue;
        if (this.board.fire.has(`${x},${y}`)) continue;
        out.push({x,y});
      }
    }
    return out;
  }


  startResolution(){
    this.encounters = [];
    try { io.to(this.room).emit('phase:resolution:start', { endsAt: (this.timerEnd = Date.now() + this.durations.resolution) }); } catch {}
    this.phase = "resolution";

    // Reveal numbers
    for (const p of Object.values(this.players)){
      if (p.selectedNumber != null){
        p.lastRevealedNumber = p.selectedNumber;
        p.usedNumbers.add(p.selectedNumber);
        try{ io.to(this.room).emit('player:last-number', { playerId: p.id, lastNumber: p.lastRevealedNumber }); }catch{}
      }
    }

    // Apply movement
    for (const p of Object.values(this.players)){
      if (!p.isAlive || p.isSponsor || !p.pos) continue;
      const legal = this.validMovesFor(p);
      if (!legal.length){
        p.isAlive = false; p.isSponsor = true; p.pos = null; p.state='ascended'; p.ascendedReturnRound = (this.round + 2); p.justRespawned = false; p.hadWarpThisRound = false;
        if (p.cornucopia){ p.cornucopia = false; const c=this.cc.center; this.board.buffs.set(`${c.x},${c.y}`, "SPACETIME_SEAL"); this.log("Cornucopia returned to center."); }
        p.vpDelta = 0;
        this.log(`${p.name} eliminated by fire (no legal moves).`);
        continue;
      }
      let dst = p.movementTarget;
      const ok = !!dst && legal.some(m=>m.x===dst.x && m.y===dst.y);
      if (!ok) dst = legal[Math.floor(Math.random()*legal.length)];
      p.pos = { x: dst.x, y: dst.y };
    }


    // Buff pickup BEFORE combat (single consumable slot; Sword/Shield/Warp consumed on next encounter)
    const lootPickedByTile = new Map();
    const byPos = new Map();
    for (const p of Object.values(this.players)){
      if (!p.isAlive || p.isSponsor || !p.pos) continue;
      const k2 = key(p.pos.x,p.pos.y);
      if (!byPos.has(k2)) byPos.set(k2, []);
      byPos.get(k2).push(p);
    }

    const normalizeLoot = (code) => {
      if (code === "COIN") return "RENOWN_CHIP";
      
      return code;
    };

    for (const [k2, raw] of Array.from(this.board.buffs.entries())){
      const code = normalizeLoot(raw);
      const contenders = (byPos.get(k2)||[]);
      if (!contenders.length) continue;

      const winner = (contenders.length === 1)
        ? contenders[0]
        : contenders.sort((a,b)=>this.joinOrder.indexOf(a.id)-this.joinOrder.indexOf(b.id))[0];

      const prevConsumable = winner.buff;          // current consumable slot (SWORD/SHIELD/WARP)
// Seal lockout: players holding Spacetime Seal cannot pick up combat buffs (SWORD/SHIELD/SPEED/WARP)
if (winner.cornucopia && (code==='SWORD'||code==='SHIELD'||code==='SPEED'||code==='WARP')){
  try{ const sock = io.sockets.sockets.get(winner.id); if (sock) sock.emit('loot:blocked', { reason:'SEAL_LOCK', type: code }); }catch{}
  this.log(`${winner.name} cannot pick up ${code} while holding the Spacetime Seal.`);
  continue;
}

// Apply loot
      if (code === "RENOWN_CHIP"){
        const amt = Math.max(0, Number(this.settings?.renownChipVP ?? 5) || 0);
        this.awardVP(winner, amt, false);
        this.log(`${winner.name} gained +${amt} VP (Renown Chip).`);
      } else if (code === "SWORD"){
        // replace existing consumable
        winner.buff = "SWORD";
        winner.hasShield = false;
      } else if (code === "SHIELD"){
        winner.buff = "SHIELD";
        winner.hasShield = true;
      }
else if (code === "SPEED") { winner.buff = "SPEED"; winner.speedSteps = 3; }
else if (code === "WARP") {
        winner.buff = "WARP";
        winner.hasShield = false;
        winner.speedSteps = 2;
      } else if (code === "SPACETIME_SEAL"){
        if (winner.hasShield) winner.hasShield = false;
        winner.buff = null;
        winner.cornucopia = true; // persistent +2
      } else {
        // unknown -> ignore
      }

      // Clear tile loot
      this.board.buffs.delete(k2);

      // Broadcast consumable slot state for UI
      try{ io.to(this.room).emit('player:buff:update', { playerId: winner.id, buffType: (winner.buff || null), prevBuff: prevConsumable || null }); }catch{}
      // emit loot event to the winner's socket
      try{
        const sock = io.sockets.sockets.get(winner.id);
        if (sock){
          sock.emit('encounter:loot', { tile: fromKey(k2), buffType: code, prevBuff: prevConsumable || null, number: winner.lastRevealedNumber ?? winner.selectedNumber ?? null, vpAward: (code==='RENOWN_CHIP' ? (this.settings?.renownChipVP ?? 5) : undefined), consumesSlot: (code!=='RENOWN_CHIP' && code!=='SPACETIME_SEAL') });
          sock.emit('player-loot', { tile: fromKey(k2), picked: code, replaced: prevConsumable || null, number: winner.lastRevealedNumber ?? winner.selectedNumber ?? null });
        }
      }catch{}
      this.log(`${winner.name} picked up ${code}` + (prevConsumable?` (replaced ${prevConsumable})`:"") + ".");
      // Broadcast to room (LootModal)
      try{ try {
  const __tile = fromKey(k2);
  const __tileId = (__tile.y * this.size) + __tile.x;
  io.to(this.room).emit('loot:open', { tile: __tile, tileId: __tileId, items: [{ name: code, qty: 1 }], playerId: winner.id, name: winner.name, type: code });
} catch {}
      io.to(this.room).emit('loot:pickup', { tile: fromKey(k2), playerId: winner.id, name: winner.name, type: code }); }catch{}
      // Remember for encounter payload
      try{ if (typeof lootPickedByTile !== 'undefined') lootPickedByTile.set(k2, { winnerId: winner.id, type: code, from: 'pickup' }); }catch{}
    }
    // Combat resolution
    this.resolveCombatsDetailed(byPos, lootPickedByTile);


    // Fire elimination (standing on fire)
    for (const p of Object.values(this.players)){
      if (!p.isAlive || p.isSponsor || !p.pos) continue;
      if (this.board.fire.has(key(p.pos.x,p.pos.y))){
        // Shield does not protect vs fire
        p.isAlive = false; p.isSponsor = true; p.pos = null; p.state='ascended'; p.ascendedReturnRound = (this.round + 2); p.justRespawned = false; p.hadWarpThisRound = false;
        if (p.cornucopia){
          p.cornucopia = false; const c = this.cc.center;
          this.board.buffs.set(key(c.x, c.y), "SPACETIME_SEAL");
          this.log("Spacetime Seal returned to center.");
        }
        this.log(`${p.name} eliminated by fire.`);
      }
    }

// Auto-sponsor: for any ascended with no target, pick lowest VP alive
    const ascenders = Object.values(this.players).filter(p=>p.isSponsor && (!p.sponsorTargetId))
    if (ascenders.length){
      const elig = Object.values(this.players).filter(p=>p.isAlive && !p.isSponsor)
                   .sort((a,b)=> (a.vp - b.vp) || String(a.name||'').localeCompare(String(b.name||'')))
      for (const s of ascenders){
        const t = elig.find(p=>p.id !== s.id) || null
        if (t){
          s.sponsorTargetId = t.id
          this.log(`${s.name} is now sponsoring ${t.name}.`)
          this.emitSponsorStateTo(s.id)
        }
      }
    }
    // Consume respawn WARP at end of resolution (even if no combat)
    for (const p of Object.values(this.players)){
      if (p.justRespawned && p.buff === 'WARP'){ p.buff = null; }
    }
    this.awardEndOfRoundVPs();
    if (!this.checkForEndGame()){
      this.timerEnd = Date.now() + this.durations.resolution;
      this.broadcastState();
    }
  }

  resolveCombatsDetailed(byPos, lootPickedByTile = new Map()){
    for (const [k, players] of byPos){
      if (!players || players.length <= 1) continue;
      const {x,y} = fromKey(k);
      const vals = players.map(p => {
        const base = Math.max(1, Math.min(6, p.selectedNumber||1));
        const sword = (p.buff === "SWORD") ? 1 : 0;          // +1 this combat
        const seal  = p.cornucopia ? 2 : 0;                  // Spacetime Seal = +2
        const total = base + sword + seal;
        return { p, base, sword, seal, total };
      });

      const maxVal = Math.max(...vals.map(v=>v.total));
      const winners = vals.filter(v=>v.total === maxVal).map(v=>v.p);
      const losers  = vals.filter(v=>v.total <  maxVal).map(v=>v.p);
      let victimsForVP = [];

      const detail = vals.map(v => {
        const buffs = [];
        if (v.sword) buffs.push('SWORD');
        if (v.seal)  buffs.push('SPACETIME_SEAL');
        const buffsTxt = buffs.length ? (' + ' + buffs.join(' + ')) : '';
        const buffSum = (v.sword||0) + (v.seal||0);
        return `${v.p.name}(${v.base}): ${v.base}${buffsTxt} = ${v.total}${buffSum ? ` (+${buffSum})` : ''}`;
      }).join('; ');

      const entrants = vals.map(v => ({ id: v.p.id, name: v.p.name, color: v.p.color, buffs: [ ...(v.p.buff ? [v.p.buff] : []), ...(v.p.hasShield ? ["SHIELD"] : []), ...(v.p.cornucopia ? ["SPACETIME_SEAL"] : []) ], number: v.base }))
      const payloadBase = { tile: {x,y}, entrants }
      io.to(this.room).emit('encounter-open', { ...payloadBase, alliances: [winners.map(p=>p.name)], mode: 'combat', result: { winnerId: (winners.length===1 ? winners[0].id : null), loot: null } })

      const swordInPlay = winners.some(w => w.buff === "SWORD");
      const defeated = [];

      if (winners.length > 1){
        this.log(`Encounter at ${fmtTile(x,y)} — alliance (tie): ${detail}`);
        victimsForVP = [];
        for (const L of losers){
          const pierced = swordInPlay && L.hasShield;
          if (!pierced && L.hasShield){
            // Shield saves once vs COMBAT only; consume it
            L.hasShield = false;
            if (L.buff === "SHIELD") L.buff = null;
            victimsForVP.push(L.id);
            this.log(`${L.name} survived combat with SHIELD.`);
            continue;
          }
          L.isAlive = false; L.isSponsor = true; L.pos = null; L.state='ascended'; L.ascendedReturnRound = (this.round + 2); L.justRespawned = false; L.hadWarpThisRound = false;
          if (L.cornucopia){ L.cornucopia = false; const c=this.cc.center; this.board.buffs.set(key(c.x,c.y), "SPACETIME_SEAL"); this.log("Spacetime Seal returned to center."); }
          defeated.push(L);
          this.log(`${L.name} eliminated in combat (alliance).`);
        }
        this.awardEliminationRenownFlat(winners.map(p=>p.id), (victimsForVP.length ? victimsForVP : defeated.map(p=>p.id)));
        if (defeated.length){ for (const ww of winners){ ww.kills = (ww.kills||0) + defeated.length; } }
      } else if (winners.length === 1){
        const W = winners[0];
        this.log(`Encounter at ${fmtTile(x,y)} — combat: ${detail}; winner: ${W.name}`);
        for (const L of losers){
          const pierced = (swordInPlay && L.hasShield);
          if (!pierced && L.hasShield){
            // Shield saves once (no sword); consume it and award VP to winners without elimination
            L.hasShield = false;
            if (L.buff === 'SHIELD') L.buff = null;
            victimsForVP.push(L.id);
            this.log(`${L.name} survived combat with SHIELD.`);
            continue;
          }
          // Pierced or unshielded: eliminate
          L.isAlive = false; L.isSponsor = true; L.pos = null; L.state='ascended'; L.ascendedReturnRound = (this.round + 2); L.justRespawned = false; L.hadWarpThisRound = false;
          if (L.cornucopia){ L.cornucopia = false; const c=this.cc.center; this.board.buffs.set(key(c.x,c.y), 'SPACETIME_SEAL'); this.log('Spacetime Seal returned to center.'); }
          defeated.push(L);
          this.log(`${L.name} eliminated by ${W.name}.`);
        }
        this.awardEliminationRenownFlat([W.id], (victimsForVP.length ? victimsForVP : defeated.map(p=>p.id)));
        if (defeated.length) { W.kills = (W.kills||0) + defeated.length; }
      }

      // CONSUME encounter buffs after combat (participants only)
      for (const {p} of vals){
        if (p.buff === "SWORD" || p.buff === "WARP" || p.buff === "SPEED") p.buff = null;
      }
    }
    try { io.to(this.room).emit('encounter:resolve'); } catch {}
  }

  startRefresh(){
// end resolution window
    try { io.to(this.room).emit('phase:resolution:end', {}); } catch {}
const FIRE_N = Math.max(0, Math.min(100, (this.settings?.firesPerRefresh ?? 5)));
const BUFF_N = Math.max(5, Math.max(0, Math.min(10, (this.settings?.buffsPerRefresh ?? 5))));

function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=(Math.random()*(i+1))|0; [a[i],a[j]]=[a[j],a[i]] } return a; }

this.phase = "refresh";

for (const p of Object.values(this.players)){
  if (p.isAlive && !p.isSponsor) p.usedNumbers = new Set();
}

// Fire spawning/spread per rules:
// - First refresh with no fire: seed up to FIRE_N random (unconnected) tiles outside Cornucore, not on players.
// - Subsequent refreshes: add up to 5 connected frontier tiles (avoid occupied).
const occupied = new Set(Object.values(this.players).filter(p=>p.isAlive && !p.isSponsor && p.pos).map(p=>key(p.pos.x,p.pos.y)));

if (this.board.fire.size === 0){
  const candidates = [];
  for (let y=0;y<this.size;y++){
    for (let x=0;x<this.size;x++){
      if (inCornucore(x,y,this.cc)) continue;
      const kk = key(x,y);
      if (!occupied.has(kk)) candidates.push(kk);
    }
  }
  const rnd = shuffle(candidates);
  const seeds = [];
  const isAdj = (a,b)=>{
    const [ax,ay] = a.split(',').map(Number);
    const [bx,by] = b.split(',').map(Number);
    return (Math.abs(ax-bx) + Math.abs(ay-by)) === 1;
  };
  for (const kk of rnd){
    if (seeds.length >= FIRE_N) break;
    if (!seeds.some(s=>isAdj(s, kk))) seeds.push(kk);
  }
  for (const kk of seeds) this.board.fire.add(kk);
  if (seeds.length === 0){
    this.endReason = 'fire_exhausted';
    this.endGame('fire_exhausted');
    return;
  }
} else {
  let frontier = (typeof this.fireFrontier === 'function') ? this.fireFrontier(true) : [];
    frontier = shuffle(frontier);
    const toAdd = frontier.slice(0, FIRE_N);
  for (const kk of toAdd) this.board.fire.add(kk);
  if (toAdd.length === 0){
    const frontierIgnore = (typeof this.fireFrontier === 'function') ? this.fireFrontier(false) : [];
    if (frontierIgnore.length === 0){
      this.endReason = 'fire_exhausted';
      this.endGame('fire_exhausted');
      return;
    }
  }
}

// Buff drops: only on Cornucore ring (16 tiles), never Inner Sanctum
const ring = ring16TilesCornucore(this.cc).map(t=> key(t.x,t.y));
const ringClean = ring.filter(kk => !this.board.fire.has(kk) && !occupied.has(kk));
shuffle(ringClean);
const desiredBuffs = Math.max(5, Math.max(0, Math.min(10, (this.settings?.buffsPerRefresh ?? 5))));
const baseOrder = ['SWORD','SHIELD','SPEED','RENOWN_CHIP','RENOWN_CHIP'];
// Fill up to desiredBuffs with random allowed types (no WARP/SEAL on refresh)
while (baseOrder.length < desiredBuffs) baseOrder.push(REFRESH_SPAWN_TYPES[(Math.random()*REFRESH_SPAWN_TYPES.length)|0]);
const spawnCount = Math.min(ringClean.length, baseOrder.length);
for (let i=0;i<spawnCount;i++){
  const t = baseOrder[i];
  this.board.buffs.set(ringClean[i], t);
}


if (!this.checkForEndGame()){
  this.timerEnd = Date.now() + this.durations.refresh;
  this.broadcastState();
}
  }
// ---------------- Actions ----------------
  pickNumber(socketId, n){
    const p = this.players[socketId];
    if (!p || !p.isAlive || p.isSponsor) return;
    if (this.phase !== "number") return;
    const num = clamp(Number(n)||0, 1, MAX_NUMBER);
    if (p.usedNumbers.has(num)) return;
    p.selectedNumber = num;
    this.broadcastState();
  }

  
moveTo(socketId, x, y){
    const p = this.players[socketId];
    if (!p || !p.isAlive || p.isSponsor) return;
    if (this.phase !== "movement") return;
    const nx = clamp(Number(x)||0, 0, this.size-1);
    const ny = clamp(Number(y)||0, 0, this.size-1);

    // Respawn WARP restriction
    if (p.buff === "WARP" && p.justRespawned && !p.hadWarpThisRound){
      const legal = ring16TilesCornucore(this.cc);
      const ok = legal.some(t => t.x===nx && t.y===ny);
      if (!ok){
        const sock = io.sockets.sockets.get(socketId);
        if (sock) sock.emit("move-ack", { ok:false, reason:"WARP requires Cornucore ring tile." });
        return;
      }
      p.movementTarget = {x:nx, y:ny};
      p.hadWarpThisRound = true; // will be consumed after movement resolves
      const sock = io.sockets.sockets.get(socketId);
      if (sock) sock.emit("move-ack", { ok:true, x:nx, y:ny, warp:true });
      this.broadcastState();
      return;
    }

    p.movementTarget = {x:nx, y:ny};
    const sock = io.sockets.sockets.get(socketId);
    if (sock) sock.emit("move-ack", { ok:true, x:nx, y:ny });
    this.broadcastState();
  }

  sponsorPick(socketId, targetId){
    const s = this.players[socketId];
    if (!s || !s.isSponsor) return;
    s.sponsorTargetId = targetId || null;
    const toName = (Object.values(this.players).find(p=>p.id===s.sponsorTargetId)||{}).name || '-';
    this.log(`${s.name} is now sponsoring ${toName}.`);
    this.emitSponsorStateTo(socketId);
    this.broadcastState();
  }

  hostPaint({x,y,mode,value}){
    const nx = clamp(Number(x)||0, 0, this.size-1);
    const ny = clamp(Number(y)||0, 0, this.size-1);
    const kk = key(nx,ny);
    const isCenterTile = isCenter(nx,ny,this.cc);

    if (mode === "FIRE"){
      if (!inCornucore(nx,ny,this.cc)){
        if (this.board.fire.has(kk)) this.board.fire.delete(kk);
        else this.board.fire.add(kk);
        this.log(`Host toggled fire at ${fmtTileFromKey(kk)}`);
      }
    } else if (mode === "BUFF"){
      if (isCenterTile){
        this.board.buffs.set(kk, "SPACETIME_SEAL");
        this.log(`Host set SPACETIME_SEAL at ${fmtTileFromKey(kk)}`);
      } else {
        if (this.board.buffs.has(kk)) {
          this.board.buffs.delete(kk);
          this.log(`Host toggled buff at ${fmtTileFromKey(kk)} (off)`);
        } else {
          let t = (value || 'RENOWN_CHIP');
          if (t === 'LIGHTNING') t = 'SPEED';
          if (t === 'WARP' || t === 'SPACETIME_SEAL') t = 'RENOWN_CHIP';
          if (!PAINTABLE_TYPES.includes(t)) t = 'RENOWN_CHIP';
          this.board.buffs.set(kk, t);
          this.log(`Host toggled buff at ${fmtTileFromKey(kk)} (${t})`);
        }
      }
    } else if (mode === "CLEAR"){
      if (isCenterTile){
        this.board.buffs.set(kk, "SPACETIME_SEAL");
        this.log(`Host protected center at ${fmtTileFromKey(kk)} (SPACETIME_SEAL)`);
      } else {
        this.board.fire.delete(kk);
        this.board.buffs.delete(kk);
        this.log(`Host cleared ${fmtTileFromKey(kk)}`);
      }
    }
    this.broadcastState();
  }

  awardVP(p, amount, opts = {}){
    // opts: { mirror?:boolean=true, silent?:boolean=false, reason?:string }
    const isBool = (typeof opts === 'boolean');
    const mirror = isBool ? !!opts : (opts.mirror !== undefined ? !!opts.mirror : true);
    const silent = isBool ? false : !!opts.silent;
    const reason = isBool ? undefined : opts.reason;

    p.vp += amount; p.vpDelta += amount;
    if (mirror){
      for (const s of Object.values(this.players)){
        if (s.isSponsor && s.sponsorTargetId === p.id){
          s.vp += amount; s.vpDelta += amount;
          if (!silent) this.log(`Sponsor ${s.name} +${amount} VP (mirrors ${p.name}).`);
        }
      }
    }
    if (!silent && amount){ this.log(`${p.name} +${amount} VP${reason ? ' ('+reason+')' : ''}`); }
  }

  leaderboard(){
    const arr = Object.values(this.players).map(p => ({ name:p.name, vp:p.vp, isSponsor:p.isSponsor, isAlive:p.isAlive }));
    arr.sort((a,b)=> (b.vp - a.vp) || ((a.isSponsor?1:0) - (b.isSponsor?1:0)) || a.name.localeCompare(b.name));
    return arr;
  }

  // ---------------- State ----------------
  serialize(){
    const now = Date.now();
    const msLeft = this.paused ? Math.max(0, (this.pauseLeft||((this.timerEnd||0)-now))) : Math.max(0, (this.timerEnd||0) - now);
    const playersPub = Object.values(this.players).map(p => ({
      id: p.id, name: p.name, color: p.color, isAlive: p.isAlive, isSponsor: p.isSponsor,
      pos: p.pos, vp: p.vp, vpDelta: p.vpDelta, kills: p.kills, buff: p.buff, hasShield: p.hasShield,
      cornucopia: p.cornucopia, sponsorTargetId: p.sponsorTargetId, usedNumbers: Array.from(p.usedNumbers),
      selectedNumber: (this.phase==="number") ? p.selectedNumber : null,
      lastRevealedNumber: (this.phase==="resolution" || this.phase==="refresh" || this.phase==="gameover") ? (p.selectedNumber ?? p.lastRevealedNumber) : null,
      speedSteps: p.speedSteps, pin: p.pin, connected: p.connected,
      buffs: [
        ...(p.buff ? [p.buff] : []),
        ...(p.hasShield ? ["SHIELD"] : []),
        ...(p.cornucopia ? ["SPACETIME_SEAL"] : []),
      ]
    }));

    const __re = (this.settings?.refreshEvery ?? REFRESH_INTERVAL);
    const refreshIn = (this.round>0) ? (__re - ((this.round-1) % __re)) : __re;

    const fire = Array.from(this.board.fire).map(fromKey);

    const __frontierNow = (typeof this.fireFrontier==='function') ? this.fireFrontier(true).length : 0;
    const __frontierIgnore = (typeof this.fireFrontier==='function') ? this.fireFrontier(false).length : 0;
    const __remainingPotential = (typeof this.fireRemainingPotential==='function') ? this.fireRemainingPotential() : 0;
    const __cyclesUpperBound = Math.ceil(__remainingPotential / 5);
    const buffsOnBoard = Array.from(this.board.buffs.entries()).map(([k,t])=> ({...fromKey(k), type:t}));

    return {
      fireStats: this.computeFireStats(),
      settings: this.settings,
      room: this.room,
      msLeft,

      hostId: this.hostId,
      phase: this.phase,
      round: this.round,
      timerEnd: this.timerEnd,
      durations: this.durations,
      refreshIn,
      paused: this.paused,
      timers: { endsAt: this.timerEnd, paused: this.paused },
      board: {
        size: this.size,
        fire: Array.from(this.board.fire),
        buffs: Array.from(this.board.buffs.entries()),
        cc: this.cc,
        cornBox: { x0: this.cc.minX, y0: this.cc.minY, x1: this.cc.maxX, y1: this.cc.maxY },
      },
      fire,
      buffsOnBoard, endReason: this.endReason || null,
      buffsOnBoardCompat: buffsOnBoard.map(b => ({...b, compatType: (b.type === 'RENOWN_CHIP' ? 'COIN' : (b.type === 'SPEED' ? 'LIGHTNING' : b.type)) })),

      players: playersPub,
      encounters: (this.phase === "resolution") ? this.encounters : [],
      gameLog: this.gameLog.slice(-200),
      log: this.gameLog.slice(-200),
      logs: this.gameLog.slice(-200),
    };
  }

  serializeFor(socketId){
    const base = this.serialize();
    const p = this.players[socketId] || null;
    if (p){
      const avail = [];
      for (let n=1;n<=MAX_NUMBER;n++){ if (!p.usedNumbers.has(n)) avail.push(n); }
      base.you = {
        id: p.id, name: p.name, color: p.color,
        currentNumber: (this.phase==="number") ? p.selectedNumber : null,
        lastNumber: (this.phase!=="number") ? (p.selectedNumber ?? p.lastRevealedNumber) : null,
        buffs: [
          ...(p.buff ? [p.buff] : []),
          ...(p.hasShield ? ["SHIELD"] : []),
          ...(p.cornucopia ? ["SPACETIME_SEAL"] : []),
        ],
        sponsorBonus: 0,
        isAlive: p.isAlive,
        isSponsor: p.isSponsor,
        eliminated: !p.isAlive || p.isSponsor,
      };
      base.availableNumbers = avail;
    } else {
      base.you = null;
      base.availableNumbers = [1,2,3,4,5,6];
    }
    return base;
  }

  checkForEndGame(){
    // New mode: do NOT end on last alive; only end during refresh when fire can no longer spread.
    return false;
  }

  emitSponsorStateTo(socketId){
    const sock = io.sockets.sockets.get(socketId);
    if (!sock) return;
    const s = this.players[socketId];
    if (!s || !s.isSponsor) return;
    const eligibleTargets = Object.values(this.players)
      .filter(p => p.isAlive && !p.isSponsor && p.id !== socketId)
      .map(p => ({ id: p.id, name: p.name, color: p.color, vp: p.vp, buffs: [
        ...(p.buff ? [p.buff] : []),
        ...(p.hasShield ? ["SHIELD"] : []),
        ...(p.cornucopia ? ["SPACETIME_SEAL"] : []),
      ]}));
    sock.emit("sponsor-state", { eligibleTargets, selectedId: s.sponsorTargetId });
  }

  broadcastState(){
    const room = io.sockets.adapter.rooms.get(this.room);
    if (!room || room.size === 0){
      io.to(this.room).emit("state", this.serialize());
      return;
    }
    for (const sid of room){
      const sock = io.sockets.sockets.get(sid);
      if (!sock) continue;
      sock.emit("state", this.serializeFor(sid));
      const p = this.players[sid];
      if (p && p.isSponsor) this.emitSponsorStateTo(sid);
    }
  }
}

// ------------------------------------------------------------------
// Rooms
// ------------------------------------------------------------------
const games = new Map(); // room -> Game
function getGame(room){
  const r = String(room || "default").slice(0,64);
  if (!games.has(r)) games.set(r, new Game(r));
  return games.get(r);
}

// ------------------------------------------------------------------
// Sockets
// ------------------------------------------------------------------
io.on("connection", (socket)=>{

  // Client can request a one-off state snapshot
  socket.on("state:request", ({ room }) => {
    const g = getGame(room);
    socket.emit("state:full", g.serialize());
    socket.emit("state", g.serializeFor(socket.id));
  });
  socket.on("request:state", ({ room }) => {
    const g = getGame(room);
    socket.emit("state:full", g.serialize());
    socket.emit("state", g.serializeFor(socket.id));
  });


  function __doJoin(allowClientId, payload){
    const { room, name, color, clientId, pin } = payload || {};
    const g = getGame(room);
    socket.join(g.room);
    const p = g.joinOrReconnect(socket, { name, color, clientId, pin }, { allowClientId });
    socket.emit("your-pin", { pin: p.pin, clientId: p.clientId });
    socket.emit("joined-ack", { id: p.id, room: g.room, name: p.name, pin: p.pin });
    // Compatibility event for clients listening to 'player:joined'
    socket.emit("player:joined", { playerId: p.id, pin: p.pin, clientId: p.clientId, room: g.room });
    g.broadcastState();
  }

  // HOST
  socket.on("host-join", ({room})=>{
    const g = getGame(room);
    socket.join(g.room);
    g.hostId = socket.id;
    socket.emit("lan-addrs", { addrs: getLanAddresses() });
    g.broadcastState();
  });

  socket.on("host-config", ({room, size, durations})=>{
    const g = getGame(room);
    if (size) g.setSize(size);
    if (durations) g.setDurations(durations);
    g.broadcastState();
  });

  socket.on("host-start", ({room, size})=>{
  const g = getGame(room);
  socket.join(g.room);
  try{ io.to(g.room).emit('game:prologue', { title:'Intersplice the Exalted', durationMs:8000 }); }catch{}
  // Fire a 3-2-1 countdown alongside Number phase; clients may overlay a cinematic
  try{
    setTimeout(()=> io.to(g.room).emit('game:countdown', { n:3 }), 8000);
    setTimeout(()=> io.to(g.room).emit('game:countdown', { n:2 }), 9000);
    setTimeout(()=> io.to(g.room).emit('game:countdown', { n:1 }), 10000);
  }catch{}
  g.startGame({ size });
});

  socket.on("host-reset", ({room})=>{
    const g = getGame(room);
    g.reset();
  });

  socket.on("host:reset", ({ room, roomId }) => {
    const g = getGame(room || roomId);
    g.reset();
  });

  socket.on("host-end-phase", ({room})=>{
    const g = getGame(room);
    g.timerEnd = Date.now();
  });

  socket.on("host-end-round", ({room})=>{
    const g = getGame(room);
    if (g.phase === "number") g.startMovement();
    else if (g.phase === "movement") g.startResolution();
    else if (g.phase === "resolution"){
      if (g.round % (g.settings?.refreshEvery ?? REFRESH_INTERVAL) === 0) g.startRefresh();
      else g.advanceToNumber();
    } else if (g.phase === "refresh"){
      g.advanceToNumber();
    }
  });

  socket.on("host-end-game", ({room})=>{
    const g = getGame(room);
    g.endGame();
  });

  socket.on("host-paint", ({room,x,y,mode,value,buff})=>{
    const g = getGame(room);
    g.hostPaint({x,y,mode,value: value || buff});
  });

  socket.on("host-clear-ghosts", ({room})=>{
    const g = getGame(room);
    g.clearGhosts();
  });

  socket.on("host-toggle-pause", ({room})=>{
    const g = getGame(room);
    if (!g) return;
    if (!g.paused){
      // going to paused
      g.pauseLeft = Math.max(0, (g.timerEnd||0) - Date.now());
      g.paused = true;
      g.log("Game paused by host.");
    } else {
      // resuming
      const left = Math.max(0, g.pauseLeft||0);
      g.timerEnd = Date.now() + left;
      g.pauseLeft = 0;
      g.paused = false;
      g.log("Game resumed by host.");
    }
    g.broadcastState();
  });

  socket.on("host-set-color", ({room, playerId, color})=>{
    const g = getGame(room);
    if (!g) return;
    for (const p of Object.values(g.players)){
      if (p.id === playerId){ p.color = color || p.color; g.log(`Host set color for ${p.name}.`); break; }
    }
    g.broadcastState();
  });

  // PLAYERS
  socket.on("player:request-legal", ({room})=>{
    const g = getGame(room);
    const p = g.players[socket.id];
    if (!p) return;
    const tiles = g.validMovesFor(p);
    socket.emit("moves:legal", tiles);
  });
  socket.on("request-legal", ({room})=>{
    const g = getGame(room);
    const p = g.players[socket.id];
    if (!p) return;
    const tiles = g.validMovesFor(p);
    socket.emit("legal-moves", { tiles });
  });
  socket.on("moves:legal:request", ({room})=>{
    const g = getGame(room);
    const p = g.players[socket.id];
    if (!p) return;
    const tiles = g.validMovesFor(p);
    socket.emit("moves:legal", tiles);
  });

  socket.on("host:kick", ({ room, playerId }) => {
    const g = getGame(room); if (!g) return;
    const p = g.players[playerId];
    if (!p) return;
    try{ const ps = io.sockets.sockets.get(playerId); if (ps) ps.leave(g.room); }catch{}
    delete g.players[playerId];
    g.joinOrder = g.joinOrder.filter(id => id !== playerId);
    g.log(`Host kicked: ${p.name}`);
    g.broadcastState();
    g.broadcastFullState();
  });
  const __kick = ({ room, playerId }) => {
    const g = getGame(room); if (!g) return;
    const p = g.players[playerId];
    if (!p) return;
    try{ const ps = io.sockets.sockets.get(playerId); if (ps) ps.leave(g.room); }catch{}
    delete g.players[playerId];
    g.joinOrder = g.joinOrder.filter(id => id !== playerId);
    g.log(`Host kicked: ${p.name}`);
    g.broadcastState();
    g.broadcastFullState();
  };
  socket.on("host:remove-player", (payload) => __kick(payload));
  socket.on("host:player:kick", (payload) => __kick(payload));

  socket.on("player:join",        (payload)=> __doJoin(false, payload));
  socket.on("player:reconnect",   (payload)=> __doJoin(true,  payload));
  socket.on("player:rejoin",      (payload)=> __doJoin(true,  payload));

  socket.on("player-join", ({room, name, color, clientId, pin})=>{
    const g = getGame(room);
    socket.join(g.room);
    const p = g.joinOrReconnect(socket, { name, color, clientId, pin }, { allowClientId:false });
    socket.emit("your-pin", { pin: p.pin, clientId: p.clientId });
    socket.emit("joined-ack", { id: p.id, room: g.room, name: p.name, pin: p.pin });
    socket.emit("player:joined", { playerId: p.id, pin: p.pin, clientId: p.clientId, room: g.room });
    g.broadcastState();
  });

  socket.on("player-reconnect", ({room, name, color, clientId, pin})=>{
    const g = getGame(room);
    socket.join(g.room);
    const p = g.joinOrReconnect(socket, { name, color, clientId, pin }, { allowClientId:true });
    socket.emit("your-pin", { pin: p.pin, clientId: p.clientId });
    socket.emit("joined-ack", { id: p.id, room: g.room, name: p.name, pin: p.pin });
    socket.emit("player:joined", { playerId: p.id, pin: p.pin, clientId: p.clientId, room: g.room });
    g.broadcastState();
  });

  socket.on("pick-number", ({room, number})=>{
    const g = getGame(room);
    g.pickNumber(socket.id, number);
  });

  socket.on("move-to", ({room, x, y})=>{
    const g = getGame(room);
    g.moveTo(socket.id, x, y);
  });

  socket.on("sponsor-pick", ({room, targetId})=>{
    const g = getGame(room);
    g.sponsorPick(socket.id, targetId);
  });

  socket.on("request-legal-moves", ({room})=>{
    const g = getGame(room);
    const p = g.players[socket.id];
    if (!p) return;
    const tiles = g.validMovesFor(p);
    socket.emit("legal-moves", { playerId: socket.id, tiles });
  });

  socket.on("disconnect", ()=>{
    for (const g of games.values()){ g.disconnect(socket.id); }
  });
});

// ------------------------------------------------------------------
// Start
// ------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", ()=>{
  console.log(`Hunger Numbers listening on:`);
  console.log(` - http://localhost:${PORT}`);
  for (const ip of getLanAddresses()){
    console.log(` - http://${ip}:${PORT}`);
  }
});


/* === Fire helpers: prototype-based to avoid class body syntax issues === */
Game.prototype.fireFrontier = function(considerOccupied = true){
  const board = this.board || {};
  const size = this.size || 0;

  const occ = new Set();
  if (considerOccupied){
    for (const p of Object.values(this.players||{})){
      if (p && p.isAlive && !p.isSponsor && p.pos && typeof p.pos.x==='number' && typeof p.pos.y==='number'){
        occ.add(`${p.pos.x},${p.pos.y}`);
      }
    }
  }

  const inBounds = (x,y)=> x>=0 && y>=0 && x<size && y<size;

  const hasFire = (kk)=> {
    if (board.fire instanceof Set) return board.fire.has(kk);
    if (Array.isArray(board.fire)) return board.fire.some(t=> (typeof t==='string' ? t===kk : (t && (t.x+','+t.y)===kk)));
    return false;
  };
  const forEachFire = (fn)=> {
    if (board.fire instanceof Set){
      for (const v of board.fire){
        let x,y;
        if (typeof v === 'string'){ const parts = v.split(','); x = +parts[0]; y = +parts[1]; }
        else if (v && typeof v==='object'){ x = +v.x; y = +v.y; } else continue;
        fn(x,y);
      }
    } else if (Array.isArray(board.fire)){
      for (const v of board.fire){
        let x,y;
        if (typeof v === 'string'){ const parts = v.split(','); x = +parts[0]; y = +parts[1]; }
        else if (v && typeof v==='object'){ x = +v.x; y = +v.y; } else continue;
        fn(x,y);
      }
    }
  };

  const cand = new Set();
  forEachFire((x,y)=>{
    const nbrs = [{x:x+1,y},{x:x-1,y},{x,y:y+1},{x,y:y-1}];
    for (const n of nbrs){
      if (!inBounds(n.x,n.y)) continue;
      if (typeof inCornucore === 'function' && inCornucore(n.x,n.y,this.cc)) continue;
      const nk = `${n.x},${n.y}`;
      if (!hasFire(nk) && !occ.has(nk)) cand.add(nk);
    }
  });
  return Array.from(cand);
};

Game.prototype.fireRemainingPotential = function(){
  const size = this.size || 0;
  const cornW = (this.cc?.maxX - this.cc?.minX + 1);
  const cornH = (this.cc?.maxY - this.cc?.minY + 1);
  const total = size * size;
  const cornArea = (cornW>0 && cornH>0) ? (cornW * cornH) : 0;
  const outside = Math.max(0, total - cornArea);

  let fireCount = 0;
  const seen = new Set();
  const push = (x,y)=>{ const kk = `${x},${y}`; if(!seen.has(kk)){ seen.add(kk); fireCount++; } };

  const board = this.board || {};
  if (board.fire instanceof Set){
    for (const v of board.fire){
      if (typeof v === 'string'){ const [x,y] = v.split(',').map(Number); push(x,y); }
      else if (v && typeof v==='object'){ push(v.x, v.y) }
    }
  } else if (Array.isArray(board.fire)){
    for (const v of board.fire){
      if (typeof v === 'string'){ const [x,y] = v.split(',').map(Number); push(x,y); }
      else if (v && typeof v==='object'){ push(v.x, v.y) }
    }
  }

  return Math.max(0, outside - fireCount);
};





/* Alliance-wide combat VP awarding (legacy non-flat mode)
 * - per victim: 5 + victim's number
 */
Game.prototype.awardCombatVPAlliance = function(winnerIds = [], victimIds = []){
  const parts = [];
  let baseTotal = 0;
  for (const vid of victimIds){
    const v = this.players[vid]; if (!v) continue;
    const n = (v.lastRevealedNumber ?? v.selectedNumber ?? 0) | 0;
    const add = 5 + Math.max(0, n);
    parts.push({ id: v.id, name: v.name, n, add });
    baseTotal += add;
  }
  const delta = baseTotal;

  const results = [];
  for (const wid of winnerIds){
    const w = this.players[wid]; if (!w) continue;
    if (delta) { this.awardVP(w, delta, true); results.push({ winnerId: w.id, delta }); }
  }

  try{ io.to(this.room).emit("combat:vp", { winners: results, parts, total: baseTotal, teamMultiplier: 1 }); }catch{}
  const txt = parts.map(p => `+${p.add} (5+${p.n}) vs ${p.name}`).join('; ');
  for (const r of results){
    const w = this.players[r.winnerId];
    this.log(`${w.name} +${r.delta} VP → ${txt}`);
  }
};

Game.prototype.awardEliminationRenownFlat = function(winnerIds = [], victimIds = []){
  const perVictim = Math.max(0, Number(this.settings?.eliminationVP ?? 20) || 0);
  if (!perVictim || !victimIds.length || !winnerIds.length) return;

  for (const wid of winnerIds){
    const w = this.players[wid]; if (!w) continue;
    const total = perVictim * victimIds.length;
    this.awardVP(w, total, true);
    this.log(`${w.name} +${total} VP (Eliminations: ${victimIds.length} × ${perVictim}).`);
  }
};




Game.prototype.awardGapSurvivalVP = function(){
  if (this.settings?.flatSurvivalVP){
    const award = Math.max(0, Number(this.settings?.survivalVP ?? 10) || 0);
    if (!award) return;
    const alive = [];
    for (const p of Object.values(this.players)){
      if (p && p.isAlive && !p.isSponsor){ this.awardVP(p, award, true); alive.push(p.name); }
    }
    if (alive.length) this.log(`Refresh: Survival VP +${award} → ${alive.join(', ')}`);
    return;
  }
  // Legacy escalating
  const award = (this.refreshIndex) * 3;
  if (!award) return;
  const alive = [];
  for (const p of Object.values(this.players)){
    if (p && p.isAlive && !p.isSponsor){ this.awardVP(p, award, true); alive.push(p.name); }
  }
  if (alive.length) this.log(`Refresh #${this.refreshIndex}: Survival VP +${award} → ${alive.join(', ')}`);
};



io.on("connection", (socket) => {
  // Host settings update
  socket.on("host:update-settings", ({ room, firesPerRefresh, buffsPerRefresh, showPhaseTimer, numberSec, movementSec, resolutionSec, refreshEvery, eliminationVP, renownChipVP, survivalPerRoundEnabled, survivalPerRoundVP, innerSanctumEnabled, innerSanctumVP, centerTileVP }) => {
    const g = games.get(room); if (!g) return;
    if (Number.isInteger(firesPerRefresh)) g.settings.firesPerRefresh = Math.max(0, Math.min(100, firesPerRefresh));
    if (Number.isInteger(buffsPerRefresh)) g.settings.buffsPerRefresh = Math.max(0, Math.min(10, buffsPerRefresh));
    if (typeof showPhaseTimer === "boolean") g.settings.showPhaseTimer = !!showPhaseTimer;
    if (Number.isInteger(numberSec))    g.settings.phaseDurations.number = Math.max(0, Math.min(120, numberSec));
    if (Number.isInteger(movementSec))  g.settings.phaseDurations.movement = Math.max(0, Math.min(120, movementSec));
    if (Number.isInteger(resolutionSec))g.settings.phaseDurations.resolution = Math.max(0, Math.min(120, resolutionSec));
    if (Number.isInteger(refreshEvery)) g.settings.refreshEvery = Math.max(1, Math.min(10, refreshEvery));
    if (Number.isInteger(eliminationVP)) g.settings.eliminationVP = Math.max(0, Math.min(100, eliminationVP));
    if (Number.isInteger(renownChipVP)) g.settings.renownChipVP = Math.max(0, Math.min(20, renownChipVP));
    if (typeof survivalPerRoundEnabled === "boolean") g.settings.survivalPerRoundEnabled = !!survivalPerRoundEnabled;
    if (Number.isInteger(survivalPerRoundVP)) g.settings.survivalPerRoundVP = Math.max(0, Math.min(10, survivalPerRoundVP));
    if (typeof innerSanctumEnabled === "boolean") g.settings.innerSanctumEnabled = !!innerSanctumEnabled;
    if (Number.isInteger(innerSanctumVP)) g.settings.innerSanctumVP = Math.max(0, Math.min(10, innerSanctumVP));
    if (Number.isInteger(centerTileVP)) g.settings.centerTileVP = Math.max(0, Math.min(10, centerTileVP));
    g.recomputeDurations();
    io.to(g.room).emit("host:settings", g.settings);
    g.broadcastState();
  });

  // Host board size apply
  socket.on("host:board:size", ({ room, size }) => {
    const g = games.get(room); if (!g) return;
    if (Number.isInteger(size) && size >= 6 && size <= 24){ g.setSize(size); }
  });

  // Host painting
  socket.on('host:paint', ({ room, x, y, action, buffType }) => {
    const g = games.get(room); if (!g) return;
    const mode = String(action||'').toUpperCase();
    const value = buffType ? String(buffType).toUpperCase() : undefined;
    g.hostPaint({ x, y, mode, value });
  });
});


Game.prototype.computeFireStats = function(){
  const total = this.size * this.size;
  const cc = this.cc || { minX:0, maxX:-1, minY:0, maxY:-1 };
  const cornW = (cc.maxX - cc.minX + 1);
  const cornH = (cc.maxY - cc.minY + 1);
  const cornArea = (cornW>0 && cornH>0) ? (cornW * cornH) : 0;
  const burnableTotal = Math.max(0, total - cornArea);

  const inCC = (x,y)=> x>=cc.minX && x<=cc.maxX && y>=cc.minY && y<=cc.maxY;

  let burned = 0;
  for (const k of this.board.fire){
    const [x,y] = k.split(',').map(Number);
    if (!inCC(x,y)) burned++;
  }
  const remaining = Math.max(0, burnableTotal - burned);

  const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
  const frontierSet = new Set();
  for (const k of this.board.fire){
    const [x,y] = k.split(',').map(Number);
    for (const [dx,dy] of dirs){
      const nx=x+dx, ny=y+dy, nk=`${nx},${ny}`;
      if (nx<0||ny<0||nx>=this.size||ny>=this.size) continue;
      if (this.board.fire.has(nk)) continue;
      if (inCC(nx,ny)) continue;
      frontierSet.add(nk);
    }
  }
  const frontier = Array.from(frontierSet);
  const occupied = new Set(Object.values(this.players).filter(p=>p.isAlive && !p.isSponsor && p.pos).map(p=>`${p.pos.x},${p.pos.y}`));
  const frontierIgnoreOccupied = frontier.filter(k => !occupied.has(k));

  const FIRE_N = Math.max(0, this.settings?.firesPerRefresh ?? 5);
  const refreshesLeft = FIRE_N > 0 ? Math.ceil(remaining / FIRE_N) : Infinity;
  const nextAdd = Math.min(FIRE_N, frontierIgnoreOccupied.length);
  const refreshesLeftFrontier = nextAdd > 0 ? Math.ceil(remaining / nextAdd) : Infinity;

  const refreshEvery = Math.max(1, this.settings?.refreshEvery ?? 1);
  const roundsUntilRefresh = ((refreshEvery - (this.round % refreshEvery)) % refreshEvery) || refreshEvery;

  return {
    burnableTotal, burned, remaining,
    frontier: frontier.length,
    frontierIgnoreOccupied: frontierIgnoreOccupied.length,
    firesPerRefresh: FIRE_N,
    refreshesLeft,
    refreshesLeftFrontier,
    refreshEvery, roundsUntilRefresh
  };
};



Game.prototype.awardEndOfRoundVPs = function(){
  const survOn = (this.settings?.survivalPerRoundEnabled !== false);
  const sVP = Math.max(0, Number(this.settings?.survivalPerRoundVP ?? 1));
  const sanctumOn = (this.settings?.innerSanctumEnabled !== false);
  const sanctumVP = Math.max(0, Number(this.settings?.innerSanctumVP ?? 1));
  const gainers = [];

  for (const p of Object.values(this.players)){
    if (p && p.isAlive && !p.isSponsor){
      if (survOn && sVP>0){ this.awardVP(p, sVP, false); gainers.push(p.name); }
      if (sanctumOn && p.pos && isInnerSanctum(p.pos.x, p.pos.y, this.cc)){ this.awardVP(p, sanctumVP, {mirror:true, reason:'Inner Sanctum'}); }
      // Center tile bonus
      const ctvp = Math.max(0, Number(this.settings?.centerTileVP ?? 0));
      if (ctvp>0 && p.pos && isCenter(p.pos.x, p.pos.y, this.cc)){
        this.awardVP(p, ctvp, {mirror:true, reason:'Center'});
      }
    }
  }
  // Survival VP logged silently (no spam).
};


Game.prototype.broadcastFullState = function(){
  try {
    const full = this.serialize();
    io.to(this.room).emit("state:full", full);
    io.to(this.room).emit("state:sync", full);
  } catch {}
};
