'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser, programState } = require('./harness');

after(closeBrowser);

// Close-combat setup on Ascent: player south of the mid tower, two bots in front.
// The player cannot die, and every enemy shot is logged with the shooter's state.
async function setup() {
    const ctx = await boot({ quality: 'low' });
    await ctx.evaluate(() => {
        tacticalEnhancements.toggleWingmanAI(false);
        game.botAbilityAI = false;
        window.__shots = [];
        const realShoot = enemyShoot;
        window.enemyShoot = (e) => { window.__shots.push({ slot: e.slot, state: e.aiState }); return realShoot(e); };
        window.__god = setInterval(() => { game.health = 100; game.shield = 50; characterController.position.set(0, 1.7, 22); }, 50);
        window.__bots = enemyObjects.filter((e) => e.isActive && !e.hit).sort((a, b) => a.slot - b.slot);
        __bots.forEach((e, i) => {
            e.mesh.position.set(i ? 7 : -7, 0, 11);
            e.position.x = e.mesh.position.x; e.position.z = e.mesh.position.z;
            e.health = e.maxHealth; e.poseDirty = true;
            enemyTactics.reset(e);
        });
    });
    return ctx;
}

test('every map has cover spots, all reachable (outside walls and pieces, inside the arena)', { timeout: 240000 }, async () => {
    const { evaluate, errors } = await boot({ quality: 'low' });
    const maps = await evaluate(() => {
        const out = {};
        for (const m of ['ascent', 'bind', 'haven', 'icebox', 'lotus', 'split']) {
            tacticalDirector.cycleMapPreset(m);
            const bad = enemyTactics.covers.filter((c) => {
                const p = new THREE.Vector3(c.x, 0, c.z);
                return resolveEnemyMapCollision(p, 0.68) || Math.abs(c.x) > 47 || Math.abs(c.z) > 47;
            }).length;
            out[m] = { n: enemyTactics.covers.length, bad };
        }
        return out;
    });
    for (const [m, r] of Object.entries(maps)) {
        assert.ok(r.n >= 30, `${m}: ${r.n} cover spots`);
        assert.equal(r.bad, 0, `${m}: cover spots are all standable`);
    }
    assert.deepEqual(errors, []);
});

test('a hurt bot takes cover out of sight, peeks to shoot, and never fires while running for cover', { timeout: 300000 }, async () => {
    const { page, errors, evaluate } = await setup();
    await evaluate(() => { const e = __bots[0]; e.health = e.maxHealth * 0.4; });
    await page.waitForFunction(() => __bots[0].aiState === 'cover', null, { timeout: 90000, polling: 50 });
    const cover = await evaluate(() => {
        const e = __bots[0], c = enemyTactics.covers[e.coverIdx];
        return { hidden: enemyTactics._hidden(c.x, c.z, characterController.position, 1), owner: enemyTactics.owner.get(e.coverIdx) === e };
    });
    assert.deepEqual(cover, { hidden: true, owner: true }, 'the chosen spot hides the bot from the player');
    await page.waitForFunction(() => __bots[0].aiState === 'peek' && __bots[0].hasSight, null, { timeout: 90000, polling: 50 });
    await page.waitForFunction(() => __shots.some((s) => s.slot === __bots[0].slot && s.state === 'peek'), null, { timeout: 90000, polling: 100 });
    const shots = await evaluate(() => __shots);
    assert.equal(shots.filter((s) => s.state === 'toCover').length, 0, 'no shots while running for cover');
    assert.deepEqual(errors, []);
});

test('pairs: the second bot flanks while its partner engages, and takes cover when the partner dies', { timeout: 300000 }, async () => {
    const { page, errors, evaluate } = await setup();
    const start = await evaluate(() => { const p = __bots[1].mesh.position; return Math.atan2(p.x, p.z - 22); });
    await page.waitForFunction(() => __bots[1].aiState === 'flank', null, { timeout: 90000, polling: 50 });
    const flank = await evaluate(() => ({ x: __bots[1].flankX, z: __bots[1].flankZ, odd: (__bots[1].slot & 1) === 1 }));
    assert.ok(flank.odd, 'the flanker is the odd slot of its pair');
    let turn = Math.abs(Math.atan2(flank.x, flank.z - 22) - start);
    if (turn > Math.PI) turn = 2 * Math.PI - turn;
    assert.ok(turn > 0.8, `the flank target swings round the player (${(turn * 57.3).toFixed(0)} degrees)`);

    // Partner killed: the survivor stops what it is doing and looks for cover
    await evaluate(() => {
        __bots[1].aiState = 'engage';
        __bots[1].nextCoverAllowed = 1e15; // only the partner's death may trigger it
        damageEnemyActor(__bots[0], 9999, performance.now(), Date.now(), 'Test', 'torso');
    });
    assert.equal(await evaluate(() => __bots[1].forceCover || ['toCover', 'cover', 'peek'].includes(__bots[1].aiState)), true);
    await page.waitForFunction(() => ['toCover', 'cover', 'peek'].includes(__bots[1].aiState), null, { timeout: 60000, polling: 50 });
    const [programs, watermark] = await programState(page);
    assert.equal(programs, watermark);
    assert.deepEqual(errors, []);
});
