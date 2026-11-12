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
