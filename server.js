// 모르둠 익스트림 뇌사패턴 미니게임 서버 (외부 패키지 없음: node server.js)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const VERSION = '1.8';
const SLOTS = ['1-1', '1-2', '1-3', '1-4', '2-1', '2-2', '2-3', '2-4'];
const C = {
  R: 500,            // 반원 맵 반지름
  BOSS_R: 75,        // 보스 충돌 반경
  PR: 16,            // 캐릭터 반경
  PAD_R1: 56,        // 1열 반구 장판 반경
  PAD_R2: 64,        // 2열 반구 장판 반경
  CONV_R: 85,        // 변환 장판 반경
  SPEED: 320,        // 이동 속도 (units/s)
  // 단계별 초수는 아래 OPT_SPEC 기본값 (방장이 대기실에서 변경)
  ATK_CD: 80,        // 공격 최소 간격 ms
};
// 방장이 조절할 수 있는 초수 옵션
const OPT_SPEC = [
  { k: 'intro', label: '시작 → 망치 장판', def: 2, min: 0.5, max: 10, step: 0.5 },
  { k: 'grace', label: '망치 장판 → 구역 판정', def: 4, min: 0.5, max: 10, step: 0.5 },
  { k: 'enrage', label: '보스 광폭화 (판정 시작 후)', def: 15, min: 5, max: 120, step: 5 },
  { k: 'convDelay', label: '보스 체력 0 → 변환 장판 (망치 유지)', def: 3, min: 0.5, max: 10, step: 0.5 },
  { k: 'convDur', label: '변환 장판 유지', def: 5, min: 0.5, max: 10, step: 0.5 },
  { k: 'boom', label: '변환 장판 소멸 → 전지역 폭발', def: 7, min: 0.5, max: 10, step: 0.5 },
  { k: 'tpCd', label: '순간이동(Space) 쿨타임', def: 5, min: 0, max: 30, step: 1 },
  { k: 'hpPer', label: '보스 체력 (1인당 공격 횟수)', def: 50, min: 5, max: 300, step: 5, unit: '타' },
  { k: 'forceSteal', label: '변환 대상자 자리 뺏기 강제', def: 0, min: 0, max: 1, step: 1, type: 'bool', hint: '대상자의 자기 자리가 이미 같은 색 → 반전 후 다른 사람 장판으로' },
  { k: 'randomSeat', label: '자리 랜덤', def: 0, min: 0, max: 1, step: 1, type: 'bool', hint: '매 판 시작 시 방장 배치와 상관없이 8자리 중 무작위 배정' },
  { k: 'hideEmpty', label: '빈 자리 장판 비활성화', def: 1, min: 0, max: 1, step: 1, type: 'bool', hint: '8명 미만일 때 주인 없는 자리의 반구 장판은 사용 불가' },
];
const defaultOpts = () => Object.fromEntries(OPT_SPEC.map(o => [o.k, o.def]));
function padPos(i) {
  const row = i < 4 ? 0 : 1, k = i % 4;
  const ang = [150, 110, 70, 30][k] * Math.PI / 180;
  const r = row ? 395 : 235;
  return { x: Math.cos(ang) * r, y: Math.sin(ang) * r, r: row ? C.PAD_R2 : C.PAD_R1 };
}

// ---------- 최소 WebSocket 구현 ----------
class Conn {
  constructor(s) {
    this.s = s; this.buf = Buffer.alloc(0); this.frag = []; this.open = true;
    this.onmsg = null; this.onclose = null;
    s.on('data', d => { this.buf = Buffer.concat([this.buf, d]); this.parse(); });
    s.on('close', () => this._closed());
    s.on('error', () => this._closed());
  }
  parse() {
    while (this.open) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = b[0] & 0x80, op = b[0] & 0x0f, masked = b[1] & 0x80;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (len > 1 << 20) { this.s.destroy(); return; }
      const mOff = off; if (masked) off += 4;
      if (b.length < off + len) return;
      let p = Buffer.from(b.subarray(off, off + len));
      if (masked) { const m = b.subarray(mOff, mOff + 4); for (let i = 0; i < p.length; i++) p[i] ^= m[i & 3]; }
      this.buf = b.subarray(off + len);
      if (op === 8) { this.close(); return; }
      if (op === 9) { this.frame(10, p); continue; }
      if (op === 10) continue;
      if (op === 1 || op === 0) {
        this.frag.push(p);
        if (fin) {
          const msg = Buffer.concat(this.frag).toString('utf8'); this.frag = [];
          if (this.onmsg) { try { this.onmsg(msg); } catch (e) { console.error(e); } }
        }
      }
    }
  }
  frame(op, p) {
    if (!this.open) return;
    const len = p.length; let h;
    if (len < 126) h = Buffer.from([0x80 | op, len]);
    else if (len < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(len, 2); }
    else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); }
    try { this.s.write(Buffer.concat([h, p])); } catch (e) { this._closed(); }
  }
  send(o) { this.frame(1, Buffer.from(JSON.stringify(o))); }
  close() { if (this.open) this.frame(8, Buffer.alloc(0)); try { this.s.end(); } catch (e) {} this._closed(); }
  _closed() { if (!this.open) return; this.open = false; if (this.onclose) this.onclose(); }
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
  } else if (url === '/health') { res.end('ok'); }
  else { res.writeHead(404); res.end('not found'); }
});
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
  const acc = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
  socket.setNoDelay(true);
  onConnect(new Conn(socket));
});

// ---------- 방 / 게임 ----------
const rooms = new Map();
const conns = new Set();
const GAME_PHASES = ['intro', 'hammer', 'pads', 'conv', 'wait'];

function newCode() {
  let c;
  do { c = String(100000 + Math.floor(Math.random() * 900000)); } while (rooms.has(c));
  return c;
}
function cleanNick(n) { return String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 12); }
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function clampPos(x, y) {
  x = Number(x); y = Number(y);
  if (!isFinite(x) || !isFinite(y)) return null;
  if (y < C.PR) y = C.PR;
  const d = Math.hypot(x, y), m = C.R - C.PR;
  if (d > m) { x = x / d * m; y = y / d * m; }
  const bd = Math.hypot(x, y), bm = C.BOSS_R + C.PR;
  if (bd < bm) { if (bd < 0.01) { x = 0; y = bm; } else { x = x / bd * bm; y = y / bd * bm; } }
  if (y < C.PR) y = C.PR;
  return { x, y };
}

function onConnect(c) {
  const id = crypto.randomBytes(4).toString('hex');
  c.id = id; conns.add(c);
  let room = null;
  const err = msg => c.send({ t: 'err', msg });
  c.onmsg = raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    if (m.t === 'create') {
      if (room) return;
      const nick = cleanNick(m.nick); if (!nick) return err('닉네임을 입력하세요');
      const code = newCode();
      room = { code, host: id, slots: new Array(8).fill(null), players: new Map(), phase: 'lobby', g: null, order: 0, opts: defaultOpts() };
      rooms.set(code, room);
      addPlayer(room, c, nick);
    } else if (m.t === 'join') {
      if (room) return;
      const nick = cleanNick(m.nick); if (!nick) return err('닉네임을 입력하세요');
      const r = rooms.get(String(m.code || '').trim());
      if (!r) return err('방을 찾을 수 없어요. 방 번호 6자리를 확인하세요');
      if (r.players.size >= 8) return err('방이 가득 찼어요 (8/8)');
      if ([...r.players.values()].some(p => p.nick === nick)) return err('같은 닉네임이 이미 방에 있어요');
      room = r; addPlayer(r, c, nick);
    } else if (room) handle(room, room.players.get(id), m);
  };
  c.onclose = () => { conns.delete(c); if (room) removePlayer(room, id); room = null; };
}

function addPlayer(room, c, nick) {
  const slot = room.slots.indexOf(null);
  const inProgress = room.phase !== 'lobby' && room.phase !== 'result';
  const p = { id: c.id, nick, conn: c, slot, x: 0, y: 200, charge: 1, alive: false, inGame: false, reason: null, lastAtk: 0, lastPing: 0, dmg: 0, joined: room.order++ };
  room.slots[slot] = c.id;
  room.players.set(c.id, p);
  c.send({ t: 'joined', you: c.id, code: room.code, C, SLOTS, OPT_SPEC, inProgress, version: VERSION });
  broadcastRoom(room);
  if (inProgress) c.send({ t: 'fx', k: 'msg', text: '게임 진행 중이에요. 다음 판부터 참여합니다.' });
}
function removePlayer(room, id) {
  const p = room.players.get(id); if (!p) return;
  room.players.delete(id);
  if (p.slot >= 0) room.slots[p.slot] = null;
  if (room.players.size === 0) { rooms.delete(room.code); return; }
  if (room.host === id) {
    const next = [...room.players.values()].sort((a, b) => a.joined - b.joined)[0];
    room.host = next.id;
  }
  broadcastRoom(room);
  if (GAME_PHASES.includes(room.phase)) fx(room, { k: 'msg', text: p.nick + ' 님이 나갔어요' });
}
function bcast(room, o) { const s = JSON.stringify(o); for (const p of room.players.values()) p.conn.frame(1, Buffer.from(s)); }
function fx(room, o) { o.t = 'fx'; bcast(room, o); }
function broadcastRoom(room) {
  bcast(room, {
    t: 'room', code: room.code, host: room.host, phase: room.phase, slots: room.slots, opts: room.opts,
    players: [...room.players.values()].map(p => ({ id: p.id, nick: p.nick, slot: p.slot, inGame: p.inGame, alive: p.alive })),
  });
}
const alivePlayers = room => [...room.players.values()].filter(p => p.inGame && p.alive);
function kill(room, p, reason) {
  if (!p.alive) return;
  p.alive = false; p.reason = reason;
  fx(room, { k: 'death', id: p.id, nick: p.nick, reason, x: Math.round(p.x), y: Math.round(p.y) });
}

function handle(room, p, m) {
  if (!p) return;
  const now = Date.now(), g = room.g, isHost = room.host === p.id;
  switch (m.t) {
    case 'swap': {
      if (!isHost || GAME_PHASES.includes(room.phase)) return;
      const a = m.a | 0, b = m.b | 0;
      if (a < 0 || a > 7 || b < 0 || b > 7 || a === b) return;
      [room.slots[a], room.slots[b]] = [room.slots[b], room.slots[a]];
      room.slots.forEach((pid, i) => { if (pid) room.players.get(pid).slot = i; });
      broadcastRoom(room); break;
    }
    case 'start': if (isHost && (room.phase === 'lobby' || room.phase === 'result')) startGame(room); break;
    case 'lobby': if (isHost && room.phase === 'result') { room.phase = 'lobby'; restoreSlots(room); broadcastRoom(room); } break;
    case 'opts': {
      if (!isHost || GAME_PHASES.includes(room.phase) || !m.opts || typeof m.opts !== 'object') return;
      if (m.opts === 'default' || m.reset) { room.opts = defaultOpts(); broadcastRoom(room); break; }
      for (const o of OPT_SPEC) {
        if (!(o.k in m.opts)) continue;
        let v = Number(m.opts[o.k]); if (!isFinite(v)) continue;
        v = Math.min(o.max, Math.max(o.min, Math.round(v / o.step) * o.step));
        room.opts[o.k] = Math.round(v * 10) / 10;
      }
      broadcastRoom(room); break;
    }
    case 'pos': {
      if (!p.alive || !p.inGame || !GAME_PHASES.includes(room.phase)) return;
      const q = clampPos(m.x, m.y); if (q) { p.x = q.x; p.y = q.y; }
      break;
    }
    case 'atk': {
      if (room.phase !== 'hammer' || !p.alive || !p.inGame) return;
      if (now - p.lastAtk < C.ATK_CD) return;
      p.lastAtk = now; g.bossHp = Math.max(0, g.bossHp - 1); p.dmg++;
      if (g.bossHp <= 0) {
        room.phase = 'pads'; g.bossDeadAt = now;
        // 자리 뺏기 강제: 변환 대상자를 미리 정하고, 그 사람 자리를 현재 전하와 같은 색으로 (반전되면 다른 장판으로 가야 함)
        // 빈 자리 비활성화: 이번 판 참여자의 자리만 반구 장판으로 사용
        const act = new Array(8).fill(!room.opts.hideEmpty);
        if (room.opts.hideEmpty) for (const q of room.players.values()) if (q.inGame && q.slot >= 0) act[q.slot] = true;
        const actIdx = act.map((v, i) => v ? i : -1).filter(i => i >= 0);
        // 자리 뺏기 강제: 변환 대상자를 미리 정하고, 그 사람 자리를 현재 전하와 같은 색으로 (반전되면 다른 사람 장판으로 가야 함)
        let pre = null;
        if (room.opts.forceSteal && actIdx.length >= 2) { const al = alivePlayers(room).filter(q => q.slot >= 0 && act[q.slot]); if (al.length) pre = al[Math.floor(Math.random() * al.length)]; }
        let pads, tries = 0;
        do {
          pads = Array.from({ length: 8 }, () => (Math.random() < 0.5 ? 1 : -1));
          if (pre) pads[pre.slot] = pre.charge;
        } while (++tries < 500 && ((actIdx.length >= 2 && actIdx.every(i => pads[i] === pads[actIdx[0]])) || (pre && !actIdx.some(i => i !== pre.slot && pads[i] === -pre.charge))));
        g.preTarget = pre ? pre.id : null;
        g.act = act;
        g.pads = pads; const o = room.opts; g.convAt = now + o.convDelay * 1000; g.flipAt = g.convAt + o.convDur * 1000; g.boomAt = g.flipAt + o.boom * 1000;
        fx(room, { k: 'bossdead', by: p.nick });
      }
      break;
    }
    case 'ping': {
      if (now - p.lastPing < 250) return;
      const x = Number(m.x), y = Number(m.y);
      if (!isFinite(x) || !isFinite(y) || Math.abs(x) > 700 || y < -200 || y > 700) return;
      p.lastPing = now;
      bcast(room, { t: 'ping', id: p.id, nick: p.nick, x: Math.round(x), y: Math.round(y) });
      break;
    }
  }
}

function restoreSlots(room) { // 대기실(방장) 배치로 되돌리기
  room.slots.forEach((pid, i) => { if (pid && room.players.get(pid)) room.players.get(pid).slot = i; });
}
function startGame(room) {
  restoreSlots(room);
  if (room.opts.randomSeat) { // 이번 판만 무작위 자리 (대기실 배치는 유지)
    const seats = shuffle([0, 1, 2, 3, 4, 5, 6, 7]);
    [...room.players.values()].forEach((p, i) => { p.slot = seats[i]; });
  }
  const ps = shuffle([...room.players.values()]);
  const n = ps.length, k = Math.floor(Math.random() * (n + 1)); // + 전하 인원 (0~n 랜덤)
  ps.forEach((p, i) => {
    p.charge = i < k ? 1 : -1; p.alive = true; p.inGame = true; p.reason = null; p.dmg = 0; p.lastAtk = 0;
    const a = 0.25 + Math.random() * (Math.PI - 0.5), r = 150 + Math.random() * 160;
    const q = clampPos(Math.cos(a) * r, Math.sin(a) * r); p.x = q.x; p.y = q.y;
  });
  const now = Date.now();
  room.phase = 'intro';
  room.g = { hammerAt: now + room.opts.intro * 1000, zoneLeft: null, graceEnd: 0, enrageAt: 0, bossMax: 0, bossHp: 0, pads: null, convAt: 0, flipAt: 0, boomAt: 0, convTarget: null, convPos: null, split: [k, n - k] };
  for (const p of room.players.values()) p.conn.send({ t: 'start', x: p.x, y: p.y, slot: p.slot, rnd: !!room.opts.randomSeat });
  broadcastRoom(room);
}

function endGame(room) {
  room.phase = 'result';
  const list = [...room.players.values()].filter(p => p.inGame).sort((a, b) => a.slot - b.slot)
    .map(p => ({ id: p.id, nick: p.nick, slot: p.slot, alive: p.alive, reason: p.reason, charge: p.charge, dmg: p.dmg }));
  sendSnap(room, Date.now());
  bcast(room, { t: 'result', list });
  broadcastRoom(room);
}

function step(room, now) {
  const g = room.g;
  if (room.phase === 'intro' && now >= g.hammerAt) {
    room.phase = 'hammer';
    g.zoneLeft = Math.random() < 0.5 ? 1 : -1;
    g.graceEnd = now + room.opts.grace * 1000; g.enrageAt = g.graceEnd + room.opts.enrage * 1000;
    g.bossMax = g.bossHp = room.opts.hpPer * Math.max(1, alivePlayers(room).length);
    fx(room, { k: 'hammer' });
  }
  // 망치 장판: 판정 시작 후 반대 색 구역에 있으면 사망 (보스 체력 0 후 3초까지 유지)
  if ((room.phase === 'hammer' || room.phase === 'pads') && now >= g.graceEnd) {
    for (const p of alivePlayers(room)) {
      const side = p.x < 0 ? g.zoneLeft : -g.zoneLeft;
      if (side !== p.charge) kill(room, p, '망치 장판 — 다른 색 구역');
    }
  }
  if (room.phase === 'hammer' && now >= g.enrageAt) {
    for (const p of alivePlayers(room)) kill(room, p, '광폭화 — 보스를 시간 내에 못 잡음');
  }
  if (room.phase === 'pads' && now >= g.convAt) {
    const al = alivePlayers(room);
    if (al.length) {
      const pre = g.preTarget && al.find(q => q.id === g.preTarget);
      const t = pre || al[Math.floor(Math.random() * al.length)];
      room.phase = 'conv'; g.convTarget = t.id; g.convPos = { x: t.x, y: t.y };
      fx(room, { k: 'conv', id: t.id, nick: t.nick });
    }
  }
  if (room.phase === 'conv') {
    const t = room.players.get(g.convTarget);
    if (t && t.alive) g.convPos = { x: t.x, y: t.y }; // 변환 장판은 대상자를 따라다님
    if (now >= g.flipAt) {
      const ids = [];
      for (const p of alivePlayers(room)) {
        if (Math.hypot(p.x - g.convPos.x, p.y - g.convPos.y) <= C.CONV_R) { p.charge *= -1; ids.push(p.id); }
      }
      room.phase = 'wait';
      fx(room, { k: 'flip', ids, x: Math.round(g.convPos.x), y: Math.round(g.convPos.y) });
    }
  }
  if (room.phase === 'wait' && now >= g.boomAt) {
    const occ = Array.from({ length: 8 }, () => []);
    for (const p of alivePlayers(room)) {
      let idx = -1;
      for (let i = 0; i < 8; i++) { if (!g.act[i]) continue; const pp = padPos(i); if (Math.hypot(p.x - pp.x, p.y - pp.y) <= pp.r) { idx = i; break; } }
      if (idx < 0) kill(room, p, '폭발 — 반구 장판 밖');
      else occ[idx].push(p);
    }
    occ.forEach((list, i) => {
      if (list.length > 1) list.forEach(p => kill(room, p, '폭발 — 한 장판에 2명 이상 (' + SLOTS[i] + ')'));
      else if (list.length === 1 && g.pads[i] !== list[0].charge) kill(room, list[0], '폭발 — 다른 색 반구 장판 (' + SLOTS[i] + ')');
    });
    fx(room, { k: 'boom' });
    endGame(room); return;
  }
  if (GAME_PHASES.includes(room.phase) && alivePlayers(room).length === 0) endGame(room);
}

function sendSnap(room, now) {
  const g = room.g;
  bcast(room, {
    t: 's', now, ph: room.phase,
    g: { zl: g.zoneLeft, ha: g.hammerAt, ge: g.graceEnd, ea: g.enrageAt, hp: g.bossHp, hm: g.bossMax, pads: g.pads, act: g.act, ca: g.convAt, fa: g.flipAt, ba: g.boomAt, ct: g.convTarget, cp: g.convPos, split: g.split },
    ps: [...room.players.values()].map(p => [p.id, Math.round(p.x), Math.round(p.y), p.charge, p.alive ? 1 : 0, p.inGame ? 1 : 0]),
  });
}

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (!GAME_PHASES.includes(room.phase)) continue;
    step(room, now);
    if (GAME_PHASES.includes(room.phase)) sendSnap(room, now);
  }
}, 50);
setInterval(() => { for (const c of conns) c.frame(9, Buffer.alloc(0)); }, 20000);

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  모르둠 뇌사패턴 미니게임 서버 실행 중 (v' + VERSION + ')');
  console.log('  → 이 PC에서:  http://localhost:' + PORT);
  const nets = require('os').networkInterfaces();
  const virt = /vEthernet|VirtualBox|VMware|Hyper-V|WSL|Loopback|Docker|Bluetooth|Tailscale|ZeroTier|Hamachi|TAP|VPN/i;
  const list = [];
  for (const k of Object.keys(nets)) for (const n of nets[k]) {
    if (n.family !== 'IPv4' || n.internal || n.address.startsWith('169.254.')) continue;
    list.push({ name: k, addr: n.address, virtual: virt.test(k) });
  }
  list.sort((a, b) => a.virtual - b.virtual);
  for (const n of list) console.log('  → 같은 와이파이/공유기' + (n.virtual ? ' (가상 어댑터, 아마 아님)' : '') + ': http://' + n.addr + ':' + PORT + '   [' + n.name + ']');
  console.log('');
  console.log('  다른 기기에서 접속이 안 되면: 이 폴더의 "방화벽허용.bat" 를 한 번 실행하세요.');
  console.log('');
});
