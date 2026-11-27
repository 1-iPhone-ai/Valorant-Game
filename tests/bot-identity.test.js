'use strict';
// V2.3 bot identity in the instanced pipeline (design 9, 17.1; WP6). One boot of the V2.3 build (Agent Identity on, the
// default), at most 4 minutes, on the machine's content tier (Low on 4 or fewer hardware threads, Medium or High above);
// BOT_IDENTITY_TIER=low|medium|high forces one through the saved contentTierMode (bot-identity-medium.test.js runs it on
// Medium, the design's budget tier). Checks:
//  - Math.random: every draw is counted from the first check to the last; none is taken while BOTKIT code is on the stack
//    (any V23.bots entry, the kits' render callbacks, the build), across assignment, new pages and the reserve swap,
//    deaths and the dissolve, tier swaps, Enhanced Animations, wingmen, highlight colours and the identity switch;
//  - the warm reserve: two warmed pages exist after the warm-up, and a bot entering a new chunk takes one (V2.2's
//    createEnemyPage still runs and takes exactly its own 8 draws per part, V2.2's count) and creates no GPU buffer
//    (glBufferData calls 0), with Enhanced Animations off and, for the second reserve page, switched on after the warm-up;
//  - assignment: deterministic, inside the archetype's pool, no duplicate among live bots of an archetype (respawns and
//    generations included), the player's agent skipped where the pool allows, fixed per slot within a Match and moved
//    by the next Match; only actor.agentId and actor.lookIdx are written;
//  - kits: one per live page (a fifth InstancedMesh under the torso, sharing its instance attributes, owning its colour),
//    draws = +1 per live page, 0 in the shadow pass; leaves (hit proxies) identical with identity on and off; leaf rest
//    colours follow enemyPartPalette in all four highlight colours, cyan torso 0x0891b2 included;
//  - every kit module of every tier inside the union hit volume + 0.03 m at every archetype scale (JS, no Ultra boot);
//  - rendered crops: the rim's own pixels (uRimBase on minus off) carry the highlight hue for red, yellow, purple and
//    cyan; a hit flash makes the kit one flat colour (the flash flag in instanceKit, one hue in the kit's pixels);
//  - the dissolve (onKilled, death ticks): 0 until 0.6 s into the lie, then rising, written only on death ticks;
//  - identity off (the pill): every kit hidden (0 kit draws), uIdentity 0; on again restores them;
//  - wingmen: one Group child, the kit as the figure's 5th child, draws equal with Enhanced Animations off and on, and
//    one draw per wingman more than with identity off (the shadow pass unchanged);
//  - tier swaps (High Detail, Ultra bodies) swap the kit superset by reference and compile nothing; every agent's kit
//    draws on every tier (a module the Low superset lacks takes its stand-in);
//  - kitRep and archOverride (the replay override API) apply and restore bit-exact, the restore also with identity off,
//    and a save from an earlier life is dropped after a respawn;
//  - steady frames (bots moved inside their chunks) upload no kit bytes; programs == watermark, 0 stalls, no page errors.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { boot, closeBrowser, programState, GAME_FILE } = require('./harness');

after(closeBrowser);

// The union hit volume read from buildActorTemplates in the game source (as agent-roster.test): the detailed boxes
// (Medium content tier and up) and the Low ones, each { c: [x, y, z], h: [half sizes] }
function hitBoxes() {
    const src = fs.readFileSync(GAME_FILE, 'utf8');
    const a = src.indexOf('function buildActorTemplates()');
    const body = src.slice(a, src.indexOf('\n        }\n', a));
    const split = body.indexOf('} else {');
    const parse = (txt) => {
        const out = [];
        const re = /box\(([\d.]+), ([\d.]+), ([\d.]+)\), matrix: partMatrix\((-?[\d.]+), (-?[\d.]+), (-?[\d.]+)\)/g;
        let m;
        while ((m = re.exec(txt))) out.push({ c: [+m[4], +m[5], +m[6]], h: [m[1] / 2, m[2] / 2, m[3] / 2] });
        return out;
    };
    const head = parse(body.slice(body.indexOf('T.enemyHead')));
    return { detailed: parse(body.slice(0, split)).concat(head), low: parse(body.slice(split, body.indexOf('T.enemyHead'))).concat(head) };
}
const hueOf = (r, g, b) => {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (d <= 0) return null;
    let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
    return h < 0 ? h + 360 : h;
};
const hueDist = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
const hexHue = (h) => hueOf((h >> 16) & 255, (h >> 8) & 255, h & 255);

// No pointer lock in headless runs (it leaks renderer memory when play resumes many times)
// and the forced content tier, if any, saved before the game reads it
const TIER = process.env.BOT_IDENTITY_TIER || null;
const INIT = (tier) => {
    Element.prototype.requestPointerLock = function () {}; document.exitPointerLock = function () {};
    if (tier) try { const k = 'valorant_v16_user_settings'; const o = JSON.parse(localStorage.getItem(k) || '{}'); o.contentTierMode = tier; localStorage.setItem(k, JSON.stringify(o)); } catch (e) {}
};
// The BOTKIT block's line range in the game file (stack frames of the inline script carry the document's line numbers)
function botkitLines() {
    const lines = fs.readFileSync(GAME_FILE, 'utf8').split('\n');
    const lo = lines.findIndex((l) => l.includes('// ===== V2.3 BLOCK BOTKIT [WP6] =====')) + 1;
    const hi = lines.findIndex((l) => l.includes('// ===== END V2.3 BLOCK BOTKIT =====')) + 1;
    return [lo, hi];
}

test(`bot identity (${TIER ? TIER + ' content tier' : 'the machine\'s content tier'}): Math.random, reserve, assignment, kits on pages, draws, leaves, colours, hit volume, rim, flash, dissolve, identity off, wingmen, tiers, replays`, { timeout: 240000 }, async () => {
    const { page, errors, frames, evaluate } = await boot({ initScript: INIT, initArg: TIER });
    const [, watermark0] = await programState(page);

    // ---- Math.random: count every draw; a draw with BOTKIT code on the stack (a V23.bots entry, or a frame inside the
    // block's lines: render callbacks, the build) is one too many. The game's stream itself is untouched (one real draw
    // per call); V23.core._quiet still swaps it for its own stream and restores this counter.
    const [lo, hi] = botkitLines();
    assert.ok(lo > 0 && hi > lo, 'the BOTKIT block is found');
    const rand0 = await evaluate(([lo, hi]) => {
        const R = window.__v23rand = { total: 0, inside: 0, sites: {}, calls: {}, depth: 0 };
        const real = Math.random, re = /\.html:(\d+):\d+/g;
        const inBlock = (st) => { re.lastIndex = 0; let m; while ((m = re.exec(st))) { const n = +m[1]; if (n >= lo && n <= hi) return true; } return false; };
        const stack = () => { const lim = Error.stackTraceLimit; Error.stackTraceLimit = 100; const st = new Error().stack; Error.stackTraceLimit = lim; return st; };
        Math.random = function () {
            R.total++;
            const st = stack();
            if (R.depth > 0 || inBlock(st)) { R.inside++; const k = (st.split('\n')[2] || '').trim(); R.sites[k] = (R.sites[k] || 0) + 1; }
            return real();
        };
        for (const k of Object.keys(V23.bots)) {
            const f = V23.bots[k];
            if (typeof f !== 'function' || k[0] === '_') continue;
            V23.bots[k] = function () { R.depth++; R.calls[k] = (R.calls[k] || 0) + 1; try { return f.apply(this, arguments); } finally { R.depth--; } };
        }
        // the attribution works: a frame inside assign reports a line inside the block (a getter BOTKIT reads)
        let seen = null;
        const desc = Object.getOwnPropertyDescriptor(game, 'activeAgent'), v = game.activeAgent, a = enemyObjects[0], keep = [a.agentId, a.lookIdx];
        Object.defineProperty(game, 'activeAgent', { configurable: true, enumerable: true, get() { if (seen === null) seen = stack(); return v; } });
        try { V23.bots.assign(a); } finally { Object.defineProperty(game, 'activeAgent', desc || { value: v, writable: true, configurable: true, enumerable: true }); a.agentId = keep[0]; a.lookIdx = keep[1]; }
        return { attributed: !!seen && inBlock(seen), site: seen && seen.split('\n').find((l) => /\.html:/.test(l)) };
    }, [lo, hi]);
    assert.ok(rand0.attributed, `a stack frame inside BOTKIT is recognised (${JSON.stringify(rand0)}; block lines ${lo}-${hi})`);

    // ---- the warm reserve: a bot entering a new chunk, with Enhanced Animations off and then switched on -------------
    const reserve = await evaluate(() => {
        const S = V23.bots._state, st = V23.bots._stats, R = window.__v23rand;
        const out = { made: st.reserveMade, held: S.reserve.length, used: st.reserveUsed, parts: enemyPartSpecs.length, moves: [],
            warmTag: S.reserve.every((pg) => pg.meshes.every((m) => m.userData.v23Warm === 'pre') && pg.kit.userData.v23Warm === 'pre'),
            eaBuffers: S.reserve.every((pg) => pg.meshes.every((m) => !!m.geometry.attributes.instanceAnim2 && !!m.geometry.attributes.instanceAnim3)) };
        const live = enemyObjects.filter((x) => x.isActive && !x.hit && x.renderActive);
        out.live = live.length;
        if (live.length < 2) return out;
        const e = live[0], buddy = live[1];
        // only the bot pages drawn, from over the map (chunks -2..1 in view)
        const cam = new THREE.PerspectiveCamera(100, 480 / 270, 0.5, 400);
        cam.position.set(0, 120, 0.01); cam.lookAt(0, 0, 0); cam.updateMatrixWorld();
        const draw = () => {
            const keep = new Set(), hidden = [];
            for (const c of enemyChunks.values()) for (const pg of c.pages) for (const m of pg.meshes) keep.add(m);
            for (const o of scene.children) if (!keep.has(o) && !o.isLight && o.visible) { hidden.push(o); o.visible = false; }
            renderer.info.reset(); renderer.setRenderTarget(null); renderer.clear(); renderer.render(scene, cam);
            const calls = renderer.info.render.calls;
            for (const o of hidden) o.visible = true;
            return calls;
        };
        const move = (ea) => {
            // a chunk with no page (the map's own first, then the ring round it)
            const used = new Set([...enemyChunks.keys()]);
            let target = null;
            for (const ring of [[-1, 0], [-2, -1, 0, 1]]) for (const cx of ring) for (const cz of ring) if (!target && !used.has(cx + ',' + cz)) target = [cx, cz];
            const r = { ea: ea, target: target };
            if (!target) return r;
            // e joins its buddy's page first (alone on its page, e would take that page back from the free list), and the
            // free list is set aside, so the move below makes V2.2 create a page
            e.mesh.position.copy(buddy.mesh.position); e.mesh.position.x += 0.8; e.poseDirty = true;
            packEnemyBatches();
            draw();
            const stash = enemyPageFree.splice(0);
            const used0 = st.reserveUsed, warmMeshes = new Set([].concat(...S.reserve.map((pg) => pg.meshes)));
            const gl0 = [perfTelemetry.glBufferDataCalls, perfTelemetry.glBufferDataBytes], r0 = [R.total, R.inside];
            e.mesh.position.set(target[0] * 50 + 25, 0, target[1] * 50 + 25); e.poseDirty = true;
            packEnemyBatches();
            r.draws = R.total - r0[0];
            r.drawsInside = R.inside - r0[1];
            const calls = draw();
            enemyPageFree.push(...stash);
            Object.assign(r, { reserveUsed: st.reserveUsed - used0, bufferDataCalls: perfTelemetry.glBufferDataCalls - gl0[0], bufferDataBytes: perfTelemetry.glBufferDataBytes - gl0[1],
                fromReserve: !!e.page && warmMeshes.has(e.page.meshes[0]) && !!e.page.kit && e.page.meshes[0].count === 1 && e.page.kit.count === 1, heldAfter: S.reserve.length,
                chunk: e.pageCx + ',' + e.pageCz, calls: calls, eaAttrs: !!e.page && e.page.meshes.every((m) => !ea || (!!m.geometry.attributes.aBone && !!m.geometry.attributes.instanceAnim2)) });
            return r;
        };
        out.moves.push(move(false));
        // Enhanced Animations switched on after the warm-up (its build gives the live and free pages their buffers; a
        // frame draws them), then the second reserve page
        enhancedAnim.set(true);
        packEnemyBatches();
        draw();
        out.moves.push(move(true));
        enhancedAnim.set(false);
        packEnemyBatches();
        return out;
    });
    assert.equal(reserve.made, 2, 'two warm pages made at boot');
    assert.equal(reserve.used + reserve.held, 2, 'held in the reserve until a new page takes one');
    assert.ok(reserve.warmTag && reserve.eaBuffers, `tagged for the warm-up, with their own EA buffers (${JSON.stringify(reserve)})`);
    assert.ok(reserve.live >= 2 && reserve.moves.length === 2, `two live bots (${JSON.stringify(reserve)})`);
    for (const mv of reserve.moves) {
        const tag = mv.ea ? 'Enhanced Animations on' : 'Enhanced Animations off';
        assert.ok(mv.target, `${tag}: a chunk without a page (${JSON.stringify(mv)})`);
        assert.equal(mv.reserveUsed, 1, `${tag}: the new page took a reserve page`);
        assert.ok(mv.fromReserve && mv.calls > 0 && mv.eaAttrs, `${tag}: the bot draws from the reserve page's meshes (${JSON.stringify(mv)})`);
        assert.equal(mv.bufferDataCalls, 0, `${tag}: a bot entering a new chunk creates no GPU buffer (${JSON.stringify(mv)})`);
        assert.equal(mv.draws, 8 * reserve.parts, `${tag}: the new page's Math.random draws are V2.2's createEnemyPage's (8 per part)`);
        assert.equal(mv.drawsInside, 0, `${tag}: none of them inside BOTKIT`);
    }
    console.log('# reserve', JSON.stringify(reserve));

    // ---- assignment -------------------------------------------------------------------------------------------------
    const asg = await evaluate(() => {
        const out = { pool: true, dupes: [], det: true, own: true, gens: [], match: [], writes: [] };
        // the game's bots out of the way (assign reads only isActive, hit, archetype and agentId of the others)
        const saved = enemyObjects.map((e) => [e.isActive, e.hit]);
        for (const e of enemyObjects) e.isActive = false;
        while (enemyObjects.length < saved.length + 8) createEnemyActor('standard');
        const T = enemyObjects.slice(saved.length, saved.length + 8);
        const mine = game.activeAgent;
        const run = (a, arch, gen) => { a.archetype = arch; a.generation = gen; V23.bots.assign(a); return a.agentId; };
        try {
            for (const arch of Object.keys(BOT_POOLS)) {
                // inside the pool, deterministic: the same state gives the same agent
                for (const a of T) for (let gen = 1; gen < 6; gen++) {
                    const id = run(a, arch, gen), again = run(a, arch, gen);
                    if (BOT_POOLS[arch].indexOf(id) < 0) out.pool = false;
                    if (id !== again || a.lookIdx !== AGENT_ORDER.indexOf(id)) out.det = false;
                    if (id === mine && BOT_POOLS[arch].length > 1) out.own = false;
                }
                // live bots of one archetype: each new life (a respawn moves the generation) avoids the others' agents
                for (const a of T) { a.isActive = false; a.agentId = undefined; }
                const n = Math.min(T.length, BOT_POOLS[arch].length - (BOT_POOLS[arch].indexOf(mine) >= 0 ? 1 : 0));
                for (let round = 0; round < 3; round++) {
                    for (let i = 0; i < n; i++) { const a = T[i]; a.isActive = false; run(a, arch, round + 1); a.isActive = true; a.hit = false; }
                    const ids = T.slice(0, n).map((a) => a.agentId);
                    if (new Set(ids).size !== ids.length) out.dupes.push(arch + ' round ' + round + ': ' + ids.join(','));
                }
                for (const a of T) a.isActive = false;
            }
            // other modes: a lone slot follows (slot x 5 + generation x 3 + map x 7) mod n across generations
            const a = T[0], P = BOT_POOLS.sniper, mi = ['ascent', 'bind', 'haven', 'icebox', 'lotus', 'split', 'skyline'].indexOf(game.mapPreset);
            for (let gen = 1; gen <= 4; gen++) {
                const want = P[(((a.slot * 5 + gen * 3 + mi * 7) % P.length) + P.length) % P.length];
                out.gens.push([run(a, 'sniper', gen), want]);
            }
            // Match: fixed per slot through the match (any generation), the next match moves it
            const mm = matchMode, keep = [mm.active, mm.stats];
            try {
                for (const m of [0, 1]) {
                    mm.active = true; mm.stats = { startedAt: m };
                    out.match.push([1, 2, 3].map((gen) => run(a, 'standard', gen)));
                }
            } finally { mm.active = keep[0]; mm.stats = keep[1]; }
            // only agentId and lookIdx change
            const before = {};
            for (const k of Object.keys(a)) before[k] = a[k];
            a.generation = 9;
            const g9 = Object.assign({}, before, { generation: 9 });
            V23.bots.assign(a);
            for (const k of Object.keys(a)) if (a[k] !== g9[k] && k !== 'agentId' && k !== 'lookIdx') out.writes.push(k);
            if (Object.keys(a).length !== Object.keys(g9).length + (('agentId' in g9) ? 0 : 1) + (('lookIdx' in g9) ? 0 : 1)) out.writes.push('keys');
        } finally {
            enemyObjects.forEach((e, i) => { if (i < saved.length) { e.isActive = saved[i][0]; e.hit = saved[i][1]; } });
        }
        return out;
    });
    assert.ok(asg.pool, 'every assignment is inside its archetype pool');
    assert.ok(asg.det, 'assignment is deterministic and lookIdx is the agent index');
    assert.ok(asg.own, "the player's own agent is skipped where the pool allows");
    assert.deepEqual(asg.dupes, [], 'no duplicates among live bots of an archetype, across respawns');
    for (const [got, want] of asg.gens) assert.equal(got, want, 'a lone slot follows the generation formula');
    assert.ok(new Set(asg.gens.map((g) => g[0])).size > 1, 'generations change the agent');
    assert.equal(new Set(asg.match[0]).size, 1, `fixed per slot within a match (${asg.match[0]})`);
    assert.equal(new Set(asg.match[1]).size, 1, 'and within the next one');
    assert.notEqual(asg.match[0][0], asg.match[1][0], 'the next match moves it');
    assert.deepEqual(asg.writes, [], 'assign writes actor.agentId and actor.lookIdx only');

    // ---- kits on pages, draws (+1 per live page, 0 in the shadow pass), leaves, colours ------------------------------
    await frames(3);
    const kits = await evaluate(() => {
        const out = {};
        const pages = [];
        for (const c of enemyChunks.values()) for (const pg of c.pages) pages.push(pg);
        const S = V23.bots._state;
        out.tier = S.tier;
        out.structure = pages.map((pg) => {
            const t = pg.meshes[0], k = pg.kit;
            return !!k && k.parent === t && pg.meshes.indexOf(k) < 0 && k.castShadow === false && k.instanceMatrix === t.instanceMatrix
                && k.geometry.attributes.instanceAnim === t.geometry.attributes.instanceAnim && k.instanceColor && k.instanceColor !== t.instanceColor
                && pg.meshes.every((m) => m.geometry.attributes.instanceKit === k.geometry.attributes.instanceKit)
                && k.geometry.attributes.position === V23.parts.kitSuperset(S.tier).attributes.position && k.material === S.mat && k.count === t.count;
        });
        out.live = pages.filter((pg) => pg.meshes[0].count > 0).length;
        // draws: only the bot pages in the scene, a camera over the map that sees every chunk
        const cam = new THREE.PerspectiveCamera(100, 480 / 270, 0.5, 400);
        cam.position.set(0, 120, 0.01); cam.lookAt(0, 0, 0); cam.updateMatrixWorld();
        const keep = new Set();
        for (const pg of pages) for (const m of pg.meshes) keep.add(m);
        const hidden = [];
        for (const o of scene.children) if (!keep.has(o) && !o.isLight && o.visible) { hidden.push(o); o.visible = false; }
        for (const f of enemyFlashLights) f.object.visible = false;
        const sm = renderer.shadowMap, smRender = sm.render;
        let shadowCalls = 0;
        sm.render = function () { const c0 = renderer.info.render.calls; const r = smRender.apply(this, arguments); shadowCalls += renderer.info.render.calls - c0; return r; };
        const count = () => { shadowCalls = 0; sm.needsUpdate = true; renderer.info.reset(); renderer.setRenderTarget(null); renderer.clear(); renderer.render(scene, cam); return [renderer.info.render.calls, shadowCalls]; };
        try {
            out.withKits = count();
            for (const pg of pages) pg.kit.visible = false;
            out.noKits = count();
            for (const pg of pages) pg.kit.visible = true;
        } finally {
            sm.render = smRender;
            for (const o of hidden) o.visible = true;
        }
        out.shadowsOn = sm.enabled;
        // leaves: hit proxies unchanged (the actors' own boxes, no kit among them, same world matrices with identity
        // on and off for the same moves), bound radius unchanged
        const e = enemyObjects.find((x) => x.isActive && !x.hit);
        out.leaves = enemyObjects.every((x) => x.leaves.length === x.mesh.children.length && x.leaves.every((l, i) => x.mesh.children[i] === l && shootableOwners.get(l) && shootableOwners.get(l).actor === x));
        out.radius = enemyObjects.every((x) => Math.abs(x.boundRadius - computeActorRadius(x.mesh)) < 1e-9);
        const proxies = () => e.leaves.map((l) => { l.updateMatrixWorld(true); return Array.from(l.matrixWorld.elements).map((v) => +v.toFixed(6)).join(','); }).join('|');
        const scenario = (on) => {
            game.userSettings.agentIdentity = on ? 'on' : 'off';
            V23.core.applySettings(game.userSettings, 'agentIdentity');
            activateEnemy(e, -11, 0, 4, 'standard');
            e.mesh.rotation.y = 0;
            const rec = [];
            for (let i = 0; i < 20; i++) { e.mesh.position.x -= 3 / 60; e.mesh.rotation.y += 0.02; updateEnemyAnimation(1 / 60); packEnemyBatches(); }
            rec.push(proxies(), V23.bots._state.on);
            return rec;
        };
        const off = scenario(false), on = scenario(true);
        out.proxiesStill = off[0] === on[0];
        out.switched = [off[1], on[1]];
        // leaf rest colours follow enemyPartPalette in every highlight colour (cyan torso 0x0891b2), and the page and kit
        // colours follow the leaves
        out.colours = {};
        const lin = (h) => new THREE.Color().setHex(h).convertSRGBToLinear();
        const near = (a, b) => Math.abs(a.r - b.r) < 1e-6 && Math.abs(a.g - b.g) < 1e-6 && Math.abs(a.b - b.b) < 1e-6;
        for (const mode of ['red', 'yellow', 'purple', 'cyan']) {
            game.userSettings.enemyHighlightColor = mode;
            settingsManager.applyEnemyHighlightColor();
            packEnemyBatches();
            const ok = [];
            for (const x of enemyObjects) {
                if (!x.isActive || x.hit || !x.page) continue;
                const pal = enemyPartPalette(ENEMY_ARCHETYPES[x.archetype]);
                const s = x.page.members.indexOf(x), c = new THREE.Color();
                const rest = x.rest.every((r, p) => near(r.color, lin(pal[p])));
                const page = x.page.meshes.every((m, p) => { m.getColorAt(s, c); return near(c, x.leaves[p].material.color); });
                x.page.kit.getColorAt(s, c);
                ok.push(rest && page && near(c, x.leaves[0].material.color));
            }
            out.colours[mode] = { ok: ok.length > 0 && ok.every(Boolean), torso: (() => { const x = enemyObjects.find((y) => y.isActive && !y.hit); return x.rest[0].color.getHex(); })(),
                rim: enemyAnimUniforms.uRim.value.getHex() };
        }
        out.cyanTorso = lin(0x0891b2).getHex();
        out.cyanRim = lin(0x67e8f9).getHex();
        game.userSettings.enemyHighlightColor = 'red';
        settingsManager.applyEnemyHighlightColor();
        return out;
    });
    assert.ok(kits.structure.length > 0 && kits.structure.every(Boolean), `every page carries its kit (${JSON.stringify(kits.structure)})`);
    assert.equal(kits.withKits[0] - kits.noKits[0], kits.live, `kit draws = live pages (${JSON.stringify(kits)})`);
    assert.ok(kits.live > 0, 'some live pages');
    assert.ok(kits.shadowsOn && kits.withKits[1] > 0, 'the shadow pass runs and draws the bots');
    assert.equal(kits.withKits[1], kits.noKits[1], 'no kit draw in the shadow pass');
    assert.ok(kits.leaves, 'leaves are the actors\' own boxes');
    assert.ok(kits.radius, 'bound radius unchanged');
    assert.ok(kits.proxiesStill, 'hit proxies identical with identity on and off');
    assert.deepEqual(kits.switched, [false, true], 'the kits switch with the setting');
    for (const [mode, c] of Object.entries(kits.colours)) assert.ok(c.ok, `${mode}: rest, page and kit colours follow enemyPartPalette`);
    assert.equal(kits.colours.cyan.torso, kits.cyanTorso, 'cyan torso 0x0891b2');
    assert.equal(kits.colours.cyan.rim, kits.cyanRim, 'cyan rim 0x67e8f9');
    console.log('# draws with kits / without (main, shadow):', JSON.stringify([kits.withKits, kits.noKits]), 'live pages', kits.live, 'tier', kits.tier);

    // ---- every kit module of every tier inside the union hit volume + 0.03 m at every archetype scale (JS) -----------
    const kitData = await evaluate(() => ['low', 'medium', 'high', 'ultra'].map((t) => {
        const g = V23.parts.kitSuperset(t);
        return { tier: t, p: Array.from(g.attributes.position.array), uv: Array.from(g.attributes.uv.array), idx: Array.from(g.index.array) };
    }));
    const scales = await evaluate(() => Object.values(ENEMY_ARCHETYPES).map((a) => [a.id, a.scale.x, a.scale.y, a.scale.z]));
    const boxes = hitBoxes();
    assert.ok(boxes.detailed.length >= 3 && boxes.low.length >= 3, 'hit boxes read from the source');
    const M = 0.03, outside = {};
    const inside = (q, list, s) => list.some((b) => [0, 1, 2].every((i) => Math.abs(q[i] - b.c[i] * s[i]) <= b.h[i] * s[i] + M + 1e-6));
    for (const k of kitData) {
        const list = k.tier === 'low' ? boxes.low : boxes.detailed, n = k.p.length / 3, pts = [];
        const mod = (i) => Math.round(k.uv[i * 2]) - 2;
        for (let i = 0; i < n; i++) pts.push([k.p[i * 3], k.p[i * 3 + 1], k.p[i * 3 + 2], mod(i)]);
        for (let t = 0; t < k.idx.length; t += 3) { const v = [k.idx[t], k.idx[t + 1], k.idx[t + 2]]; pts.push([0, 1, 2].map((a) => (k.p[v[0] * 3 + a] + k.p[v[1] * 3 + a] + k.p[v[2] * 3 + a]) / 3).concat(mod(v[0]))); }
        for (const [aid, sx, sy, sz] of scales) for (const q of pts) {
            if (!inside([q[0] * sx, q[1] * sy, q[2] * sz], list, [sx, sy, sz])) (outside[k.tier + '/' + aid + '/' + q[3]] = outside[k.tier + '/' + aid + '/' + q[3]] || []).push(q.slice(0, 3).map((v) => +v.toFixed(3)));
        }
    }
    assert.deepEqual(Object.keys(outside).map((k) => k + ' ' + JSON.stringify(outside[k].slice(0, 2))), [], 'every kit point inside the union hit volume + 0.03 m at every archetype scale');
    console.log('# kit superset vertices:', kitData.map((k) => k.tier + ' ' + k.p.length / 3).join(', '));
    // every agent's kit draws on every tier: the mask names only modules that tier's superset holds, at least one, and
    // where the superset holds all of the kit's modules the mask is the kit itself
    const masks = await evaluate(() => AGENT_ORDER.map((id) => {
        const L = V23.core.resolve(id), kit = ((L && L.bot && L.bot.kit) || []).filter((k) => k >= 0 && k <= 22);
        return { id: id, kit: kit, tiers: ['low', 'medium', 'high', 'ultra'].map((t) => {
            const mods = V23.parts.kitSuperset(t).userData.kit.modules, has = (k) => mods.some((m) => m.id === k && m.vertices > 0);
            const mask = V23.bots._kitMask(id, t), bits = [];
            for (let k = 0; k < 24; k++) if (Math.floor(mask / Math.pow(2, k)) % 2 === 1) bits.push(k);
            return { tier: t, bits: bits, held: bits.every(has), exact: !kit.every(has) || (bits.length === kit.length && kit.every((k) => bits.indexOf(k) >= 0)) };
        }) };
    }));
    const badMask = [];
    for (const m of masks) for (const t of m.tiers) if (m.kit.length && (!t.bits.length || !t.held || !t.exact)) badMask.push(m.id + '/' + t.tier + ' kit ' + m.kit + ' bits ' + t.bits);
    assert.deepEqual(badMask, [], 'every agent kit draws on every tier, only modules the tier holds, the kit itself where it can');
    console.log('# Low kits with stand-ins:', masks.filter((m) => m.kit.join() !== m.tiers[0].bits.join() && m.kit.slice().sort((a, b) => a - b).join() !== m.tiers[0].bits.join()).map((m) => m.id + ' ' + m.kit + '>' + m.tiers[0].bits).join('; '));

    // ---- rendered crops: the rim hue per highlight colour; a hit flash is one flat colour ------------------------------
    const crops = await evaluate(() => {
        window.updateEnemies = () => {};
        if (tacticalEnhancements.wingmanEnabled) tacticalEnhancements.toggleWingmanAI(false);
        const e = enemyObjects.find((x) => x.isActive && !x.hit);
        for (const x of enemyObjects) if (x !== e) { x.isActive = false; x.hit = true; x.renderActive = false; x.mesh.visible = false; }
        activateEnemy(e, -11, 0, 4, 'standard');
        e.mesh.rotation.set(0, 0.35, 0);
        e.health = 1e6; e.armor = 0;
        V23.bots.kitRep(e, { agentId: 'omen' });
        packEnemyBatches();
        const cam = new THREE.PerspectiveCamera(24, 480 / 270, 0.1, 100);
        cam.position.set(-11, 1.25, 9.2); cam.lookAt(-11, 1.1, 4); cam.updateMatrixWorld();
        const gl = renderer.getContext(), W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
        const px = new Uint8Array(W * H * 4);
        const shot = (onlyKit, none) => {
            const pg = e.page, keep = new Set(none ? [] : pg.meshes), hidden = [];
            for (const o of scene.children) if (!keep.has(o) && !o.isLight && o.visible) { hidden.push(o); o.visible = false; }
            for (const f of enemyFlashLights) f.object.visible = false;
            if (onlyKit) for (const m of enemyPartMaterials) m.visible = false;
            renderer.info.reset();
            renderer.setRenderTarget(null); renderer.setClearColor(0, 1); renderer.clear(); renderer.render(scene, cam);
            gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
            if (onlyKit) for (const m of enemyPartMaterials) m.visible = true;
            for (const o of hidden) o.visible = true;
            return px.slice();
        };
        const hue = (r, g, b) => { const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; if (d <= 0) return -1; let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; return h < 0 ? h + 360 : h; };
        const out = { rim: {}, flash: {} };
        for (const mode of ['red', 'yellow', 'purple', 'cyan']) {
            game.userSettings.enemyHighlightColor = mode;
            settingsManager.applyEnemyHighlightColor();
            e.colorDirty = true;
            packEnemyBatches();
            const a = shot(false);
            const base = enemyAnimUniforms.uRimBase.value;
            enemyAnimUniforms.uRimBase.value = 0;
            const b = shot(false);
            enemyAnimUniforms.uRimBase.value = base;
            let R = 0, G = 0, Bl = 0, n = 0, bot = 0;
            for (let i = 0; i < a.length; i += 4) {
                if (a[i] + a[i + 1] + a[i + 2] > 0) bot++;
                const dr = a[i] - b[i], dg = a[i + 1] - b[i + 1], db = a[i + 2] - b[i + 2];
                if (dr > 0 || dg > 0 || db > 0) { R += Math.max(0, dr); G += Math.max(0, dg); Bl += Math.max(0, db); n++; }
            }
            out.rim[mode] = { hue: hue(R, G, Bl), px: n, bot: bot, sum: [R, G, Bl] };
        }
        // a hit flash, with the highlight cyan (its accents far from the orange flash): the kit alone, at rest and in the
        // flash; every kit pixel counts, and those near the flash hue are the flat ones
        game.userSettings.enemyHighlightColor = 'cyan';
        settingsManager.applyEnemyHighlightColor();
        e.colorDirty = true;
        packEnemyBatches();
        // the kit's own pixels (those that differ from the same frame without the bot: the scene background is drawn)
        const bg = shot(false, true);
        const spread = (img) => {
            const hs = [];
            for (let i = 0; i < img.length; i += 4) {
                if (img[i] === bg[i] && img[i + 1] === bg[i + 1] && img[i + 2] === bg[i + 2]) continue;
                const r = img[i], g = img[i + 1], b = img[i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b);
                hs.push(mx > 24 && mx - mn > 0.25 * mx ? hue(r, g, b) : -1);
            }
            return hs;
        };
        const rest = spread(shot(true));
        damageEnemyActor(e, 1, performance.now(), Date.now(), 'Test', 'torso');
        packEnemyBatches();
        const s = e.page.members.indexOf(e), w = e.page.kit.geometry.attributes.instanceKit.getW(s);
        const flash = spread(shot(true));
        out.flash = { w: w, flagged: Math.floor(Math.floor(w + 1e-4) / 2) % 2 === 1, rest: rest, flash: flash, until: e.flashUntil[0] > 0 };
        // the flash ends: the flag goes
        updateActorFlashes(e.flashUntil[0] + 1);
        packEnemyBatches();
        out.flash.after = e.page.kit.geometry.attributes.instanceKit.getW(s);
        out.kitDraws = renderer.info.render.calls;
        return out;
    });
    const ACC = { red: 0xff4655, yellow: 0xffd166, purple: 0xe879f9, cyan: 0x67e8f9 };
    for (const [mode, r] of Object.entries(crops.rim)) {
        assert.ok(r.px > 30 && r.bot > 1000, `${mode}: the rim lights pixels (${JSON.stringify(r)})`);
        assert.ok(hueDist(r.hue, hexHue(ACC[mode])) < 25, `${mode}: rim hue ${r.hue.toFixed(1)} vs accent ${hexHue(ACC[mode]).toFixed(1)}`);
    }
    console.log('# rim hues:', Object.entries(crops.rim).map(([m, r]) => m + ' ' + r.hue.toFixed(1) + ' (accent ' + hexHue(ACC[m]).toFixed(1) + ', ' + r.px + ' px)').join(', '));
    const fl = crops.flash, fh = hexHue(0xffaa00);
    const near = (hs) => hs.filter((h) => h >= 0 && hueDist(h, fh) < 25).length / Math.max(1, hs.length);
    assert.ok(fl.until && fl.flagged, `the flash flag is set in instanceKit (${fl.w})`);
    assert.ok(fl.flash.length > 200 && near(fl.flash) > 0.6, `in a hit flash the kit is one flat colour (${(near(fl.flash) * 100).toFixed(1)}% of ${fl.flash.length} px near the flash hue; the rest is its rim)`);
    assert.ok(near(fl.rest) < 0.05, `at rest the kit shows its own zones (${(near(fl.rest) * 100).toFixed(1)}% near the flash hue)`);
    console.log('# kit pixels near the flash hue: rest', (near(fl.rest) * 100).toFixed(1) + '%', 'flash', (near(fl.flash) * 100).toFixed(1) + '%', 'of', fl.flash.length);
    assert.equal(Math.floor(Math.floor(fl.after + 1e-4) / 2) % 2, 0, 'the flag clears with the flash');

    // ---- the dissolve: onKilled, death ticks only, 0 until 0.6 s into the lie, rising after ---------------------------
    const dis = await evaluate(() => {
        const e = enemyObjects.find((x) => x.isActive && !x.hit);
        V23.bots.kitRep(e, null);
        const s0 = V23.bots._stats.deathWrites;
        e.health = 1; e.armor = 0;
        damageEnemyActor(e, 999, performance.now(), Date.now(), 'Test', 'torso');
        const rows = [];
        for (let i = 0; i < 240 && e.renderActive; i++) {
            stepActorAnimations();
            packEnemyBatches();
            const anim = actorAnimations.find((a) => a.actor === e);
            if (!e.page) break;
            const w = e.page.kit.geometry.attributes.instanceKit.getW(e.page.members.indexOf(e));
            rows.push([anim ? +anim.t.toFixed(4) : -1, anim ? anim.lieT : -1, +(w - Math.floor(w + 1e-4)).toFixed(4)]);
        }
        const out = { rows: rows, writes: V23.bots._stats.deathWrites - s0 };
        respawnEnemy(e);
        packEnemyBatches();
        out.respawned = e.page ? +e.page.kit.geometry.attributes.instanceKit.getW(e.page.members.indexOf(e)).toFixed(4) : null;
        return out;
    });
    const lie = dis.rows.find((r) => r[1] >= 0);
    assert.ok(lie, 'the topple lands');
    const lieT = lie[1];
    for (const [t, , d] of dis.rows) {
        if (t < lieT + 0.6 - 1e-6) assert.equal(d, 0, `no dissolve before 0.6 s into the lie (t ${t})`);
        else if (t > lieT + 0.75 && t < lieT + 1.4) assert.ok(d > 0 && d < 1, `dissolving at t ${t} (${d})`);
    }
    assert.ok(Math.max(...dis.rows.map((r) => r[2])) > 0.8, 'the dissolve nearly completes before the sink ends');
    assert.ok(dis.writes > 10 && dis.writes <= dis.rows.length, `written on death ticks (${dis.writes} of ${dis.rows.length})`);
    assert.equal(dis.respawned, 1, 'a respawn starts clean (kit on, no dissolve)');

    // ---- identity off: kits hidden (0 kit draws), uIdentity 0; on again ----------------------------------------------
    const pill = (v) => evaluate((v) => document.querySelector(`#setting-agent-identity-pills [data-agentidentity="${v}"]`).click(), v);
    const drawState = () => evaluate(() => {
        packEnemyBatches();
        const pages = [];
        for (const c of enemyChunks.values()) for (const pg of c.pages) pages.push(pg);
        const cam = new THREE.PerspectiveCamera(100, 480 / 270, 0.5, 400);
        cam.position.set(0, 120, 0.01); cam.lookAt(0, 0, 0); cam.updateMatrixWorld();
        const keep = new Set(), hidden = [];
        for (const pg of pages) for (const m of pg.meshes) keep.add(m);
        for (const o of scene.children) if (!keep.has(o) && !o.isLight && o.visible) { hidden.push(o); o.visible = false; }
        const count = () => { renderer.info.reset(); renderer.setRenderTarget(null); renderer.clear(); renderer.render(scene, cam); return renderer.info.render.calls; };
        const asIs = count();
        const vis = pages.map((pg) => pg.kit.visible), counts = pages.map((pg) => pg.kit.count);
        for (const pg of pages) pg.kit.visible = false;
        const none = count();
        pages.forEach((pg, i) => { pg.kit.visible = vis[i]; });
        for (const o of hidden) o.visible = true;
        return { kitDraws: asIs - none, live: pages.filter((pg) => pg.meshes[0].count > 0).length, uIdentity: enemyAnimUniforms.uIdentity.value, counts: counts };
    });
    await evaluate(() => { for (const x of enemyObjects) if (!x.isActive && x.slot < CONTENT.enemies) respawnEnemy(x); });
    await pill('off');
    await frames(3);
    const off = await drawState();
    assert.equal(off.uIdentity, 0, 'identity off: uIdentity 0');
    assert.equal(off.kitDraws, 0, `identity off: 0 kit draws (${JSON.stringify(off)})`);
    assert.ok(off.counts.every((v) => v === 0), 'identity off: every kit at count 0');
    await pill('on');
    await frames(3);
    const on = await drawState();
    assert.equal(on.uIdentity, 1, 'identity on again: uIdentity 1');
    assert.equal(on.kitDraws, on.live, `identity on again: a kit draw per live page (${JSON.stringify(on)})`);

    // ---- wingmen: one Group child, the kit as the figure's 5th child, draws equal with EA off and on -------------------
    const wing = await evaluate(() => {
        const te = tacticalEnhancements;
        if (!te.wingmanEnabled) te.toggleWingmanAI(true);
        te.wingmanGroup.visible = true;
        te.wingmanBots.forEach((b, i) => b.group.position.set(-13 + i * 4, 0, 8));
        // (the Group Enhanced Animations adds for its rig, V2.2's, is not the figure: EA was first switched on above)
        const rigs = new Set(enhancedAnim.wingRigs.map((r) => r.rig));
        const out = { plain: te.wingmanBots.map((b) => { const figs = b.group.children.filter((c) => c.isGroup && !rigs.has(c)); return [figs.length, figs[0] ? figs[0].children.length : 0, figs[0] && figs[0].children[4] ? figs[0].children[4].name : null]; }) };
        const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 200);
        cam.position.set(-11, 6, 20); cam.lookAt(-11, 0, 8); cam.updateMatrixWorld();
        const sm = renderer.shadowMap, smRender = sm.render;
        let shadowCalls = 0;
        sm.render = function () { const c0 = renderer.info.render.calls; const r = smRender.apply(this, arguments); shadowCalls += renderer.info.render.calls - c0; return r; };
        const count = (on) => {
            enhancedAnim.set(on);
            const hidden = [];
            for (const o of scene.children) if (o !== te.wingmanGroup && !o.isLight && o.visible) { hidden.push(o); o.visible = false; }
            shadowCalls = 0; sm.needsUpdate = true;
            renderer.info.reset(); renderer.setRenderTarget(null); renderer.clear(); renderer.render(scene, cam);
            const n = [renderer.info.render.calls, shadowCalls];
            for (const o of hidden) o.visible = true;
            return n;
        };
        const identity = (v) => { game.userSettings.agentIdentity = v; V23.core.applySettings(game.userSettings, 'agentIdentity'); packEnemyBatches(); };
        try {
            out.off = count(false);
            out.on = count(true);
            out.rigKits = enhancedAnim.wingRigs.map((r) => r.rig.children.filter((c) => c.name === 'v23:rigKit').length);
            out.off2 = count(false);
            // identity off: the plain kits and the rig kits draw nothing (V2.2's wingman draws)
            identity('off');
            out.idOff = [count(false), count(true)];
            identity('on');
            out.idOn = [count(false), count(true)];
            enhancedAnim.set(false);
        } finally { sm.render = smRender; if (game.userSettings.agentIdentity !== 'on') identity('on'); }
        out.n = te.wingmanBots.length;
        return out;
    });
    for (const [groups, children, kit] of wing.plain) {
        assert.equal(groups, 1, 'one Group child per wingman');
        assert.equal(children, 5, 'the figure holds its 4 parts and the kit');
        assert.equal(kit, 'v23:wingKit', 'the 5th child is the agent kit');
    }
    assert.equal(wing.on[0], wing.off[0], `wingman draws equal with Enhanced Animations off and on (${JSON.stringify(wing)})`);
    assert.equal(wing.on[1], wing.off[1], 'and in the shadow pass');
    assert.equal(wing.off2[0], wing.off[0], 'and off again');
    assert.deepEqual(wing.rigKits, wing.rigKits.map(() => 1), 'each EA rig carries a one-instance kit');
    assert.ok(wing.n > 0, 'some wingmen');
    for (const ea of [0, 1]) {
        const tag = ea ? 'Enhanced Animations on' : 'Enhanced Animations off';
        assert.equal(wing.idOn[ea][0] - wing.idOff[ea][0], wing.n, `${tag}: one kit draw per wingman more than with identity off (${JSON.stringify(wing)})`);
        assert.equal(wing.idOn[ea][1], wing.idOff[ea][1], `${tag}: the shadow pass unchanged by the kits`);
    }
    console.log('# wingman draws (main, shadow) EA off / on:', JSON.stringify([wing.off, wing.on]), 'identity off (EA off, on):', JSON.stringify(wing.idOff), 'for', wing.n, 'wingmen');

    // ---- tier swaps compile nothing; kitRep and archOverride restore bit-exact; steady frames upload no kit bytes -----
    const tiers = await evaluate(() => {
        const S = V23.bots._state, out = { seen: [] };
        const pos = () => { const pg = [...enemyChunks.values()][0].pages[0]; return pg.kit.geometry.attributes.position; };
        const render = () => { renderer.info.reset(); renderer.setRenderTarget(null); renderer.render(scene, camera); };
        game.userSettings.charDetail = 'on'; applyVisualOverrides(); packEnemyBatches(); render();
        out.seen.push([S.tier, pos() === V23.parts.kitSuperset('high').attributes.position]);
        ultraChars.set(true); packEnemyBatches(); render();
        out.seen.push([S.tier, pos() === V23.parts.kitSuperset('ultra').attributes.position]);
        ultraChars.set(false); packEnemyBatches(); render();
        out.seen.push([S.tier, pos() === V23.parts.kitSuperset('high').attributes.position]);
        game.userSettings.charDetail = 'off'; applyVisualOverrides(); packEnemyBatches(); render();
        out.seen.push([S.tier, pos() === V23.parts.kitSuperset(S.tier).attributes.position]);
        out.reserveTier = S.reserve.every((pg) => pg.meshes.every((m, p) => m.geometry.attributes.position === enemyPartSpecs[p].geometry.attributes.position));
        // archOverride: the recorded archetype's scale and colours, then the live values back bit-exact
        const e = enemyObjects.find((x) => x.isActive && !x.hit);
        const snap = () => JSON.stringify([e.mesh.scale.toArray(), e.leaves.map((l) => l.material.color.toArray())]);
        const live = snap(), arch = e.archetype;
        const other = ENEMY_ARCHETYPE_ORDER.indexOf(arch === 'armored' ? 'rusher' : 'armored');
        out.arch = [V23.bots.archOverride(e, other), snap() !== live, Math.abs(e.mesh.scale.x - ENEMY_ARCHETYPES[ENEMY_ARCHETYPE_ORDER[other]].scale.x) < 1e-12, V23.bots.archOverride(e, -1), snap() === live];
        out.rep = [V23.bots.kitRep(e, { agentId: 'sage' }), V23.bots.kitRep(e, { agentId: 'nobody' }), V23.bots.kitRep(e, null)];
        // the restore also works with identity off (only starting an override needs it on)
        const identity = (v) => { game.userSettings.agentIdentity = v; V23.core.applySettings(game.userSettings, 'agentIdentity'); packEnemyBatches(); };
        const slot = () => V23.bots._state.slots[e.slot | 0];
        const a1 = V23.bots.archOverride(e, other), r1 = V23.bots.kitRep(e, { agentId: 'sage' });
        identity('off');
        out.offRestore = [a1, r1, V23.bots.archOverride(e, other), V23.bots.kitRep(e, { agentId: 'omen' }), V23.bots.archOverride(e, -1), snap() === live, V23.bots.kitRep(e, null), slot().rep, slot().arch];
        identity('on');
        // a save from an earlier life: dropped after a respawn (the new life's own scale and colours stay)
        V23.bots.archOverride(e, other);
        respawnEnemy(e);
        packEnemyBatches();
        const life = snap();
        out.stale = [V23.bots.archOverride(e, -1), snap() === life, Math.abs(e.mesh.scale.x - ENEMY_ARCHETYPES[e.archetype].scale.x) < 1e-12];
        // steady state: frames with nothing to recolour upload no kit bytes. Each bot moves 0.01 m a frame toward the centre
        // of its own chunk, so no page changes (a bot crossing into another page is a structure repack, which rewrites
        // its kit slots as V2.2 rewrites its colours)
        packEnemyBatches();
        const b0 = V23.bots._stats.uploadBytes, w0 = V23.bots._stats.kitWrites;
        const where = () => enemyObjects.map((x) => [x.page, x.pageCx, x.pageCz]);
        const p0 = where();
        for (let i = 0; i < 30; i++) {
            for (const x of enemyObjects) if (x.isActive) {
                const c = (x.pageCx + 0.5) * 50;
                x.mesh.position.x += Math.abs(c - x.mesh.position.x) > 0.02 ? Math.sign(c - x.mesh.position.x) * 0.01 : 0;
                x.mesh.rotation.y += 0.01;
                x.poseDirty = true;
            }
            packEnemyBatches();
        }
        out.steady = { bytes: V23.bots._stats.uploadBytes - b0, writes: V23.bots._stats.kitWrites - w0 };
        out.samePages = where().every((w, i) => w[0] === p0[i][0] && w[1] === p0[i][1] && w[2] === p0[i][2]);
        // a page V2.2 releases (its free list full): the kit set goes back to the pool first, and the next page takes it
        const pool0 = V23.bots._state.pool.length, spare = createEnemyPage(), had = !!spare.kit;
        releaseEnemyPageGPU(spare);
        const pool1 = V23.bots._state.pool.length, next = createEnemyPage(), reused = V23.bots._state.pool.length === pool1 - 1 && !!next.kit;
        releaseEnemyPageGPU(next);
        out.release = [had, spare.kit === null, pool1 === pool0 + 1, reused];
        out.stats = V23.bots._stats;
        return out;
    });
    assert.deepEqual(tiers.seen.map((s) => s[1]), [true, true, true, true], `the kit superset follows the tier (${JSON.stringify(tiers.seen)})`);
    assert.deepEqual(tiers.seen.slice(0, 3).map((s) => s[0]), ['high', 'ultra', 'high']);
    assert.ok(tiers.reserveTier, 'the reserve pages follow the body tier');
    assert.deepEqual(tiers.arch, [true, true, true, true, true], 'archOverride applies and restores bit-exact');
    assert.deepEqual(tiers.rep, [true, false, true], 'kitRep takes a known agent and null');
    assert.deepEqual(tiers.offRestore, [true, true, false, false, true, true, true, -1, -1], `identity off: no new override, and both restore bit-exact (${JSON.stringify(tiers.offRestore)})`);
    assert.deepEqual(tiers.stale, [false, true, true], 'a save from the last life is dropped: the new life keeps its own scale and colours');
    assert.ok(tiers.samePages, 'the steady frames keep every bot on its page');
    assert.deepEqual(tiers.release, [true, true, true, true], 'a released page returns its kit set to the pool, and the next page reuses it');
    assert.deepEqual(tiers.steady, { bytes: 0, writes: 0 }, 'steady frames write and upload no kit data');
    console.log('# stats', JSON.stringify(tiers.stats));

    await frames(5);
    const rand = await evaluate(() => window.__v23rand);
    console.log('# Math.random draws', rand.total, 'inside BOTKIT', rand.inside, JSON.stringify(rand.sites), 'V23.bots calls', JSON.stringify(rand.calls));
    // (wingKit runs when the wingmen are built, at boot: the boot probe covers it)
    for (const k of ['assign', 'onPage', 'releasePage', 'packPose', 'packColor', 'flush', 'geomAttrs', 'wingRig', 'onTier', 'setRim', 'onKilled', 'kitRep', 'archOverride'])
        assert.ok(rand.calls[k] > 0, `V23.bots.${k} was driven`);
    assert.equal(rand.inside, 0, `no Math.random draw inside BOTKIT (${JSON.stringify(rand.sites)})`);
    const [programs, watermark, stalls] = await programState(page);
    assert.equal(watermark, watermark0, 'the watermark never moved');
    assert.equal(programs, watermark, 'programs == watermark');
    assert.equal(stalls, 0, 'no first-use stalls');
    assert.deepEqual(errors, []);
});
