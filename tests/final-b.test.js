'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser } = require('./harness');
const kit = require('./hifi-kit');

after(closeBrowser);

// V2.2 final check: the bugs found during the High Fidelity work. One lean check per fix, several per
// boot (Classic, bots frozen and moved off unless a check places one; every wait is on game time).

const HELPERS = () => {
    window.updateEnemies = () => {};
    game.userSettings.infiniteAbilities = true;
    game.userSettings.infiniteUlt = true;
    // every flash and ring, with the ability tag it was spawned under
    window.__fx = [];
    for (const name of ['spawnFlashBurst', 'spawnWindRing']) {
        const orig = agentSystem[name];
        agentSystem[name] = function (x, y, z) {
            __fx.push({ kind: name === 'spawnFlashBurst' ? 'flash' : 'ring', tag: abilityLook.tag, x: x, y: y, z: z });
            return orig.apply(this, arguments);
        };
    }
    // cast from a spot (eye position), facing yaw and looking down by pitch; returns the flashes and rings it spawned
    window.__cast = (agent, slot, at, yaw, pitch) => {
        agentSystem.selectAgent(agent);
        if (castFX.active) { castFX.active = null; castFX.hide(); }
        if (slot === 'x') { game.ultActiveUntil = 0; game.ultAgent = null; game.ultChargesLeft = 0; game.ultPoints = game.maxUltPoints; }
        const cc = characterController;
        cc.position.set(at[0], at[1], at[2]);
        cc.prevSimPosition.copy(cc.position);
        camera.position.copy(cc.position);
        camera.rotation.set(pitch === undefined ? -0.3 : pitch, yaw, 0, 'YXZ');
        if (cc.targetRotation) cc.targetRotation.y = yaw;
        const i0 = __fx.length;
        agentSystem.castAbility(slot);
        return __fx.slice(i0);
    };
    // every bot but `keep` goes far off (none is hunted, hit or pulled)
    window.__away = (keep) => {
        for (const e of enemyObjects) {
            if (!e.isActive || e.hit || e === keep) continue;
            e.mesh.position.set(40, 0, -40);
            e.poseDirty = true;
            syncEnemyBroadphase(e);
        }
    };
    window.__wpos = (o) => { o.updateMatrixWorld(true); return o.getWorldPosition(new THREE.Vector3()).toArray(); };
};

async function waitGame(g, ms) {
    const t0 = await g.evaluate(() => gameNow());
    await g.page.waitForFunction(([t0, ms]) => gameNow() - t0 >= ms, [t0, ms], { timeout: 120000, polling: 20 });
}

function near(actual, expected, label, tol = 1e-6) {
    const a = [].concat(actual), e = [].concat(expected);
    assert.equal(a.length, e.length, label);
    for (let i = 0; i < e.length; i++) assert.ok(typeof a[i] === 'number' && Math.abs(a[i] - e[i]) <= tol, `${label}: ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

// The items that stood at fixed heights from 0, cast along the open corridor at x = -40 (facing +z), on a
// floor at height H: their heights and their flashes' and rings', read at the cast, 400 ms on (the movers;
// then they go off by hand) and 2 s on (the delayed bursts)
async function heightsOn(g, H) {
    await kit.clear(g);
    await g.evaluate(() => { __away(null); __fx.length = 0; });
    const cast = await g.evaluate((H) => {
        const at = [-39, H + 1.7, 14], yaw = Math.PI, A = agentSystem;
        const out = { fx: {} };
        // Thrash is the last ultimate: X while it swims lunges it instead (whoever presses)
        const keys = ['gekko.q', 'tejo.c', 'tejo.x', 'harbor.e', 'harbor.x', 'astra.x', 'astra.c', 'astra.q', 'waylay.x', 'gekko.x', 'waylay.q', 'waylay.e'];
        const own = (k, list) => list.filter((f) => f.tag === k).map((f) => f.kind + ' ' + f.y);
        for (const k of keys) { const [a, s] = k.split('.'); out.fx[k] = own(k, __cast(a, s, at, yaw)); }
        out.fx['waylay.e'] = out.fx['waylay.e'].concat(own('waylay.e', __cast('waylay', 'e', at, yaw)));   // E again: the return
        const cp = A.waylayConvergentPaths, ta = A.tejoArmageddon;
        out.wingman = A.gekkoWingman.find((x) => x.inUse).group.position.y;
        out.drone = A.tejoStealthDrones.find((x) => x.inUse).group.position.y;
        out.thrash = A.gekkoThrash.group.position.y;
        out.armageddon = __wpos(ta.floorMesh)[1];
        out.highTide = A.harborHighTides.find((x) => x.inUse).group.position.y;
        out.reckoning = A.harborReckoning.position.y;
        out.divide = A.astraCosmicDivide.group.position.y;
        // the Classic lane and mirage where the eruption hits: 13 m down the lane, 2.5 m ahead
        out.lane = __wpos(cp.laneMesh);
        out.mirage = __wpos(cp.mirageMesh);
        out.origin = [cp.origin.x, cp.origin.y, cp.origin.z];
        return out;
    }, H);
    await waitGame(g, 400);
    const moving = await g.evaluate(() => {
        const A = agentSystem, now = gameNow();
        const gw = A.gekkoWingman.find((x) => x.inUse), td = A.tejoStealthDrones.find((x) => x.inUse), gt = A.gekkoThrash, hr = A.harborReckoning;
        const out = { wingman: [gw.position.z, gw.group.position.y], drone: [td.position.z, td.group.position.y], thrash: [gt.position.z, gt.group.position.y], reckoning: [hr.position.z, hr.position.y], fx: {} };
        const i0 = __fx.length;
        A.detonateGekkoWingman(gw, now, Date.now());
        A.detonateGekkoThrash(now, Date.now());
        A.detonateTejoDronePulse(now, td);
        for (const f of __fx.slice(i0)) (out.fx[f.tag] = out.fx[f.tag] || []).push(f.kind + ' ' + f.y);
        return out;
    });
    await waitGame(g, 1700);   // the Gravity Well implodes 1.8 s after its cast
    const later = await g.evaluate(() => {
        const pick = (tag, kind) => __fx.filter((f) => f.tag === tag && f.kind === kind).map((f) => f.y);
        return { well: [pick('astra.c', 'flash'), pick('astra.c', 'ring')], nova: [pick('astra.q', 'flash'), pick('astra.q', 'ring')], erupt: [pick('waylay.x', 'flash'), pick('waylay.x', 'ring')] };
    });
    return { cast, moving, later };
}

function checkHeights(r, H, label) {
    const y = (v) => v + H;
    const fx = (list) => list.map(([k, v]) => k + ' ' + y(v));
    const sameFx = (actual, expected, what) => {
        assert.equal(actual.length, expected.length, `${label} ${what}: ${JSON.stringify(actual)}`);
        actual.forEach((a, i) => {
            const [k, v] = a.split(' '), [ek, ev] = expected[i].split(' ');
            assert.ok(k === ek && Math.abs(+v - +ev) < 1e-6, `${label} ${what}: ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
        });
    };
    const c = r.cast;
    near(c.wingman, y(0.05), `${label} Wingman`);
    near(c.drone, y(1.35), `${label} Stealth Drone`);
    near(c.thrash, y(0.35), `${label} Thrash`);
    near(c.armageddon, y(0.05), `${label} Armageddon's floor plane`);
    near(c.highTide, y(0), `${label} High Tide`);
    near(c.reckoning, y(0.04), `${label} Reckoning`);
    near(c.divide, y(0), `${label} Cosmic Divide`);
    near(c.origin, [-39, y(0.04), 14], `${label} Convergent Paths' origin`);
    near(c.lane, [-39, y(0.05), 27], `${label} Convergent Paths' lane`, 1e-4);
    near(c.mirage, [-39, y(1.35), 16.5], `${label} Convergent Paths' mirage`, 1e-4);
    sameFx(c.fx['tejo.x'], fx([['ring', 0.25]]), 'Armageddon call-in ring');
    sameFx(c.fx['harbor.e'], fx([['ring', 0.2]]), 'High Tide ring');
    sameFx(c.fx['harbor.x'], fx([['ring', 0.25]]), 'Reckoning ring');
    sameFx(c.fx['astra.x'], fx([['flash', 2.2], ['ring', 0.25]]), 'Cosmic Divide flash and ring');
    sameFx(c.fx['waylay.x'], fx([['ring', 0.25]]), 'Convergent Paths ring');
    sameFx(c.fx['waylay.q'], fx([['ring', 0.3]]), 'Lightspeed ring');
    // Refract: the beacon's ring, then the return: where you leave (flash, ring), where you arrive (flash,
    // ring: over the beacon, which stands 0.02 m up on flat floor, as before)
    const b = Math.max(0.02, H);
    sameFx(c.fx['waylay.e'], ['ring ' + y(0.15), 'flash ' + y(0.9), 'ring ' + y(0.15), 'flash ' + (b + 0.9), 'ring ' + (b + 0.15)], 'Refract');
    const m = r.moving;
    for (const [k, h] of [['wingman', 0.05], ['drone', 1.35], ['thrash', 0.35], ['reckoning', 0.04]]) {
        assert.ok(m[k][0] > 15 && m[k][0] < 40, `${label} ${k} moved down the corridor (z ${m[k][0]})`);
        near(m[k][1], y(h), `${label} ${k} as it moves`);
    }
    sameFx(m.fx['gekko.q'], fx([['flash', 0.85], ['ring', 0.25]]), 'Wingman concuss');
    sameFx(m.fx['gekko.x'], fx([['flash', 1.0], ['ring', 0.3]]), 'Thrash lunge');
    sameFx(m.fx['tejo.c'], fx([['flash', 1.35], ['ring', 0.25]]), 'Stealth Drone EMP');
    const l = r.later;
    near(l.well[0], [y(0.95)], `${label} Gravity Well implosion flash`);
    near(l.well[1], [y(0.15), y(0.25)], `${label} Gravity Well rings (cast, implosion)`);
    near(l.nova[0], [y(0.95)], `${label} Nova Pulse flash`);
    near(l.nova[1], [y(0.15), y(0.25)], `${label} Nova Pulse rings (cast, burst)`);
    near(l.erupt[0], [y(1.4)], `${label} Convergent Paths eruption flash`);
    near(l.erupt[1], [y(0.25), y(0.3)], `${label} Convergent Paths rings (cast, eruption)`);
}

test('ability objects stand where they act: the warm-up puts them back, the floor under them, the arena, the dome', { timeout: 420000 }, async () => {
    const g = await boot({ quality: 'low' });
    await g.evaluate(HELPERS);

    // The shader warm-up drew every ability object at a point in front of the camera and left it there.
    // Convergent Paths, Armageddon and the Annihilation cocoon never place their group (their meshes are
    // in world coordinates), so they drew about 11 m off and 1.7 m up. Each is back where it was built...
    assert.equal(await g.evaluate(() => agentSystem.warmupMeshes.filter((wm) => wm.position.lengthSq() !== 0).length), 0, 'every warm-up object back at its origin');
    // ...so the cocoon is drawn on its captive
    const cocoon = await g.evaluate(() => {
        const e = enemyObjects.find((x) => x.isActive && !x.hit);
        __away(e);
        e.mesh.position.set(0, 0, 14); e.poseDirty = true; syncEnemyBroadphase(e); e.health = 1e6;
        __cast('deadlock', 'x', [0, 1.7, 22], 0, -0.1);
        const dc = agentSystem.deadlockCocoon;
        const out = { active: dc.active, cocoon: __wpos(dc.cocoonMesh), at: [dc.position.x, 1.15, dc.position.z] };
        dc.executeAt = 1;   // ends next step (it holds its captive while it lives)
        return out;
    });
    assert.ok(cocoon.active, 'Annihilation caught the bot');
    near(cocoon.cocoon, cocoon.at, 'the cocoon on its captive', 1e-4);

    // Kill Contract from the corridor at x = -40 (a 3 m wall stub across z 4-6 east of x -39.5): the arena
    // stays where it is aimed (its centre was clamped to ±38 m: moved 2 m into the stub facing -z and 6 m
    // to the other side of you facing -x) on the floor (from 1 m over the eyes the stub's top, y 3, was taken)
    const arena = await g.evaluate(() => {
        const out = [];
        for (const yaw of [0, Math.PI / 2]) {
            __away(null);
            __cast('iso', 'x', [-40, 1.7, 10], yaw, -0.1);
            const kc = agentSystem.isoKillContract;
            out.push([kc.active].concat(kc.position.toArray().map((v) => Math.round(v * 100) / 100 + 0)));
            kc.active = false; kc.group.visible = false; game.ultActiveUntil = 0; game.ultAgent = null;
        }
        return out;
    });
    assert.deepEqual(arena, [[true, -40, 0, 5.8], [true, -44.2, 0, 10]], 'the arena where it was aimed, on the floor');

    // Viper's Pit: the Classic dome is the 14 m sphere sight stops at (it was squashed to 7.7 m high)
    const pit = await g.evaluate(() => {
        __cast('viper', 'x', [0, 1.7, 22], 0);
        const vp = agentSystem.vipersPit, d = vp.domeMesh;
        d.geometry.computeBoundingBox();
        d.updateWorldMatrix(true, false);
        const top = new THREE.Vector3(0, d.geometry.boundingBox.max.y, 0).applyMatrix4(d.matrixWorld).y;
        return { r: vp.radius, scale: d.scale.toArray(), top: top - vp.position.y };
    });
    near(pit.scale, [pit.r, pit.r, pit.r], "Viper's Pit dome scale");
    near(pit.top, pit.r, "Viper's Pit dome top over its floor", 1e-4);

    // Fixed heights: on flat floor everything is where it was (but Lightspeed's ring and Refract's
    // departure burst, which were over your head: eye + 0.3, eye + 0.9 and the ring at your eyes)...
    checkHeights(await heightsOn(g, 0), 0, 'flat floor:');
    // ...and on a raised floor (a 1.2 m platform along the corridor) everything stands on it
    await g.evaluate(() => {
        const rec = createColliderRecord('static', null);
        setColliderFromBox3(rec, new THREE.Box3(new THREE.Vector3(-41.9, 0, 12), new THREE.Vector3(-36.1, 1.2, 40)), -39, 26);
        collisionIndex.insert(rec);
        window.__platform = rec;
    });
    checkHeights(await heightsOn(g, 1.2), 1.2, '1.2 m floor:');
    await g.evaluate(() => collisionIndex.remove(__platform));
    await kit.clear(g);
    assert.deepEqual(g.errors, []);
});

test('Devour heals over time; Gatecrash fires no unmask; casts stamp spawnAt; Bassquake and Fast Lane', { timeout: 300000 }, async () => {
    const g = await boot({ quality: 'low' });
    await g.evaluate(HELPERS);

    // Reyna's Devour: its heal comes in ticks (10 HP each 450 ms, the first on the next step) from a
    // session the cast now starts (it healed 50 at once and the session's step never ran); the shield
    // comes at once as before; a second orb adds its ticks
    const dev = await g.evaluate(() => {
        __away(null);
        agentSystem.selectAgent('reyna');
        const cc = characterController;
        cc.position.set(0, 1.7, 22); cc.prevSimPosition.copy(cc.position);
        game.health = 40; game.shield = 0;
        window.__heals = [];
        const heal = agentSystem.healPlayer;
        agentSystem.healPlayer = function (amount) { __heals.push([gameNow(), amount]); return heal.apply(this, arguments); };
        agentSystem.onActorEliminated('enemy', new THREE.Vector3(1.5, 0, 22));
        const t = gameNow();
        agentSystem.castAbility('q');
        const s = agentSystem.reynaDevourSession;
        const first = { hp: game.health, shield: game.shield, active: s.active, ticks: s.ticksLeft, next: s.nextTickAt };
        agentSystem.onActorEliminated('enemy', new THREE.Vector3(-1.5, 0, 22));
        agentSystem.castAbility('q');
        return { t, first, second: { ticks: s.ticksLeft, next: s.nextTickAt, hp: game.health } };
    });
    assert.deepEqual(dev.first, { hp: 40, shield: 25, active: true, ticks: 5, next: dev.t }, 'Devour starts its heal and shields at once');
    assert.deepEqual(dev.second, { ticks: 10, next: dev.t, hp: 40 }, 'a second orb adds its ticks');
    await g.page.waitForFunction(() => !agentSystem.reynaDevourSession.active, null, { timeout: 120000, polling: 20 });
    const heals = await g.evaluate(() => ({ heals: __heals, hp: game.health }));
    assert.deepEqual(heals.heals.map((h) => h[1]), Array(10).fill(10), 'ten ticks of 10 HP');
    assert.equal(heals.hp, 100, 'healed (to full)');
    assert.ok(heals.heals[0][0] - dev.t > 0 && heals.heals[0][0] - dev.t <= 1000 / 60 + 0.01, `the first tick on the next step (${heals.heals[0][0] - dev.t} ms)`);
    for (let i = 1; i < 10; i++) {
        const gap = heals.heals[i][0] - heals.heals[i - 1][0];
        assert.ok(gap >= 449.9 && gap <= 450 + 1000 / 60 + 0.01, `tick ${i} ${gap.toFixed(1)} ms after the one before`);
    }

    // Yoru: a shot in Gatecrash's 0.9 s arrival phase (the same intangible timer as the Drift) fires no
    // unmask (it fired the Drift's flash and blind without the ultimate); in the ultimate it still does
    const yoru = await g.evaluate(() => {
        __away(null);
        const e = enemyObjects.find((x) => x.isActive && !x.hit);
        __cast('yoru', 'e', [0, 1.7, 22], 0);   // the tether
        __cast('yoru', 'e', [0, 1.7, 22], 0);   // E again: there, intangible
        const p = characterController.position, now = gameNow();
        e.mesh.position.set(p.x + 3, 0, p.z); e.poseDirty = true; syncEnemyBroadphase(e); e.health = 1e6; e.blindedUntil = 0;
        window.__yoruBot = e;
        const until = agentSystem.reynaDismissUntil, i0 = __fx.length;
        game.lastShot = 0;
        shoot();
        return { phase: until - now, still: agentSystem.reynaDismissUntil === until, blinded: e.blindedUntil > now, unmask: __fx.slice(i0).filter((f) => f.tag === 'yoru.x').length };
    });
    assert.ok(yoru.phase > 0 && yoru.phase <= 900, `Gatecrash's arrival phase (${yoru.phase} ms)`);
    assert.deepEqual([yoru.unmask, yoru.blinded, yoru.still], [0, false, true], 'a shot in it: no unmask flash, no blind, still intangible');
    await g.frames(2);
    const banner = await g.evaluate(() => statusPillBanner.textContent);
    assert.match(banner, /GATECRASH/, `the banner names Gatecrash's phase: ${banner}`);
    assert.doesNotMatch(banner, /DRIFT|UNMASK/, 'not the Drift');
    const drift = await g.evaluate(() => {
        const e = __yoruBot;
        __cast('yoru', 'x', [0, 1.7, 22], 0);
        e.mesh.position.set(characterController.position.x + 3, 0, characterController.position.z); e.poseDirty = true; syncEnemyBroadphase(e); e.blindedUntil = 0;
        const now = gameNow(), i0 = __fx.length;
        game.lastShot = 0;
        shoot();
        return { unmask: __fx.slice(i0).filter((f) => f.tag === 'yoru.x').length, blinded: e.blindedUntil > now, out: agentSystem.reynaDismissUntil === 0, ultEnded: game.ultActiveUntil <= now };
    });
    assert.deepEqual(drift, { unmask: 1, blinded: true, out: true, ultEnded: true }, 'in Dimensional Drift a shot unmasks');

    // Every projectile cast stamps spawnAt (High Fidelity reads it: the throw's age, a reused slot's new throw)
    const stamps = await g.evaluate(() => {
        const out = {};
        for (const [k, type] of [['gekko.c', 'moshpit'], ['deadlock.c', 'gravnet'], ['harbor.q', 'cove'], ['vyse.e', 'razorvine'], ['tejo.q', 'specialdelivery'],
            ['waylay.c', 'saturate'], ['veto.q', 'chokehold'], ['miks.c', 'mpulse'], ['clove.q', 'meddle']]) {
            for (const p of agentSystem.projectiles) p.spawnAt = -1;
            const [a, s] = k.split('.');
            __cast(a, s, [0, 1.7, 22], 0);
            const p = agentSystem.projectiles.find((x) => x.inUse && x.type === type);
            out[k] = p ? p.spawnAt === gameNow() : 'no ' + type;
        }
        return out;
    });
    for (const [k, v] of Object.entries(stamps)) assert.equal(v, true, `${k} stamps spawnAt`);

    // Bassquake keeps only the fields that are read (origin, dir, wavesFired), and still rolls its drops
    const bq = await g.evaluate(() => {
        const q = agentSystem.miksBassquake;
        const stale = ['originX', 'originY', 'originZ', 'dirX', 'dirZ', 'rightX', 'rightZ', 'yaw', 'wavesDone', 'maxWaves'].filter((k) => k in q);
        __cast('miks', 'x', [0, 1.7, 22], 0);
        return { stale, active: q.active };
    });
    assert.deepEqual(bq, { stale: [], active: true }, 'no stale Bassquake fields');
    await g.page.waitForFunction(() => agentSystem.miksBassquake.wavesFired >= 2, null, { timeout: 120000, polling: 20 });

    // Fast Lane: its tick reuses one walls array (it built a new one each tick) and still hits a bot on
    // each wall once a tick
    await kit.clear(g);
    await g.evaluate(() => {
        __away(null);
        __cast('neon', 'c', [-39, 1.7, 14], Math.PI, -0.1);   // along the corridor
        const fl = agentSystem.fastLanes.find((x) => x.inUse);
        const bots = enemyObjects.filter((x) => x.isActive && !x.hit).slice(0, 2);
        [[fl.leftStart, fl.leftEnd], [fl.rightStart, fl.rightEnd]].forEach(([s, e], i) => {
            bots[i].mesh.position.set((s.x + e.x) / 2, 0, (s.z + e.z) / 2); bots[i].poseDirty = true; syncEnemyBroadphase(bots[i]); bots[i].health = 1e6;
        });
        window.__lane = { fl, bots, hits: [0, 0], n: 0 };
        const dmg = window.damageEnemyActor;
        window.damageEnemyActor = function (e, amount, a, b, source) {
            if (source === 'Fast Lane') { const i = __lane.bots.indexOf(e); if (i >= 0) { __lane.hits[i] += amount; __lane.n++; } }
            return dmg.apply(this, arguments);
        };
    });
    await waitGame(g, 600);
    const lane = await g.evaluate(() => ({
        hits: __lane.hits, per: AGENT_TUNING.neon.c.damagePerTick,
        reused: typeof _fastLaneWalls !== 'undefined' && _fastLaneWalls[0].s === __lane.fl.leftStart && _fastLaneWalls[0].e === __lane.fl.leftEnd &&
            _fastLaneWalls[1].s === __lane.fl.rightStart && _fastLaneWalls[1].e === __lane.fl.rightEnd
    }));
    assert.ok(lane.reused, 'the tick reuses one walls array (holding the lane\'s own wall ends)');
    assert.ok(lane.hits[0] >= lane.per && lane.hits[0] === lane.hits[1] && lane.hits[0] % lane.per === 0, `a hit a tick on each wall: ${lane.hits}`);
    assert.deepEqual(g.errors, []);
});
