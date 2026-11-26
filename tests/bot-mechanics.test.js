'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser, programState } = require('./harness');

after(closeBrowser);

// V2.2 Bots Use Map Mechanics (Settings > Custom & Cheats, with Bot Skill; off by default): with it on, bots take Bind's
// teleporters, climb Icebox's and Split's ropes to hold a deck, open Lotus's doors and (attacking) shoot
// its breakable wall open; with it off nothing about the bots changes.
//
// Each scenario runs in one evaluate: the bots' own update and the map mechanics at 60 Hz of simulated
// time, with the clocks and random numbers fixed for the run (so it plays the same every time), and the
// game's frames held off for its length.
const HELPERS = () => {
    // (t0: where the clock starts, the same in two builds compared against each other; it never runs
    // backwards from one run to the next)
    window.__det = (fn, t0) => {
        const realPerf = performance.now.bind(performance), realDate = Date.now, realRandom = Math.random;
        const T0 = Math.max(t0 !== undefined ? t0 : realPerf(), window.__simT || 0) + 1000;
        let el = 0, seed = 20221;
        performance.now = () => T0 + el;
        Date.now = () => 1.7e12 + T0 + el;
        Math.random = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
        const sim = (secs, done, every, match) => {
            for (let k = 0; k < secs * 60; k++) {
                game.health = 100; game.shield = 50; game.isDead = false;
                el += 1000 / 60;
                const now = T0 + el;
                updateEnemies(now, 1 / 60);
                if (match) { matchMode.update(1 / 60, now); tacticalDirector.updateSpikeSystem(1 / 60, now); }
                tacticalEnhancements.updateMapMechanics(1 / 60, now);
                if (every) every(k, el / 1000);
                if (done && done()) return el / 1000;
            }
            return -1;
        };
        try { return fn(sim, () => T0 + el); } finally {
            performance.now = realPerf; Date.now = realDate; Math.random = realRandom;
            window.__simT = T0 + el;
        }
    };
    // You at (x, z) (y: your eye height above the floor, standing by default)
    window.__put = (x, z, y) => {
        const cc = characterController;
        cc.position.set(x, y === undefined ? cc.standHeight : y, z); cc.prevSimPosition.copy(cc.position); cc.velocity.set(0, 0, 0);
    };
    // One bot left at (x, z); the others out of the round
    window.__solo = (x, z, arch) => {
        const e = enemyObjects.find((o) => o.isActive && !o.hit) || enemyObjects[0];
        for (const o of enemyObjects) if (o !== e) { o.isActive = false; o.hit = true; o.renderActive = false; if (o.broadKeys) actorBroadphase.remove(o); }
        activateEnemy(e, x, 0, z, arch || 'standard');
        return e;
    };
    // A Match round on map, live: the bots attacking (they plant at key) or defending
    window.__match = (map, bots, key) => {
        tacticalEnhancements.toggleWingmanAI(false);
        if (game.mapPreset !== map) rebuildMapPreset(map);
        tacticalDirector.setGameMode('match');
        game.botAbilityAI = false;
        matchMode.round = bots === 'attack' ? 6 : 0;
        matchMode.startRound(performance.now());
        if (key) matchMode.plantSiteKey = key;
        matchMode.phase = 'live';
        matchMode.phaseEndsAt = performance.now() + matchMode.cfg.roundMs;
    };
    // You shut a door as you do ([F] beside it) and it turns all the way
    window.__shut = (d) => {
        const te = tacticalEnhancements;
        __put(d.x, d.z + 4);
        game.keys.f = true; te.lastInteractFAt = -1e12;
        te.updateMapMechanics(1 / 60, performance.now());
        game.keys.f = false;
        for (let i = 0; i < 400 && d.turning; i++) te.updateMapMechanics(1 / 60, performance.now());
        return !d.isOpen && !d.turning;
    };
};

// The scenarios, run with the setting on and off
const SCENARIOS = () => {
    // Bind: a bot by a pad whose goal (the plant site) is past the pad's exit
    window.__bindPad = (pad) => __det((sim) => {
        const key = pad === 0 ? 'B' : 'A';
        __match('bind', 'attack', key);
        const L = mapLayout(), tp = L.teleporters[pad], goal = matchMode.botGoal();
        const start = pad === 0 ? [-24.5, -42] : [-22.5, 42];
        const e = __solo(start[0], start[1]);
        __put(L.spawns.defend.x, L.spawns.defend.z);
        const out = {
            walk: navGrid.routeLength(start[0], start[1], goal.x, goal.z),
            byPad: navGrid.routeLength(start[0], start[1], tp.from.x, tp.from.z) + navGrid.routeLength(tp.to.x, tp.to.z, goal.x, goal.z),
            jumps: [], exitSounds: 0, placedAt: null, flashes: 0, maxY: 0, anim: 0, states: 0
        };
        const realExit = soundFX.teleporterExit, realFlash = haloSystem.flash, realAt = soundFX.at;
        let at = null;
        soundFX.at = function (x, y, z) { at = [x, z]; return realAt.apply(this, arguments); };
        soundFX.teleporterExit = function () { out.exitSounds++; out.placedAt = at; return realExit.apply(this, arguments); };
        haloSystem.flash = function (x, y, z, hex) { if (hex === tp.color) out.flashes++; return realFlash.apply(this, arguments); };
        let px = e.mesh.position.x, pz = e.mesh.position.z;
        try {
            out.secs = sim(90, () => Math.hypot(e.mesh.position.x - goal.x, e.mesh.position.z - goal.z) < 2.8, (k, t) => {
                const p = e.mesh.position;
                if (Math.hypot(p.x - px, p.z - pz) > 3) out.jumps.push({ t, from: [px, pz], to: [p.x, p.z], yaw: e.mesh.rotation.y, readyIn: e.mechTpReadyAt - performance.now() });
                if (p.y > out.maxY) out.maxY = p.y;
                if (e.animAction) out.anim++;
                if (e.mechState) out.states++;
                px = p.x; pz = p.z;
            });
        } finally { soundFX.teleporterExit = realExit; haloSystem.flash = realFlash; soundFX.at = realAt; }
        out.tp = { from: [tp.from.x, tp.from.z], to: [tp.to.x, tp.to.z], yaw: tp.to.yaw };
        return out;
    });
    // Lotus: a door shut on a bot's way to the plant site (Lion Gate to A, Serpent Gate to C)
    window.__lotusDoor = (di) => __det((sim) => {
        const key = di === 0 ? 'A' : 'C';
        __match('lotus', 'attack', key);
        const te = tacticalEnhancements, d = te.lotusDoors[di], L = mapLayout(), goal = matchMode.botGoal();
        const out = { shut: __shut(d) };
        const start = di === 0 ? [-26, -12] : [-20, 12];
        const e = __solo(start[0], start[1]);
        __put(L.spawns.defend.x, L.spawns.defend.z);
        const alongZ = d.cfg.axis === 'z', u = (p) => alongZ ? p.z - d.z : p.x - d.x, lat = (p) => alongZ ? p.x - d.x : p.z - d.z;
        const s0 = Math.sign(u(e.mesh.position));
        Object.assign(out, { walk: navGrid.routeLength(start[0], start[1], goal.x, goal.z), push: 0, pushWhileTurning: 0, openedAt: null, through: null, everOpen: false, maxY: 0, climb: 0 });
        out.secs = sim(90, () => Math.hypot(e.mesh.position.x - goal.x, e.mesh.position.z - goal.z) < 2.8, (k, t) => {
            const p = e.mesh.position;
            if (e.animAction === 'push') { out.push++; if (d.turning) out.pushWhileTurning++; }
            if (e.animAction === 'climb') out.climb++;
            if (d.isOpen) { out.everOpen = true; if (out.openedAt === null && !d.turning) out.openedAt = t; }
            if (out.through === null && Math.sign(u(p)) !== s0 && Math.abs(lat(p)) < d.cfg.len / 2 && Math.abs(u(p)) < 1.5) out.through = t;
            if (p.y > out.maxY) out.maxY = p.y;
        });
        out.doorNow = [d.isOpen, d.turning];
        return out;
    });
    // Lotus in Wave (the bots defend): a bot rushing the spike at A walks through Lion Gate, open; it may
    // shut it behind it (every time here)
    window.__lotusClose = () => __det((sim) => {
        tacticalEnhancements.toggleWingmanAI(false);
        game.botAbilityAI = false;
        tacticalDirector.setGameMode('wave');
        if (game.mapPreset !== 'lotus') rebuildMapPreset('lotus');
        tacticalEnhancements.resetMapMechanics();
        const te = tacticalEnhancements, d = te.lotusDoors[0], td = tacticalDirector;
        const e = __solo(-26, -12);
        td.spikeState = 'planted';
        td.activeSpikeSitePos.set(9, 0, -41);
        __put(-5, -20);   // (in the rock between the lanes: in range, never in sight)
        const chance = BOT_MECH.closeChance;
        BOT_MECH.closeChance = 1;
        const out = { open: d.isOpen && !d.turning, push: 0, through: null, shutAt: null };
        try {
            out.secs = sim(40, () => Math.hypot(e.mesh.position.x - 9, e.mesh.position.z + 41) < 3, (k, t) => {
                const p = e.mesh.position;
                if (e.animAction === 'push') out.push++;
                if (out.through === null && p.z < d.z - 1 && Math.abs(p.x - d.x) < 3) out.through = t;
                if (out.shutAt === null && !d.isOpen) out.shutAt = { t, z: p.z, clearOfSweep: Math.max(Math.abs(p.x - d.x), Math.abs(p.z - d.z)) > d.cfg.len / 2 + 0.68 };
            });
        } finally { BOT_MECH.closeChance = chance; td.spikeState = 'unplanted'; }
        out.door = [d.isOpen, d.turning];
        return out;
    });
    // Lotus: the bots planted at A; an attacker on A hunts you in the Bell Loft, past the Incense Wall
    window.__lotusWall = () => __det((sim) => {
        __match('lotus', 'attack', 'A');
        const te = tacticalEnhancements, w = te.breakWall;
        const e = __solo(12, -36);
        tacticalDirector.matchBotPlant('A', performance.now());
        __put(34, -19.5);
        const out = { whole: !w.broken, goal: matchMode.botGoal(), walk: navGrid.routeLength(12, -36, 34, -19.5), hits: 0, brokeAt: null, through: null, seenAt: null, maxX: -99, maxY: 0, anim: 0 };
        const real = te.damageBreakWall;
        te.damageBreakWall = function () { out.hits++; return real.apply(this, arguments); };
        try {
            out.secs = sim(70, () => out.seenAt !== null && (out.through !== null || out.maxX > 38), (k, t) => {
                const p = e.mesh.position;
                if (out.brokeAt === null && w.broken) out.brokeAt = t;
                if (out.through === null && p.z > -24 && p.x > 17.5 && p.x < 22.5) out.through = t;
                if (out.seenAt === null && e.hasSight) out.seenAt = t;
                if (p.x > out.maxX) out.maxX = p.x;
                if (p.y > out.maxY) out.maxY = p.y;
                if (e.animAction) out.anim++;
            });
        } finally { te.damageBreakWall = real; }
        out.broken = w.broken;
        return out;
    });
};

test('Bots Use Map Mechanics is OFF by default, sits with Bot Skill and is saved when switched', { timeout: 240000 }, async () => {
    const { errors, evaluate } = await boot({ quality: 'low' });
    const r = await evaluate(() => {
        const out = {
            setting: game.userSettings.botMechanics, fallback: DEFAULT_USER_SETTINGS.botMechanics, enabled: botMechanics.enabled(),
            pill: document.querySelector('#setting-bot-mech-pills .active').dataset.botmech,
            withBotSkill: document.getElementById('setting-bot-mech-pills').closest('.settings-section-box') === document.getElementById('setting-bot-diff-pills').closest('.settings-section-box'),
            bots: enemyObjects.every((e) => e.animAction === null && e.animActionAt === 0 && e.mechState === null)
        };
        const saved = () => JSON.parse(localStorage.getItem('valorant_v16_user_settings') || '{}').botMechanics;
        document.querySelector('#setting-bot-mech-pills [data-botmech="on"]').click();
        out.on = [game.userSettings.botMechanics, botMechanics.enabled(), saved()];
        document.querySelector('#setting-bot-mech-pills [data-botmech="off"]').click();
        out.off = [game.userSettings.botMechanics, botMechanics.enabled(), saved()];
        game.userSettings.botMechanics = 'on';
        settingsManager.syncAllUI();
        out.synced = document.querySelector('#setting-bot-mech-pills .active').dataset.botmech;
        game.userSettings.botMechanics = 'off';
        settingsManager.syncAllUI();
        return out;
    });
    assert.deepEqual([r.setting, r.fallback, r.enabled, r.pill], ['off', 'off', false, 'off'], 'off by default (and for older saves)');
    assert.equal(r.withBotSkill, true, 'in the bot section, with Bot Skill');
    assert.equal(r.bots, true, 'every bot starts with animAction null, animActionAt 0 and no move');
    assert.deepEqual(r.on, ['on', true, 'on'], 'switched on and saved');
    assert.deepEqual(r.off, ['off', false, 'off'], 'switched off and saved');
    assert.equal(r.synced, 'on', 'the panel shows the setting');
    assert.deepEqual(errors, []);
});

test('ON: Icebox and Split ropes: a bot climbs each at your speed to its deck, holds it (its hit boxes and culling box with it, shooting what it sees), then comes back down; one defender a round takes a deck by itself and comes down at the plant', { timeout: 600000 }, async () => {
    const { page, errors, frames, evaluate } = await boot({ quality: 'low' });
    await evaluate(HELPERS);
    const runs = [];
    for (const map of ['icebox', 'split']) {
        const n = await evaluate((map) => { tacticalDirector.setGameMode('wave'); rebuildMapPreset(map); return mapLayout().ropes.length; }, map);
        for (let r = 0; r < n; r++) {
            runs.push(await evaluate(([map, r]) => __det((sim) => {
                game.userSettings.botMechanics = 'on';
                // A Match round with the bots attacking (one left): you far off at the defenders' spawn
                __match(map, 'attack', 'A');
                const L = mapLayout(), rope = L.ropes[r], deck = rope.topY - 0.2, foot = botMechanics._foot(L, r);
                // Start 6-14 m (by route) from the rope's foot, on open floor
                let start = null;
                for (let a = 0; a < 16 && !start; a++) for (const rad of [9, 12, 7]) {
                    const x = foot.x + Math.cos(a * Math.PI / 8) * rad, z = foot.z + Math.sin(a * Math.PI / 8) * rad;
                    if (resolveEnemyMapCollision(new THREE.Vector3(x, 0, z), 0.75, true)) continue;
                    const len = navGrid.routeLength(x, z, foot.x, foot.z);
                    if (len > 6 && len < 14) { start = [x, z]; break; }
                }
                if (!start) return { map, rope: rope.name, start };
                const e = __solo(start[0], start[1]);
                __put(L.spawns.defend.x, L.spawns.defend.z);
                const realShoot = window.enemyShoot;
                const out = { map, rope: rope.name, deck, start, sent: botMechanics.sendToRope(e, r, 2500), maxY: 0, climbTicks: 0, climbOffRope: 0, climbState: 0, deckTicks: 0, shotsOnDeck: 0, faced: null, states: [] };
                window.enemyShoot = (b) => { if (b === e && Math.abs(b.mesh.position.y - deck) < 1e-6) out.shotsOnDeck++; return realShoot(b); };
                let lastY = -1, last = null, shown = 0;
                try {
                    out.secs = sim(40, () => out.maxY > deck - 0.01 && e.mechState === null && e.mesh.position.y === 0, (k, t) => {
                        const p = e.mesh.position;
                        if (p.y > out.maxY) out.maxY = p.y;
                        if (e.animAction === 'climb') {
                            out.climbTicks++;
                            if (Math.hypot(p.x - rope.x, p.z - rope.z) > 0.6) out.climbOffRope++;
                        }
                        // (it reaches the cable on its first climbing tick and rises from the next)
                        if (e.mechState === 'climb') { if (out.climbState > 0 && p.y <= lastY) out.climbStalled = true; out.climbState++; }
                        if (Math.abs(p.y - deck) < 1e-6) out.deckTicks++;
                        if (e.mechState !== last) { out.states.push(e.mechState); last = e.mechState; }
                        // Once it holds the deck you step into its view at its height (it turns to you and
                        // fires); a tick later, drawn, its hit boxes and its batch's culling box are up there
                        if (e.mechState === 'perch' && shown === 1) {
                            shown = 2;
                            packEnemyBatches();
                            const head = new THREE.Box3().setFromObject(e.leaves[1]);
                            out.head = [+head.min.y.toFixed(2), +head.max.y.toFixed(2)];
                            out.culled = !(e.page && e.page.meshes[1].geometry.boundingBox.containsBox(head));
                        }
                        if (e.mechState === 'perch' && !shown) {
                            shown = 1;
                            __put(rope.exit.x + 6, rope.exit.z + 2, deck + characterController.standHeight);
                        }
                        if (e.mechState === 'perch') {
                            // (how far it faces off you, at the end of its hold)
                            const want = Math.atan2(characterController.position.x - p.x, characterController.position.z - p.z);
                            out.faced = Math.abs(Math.atan2(Math.sin(want - e.mesh.rotation.y), Math.cos(want - e.mesh.rotation.y)));
                        }
                        lastY = p.y;
                    });
                } finally { window.enemyShoot = realShoot; }
                out.end = [e.mechState, e.animAction, e.mesh.position.y, e.mechAir];
                return out;
            }), [map, r]));
        }
    }
    for (const o of runs) {
        const name = `${o.map} ${o.rope}`;
        assert.ok(o.start, `${name}: a start spot near the rope`);
        assert.equal(o.sent, true, `${name}: sent`);
        assert.ok(Math.abs(o.maxY - o.deck) < 1e-6, `${name}: feet at the deck (${o.maxY} m, deck ${o.deck} m)`);
        assert.ok(o.deckTicks >= 150, `${name}: holds the deck (${(o.deckTicks / 60).toFixed(1)} s)`);
        // Up at 13.5 m/s: 0.4 s for a 5.2 m stack, rising every tick
        assert.ok(Math.abs(o.climbState - o.deck / 13.5 * 60) <= 1.5 && !o.climbStalled, `${name}: climbs at your speed (${o.climbState} ticks up ${o.deck} m)`);
        assert.ok(o.climbTicks > o.climbState, `${name}: animAction 'climb' on the rope (up and down: ${o.climbTicks} ticks)`);
        assert.equal(o.climbOffRope, 0, `${name}: x and z at the rope while it climbs`);
        assert.deepEqual(o.states, ['toRope', 'climb', 'onTop', 'perch', 'back', 'down', null], `${name}: up, on the deck, back down`);
        assert.deepEqual(o.end, [null, null, 0, false], `${name}: back on the floor, back to normal`);
        assert.ok(o.secs > 0 && o.secs < 20, `${name}: done in ${o.secs} s`);
        assert.ok(o.head[0] > o.deck + 1 && o.head[1] < o.deck + 3, `${name}: its head hit box is up on the deck (${o.head})`);
        assert.equal(o.culled, false, `${name}: inside its batch's culling box`);
        assert.ok(o.shotsOnDeck > 0, `${name}: fires at you from the deck`);
        assert.ok(o.faced !== null && o.faced < 0.35, `${name}: turned to face you (${o.faced} rad off)`);
    }

    // A Match on Icebox with the bots defending: one of them takes a deck by itself a few seconds in,
    // never two at once, and comes down when the spike is planted
    const m = await evaluate(() => __det((sim, clock) => {
        game.userSettings.botMechanics = 'on';
        __match('icebox', 'defend');
        __put(-15, 8);   // in the Rail Yard: in range of both sites, out of sight
        const bots = enemyObjects.filter((e) => e.isActive && !e.hit);
        const out = { bots: bots.length, most: 0, up: [], downAt: null };
        const watch = (t) => {
            let n = 0;
            for (const e of bots) {
                if (e.mechKind === 'rope') n++;
                if (e.mesh.position.y > 1 && !out.up.some((u) => u.slot === e.slot)) out.up.push({ slot: e.slot, t, home: [e.position.x, e.position.z] });
            }
            out.most = Math.max(out.most, n, botMechanics.perchers);
        };
        sim(25, null, (k, t) => watch(t));
        out.heldAtPlant = bots.filter((e) => e.mechState === 'perch').length;
        tacticalDirector.completeSpikePlant(performance.now(), 'A');
        const planted = clock();
        out.downAt = sim(8, () => bots.every((e) => e.mesh.position.y === 0 && e.mechKind !== 'rope'), (k, t) => watch(t)) > 0 ? (clock() - planted) / 1000 : -1;
        out.after = bots.map((e) => [e.mechState, e.mesh.position.y]);
        return out;
    }));
    assert.ok(m.up.length === 1 && m.up[0].t < 20, `one defender takes a deck by itself (${JSON.stringify(m.up)})`);
    assert.equal(m.most, 1, 'never more than one bot on a side up a rope');
    assert.equal(m.heldAtPlant, 1, 'it holds the deck until the plant');
    assert.ok(m.downAt > 0 && m.downAt < 4, `and comes down at the plant (${m.downAt} s)`);
    assert.ok(m.after.every((a) => a[0] === null && a[1] === 0), 'every bot back on the floor');

    // Drawn in play with a bot up on the B stack: nothing compiles
    const up = await evaluate(() => __det((sim) => {
        __match('icebox', 'attack', 'A');
        const L = mapLayout(), f = botMechanics._foot(L, 2);
        const off = [[0, -4], [0, 4], [-3, 0], [3, 0]].find(([dx, dz]) => !resolveEnemyMapCollision(new THREE.Vector3(f.x + dx, 0, f.z + dz), 0.75, true));
        const e = __solo(f.x + off[0], f.z + off[1]);
        __put(L.spawns.defend.x, L.spawns.defend.z);
        botMechanics.sendToRope(e, 2, 600000);
        sim(15, () => e.mechState === 'perch');
        return e.mechState;
    }));
    assert.equal(up, 'perch');
    await frames(20);
    const [programs, watermark] = await programState(page);
    assert.equal(programs, watermark, 'no shader compiles');
    assert.equal(await evaluate(() => enemyObjects.some((e) => e.mechState === 'perch' && e.mesh.position.y === 5.2)), true, 'it stays up there in play');
    // Switched off: it is put back on the floor at once
    await evaluate(() => document.querySelector('#setting-bot-mech-pills [data-botmech="off"]').click());
    assert.equal(await evaluate(() => enemyObjects.every((e) => !e.mechState && !e.mechAir && (e.hit || !e.isActive || e.mesh.position.y === 0))), true, 'off: back on the floor');
    assert.deepEqual(errors, []);
});

test('ON: Bind teleporters and Lotus doors and wall: a bot takes the pad when quicker, opens a shut door and goes through, a defender shuts one behind it, and an attacker shoots the wall open and goes through, each reaching its goal', { timeout: 600000 }, async () => {
    const { page, errors, frames, evaluate } = await boot({ quality: 'low' });
    await evaluate(HELPERS);
    await evaluate(SCENARIOS);
    await evaluate(() => { game.userSettings.botMechanics = 'on'; });
    for (const pad of [0, 1]) {
        const r = await evaluate((pad) => __bindPad(pad), pad);
        const name = `Bind pad ${pad}`;
        assert.ok(r.byPad < r.walk * 0.6, `${name}: the pad is quicker (${r.byPad.toFixed(1)} m against ${r.walk.toFixed(1)} m)`);
        assert.equal(r.jumps.length, 1, `${name}: one trip (${JSON.stringify(r.jumps)})`);
        const j = r.jumps[0];
        assert.ok(Math.hypot(j.from[0] - r.tp.from[0], j.from[1] - r.tp.from[1]) <= 1.2, `${name}: from the pad (${j.from})`);
        // (it walks on a few centimetres in the same tick)
        assert.ok(Math.hypot(j.to[0] - r.tp.to[0], j.to[1] - r.tp.to[1]) < 0.2, `${name}: out at the exit (${j.to})`);
        const off = Math.abs(Math.atan2(Math.sin(j.yaw - (r.tp.yaw + Math.PI)), Math.cos(j.yaw - (r.tp.yaw + Math.PI))));
        assert.ok(off < 0.06, `${name}: facing the layout's way out (${off.toFixed(3)} rad off)`);
        assert.ok(j.readyIn > 3000 && j.readyIn <= 3200, `${name}: a reuse wait like yours (${j.readyIn} ms)`);
        assert.equal(r.exitSounds, 1, `${name}: the arrival sound`);
        assert.deepEqual(r.placedAt, r.tp.to, `${name}: placed in 3D at the exit`);
        assert.ok(r.flashes >= 2, `${name}: a flash at the pad and the exit`);
        assert.ok(r.secs > 0 && r.secs < 40, `${name}: reaches its goal (${r.secs} s)`);
        assert.equal(r.maxY, 0);
    }
    for (const di of [0, 1]) {
        const r = await evaluate((di) => __lotusDoor(di), di);
        const name = `Lotus door ${di}`;
        assert.equal(r.shut, true, `${name}: shut first`);
        assert.ok(r.push >= 130, `${name}: animAction 'push' while it turns it (${r.push} ticks)`);
        assert.ok(r.pushWhileTurning >= 130, `${name}: ...and waits for the turn`);
        assert.ok(r.openedAt !== null, `${name}: open`);
        assert.ok(r.through !== null && r.through > r.openedAt, `${name}: through it once open (${r.through} s)`);
        assert.ok(r.secs > 0 && r.secs < 40, `${name}: reaches its goal (${r.secs} s; the walk round is ${r.walk.toFixed(1)} m)`);
        assert.deepEqual([r.doorNow[0], r.maxY, r.climb], [true, 0, 0]);
    }
    const c = await evaluate(() => __lotusClose());
    assert.equal(c.open, true, 'Lion Gate open at first');
    assert.ok(c.through !== null, 'the defender goes through it');
    assert.ok(c.shutAt && c.shutAt.t > c.through && c.shutAt.clearOfSweep, `and shuts it behind it, clear of its sweep (${JSON.stringify(c.shutAt)})`);
    assert.ok(c.push > 20 && c.push < 90, `animAction 'push' while it turns it (${c.push} ticks)`);
    assert.deepEqual(c.door[0], false, 'shut');
    assert.ok(c.secs > 0 && c.secs < 30, `then on to its goal (${c.secs} s)`);
    const w = await evaluate(() => __lotusWall());
    assert.equal(w.goal, null, 'post-plant, it hunts you');
    assert.ok(w.whole, 'the wall stands at first');
    assert.ok(w.hits >= 10 && w.hits <= 12, `it shoots the wall down (${w.hits} hits)`);
    assert.ok(w.brokeAt !== null && w.broken, 'broken');
    assert.ok(w.through !== null && w.through > w.brokeAt, `through the gap (${w.through} s)`);
    assert.ok(w.seenAt !== null && w.secs > 0 && w.secs < 30, `and finds you (${w.secs} s; the walk round is ${w.walk.toFixed(1)} m)`);
    assert.ok(w.maxX < 26, 'it did not go the long way round');
    assert.deepEqual([w.maxY, w.anim], [0, 0]);
    // Their effects drawn in play (a pad's flash, a bot's shots at the wall, a bot turning a door): nothing compiles
    await evaluate(() => {
        __match('lotus', 'attack', 'A');
        const e = __solo(20, -29.5), te = tacticalEnhancements;
        __put(20, -36);
        for (let i = 0; i < 4; i++) botMechanics._shootWall(e, e.mesh.position, te.breakWall, 1, performance.now());
        botMechanics._flash(20, -33, 0xf59e0b);
        te.botTurnDoor(te.lotusDoors[0], false);
    });
    await frames(20);
    const [programs, watermark] = await programState(page);
    assert.equal(programs, watermark, 'no shader compiles');
    await evaluate(() => { game.userSettings.botMechanics = 'off'; tacticalDirector.setGameMode('wave'); });
    assert.deepEqual(errors, []);
});

test('OFF: the same scenarios: no bot climbs, teleports, opens a door or shoots the wall; they go round, and none of the new code runs', { timeout: 600000 }, async () => {
    const { errors, frames, evaluate } = await boot({ quality: 'low' });
    await evaluate(HELPERS);
    await evaluate(SCENARIOS);
    // Off, nothing but the setting check and the bots' field reset may run
    await evaluate(() => {
        game.userSettings.botMechanics = 'off';
        window.__ran = [];
        for (const k of Object.keys(botMechanics)) {
            if (typeof botMechanics[k] !== 'function' || k === 'enabled' || k === 'reset') continue;
            botMechanics[k] = () => { window.__ran.push(k); throw new Error('botMechanics.' + k + ' ran with the setting off'); };
        }
    });
    for (const pad of [0, 1]) {
        const r = await evaluate((pad) => __bindPad(pad), pad);
        assert.deepEqual(r.jumps, [], `Bind pad ${pad}: no trip`);
        assert.deepEqual([r.exitSounds, r.maxY, r.anim, r.states], [0, 0, 0, 0]);
        assert.ok(r.secs > 0 && r.secs < 70, `Bind pad ${pad}: walks round to its goal (${r.secs} s)`);
    }
    for (const di of [0, 1]) {
        const r = await evaluate((di) => __lotusDoor(di), di);
        assert.equal(r.shut, true);
        assert.deepEqual([r.everOpen, r.through, r.push, r.climb, r.maxY], [false, null, 0, 0, 0], `Lotus door ${di}: never opened, never through it`);
        assert.ok(r.secs > 0 && r.secs < 70, `Lotus door ${di}: goes round to its goal (${r.secs} s)`);
    }
    const c = await evaluate(() => __lotusClose());
    assert.deepEqual([c.open, c.shutAt, c.push, c.door[0]], [true, null, 0, true], 'Lion Gate: walked through, left open');
    assert.ok(c.secs > 0 && c.secs < 30, `on to its goal (${c.secs} s)`);
    const w = await evaluate(() => __lotusWall());
    assert.deepEqual([w.hits, w.broken, w.through, w.maxY, w.anim], [0, false, null, 0, 0], 'the wall: never shot, never through');
    assert.ok(w.maxX > 38 && w.seenAt !== null, `goes the long way round to you (x ${w.maxX.toFixed(1)}, ${w.seenAt} s)`);
    assert.deepEqual(await evaluate(() => window.__ran), [], 'none of the new code ran');
    await frames(5);
    assert.deepEqual(errors, []);
});

test('OFF: bots move exactly as in V2.1 (same seeded rounds of Wave and Match on the maps with mechanics, doors shut)', { timeout: 600000 }, async () => {
    // Every bot's position, height, facing, tactic and tier, twice a second, through a Wave stretch, a
    // Match round with the bots attacking and one with them defending a planted spike
    const RUN = () => {
        window.__track = (map) => __det((sim) => {
            const rec = [];
            const snap = () => { for (const e of enemyObjects) rec.push(e.isActive && !e.hit ? [e.slot, e.mesh.position.x, e.mesh.position.y, e.mesh.position.z, e.mesh.rotation.y, e.aiState || '', e.tier || ''] : [e.slot]); };
            tacticalEnhancements.toggleWingmanAI(false);
            game.botAbilityAI = false;
            tacticalDirector.setGameMode('wave');
            if (game.mapPreset !== map) rebuildMapPreset(map);
            const L = mapLayout();
            for (const d of tacticalEnhancements.lotusDoors) if (d.cfg) __shut(d);
            __put(L.start.x, L.start.z);
            sim(20, null, (k) => { if (k % 30 === 0) snap(); });
            __match(map, 'attack', 'A');
            __put(L.spawns.defend.x + 3, L.spawns.defend.z - 6);
            sim(30, null, (k) => { if (k % 30 === 0) snap(); }, true);
            __match(map, 'defend');
            __put(L.spawns.attack.x, L.spawns.attack.z + 6);
            tacticalDirector.completeSpikePlant(performance.now(), 'B');
            sim(20, null, (k) => { if (k % 30 === 0) snap(); }, true);
            tacticalDirector.setGameMode('wave');
            return rec;
        }, 5e6);
    };
    const maps = ['bind', 'icebox', 'lotus', 'split'];
    const out = {};
    for (const [label, file] of [['v21', '(V2.1) valorant-fps.html'], ['v22', null]]) {
        const { errors, evaluate } = await boot(file ? { quality: 'low', file } : { quality: 'low' });
        await evaluate(HELPERS);
        await evaluate(RUN);
        out[label] = { setting: await evaluate(() => game.userSettings.botMechanics), errors };
        for (const map of maps) out[label][map] = await evaluate((m) => __track(m), map);
    }
    assert.equal(out.v22.setting, 'off');
    for (const map of maps) {
        assert.ok(out.v21[map].length > 200, `${map}: ${out.v21[map].length} samples`);
        const i = out.v21[map].findIndex((s, k) => JSON.stringify(s) !== JSON.stringify(out.v22[map][k]));
        assert.equal(i, -1, `${map}: the same moves (first difference at sample ${i}: ${JSON.stringify(out.v21[map][i])} vs ${JSON.stringify(out.v22[map][i])})`);
    }
    assert.deepEqual(out.v21.errors, []);
    assert.deepEqual(out.v22.errors, []);
});
