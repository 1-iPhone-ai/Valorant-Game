'use strict';
// V2.3 agent roster (design 17.1, WP2): one boot with the start screen open (the sim is paused), data-driven by
// AGENT_ORDER (ROLE=<role> narrows the per-agent rows). Checks:
//  - the roster sets are equal: AGENT_ORDER, AGENT_DEFS and AGENT_LOOKS hold the same 29 ids;
//  - every entry resolves; the full entries (Sage and Omen at M1) pass the whole lint and the validator reports nothing;
//    the stubs are flagged; deliberately broken entries are rejected and leave the registry as it was;
//  - builds are deterministic (the geometry hash of a second, fresh build equals the first) and make no Math.random call
//    once the object pool exists (a counting wrapper around Math.random);
//  - show LODs within 7,000 vertices and 36 draws, world LODs within 6 meshes;
//  - every kit module of every tier inside the union hit volume +0.03 m at every archetype scale;
//  - the staged builder never steps in unpaused combat, and steps in the menu;
//  - after building and upload-drawing every LOD of every agent and drawing each with its own materials where it is
//    drawn in the game (show: the stage's light set; world and body: the game scene): programs == watermark, 0 stalls;
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

test('agent roster: registry, lint, builds, budgets, hit volume, staged builder, programs', { timeout: 420000 }, async () => {
    const boxes = hitBoxes();
    assert.equal(boxes.detailed.length, 7, 'detailed hit boxes: body, two arms, two legs, weapon, head');
    assert.equal(boxes.low.length, 4, 'low hit boxes: body, arms block, legs, head');

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

    // ---- roster sets, resolve, stubs ---------------------------------------------------------------------------------
    const reg = await evaluate(() => {
        const keysLooks = Object.keys(AGENT_LOOKS), keysDefs = Object.keys(AGENT_DEFS);
        const res = {};
        for (const id of AGENT_ORDER) {
            const L = V23.core.resolve(id);
            res[id] = L ? { stub: L.stub, role: L.role, frozen: Object.isFrozen(L) && Object.isFrozen(L.palette) && Object.isFrozen(L.previews.c), same: V23.core.resolve(id) === L,
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
    const full = reg.order.filter((id) => !reg.res[id].stub);
    assert.deepEqual(full.sort(), ['omen', 'sage'], 'Sage and Omen are full entries; the other 27 are flagged stubs');
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
        matrix(id, 'intro <= 1.4 s and interruptible', r.introMs <= 1400, r.intro + ' ' + r.introMs + ' ms');
    }

    // ---- the full lint for Sage and Omen and rejected entries -------------------------------------------------------
    const lint = await evaluate(() => {
        const out = {};
        for (const id of ['sage', 'omen']) {
            const L = V23.core.resolve(id), e = AGENT_LOOKS[id];
            out[id] = { fields: ['codename', 'concept', 'avoid', 'rig', 'height', 'shoulderScale', 'hips', 'stance', 'palette', 'head', 'outfit', 'shoulders', 'back', 'equipment',
                'gloves', 'prop', 'motion', 'idle', 'showroom', 'gestures', 'previews', 'fp', 'sound', 'bot', 'mvp'].filter((f) => e[f] === undefined),
                avoid: L.avoid.slice(), tempo: L.motion.tempo, snap: L.motion.snap, intro: L.showroom.intro, x: L.gestures.x, pool: L.bot.pool, kit: L.bot.kit.slice(),
                hair: L.head.hair, gear: L.head.gear.slice(), outfit: L.outfit.map((o) => o.m), glove: L.gloves.type, tips: L.gloves.tips, prop: L.prop.m, hold: L.prop.hold };
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
            tryDef('omen', (d) => { d.motion.tempo = 2; })
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
                const t0 = performance.now();
                const root = V23.core.build(id, tier);
                const ms = performance.now() - t0;
                const v = root.userData.v23;
                let meshes = 0;
                root.traverse((o) => { if (o.isMesh && o.geometry.groups.length) meshes++; });
                out[tier][id] = Object.assign({ hash: v.hash, objMeshes: meshes, nodes: v.nodeList.length }, v.stats);
                out.ms.push({ id, tier, ms });
            }
        }
        // motion sampling on a built root draws nothing either
        for (const id of ['sage', 'omen']) for (const clip of ['idle', 'intro', 'lockIn', 'mvp', 'c', 'q', 'e', 'x']) for (let t = 0; t < 3; t += 0.25) V23.motion.sample(id, clip, t, V23.core.build(id, 'show'));
        out.rand = window.__rand.n;
        window.__rand.on = false;
        out.pool = pool0;
        out.misses = V23.parts.stats.poolMisses - miss0;
        // a second, fresh build of every show LOD (V23.parts.figure) has the same hash
        out.again = {};
        for (const id of AGENT_ORDER) out.again[id] = V23.parts.figure(V23.core.resolve(id), 'show').userData.v23.hash;
        out.kit = ['low', 'medium', 'high', 'ultra'].map((t) => { const g = V23.parts.kitSuperset(t); return { tier: t, v: g.userData.kit.vertices, hash: g.userData.kit.hash, again: V23.parts.kitSuperset(t) === g }; });
        return out;
    });
    assert.equal(builds.rand, 0, 'no Math.random call while every agent\'s show and world LOD builds and while motion samples');
    assert.ok(builds.pool.made, 'the object pool exists');
    assert.equal(builds.misses, 0, 'every build took its objects from the pool');
    const msList = builds.ms.map((b) => b.ms).sort((a, b) => a - b);
    const showMs = builds.ms.filter((b) => b.tier === 'show').map((b) => b.ms).sort((a, b) => a - b);
    const median = (a) => a[a.length >> 1];
    console.log('# median build ms per figure (show + world, 58 builds):', median(msList).toFixed(2), '| show only:', median(showMs).toFixed(2), '| max', msList[msList.length - 1].toFixed(2), '| pool made in', builds.pool.madeMs.toFixed(1), 'ms');
    for (const id of ['sage', 'omen']) console.log('#', id, 'show', JSON.stringify(builds.show[id]), 'world', JSON.stringify(builds.world[id]),
        'ms', builds.ms.filter((b) => b.id === id).map((b) => b.tier + ' ' + b.ms.toFixed(2)).join(', '));
    for (const id of reg.order) {
        const s = builds.show[id], w = builds.world[id];
        assert.ok(s.vertices <= 7000, `${id} show LOD ${s.vertices} vertices <= 7,000`);
        assert.ok(s.draws <= 36 && s.objMeshes <= 36, `${id} show LOD ${s.draws} draws, ${s.objMeshes} meshes <= 36`);
        assert.ok(w.meshes <= 6 && w.draws <= 6, `${id} world LOD ${w.draws} draws in ${w.meshes} mesh(es) <= 6`);
        assert.equal(builds.again[id], s.hash, `${id}: a fresh build has the same geometry hash`);
    }
    assert.equal(builds.show.sage.nodes, 7, 'Sage: the prop and its six shards are nodes');
    assert.equal(builds.show.omen.nodes, 11, 'Omen: the rift key and ten plates are nodes');
    for (const id of agents) matrix(id, 'show LOD within budget (<= 7k vertices, <= 36 meshes)', builds.show[id].vertices <= 7000 && builds.show[id].draws <= 36,
        `${builds.show[id].vertices} v, ${builds.show[id].draws} draws; world ${builds.world[id].draws} draws`);
    const kitBudget = { low: 600, medium: 1100, high: 2400, ultra: 3000 };
    for (const k of builds.kit) {
        assert.ok(k.v <= kitBudget[k.tier], `kit superset ${k.tier}: ${k.v} vertices <= ${kitBudget[k.tier]}`);
        assert.ok(k.again, `kit superset ${k.tier} is cached`);
    }

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
    // an agent change in combat queues its LODs (nothing builds now); the menu then builds them
    const staged2 = await evaluate(() => {
        const out = {};
        // a look redefined after it was built goes back on the queue (the same entry: the registry is unchanged)
        V23.core.define('miks', JSON.parse(JSON.stringify(AGENT_LOOKS.miks)));
        out.queued = V23.core.stats.queue.indexOf('miks|show') >= 0;
        out.combat = V23.core.stagedStep(3);
        mainMenu.show('pause');
        out.allowed = V23.core.stats.allowed;
        let n = 0;
        for (let i = 0; i < 50 && V23.core.stats.queue.length; i++) if (V23.core.stagedStep(3)) n++;
        out.steps = n;
        out.left = V23.core.stats.queue.length;
        out.built = (V23.core.stats.built.miks || []).indexOf('show') >= 0;
        return out;
    });
    assert.ok(staged2.queued && !staged2.combat, 'queued in combat, not built there');
    assert.ok(staged2.allowed && staged2.steps >= 1 && staged2.built && staged2.left === 0, 'the menu runs the staged builder through its queue');

    // ---- programs: upload-draw every LOD, then draw each with its own materials where the game draws it ----------------
    const prog = await evaluate(() => {
        const before = [renderer.info.programs.length, perfTelemetry.programWatermark, perfTelemetry.firstUseStalls];
        const tgt = new THREE.WebGLRenderTarget(64, 64);
        tgt.texture.encoding = THREE.sRGBEncoding;
        const prev = renderer.getRenderTarget();
        let uploads = 0;
        camera.updateMatrixWorld();
        const ahead = new THREE.Vector3(0, 0, -4).applyMatrix4(camera.matrixWorld);
        for (const id of AGENT_ORDER) for (const tier of ['show', 'world', 'body']) {
            if (tier === 'body' && id !== 'sage' && id !== 'omen' && id !== game.activeAgent) continue;
            const root = V23.core.build(id, tier);
            if (V23.core.uploadDraw(root)) uploads++;
            renderer.setRenderTarget(tgt);
            if (tier === 'show') {
                // the stage: exactly the viewmodel's light set and environment
                viewmodelScene.add(root);
                renderer.render(viewmodelScene, viewmodelCamera);
                viewmodelScene.remove(root);
            } else {
                // the killcam ghost and the prototypes: the game scene
                scene.add(root);
                root.position.copy(ahead);
                renderer.render(scene, camera);
                scene.remove(root);
                root.position.set(0, 0, 0);
            }
            renderer.setRenderTarget(prev);
        }
        tgt.dispose();
        return { before, uploads, after: [renderer.info.programs.length, perfTelemetry.programWatermark, perfTelemetry.firstUseStalls] };
    });
    await frames(10);
    const [programs, watermark, stalls] = await programState(page);
    console.log('# programs before', prog.before.join('/'), 'after', prog.after.join('/'), 'uploads', prog.uploads);
    assert.ok(prog.uploads >= 58, 'every LOD was upload-drawn');
    assert.equal(prog.after[0], prog.before[0], 'drawing every LOD made no program');
    assert.equal(programs, watermark, 'programs == watermark');
    assert.equal(stalls, 0, 'no first-use stalls');
    for (const id of agents) matrix(id, 'programs == watermark, 0 stalls', programs === watermark && stalls === 0, `${programs}/${watermark}, stalls ${stalls}`);

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
