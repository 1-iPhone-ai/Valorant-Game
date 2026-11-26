'use strict';
// V2.2: the High Fidelity test kit (abilityLook). Each role's test file uses it to boot into High
// Fidelity, cast an ability by key, log what draws it, and check the rules every conversion keeps:
// only bound items lose their Classic look, colliders and shot proxies stay, nothing compiles in
// play, and the cost stays inside the budget measured from the ten proof abilities.
//
//   const kit = require('./hifi-kit');
//   const g = await kit.bootHifi();                  // High Fidelity, bots frozen, casts never run out
//   await kit.cast(g, 'viper.e');                    // the RECIPES entry: spot, aim, second press, target
//   assert.deepEqual(await kit.waitBound(g, ['viper.e>wall']), []);
//   assert.deepEqual(await kit.checkHidden(g), []);
//   assert.deepEqual(await kit.checkNoCompile(g), []);
const { boot, programState } = require('./harness');

// Where each ability is cast from and what it needs. Default: from (0, 1.7, 22) on Ascent, looking
// along -Z and a little down (pitch -0.3), one press.
//   at: eye position; aim: [pitch, yaw]; again: press the same key again after this many ms of game
//   time (two-stage abilities); fire: shots fired (left click) after the press, every fireMs;
//   target: put an enemy at [x, z] (absolute; bots are frozen by bootHifi); orb: drop a soul orb at
//   [x, z] first (Reyna); xFire: X is pressed a second time at once (ultimates that fire on X).
const SPOT = [0, 1.7, 22];
const RECIPES = {
    // Duelists
    'jett.c': {}, 'jett.q': {}, 'jett.e': {}, 'jett.x': {},
    'phoenix.c': {}, 'phoenix.q': {}, 'phoenix.e': { target: [0, 20] }, 'phoenix.x': {},
    'reyna.c': { target: [0, 12] }, 'reyna.q': { orb: [1.5, 20] }, 'reyna.e': { orb: [1.5, 20] }, 'reyna.x': {},
    'raze.c': { target: [0, 12] }, 'raze.q': {}, 'raze.e': {}, 'raze.x': { xFire: true, at: [-40, 1.7, 0], aim: [0.02, Math.PI] },
    'yoru.c': { target: [0, 14] }, 'yoru.q': {}, 'yoru.e': { again: 1600 }, 'yoru.x': {},
    'neon.c': {}, 'neon.q': {}, 'neon.e': {}, 'neon.x': { fire: 6, fireMs: 120, target: [0, 12] },
    'iso.c': { target: [0, 14] }, 'iso.q': { target: [0, 14] }, 'iso.e': {}, 'iso.x': { target: [0, 18], aim: [-0.05, 0] },
    'waylay.c': {}, 'waylay.q': {}, 'waylay.e': { again: 1600 }, 'waylay.x': {},
    // Controllers
    'omen.c': { aim: [-0.15, 0] }, 'omen.q': { target: [0, 12] }, 'omen.e': {}, 'omen.x': {},
    'brimstone.c': {}, 'brimstone.q': {}, 'brimstone.e': {}, 'brimstone.x': {},
    'viper.c': {}, 'viper.q': {}, 'viper.e': {}, 'viper.x': {},
    'clove.c': {}, 'clove.q': {}, 'clove.e': {}, 'clove.x': {},
    'harbor.c': {}, 'harbor.q': {}, 'harbor.e': {}, 'harbor.x': {},
    'astra.c': {}, 'astra.q': {}, 'astra.e': {}, 'astra.x': {},
    'miks.c': {}, 'miks.q': {}, 'miks.e': {}, 'miks.x': {},
    // Initiators
    'sova.c': {}, 'sova.q': {}, 'sova.e': {}, 'sova.x': { xFire: true },
    'kayo.c': {}, 'kayo.q': {}, 'kayo.e': {}, 'kayo.x': {},
    'skye.c': {}, 'skye.q': { target: [0, 12] }, 'skye.e': { again: 700 }, 'skye.x': { target: [0, 12] },
    'fade.c': { target: [0, 13] }, 'fade.q': {}, 'fade.e': {}, 'fade.x': {},
    'breach.c': {}, 'breach.q': {}, 'breach.e': {}, 'breach.x': {},
    'gekko.c': {}, 'gekko.q': { target: [0, 12] }, 'gekko.e': { target: [0, 14] }, 'gekko.x': { again: 1500 },
    'tejo.c': { again: 1500 }, 'tejo.q': {}, 'tejo.e': {}, 'tejo.x': {},
    // Sentinels
    'sage.c': {}, 'sage.q': {}, 'sage.e': {}, 'sage.x': {},
    'killjoy.c': {}, 'killjoy.q': { target: [0, 12] }, 'killjoy.e': { target: [0, 8] }, 'killjoy.x': {},
    'cypher.c': { target: [0, 16] }, 'cypher.q': {}, 'cypher.e': { target: [0, 12] }, 'cypher.x': {},
    'chamber.c': { target: [0, 14] }, 'chamber.q': { target: [0, 12], aim: [-0.08, 0] }, 'chamber.e': { again: 1600 }, 'chamber.x': { xFire: true, target: [0, 12], aim: [-0.08, 0] },
    'deadlock.c': {}, 'deadlock.q': { target: [0, 12] }, 'deadlock.e': {}, 'deadlock.x': { target: [0, 12], aim: [-0.08, 0] },
    'vyse.c': { target: [0, 17] }, 'vyse.q': { again: 1400 }, 'vyse.e': {}, 'vyse.x': {},
    'veto.c': { again: 1600 }, 'veto.q': {}, 'veto.e': { target: [0, 12] }, 'veto.x': {}
};

/** Boot the game (Medium by default) in High Fidelity, bots frozen, wingmen off; pass look: 'classic' to stay Classic */
async function bootHifi(options = {}) {
    const g = await boot(Object.assign({ quality: 'medium' }, options));
    await g.evaluate((freeze) => {
        if (freeze) { window.updateEnemies = () => {}; try { tacticalEnhancements.toggleWingmanAI(false); } catch (e) {} }
        game.userSettings.infiniteAbilities = true;
        game.userSettings.infiniteUlt = true;
    }, options.freezeBots !== false);
    if (options.look !== 'classic') await setLook(g, 'hifi');
    return g;
}

/** Switch the Ability Effects setting ('hifi' | 'classic' | 'auto') and wait for High Fidelity when asked */
async function setLook(g, look) {
    await g.evaluate((look) => { game.userSettings.abilityEffects = look; abilityLook.refresh(); }, look);
    if (look === 'hifi') await g.page.waitForFunction(() => abilityLook.mode === 'hifi', null, { timeout: 180000 });
    else await g.frames(2);
}

/**
 * Log every binding as 'key>renderer' in window.__bound (and keep the casts from running out); count
 * High Fidelity's meshes drawn every frame and keep the most in window.__hfPeak (clear() resets it), so
 * a pop shorter than a frame or two here is measured too
 */
async function instrument(g) {
    await g.evaluate(() => {
        game.userSettings.infiniteAbilities = true;
        game.userSettings.infiniteUlt = true;
        window.__bound = new Set();
        window.__hfPeak = 0;
        if (!window.__kitPeakLoop) {
            window.__kitPeakLoop = true;
            let n = 0;
            const vis = (o) => { if (!o.visible) return; if (o.isMesh || o.isLine || o.isPoints) n++; for (let i = 0; i < o.children.length; i++) vis(o.children[i]); };
            const tick = () => {
                if (abilityLook.root && abilityLook.mode === 'hifi') {
                    n = 0;
                    vis(abilityLook.root);
                    if (abilityLook.vmRoot && abilityLook.vmRoot.visible) vis(abilityLook.vmRoot);
                    if (n > window.__hfPeak) window.__hfPeak = n;
                }
                requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
        }
        if (abilityLook.__kitBind) return;
        const bind = abilityLook.bind;
        abilityLook.__kitBind = bind;
        abilityLook.bind = function (it, kind, key, now) {
            const b = bind.call(this, it, kind, key, now);
            if (b) {
                __bound.add(key + '>' + this.route(kind, key));
                for (let i = 0; i < (b.nparts || 0); i++) __bound.add(key + '>' + b.parts[i].route.renderer);   // more renderers on one item
            }
            return b;
        };
    });
}

/**
 * Cast one ability by key with its RECIPES entry (or opts: the same fields). Waits for a second
 * press, shots and so on. Returns null, or the error the cast threw.
 */
async function cast(g, key, opts) {
    const r = Object.assign({}, RECIPES[key] || {}, opts || {});
    const err = await g.evaluate(([key, r, SPOT]) => {
        try {
            const [agent, slot] = key.split('.');
            game.userSettings.infiniteAbilities = true;
            game.userSettings.infiniteUlt = true;
            agentSystem.selectAgent(agent);
            if (slot === 'x' || r.resetUlt !== false) { game.ultActiveUntil = 0; game.ultAgent = null; game.ultChargesLeft = 0; }
            // no gesture still playing (a cast never cuts into an ultimate's)
            if (castFX.active) { castFX.active = null; castFX.hide(); }
            const at = r.at || SPOT, aim = r.aim || [-0.3, 0];
            const cc = characterController;
            cc.position.set(at[0], at[1], at[2]);
            cc.prevSimPosition.copy(cc.position);
            camera.position.copy(cc.position);   // casts start at the camera, which follows the player next frame
            camera.rotation.set(aim[0], aim[1], 0, 'YXZ');
            if (cc.targetRotation) cc.targetRotation.y = aim[1];
            if (r.target) {
                const e = window.__kitTarget && window.__kitTarget.isActive && !window.__kitTarget.hit ? window.__kitTarget
                    : enemyObjects.find((x) => x.isActive && !x.hit);
                if (e) {
                    window.__kitTarget = e;
                    e.mesh.position.set(r.target[0], 0, r.target[1]);
                    e.poseDirty = true;
                    // bots are frozen, so no enemy update files the moved one again where shots look for actors
                    syncEnemyBroadphase(e);
                }
            }
            if (r.orb) agentSystem.onActorEliminated('enemy', new THREE.Vector3(r.orb[0], 0, r.orb[1]));
            if (slot === 'x') { game.ultPoints = game.maxUltPoints; agentSystem.castAbility('x'); if (r.xFire) agentSystem.castAbility('x'); }
            else agentSystem.castAbility(slot);
            window.__kitCastAt = gameNow();
            return null;
        } catch (e) { return e.message + ' @ ' + (e.stack || '').split('\n')[1]; }
    }, [key, r, SPOT]);
    if (err) return err;
    if (r.fire) {
        for (let i = 0; i < r.fire; i++) {
            await g.page.waitForFunction((ms) => gameNow() - window.__kitCastAt >= ms, (i + 1) * (r.fireMs || 120), { timeout: 60000, polling: 20 });
            await g.evaluate(() => { game.lastShot = 0; shoot(); });
        }
    }
    if (r.again) {
        await g.page.waitForFunction((ms) => gameNow() - window.__kitCastAt >= ms, r.again, { timeout: 60000, polling: 20 });
        const e2 = await g.evaluate((key) => { try { agentSystem.castAbility(key.split('.')[1]); return null; } catch (e) { return e.message; } }, key);
        if (e2) return e2;
    }
    return null;
}

/** Wait (up to timeoutMs) until every 'key>renderer' pair is logged; returns the ones still missing */
async function waitBound(g, pairs, timeoutMs = 45000) {
    await g.page.waitForFunction((pairs) => pairs.every((k) => __bound.has(k)), pairs, { timeout: timeoutMs, polling: 50 }).catch(() => {});
    return g.evaluate((pairs) => pairs.filter((k) => !__bound.has(k)), pairs);
}

/** Wait until gameNow() has moved on by ms (game time; it stands still while paused) */
async function waitGame(g, ms) {
    const t0 = await g.evaluate(() => gameNow());
    await g.page.waitForFunction(([t0, ms]) => gameNow() - t0 >= ms, [t0, ms], { timeout: 120000, polling: 20 });
}

/** End every ability item that is out (through the normal update paths) and the ultimate */
async function clear(g) {
    await g.evaluate(() => {
        game.ultActiveUntil = 0; game.ultAgent = null; game.ultChargesLeft = 0;
        const end = (it) => {
            if (!it || typeof it !== 'object' || it.isObject3D) return;
            if ('expireAt' in it) it.expireAt = 1;
            if ('endTime' in it) it.endTime = 1;
        };
        // every pooled list and single object of agentSystem, and the bots' hazards
        const A = agentSystem;
        for (const k of Object.keys(A)) {
            const v = A[k];
            if (Array.isArray(v)) { for (const it of v) if (it && typeof it === 'object' && ('inUse' in it || 'active' in it)) end(it); }
            else if (v && typeof v === 'object' && ('inUse' in v || 'active' in v)) end(v);
        }
        for (const h of (tacticalDirector.botHazardsPool || [])) end(h);
        for (const p of A.projectiles) if (p.inUse) { p.inUse = false; p.mesh.visible = false; }
        for (const k of ['neonHighGearUntil', 'isoDoubleTapUntil', 'clovePickMeUpUntil', 'waylayLightspeedUntil', 'miksHarmonizeUntil', 'reynaDismissUntil', 'brimStimUntil']) if (typeof A[k] === 'number') A[k] = 0;
        // High Fidelity's own tails (blasts, flashes, dashes) and scorch marks go too (the next scan binds what is still out)
        if (typeof abilityLook !== 'undefined' && abilityLook.state === 'ready' && abilityLook.unbindAll) {
            abilityLook.unbindAll();
            for (const s of (abilityLook.scorchPool || [])) s.mesh.visible = false;
        }
    });
    await g.frames(4);
    await g.evaluate(() => { window.__hfPeak = 0; });   // the next cast's peak starts here
}

/**
 * The look's rules while abilities are out (returns a list of problems; [] when all hold):
 *  - a hidden Classic material belongs only to bound items (nothing unbound loses its look);
 *  - every bound item's Classic materials are hidden;
 *  - colliders and shot proxies stay (their meshes visible, the proxy still the item's own).
 */
async function checkHidden(g) {
    return g.evaluate(() => {
        const problems = [];
        const owners = new Map();   // material -> items using it
        const each = (fn) => {
            for (const s of abilityLook.allSources()) {
                const items = s.list ? s.list() : [s.one ? s.one() : null];
                if (!items) continue;
                for (const it of items) if (it && typeof it === 'object') fn(it, s.kind);
            }
        };
        each((it) => {
            for (const f in it) {
                const o = it[f];
                if (!o || !o.isObject3D || f === '_hf') continue;
                o.traverse((c) => { if (c.material) { const ms = Array.isArray(c.material) ? c.material : [c.material]; for (const m of ms) { if (!owners.has(m)) owners.set(m, new Set()); owners.get(m).add(it); } } });
            }
        });
        for (const [m, items] of owners) {
            if (m.visible !== false) continue;
            for (const it of items) {
                const on = it._hf && it._hf.on;
                if (!on && !(it._hfMats && it._hfMats.indexOf(m) >= 0 && it._hf && it._hf.on)) problems.push('hidden material of an unbound item (' + (m.name || m.type) + ')');
            }
        }
        each((it, kind) => {
            if (!(it._hf && it._hf.on)) return;
            for (const m of it._hf.mats) if (m.visible !== false) problems.push(kind + ' ' + it._hf.key + ': a Classic material still drawn');
            if ('collider' in it && it.inUse && it.collider === undefined) problems.push(kind + ' ' + it._hf.key + ': collider gone');
            if (it.shotPiece && it.shotPiece.proxy && !it.shotPiece.proxy.visible) problems.push(kind + ' ' + it._hf.key + ': shot proxy mesh hidden');
        });
        return [...new Set(problems)];
    });
}

/** No shader compiled outside the warm steps (returns problems; [] when it holds) */
async function checkNoCompile(g) {
    const [programs, watermark, stalls] = await programState(g.page);
    const out = [];
    if (programs !== watermark) out.push(`programs ${programs} != watermark ${watermark}`);
    if (stalls) out.push(`${stalls} first-use stalls`);
    return out;
}

/**
 * Cost of a set of abilities out at once, the same scene in both looks: draw calls per frame
 * (renderer.info.render.calls, the median) and frame CPU time (ms, the game's own per-callback
 * measure; the mean of the middle half, as this browser's timer ticks in 0.1 ms) over `frames`
 * frames. Each look casts the set from a clean state (kit.clear between).
 * Returns { classic: {calls, cpu}, hifi: {calls, cpu}, delta: {calls, cpu} }.
 */
async function measure(g, keys, options = {}) {
    const frames = options.frames || 36, settleMs = options.settleMs || 900;
    const sample = async (look) => {
        await setLook(g, look);
        await clear(g);
        for (const k of keys) {
            const e = await cast(g, k, options.recipes && options.recipes[k]);
            if (e) throw new Error(k + ': ' + e);
        }
        await waitGame(g, settleMs);
        await g.evaluate(() => {
            window.__kitCost = { calls: [], cpu: [] };
            if (!perfTelemetry.__kitRecord) {
                const rec = perfTelemetry.record;
                perfTelemetry.__kitRecord = rec;
                perfTelemetry.record = function (interval, cpu) {
                    if (window.__kitCost) { __kitCost.calls.push(renderer.info.render.calls); __kitCost.cpu.push(cpu); }
                    return rec.apply(this, arguments);
                };
            }
        });
        await g.frames(frames);
        return g.evaluate(() => {
            const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
            const mid = (a) => {
                const s = a.slice().sort((x, y) => x - y), q = s.length >> 2, m = s.slice(q, s.length - q);
                return m.length ? m.reduce((x, y) => x + y, 0) / m.length : 0;
            };
            const out = { calls: med(__kitCost.calls), cpu: +mid(__kitCost.cpu).toFixed(3), n: __kitCost.calls.length };
            window.__kitCost = null;
            return out;
        });
    };
    const classic = await sample('classic');
    const hifi = await sample('hifi');
    await clear(g);
    return { classic, hifi, delta: { calls: hifi.calls - classic.calls, cpu: +(hifi.cpu - classic.cpu).toFixed(3) } };
}

/**
 * A still picture of the world for a look check: photo mode freezes game time, the free camera
 * goes to `from` looking at `to`, the HUD and the gun are hidden (gun: true keeps the gun).
 */
async function photo(g, path, from, to, options = {}) {
    await g.evaluate(([from, to, gun]) => {
        photoMode.enter();
        photoMode.panelHidden = true;
        photoMode.hideGun = !gun;
        photoMode.render && photoMode.render();
        camera.position.set(from[0], from[1], from[2]);
        const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
        photoMode.yaw = Math.atan2(-dx, -dz);
        photoMode.pitch = Math.atan2(dy, Math.hypot(dx, dz));
    }, [from, to, !!options.gun]);
    await g.frames(3);
    await g.page.screenshot({ path });
    await g.evaluate(() => { photoMode.exit(); });
    await g.frames(1);
}

/**
 * What High Fidelity itself costs right now, without a Classic run: hf = its meshes drawn (each one
 * draw call), peak = the most it drew in one frame since the last clear() (instrument() counts every
 * frame: short pops included), classicHidden = Classic meshes it stopped drawing, update = the median
 * ms of abilityLook.update over `frames` frames. Cheap enough for every ability of a role.
 */
async function hfCost(g, frames = 6) {
    await g.evaluate(() => {
        window.__kitUpd = [];
        if (abilityLook.__kitUpdate) return;
        const up = abilityLook.update;
        abilityLook.__kitUpdate = up;
        abilityLook.update = function () {
            const t0 = performance.now();
            const r = up.apply(this, arguments);
            if (window.__kitUpd) __kitUpd.push(performance.now() - t0);
            return r;
        };
    });
    let hf = 0, hidden = 0;
    for (let i = 0; i < frames; i++) {
        await g.frames(1);
        const c = await g.evaluate(() => {
            let hf = 0, hidden = 0;
            const vis = (o) => { if (!o.visible) return; if (o.isMesh || o.isLine || o.isPoints) hf++; for (const c of o.children) vis(c); };
            if (abilityLook.root) vis(abilityLook.root);
            if (abilityLook.vmRoot && abilityLook.vmRoot.visible) vis(abilityLook.vmRoot);
            for (const s of abilityLook.allSources()) {
                const items = s.list ? s.list() : [s.one ? s.one() : null];
                if (!items) continue;
                for (const it of items) {
                    if (!it || !it._hf || !it._hf.on) continue;
                    const root = it.group || it.mesh;
                    if (root) root.traverse((o) => { if (o.isMesh && o.visible && o.material && o.material.visible === false) hidden++; });
                }
            }
            return { hf, hidden };
        });
        hf = Math.max(hf, c.hf); hidden = Math.max(hidden, c.hidden);
    }
    const [update, peak] = await g.evaluate(() => {
        const s = __kitUpd.slice().sort((a, b) => a - b);
        window.__kitUpd = null;
        return [s.length ? +s[s.length >> 1].toFixed(3) : 0, window.__hfPeak || 0];
    });
    return { hf, peak: Math.max(peak, hf), classicHidden: hidden, update };
}

// The relative budget (HIFI-CONTRACT.md), measured from the ten proof abilities on the test machine
// (Medium, 480 x 270, SwiftShader): one = the most expensive of the ten alone, ten = the ten out at
// once. calls: draw calls per frame added over Classic (renderer.info.render.calls, HF - Classic;
// kit.measure); cpu: frame CPU ms added; hf: High Fidelity meshes drawn at the ability's peak (hfCost's
// peak; for ten, the sum of the ten's); update: abilityLook.update ms (hfCost).
// A new ability must stay within one (roleTest checks hf and update); a whole role's converted set out
// at once within ten (roleTest checks calls and cpu).
const BUDGET = {
    one: { calls: 5, cpu: 1, hf: 15, update: 0.1 },
    ten: { calls: 15, cpu: 0, hf: 37, update: 0.9 },
    cpuSlack: 1.5,  // CPU on a shared software-GPU machine is noisy: a measure may run over by this factor
    cpuNoise: 1.0,  // frame CPU deltas this small are noise here (the ten's own are): the CPU budget is at least this
    timerMs: 0.2,   // performance.now() ticks in 0.1 ms in this browser: two ticks more on update times
    callsJitter: 3  // which short effects are still out in the frames measured varies a little: a few draws
};

/** A set measured with measure() against BUDGET.ten: the problems ([] when it is within) */
function overTen(m) {
    const out = [], B = BUDGET, cpu = Math.max(B.ten.cpu, B.cpuNoise) * B.cpuSlack;
    if (m.delta.calls > B.ten.calls + B.callsJitter) out.push(`${m.delta.calls} draw calls over Classic (budget ${B.ten.calls})`);
    if (m.delta.cpu > cpu) out.push(`${m.delta.cpu} ms of frame CPU over Classic (budget ${B.ten.cpu}, allowed ${cpu.toFixed(2)})`);
    return out;
}

/**
 * A role's test file in one call. Registers node:test tests that boot into High Fidelity and, for each
 * converted ability ({ key: ['key>renderer', ...] }):
 *  - cast it (RECIPES), wait until each part is drawn by its renderer;
 *  - only bound items lose their Classic look, colliders and shot proxies stay (checkHidden);
 *  - nothing compiles in play, no look problems (abilityLook.problems), no page errors;
 * the role's abilities that are not converted yet cast in High Fidelity and stay Classic; and the cost:
 * each ability alone within BUDGET.one (hfCost), the whole set out at once within BUDGET.ten (measure).
 * options.recipes: per-key RECIPES overrides; options.unconverted: false skips the Classic check.
 */
function roleTest(role, abilities, options = {}) {
    const { test, after } = require('node:test');
    const assert = require('node:assert/strict');
    const { closeBrowser } = require('./harness');
    after(closeBrowser);
    const keys = Object.keys(abilities);
    const recipe = (k) => options.recipes && options.recipes[k];
    test(`High Fidelity, ${role}: each converted ability is drawn by its renderers, hides only its Classic look, compiles nothing in play`, { timeout: 1800000 }, async (t) => {
        const g = await bootHifi();
        await instrument(g);
        const missing = [], hidden = [], costs = {};
        for (const k of keys) {
            await clear(g);
            assert.equal(await cast(g, k, recipe(k)), null, `${k} casts`);
            const m = await waitBound(g, abilities[k]);
            missing.push(...m);
            hidden.push(...(await checkHidden(g)).map((p) => k + ': ' + p));
            costs[k] = await hfCost(g);
            t.diagnostic(`${k}: ${JSON.stringify(costs[k])}`);
        }
        assert.deepEqual(missing, [], 'every part is drawn by its renderer');
        assert.deepEqual(hidden, [], 'only bound items lose their Classic look; colliders and shot proxies stay');
        for (const k of keys) {
            assert.ok(costs[k].peak <= BUDGET.one.hf, `${k}: ${costs[k].peak} High Fidelity draws at its peak (budget ${BUDGET.one.hf})`);
            assert.ok(costs[k].update <= BUDGET.one.update * BUDGET.cpuSlack + BUDGET.timerMs, `${k}: update ${costs[k].update} ms (budget ${BUDGET.one.update})`);
        }
        // the role's abilities that are not converted yet stay Classic in High Fidelity
        if (options.unconverted !== false) {
            const rest = await g.evaluate(([role, keys]) => {
                const out = [];
                for (const id of Object.keys(AGENT_DEFS)) {
                    if (AGENT_DEFS[id].role !== role) continue;
                    for (const s of ['c', 'q', 'e', 'x']) { const k = id + '.' + s; if (keys.indexOf(k) < 0 && !abilityLook.converted(k)) out.push(k); }
                }
                return out;
            }, [role.toUpperCase().replace(/S$/, ''), keys]);
            for (const k of rest) {
                await clear(g);
                assert.equal(await cast(g, k, recipe(k)), null, `${k} casts in High Fidelity`);
                await g.frames(3);
            }
            const drawn = await g.evaluate((rest) => [...__bound].filter((b) => rest.indexOf(b.split('>')[0]) >= 0), rest);
            assert.deepEqual(drawn, [], 'abilities not converted yet keep their Classic look');
        }
        assert.deepEqual(await checkNoCompile(g), [], 'no shader compiled outside the warm steps');
        assert.deepEqual(await g.evaluate(() => abilityLook.problems), [], 'no look problems (adapters, models)');
        assert.deepEqual(g.errors, []);
    });
    test(`High Fidelity, ${role}: the whole set out at once stays within the budget of the ten`, { timeout: 1800000 }, async (t) => {
        const g = await bootHifi();
        const m = await measure(g, keys, { recipes: options.recipes });
        t.diagnostic(`${role} set: ${JSON.stringify(m)}`);
        assert.deepEqual(overTen(m), [], 'the whole set out at once costs no more than the ten together');
        assert.deepEqual(await checkNoCompile(g), []);
        assert.deepEqual(g.errors, []);
    });
}

module.exports = { RECIPES, SPOT, BUDGET, overTen, bootHifi, setLook, instrument, cast, waitBound, waitGame, clear, checkHidden, checkNoCompile, measure, hfCost, photo, roleTest };
