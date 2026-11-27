'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser, programState } = require('./harness');

after(closeBrowser);

// V2.3 (WP8) Bot Utility, classic (design 10, 17.1): the bots' casts are V2.2's (when, where, which pool entry, how
// many Math.random draws), and with Agent Identity on they wind up first, release on the cast tick and throw the
// orb from the hand to V2.2's point in 220 ms. Bot Ability AI off means no casts and ends a windup at once.
//
// Every scenario runs in one evaluate on a deterministic driver (__det): 60 Hz ticks that move game time by 1000/60 ms
// (gameClock / gameTime, which V2.2's bot abilities run on) with performance.now, Date.now and Math.random fixed for the
// run, calling updateEnemies, updateEnemyAnimation and tacticalDirector.updateBotAbilities, nothing drawn. The same
// scenarios run in the V2.2 build (booted with the harness 'file' option) and in V2.3, and their traces must be equal.
// The V2.3 build is booted once; the second test goes on in the same page.

const V22 = '(V2.2) valorant-fps.html';
const TICK = 1000 / 60;

const HELPERS = () => {
    // (t0: the game-time origin of the run, the same in both builds)
    window.__det = (fn, t0) => {
        // The sound buffers made on first use take Math.random() calls: made here, before the seeded numbers
        // (as in bot-mechanics.test.js)
        const ctx = soundFX.ensureContext && soundFX.ensureContext();
        if (ctx) {
            soundFX._ensureReverb(ctx);
            if (!soundFX._noiseBuffer || soundFX._noiseBuffer.sampleRate !== ctx.sampleRate) {
                const b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate), d = b.getChannelData(0);
                for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
                soundFX._noiseBuffer = b;
            }
        }
        const realPerf = performance.now.bind(performance), realDate = Date.now, realRandom = Math.random, realRender = renderer.render;
        const T0 = Math.max(t0, window.__simT || 0) + 1000;
        let el = 0, seed = 20221, draws = 0;
        performance.now = () => T0 + el;
        Date.now = () => 1.7e12 + T0 + el;
        Math.random = () => { draws++; seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
        renderer.render = function () {};
        gameClock = T0; gameTime = T0;
        const tick = () => {
            game.health = 100; game.shield = 50; game.isDead = false;
            el += 1000 / 60;
            const now = T0 + el;
            gameClock = now; gameTime = now;   // game time moves with the step, as in animate
            updateEnemies(now, 1 / 60);
            updateEnemyAnimation(1 / 60);
            tacticalDirector.updateBotAbilities(1 / 60, gameNow());
        };
        // the game time of the next tick, computed exactly as tick() computes it
        const next = () => T0 + (el + 1000 / 60);
        try { return fn(tick, T0, () => draws, next); } finally {
            performance.now = realPerf; Date.now = realDate; Math.random = realRandom; renderer.render = realRender;
            window.__simT = T0 + el;
        }
    };

    // The same starting state in both builds: Wave on Ascent, no wingmen, every bot timer and hazard cleared, at
    // least `need` bot actors, you at the map's start facing down -Z
    window.__setup = (need) => {
        tacticalEnhancements.toggleWingmanAI(false);
        if (game.gameMode !== 'wave') tacticalDirector.setGameMode('wave');
        if (game.mapPreset !== 'ascent') rebuildMapPreset('ascent');
        while (enemyObjects.length < need) createEnemyActor(ENEMY_ARCHETYPE_ORDER[enemyObjects.length % ENEMY_ARCHETYPE_ORDER.length]);
        for (const o of enemyObjects) {
            o.isActive = false; o.hit = true; o.renderActive = false;
            if (o.broadKeys) actorBroadphase.remove(o);
            o.nextAbilityAt = 0; o.nextTpAt = 0; o.dashUntil = 0; o.lastLosCheckAt = 0; o.strafeNextSwitch = 0;
        }
        for (const h of tacticalDirector.botHazardsPool) { h.inUse = false; h.detonated = false; h.group.visible = false; }
        tacticalDirector.lastBotAbilityCastAt = 0;
        game.botAbilityAI = true;
        game.userSettings.botDifficulty = 'gold';
        const L = mapLayout(), cc = characterController;
        cc.position.set(L.start.x, cc.standHeight, L.start.z); cc.prevSimPosition.copy(cc.position); cc.velocity.set(0, 0, 0);
        camera.position.copy(cc.position);
        camera.rotation.set(0, 0, 0, 'YXZ');
        if (cc.targetRotation) cc.targetRotation.y = 0;
        if (typeof V23 !== 'undefined' && V23.util) V23.util.cancelWindups();
        return L;
    };
    // A free spot `d` m from you, the first of 16 directions where a bot fits and you can see it (the same in both builds)
    window.__spot = (d) => {
        const p = characterController.position;
        for (let k = 0; k < 16; k++) {
            const a = k * Math.PI / 8;
            const v = new THREE.Vector3(p.x + Math.sin(a) * d, 0, p.z - Math.cos(a) * d), w = v.clone();
            resolveEnemyMapCollision(w, 0.75);
            if (w.distanceTo(v) > 1e-6) continue;
            const o = new THREE.Vector3(p.x, p.y - 0.2, p.z), t = new THREE.Vector3(v.x, 1.4, v.z);
            if (agentSystem.hasWallLineOfSight(o, t, o.distanceTo(t))) return [v.x, v.z, a];
        }
        return null;
    };
    // Bot `slot` alive as `arch` at (x, z)
    window.__bot = (slot, x, z, arch) => {
        const e = enemyObjects[slot];
        activateEnemy(e, x, 0, z, arch);
        return e;
    };

    // What both builds record: each cast (a hazard taken), each pop, each bot timer change, each global gap stamp, and
    // every bot twice a second
    window.__rec = (T0) => {
        const pool = tacticalDirector.botHazardsPool;
        const seen = pool.map(() => null), popped = pool.map(() => true);
        const r = { casts: [], pops: [], timers: [], gaps: [], bots: [] };
        const timers = enemyObjects.map((e) => e.nextAbilityAt || 0);
        let gap = tacticalDirector.lastBotAbilityCastAt;
        r.sample = (k) => {
            for (let i = 0; i < pool.length; i++) {
                const h = pool[i];
                if (h.inUse && h.startTime !== seen[i]) {
                    seen[i] = h.startTime;
                    popped[i] = h.detonated;
                    r.casts.push([k, i, h.type, h.x, h.y, h.z, h.startTime - T0, h.detonateAt - T0, h.endTime - T0, h.radius, h.group.position.x, h.group.position.z]);
                }
                if (h.inUse && h.detonated && !popped[i]) { popped[i] = true; r.pops.push([k, i, h.type]); }
            }
            for (let s = 0; s < enemyObjects.length; s++) {
                const v = enemyObjects[s].nextAbilityAt || 0;
                if (v !== timers[s]) { r.timers.push([k, s, timers[s] ? 1 : 0, v - T0]); timers[s] = v; }
            }
            if (tacticalDirector.lastBotAbilityCastAt !== gap) { gap = tacticalDirector.lastBotAbilityCastAt; r.gaps.push(gap - T0); }
            if (k % 30 === 0) for (const e of enemyObjects) {
                r.bots.push(e.isActive && !e.hit ? [k, e.slot, e.mesh.position.x, e.mesh.position.y, e.mesh.position.z, e.mesh.rotation.y, e.health, e.aiState || '', e.hasSight ? 1 : 0, (e.dashUntil || 0) - T0] : [k, e.slot]);
            }
        };
        return r;
    };
    // V2.3 only: what V23.util sends out (the windup pose calls [k, slot, code, t, generation, seeded] and the cues
    // [k, slot, kind, seeded]), with the tick they came on, and the orb offsets of the hazards in flight. Each spy call
    // takes one number the way a seededSafe helper would (fxKit._rng, else Math.random), as a WP7 pose or WP10 sting
    // may: inside V23.seeded that is the V2.3 stream, so the Math.random count stays V2.2's; outside it, it would not.
    window.__spy = () => {
        const s = { k: -1, W: [], C: [], orbs: [], restore: () => {} };
        if (typeof V23 === 'undefined') return s;
        const ow = V23.bots.windup, oc = V23.audio.botCue;
        const draw = () => { const seeded = typeof fxKit._rng === 'function'; (seeded ? fxKit._rng : Math.random)(); return seeded ? 1 : 0; };
        V23.bots.windup = function (e, code, t) { s.W.push([s.k, e.slot, code, t, e.generation, draw()]); return ow.apply(this, arguments); };
        V23.audio.botCue = function (e, kind) { s.C.push([s.k, e.slot, kind, draw()]); return oc.apply(this, arguments); };
        s.restore = () => { V23.bots.windup = ow; V23.audio.botCue = oc; };
        s.orb = (k) => {
            const pool = tacticalDirector.botHazardsPool;
            for (let i = 0; i < pool.length; i++) {
                const h = pool[i], o = h.orbMesh.position;
                if (h.inUse && h.orbMesh.visible) s.orbs.push([k, i, o.x, o.y, o.z, h.orbMesh.scale.x, h.startTime]);
            }
        };
        return s;
    };
    window.__out = (r, s, draws, extra) => {
        const st = typeof V23 !== 'undefined' ? V23.util._stats : null;
        return Object.assign({ casts: r.casts, pops: r.pops, timers: r.timers, gaps: r.gaps, bots: r.bots, draws: draws(),
            W: s.W, C: s.C, orbs: s.orbs, stats: st ? { windups: st.windups, cancelled: st.cancelled, casts: st.casts, castsLed: st.castsLed, flights: st.flights, landed: st.landed } : null }, extra || {});
    };

    // A: one rusher held 12 m from you for 40 s (V2.2's casts every 7.8-10 s, each with a windup in V2.3). With
    // id 'off' (V2.3 only), the same run with Agent Identity off
    window.__scenRusher = (t0, id) => __det((tick, T0, draws) => {
        __setup(4);
        const V = typeof V23 !== 'undefined';
        if (V && id === 'off') game.userSettings.agentIdentity = 'off';
        const sp = __spot(12);
        const e = __bot(0, sp[0], sp[1], 'rusher');
        const hy = e.mesh.position.y;
        const r = __rec(T0), s = __spy();
        try {
            for (let k = 0; k < 40 * 60; k++) {
                s.k = k;
                e.mesh.position.set(sp[0], hy, sp[1]); e.poseDirty = true; syncEnemyBroadphase(e);
                tick();
                r.sample(k); if (s.orb) s.orb(k);
            }
        } finally { s.restore(); if (V) game.userSettings.agentIdentity = 'on'; }
        return __out(r, s, draws, { spot: sp, arch: e.archetype, slot: e.slot });
    }, t0);

    // B: four bots, one per archetype, free to move for 60 s (the sniper and the rifler hurt, so they cast too)
    window.__scenMixed = (t0) => __det((tick, T0, draws) => {
        __setup(4);
        const arch = ['rusher', 'sniper', 'armored', 'standard'], d = [11, 15, 13, 10];
        for (let i = 0; i < 4; i++) {
            const sp = __spot(d[i]);
            const e = __bot(i, sp[0] + (i - 1.5) * 1.2, sp[1], arch[i]);
            if (arch[i] === 'sniper' || arch[i] === 'standard') e.health = e.maxHealth - 10;
        }
        const r = __rec(T0), s = __spy();
        try {
            for (let k = 0; k < 60 * 60; k++) {
                s.k = k;
                tick();
                r.sample(k); if (s.orb) s.orb(k);
            }
        } finally { s.restore(); }
        return __out(r, s, draws);
    }, t0);

    // C: the rusher is in range when its cast comes within 300 ms (its windup is on), then held 5 m away (no cast
    // there) for 1.5 s, then back at 12 m (it casts at once). D: Bot Ability AI off for 15 s. E: F5 when the cast comes
    // within 300 ms, F5 again 2 s later. F: V23.util.cancelWindups() at the same moment (V2.3 only).
    // At the same moment (V2.3's settings only where they exist; the rest in both builds): 'idoff' Agent Identity off
    // for 2 s; 'death' the bot is hit (killed); 'respawn' activateEnemy on its slot, in place; 'blind' it is blinded
    // for 1.5 s; 'far' it is held 24 m away (past the near tier) for 1.5 s, then back at 12 m. 'idcast': Agent
    // Identity off on the cast tick itself (the windup still on), for 2 s
    window.__scenSwitch = (t0, what) => __det((tick, T0, draws, next) => {
        __setup(4);
        const far = __spot(12);
        const e = __bot(0, far[0], far[1], 'rusher');
        const hy = e.mesh.position.y, p = characterController.position;
        const near = [p.x + (far[0] - p.x) * 5 / 12, p.z + (far[1] - p.z) * 5 / 12];
        const out24 = [p.x + (far[0] - p.x) * 2, p.z + (far[1] - p.z) * 2];
        const V = typeof V23 !== 'undefined';
        const idSet = (v) => { if (V) game.userSettings.agentIdentity = v; };
        if (what === 'off') game.botAbilityAI = false;
        const r = __rec(T0), s = __spy();
        let at = -1, spot = far;
        const key = () => document.dispatchEvent(new KeyboardEvent('keydown', { code: 'F5', key: 'F5', bubbles: true }));
        try {
            for (let k = 0; k < (what === 'off' ? 15 : 8) * 60; k++) {
                s.k = k;
                const due = what === 'idcast'
                    ? (e.nextAbilityAt && e.nextAbilityAt <= next())                       // the cast is on this tick
                    : (e.nextAbilityAt && e.nextAbilityAt - (gameNow() + 1000 / 60) <= 300);  // the cast within 300 ms
                if (at < 0 && due) {
                    at = k;
                    if (what === 'away') spot = near;
                    else if (what === 'far') spot = out24;
                    else if (what === 'f5') key();
                    else if (what === 'cancel' && V) V23.util.cancelWindups();
                    else if (what === 'idoff' || what === 'idcast') idSet('off');
                    else if (what === 'death') e.hit = true;
                    else if (what === 'respawn') __bot(0, far[0], far[1], 'rusher');
                    else if (what === 'blind') e.blindedUntil = gameNow() + 1500;
                }
                if (at >= 0 && k === at + 90 && (what === 'away' || what === 'far')) spot = far;
                if (at >= 0 && k === at + 120 && what === 'f5') key();
                if (at >= 0 && k === at + 120 && (what === 'idoff' || what === 'idcast')) idSet('on');
                if (!e.hit) { e.mesh.position.set(spot[0], hy, spot[1]); e.poseDirty = true; syncEnemyBroadphase(e); }
                tick();
                r.sample(k); if (s.orb) s.orb(k);
            }
        } finally { s.restore(); idSet('on'); }
        game.botAbilityAI = true;
        return __out(r, s, draws, { at, ai: game.botAbilityAI });
    }, t0);

    // G: the pool full (V2.2's 6 in use): the next cast takes entry 0 back, as V2.2's does (classic never reaches 6-9);
    // then with 'agent' (V2.3 only) it takes entry 6
    window.__scenSteal = (t0) => __det((tick, T0, draws) => {
        __setup(4);
        const sp = __spot(12);
        const e = __bot(0, sp[0], sp[1], 'rusher');
        const pool = tacticalDirector.botHazardsPool, got = [];
        const fill = () => { for (let i = 0; i < pool.length; i++) { pool[i].inUse = i < 6; pool[i].endTime = T0 + 1e6; pool[i].startTime = T0 - 1 - i; } };
        const one = () => {
            e.nextAbilityAt = 1; tacticalDirector.lastBotAbilityCastAt = -1e9;
            tacticalDirector.tryCastBotAbility(e, gameNow(), 12, 0, 1, 1, 0);
            got.push(pool.findIndex((h) => h.inUse && h.startTime === gameNow()));
        };
        fill(); one();
        const first = draws();
        if (typeof V23 !== 'undefined') {
            game.userSettings.botUtility = 'agent';
            fill(); one();
            game.userSettings.botUtility = 'classic';
            fill(); one();
        }
        for (const h of pool) { h.inUse = false; h.group.visible = false; }
        return { got, draws: first, size: pool.length, build: typeof V23 };
    }, t0);

    // N (V2.3 only): what _frame itself does between sim ticks (updateBotAbilities with no tick, as animate's frames
    // without a step run it). Each case: a rusher 12 m away ticked until its windup is on, then one change and one
    // updateBotAbilities with no tick. 'reset': animate's timing reset on a resume (gameTime = gameClock plus the
    // accumulator's fraction, then gameClock = gameTime, no step that frame); the windup must stay on and lead the
    // cast. 'botAI', 'idoff', 'blind', 'mode': Bot Ability AI off, identity off, a blind, the mode changed. 'unseen':
    // with a second bot (a rusher held 5 m away, too close to cast), a tick that steps it but not the blinded first.
    window.__scenFrame = (t0) => __det((tick, T0) => {
        const U = V23.util, out = {};
        const last = () => U._stats.log[U._stats.log.length - 1];
        for (const what of ['reset', 'botAI', 'idoff', 'blind', 'mode', 'unseen']) {
            __setup(4);
            const sp = __spot(12);
            const e = __bot(0, sp[0], sp[1], 'rusher');
            const hy = e.mesh.position.y, p = characterController.position;
            let f = null;
            if (what === 'unseen') {
                f = __bot(1, p.x + (sp[0] - p.x) * 5 / 12, p.z + (sp[1] - p.z) * 5 / 12, 'rusher');
            }
            const fy = f ? f.mesh.position.y : 0, fp = f ? [f.mesh.position.x, f.mesh.position.z] : null;
            const hold = () => {
                e.mesh.position.set(sp[0], hy, sp[1]); e.poseDirty = true; syncEnemyBroadphase(e);
                if (f) { f.mesh.position.set(fp[0], fy, fp[1]); f.poseDirty = true; syncEnemyBroadphase(f); }
            };
            let k = 0;
            while (k < 600 && !(U._w[0] && U._w[0].on)) { hold(); tick(); k++; }
            const r = { started: !!(U._w[0] && U._w[0].on), at: k }, tStart = gameNow();
            try {
                if (what === 'reset') {
                    gameTime = gameClock + 8.3;
                    gameClock = gameTime;
                    tacticalDirector.updateBotAbilities(0, gameNow());
                    r.on = U._w[0].on;
                    // then the ticks go on: the windup leads V2.2's cast, released on the cast tick
                    let c = 0;
                    while (c < 60 && !U._stats.log.some((q) => q[0] === 'cast' && q[3] >= tStart)) { hold(); tick(); c++; }
                    r.cast = U._stats.log.filter((q) => q[0] === 'cast').pop();
                    r.cancels = U._stats.log.filter((q) => q[0] === 'cancel' && q[1] === 0 && q[3] >= tStart).map((q) => q[2]);
                } else if (what === 'unseen') {
                    e.blindedUntil = gameNow() + 1500;
                    hold(); tick();
                    r.on = U._w[0].on;
                    r.last = last();
                    r.stepped = U._stepAt === gameNow() && U._w[0].seenAt < U._stepAt;   // the second bot was stepped on it
                } else {
                    if (what === 'botAI') game.botAbilityAI = false;
                    else if (what === 'idoff') game.userSettings.agentIdentity = 'off';
                    else if (what === 'blind') e.blindedUntil = gameNow() + 1500;
                    else if (what === 'mode') game.userSettings.botUtility = 'agent';
                    tacticalDirector.updateBotAbilities(0, gameNow());
                    r.on = U._w[0].on;
                    r.last = last();
                    if (what === 'mode') {
                        // back to classic, ticks on to the cast: no new windup on the same prediction, the release only
                        game.userSettings.botUtility = 'classic';
                        const n0 = U._stats.windups;
                        let c = 0;
                        while (c < 60 && !U._stats.log.some((q) => q[0] === 'cast' && q[3] >= r.last[3])) { hold(); tick(); c++; }
                        r.cast = U._stats.log.filter((q) => q[0] === 'cast').pop();
                        r.rewound = U._stats.windups - n0;
                    }
                }
            } finally {
                game.botAbilityAI = true; game.userSettings.agentIdentity = 'on'; game.userSettings.botUtility = 'classic';
                e.blindedUntil = 0;
            }
            out[what] = r;
        }
        return out;
    }, t0);
};

// The parts of a trace both builds must give exactly
const GAMEPLAY = ['casts', 'pops', 'timers', 'gaps', 'bots', 'draws'];
const SCENARIOS = [
    ['rusher', (t0) => __scenRusher(t0), 6e6],
    ['mixed', (t0) => __scenMixed(t0), 7e6],
    ['away', (t0) => __scenSwitch(t0, 'away'), 8e6],
    ['off', (t0) => __scenSwitch(t0, 'off'), 9e6],
    ['f5', (t0) => __scenSwitch(t0, 'f5'), 10e6],
    ['rusherOff', (t0) => __scenRusher(t0, 'off'), 13e6],
    ['idoff', (t0) => __scenSwitch(t0, 'idoff'), 14e6],
    ['idcast', (t0) => __scenSwitch(t0, 'idcast'), 15e6],
    ['death', (t0) => __scenSwitch(t0, 'death'), 16e6],
    ['respawn', (t0) => __scenSwitch(t0, 'respawn'), 17e6],
    ['blind', (t0) => __scenSwitch(t0, 'blind'), 18e6],
    ['far', (t0) => __scenSwitch(t0, 'far'), 19e6]
];

// The V2.3 page, booted once for the file (design 17.1); the second test goes on in it. boot() closes the page before,
// so the V2.2 reference is booted first
let V23PAGE = null;
async function bootBuild(file) {
    const b = await boot(file ? { quality: 'low', file } : { quality: 'low' });
    await b.evaluate(HELPERS);
    if (!file) V23PAGE = b;
    return b;
}
async function v23Page() { return V23PAGE || bootBuild(null); }

async function runAll(file) {
    const b = await bootBuild(file);
    const { evaluate, errors, page, frames } = b;
    const out = { errors };
    for (const [name, fn, t0] of SCENARIOS) out[name] = await evaluate(`(${fn.toString()})(${t0})`);
    out.steal = await evaluate(() => __scenSteal(20e6));
    if (!file) out.frame = await evaluate(() => __scenFrame(21e6));
    // then real frames: the game draws on from where the runs left it
    await frames(20);
    out.programs = await programState(page);
    return { out, evaluate, page, errors };
}

// The windups of one bot slot in a spy log: [{start, end, how ('cast' | 'cancel'), code, ts}]
function windups(W, slot) {
    const list = [];
    let cur = null;
    for (const [k, s, code, t] of W) {
        if (s !== slot) continue;
        if (code > 0 && t === 0 && !cur) { cur = { start: k, code, ts: [] }; continue; }
        if (!cur) { if (code > 0 && t === 1) list.push({ start: k, end: k, how: 'cast', code, ts: [] }); continue; }
        if (code > 0 && t > 0 && t < 1) { cur.ts.push(t); continue; }
        if (code > 0 && t === 1) { cur.end = k; cur.how = 'cast'; cur.code = code; list.push(cur); cur = null; continue; }
        if (code === 0) { cur.end = k; cur.how = 'cancel'; list.push(cur); cur = null; }
    }
    if (cur) { cur.end = -1; cur.how = 'open'; list.push(cur); }
    return list;
}

let V22OUT = null;

test('classic: the same casts, hazards, pool entries, timers, gaps and Math.random draws as V2.2, with windups, releases and orb flights on top', { timeout: 900000 }, async () => {
    const a = await runAll(V22);
    V22OUT = a.out;
    const b = await runAll(null);
    const v23 = b.out;
    assert.deepEqual(a.out.errors, []);
    assert.deepEqual(v23.errors, []);
    assert.equal(v23.programs[0], v23.programs[1], 'no shader program past the warm-up watermark');
    assert.equal(v23.programs[2], 0, 'no first-use stall');
    const settings = await b.evaluate(() => [game.userSettings.agentIdentity, game.userSettings.botUtility, tacticalDirector.botHazardsPool.length, V23.util.poolLimit()]);
    assert.deepEqual(settings, ['on', 'classic', 10, 6], 'identity on and classic by default; 10 pool entries, 6 used');
    // the reference run really is V2.2 (no V23, 6 entries, nothing sent out)
    assert.deepEqual([V22OUT.steal.build, V22OUT.steal.size, V22OUT.rusher.W.length], ['undefined', 6, 0]);
    // the pool full: classic takes entry 0 back, exactly as V2.2 does; 'agent' reaches entry 6
    assert.deepEqual(V22OUT.steal.got, [0]);
    assert.deepEqual(v23.steal.got, [0, 6, 0], 'pool full: classic steals entry 0 as V2.2 does; agent mode takes entry 6');
    assert.equal(v23.steal.draws, V22OUT.steal.draws, 'the same draws for the classic steal');
    // every pose call and cue (start, progress, end, release, arming) came inside V23.seeded
    for (const [name] of SCENARIOS) {
        const y = v23[name];
        assert.deepEqual(y.W.filter((w) => w[5] !== 1), [], `${name}: every V23.bots.windup call inside V23.seeded`);
        assert.deepEqual(y.C.filter((c) => c[3] !== 1), [], `${name}: every V23.audio.botCue call inside V23.seeded`);
    }
    for (const [name] of SCENARIOS) {
        const x = V22OUT[name], y = v23[name];
        for (const k of GAMEPLAY) assert.deepEqual(y[k], x[k], `${name}: ${k} equal to V2.2`);
        console.log(`# ${name}: ${y.casts.length} hazard casts, ${y.timers.length} timer writes, ${y.pops.length} pops, ${y.draws} Math.random draws; V2.3 windups ${y.W.filter((w) => w[2] > 0 && w[3] === 0).length}, cues ${y.C.length}`);
    }

    // A: every flash had a windup of at least 250 ms (and at most 350 + a tick), the throw (code 7) on the cast tick, the
    // cue at the start and on the cast, and the orb from the hand to V2.2's point within 220 ms
    const A = v23.rusher;
    assert.ok(A.casts.length >= 4, `the rusher cast ${A.casts.length} times in 40 s`);
    assert.ok(A.casts.every((c) => c[2] === 'flash' && c[1] < 6), 'flashes, from V2.2\'s first 6 entries');
    const wa = windups(A.W, A.slot);
    assert.equal(wa.length, A.casts.length, 'one windup per cast');
    for (let i = 0; i < A.casts.length; i++) {
        const c = A.casts[i], w = wa[i];
        assert.equal(w.how, 'cast', `cast ${i} released a windup`);
        assert.equal(w.end, c[0], `cast ${i}: the release is on the cast tick`);
        assert.equal(w.code, 7, 'the throw');
        const lead = (w.end - w.start) * TICK;
        assert.ok(lead >= 250 && lead <= 350 + TICK, `cast ${i}: windup ${lead.toFixed(1)} ms before it`);
        for (let j = 1; j < w.ts.length; j++) assert.ok(w.ts[j] >= w.ts[j - 1] && w.ts[j] <= 0.95, 'the windup progress rises to at most 0.95');
        assert.ok(A.C.some((q) => q[0] === w.start && q[2] === 'windup.flash'), 'the warning cue at the windup');
        assert.ok(A.C.some((q) => q[0] === c[0] && q[2] === 'cast.flash'), 'the cast cue');
        // the orb: at the hand on the cast tick, V2.2's point (offset exactly 0) at the first tick 220 ms on, closer each tick
        const fl = A.orbs.filter((o) => o[1] === c[1] && o[0] >= c[0] && o[0] <= c[0] + 16);
        const first = fl[0];
        assert.equal(first[0], c[0], 'the orb is out on the cast tick');
        const off0 = Math.hypot(first[2], first[4]);
        assert.ok(off0 > 1, `it starts ${off0.toFixed(2)} m from V2.2's point`);
        const hx = c[10] + first[2], hz = c[11] + first[4];
        assert.ok(c[4] + first[3] > 0.9 && c[4] + first[3] < 1.6, `it starts at hand height (${(c[4] + first[3]).toFixed(2)} m)`);
        assert.ok(Math.hypot(hx - A.spot[0], hz - A.spot[1]) < 2.3, 'beside the bot (its dash moves it at most 1.7 m, the hand is 0.45 m out)');
        const land = Math.ceil(220 / TICK - 1e-9);
        for (const o of fl) {
            const age = (o[0] - c[0]) * TICK;
            if (age >= 220) assert.deepEqual([o[2], o[3], o[4]], [0, 0, 0], `on V2.2's point at ${age.toFixed(0)} ms`);
        }
        const before = fl.filter((o) => o[0] - c[0] < land).map((o) => Math.hypot(o[2], o[4]));
        for (let j = 1; j < before.length; j++) assert.ok(before[j] < before[j - 1], 'closer every tick');
        assert.ok(before[before.length - 1] > 0, 'still flying just before 220 ms');
    }

    // B: every windup ends in a release or a cancel within 650 ms (+ a tick); the 2600 ms gap and each archetype's
    // cooldown hold; no pool entry past V2.2's 6
    const B = v23.mixed;
    assert.ok(B.timers.filter((t) => t[2]).length >= 6, `${B.timers.length} casts in the mixed run`);
    for (let i = 1; i < B.gaps.length; i++) assert.ok(B.gaps[i] - B.gaps[i - 1] >= 2600 - 1e-6, `the global gap holds (${(B.gaps[i] - B.gaps[i - 1]).toFixed(0)} ms)`);
    const minCd = { rusher: 7800, sniper: 7500, armored: 9200, standard: 9600 }, archOf = ['rusher', 'sniper', 'armored', 'standard'];
    for (let s = 0; s < 4; s++) {
        const ts = B.timers.filter((t) => t[1] === s && t[2]);
        let last = null;
        for (const t of ts) { const at = t[0] * TICK; if (last !== null) assert.ok(at - last >= minCd[archOf[s]] - TICK, `${archOf[s]} cooldown (${(at - last).toFixed(0)} ms)`); last = at; }
    }
    assert.ok(B.casts.every((c) => c[1] < 6), 'classic never takes an entry past V2.2\'s 6');
    let led = 0, all = 0;
    for (let s = 0; s < 4; s++) {
        for (const w of windups(B.W, s)) {
            if (w.how === 'open') { assert.ok((60 * 60 - w.start) * TICK < 650 + TICK, 'only a windup in its last 650 ms is still open'); continue; }
            const len = (w.end - w.start) * TICK;
            assert.ok(len <= 650 + TICK, `slot ${s}: a windup lasted ${len.toFixed(0)} ms`);
            if (w.how === 'cast') { all++; if (len >= 250) led++; }
        }
    }
    console.log(`# mixed: ${led} of ${all} casts had a windup of 250 ms or more (the rest came as the bot entered range)`);
    assert.ok(all >= 6 && led >= all - 2, `windups lead casts in free play too (${led} of ${all})`);
    // each mortar arming (its pop) plays the armored bot's warning sting on that tick, and nothing else does
    const mortarPops = B.pops.filter((q) => q[2] === 'mortar');
    assert.ok(mortarPops.length >= 2, `${mortarPops.length} mortars armed`);
    const arms = B.C.filter((q) => q[2] === 'arm.mortar');
    assert.deepEqual(arms.map((q) => [q[0], q[1]]), mortarPops.map((q) => [q[0], 2]), 'the arming sting on each mortar\'s arming tick, from its caster');

    // C: in range at the windup, out of range at the cast time: no cast, the windup cancelled 650 ms after it
    // started, no restart on the same prediction; back in range, it casts at once (V2.2) with only the release
    const C = v23.away;
    const wc = windups(C.W, 0);
    assert.ok(wc.length >= 2, 'a cancelled windup, then the cast');
    assert.equal(wc[0].how, 'cancel', 'the first windup is cancelled');
    const clen = (wc[0].end - wc[0].start) * TICK;
    assert.ok(clen >= 650 && clen < 650 + TICK, `cancelled ${clen.toFixed(0)} ms after it started`);
    assert.ok(!C.casts.some((c) => c[0] < C.at + 90), 'no cast while 5 m away');
    assert.equal(wc[1].how, 'cast', 'then the cast');
    assert.equal(wc[1].start, wc[1].end, 'back in range, it casts at once (no windup to lead it)');
    assert.equal(wc[1].end, C.at + 90, 'on the tick it is back in range');

    // D: Bot Ability AI off: no casts, no windups, no cues
    const D = v23.off;
    assert.deepEqual([D.casts.length, D.timers.length, D.W.length, D.C.length], [0, 0, 0, 0], 'Bot Ability AI off: no casts, no timers, no windups, no cues');

    // E: F5 mid-windup ends it on the next tick, no cast while off; F5 again and the cast comes at once
    const E = v23.f5;
    const we = windups(E.W, 0);
    assert.equal(we[0].how, 'cancel', 'F5 cancels the windup');
    assert.equal(we[0].end, E.at, 'on the F5 tick itself');
    assert.ok(!E.casts.some((c) => c[0] < E.at + 120), 'no cast while Bot Ability AI is off');
    assert.ok(E.casts.some((c) => c[0] === E.at + 120), 'F5 again: the cast at once');
    assert.equal(E.ai, true);

    // What a slot's spy log holds in ticks [a, b): pose calls with a gesture, and cues
    const busy = (Y, a, b) => [Y.W.filter((w) => w[1] === 0 && w[0] >= a && w[0] < b && w[2] > 0), Y.C.filter((q) => q[1] === 0 && q[0] >= a && q[0] < b)];
    const endsAt = (Y, k) => Y.W.some((w) => w[0] === k && w[1] === 0 && w[2] === 0);

    // G: Agent Identity off for the whole rusher run: V2.2's picture (no pose call, no cue, every orb on V2.2's point)
    // and V2.2's play (the gameplay trace above)
    const G = v23.rusherOff;
    assert.ok(G.casts.length >= 4 && G.orbs.length > 0, `${G.casts.length} casts with identity off`);
    assert.deepEqual([G.W.length, G.C.length], [0, 0], 'identity off: no windup pose call and no cue');
    assert.deepEqual(G.orbs.filter((o) => o[2] !== 0 || o[3] !== 0 || o[4] !== 0), [], 'identity off: every orb at V2.2\'s point');

    // H: identity switched off mid-windup: the pose back to rest on that tick, then nothing while it is off (the cast
    // has no release and its orb no flight)
    const H = v23.idoff;
    const wh = windups(H.W, 0);
    assert.equal(wh[0].how, 'cancel', 'identity off cancels the windup');
    assert.equal(wh[0].end, H.at, 'on the tick it went off (a code-0 call)');
    assert.deepEqual(busy(H, H.at, H.at + 120), [[], []], 'nothing sent while identity is off');
    const hc = H.casts.filter((c) => c[0] > H.at && c[0] < H.at + 120);
    assert.equal(hc.length, 1, 'the cast came while identity was off');
    assert.deepEqual(H.orbs.filter((o) => o[0] >= hc[0][0] && o[0] < H.at + 120 && (o[2] || o[3] || o[4])), [], 'its orb on V2.2\'s point');

    // I: identity switched off on the cast tick itself: the pose back to rest on that tick, no release, no cue
    const I = v23.idcast;
    assert.ok(I.casts.some((c) => c[0] === I.at), 'the cast is on the tick identity went off');
    assert.ok(endsAt(I, I.at), 'a code-0 call on the cast tick');
    assert.deepEqual(busy(I, I.at, I.at + 120), [[], []], 'no release and no cue while identity is off');
    assert.deepEqual(I.orbs.filter((o) => o[0] >= I.at && o[0] < I.at + 120 && (o[2] || o[3] || o[4])), [], 'no flight');

    // J: the bot killed mid-windup: the pose back to rest on that tick, nothing after (it never casts again)
    const J = v23.death;
    const wj = windups(J.W, 0);
    assert.deepEqual([wj.length, wj[0].how, wj[0].end], [1, 'cancel', J.at], 'death cancels the windup on that tick');
    assert.deepEqual(busy(J, J.at, 1e9), [[], []], 'no release after the death');
    assert.ok(!J.casts.some((c) => c[0] >= J.at), 'no cast after the death');

    // K: the slot respawned mid-windup: the old life's windup ends on that tick and is never released; the new life
    // winds up afresh for V2.2's cast (activateEnemy keeps nextAbilityAt in V2.2) and releases that one
    const K = v23.respawn;
    const wk = windups(K.W, 0);
    assert.equal(wk[0].how, 'cancel', 'respawn cancels the windup');
    assert.equal(wk[0].end, K.at, 'on the tick of the respawn');
    const g0 = K.W.find((w) => w[1] === 0 && w[2] > 0 && w[3] === 0)[4];
    assert.ok(K.W.filter((w) => w[1] === 0 && w[3] === 1).every((w) => w[4] > g0), 'no release for the old life');
    assert.ok(wk.length >= 2 && wk[1].how === 'cast' && wk[1].start >= K.at && wk[1].code === 7, 'the new life winds up and throws');
    assert.ok(K.casts.some((c) => c[0] === wk[1].end), 'released on V2.2\'s cast tick');

    // L: blinded mid-windup: the bot is not stepped (V2.2 skips a blinded bot), so the windup ends on that tick, not
    // 650 ms later; nothing while blind; the cast when the blind ends has its release only
    const Lb = v23.blind;
    const wl = windups(Lb.W, 0);
    assert.deepEqual([wl[0].how, wl[0].end], ['cancel', Lb.at], 'blind cancels the windup on that tick');
    const lc = Lb.casts.filter((c) => c[0] >= Lb.at);
    assert.ok(lc.length >= 1 && lc[0][0] >= Lb.at + 85, 'no cast while blind');
    assert.deepEqual(busy(Lb, Lb.at + 1, lc[0][0]), [[], []], 'nothing sent while blind');
    assert.ok(wl[1].how === 'cast' && wl[1].start === wl[1].end && wl[1].end === lc[0][0], 'then the cast with its release only');

    // M: out of the near tier mid-windup (24 m): not stepped, so the windup ends on that tick; back at 12 m the cast
    // comes at once with its release only
    const M = v23.far;
    const wm = windups(M.W, 0);
    assert.deepEqual([wm[0].how, wm[0].end], ['cancel', M.at], 'leaving the near tier cancels the windup on that tick');
    assert.deepEqual(busy(M, M.at + 1, M.at + 90), [[], []], 'nothing sent while out of the near tier');
    assert.ok(!M.casts.some((c) => c[0] < M.at + 90), 'no cast at 24 m');
    assert.ok(wm[1] && wm[1].how === 'cast' && wm[1].start === wm[1].end, 'back in range: the cast with its release only');

    // N: _frame between ticks. A timing reset (a resume) keeps the windup, which then leads the cast; Bot Ability AI
    // off, identity off, a blind and a mode change each end it there, with no tick; a tick that steps another bot but
    // not the windup's ends it ('unseen'); after a mode change the cast comes with its release only
    const N = v23.frame;
    for (const k of Object.keys(N)) assert.ok(N[k].started, `${k}: the windup started`);
    assert.equal(N.reset.on, true, 'reset: the windup is still on after the timing reset');
    assert.deepEqual(N.reset.cancels, [], 'reset: no cancel');
    assert.ok(N.reset.cast && N.reset.cast[4] >= 250, `reset: the cast is led by the windup (${N.reset.cast && N.reset.cast[4]} ms)`);
    assert.deepEqual([N.botAI.on, N.botAI.last[0], N.botAI.last[2]], [false, 'cancel', 'botAI'], 'Bot Ability AI off between ticks: _frame ends it');
    assert.deepEqual([N.idoff.on, N.idoff.last[0], N.idoff.last[2]], [false, 'cancel', 'off'], 'identity off between ticks: _frame ends it');
    assert.deepEqual([N.blind.on, N.blind.last[0], N.blind.last[2]], [false, 'cancel', 'blind'], 'a blind between ticks: _frame ends it');
    assert.deepEqual([N.mode.on, N.mode.last[0], N.mode.last[2]], [false, 'cancel', 'mode'], 'a mode change: _frame ends it');
    assert.equal(N.mode.rewound, 0, 'no new windup on the same prediction after the mode change');
    assert.ok(N.mode.cast && N.mode.cast[4] === 0, 'then the cast with its release only');
    assert.deepEqual([N.unseen.on, N.unseen.last[0], N.unseen.last[2], N.unseen.stepped], [false, 'cancel', 'unseen', true], 'a tick that steps another bot but not this one ends it');
});

test('classic: mid-windup cancelWindups, the mortar caster, the botDash clock, palette tints, identity off, the Ranked pin, and no new programs', { timeout: 600000 }, async () => {
    const { evaluate, errors, page, frames } = await v23Page();

    // cancelWindups() at the windup ends it at once
    const F = await evaluate(() => __scenSwitch(11e6, 'cancel'));
    const wf = windups(F.W, 0);
    assert.equal(wf[0].how, 'cancel');
    assert.equal(wf[0].end, F.at, 'cancelWindups ends it in the same tick');

    const r = await evaluate(() => {
        const out = {};
        __setup(4);
        const sp = __spot(12);
        const lin = (h) => new THREE.Color().setHex(h).convertSRGBToLinear().toArray().map((v) => +v.toFixed(6));
        const col = (hz) => hz.orbMat.color.toArray().map((v) => +v.toFixed(6));
        const cast = (e, d) => {
            e.nextAbilityAt = 1; tacticalDirector.lastBotAbilityCastAt = -1e9;
            for (const h of tacticalDirector.botHazardsPool) { h.inUse = false; h.group.visible = false; }
            tacticalDirector.tryCastBotAbility(e, gameNow(), d || 12, 0, 1, 1, 0);
            return tacticalDirector.botHazardsPool.find((h) => h.inUse) || null;
        };
        // botDash gets game time whatever clock the caller passes (V2.2 passed the argument on)
        const e = __bot(0, sp[0], sp[1], 'rusher');
        const od = abilityLook.botDash, got = [];
        abilityLook.botDash = function (en, sx, sz, now) { got.push(now); return od.apply(this, arguments); };
        e.nextAbilityAt = 1; tacticalDirector.lastBotAbilityCastAt = -1e9;
        tacticalDirector.tryCastBotAbility(e, gameNow() + 54321, 12, 0, 1, 1, 0);
        abilityLook.botDash = od;
        out.dash = [got.length, got[0] === gameNow()];
        // the flash: owner, ability id, a fresh caster record; the orb starts at the hand; V2.2's colour (stub look)
        let hz = cast(e);
        out.flash = [hz.type, hz.owner === e, hz.abilityId, hz.caster.enemy === e, hz.caster.slot === e.slot, hz.caster.generation === e.generation,
            hz.orbMesh.position.length() > 1, JSON.stringify(col(hz)) === JSON.stringify(lin(0xfbbf24))];
        // a built look tints the orb with its glow; a stub look keeps V2.2's colour
        const realResolve = V23.core.resolve;
        try {
            V23.core.resolve = (id) => (id === 'sage' ? { palette: { glow: { c: 0x2dd4bf } } } : id === 'omen' ? { stub: true, palette: { glow: { c: 0x7c3aed } } } : realResolve(id));
            e.agentId = 'sage';
            hz = cast(e);
            out.tint = JSON.stringify(col(hz)) === JSON.stringify(lin(0x2dd4bf));
            e.agentId = 'omen';
            hz = cast(e);
            out.stubTint = JSON.stringify(col(hz)) === JSON.stringify(lin(0xfbbf24));
            const s = __bot(3, sp[0], sp[1], 'standard');
            s.agentId = 'sage'; s.hasSight = false;
            hz = cast(s, 10);
            const mix = V23.util._mix(0x2dd4bf, 0x991b1b, 0.5);
            out.smoke = [hz.type, JSON.stringify(col(hz)) === JSON.stringify(lin(mix)), hz.orbMesh.position.length() > 1, +hz.orbMesh.scale.x.toFixed(3)];
            // the lob flies at V2.2's scale (only the offset moves, design 10) and lands on V2.2's point
            for (let k = 0; k < 20; k++) {
                tacticalDirector.updateBotAbilities(1 / 60, gameNow() + (k + 1) * 1000 / 60);
                if (k === 5) out.smokeMid = [hz.orbMesh.position.length() > 0.1, hz.orbMesh.scale.x];
            }
            out.smokeLanded = [hz.orbMesh.position.length(), hz.orbMesh.scale.x];
            // identity switched off with a flash orb in flight: it lands on V2.2's point on the next update
            e.agentId = undefined;
            hz = cast(e);
            const flying = hz.orbMesh.position.length();
            game.userSettings.agentIdentity = 'off';
            tacticalDirector.updateBotAbilities(1 / 60, gameNow());
            out.offFlight = [flying > 1, hz.orbMesh.position.length()];
            // identity off: V2.2's picture: no flight, V2.2's colour, no windup or cue calls
            const calls = [];
            const ow = V23.bots.windup;
            V23.bots.windup = function () { calls.push([...arguments].slice(1)); };
            e.agentId = 'sage';
            hz = cast(e);
            V23.bots.windup = ow;
            out.off = [hz.orbMesh.position.length(), JSON.stringify(col(hz)) === JSON.stringify(lin(0xfbbf24)), calls.length];
            // identity switched off with a tinted orb live: V2.2's colour back on the next update (design 16), for a smoke
            // and for a flash before its pop
            const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
            game.userSettings.agentIdentity = 'on';
            const s3 = __bot(3, sp[0], sp[1], 'standard');
            s3.agentId = 'sage'; s3.hasSight = false;
            hz = cast(s3, 10);
            const tintedSmoke = eq(col(hz), lin(mix));
            game.userSettings.agentIdentity = 'off';
            tacticalDirector.updateBotAbilities(1 / 60, gameNow());
            out.smokeOff = [tintedSmoke, eq(col(hz), lin(0x991b1b)), hz.inUse, V23.util._tinted];
            game.userSettings.agentIdentity = 'on';
            e.agentId = 'sage';
            hz = cast(e);
            const tintedFlash = eq(col(hz), lin(0x2dd4bf));
            game.userSettings.agentIdentity = 'off';
            tacticalDirector.updateBotAbilities(1 / 60, gameNow());
            out.flashOff = [tintedFlash, eq(col(hz), lin(0xfbbf24)), hz.detonated, V23.util._tinted];
            game.userSettings.agentIdentity = 'on';
            // a tinted flash pops V2.2's white, and its tint ends there
            hz = cast(e);
            tacticalDirector.updateBotAbilities(1 / 60, hz.detonateAt);
            out.flashPop = [hz.detonated, eq(col(hz), lin(0xffffff)), V23.util._tinted];
            // a tinted smoke's entry ends: V2.2's crimson back on it
            hz = cast(s3, 10);
            tacticalDirector.updateBotAbilities(1 / 60, hz.endTime);
            out.smokeEnd = [hz.inUse, eq(col(hz), lin(0x991b1b)), V23.util._tinted];
            // a tinted smoke's entry taken back by a mortar (V2.2's 6 in use): the colour V2.2 left on that orb
            hz = cast(s3, 10);
            const pool = tacticalDirector.botHazardsPool, idx = pool.indexOf(hz);
            for (let i = 1; i < 6; i++) { pool[i].inUse = true; pool[i].endTime = gameNow() + 1e6; pool[i].startTime = gameNow() - i; }
            const a = __bot(2, sp[0], sp[1], 'armored');
            a.nextAbilityAt = 1; tacticalDirector.lastBotAbilityCastAt = -1e9;
            tacticalDirector.tryCastBotAbility(a, gameNow(), 10, 0, 1, 1, 0);
            out.smokeSteal = [idx, hz.type, eq(col(hz), lin(0x991b1b)), V23.util._tinted];
            for (const h of pool) { h.inUse = false; h.group.visible = false; }
        } finally {
            V23.core.resolve = realResolve;
            game.userSettings.agentIdentity = 'on';
            e.agentId = undefined;
        }
        // the mortar: the caster on the hazard and on the tick's source, never source.enemy; the arming sting from the
        // caster (inside V23.seeded), none once the caster's slot has respawned, none with identity off
        const m = __bot(2, sp[0], sp[1], 'armored');
        const src = [], realTake = window.takeDamage, cues = [], realCue = V23.audio.botCue;
        window.takeDamage = function (amount, pos, source) { src.push(source); };
        V23.audio.botCue = function (en, kind, h) { cues.push([en.slot, kind, typeof fxKit._rng === 'function' ? 1 : 0, arguments.length > 2 ? (h === hz ? 'hz' : 'other') : null]); };
        // the first update arms it, the second ticks (450 ms after arming) with you inside
        const arm = (h) => { for (let k = 0; k < 2; k++) tacticalDirector.updateBotAbilities(1 / 60, h.detonateAt + 500); };
        try {
            hz = cast(m, 10);
            arm(hz);
            out.mortar = [hz.type, hz.owner === m, hz.abilityId, hz.caster.enemy === m, hz.caster.archetype, src.length,
                src[0] && src[0].label, src[0] && src[0].caster === hz.caster, src[0] && ('enemy' in src[0])];
            out.armOn = cues.splice(0);
            hz = cast(m, 10);
            __bot(2, sp[0], sp[1], 'armored');
            arm(hz);
            out.armRespawn = cues.splice(0).map((c) => c[1]);
            // the caster killed before its mortar arms: no sting (it would come from a corpse)
            hz = cast(m, 10);
            m.hit = true;
            arm(hz);
            out.armDead = [hz.detonated, cues.splice(0).map((c) => c[1])];
            __bot(2, sp[0], sp[1], 'armored');
            game.userSettings.agentIdentity = 'off';
            hz = cast(m, 10);
            arm(hz);
            out.armOff = [hz.detonated, cues.splice(0).length];
        } finally {
            window.takeDamage = realTake;
            V23.audio.botCue = realCue;
            game.userSettings.agentIdentity = 'on';
        }
        // the Ranked pin: 'classic' for the match without touching the saved setting
        const u = game.userSettings, diff = u.botDifficulty;
        u.botUtility = 'agent';
        const pin = [V23.util.poolLimit()];
        rankedLadder.onMatchStart();
        pin.push(V23.util.poolLimit(), u.botUtility);
        rankedLadder.restoreDifficulty();
        pin.push(V23.util.poolLimit(), u.botDifficulty === diff);
        u.botUtility = 'classic';
        pin.push(V23.util.poolLimit());
        out.pin = pin;
        // a flash in flight for the frames below
        cast(e);
        return out;
    });
    assert.deepEqual(r.dash, [1, true], 'botDash ages on game time');
    assert.deepEqual(r.flash, ['flash', true, 'bot.flash', true, true, true, true, true]);
    assert.equal(r.tint, true, 'a built look tints the flash orb with its glow');
    assert.equal(r.stubTint, true, 'a stub look keeps V2.2\'s colour');
    assert.deepEqual(r.smoke, ['smoke', true, true, 3.4], 'the smoke: half the caster\'s glow, lobbed from the hand at V2.2\'s scale');
    assert.deepEqual(r.smokeMid, [true, 3.4], 'in flight only the offset moves (design 10)');
    assert.deepEqual(r.smokeLanded, [0, 3.4], 'the lob lands at V2.2\'s point and scale');
    assert.deepEqual(r.offFlight, [true, 0], 'identity off mid-flight: the orb lands on V2.2\'s point at once');
    assert.deepEqual(r.off, [0, true, 0], 'identity off: no flight, V2.2\'s colour, no windup calls');
    assert.deepEqual(r.smokeOff, [true, true, true, 0], 'identity off with a tinted smoke live: V2.2\'s crimson back on the next update');
    assert.deepEqual(r.flashOff, [true, true, false, 0], 'identity off with a tinted flash before its pop: V2.2\'s amber back');
    assert.deepEqual(r.flashPop, [true, true, 0], 'a tinted flash pops V2.2\'s white; its tint ends');
    assert.deepEqual(r.smokeEnd, [false, true, 0], 'a tinted smoke\'s entry ends: V2.2\'s crimson back');
    assert.deepEqual(r.smokeSteal, [0, 'mortar', true, 0], 'a tinted smoke\'s entry taken by a mortar: the colour V2.2 left on that orb');
    assert.deepEqual(r.mortar, ['mortar', true, 'bot.mortar', true, 'armored', 1, 'Incendiary Mortar', true, false], 'the mortar tick names its caster, never source.enemy');
    assert.deepEqual(r.armOn, [[2, 'cast.mortar', 1, null], [2, 'arm.mortar', 1, 'hz']], 'the cast cue, then the arming sting from the caster with its hazard, both seeded');
    assert.deepEqual(r.armRespawn, ['cast.mortar'], 'no arming sting from a slot that has respawned');
    assert.deepEqual(r.armDead, [true, ['cast.mortar']], 'no arming sting from a dead caster');
    assert.deepEqual(r.armOff, [true, 0], 'identity off: the mortar arms with no cue');
    assert.deepEqual(r.pin, [10, 6, 'agent', 10, true, 6], 'Ranked pins classic for the match; the setting itself is untouched');

    // the orb flies over real frames with no new program and no stall
    await frames(30);
    const [programs, watermark, stalls] = await programState(page);
    assert.equal(programs, watermark, 'no new shader program');
    assert.equal(stalls, 0, 'no first-use stall');
    assert.deepEqual(errors, []);
});
