'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser, programState } = require('./harness');

after(closeBrowser);

// Every agent's C/Q/E plus the ultimate, with the ultimate state reset first (an
// active ult from the previous agent would otherwise make X return early), then
// every ability again while the ult is active. Delayed effects (projectile
// detonations, pulses) get frames to run. Also audits flat ground effects:
// ring/disc geometry is pre-rotated flat (XZ), so a scale of (r, r, 1) squashes
// it into a sliver; every flat mesh must be scaled with equal X and Z.
test('all agents: every ability and ultimate casts cleanly; ground rings stay circular', { timeout: 900000 }, async () => {
    const { page, errors, frames } = await boot();
    await page.evaluate(() => {
        game.userSettings.infiniteAbilities = true;
        game.userSettings.infiniteUlt = true;
        window.__flatBad = new Set();
        const box = new THREE.Vector3();
        window.__scanFlat = (tag) => {
            scene.traverse((o) => {
                if (!o.isMesh || !o.visible || o.isInstancedMesh) return;
                for (let n = o; n; n = n.parent) if (!n.visible) return;
                const g = o.geometry;
                if (!g.boundingBox) g.computeBoundingBox();
                g.boundingBox.getSize(box);
                const m = Math.max(box.x, box.y, box.z);
                if (m === 0 || !(box.y < m * 0.1 && box.x > m * 0.5 && box.z > m * 0.5)) return;
                const sx = o.scale.x, sz = o.scale.z;
                if (Math.abs(sx - sz) > 0.05 * Math.max(Math.abs(sx), Math.abs(sz), 0.01)) __flatBad.add(tag + ': ' + g.type + ' scale ' + sx.toFixed(2) + ',' + sz.toFixed(2));
            });
        };
    });
    const agents = await page.evaluate(() => Object.keys(AGENT_DEFS));
    assert.ok(agents.length >= 29, 'expected the full agent roster');
    const failures = [];
    for (const agent of agents) {
        await page.evaluate(() => { characterController.position.set(0, 1.7, 22); characterController.prevSimPosition.copy(characterController.position); camera.rotation.set(-0.3, 0, 0); });
        for (const slot of ['c', 'q', 'e', 'x']) {
            const err = await page.evaluate(([agent, slot]) => {
                try {
                    agentSystem.selectAgent(agent);
                    game.ultActiveUntil = 0;
                    game.ultAgent = null;
                    game.ultPoints = game.maxUltPoints;
                    // Reyna's Devour/Dismiss need a soul orb, which a kill drops
                    agentSystem.onActorEliminated('enemy', characterController.position.clone().setX(characterController.position.x + 2));
                    agentSystem.castAbility(slot);
                    if (slot === 'x') for (const s of ['x', 'c', 'q', 'e']) agentSystem.castAbility(s);
                    return null;
                } catch (e) { return e.message; }
            }, [agent, slot]);
            if (err) failures.push(`${agent}.${slot}: ${err}`);
            await frames(2);
            await page.evaluate((tag) => __scanFlat(tag), `${agent}.${slot}`);
        }
        for (let i = 0; i < 3; i++) { await frames(5); await page.evaluate((tag) => __scanFlat(tag), `${agent} (after)`); }
    }
    // Non-ability ground effects with flat rings, triggered directly so the audit
    // never depends on timing: ACE finisher, skin finisher seal, 3D ping marker.
    await page.evaluate(() => {
        const p = characterController.position.clone().setZ(characterController.position.z - 6);
        const now = performance.now();
        tacticalDirector.spawnAceFinisher3D(p, now);
        tacticalEnhancements.spawnSkinFinisher3D(p, 'prime', now);
        tacticalEnhancements.spawnWorldPing(p.x + 2, 0, p.z, false, 'TEST');
    });
    for (let i = 0; i < 4; i++) { await frames(4); await page.evaluate(() => __scanFlat('finishers/ping')); }
    assert.deepEqual(failures, [], 'ability casts threw');
    assert.deepEqual(await page.evaluate(() => [...__flatBad]), [], 'flat ground effects must be scaled on X and Z');
    const [programs, watermark] = await programState(page);
    assert.equal(programs, watermark, 'abilities must not compile new shaders');
    assert.deepEqual(errors, [], 'no errors from delayed ability effects');
});

test('Reyna and Omen kits work end to end', { timeout: 240000 }, async () => {
    const { page, errors } = await boot();
    const r = await page.evaluate(() => {
        const out = {};
        agentSystem.selectAgent('reyna');
        game.health = 40; game.shield = 0;
        const p = characterController.position;
        agentSystem.onActorEliminated('enemy', new THREE.Vector3(p.x + 3, 0, p.z));
        out.orbs = agentSystem.soulOrbs.filter((o) => o.inUse).length;
        agentSystem.castAbility('q');
        out.hp = game.health; out.shield = game.shield;
        const before = agentSystem.stateByAgent.reyna.e.charges;
        agentSystem.castAbility('e'); // no orb left: charge is refunded
        out.refunded = agentSystem.stateByAgent.reyna.e.charges === before;
        agentSystem.selectAgent('omen');
        const from = p.clone();
        camera.rotation.set(-0.2, 0, 0);
        agentSystem.castAbility('c');
        out.stepped = from.distanceTo(p) > 2;
        out.portals = agentSystem.shadowPortals.filter((x) => x.inUse).length;
        return out;
    });
    assert.equal(r.orbs, 1, 'a kill drops a soul orb');
    assert.ok(r.hp > 40 && r.shield > 0, 'Devour heals and shields');
    assert.ok(r.refunded, 'Dismiss without an orb refunds its charge');
    assert.ok(r.stepped && r.portals === 2, 'Shrouded Step teleports with two portals');
    assert.deepEqual(errors, []);
});

// V1.9.1: the Duelists' ability numbers live in AGENT_TUNING[agent][slot]; V2.2: every agent's do.
// The table keeps its shape (all four slots, a look from the fixed list, numbers only),
// ABILITY_TUNING is folded into it, and nothing writes to the table while the kits are played.
test('AGENT_TUNING: every agent has C, Q, E and X with a look, numbers only, unchanged by play', { timeout: 600000 }, async () => {
    const { page, errors, frames } = await boot({ quality: 'low' });
    const LOOKS = ['smoke', 'wall', 'groundZone', 'projectile', 'blast', 'flash', 'beam', 'pulse', 'deployable', 'self'];
    const shape = await page.evaluate((LOOKS) => {
        const bad = [];
        const agents = Object.keys(AGENT_DEFS);
        const roles = {};
        for (const id of agents) {
            roles[AGENT_DEFS[id].role] = (roles[AGENT_DEFS[id].role] || 0) + 1;
            for (const slot of ['c', 'q', 'e', 'x']) if (!(AGENT_TUNING[id] && AGENT_TUNING[id][slot])) bad.push(`${id}.${slot} missing`);
        }
        for (const id of Object.keys(AGENT_TUNING)) if (!AGENT_DEFS[id]) bad.push(`${id} is not an agent`);
        // The ten High Fidelity abilities keep the looks they had (V2.2: they read them from AGENT_TUNING)
        const hifi = {};
        for (const k of Object.keys(abilityLook.CONVERTED)) hifi[k] = abilityLook.lookOf(k);
        for (const [id, slots] of Object.entries(AGENT_TUNING)) {
            for (const [slot, t] of Object.entries(slots)) {
                if (!['c', 'q', 'e', 'x'].includes(slot)) { bad.push(`${id}.${slot} is not a slot`); continue; }
                if (!Array.isArray(t.look) || !t.look.length || t.look.some((l) => !LOOKS.includes(l))) bad.push(`${id}.${slot}.look`);
                for (const [k, v] of Object.entries(t)) if (k !== 'look' && !Number.isFinite(v)) bad.push(`${id}.${slot}.${k}`);
            }
        }
        return { agents, roles, hifi, bad, oldTable: typeof ABILITY_TUNING, snapshot: JSON.stringify(AGENT_TUNING) };
    }, LOOKS);
    assert.equal(shape.agents.length, 29, '29 agents');
    assert.deepEqual(shape.roles, { DUELIST: 8, INITIATOR: 7, SENTINEL: 7, CONTROLLER: 7 });
    assert.deepEqual(shape.bad, []);
    assert.equal(shape.oldTable, 'undefined', 'ABILITY_TUNING is folded into AGENT_TUNING');
    assert.deepEqual(shape.hifi, {
        'omen.e': ['projectile', 'smoke'], 'sage.c': ['wall'], 'phoenix.c': ['projectile', 'groundZone'], 'sova.q': ['projectile', 'blast'],
        'raze.e': ['projectile', 'blast'], 'phoenix.q': ['projectile', 'flash'], 'sova.x': ['beam'], 'breach.e': ['pulse'],
        'killjoy.e': ['deployable'], 'jett.e': ['self']
    }, 'the High Fidelity abilities keep their looks');
    // Every agent: C, Q, E, the E re-press, the ultimate, shots during it and a kill
    for (const id of shape.agents) {
        await page.evaluate((id) => {
            agentSystem.selectAgent(id);
            game.ultActiveUntil = 0; game.ultAgent = null;
            const p = characterController.position;
            agentSystem.onActorEliminated('enemy', new THREE.Vector3(p.x + 2, 0, p.z));
            for (const k of ['c', 'q', 'e', 'e']) {
                const s = agentSystem.stateByAgent[id][k]; s.charges = s.maxCharges; s.rechargeEnd = 0;
                agentSystem.castAbility(k);
            }
            game.ultPoints = game.maxUltPoints;
            agentSystem.castAbility('x');
            for (let i = 0; i < 3; i++) { game.lastShot = 0; shoot(); }
            const e = enemyObjects.find((x) => x.isActive && !x.hit);
            if (e) damageEnemyActor(e, 9999, performance.now(), Date.now(), 'Vandal', 'head');
        }, id);
        await frames(20);
    }
    assert.equal(await page.evaluate(() => JSON.stringify(AGENT_TUNING)), shape.snapshot, 'nothing writes to AGENT_TUNING');
    assert.deepEqual(errors, []);
});

// V2.1: a thrown projectile's fuse counts its simulated flight, as its movement does. CI on PR #31
// caught Phoenix's Curveball popping where it was thrown, never drawn: the frame after the throw took
// longer than its 420 ms fuse, and the fuse ran on the wall clock while the simulation (four ticks a
// frame at most) had barely moved it
test('a projectile thrown just before a long frame flies like any other: its fuse counts simulated time', { timeout: 300000 }, async () => {
    const { errors, frames, evaluate } = await boot({ quality: 'medium' });
    await evaluate(() => { window.updateEnemies = () => {}; game.userSettings.infiniteAbilities = true; });
    const flights = [];
    for (const stall of [0, 600]) {
        await evaluate((stall) => {
            agentSystem.selectAgent('phoenix');
            const cc = characterController;
            cc.position.set(0, 1.7, 22); cc.prevSimPosition.copy(cc.position);
            camera.position.copy(cc.position); camera.rotation.set(-0.3, 0, 0, 'YXZ');
            agentSystem.castAbility('q');
            window.__p = agentSystem.projectiles.find((q) => q.inUse && q.type === 'flash');
            window.__p0 = __p.position.clone();
            // Count the rendered frames that show it in flight (this runs after each of the game's frames)
            window.__seen = 0;
            let n = 0;
            const look = () => { if (__p.inUse) __seen++; if (++n < 60) requestAnimationFrame(look); };
            requestAnimationFrame(look);
            const t = performance.now();
            while (performance.now() - t < stall) {}      // one long frame right after the throw
        }, stall);
        await frames(70);
        flights.push(await evaluate(() => ({ seen: __seen, flew: +__p.position.distanceTo(__p0).toFixed(2) })));
    }
    assert.ok(flights[0].seen >= 1 && flights[0].flew > 2.5, `a normal throw flies (${JSON.stringify(flights[0])})`);
    assert.ok(flights[1].seen >= 1, `a throw just before a long frame is seen in flight (${JSON.stringify(flights[1])})`);
    assert.ok(Math.abs(flights[1].flew - flights[0].flew) < 0.2, `and lands where a normal throw does (${flights[1].flew} m vs ${flights[0].flew} m)`);
    assert.deepEqual(errors, []);
});
