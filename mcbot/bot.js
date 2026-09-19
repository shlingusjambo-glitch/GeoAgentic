// GeoAgentic Minecraft bot: joins the user's world (Open to LAN) as its own player and exposes the world as TEXT
// plus high-level actions over a tiny HTTP API, so the agent plays from state, not screenshots.
// POST / {"action": "...", ...}  ->  JSON { ok, result | error, state }
const http = require('http');
const dgram = require('dgram');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');

// Several bots can live in one world; `bot` is the one the current request addresses (set per request).
const BOTS = {};  // name -> { bot, chat: [], busy: null }
let lanPort = null, busy = null, lastPlaceError = '';
// Requests for different bots run concurrently: `bot` and `lastChat` resolve through the current async context,
// so one bot's action can never be hijacked by another's.
const { AsyncLocalStorage } = require('async_hooks');
const ctx = new AsyncLocalStorage();
const fallback = { bot: null, chat: [] };
Object.defineProperty(globalThis, 'bot', { get: () => (ctx.getStore() || fallback).bot, set: (v) => { (ctx.getStore() || fallback).bot = v; } });
Object.defineProperty(globalThis, 'lastChat', { get: () => (ctx.getStore() || fallback).chat, set: (v) => { (ctx.getStore() || fallback).chat = v; } });
function select(name) {
  const entry = name ? BOTS[name] : Object.values(BOTS)[0];
  bot = entry ? entry.bot : null; lastChat = entry ? entry.chat : [];
  return entry;
}

// ---- LAN discovery: Minecraft announces "Open to LAN" worlds on 224.0.2.60:4445 ----
const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
udp.on('message', (msg) => { const m = /\[AD\](\d+)\[\/AD\]/.exec(msg.toString()); if (m) lanPort = parseInt(m[1]); });
udp.bind(4445, () => { try { udp.addMembership('224.0.2.60'); } catch (e) {} });

// pathfinder.goto never returns for unreachable goals: bound every navigation
async function go(goal, ms = 12000) {
  let timer;
  try {
    await Promise.race([bot.pathfinder.goto(goal), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('no path')), ms); })]);
  } finally { clearTimeout(timer); bot.pathfinder.setGoal(null); }
}
const V = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function state() {
  if (!bot || !bot.entity) return { connected: false, lanPort };
  const p = bot.entity.position;
  const inv = {};
  for (const it of bot.inventory.items()) inv[it.name] = (inv[it.name] || 0) + it.count;
  const near = {};
  for (const pos of bot.findBlocks({ matching: (b) => b.name !== 'air' && b.name !== 'cave_air', maxDistance: 8, count: 400 })) {
    const b = bot.blockAt(pos); if (!b) continue;
    near[b.name] = (near[b.name] || 0) + 1;
  }
  const ents = Object.values(bot.entities).filter(e => e !== bot.entity && e.position.distanceTo(p) < 16)
    .map(e => `${e.username || e.name || e.type} ${Math.round(e.position.distanceTo(p))}m`).slice(0, 12);
  const players = Object.keys(bot.players).filter(n => n !== bot.username);
  const yaw = ((bot.entity.yaw * 180 / Math.PI) + 360) % 360;
  const facing = ['south', 'west', 'north', 'east'][Math.round(yaw / 90) % 4];
  const under = bot.blockAt(p.offset(0, -1, 0));
  const ahead = bot.blockAtCursor(5);
  return {
    connected: true, name: bot.username, position: V(p), facing, health: bot.health, food: bot.food,
    time: bot.time.isDay ? 'day' : 'night', standing_on: under && under.name, looking_at: ahead ? `${ahead.name} at ${V(ahead.position)}` : 'nothing within reach',
    held: bot.heldItem ? bot.heldItem.name : 'nothing', inventory: inv, nearby_blocks: near, nearby_entities: ents, players,
    recent_chat: lastChat.slice(-8), busy: (BOTS[bot.username] || {}).busy || null, bots: Object.keys(BOTS),
    warning: bot.food <= 6 ? 'hungry: find food (kill animals, harvest crops/apples) and eat' : (bot.health <= 6 ? 'low health: retreat, eat, avoid mobs' : undefined),
  };
}

// Self-defense reflex: hit hostile mobs that come within reach, back away from creepers.
const HOSTILE = new Set(['zombie', 'skeleton', 'spider', 'cave_spider', 'creeper', 'enderman', 'witch', 'drowned', 'husk', 'stray', 'phantom', 'slime', 'zombie_villager', 'pillager', 'vindicator']);
let lastSwing = 0;
function defendAll() { for (const e of Object.values(BOTS)) ctx.run({ bot: e.bot, chat: e.chat }, () => { try { defend(); } catch (x) {} }); }
function defend() {
  if (!bot || !bot.entity) return;
  const p = bot.entity.position;
  const mob = Object.values(bot.entities).filter(e => e.name && HOSTILE.has(e.name) && e.position.distanceTo(p) < 3.5)
    .sort((a, b) => a.position.distanceTo(p) - b.position.distanceTo(p))[0];
  if (!mob) return;
  if (mob.name === 'creeper') { bot.setControlState('back', true); setTimeout(() => bot.setControlState('back', false), 1200); return; }
  if (Date.now() - lastSwing < 600) return;
  lastSwing = Date.now();
  const sword = bot.inventory.items().find(i => /sword|axe/.test(i.name));
  const swing = () => { bot.lookAt(mob.position.offset(0, mob.height * 0.8, 0), true).then(() => bot.attack(mob)).catch(() => {}); };
  if (sword && (!bot.heldItem || bot.heldItem.name !== sword.name)) bot.equip(sword, 'hand').then(swing).catch(swing); else swing();
  lastChat.push(`(fighting a ${mob.name})`);
}
setInterval(defendAll, 400);

async function connect(port, username) {
  username = username || 'GeoAgent';
  if (BOTS[username]) { select(username); if (bot && bot.entity) return `${username} is already in the world at ${V(bot.entity.position)}`; try { BOTS[username].bot.quit(); } catch (e) {} delete BOTS[username]; }
  port = port || lanPort;
  if (!port) throw new Error('no LAN world found: in Minecraft press Escape > Open to LAN > Start LAN World (or give the port)');
  const entry = { bot: null, chat: [], busy: null };
  await new Promise((resolve, reject) => {
    const nb = mineflayer.createBot({ host: '127.0.0.1', port, username, auth: 'offline' });
    entry.bot = nb;
    nb.loadPlugin(pathfinder);
    nb.once('spawn', () => { nb.pathfinder.setMovements(new Movements(nb)); resolve(); });
    nb.on('chat', (u, m) => { if (u === username) return; entry.chat.push(`${u}: ${m}`); if (entry.chat.length > 30) entry.chat.shift(); });
    nb.on('whisper', (u, m) => { entry.chat.push(`${u} (private): ${m}`); if (entry.chat.length > 30) entry.chat.shift(); });
    nb.on('kicked', (r) => { entry.chat.push(`kicked: ${r}`); delete BOTS[username]; });
    nb.on('error', (e) => reject(new Error('join failed: ' + e.message + ' (LAN worlds must not require online authentication)')));
    nb.on('end', () => { delete BOTS[username]; });
    setTimeout(() => reject(new Error('join timed out')), 20000);
  });
  BOTS[username] = entry; select(username);
  return `joined the world as ${username} at ${V(bot.entity.position)}`;
}

async function goto(x, y, z, range = 1) {
  await go(new goals.GoalNear(x, y, z, range), 60000);
  return `arrived near ${x},${y},${z}`;
}
async function gotoPlayer(name) {
  const pl = bot.players[name] || Object.values(bot.players).find(p => p.username !== bot.username);
  if (!pl || !pl.entity) throw new Error(`cannot see player ${name || ''} (too far away?)`);
  await go(new goals.GoalFollow(pl.entity, 2), 30000);
  return `standing next to ${pl.username}`;
}
const CLAIMS = new Map();  // "x,y,z" -> bot name: blocks another bot is already working on
function findBlocks(name, count, maxDistance = 32) {
  name = name.toLowerCase().replace(/s$/, '').replace(/^wood$/, 'log').replace(/^tree$/, 'log');  // logs, trees, stones...
  const ids = bot.registry.blocksByName[name] ? [bot.registry.blocksByName[name].id]
    : Object.values(bot.registry.blocksByName).filter(b => b.name.includes(name)).map(b => b.id);
  if (!ids.length) throw new Error(`unknown block "${name}"`);
  const me = bot.username;
  return bot.findBlocks({ matching: ids, maxDistance, count: count + 8 }).filter(p => { const c = CLAIMS.get(V(p)); return !c || c === me; }).slice(0, count);
}
async function digOne(pos) {
  const b = bot.blockAt(pos);
  if (!b || b.name === 'air') return false;
  const key = V(pos); if (CLAIMS.get(key) && CLAIMS.get(key) !== bot.username) return false;
  CLAIMS.set(key, bot.username); setTimeout(() => CLAIMS.delete(key), 20000);
  try { return await digOneInner(pos, b); } finally { CLAIMS.delete(key); }
}
async function digOneInner(pos, b) {
  if (!bot.canDigBlock(b) || bot.entity.position.distanceTo(pos) > 4.2) {
    await go(new goals.GoalLookAtBlock(pos, bot.world, { reach: 4 }), 10000);
  }
  const tool = bot.pathfinder.bestHarvestTool(b); if (tool && (!bot.heldItem || bot.heldItem.name !== tool.name)) await bot.equip(tool, 'hand');
  await bot.lookAt(pos.offset(0.5, 0.5, 0.5), true);
  await bot.dig(b);
  return true;
}
function needsTool(name) {  // stone/ores drop nothing without a pickaxe
  const bl = bot.registry.blocksByName[name]; if (!bl || !bl.harvestTools) return null;
  const ok = bot.inventory.items().some(i => bl.harvestTools[i.type]);
  if (ok) return null;
  const want = Object.keys(bl.harvestTools).map(id => bot.registry.items[id] && bot.registry.items[id].name).filter(Boolean);
  return `${name} drops nothing without a ${want.find(n => /wooden|stone/.test(n)) || want[0] || 'proper tool'}. Craft one (collect logs -> craft crafting_table, stick, wooden_pickaxe) or use dirt/sand/logs instead`;
}
async function shelter() {  // classic night hole: dig down 3, plug the top
  const p = bot.entity.position.floored();
  for (let i = 1; i <= 3; i++) { const bb = bot.blockAt(p.offset(0, -i, 0)); if (bb && bb.name !== 'air') { await bot.dig(bb); await sleep(300); } }
  await sleep(800);
  const top = bot.entity.position.floored().offset(0, 2, 0);
  const mat = bot.inventory.items().find(i => /dirt|cobblestone|stone|planks|log|sand|gravel/.test(i.name));
  if (mat) { try { await bot.equip(mat, 'hand'); await bot.placeBlock(bot.blockAt(top.offset(0, 0, 1)) , new Vec3(0, 0, -1)); } catch (e) { try { await bot.placeBlock(bot.blockAt(top.offset(1, 0, 0)), new Vec3(-1, 0, 0)); } catch (e2) {} } }
  return `sheltered in a hole at ${V(bot.entity.position)}${mat ? ' with the top covered' : ' (no block to cover the top)'}; wait for day, then dig up`;
}
async function collect(name, count) {
  const nt = needsTool(name); if (nt) throw new Error(nt);
  const wanted = count; count = Math.min(count, 24);  // chunked: keep each call short and the agent in the loop
  let got = 0;
  for (let tries = 0; got < count && tries < count * 3; tries++) {
    const found = findBlocks(name, 8);
    if (!found.length) throw new Error(`no ${name} within 32 blocks (collected ${got}). Try another block that is nearby (see nearby_blocks): dirt and stone are almost always available`);
    const p = bot.entity.position, others = Object.values(BOTS).map(e => e.bot).filter(o => o !== bot && o.entity);
    found.sort((a, b) => (a.distanceTo(p) + 0.5 * others.reduce((s, o) => s + Math.max(0, 6 - a.distanceTo(o.entity.position)), 0))
                       - (b.distanceTo(p) + 0.5 * others.reduce((s, o) => s + Math.max(0, 6 - b.distanceTo(o.entity.position)), 0)));
    if (await digOne(found[0])) { got++; await sleep(150); await pickUp(); }
  }
  await pickUp();
  const more = wanted - got;
  return `collected ${got} ${name}; inventory now: ${JSON.stringify(state().inventory)}` + (more > 0 ? `. ${more} more to go: call collect ${name} ${more} again` : '');
}
async function pickUp() {  // walk over nearby dropped items
  for (let i = 0; i < 4; i++) {
    const p = bot.entity.position;
    const drop = Object.values(bot.entities).filter(e => e.name === 'item' && e.position.distanceTo(p) < 7)
      .sort((a, b) => a.position.distanceTo(p) - b.position.distanceTo(p))[0];
    if (!drop) return;
    try { await go(new goals.GoalBlock(Math.floor(drop.position.x), Math.floor(drop.position.y), Math.floor(drop.position.z)), 4000); } catch (e) { return; }
    await sleep(250);
  }
}
async function equipItem(name) {
  const it = bot.inventory.items().find(i => i.name === name) || bot.inventory.items().find(i => i.name.includes(name));
  if (!it) throw new Error(`no ${name} in inventory`);
  await bot.equip(it, 'hand'); return `holding ${it.name}`;
}
const REPLACEABLE = new Set(['air', 'cave_air', 'void_air', 'short_grass', 'tall_grass', 'grass', 'fern', 'large_fern', 'dead_bush', 'dandelion', 'poppy', 'snow', 'seagrass', 'vine']);
const free = (pos) => { const b = bot.blockAt(pos); return !b || REPLACEABLE.has(b.name); };
async function placeAt(pos, name) {
  // place block `name` at pos, using any solid neighbour as the reference face
  if (!free(pos)) return false;
  await equipItem(name);
  const faces = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];
  for (const f of faces) {
    const ref = bot.blockAt(pos.minus(f));
    if (!ref || REPLACEABLE.has(ref.name) || ref.name === 'water' || ref.name === 'lava') continue;
    try {
      if (bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) > 4 || !bot.canSeeBlock(ref)) {
        await go(new goals.GoalPlaceBlock(pos, bot.world, { range: 4 }), 8000);
      }
      const me = bot.entity.position.floored();
      if (me.equals(pos) || me.offset(0, 1, 0).equals(pos)) continue;  // cannot place where we stand
      await bot.lookAt(ref.position.offset(0.5, 0.5, 0.5), true);
      await bot.placeBlock(ref, f);
      return true;
    } catch (e) { lastPlaceError = e.message; }
  }
  return false;
}
async function place(name, x, y, z) {
  const pos = (x === undefined) ? bot.blockAtCursor(5)?.position.offset(0, 1, 0) : new Vec3(x, y, z);
  if (!pos) throw new Error('nothing to place against; give x y z');
  if (!(await placeAt(pos, name))) throw new Error(`could not place ${name} at ${V(pos)}: ${lastPlaceError}`);
  return `placed ${name} at ${V(pos)}`;
}
async function craft(name, count = 1) {
  const item = bot.registry.itemsByName[name] || Object.values(bot.registry.itemsByName).find(i => i.name.includes(name));
  if (!item) throw new Error(`unknown item "${name}"`);
  let table = null;
  let recipes = bot.recipesFor(item.id, null, 1, null);
  if (!recipes.length) {
    const tb = bot.findBlock({ matching: bot.registry.blocksByName.crafting_table.id, maxDistance: 32 });
    if (tb) { table = tb; await go(new goals.GoalNear(tb.position.x, tb.position.y, tb.position.z, 2), 30000); recipes = bot.recipesFor(item.id, null, 1, tb); }
  }
  if (!recipes.length) throw new Error(`cannot craft ${name}: missing ingredients or no crafting table nearby`);
  await bot.craft(recipes[0], count, table);
  return `crafted ${count} x ${name}; inventory: ${JSON.stringify(state().inventory)}`;
}
async function buildHouse(size = 5, height = 3, name) {
  size = Math.max(3, Math.min(9, size));
  // a hollow box with a doorway and a flat roof, next to where the bot stands, from the given block
  const inv = state().inventory;
  name = name || Object.keys(inv).find(k => /planks|cobblestone|stone|dirt|log|sand|bricks/.test(k));
  if (!name) throw new Error('no building blocks in inventory. Dirt is everywhere: minecraft("collect dirt 50") then build again (logs/cobblestone also work)');
  // pick a site: the nearest footprint (within 10 blocks, +-2 levels) with mostly solid ground and free space above
  const me = bot.entity.position.floored();
  let base = null, bestScore = -1;
  for (let dy = -2; dy <= 2; dy++) for (let r = 1; r <= 10 && bestScore < 1; r++) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
    if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
    const o = me.offset(dx, dy, dz); let ground = 0, clear = 0;
    for (let x = 0; x < size; x++) for (let z = 0; z < size; z++) {
      const g = bot.blockAt(o.offset(x, -1, z)); if (g && !REPLACEABLE.has(g.name) && g.name !== 'water' && g.name !== 'lava') ground++;
      let ok = true; for (let y = 0; y <= height; y++) if (!free(o.offset(x, y, z))) ok = false; if (ok) clear++;
    }
    const cells = size * size, score = (ground / cells) * (clear / cells) - r * 0.01;
    if (ground / cells >= 0.75 && clear === cells && score > bestScore) { bestScore = score; base = o; }
  }
  if (!base) throw new Error('no flat enough spot within 10 blocks to build on; move somewhere flatter (goto) and try again');
  const targets = [];
  for (let x = 0; x < size; x++) for (let z = 0; z < size; z++) {  // fill missing ground first
    const g = bot.blockAt(base.offset(x, -1, z)); if (!g || REPLACEABLE.has(g.name) || g.name === 'water') targets.push(base.offset(x, -1, z));
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < size; x++) for (let z = 0; z < size; z++) {
    const edge = x === 0 || z === 0 || x === size - 1 || z === size - 1;
    const door = z === 0 && x === Math.floor(size / 2) && y < 2;
    if (edge && !door) targets.push(base.offset(x, y, z));
  }
  for (let x = 0; x < size; x++) for (let z = 0; z < size; z++) targets.push(base.offset(x, height, z));  // roof
  const need = targets.length;  // includes ground fills
  if ((inv[name] || 0) < need * 0.6) throw new Error(`need ${need} ${name} for a ${size}x${size} house, have ${inv[name] || 0}. Next: minecraft("collect ${name} ${need - (inv[name] || 0)}")`);
  const short = Math.max(0, need - (inv[name] || 0));
  const inside = (p) => p.x >= base.x - 1 && p.x <= base.x + size && p.z >= base.z - 1 && p.z <= base.z + size && p.y >= base.y - 1 && p.y <= base.y + height + 1;
  const stepOut = async () => {  // never build from inside or on top of the house
    if (inside(bot.entity.position.floored())) {
      for (const spot of [base.offset(-2, 0, -2), base.offset(size + 1, 0, -2), base.offset(-2, 0, size + 1), base.offset(size + 1, 0, size + 1)]) {
        try { await go(new goals.GoalNear(spot.x, spot.y, spot.z, 1), 8000); if (!inside(bot.entity.position.floored())) return; } catch (e) {}
      }
    }
  };
  let placed = 0; let todo = targets;
  for (let pass = 0; pass < 3 && todo.length; pass++) {
    const left = [];
    for (const t of todo) {
      if (!free(t)) { placed++; continue; }
      await stepOut();
      if (await placeAt(t, name)) placed++; else left.push(t);
    }
    todo = left;
  }
  await stepOut();
  return `house built at ${V(base)} (${size}x${size}, ${height} high, doorway on the north side): placed ${placed} ${name}` + (todo.length ? `, ${todo.length} could not be placed` : '') + (short ? ` (was ${short} short of a full ${need})` : '');
}

async function eat() {
  const food = bot.inventory.items().find(i => bot.registry.foodsByName && bot.registry.foodsByName[i.name]);
  if (!food) throw new Error('no food in inventory (bread, apples, cooked meat, carrots...)');
  await bot.equip(food, 'hand'); await bot.consume();
  return `ate ${food.name}; food now ${bot.food}/20`;
}
// eat on our own when hungry and something edible is at hand, before long actions
async function autoEat() {
  try { if (bot.food <= 6 && bot.inventory.items().some(i => bot.registry.foodsByName && bot.registry.foodsByName[i.name])) await eat(); } catch (e) {}
}
// ---------- more of a life: combat, chests, trading, smelting, farming, beds, exploring, building shapes ----------
const HOMES = {};  // bot name -> Vec3
function nearestEntity(name, maxDist = 32) {
  const p = bot.entity.position; const n = (name || '').toLowerCase();
  return Object.values(bot.entities).filter(e => e !== bot.entity && e.position.distanceTo(p) < maxDist &&
      (!n || (e.name || '').includes(n) || (e.username || '').toLowerCase() === n || (e.displayName || '').toLowerCase().includes(n)))
    .sort((a, b) => a.position.distanceTo(p) - b.position.distanceTo(p))[0];
}
async function attackEntity(name, count = 1) {
  let killed = 0, drops = 0;
  for (let i = 0; i < count; i++) {
    const e = nearestEntity(name); if (!e) throw new Error(`no ${name} within 32 blocks (killed ${killed})`);
    const weapon = bot.inventory.items().filter(it => /sword|axe/.test(it.name)).sort((a, b) => (/diamond/.test(b.name) ? 3 : /iron/.test(b.name) ? 2 : /stone/.test(b.name) ? 1 : 0) - (/diamond/.test(a.name) ? 3 : /iron/.test(a.name) ? 2 : /stone/.test(a.name) ? 1 : 0))[0];
    if (weapon) await bot.equip(weapon, 'hand').catch(() => {});
    const t0 = Date.now();
    while (bot.entities[e.id] && Date.now() - t0 < 40000) {
      if (bot.entity.position.distanceTo(e.position) > 2.8) { try { await go(new goals.GoalFollow(e, 2), 6000); } catch (x) {} }
      await bot.lookAt(e.position.offset(0, e.height * 0.8, 0), true);
      bot.attack(e); await sleep(650);
    }
    if (!bot.entities[e.id]) killed++;
    await pickUp();
  }
  return `killed ${killed} ${name}; inventory: ${JSON.stringify(state().inventory)}`;
}
async function nearestChest() {
  const c = bot.findBlock({ matching: [bot.registry.blocksByName.chest.id, bot.registry.blocksByName.barrel ? bot.registry.blocksByName.barrel.id : -1].filter(x => x >= 0), maxDistance: 32 });
  if (!c) throw new Error('no chest within 32 blocks: craft chest (8 planks) and place it');
  await go(new goals.GoalNear(c.position.x, c.position.y, c.position.z, 2), 30000);
  return c;
}
async function chestList() {
  const c = await nearestChest(); const ch = await bot.openContainer(c);
  const items = {}; for (const it of ch.containerItems()) items[it.name] = (items[it.name] || 0) + it.count;
  ch.close(); return `chest at ${V(c.position)} contains: ${JSON.stringify(items)}`;
}
async function chestStore(name, count) {
  const c = await nearestChest(); const ch = await bot.openContainer(c);
  const items = bot.inventory.items().filter(i => !name || name === 'all' || i.name === name || i.name.includes(name));
  let moved = 0;
  for (const it of items) { const n = Math.min(it.count, (count || 999) - moved); if (n <= 0) break; await ch.deposit(it.type, null, n); moved += n; }
  ch.close(); return `stored ${moved} ${name || 'items'} in the chest at ${V(c.position)}`;
}
async function chestTake(name, count) {
  const c = await nearestChest(); const ch = await bot.openContainer(c);
  const items = ch.containerItems().filter(i => i.name === name || i.name.includes(name));
  let moved = 0;
  for (const it of items) { const n = Math.min(it.count, (count || 64) - moved); if (n <= 0) break; await ch.withdraw(it.type, null, n); moved += n; }
  ch.close(); if (!moved) throw new Error(`no ${name} in that chest`); return `took ${moved} ${name} from the chest`;
}
async function giveTo(who, name, count) {
  const target = bot.players[who] && bot.players[who].entity ? bot.players[who].entity : nearestEntity(who);
  if (!target) throw new Error(`cannot see ${who}; ask them to come (say) or goto their position`);
  const it = bot.inventory.items().find(i => i.name === name || i.name.includes(name)); if (!it) throw new Error(`no ${name} to give`);
  await go(new goals.GoalFollow(target, 2), 30000);
  await bot.lookAt(target.position.offset(0, 1, 0), true);
  await bot.toss(it.type, null, Math.min(count || it.count, it.count));
  return `gave ${Math.min(count || it.count, it.count)} ${it.name} to ${who} (dropped at their feet)`;
}
async function dropItem(name, count) {
  const it = bot.inventory.items().find(i => i.name === name || i.name.includes(name)); if (!it) throw new Error(`no ${name}`);
  await bot.toss(it.type, null, Math.min(count || it.count, it.count)); return `dropped ${name}`;
}
async function smelt(name, count = 1) {
  let f = bot.findBlock({ matching: bot.registry.blocksByName.furnace.id, maxDistance: 32 });
  if (!f) throw new Error('no furnace nearby: craft furnace (8 cobblestone) and place it');
  await go(new goals.GoalNear(f.position.x, f.position.y, f.position.z, 2), 30000);
  const input = bot.inventory.items().find(i => i.name === name || i.name.includes(name)); if (!input) throw new Error(`no ${name} to smelt`);
  const fuel = bot.inventory.items().find(i => /coal|planks|log|stick|charcoal/.test(i.name)); if (!fuel) throw new Error('no fuel (coal, planks, logs)');
  const fu = await bot.openFurnace(f);
  await fu.putFuel(fuel.type, null, Math.min(fuel.count, Math.ceil(count / 8) + 1));
  await fu.putInput(input.type, null, Math.min(input.count, count));
  const t0 = Date.now(); let out = null;
  while (Date.now() - t0 < 12000 * count + 5000) { await sleep(2000); out = fu.outputItem(); if (out && out.count >= Math.min(input.count, count)) break; }
  if (out) await fu.takeOutput();
  fu.close(); return `smelted ${out ? out.count + ' ' + out.name : 'nothing yet (come back later: take from the furnace)'}`;
}
async function till() {
  const hoe = bot.inventory.items().find(i => /hoe/.test(i.name)); if (!hoe) throw new Error('no hoe: craft wooden_hoe');
  const water = bot.findBlock({ matching: bot.registry.blocksByName.water.id, maxDistance: 16 });
  const cands = bot.findBlocks({ matching: [bot.registry.blocksByName.grass_block.id, bot.registry.blocksByName.dirt.id], maxDistance: water ? 6 : 8, count: 30, point: water ? water.position : undefined })
    .filter(p => free(p.offset(0, 1, 0)));
  if (!cands.length) throw new Error('no dirt/grass with open sky nearby');
  await bot.equip(hoe, 'hand'); let n = 0;
  for (const p of cands.slice(0, 9)) { try { await go(new goals.GoalNear(p.x, p.y + 1, p.z, 2), 8000); await bot.activateBlock(bot.blockAt(p)); n++; } catch (e) {} }
  return `tilled ${n} blocks of farmland${water ? ' near water' : ' (no water nearby: crops grow slowly)'}`;
}
async function plant(name = 'wheat_seeds') {
  const seed = bot.inventory.items().find(i => i.name === name || i.name.includes(name.replace('_seeds', ''))); if (!seed) throw new Error(`no ${name}`);
  const farm = bot.findBlocks({ matching: bot.registry.blocksByName.farmland.id, maxDistance: 16, count: 30 }).filter(p => free(p.offset(0, 1, 0)));
  if (!farm.length) throw new Error('no empty farmland: till first');
  await bot.equip(seed, 'hand'); let n = 0;
  for (const p of farm) { try { await go(new goals.GoalNear(p.x, p.y + 1, p.z, 2), 8000); await bot.placeBlock(bot.blockAt(p), new Vec3(0, 1, 0)); n++; } catch (e) {} if (!bot.inventory.items().find(i => i.name === seed.name)) break; }
  return `planted ${n} ${seed.name}`;
}
async function harvest(name = 'wheat') {
  const crop = bot.registry.blocksByName[name]; if (!crop) throw new Error(`unknown crop ${name}`);
  const ripe = bot.findBlocks({ matching: crop.id, maxDistance: 16, count: 40 }).filter(p => { const bl = bot.blockAt(p); const age = bl.getProperties ? bl.getProperties().age : undefined; return age === undefined || age >= 7; });
  if (!ripe.length) throw new Error(`no ripe ${name} nearby`);
  let n = 0; for (const p of ripe) { if (await digOne(p)) n++; }
  await pickUp(); return `harvested ${n} ${name}; inventory: ${JSON.stringify(state().inventory)}`;
}
async function sleepInBed() {
  const bed = bot.findBlock({ matching: (bl) => bl.name.endsWith('_bed'), maxDistance: 32 });
  if (!bed) throw new Error('no bed nearby: craft a bed (3 wool + 3 planks) and place it');
  await go(new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2), 30000);
  await bot.sleep(bed); return 'sleeping in the bed (the night passes if everyone sleeps); wake when done';
}
async function explore(dir, dist = 24) {
  const d = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }[dir] || [Math.cos(bot.entity.yaw), Math.sin(bot.entity.yaw)];
  const p = bot.entity.position; const tx = Math.floor(p.x + d[0] * dist), tz = Math.floor(p.z + d[1] * dist);
  try { await go(new goals.GoalXZ(tx, tz), 60000); } catch (e) {}
  return `explored ${dir || 'ahead'}: now at ${V(bot.entity.position)}. ` + scout();
}
function scout() {
  const p = bot.entity.position; const notable = {};
  for (const n of ['water', 'lava', 'coal_ore', 'iron_ore', 'copper_ore', 'gold_ore', 'diamond_ore', 'crafting_table', 'furnace', 'chest', 'oak_log', 'birch_log', 'spruce_log', 'sand', 'gravel', 'wheat', 'sugar_cane', 'pumpkin', 'melon']) {
    const bl = bot.registry.blocksByName[n]; if (!bl) continue;
    const f = bot.findBlock({ matching: bl.id, maxDistance: 40 }); if (f) notable[n] = `${V(f.position)} (${Math.round(f.position.distanceTo(p))}m)`;
  }
  const ents = Object.values(bot.entities).filter(e => e !== bot.entity && e.position.distanceTo(p) < 40).map(e => `${e.username || e.name} ${Math.round(e.position.distanceTo(p))}m ${V(e.position)}`).slice(0, 15);
  return `notable within 40: ${Object.entries(notable).map(([k, v]) => k + ' ' + v).join('; ') || 'nothing special'}. entities: ${ents.join(', ') || 'none'}`;
}
function findThing(name) {
  const bl = bot.registry.blocksByName[name] || Object.values(bot.registry.blocksByName).find(x => x.name.includes(name));
  if (bl) { const f = bot.findBlock({ matching: bl.id, maxDistance: 64 }); if (f) return `${f.name} at ${V(f.position)} (${Math.round(f.position.distanceTo(bot.entity.position))}m)`; }
  const e = nearestEntity(name, 64); if (e) return `${e.username || e.name} at ${V(e.position)} (${Math.round(e.position.distanceTo(bot.entity.position))}m)`;
  return `no ${name} within 64 blocks`;
}
async function useBlock(name) {
  const bl = name ? (bot.registry.blocksByName[name] || Object.values(bot.registry.blocksByName).find(x => x.name.includes(name))) : null;
  const target = bl ? bot.findBlock({ matching: bl.id, maxDistance: 16 }) : bot.blockAtCursor(5);
  if (!target) throw new Error(`no ${name || 'block'} to use`);
  await go(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 2), 15000);
  await bot.activateBlock(target); return `used ${target.name} at ${V(target.position)}`;
}
async function wear() {
  const slots = { helmet: 'head', chestplate: 'torso', leggings: 'legs', boots: 'feet', shield: 'off-hand' }; const worn = [];
  for (const it of bot.inventory.items()) for (const k of Object.keys(slots)) if (it.name.endsWith(k)) { try { await bot.equip(it, slots[k]); worn.push(it.name); } catch (e) {} }
  return worn.length ? `wearing ${worn.join(', ')}` : 'no armor in inventory';
}
async function buildShape(shape, a1, a2, a3, name) {
  const inv = state().inventory;
  name = name || Object.keys(inv).find(k => /planks|cobblestone|stone|dirt|log|sand|bricks|glass/.test(k));
  if (!name) throw new Error('no building blocks: collect dirt/cobblestone/planks first');
  const me = bot.entity.position.floored(); const base = me.offset(2, 0, 2); const targets = [];
  const yaw = bot.entity.yaw; const fx = Math.round(-Math.sin(yaw)), fz = Math.round(Math.cos(yaw));
  if (shape === 'wall') { const len = a1 || 5, h = a2 || 3; for (let i = 0; i < len; i++) for (let y = 0; y < h; y++) targets.push(base.offset(i * (fz ? 1 : 0) + (fx ? 0 : 0), y, i * (fx ? 1 : 0))); }
  else if (shape === 'floor' || shape === 'platform') { const w = a1 || 5, l = a2 || w; for (let x = 0; x < w; x++) for (let z = 0; z < l; z++) targets.push(base.offset(x, shape === 'platform' ? 1 : -1, z)); }
  else if (shape === 'tower' || shape === 'pillar') { const h = a1 || 5; for (let y = 0; y < h; y++) targets.push(base.offset(0, y, 0)); }
  else if (shape === 'room' || shape === 'house') return await buildHouse(a1 || 5, a2 || 3, name);
  else if (shape === 'fence' || shape === 'pen') { const s = a1 || 6; for (let i = 0; i < s; i++) { targets.push(base.offset(i, 0, 0)); targets.push(base.offset(i, 0, s - 1)); targets.push(base.offset(0, 0, i)); targets.push(base.offset(s - 1, 0, i)); } }
  else if (shape === 'stairs' || shape === 'ramp') { const h = a1 || 4; for (let i = 0; i < h; i++) for (let y = 0; y <= i; y++) targets.push(base.offset(i, y, 0)); }
  else if (shape === 'bridge') { const len = a1 || 8; for (let i = 0; i < len; i++) targets.push(me.offset(fx * (i + 1), -1, fz * (i + 1))); }
  else throw new Error('shapes: wall <len> <h>, floor <w> <l>, platform <w> <l>, tower <h>, room/house <size> <h>, fence <size>, stairs <h>, bridge <len>');
  const uniq = [...new Map(targets.map(t => [V(t), t])).values()].filter(t => free(t));
  if ((inv[name] || 0) < uniq.length * 0.6) throw new Error(`need about ${uniq.length} ${name}, have ${inv[name] || 0}: collect more first`);
  let placed = 0, todo = uniq;
  for (let pass = 0; pass < 3 && todo.length; pass++) { const left = []; for (const t of todo) { if (!free(t)) { placed++; continue; } if (await placeAt(t, name)) placed++; else left.push(t); } todo = left; }
  return `built ${shape} with ${placed} ${name} near ${V(base)}` + (todo.length ? ` (${todo.length} blocks could not be placed)` : '');
}

async function run(q) {
  const a = q.action;
  if (a === 'bots') return { bots: Object.keys(BOTS), lanPort };
  if (a === 'connect') return await connect(q.port, q.username || q.bot);
  select(q.bot);
  if (a === 'state') return state();
  if (!bot) throw new Error('not in a world yet: connect first (Minecraft: Escape > Open to LAN > Start LAN World)');
  if (['goto','come','follow','collect','build_house','craft'].includes(a)) {
    await autoEat();
    if (!bot.time.isDay && bot.health <= 8 && a !== 'shelter') { const r = await shelter(); throw new Error(`survival first: it is night and health is ${bot.health}/20. ${r}. Use wait 60 until day, then continue.`); }
  }
  switch (a) {
    case 'goto': return await goto(+q.x, +q.y, +q.z, q.range ? +q.range : 1);
    case 'come': case 'follow': return await gotoPlayer(q.name);
    case 'collect': return await collect(q.block, +(q.count || 1));
    case 'dig': { const f = findBlocks(q.block, 1); if (!f.length) throw new Error(`no ${q.block} nearby`); await digOne(f[0]); return `dug ${q.block} at ${V(f[0])}`; }
    case 'place': return await place(q.block, q.x, q.y, q.z);
    case 'craft': return await craft(q.item, +(q.count || 1));
    case 'equip': return await equipItem(q.item);
    case 'build_house': return await buildHouse(+(q.size || 5), +(q.height || 3), q.block);
    case 'blocks': { const p=new Vec3(+q.x,+q.y,+q.z); const out=[]; for (let dy=-1; dy<=1; dy++) for (let dx=0; dx<4; dx++) for (let dz=0; dz<4; dz++) { const bb=bot.blockAt(p.offset(dx,dy,dz)); out.push(`${dx},${dy},${dz}:${bb?bb.name:'?'}`);} return out.join(' '); }
    case 'attack': case 'hunt': case 'kill': return await attackEntity(q.target, +(q.count || 1));
    case 'chest': return await chestList();
    case 'store': return await chestStore(q.item, +(q.count || 0));
    case 'take': return await chestTake(q.item, +(q.count || 0));
    case 'give': return await giveTo(q.who, q.item, +(q.count || 0));
    case 'drop': return await dropItem(q.item, +(q.count || 0));
    case 'smelt': case 'cook': return await smelt(q.item, +(q.count || 1));
    case 'till': return await till();
    case 'plant': return await plant(q.item || 'wheat_seeds');
    case 'harvest': return await harvest(q.item || 'wheat');
    case 'sleep': return await sleepInBed();
    case 'wake': await bot.wake().catch(() => {}); return 'awake';
    case 'explore': return await explore(q.direction, +(q.distance || 24));
    case 'scout': case 'look_around': return scout();
    case 'find': return findThing(q.target);
    case 'use': return await useBlock(q.target);
    case 'wear': return await wear();
    case 'fish': { const rod = bot.inventory.items().find(i => i.name === 'fishing_rod'); if (!rod) throw new Error('no fishing_rod (3 sticks + 2 string)'); const w = bot.findBlock({ matching: bot.registry.blocksByName.water.id, maxDistance: 16 }); if (!w) throw new Error('no water nearby'); await go(new goals.GoalNear(w.position.x, w.position.y + 1, w.position.z, 3), 20000); await bot.equip(rod, 'hand'); await bot.lookAt(w.position.offset(0.5, 0.5, 0.5)); await bot.fish(); await pickUp(); return `fished; inventory: ${JSON.stringify(state().inventory)}`; }
    case 'home': if (q.set) { HOMES[bot.username] = bot.entity.position.floored(); return `home set at ${V(HOMES[bot.username])}`; } { const h = HOMES[bot.username]; if (!h) throw new Error('no home set: use home set'); await go(new goals.GoalNear(h.x, h.y, h.z, 1), 90000); return `at home ${V(h)}`; }
    case 'build_shape': return await buildShape(q.shape, +q.a1 || undefined, +q.a2 || undefined, +q.a3 || undefined, q.block);
    case 'whisper': case 'tell': bot.whisper(q.who, q.text); return `whispered to ${q.who}: ${q.text}`;
    case 'eat': return await eat();
    case 'shelter': return await shelter();
    case 'wait': await sleep(Math.min(+(q.seconds || 30), 120) * 1000); return `waited ${Math.min(+(q.seconds || 30), 120)}s`;
    case 'chat': bot.chat(q.text); return `said: ${q.text}`;
    case 'look': await bot.look(((+q.yaw || 0) * Math.PI / 180), ((+q.pitch || 0) * Math.PI / 180), true); return 'looking';
    case 'stop': bot.pathfinder.setGoal(null); bot.stopDigging(); return 'stopped';
    case 'disconnect': { const n = bot.username; bot.quit(); delete BOTS[n]; bot = null; return `${n} left the world`; }
    default: throw new Error(`unknown action ${a}`);
  }
}

http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => body += c);
  req.on('end', async () => {
    let q = {}; try { q = JSON.parse(body || '{}'); } catch (e) {}
    const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    const entry = q.bot ? BOTS[q.bot] : Object.values(BOTS)[0];
    const passive = ['state', 'stop', 'bots', 'connect'].includes(q.action);
    if (entry && entry.busy && !passive) return send({ ok: false, error: `still busy with: ${entry.busy}` });
    if (entry && !passive) entry.busy = q.action;
    await ctx.run({ bot: null, chat: [] }, async () => {
      try { const r = await Promise.race([run(q), new Promise((_, rej) => setTimeout(() => rej(new Error('action timed out (300s)')), 300000))]);
            select(q.bot);
            send({ ok: true, result: r, state: q.action === 'state' ? undefined : state() }); }
      catch (e) { select(q.bot); send({ ok: false, error: e.message, state: state() }); }
      finally { if (entry && !passive) entry.busy = null; }
    });
  });
}).listen(8125, '127.0.0.1', () => console.log('mcbot on 8125'));
