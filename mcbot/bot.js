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
let bot = null, lanPort = null, busy = null, lastChat = [], lastPlaceError = '';
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
function defendAll() { for (const e of Object.values(BOTS)) { const saved = bot; bot = e.bot; try { defend(); } catch (x) {} bot = saved; } }
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
function findBlocks(name, count, maxDistance = 32) {
  name = name.toLowerCase().replace(/s$/, '').replace(/^wood$/, 'log').replace(/^tree$/, 'log');  // logs, trees, stones...
  const ids = bot.registry.blocksByName[name] ? [bot.registry.blocksByName[name].id]
    : Object.values(bot.registry.blocksByName).filter(b => b.name.includes(name)).map(b => b.id);
  if (!ids.length) throw new Error(`unknown block "${name}"`);
  return bot.findBlocks({ matching: ids, maxDistance, count });
}
async function digOne(pos) {
  const b = bot.blockAt(pos);
  if (!b || b.name === 'air') return false;
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
    found.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position));
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
    try { const r = await Promise.race([run(q), new Promise((_, rej) => setTimeout(() => rej(new Error('action timed out (300s)')), 300000))]);
          select(q.bot); busy = entry ? entry.busy : null;
          send({ ok: true, result: r, state: q.action === 'state' ? undefined : state() }); }
    catch (e) { select(q.bot); send({ ok: false, error: e.message, state: state() }); }
    finally { if (entry && !passive) entry.busy = null; }
  });
}).listen(8125, '127.0.0.1', () => console.log('mcbot on 8125'));
