'use strict';
// V2.3 agent roster (design 17.1, WP2): one boot of the V2.3 build with the start screen open (the sim is paused), data-
// driven by AGENT_ORDER (ROLE=<role> narrows the per-agent rows), after one baseline boot of '(V2.2) valorant-fps.html'
// (same quality and menu) that gives the program count and watermark V2.3 must match (design 15: programs +0). Checks:
//  - the roster sets are equal: AGENT_ORDER, AGENT_DEFS and AGENT_LOOKS hold the same 29 ids;
//  - every entry resolves; Sage and Omen are full entries, every other entry is flagged a stub (role batches add full
//    entries without touching this file); full entries pass the whole lint and the validator reports nothing;
//    deliberately broken entries are rejected and leave the registry as it was;
//  - builds are deterministic (the geometry hash of a second, fresh build equals the first) and make no Math.random call
//    once the object pool exists (a counting wrapper around Math.random); every build takes from the pool (no misses);
//  - show LODs within 7,000 vertices and 36 draws, world LODs within 6 meshes, body LODs within 36 draws; the pilots'
//    own build times next to the median;
//  - the show LOD's hand nodes (children of the forearms at the wrist) swap the hand key's shared pose geometry by
//    reference as the motion samples, and V23.motion.sample allocates nothing on the JS heap once warm;
//  - intros are interruptible: an idle sampled right after an intro (into the same pose and the same root) equals a
//    fresh idle, nothing carried over; Omen's idle turns his head on one seeded schedule (every interval in
//    idle.tic.every, across the schedule's loop too) and flexes his right hand on its own (design 4.2);
//  - seams and clearances on every show LOD's primitives (no shells that coincide or graze): the upper arm's capsule
//    dome shares the sleeve's end ring, the elbow ball stands proud of both limb ends, coaxial cylinders on one node
//    are 6 mm apart where they overlap and never stack caps within 3 mm, shoulder caps clear the sleeve, the pelvis
//    floor clears the thighs; Omen's rift key stays clear of his right hand and forearm in every clip;
//  - every kit module of every tier inside the union hit volume +0.03 m at every archetype scale; Medium modules at most
//    48 vertices each (design 3.4);
//  - the staged builder never steps in unpaused combat; in the menu it spreads a figure over frames, starting a unit only
//    while the frame is under its budget; define() gives the old LODs back to the pool and queues show and world;
//  - after building and upload-drawing every LOD of every agent (show, world and body) and drawing each with its own
//    materials where it is drawn in the game (show: the stage's light set, every hand pose; world and body: the game
//    scene): programs == watermark == V2.2's, 0 stalls;
//  - silhouettes (64 x 64 masks, front and 3/4) and idle feature vectors between full entries; palette pairs;
//  - V23MATRIX rows for the coverage matrix (tests/tools/matrix.js reads them).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { boot, closeBrowser, programState, GAME_FILE } = require('./harness');

after(closeBrowser);

const ROLE = process.env.ROLE || null;
const matrix = (agent, column, ok, detail) => console.log('V23MATRIX ' + JSON.stringify({ agent, column, ok: !!ok, detail: detail === undefined ? '' : detail }));

// The union hit volume, read from buildActorTemplates in the game source (the hit proxies never change): the detailed
// boxes (Medium content tier and up) and the Low ones, each { c: [x, y, z], h: [half sizes] }
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
    const detailed = parse(body.slice(0, split)).concat(head);
    const low = parse(body.slice(split, body.indexOf('T.enemyHead'))).concat(head);
    return { detailed, low };
}

test('agent roster: registry, lint, builds, budgets, hit volume, staged builder, programs', { timeout: 900000 }, async () => {
    const boxes = hitBoxes();
    assert.equal(boxes.detailed.length, 7, 'detailed hit boxes: body, two arms, two legs, weapon, head');
    assert.equal(boxes.low.length, 4, 'low hit boxes: body, arms block, legs, head');

    // ---- the baseline: V2.2's own program count and watermark, booted the same way (menu, Medium) -----------------------
    // (programs == watermark inside V2.3 alone cannot catch a program V2.3's boot adds: its warm-up folds it into the
    // watermark; V2.2's numbers can)
    const base = await boot({ file: '(V2.2) valorant-fps.html', menu: true });
    await base.frames(10);
    const v22 = await programState(base.page);
    assert.deepEqual(base.errors, [], 'V2.2 boots cleanly');
    console.log('# V2.2 baseline: programs', v22[0], 'watermark', v22[1], 'stalls', v22[2]);

    const { page, errors, frames, evaluate } = await boot({
        menu: true,
        // a counter around Math.random from the first script on (the harness's own calls do not go through V23)
        initScript: () => {
            const real = Math.random;
            window.__rand = { n: 0, on: false };
            Math.random = function () { if (window.__rand.on) window.__rand.n++; return real(); };
        }
    });
    await frames(10);
    // V2.3's boot, identity on (the default): the same program count and watermark as V2.2's
    const atBoot = await programState(page);
    console.log('# V2.3 boot: programs', atBoot[0], 'watermark', atBoot[1], 'stalls', atBoot[2]);
    assert.equal(atBoot[1], v22[1], 'V2.3 boot watermark == V2.2 boot watermark (design 15: programs +0)');
    assert.equal(atBoot[0], v22[0], 'V2.3 program count at the menu == V2.2\'s');
    assert.equal(atBoot[2], 0, 'no first-use stalls at boot');

    // ---- roster sets, resolve, stubs ---------------------------------------------------------------------------------
    const reg = await evaluate(() => {
        const keysLooks = Object.keys(AGENT_LOOKS), keysDefs = Object.keys(AGENT_DEFS);
        const res = {};
        for (const id of AGENT_ORDER) {
            const L = V23.core.resolve(id);
            res[id] = L ? { stub: L.stub, entryStub: !!(AGENT_LOOKS[id] && AGENT_LOOKS[id].stub), role: L.role, frozen: Object.isFrozen(L) && Object.isFrozen(L.palette) && Object.isFrozen(L.previews.c), same: V23.core.resolve(id) === L,
                gestures: ['c', 'q', 'e', 'x'].map((s) => L.gestures[s]), recipes: ['c', 'q', 'e', 'x'].map((s) => L.previews[s].recipe), sounds: ['c', 'q', 'e', 'x'].map((s) => (L.previews[s].sound.calls || []).length),
                introMs: V23.motion.idle(id).introMs, intro: L.showroom.intro, pool: L.bot.pool, kit: L.bot.kit.slice(), codename: L.codename, avoid: L.avoid.length } : null;
        }
        return { order: AGENT_ORDER.slice(), keysLooks, keysDefs, res, validate: V23.core.validate(), menuOpen: mainMenu.open, paused: mainMenu.paused() };
    });
    assert.equal(reg.order.length, 29, '29 agents in AGENT_ORDER');
    assert.deepEqual([...reg.keysDefs].sort(), [...reg.order].sort(), 'AGENT_DEFS holds exactly AGENT_ORDER');
    assert.deepEqual([...reg.keysLooks].sort(), [...reg.order].sort(), 'AGENT_LOOKS holds exactly AGENT_ORDER');
    assert.deepEqual(reg.validate, [], 'V23.core.validate() reports nothing for the roster');
    assert.ok(reg.menuOpen && reg.paused, 'the start screen is open and the sim paused');
    // data-driven: Sage and Omen are full entries (more arrive with each role batch); every other entry is flagged a stub
    const full = reg.order.filter((id) => !reg.res[id].stub);
    assert.ok(full.includes('sage') && full.includes('omen'), 'Sage and Omen are full entries');
    for (const id of reg.order) assert.equal(reg.res[id].stub, reg.res[id].entryStub, id + ': resolve(id).stub matches its entry (' + (reg.res[id].stub ? 'stub' : 'full') + ')');
    console.log('# full entries:', full.join(', '), '| stubs:', reg.order.length - full.length);
    const agents = reg.order.filter((id) => !ROLE || reg.res[id].role === ROLE.toUpperCase());
    for (const id of reg.order) {
        const r = reg.res[id];
        assert.ok(r, id + ' resolves');
        assert.ok(r.frozen && r.same, id + ': the resolved look is frozen and cached');
        assert.ok(r.gestures.every(Boolean) && r.recipes.every(Boolean) && r.sounds.every((n) => n > 0), id + ': every slot has a gesture, a recipe and a sound');
        assert.ok(r.introMs <= 1400, id + ': intro at most 1.4 s');
    }
    assert.equal(reg.res.sage.codename, 'Crystal Medic');
    assert.equal(reg.res.omen.codename, 'Rift Infiltrator');
    for (const id of agents) {
        const r = reg.res[id];
        matrix(id, 'look entry valid (validator)', true, r.stub ? 'stub (role default ' + r.role + ')' : 'full entry, lint clean');
    }

    // ---- the full lint for Sage and Omen and rejected entries -------------------------------------------------------
    const lint = await evaluate(() => {
        const out = {};
        for (const id of ['sage', 'omen']) {
            const L = V23.core.resolve(id), e = AGENT_LOOKS[id];
            out[id] = { fields: ['codename', 'concept', 'avoid', 'rig', 'height', 'shoulderScale', 'hips', 'stance', 'palette', 'head', 'outfit', 'shoulders', 'back', 'equipment',
                'gloves', 'prop', 'motion', 'idle', 'showroom', 'gestures', 'previews', 'fp', 'sound', 'bot', 'mvp'].filter((f) => e[f] === undefined),
                avoid: L.avoid.slice(), tempo: L.motion.tempo, snap: L.motion.snap, intro: L.showroom.intro, x: L.gestures.x, pool: L.bot.pool, kit: L.bot.kit.slice(),
                hair: L.head.hair, gear: L.head.gear.slice(), outfit: L.outfit.map((o) => o.m), glove: L.gloves.type, tips: L.gloves.tips, prop: L.prop.m, hold: L.prop.hold,
                gestureKeys: Object.keys(L.gestures).sort(), idle: L.idle.hands, breath: L.idle.breath.slice() };
        }
        const tryDef = (id, mut) => {
            const before = JSON.stringify(AGENT_LOOKS[id]), resolved = V23.core.resolve(id);
            const d = JSON.parse(before);
            mut(d);
            let threw = null;
            try { V23.core.define(id, d); } catch (e) { threw = e.message; }
            return { threw, kept: JSON.stringify(AGENT_LOOKS[id]) === before && V23.core.resolve(id) === resolved };
        };
        out.broken = [
            tryDef('sage', (d) => { delete d.gloves; }),
            tryDef('sage', (d) => { d.showroom.introMs = 2000; }),
            tryDef('omen', (d) => { d.outfit[0].m = 'noSuchModule'; }),
            tryDef('omen', (d) => { d.gestures.q = 'noSuchGesture'; }),
            tryDef('sage', (d) => { d.palette.base.c = 'white'; }),
            tryDef('omen', (d) => { d.bot.pool = 'healer'; }),
            tryDef('sage', (d) => { d.stance.carry = 'juggle'; }),
            tryDef('omen', (d) => { d.motion.tempo = 2; }),
            // design 3.1: second presses are c2, q2 and e2 only
            tryDef('omen', (d) => { d.gestures.x2 = 'fingerSnap'; })
        ];
        let unknown = null;
        try { V23.core.define('notAnAgent', JSON.parse(JSON.stringify(AGENT_LOOKS.sage))); } catch (e) { unknown = e.message; }
        out.unknown = unknown;
        out.validateAfter = V23.core.validate();
        return out;
    });
    for (const id of ['sage', 'omen']) assert.deepEqual(lint[id].fields, [], id + ': every schema field is in the entry itself');
    assert.deepEqual(lint.sage.avoid, ['hair bun or top-knot', 'mandarin or qipao-style collar', 'orb held like a ball', 'dress silhouette']);
    assert.deepEqual(lint.omen.avoid, ['hood or cloak', 'tattered robes', 'arm bandages', 'glowing eye marks on a shadow face']);
    // the avoid lists, kept by construction: no bun or knot hair and no standing collar for Sage, the crystal floats; no
    // hood, cloak or robe module for Omen, gauntlets (no wraps), a slatted visor on a sealed helm (no eye marks)
    assert.ok(!/knot|bun/i.test(lint.sage.hair) && lint.sage.outfit.indexOf('collarFunnel') < 0 && lint.sage.hold === 'float' && lint.sage.outfit.indexOf('gownCoat') < 0);
    assert.ok(lint.omen.hair === null && !lint.omen.outfit.some((m) => /robe|cloak|hood/i.test(m)) && lint.omen.glove === 'gauntlet' && lint.omen.gear.indexOf('helmSealed') === 0);
    assert.deepEqual(lint.omen.gestureKeys, ['c', 'c2', 'e', 'e2', 'q', 'q2', 'x'], 'second presses c2, q2, e2 (no x2: design 3.1)');
    assert.equal(lint.sage.intro, 'assembleCrystal');
    assert.equal(lint.omen.intro, 'riftStep');
    assert.deepEqual([lint.sage.pool, lint.sage.kit, lint.omen.pool, lint.omen.kit], ['armored', [2, 11, 13], 'standard', [1, 15, 12]]);
    for (const b of lint.broken) {
        assert.ok(b.threw && /V23\.core\.define/.test(b.threw), 'a broken entry is rejected: ' + b.threw);
        assert.ok(b.kept, 'and the registry keeps the entry it had');
    }
    assert.ok(lint.unknown && /unknown agent/.test(lint.unknown), 'an id outside AGENT_DEFS is rejected');
    assert.deepEqual(lint.validateAfter, [], 'the roster still validates after the rejected entries');

    // ---- builds: no Math.random once the pool exists, budgets, deterministic hashes, build times ---------------------
    const builds = await evaluate(() => {
        // the pool exists after core.init (identity is on by default); a first build would make it otherwise
        V23.core.build(game.activeAgent, 'show');
        const pool0 = Object.assign({}, { made: V23.parts.pool.made, meshes: V23.parts.pool.meshes, madeMs: V23.parts.pool.madeMs }), miss0 = V23.parts.stats.poolMisses;
        window.__rand.n = 0; window.__rand.on = true;
        const out = { show: {}, world: {}, ms: [] };
        for (const id of AGENT_ORDER) {
            for (const tier of ['show', 'world']) {
                const had = (V23.core.stats.built[id] || []).indexOf(tier) >= 0, b0 = V23.parts.stats.builds;
                const t0 = performance.now();
                const root = V23.core.build(id, tier);
                const ms = performance.now() - t0;
                const v = root.userData.v23;
                let meshes = 0;
                root.traverse((o) => { if (o.isMesh && o.geometry.groups.length) meshes++; });
                out[tier][id] = Object.assign({ hash: v.hash, objMeshes: meshes, nodes: v.nodeList.length }, v.stats);
                // build: the figure itself (V23.parts' job time); total: with core.build's upload draw
                if (!had && V23.parts.stats.builds === b0 + 1) out.ms.push({ id, tier, ms: V23.parts.stats.lastMs, total: ms, units: V23.parts.stats.lastUnits, handMs: V23.parts.stats.lastHandMs });
            }
        }
        // motion sampling on a built root draws nothing either
        for (const id of ['sage', 'omen']) for (const clip of ['idle', 'intro', 'lockIn', 'mvp', 'c', 'q', 'e', 'x']) for (let t = 0; t < 3; t += 0.25) V23.motion.sample(id, clip, t, V23.core.build(id, 'show'));
        out.rand = window.__rand.n;
        window.__rand.on = false;
        out.pool = pool0;
        out.misses = V23.parts.stats.poolMisses - miss0;
        // a second, fresh build of every show LOD (V23.parts.figure) has the same hash; each goes back to the pool after
        const free0 = [V23.parts.pool.meshes, V23.parts.pool.groups, V23.parts.pool.vm];
        out.again = {};
        // (each one's job time too: these are warm builds, with the hand keys' pose geometries and the primitives cached)
        out.warmMs = {};
        for (const id of AGENT_ORDER) { const r = V23.parts.figure(V23.core.resolve(id), 'show'); out.warmMs[id] = V23.parts.stats.lastMs; out.again[id] = r.userData.v23.hash; out.released = V23.parts._release(r); }
        out.poolBack = [V23.parts.pool.meshes, V23.parts.pool.groups, V23.parts.pool.vm].join() === free0.join();
        out.missesAll = V23.parts.stats.poolMisses - miss0;
        out.poolSize = V23.parts.pool.size;
        out.poolNeedsMs = V23.parts.pool.needsMs;
        out.kit = ['low', 'medium', 'high', 'ultra'].map((t) => { const g = V23.parts.kitSuperset(t); return { tier: t, v: g.userData.kit.vertices, hash: g.userData.kit.hash, again: V23.parts.kitSuperset(t) === g, modules: g.userData.kit.modules.map((m) => [m.name, m.vertices]) }; });
        // the first-person arm sets WP4 attaches: a sleeve and a detail geometry in hand space, slots from the look's fp;
        // cached per agent (a second call returns the same set and takes nothing from the pool)
        out.fp = {};
        const g0 = V23.parts.pool.geoms;
        for (const id of AGENT_ORDER) V23.parts.fpArms(V23.core.resolve(id));
        const g1 = V23.parts.pool.geoms;
        out.fpCached = AGENT_ORDER.every((id) => V23.parts.fpArms(V23.core.resolve(id)) === V23.parts.fpArms(V23.core.resolve(id))) && V23.parts.pool.geoms === g1;
        out.fpTaken = g0 - g1;
        // design 7.2: the arm set is at most 3 draws (sleeve groups + detail groups), for every agent
        out.fpDraws = AGENT_ORDER.map((id) => { const a = V23.parts.fpArms(V23.core.resolve(id)); return [id, a.draws, a.sleeve.groups.length + a.detail.groups.length, a.cuffFolded]; });
        for (const id of ['sage', 'omen']) {
            const a = V23.parts.fpArms(V23.core.resolve(id));
            a.sleeve.computeBoundingBox();
            out.fp[id] = { sleeve: a.sleeve.attributes.position.count, detail: a.detail.attributes.position.count, groups: [a.sleeve.groups.length, a.detail.groups.length],
                slots: a.slots, wrist: a.wrist, overlay: a.overlay, draws: a.draws, folded: a.cuffFolded, box: [a.sleeve.boundingBox.min.toArray().map((v) => +v.toFixed(2)), a.sleeve.boundingBox.max.toArray().map((v) => +v.toFixed(2))] };
        }
        return out;
    });
    for (const id of ['sage', 'omen']) {
        const f = builds.fp[id];
        assert.ok(f.sleeve > 0 && f.detail > 0 && f.groups[0] >= 1 && f.groups[1] >= 1, id + ': first-person sleeve and detail geometry');
        // both forearms, from the wrists (+-0.08, -0.09) down and back toward the camera
        assert.ok(f.box[0][0] < -0.05 && f.box[1][0] > 0.05 && f.box[0][1] < -0.2 && f.box[1][2] > 0.15, id + ': sleeves in hand space ' + JSON.stringify(f.box));
        console.log('#', id, 'fp arms', JSON.stringify(f));
    }
    assert.deepEqual([builds.fp.sage.slots.sleeve, builds.fp.sage.wrist], [['base', 'skin'], 'ampouleCuff'], 'Sage: a white sleeve over a bare forearm, jade ampoule cuffs');
    // design 7.2: at most 3 draws per arm set; Sage's rolled sleeve needs four materials, so her cuff parts take the sleeve's
    for (const [id, draws, groups] of builds.fpDraws) assert.ok(draws <= 3 && draws === groups, id + ': first-person arm set ' + draws + ' draws (<= 3)');
    assert.deepEqual([builds.fp.sage.draws, builds.fp.sage.folded, builds.fp.sage.slots.detail], [3, true, ['glow']], 'Sage: [base, skin] + [glow], the cuff folded into the sleeve');
    assert.deepEqual([builds.fp.omen.draws, builds.fp.omen.folded], [2, false], 'Omen: [under] + [trim]');
    assert.deepEqual([builds.fp.omen.slots.sleeve, builds.fp.omen.wrist, builds.fp.omen.overlay], [['under'], 'plateRing', 'basePlatesL'], 'Omen: the undersuit sleeve, plate rings, left forearm plates');
    assert.equal(builds.rand, 0, 'no Math.random call while every agent\'s show and world LOD builds and while motion samples');
    assert.ok(builds.pool.made, 'the object pool exists');
    assert.equal(builds.misses, 0, 'every build took its objects from the pool');
    assert.equal(builds.missesAll, 0, 'and so did 29 fresh builds, each released after');
    assert.ok(builds.released && builds.poolBack, 'V23.parts._release gave every fresh build\'s meshes, group and materials back');
    assert.ok(builds.fpCached, 'fpArms is cached per agent');
    assert.ok(builds.fpTaken <= 2 * 29, 'one arm set (2 geometries) per agent at most: ' + builds.fpTaken);
    console.log('# pool', JSON.stringify(builds.poolSize), 'sized in', builds.poolNeedsMs.toFixed(1), 'ms, made in', builds.pool.madeMs.toFixed(1), 'ms');
    // the pool's node count, read from the entries without expanding them, is exactly what the built figures hold
    const shownMeshes = reg.order.reduce((n, id) => n + 11 + builds.show[id].nodes, 0);
    assert.equal(builds.poolSize.showMeshes, shownMeshes, 'the pool counts each agent\'s show meshes exactly (11 bones + its nodes)');
    // medians: the true middle (the mean of the two middle values for an even count)
    const median = (a) => { const b = a.slice().sort((x, y) => x - y), n = b.length; return n ? (n % 2 ? b[n >> 1] : (b[n / 2 - 1] + b[n / 2]) / 2) : NaN; };
    const fix2 = (v) => (isFinite(v) ? v.toFixed(2) : '-');
    const fresh = builds.ms;
    const allMs = fresh.map((b) => b.ms), showMs = fresh.filter((b) => b.tier === 'show').map((b) => b.ms);
    console.log('# build ms per figure (V23.parts job time; ' + fresh.length + ' figures built here): median', fix2(median(allMs)),
        '| show median', fix2(median(showMs)), '| max', allMs.length ? Math.max(...allMs).toFixed(2) : '-');
    // the full entries' show figures apart (the stubs are cheap; each role batch adds full entries: re-measure then): cold
    // is their first build here (a new hand key builds its eight pose geometries inside it), warm a rebuild
    const fullShow = reg.order.filter((id) => !reg.res[id].stub);
    const cold = fresh.filter((b) => b.tier === 'show' && fullShow.includes(b.id));
    console.log('# full-entry show figures (' + fullShow.join(', ') + '): cold median', fix2(median(cold.map((b) => b.ms))), 'ms (' + cold.map((b) => b.id + ' ' + b.ms.toFixed(2) + ', ' + b.units + ' units, ' + b.handMs.toFixed(2) + ' ms of it its hand key\'s 8 poses').join('; ') +
        ') | warm median', fix2(median(fullShow.map((id) => builds.warmMs[id]))), 'ms (' + fullShow.map((id) => id + ' ' + builds.warmMs[id].toFixed(2)).join('; ') + ') | target <= 8 ms per figure');
    for (const id of ['sage', 'omen']) {
        const own = fresh.filter((b) => b.id === id);
        console.log('#', id, 'build ms', own.map((b) => b.tier + ' ' + b.ms.toFixed(2) + ' (' + b.units + ' units; with the upload draw ' + b.total.toFixed(2) + ')').join(', ') || '(built at boot)',
            '| show', JSON.stringify(builds.show[id]), 'world', JSON.stringify(builds.world[id]));
    }
    for (const id of reg.order) {
        const s = builds.show[id], w = builds.world[id];
        assert.ok(s.vertices <= 7000, `${id} show LOD ${s.vertices} vertices <= 7,000`);
        assert.ok(s.draws <= 36 && s.objMeshes <= 36, `${id} show LOD ${s.draws} draws, ${s.objMeshes} meshes <= 36`);
        assert.ok(w.meshes <= 6 && w.draws <= 6, `${id} world LOD ${w.draws} draws in ${w.meshes} mesh(es) <= 6`);
        assert.equal(builds.again[id], s.hash, `${id}: a fresh build has the same geometry hash`);
    }
    assert.equal(builds.show.sage.nodes, 9, 'Sage: the prop, its six shards and the two hands are nodes');
    assert.equal(builds.show.omen.nodes, 13, 'Omen: the rift key, ten plates and the two hands are nodes');
    for (const id of agents) matrix(id, 'show LOD within budget (<= 7k vertices, <= 36 meshes)', builds.show[id].vertices <= 7000 && builds.show[id].draws <= 36,
        `${builds.show[id].vertices} v, ${builds.show[id].draws} draws; world ${builds.world[id].draws} draws`);
    // ---- hand nodes: the show LOD's hands swap their key's shared pose geometry by reference ----------------------------
    const hands = await evaluate(() => {
        const out = {};
        for (const id of AGENT_ORDER) {
            const root = V23.core.build(id, 'show'), v = root.userData.v23, H = v.hands;
            const set = H && H.set;
            const r = { key: set && set.key, idle: H && H.idle, poses: set ? Object.keys(set.geoms).sort() : [], uploaded: !!(set && set.uploaded),
                parents: H ? [H.R.parent === v.bones[4], H.L.parent === v.bones[6]] : [], mirror: H ? [H.R.scale.x, H.L.scale.x] : [],
                groups: set ? Object.values(set.geoms).map((g) => g.groups.length) : [], shared: true, seen: {} };
            // a few clips: the hands take the poses the clip names, and the geometry is the set's own object (by reference)
            for (const clip of ['idle', 'c', 'q', 'e', 'x', 'lockIn', 'mvp']) for (let t = 0; t < 1.6; t += 0.02) {
                const pose = V23.motion.sample(id, clip, t, root);
                for (const side of ['R', 'L']) {
                    const m = H[side], want = set.geoms[pose.hands[side]];
                    if (m.geometry !== want) r.shared = false;
                    r.seen[pose.hands[side]] = 1;
                }
            }
            r.seen = Object.keys(r.seen).sort();
            V23.motion.sample(id, 'idle', 0, root);
            out[id] = r;
        }
        // the six cast-hand poses (design 7.1) lead the list
        out.poses = V23.motion.HAND_POSES.slice();
        out.casts = V23.motion.CAST_POSES.slice();
        // Omen's finger snap: the flick releases at 90 ms of the 1.1 s clip (tempo 1.25), Sage's palm press at about 200 ms
        const rel = (id, slot) => { for (let t = 0; t < 0.6; t += 0.002) { const p = V23.motion.sample(id, slot, t, null); if (p.events.some((e) => e.kind === 'release')) return Math.round(p.events.find((e) => e.kind === 'release').t * 1100); } return null; };
        out.release = { omenC: rel('omen', 'c'), sageE: rel('sage', 'e') };
        // breath periods as authored: the spine's breath term repeats every breath[1] seconds
        out.breath = {};
        for (const id of ['sage', 'omen']) {
            const L = V23.core.resolve(id), per = L.idle.breath[1];
            const a = V23.motion.sample(id, 'idle', 0.3, null).bones[3 * 1], b = V23.motion.sample(id, 'idle', 0.3 + per, null).bones[3 * 1];
            out.breath[id] = { per, same: Math.abs(a - b) };
        }
        return out;
    });
    assert.deepEqual(hands.casts, ['open', 'cup', 'fist', 'point', 'snap', 'flat'], 'the six cast-hand poses');
    for (const id of reg.order) {
        const h = hands[id];
        assert.ok(h.key, id + ': a hand key');
        assert.deepEqual(h.poses, hands.poses.slice().sort(), id + ': its hand key holds all eight pose geometries');
        assert.ok(h.uploaded, id + ': the pose geometries were upload-drawn');
        assert.deepEqual(h.parents, [true, true], id + ': the hand nodes are children of the forearms');
        assert.deepEqual(h.mirror, [1, -1], id + ': the left hand mirrors the shared geometry');
        assert.ok(h.shared, id + ': each sampled pose swapped the shared geometry in by reference');
        assert.ok(new Set(h.groups).size === 1 && h.groups[0] >= 1 && h.groups[0] <= 3, id + ': every pose has the same groups ([glove, tips, trim])');
    }
    assert.deepEqual([hands.sage.key, hands.omen.key], ['fingerless|tips', 'gauntlet|one'], 'Sage: bare tips apart from the glove; Omen: one gauntlet draw');
    assert.ok(hands.omen.seen.includes('snap') && hands.omen.seen.includes('clawLow') && hands.sage.seen.includes('flat') && hands.sage.seen.includes('cup'),
        'the clips change the hand shapes: ' + JSON.stringify([hands.sage.seen, hands.omen.seen]));
    console.log('# hand poses seen: sage', hands.sage.seen.join(' '), '| omen', hands.omen.seen.join(' '), '| release ms', JSON.stringify(hands.release));
    assert.ok(hands.release.omenC >= 80 && hands.release.omenC <= 100, 'Omen\'s finger snap releases near 90 ms (tempo 1.25): ' + hands.release.omenC);
    assert.ok(hands.release.sageE >= 180 && hands.release.sageE <= 220, 'Sage\'s palm press releases near 200 ms (tempo 0.78): ' + hands.release.sageE);
    for (const id of ['sage', 'omen']) assert.ok(hands.breath[id].same < 1e-4, id + ': the breath repeats every ' + hands.breath[id].per + ' s (authored period)');
    for (const id of agents) matrix(id, 'show LOD hand nodes swap pose geometry by reference', hands[id].shared, hands[id].key + ', idle ' + hands[id].idle);

    // ---- intros are interruptible; Omen's idle schedules ------------------------------------------------------------
    // The sampler keeps no state between calls: an idle sampled right after an intro, into the same pose object and onto the
    // same root, equals the idle sampled with nothing before it (bones, root, scale, glow, rift card, hand shapes, every node)
    const motion = await evaluate(() => {
        const snapRoot = (root) => {
            const v = root.userData.v23, o = [];
            root.updateMatrixWorld(true);
            for (const b of v.bones) if (b) o.push(b.position.toArray(), b.rotation.toArray().slice(0, 3), b.scale.toArray());
            for (const n of v.nodeList) { const m = v.nodes[n]; o.push(m.position.toArray(), m.rotation.toArray().slice(0, 3), m.scale.toArray(), [m.visible ? 1 : 0]); }
            if (v.hands) o.push([v.hands.R.geometry.name, v.hands.L.geometry.name]);
            const gi = v.slots.indexOf('glow');
            if (gi >= 0) o.push([v.materials[gi].emissiveIntensity]);
            return JSON.stringify(o);
        };
        const snapPose = (p) => {
            const nodes = {};
            for (const k of Object.keys(p.nodes)) { const a = Array.from(p.nodes[k]); if (a.some((x, i) => x !== (i >= 6 ? 1 : 0))) nodes[k] = a; }
            return JSON.stringify([Array.from(p.bones), Array.from(p.root), p.scale, p.glow, p.fx.rift.open, p.hands.L, p.hands.R, p.events.length, nodes]);
        };
        const out = { interrupt: {} };
        for (const id of AGENT_ORDER) {
            const root = V23.core.build(id, 'show'), r = { root: true, pose: true, differs: false };
            for (const t of [0.05, 0.3, 0.7, 1.1]) {
                V23.motion.sample(id, 'idle', t, root);
                const a = snapRoot(root);
                V23.motion.sample(id, 'intro', t, root);
                if (snapRoot(root) !== a) r.differs = true;
                V23.motion.sample(id, 'idle', t, root);
                if (snapRoot(root) !== a) r.root = false;
                const fresh = snapPose(V23.motion.sample(id, 'idle', t, null));
                const P = V23.motion.sample(id, 'intro', t, null);
                if (snapPose(V23.motion.sample(id, 'idle', t, P)) !== fresh) r.pose = false;
            }
            V23.motion.sample(id, 'idle', 0, root);
            out.interrupt[id] = r;
        }
        // Omen's idle for 300 s at 50 Hz (past the 48-event schedule's loop): his head yaw only changes in snaps, so a snap
        // starts at the first sample that differs from the one before; his right hand flexes, his left never does
        const L = V23.core.resolve('omen'), every = L.idle.tic.every.slice();
        let pose = null, prevYaw = null, quiet = 0;
        const starts = [], flex = [], flexL = [];
        let inFlex = false;
        for (let k = 0; k <= 300 * 50; k++) {
            const t = k / 50;
            pose = V23.motion.sample('omen', 'idle', t, pose);
            const yaw = pose.bones[2 * 3 + 1];
            if (prevYaw !== null && Math.abs(yaw - prevYaw) > 1e-6) { if (quiet >= 25) starts.push(t); quiet = 0; } else quiet++;
            prevYaw = yaw;
            const f = pose.hands.R !== L.idle.hands;
            if (f && !inFlex) flex.push([t, pose.hands.R]);
            if (inFlex && !f) flex[flex.length - 1].push(t);
            inFlex = f;
            if (pose.hands.L !== L.idle.hands) flexL.push(t);
        }
        out.snaps = { every, starts };
        out.flex = { flex, flexL: flexL.length, idleHand: L.idle.hands };
        return out;
    });
    for (const id of reg.order) {
        const r = motion.interrupt[id];
        assert.ok(r.root && r.pose, id + ': an intro cut short leaves nothing behind (root ' + r.root + ', pose ' + r.pose + ')');
        assert.ok(r.differs, id + ': (the intro does move the figure, so the comparison means something)');
    }
    for (const id of agents) {
        const r = reg.res[id], m = motion.interrupt[id];
        matrix(id, 'intro <= 1.4 s and interruptible', r.introMs <= 1400 && m.root && m.pose, r.intro + ' ' + r.introMs + ' ms; idle after a cut intro equals a fresh idle');
    }
    // one head-snap schedule: every interval between snaps inside idle.tic.every [4, 6] s (+-1 sample), the loop included
    const st = motion.snaps.starts, gaps = st.slice(1).map((t, i) => t - st[i]);
    console.log('# omen head snaps in 300 s:', st.length, '| intervals', Math.min(...gaps).toFixed(2), '-', Math.max(...gaps).toFixed(2), 's (tic.every ' + motion.snaps.every.join('-') + ')');
    assert.ok(st.length >= 300 / motion.snaps.every[1] - 1 && st.length <= 300 / motion.snaps.every[0] + 1, 'Omen snaps his head ' + st.length + ' times in 300 s');
    assert.deepEqual(gaps.filter((g) => g < motion.snaps.every[0] - 0.021 || g > motion.snaps.every[1] + 0.021).map((g) => +g.toFixed(3)), [], 'every snap interval inside idle.tic.every: one schedule');
    // the finger flex: the right hand leaves clawLow for about 150 ms every 5-8 s; the left hand never flexes
    // (a flex already under way at t = 0 is cut by the window: it is not counted)
    const fx = motion.flex.flex.filter((f) => f[0] > 0), fgaps = fx.slice(1).map((f, i) => f[0] - fx[i][0]), fdur = fx.filter((f) => f.length > 2).map((f) => f[2] - f[0]);
    console.log('# omen finger flexes in 300 s:', fx.length, '(' + [...new Set(fx.map((f) => f[1]))].join(', ') + ') | intervals', Math.min(...fgaps).toFixed(2), '-', Math.max(...fgaps).toFixed(2), 's | lengths', Math.min(...fdur).toFixed(2), '-', Math.max(...fdur).toFixed(2), 's');
    assert.ok(fx.length >= 300 / 8 - 1 && fx.every((f) => f[1] === 'relaxed'), 'Omen\'s right hand flexes to relaxed on its schedule: ' + fx.length);
    assert.deepEqual(fgaps.filter((g) => g < 5 - 0.021 || g > 8 + 0.021), [], 'flex intervals in [5, 8] s');
    assert.ok(fdur.every((d) => d >= 0.13 && d <= 0.17), 'each flex lasts about 150 ms');
    assert.equal(motion.flex.flexL, 0, 'the left hand keeps its idle shape');

    // ---- seams and clearances on the show LODs' primitives (no coincident or grazing shells) ---------------------------
    const seams = await evaluate(() => {
        const R0 = V23.parts.rig().rest, out = { problems: [], pairs: 0, checked: {} };
        const bad = (id, what) => out.problems.push(id + ': ' + what);
        const S1 = new THREE.Vector3(1, 1, 1);
        // a primitive's frame (position and rotation; non-uniformly scaled primitives are left out of the cylinder pairs)
        const frame = (s) => new THREE.Matrix4().compose(new THREE.Vector3(s.at[0], s.at[1], s.at[2]),
            new THREE.Quaternion().setFromEuler(new THREE.Euler(s.rot ? s.rot[0] : 0, s.rot ? s.rot[1] : 0, s.rot ? s.rot[2] : 0, s.order || 'XYZ')), S1);
        const axisOf = (s) => new THREE.Vector3(0, 1, 0).transformDirection(frame(s));
        const keyOf = (s) => (s.node !== undefined && s.node !== null ? 'n:' + s.node : 'b' + (s.bone === undefined ? 0 : s.bone));
        const uniform = (s) => !s.scl || s.scl.every((v) => Math.abs(v - 1) < 1e-9);
        for (const id of AGENT_ORDER) {
            const look = V23.core.resolve(id), X = V23.parts._prims(look, 'show'), P = X.prims;
            const done = [];
            if (X.nodeCount !== X.nodes.length) bad(id, 'node count from the entry ' + X.nodeCount + ' != ' + X.nodes.length);
            // (1) coaxial cylinders on one node: at least 6 mm apart (less any tilt) where they overlap, and facing caps of
            // cylinders that do not overlap at least 3 mm apart across the whole cap
            const cyl = P.filter((s) => s.prim === 'cyl' && uniform(s));
            for (let i = 0; i < cyl.length; i++) for (let j = i + 1; j < cyl.length; j++) {
                const a = cyl[i], b = cyl[j];
                if (keyOf(a) !== keyOf(b)) continue;
                const ua = axisOf(a), dot = ua.dot(axisOf(b));
                if (Math.abs(dot) < 0.999) continue;
                const d = new THREE.Vector3(b.at[0] - a.at[0], b.at[1] - a.at[1], b.at[2] - a.at[2]), along = d.dot(ua);
                if (d.clone().sub(ua.clone().multiplyScalar(along)).length() > 0.004) continue;
                out.pairs++;
                const ha = a.size[2] / 2, hb = b.size[2] / 2, sg = dot > 0 ? 1 : -1;
                const rA = (y) => a.size[1] + (a.size[0] - a.size[1]) * (y + ha) / (2 * ha);
                const rB = (y) => { const yb = (y - along) * sg; return b.size[1] + (b.size[0] - b.size[1]) * (yb + hb) / (2 * hb); };
                const lo = Math.max(-ha, along - hb), hi = Math.min(ha, along + hb), ov = hi - lo;
                const tilt = Math.sqrt(Math.max(0, 1 - dot * dot)), rmax = Math.max(a.size[0], a.size[1], b.size[0], b.size[1]);
                if (ov > 0.002) {
                    const dr = Math.min(Math.abs(rA(lo) - rB(lo)), Math.abs(rA(hi) - rB(hi)));
                    if (dr - rmax * tilt < 0.006) bad(id, 'coaxial cylinders on ' + keyOf(a) + ' only ' + (dr * 1000).toFixed(1) + ' mm apart over ' + (ov * 1000).toFixed(1) + ' mm');
                } else if (!a.open && !b.open && -ov - 2 * rmax * tilt < 0.003) bad(id, 'stacked caps on ' + keyOf(a) + ' ' + (-ov * 1000).toFixed(1) + ' mm apart, tilted ' + tilt.toFixed(3));
            }
            done.push('cylinders');
            // (2) each arm: a capsule (the dome on the sleeve's axis at its top end, the same radius and columns) and, unless a
            // rolled sleeve's roll covers it, an elbow of two shells on the pivot: a hemisphere coaxial with the upper arm and
            // in phase with it, 9 mm or more proud of both limb ends, and a whole ball inside it, coaxial with the forearm
            const near = (s, p) => new THREE.Vector3(...s.at).distanceTo(new THREE.Vector3(p[0], p[1], p[2])) < 1e-6;
            for (const side of ['R', 'L']) {
                const up = side === 'R' ? 3 : 5, fo = up + 1, el = side === 'R' ? R0.elbowR : R0.elbowL;
                const arm = P.filter((s) => s.prim === 'cyl' && s.bone === up && s.node === undefined).sort((x, y) => y.size[2] - x.size[2])[0];
                const fore = P.filter((s) => s.prim === 'cyl' && s.bone === fo && s.node === undefined && !s.hand).sort((x, y) => y.size[2] - x.size[2])[0];
                const top = new THREE.Vector3(0, arm.size[2] / 2, 0).applyMatrix4(frame(arm));
                const dome = P.find((s) => s.prim === 'sph' && s.bone === up && s.hemi === 0.5 && near(s, top.toArray()));
                if (!dome) bad(id, side + ': no capsule dome on the sleeve\'s top end');
                else if (Math.abs(dome.size[0] - arm.size[0]) > 1e-9 || dome.seg[0] !== arm.seg || axisOf(dome).dot(axisOf(arm)) < 0.999999) bad(id, side + ': the capsule dome does not share the sleeve\'s end ring');
                const upper = P.find((s) => s.prim === 'sph' && s.bone === up && s.hemi === 0.5 && near(s, el));
                const ball = P.find((s) => s.prim === 'sph' && !s.hemi && s.bone === fo && near(s, el));
                if (X.flags.rolled) { if (upper || ball) bad(id, side + ': an elbow joint under a rolled sleeve'); }
                else if (!upper || !ball) bad(id, side + ': the elbow joint is missing a shell');
                else {
                    const proud = upper.size[0] - Math.max(arm.size[1], fore.size[0]);
                    if (proud < 0.009) bad(id, side + ': the elbow is only ' + (proud * 1000).toFixed(1) + ' mm proud of the limbs');
                    if (upper.seg[0] !== arm.seg || axisOf(upper).dot(axisOf(arm)) < 0.999999) bad(id, side + ': the elbow hemisphere is not coaxial and in phase with the upper arm');
                    if (ball.seg[0] !== fore.seg || axisOf(ball).dot(axisOf(fore)) < 0.999999) bad(id, side + ': the elbow ball is not coaxial and in phase with the forearm');
                    if (!(ball.size[0] < upper.size[0] && ball.size[0] >= fore.size[0] + 0.009 && ball.size[0] > arm.size[1] + 0.004)) bad(id, side + ': the forearm ball does not sit inside the hemisphere and proud of both limbs');
                }
                // (3) a shoulder cap (an open dome on the upper arm) clears the capsule everywhere by 6 mm
                for (const cap of P.filter((s) => s.prim === 'sph' && s.bone === up && s.hemi > 0.5 && s.hemi < 1)) {
                    const F = frame(cap), a = new THREE.Vector3(...el), b = top, ab = b.clone().sub(a), L2 = ab.lengthSq();
                    let min = 1e9;
                    for (let j = 0; j <= 24; j++) for (let k = 0; k < 48; k++) {
                        const th = Math.PI * cap.hemi * j / 24, ph = k / 48 * Math.PI * 2;
                        const q = new THREE.Vector3(-Math.cos(ph) * Math.sin(th) * cap.size[0], Math.cos(th) * cap.size[1], Math.sin(ph) * Math.sin(th) * cap.size[2]).applyMatrix4(F);
                        const t = Math.max(0, Math.min(1, q.clone().sub(a).dot(ab) / L2));
                        const dist = q.distanceTo(a.clone().add(ab.clone().multiplyScalar(t))) - (arm.size[1] + (arm.size[0] - arm.size[1]) * t);
                        if (dist < min) min = dist;
                    }
                    if (min < 0.006) bad(id, side + ': the shoulder cap comes within ' + (min * 1000).toFixed(1) + ' mm of the sleeve');
                    (out.checked.cap = out.checked.cap || []).push(id + ' ' + (min * 1000).toFixed(1));
                }
            }
            done.push('arms');
            // (4) the pelvis floor holds both thighs' cross-sections with a centimetre to spare (rest pose)
            const pel = P.find((s) => s.prim === 'lathe' && s.bone === 0), fy = pel.pts[1][1], Rx = pel.pts[1][0], Rz = Rx * (pel.scl ? pel.scl[2] : 1);
            for (const bone of [9, 11]) {
                const th = P.filter((s) => s.prim === 'cyl' && s.bone === bone).sort((x, y) => y.size[2] - x.size[2])[0];
                const F = frame(th), h = th.size[2], u = axisOf(th), c0 = new THREE.Vector3(...th.at);
                const t = (fy - c0.y) / u.y, c = c0.clone().add(u.clone().multiplyScalar(t)), r = th.size[1] + (th.size[0] - th.size[1]) * (t + h / 2) / h;
                let worst = 1e9;
                for (let k = 0; k < 64; k++) {
                    const a = k / 64 * Math.PI * 2, qx = c.x + Math.cos(a) * r / Math.abs(u.y), qz = c.z + Math.sin(a) * r;
                    // the gap to the floor's rim along the ray from the pelvis's centre through the point
                    const e = Math.sqrt((qx / Rx) * (qx / Rx) + (qz / Rz) * (qz / Rz));
                    worst = Math.min(worst, (1 - e) * Math.hypot(qx, qz) / e);
                }
                if (worst < 0.01) bad(id, 'thigh ' + bone + ' passes the pelvis floor only ' + (worst * 1000).toFixed(1) + ' mm inside its rim');
                (out.checked.floor = out.checked.floor || []).push(id + ' ' + (worst * 1000).toFixed(1));
            }
            done.push('pelvis');
            out.checked[id] = done;
        }
        // (5) Omen's rift key, in his right forearm's frame (where it orbits), stays 1.5 cm or more outside every vertex of
        // the forearm mesh and the right hand, over the idle, the intro, the lock-in, the MVP pose and every slot clip
        const root = V23.core.build('omen', 'show'), v = root.userData.v23, fo = v.bones[4], hand = v.nodes.handR, prop = v.nodes.prop;
        const inv = new THREE.Matrix4(), m = new THREE.Matrix4(), p = new THREE.Vector3();
        const ext = (mesh, into) => { m.multiplyMatrices(inv, mesh.matrixWorld); const a = mesh.geometry.attributes.position; for (let i = 0; i < a.count; i++) { p.fromBufferAttribute(a, i).applyMatrix4(m); if (p.x < into[0]) into[0] = p.x; if (p.x > into[1]) into[1] = p.x; } };
        let gap = 1e9, samples = 0;
        for (const clip of ['idle', 'intro', 'lockIn', 'mvp', 'c', 'q', 'e', 'x']) for (let t = 0; t < 6; t += 0.05) {
            V23.motion.sample('omen', clip, t, root);
            root.updateMatrixWorld(true);
            inv.copy(fo.matrixWorld).invert();
            const k = [1e9, -1e9], h = [1e9, -1e9];
            ext(prop, k); ext(hand, h); ext(fo, h);
            gap = Math.min(gap, k[0] - h[1]);
            samples++;
        }
        V23.motion.sample('omen', 'idle', 0, root);
        out.key = { parent: prop.parent === fo, gap, samples };
        return out;
    });
    console.log('# seams: ' + seams.pairs + ' coaxial cylinder pairs checked; shoulder caps clear by (mm)', (seams.checked.cap || []).join(', '), '| pelvis floor margins (mm)',
        [...new Set((seams.checked.floor || []).map((s) => s.split(' ')[1]))].join(', '), '| rift key gap', (seams.key.gap * 1000).toFixed(1), 'mm over', seams.key.samples, 'samples');
    assert.deepEqual(seams.problems, [], 'no coincident or grazing shells, capsule shoulders, elbow balls, cap and floor clearances');
    for (const id of reg.order) assert.deepEqual(seams.checked[id], ['cylinders', 'arms', 'pelvis'], id + ': seam checks ran');
    assert.ok(seams.key.parent, 'Omen\'s rift key rides his right forearm');
    assert.ok(seams.key.gap >= 0.015, 'the rift key stays 1.5 cm or more off the right hand and forearm in every clip: ' + (seams.key.gap * 1000).toFixed(1) + ' mm');

    // ---- V23.motion.sample allocates nothing once warm (design 15: no per-frame allocation in V23 update paths) ----------
    // The sampling heap profiler (64-byte interval, collected objects kept) attributes every JS heap allocation to its call
    // stack. A control run (a fresh pose per call) shows the probe sees allocations under V23.motion.sample; then 9,000
    // samples of idles, intros, gestures, lock-ins, tics and MVP poses into reused poses must allocate less than a byte
    // per 2 samples there (one 16-byte object per call would be 8 bytes per sample; what remains is one-time JIT data).
    const cdp = await page.context().newCDPSession(page);
    const sampleBatch = (n, reuse) => evaluate(([n, reuse]) => {
        const ids = ['sage', 'omen', 'jett', 'killjoy'], clips = ['idle', 'intro', 'c', 'q', 'e', 'x', 'lockIn', 'mvp', 'tic:checkAmpoule'];
        const roots = ids.map((id) => V23.core.build(id, 'show'));
        let k = 0;
        for (let i = 0; i < n; i++) for (let a = 0; a < ids.length; a++) { V23.motion.sample(ids[a], clips[i % clips.length], (i % 97) * 0.017, reuse ? roots[a] : null); k++; }
        return k;
    }, [n, reuse]);
    // V23.motion.sample by its line in the page (perfTelemetry has a 'sample' too); profile lines are 0-based
    const srcLines = fs.readFileSync(GAME_FILE, 'utf8').split('\n');
    const sampleLine = srcLines.findIndex((l) => /^\s*sample: function \(agentId, clip, t, out\) \{/.test(l));
    assert.ok(sampleLine > 0, 'V23.motion.sample found in the source');
    const profiled = async (n, reuse) => {
        await cdp.send('HeapProfiler.enable');
        await cdp.send('HeapProfiler.startSampling', { samplingInterval: 64, includeObjectsCollectedByMinorGC: true, includeObjectsCollectedByMajorGC: true });
        const count = await sampleBatch(n, reuse);
        const { profile } = await cdp.send('HeapProfiler.stopSampling');
        await cdp.send('HeapProfiler.disable');
        let under = 0, total = 0;
        const sites = {};
        const walk = (node, inSample) => {
            const here = inSample || (node.callFrame.functionName === 'sample' && node.callFrame.lineNumber === sampleLine);
            const bytes = node.selfSize || 0;
            total += bytes;
            if (here && bytes) { under += bytes; const k = node.callFrame.functionName + ':' + (node.callFrame.lineNumber + 1); sites[k] = (sites[k] || 0) + bytes; }
            for (const c of node.children || []) walk(c, here);
        };
        walk(profile.head, false);
        return { count, under, total, sites };
    };
    // the control first: a fresh pose per call allocates under sample, and the profile sees it (the probe can fail)
    await sampleBatch(300, false);
    const control = await profiled(300, false);
    // then warm the reuse path again (ending a profiler session drops optimized code, and unoptimized frames box their
    // doubles: VM allocations that optimized code does not make), and measure
    await sampleBatch(5000, true);
    const steady = await profiled(2250, true);
    console.log('# heap: control (new pose each call)', control.count, 'samples,', control.under, 'bytes under V23.motion.sample | reused poses', steady.count, 'samples,',
        steady.under, 'bytes', JSON.stringify(steady.sites), '(all sampled allocations', steady.total, 'bytes)');
    assert.ok(control.under > 50 * control.count, 'the heap probe attributes a fresh pose\'s allocations to V23.motion.sample: ' + control.under + ' bytes');
    assert.ok(steady.under < 0.5 * steady.count, 'V23.motion.sample allocates nothing per call once warm: ' + steady.under + ' bytes over ' + steady.count + ' samples ' + JSON.stringify(steady.sites));

    const kitBudget = { low: 600, medium: 1100, high: 2400, ultra: 3000 };
    for (const k of builds.kit) {
        assert.ok(k.v <= kitBudget[k.tier], `kit superset ${k.tier}: ${k.v} vertices <= ${kitBudget[k.tier]}`);
        assert.ok(k.again, `kit superset ${k.tier} is cached`);
    }
    // design 3.4: kit modules at most 48 vertices each (the Medium tier, boxes and the halo's half torus)
    const medium = builds.kit.find((k) => k.tier === 'medium');
    assert.deepEqual(medium.modules.filter(([, v]) => v > 48), [], 'every Medium kit module has at most 48 vertices');
    console.log('# Medium kit module vertices:', medium.modules.map(([n, v]) => n + ' ' + v).join(', '));

    // ---- kit modules inside the union hit volume +0.03 m at every archetype scale --------------------------------------
    const kitData = await evaluate(() => ['low', 'medium', 'high', 'ultra'].map((t) => {
        const g = V23.parts.kitSuperset(t);
        return { tier: t, p: Array.from(g.attributes.position.array), uv: Array.from(g.attributes.uv.array), bone: Array.from(g.attributes.aBone.array), idx: Array.from(g.index.array) };
    }));
    const scales = await evaluate(() => Object.values(ENEMY_ARCHETYPES).map((a) => [a.id, a.scale.x, a.scale.y, a.scale.z]));
    // the page's own template bounds agree with the boxes read from the source (Low is this machine's content tier)
    const tplLow = await evaluate(() => CONTENT.detailedModels ? null : ['enemyTorso', 'enemyLegs', 'enemyHead'].map((k) => { const g = actorTemplates[k]; g.computeBoundingBox(); return [g.boundingBox.min.toArray(), g.boundingBox.max.toArray()]; }));
    if (tplLow) {
        const ext = (list) => [0, 1, 2].map((a) => [Math.min(...list.map((b) => b.c[a] - b.h[a])), Math.max(...list.map((b) => b.c[a] + b.h[a]))]);
        const torso = ext(boxes.low.slice(0, 2)), legs = ext([boxes.low[2]]), head = ext([boxes.low[3]]);
        for (const [i, e] of [torso, legs, head].entries()) for (let a = 0; a < 3; a++) {
            assert.ok(Math.abs(tplLow[i][0][a] - e[a][0]) < 1e-4 && Math.abs(tplLow[i][1][a] - e[a][1]) < 1e-4, 'the Low hit boxes match actorTemplates');
        }
    }
    const MARGIN = 0.03;
    const outside = {};
    const inside = (q, list, s) => list.some((b) => Math.abs(q[0] - b.c[0] * s[0]) <= b.h[0] * s[0] + MARGIN + 1e-6 && Math.abs(q[1] - b.c[1] * s[1]) <= b.h[1] * s[1] + MARGIN + 1e-6 && Math.abs(q[2] - b.c[2] * s[2]) <= b.h[2] * s[2] + MARGIN + 1e-6);
    const modulesSeen = {};
    for (const k of kitData) {
        const list = k.tier === 'low' ? boxes.low : boxes.detailed;
        const n = k.p.length / 3;
        const mod = (i) => Math.round(k.uv[i * 2]) - 2;
        // every vertex and every triangle centroid
        const pts = [];
        for (let i = 0; i < n; i++) pts.push([k.p[i * 3], k.p[i * 3 + 1], k.p[i * 3 + 2], mod(i)]);
        for (let t = 0; t < k.idx.length; t += 3) {
            const a = k.idx[t], b = k.idx[t + 1], c = k.idx[t + 2];
            pts.push([(k.p[a * 3] + k.p[b * 3] + k.p[c * 3]) / 3, (k.p[a * 3 + 1] + k.p[b * 3 + 1] + k.p[c * 3 + 1]) / 3, (k.p[a * 3 + 2] + k.p[b * 3 + 2] + k.p[c * 3 + 2]) / 3, mod(a)]);
        }
        for (const [aid, sx, sy, sz] of scales) for (const q of pts) {
            (modulesSeen[k.tier] = modulesSeen[k.tier] || new Set()).add(q[3]);
            if (!inside([q[0] * sx, q[1] * sy, q[2] * sz], list, [sx, sy, sz])) (outside[k.tier + '/' + aid + '/' + q[3]] = outside[k.tier + '/' + aid + '/' + q[3]] || []).push(q.slice(0, 3).map((v) => +v.toFixed(3)));
        }
        // uv.y is a zone (0, 1 or 2); aBone a kit bone (head 2, back 1, shoulders 3 / 5, orb 4, tails 0)
        for (let i = 0; i < n; i++) { assert.ok([0, 1, 2].indexOf(Math.round(k.uv[i * 2 + 1])) >= 0, 'zone'); assert.ok([0, 1, 2, 3, 4, 5].indexOf(k.bone[i]) >= 0, 'bone'); }
    }
    assert.deepEqual(Object.keys(outside).map((k) => k + ' ' + JSON.stringify(outside[k].slice(0, 2))), [], 'every kit point inside the union hit volume + 0.03 m at every archetype scale');
    assert.equal(modulesSeen.medium.size, 24, 'Medium holds all 24 modules');
    assert.equal(modulesSeen.low.size, 12, 'Low holds 12 modules');
    for (const id of agents) matrix(id, 'bot pool and kit inside the hit volume (all tiers)', true, reg.res[id].pool + ' [' + reg.res[id].kit.join(', ') + '] + orb');

    // ---- the staged builder: never in unpaused combat; steps in the menu -----------------------------------------------
    const staged = await evaluate(() => {
        const out = {};
        V23.core.onAgentChanged('jett');   // re-queues jett's world and show LODs if missing (they are built: nothing to do)
        // unpaused combat: menu closed, picker closed, alive, no killcam
        mainMenu.hide();
        out.combat = { open: mainMenu.open, picker: game.agentPickerOpen, paused: mainMenu.paused(), allowed: V23.core.stats.allowed };
        const q0 = V23.core.stats.queue.length, s0 = V23.core.stats.steps;
        let any = false;
        for (let i = 0; i < 200; i++) any = V23.core.stagedStep(3) || any;
        out.combatStepped = any || V23.core.stats.steps !== s0;
        out.queueKept = V23.core.stats.queue.length === q0;
        out.q0 = q0;
        return out;
    });
    assert.ok(!staged.combat.open && !staged.combat.picker && !staged.combat.paused && !staged.combat.allowed, 'live combat: no menu, no picker, not paused');
    assert.ok(!staged.combatStepped, 'the staged builder never steps in unpaused combat');
    assert.ok(staged.queueKept, 'and leaves its queue alone');
    // a look redefined after it was built (in combat): its old LODs go back to the pool, show and world are queued, nothing
    // builds there; the menu then builds them
    const staged2 = await evaluate(() => {
        const out = {};
        const old = { show: V23.core.build('miks', 'show'), world: V23.core.build('miks', 'world') };
        const oldInfo = old.show.userData.v23;
        const released0 = V23.parts.stats.released;
        V23.core.define('miks', JSON.parse(JSON.stringify(AGENT_LOOKS.miks)));
        out.queued = ['miks|show', 'miks|world'].map((k) => V23.core.stats.queue.indexOf(k) >= 0);
        out.released = V23.parts.stats.released - released0;
        out.oldGone = !old.show.userData.v23 && !old.world.userData.v23;
        out.combat = V23.core.stagedStep(3);
        mainMenu.show('pause');
        out.allowed = V23.core.stats.allowed;
        let n = 0;
        for (let i = 0; i < 400 && (V23.core.stats.queue.length || V23.core.stats.job); i++) if (V23.core.stagedStep(3)) n++;
        out.steps = n;
        out.left = V23.core.stats.queue.length;
        out.built = V23.core.stats.built.miks || [];
        // (the pool may hand the same Group back: a fresh build has a fresh figure record)
        out.fresh = V23.core.build('miks', 'show').userData.v23 !== oldInfo;
        return out;
    });
    assert.deepEqual(staged2.queued, [true, true], 'define() after a build queues both the show and the world LOD');
    assert.equal(staged2.released, 2, 'and gives both old LODs back to the pool');
    assert.ok(staged2.oldGone, 'the old roots are emptied');
    assert.ok(!staged2.combat, 'nothing builds in combat');
    assert.ok(staged2.allowed && staged2.steps >= 1 && staged2.left === 0, 'the menu runs the staged builder through its queue');
    assert.ok(staged2.built.includes('show') && staged2.built.includes('world') && staged2.fresh, 'miks has fresh show and world LODs');

    // the per-frame budget (design 2.5): a figure is built as units over several frames, and a frame starts a unit only
    // while its spend is under the budget (so it overruns by at most its last unit); a tight budget makes it visible
    const staged3 = await evaluate(() => {
        for (const id of ['sage', 'omen']) V23.core.define(id, JSON.parse(JSON.stringify(AGENT_LOOKS[id])));
        const q0 = V23.core.stats.queue.slice();
        const log = [];
        const BUDGET = 0.5;
        for (let i = 0; i < 2000 && (V23.core.stats.queue.length || V23.core.stats.job); i++) { V23.core.stagedStep(BUDGET); log.push(Object.assign({}, V23.core.stats.lastStep)); }
        const perKey = {};
        for (const l of log) perKey[l.key] = (perKey[l.key] || 0) + 1;
        return { q0, budget: BUDGET, steps: log.length, perKey, maxMs: Math.max(...log.map((l) => l.ms)), maxUnit: Math.max(...log.map((l) => l.maxUnitMs)),
            lateStarts: log.filter((l) => l.units > 1 && l.beforeLast >= l.budget).length, empty: log.filter((l) => l.units < 1).length,
            left: V23.core.stats.queue.length, job: V23.core.stats.job, built: ['sage', 'omen'].map((id) => (V23.core.stats.built[id] || []).slice().sort().join()) };
    });
    console.log('# staged builder at', staged3.budget, 'ms per frame:', staged3.steps, 'frames for', JSON.stringify(staged3.perKey), '| longest frame', staged3.maxMs.toFixed(2), 'ms, longest unit', staged3.maxUnit.toFixed(2), 'ms');
    assert.deepEqual(staged3.q0.slice().sort(), ['omen|show', 'omen|world', 'sage|show', 'sage|world'], 'redefining Sage and Omen queued both tiers of each');
    assert.equal(staged3.lateStarts, 0, 'no frame starts a unit once its budget is spent');
    assert.equal(staged3.empty, 0, 'every frame makes progress');
    assert.ok(staged3.perKey['sage|show'] >= 3 && staged3.perKey['omen|show'] >= 3, 'each show LOD is spread over several frames: ' + JSON.stringify(staged3.perKey));
    assert.ok(staged3.maxMs <= staged3.budget + staged3.maxUnit + 0.5, 'a frame spends at most its budget plus one unit');
    assert.ok(staged3.left === 0 && !staged3.job && staged3.built.every((b) => b === 'show,world'), 'Sage and Omen rebuilt');

    // ---- programs: upload-draw every LOD, then draw each with its own materials where the game draws it ----------------
    // show (the stage: the viewmodel's light set) in every hand pose; world and body (the killcam ghost, the prototypes:
    // the game scene). The body LOD of every agent is built with V23.parts.figure, drawn and given back to the pool.
    const prog = await evaluate(() => {
        const before = [renderer.info.programs.length, perfTelemetry.programWatermark, perfTelemetry.firstUseStalls];
        const tgt = new THREE.WebGLRenderTarget(64, 64);
        tgt.texture.encoding = THREE.sRGBEncoding;
        const prev = renderer.getRenderTarget();
        let uploads = 0, poseDraws = 0;
        const body = {};
        camera.updateMatrixWorld();
        const ahead = new THREE.Vector3(0, 0, -4).applyMatrix4(camera.matrixWorld);
        const inScene = (root) => { scene.add(root); root.position.copy(ahead); renderer.render(scene, camera); scene.remove(root); root.position.set(0, 0, 0); };
        const m0 = V23.parts.stats.poolMisses;
        for (const id of AGENT_ORDER) for (const tier of ['show', 'world', 'body']) {
            const root = tier === 'body' ? V23.parts.figure(V23.core.resolve(id), 'body') : V23.core.build(id, tier);
            if (V23.core.uploadDraw(root)) uploads++;
            renderer.setRenderTarget(tgt);
            if (tier === 'show') {
                // the stage: exactly the viewmodel's light set and environment, once per hand pose
                const H = root.userData.v23.hands;
                viewmodelScene.add(root);
                for (const pose of V23.motion.HAND_POSES) { H.R.geometry = H.set.geoms[pose]; H.L.geometry = H.set.geoms[pose]; renderer.render(viewmodelScene, viewmodelCamera); poseDraws++; }
                viewmodelScene.remove(root);
                V23.motion.sample(id, 'idle', 0, root);
            } else inScene(root);
            renderer.setRenderTarget(prev);
            if (tier === 'body') {
                const v = root.userData.v23;
                let meshes = 0;
                root.traverse((o) => { if (o.isMesh && o.geometry.groups.length) meshes++; });
                body[id] = { draws: v.stats.draws, meshes: meshes, vertices: v.stats.vertices, released: V23.parts._release(root) };
            }
        }
        tgt.dispose();
        return { before, uploads, poseDraws, body, misses: V23.parts.stats.poolMisses - m0, after: [renderer.info.programs.length, perfTelemetry.programWatermark, perfTelemetry.firstUseStalls] };
    });
    await frames(10);
    const [programs, watermark, stalls] = await programState(page);
    console.log('# programs before', prog.before.join('/'), 'after', prog.after.join('/'), 'uploads', prog.uploads, 'hand-pose draws', prog.poseDraws, '| V2.2', v22.join('/'));
    console.log('# body LODs (draws/meshes/vertices): sage', JSON.stringify(prog.body.sage), 'omen', JSON.stringify(prog.body.omen));
    assert.equal(prog.uploads, 3 * reg.order.length, 'every LOD of every agent (show, world, body) was upload-drawn');
    for (const id of reg.order) {
        const b = prog.body[id];
        assert.ok(b.draws <= 36 && b.meshes <= 36, `${id} body LOD ${b.draws} draws, ${b.meshes} meshes <= 36`);
        assert.ok(b.released, `${id} body LOD released`);
    }
    assert.equal(prog.misses, 0, 'the body LODs came from the pool and went back');
    assert.equal(prog.after[0], prog.before[0], 'drawing every LOD in every hand pose made no program');
    assert.equal(programs, watermark, 'programs == watermark');
    assert.equal(watermark, v22[1], 'the watermark is V2.2\'s');
    assert.equal(programs, v22[0], 'and so is the program count after every LOD was drawn');
    assert.equal(stalls, 0, 'no first-use stalls');
    for (const id of agents) matrix(id, 'programs == watermark == V2.2, 0 stalls', programs === watermark && watermark === v22[1] && stalls === 0, `${programs}/${watermark} (V2.2 ${v22[1]}), stalls ${stalls}`);

    // ---- silhouettes (64 x 64 masks, front and 3/4) and idle vectors between full entries; info for the rest -----------
    const sil = await evaluate((ids) => {
        const S = 64, tgt = new THREE.WebGLRenderTarget(S, S), px = new Uint8Array(S * S * 4), cam = new THREE.PerspectiveCamera(30, 1, 0.1, 30);
        const prev = renderer.getRenderTarget(), masks = {};
        const hidden = viewmodelScene.children.filter((c) => !c.isLight && c.visible);
        for (const c of hidden) c.visible = false;
        for (const id of ids) {
            const root = V23.core.build(id, 'show');
            V23.motion.sample(id, 'stance', 0, root);
            const holder = new THREE.Group();
            holder.add(root);
            viewmodelScene.add(holder);
            masks[id] = [];
            for (const yaw of [0, -Math.PI / 4]) {
                holder.rotation.y = yaw;
                cam.position.set(0, 1.1, -7.2); cam.lookAt(0, 1.1, 0);
                renderer.setRenderTarget(tgt);
                renderer.setClearColor(0x000000, 0);
                renderer.clear(true, true, true);
                renderer.render(viewmodelScene, cam);
                renderer.readRenderTargetPixels(tgt, 0, 0, S, S, px);
                const m = [];
                for (let i = 0; i < S * S; i++) m.push(px[i * 4 + 3] > 0 ? 1 : 0);
                masks[id].push(m);
            }
            holder.remove(root);
            viewmodelScene.remove(holder);
        }
        renderer.setRenderTarget(prev);
        for (const c of hidden) c.visible = true;
        tgt.dispose();
        // idle feature vectors: 6 s of the 13 bones' angles at 10 Hz: the mean and spread of each channel and its mean speed
        const feats = {};
        for (const id of ids) {
            const rows = [];
            let pose = null;
            for (let k = 0; k < 60; k++) { pose = V23.motion.sample(id, 'idle', k / 10, pose); rows.push(Array.from(pose.bones).concat(Array.from(pose.root))); }
            const f = [];
            for (let c = 0; c < rows[0].length; c++) {
                const col = rows.map((r) => r[c]);
                const mean = col.reduce((a, b) => a + b, 0) / col.length;
                const sd = Math.sqrt(col.reduce((a, b) => a + (b - mean) * (b - mean), 0) / col.length);
                let sp = 0;
                for (let k = 1; k < col.length; k++) sp += Math.abs(col[k] - col[k - 1]);
                f.push(mean, sd * 4, sp / col.length * 10);
            }
            feats[id] = f;
        }
        return { masks, feats, roles: ids.map((id) => [id, AGENT_DEFS[id].role, V23.core.resolve(id).stub]) };
    }, reg.order);
    const iou = (a, b) => { let i = 0, u = 0; for (let k = 0; k < a.length; k++) { if (a[k] || b[k]) u++; if (a[k] && b[k]) i++; } return u ? i / u : 1; };
    const dist = (a, b) => Math.sqrt(a.reduce((s, v, i) => s + (v - b[i]) * (v - b[i]), 0));
    const roleOf = Object.fromEntries(sil.roles.map(([id, r, stub]) => [id, { r, stub }]));
    const IDLE_MIN = 0.15;
    for (const id of agents) {
        // the most similar same-role agent (info for stubs: they are their role's default by construction)
        let worst = 0, worstId = null;
        for (const o of reg.order) {
            if (o === id || roleOf[o].r !== roleOf[id].r) continue;
            const v = Math.max(iou(sil.masks[id][0], sil.masks[o][0]), iou(sil.masks[id][1], sil.masks[o][1]));
            if (!roleOf[o].stub && v > worst) { worst = v; worstId = o; }
        }
        matrix(id, 'distinct silhouette (mask IoU <= 0.9 vs same role)', roleOf[id].stub ? false : worst <= 0.9, roleOf[id].stub ? 'stub' : (worstId ? `max IoU ${worst.toFixed(3)} vs ${worstId}` : 'no other full entry in ' + roleOf[id].r));
        let near = 1e9, nearId = null;
        for (const o of reg.order) { if (o === id || roleOf[o].stub) continue; const d = dist(sil.feats[id], sil.feats[o]); if (d < near) { near = d; nearId = o; } }
        matrix(id, 'distinct idle (feature-vector distance)', roleOf[id].stub ? false : near >= IDLE_MIN, roleOf[id].stub ? 'stub' : `nearest ${nearId} at ${near.toFixed(3)}`);
    }
    // between full entries: same role IoU <= 0.9, and every pair's idles at least IDLE_MIN apart
    const fullIds = reg.order.filter((id) => !roleOf[id].stub);
    for (let i = 0; i < fullIds.length; i++) for (let j = i + 1; j < fullIds.length; j++) {
        const a = fullIds[i], b = fullIds[j];
        const v = [0, 1].map((k) => iou(sil.masks[a][k], sil.masks[b][k]));
        console.log(`# silhouette IoU ${a}/${b}: front ${v[0].toFixed(3)}, 3/4 ${v[1].toFixed(3)}; idle distance ${dist(sil.feats[a], sil.feats[b]).toFixed(3)}`);
        if (roleOf[a].r === roleOf[b].r) assert.ok(Math.max(...v) <= 0.9, `${a}/${b} silhouettes IoU <= 0.9`);
        assert.ok(dist(sil.feats[a], sil.feats[b]) >= IDLE_MIN, `${a}/${b} idles differ`);
    }
    assert.deepEqual(errors, []);
});
