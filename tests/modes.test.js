'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser, programState } = require('./harness');

after(closeBrowser);

// Plays each game mode through its full loop. Low quality keeps SwiftShader
// fast; god mode keeps the player alive while standing on a site.
async function setup() {
    const ctx = await boot({ quality: 'low', viewport: { width: 320, height: 180 } });
    await ctx.evaluate(() => {
        game.userSettings.infiniteAmmo = true;
        window.__god = () => { game.health = 100; game.shield = 50; };
        window.__killAll = () => {
            let n = 0;
            for (const e of enemyObjects) if (e.isActive && !e.hit) { damageEnemyActor(e, 9999, performance.now(), Date.now(), 'Test', 'torso'); n++; }
            return n;
        };
        window.__standAt = (x, z) => { __god(); characterController.position.set(x, 1.7, z); characterController.prevSimPosition.copy(characterController.position); };
    });
    const until = async (fn, arg, maxFrames = 900) => {
        for (let i = 0; i < maxFrames; i += 3) {
            if (await ctx.evaluate(fn, arg)) return true;
            await ctx.frames(3);
        }
        return false;
    };
    return { ...ctx, until };
}

test('Wave mode: kills advance the wave; plant, enemy defuse and detonation work', { timeout: 600000 }, async () => {
    const { errors, frames, evaluate, until } = await setup();
    await evaluate(() => tacticalDirector.setGameMode('wave'));
    const r0 = await evaluate(() => game.roundNumber);
    for (let i = 0; i < 8 && (await evaluate(() => game.roundNumber)) === r0; i++) {
        await evaluate(() => { __killAll(); for (const e of enemyObjects) if (e.hit) respawnEnemy(e); });
        await frames(3);
    }
    assert.ok((await evaluate(() => game.roundNumber)) > r0, 'clearing the quota starts the next wave');

    await evaluate(() => { __standAt(0, -22); game.keys.f = true; });
    assert.ok(await until(() => { __standAt(0, -22); return tacticalDirector.spikeState === 'planted'; }), 'holding F on Site A plants the spike');
    await evaluate(() => { game.keys.f = false; });

    await evaluate(() => { const e = enemyObjects.find((x) => x.isActive && !x.hit); e.mesh.position.set(1, 0, -22); e.blindedUntil = 0; });
    assert.ok(await until(() => tacticalDirector.enemyDefuseProgress > 0, null, 120), 'an enemy on site starts defusing');

    const r1 = await evaluate(() => game.roundNumber);
    await evaluate(() => { tacticalDirector.spikeDetonateAt = performance.now() + 100; for (const e of enemyObjects) if (e.isActive && !e.hit) e.mesh.position.set(30, 0, 30); });
    assert.ok(await until((r) => game.roundNumber > r && tacticalDirector.spikeState === 'unplanted', r1, 120), 'detonation wins the round');
    assert.deepEqual(errors, []);
});

test('Retake mode: defuse wins and moves sites, 50% checkpoint holds, detonation resets', { timeout: 600000 }, async () => {
    const { errors, frames, evaluate, until } = await setup();
    await evaluate(() => tacticalDirector.setGameMode('retake'));
    await frames(3);
    const start = await evaluate(() => ({ state: tacticalDirector.spikeState, site: tacticalDirector.activeSpikeSiteKey, round: game.roundNumber }));
    assert.equal(start.state, 'planted', 'retake starts with the spike planted');

    await evaluate(() => { __killAll(); const p = tacticalDirector.activeSpikeSitePos; __standAt(p.x, p.z); game.keys.f = true; });
    assert.ok(await until((r) => { const p = tacticalDirector.activeSpikeSitePos; __standAt(p.x, p.z); return game.roundNumber > r; }, start.round), 'defusing wins the round');
    await evaluate(() => { game.keys.f = false; });
    assert.notEqual(await evaluate(() => tacticalDirector.activeSpikeSiteKey), start.site, 'the next round is on the other site');

    await evaluate(() => { __killAll(); const p = tacticalDirector.activeSpikeSitePos; __standAt(p.x, p.z); game.keys.f = true; });
    await until(() => { const p = tacticalDirector.activeSpikeSitePos; __standAt(p.x, p.z); return tacticalDirector.spikeDefuseProgress >= 0.55; });
    await evaluate(() => { game.keys.f = false; __standAt(0, 0); });
    await frames(10);
    assert.ok((await evaluate(() => tacticalDirector.spikeDefuseProgress)) >= 0.5, 'progress past 50% is kept after letting go');

    await evaluate(() => { tacticalDirector.spikeDetonateAt = performance.now() + 100; });
    await frames(10);
    const after = await evaluate(() => ({ state: tacticalDirector.spikeState, progress: tacticalDirector.spikeDefuseProgress }));
    assert.equal(after.state, 'planted', 'a detonation restarts the retake');
    assert.equal(after.progress, 0, 'with defuse progress reset');
    assert.deepEqual(errors, []);
});

test('Range mode: 30 bots to a scorecard, retry, map change and exit', { timeout: 600000 }, async () => {
    const { errors, frames, evaluate } = await setup();
    await evaluate(() => tacticalDirector.setGameMode('range'));
    await frames(3);
    assert.equal(await evaluate(() => tacticalDirector.rangeActive), true);
    let kills = 0;
    for (let i = 0; i < 80 && !(await evaluate(() => rangeScorecard.classList.contains('visible'))); i++) {
        kills += await evaluate(() => {
            const b = tacticalDirector.activeRangeBot;
            if (!b || !b.isActive || b.hit) return 0;
            tacticalDirector.recordShot(b, true);
            damageEnemyActor(b, 9999, performance.now(), Date.now(), 'Test', 'head');
            return 1;
        });
        await frames(2);
    }
    const card = await evaluate(() => ({ visible: rangeScorecard.classList.contains('visible'), rank: rangeRankBadge.textContent.trim() }));
    assert.equal(card.visible, true, 'the scorecard appears');
    assert.equal(kills, 30, 'the challenge is 30 bots');
    assert.ok(card.rank.length > 0, 'a rank is shown');

    await evaluate(() => rangeRetryBtn.click());
    await frames(3);
    assert.deepEqual(await evaluate(() => ({ active: tacticalDirector.rangeActive, card: rangeScorecard.classList.contains('visible') })), { active: true, card: false });
    await evaluate(() => tacticalDirector.cycleMapPreset('split'));
    await frames(3);
    assert.equal(await evaluate(() => tacticalDirector.rangeActive), true, 'a map change keeps the range running');
    await evaluate(() => rangeExitBtn.click());
    await frames(3);
    assert.deepEqual(await evaluate(() => ({ mode: game.gameMode, active: tacticalDirector.rangeActive })), { mode: 'wave', active: false });
    assert.deepEqual(errors, []);
});

test('a death is counted once even if hits keep landing before respawn', { timeout: 240000 }, async () => {
    const { page, errors, evaluate } = await setup();
    const r = await evaluate(() => {
        const d0 = game.playerDeaths || 0;
        takeDamage(999, null); takeDamage(999, null); takeDamage(999, null);
        return { deaths: (game.playerDeaths || 0) - d0, hp: game.health };
    });
    assert.deepEqual(r, { deaths: 1, hp: 0 });
    // The respawn is a 3 s timer; wait for it rather than for wall-clock time
    await page.waitForFunction(() => game.health === 100, null, { timeout: 60000, polling: 100 });
    assert.equal(await evaluate(() => game.health), 100, 'respawns with full health');
    const [programs, watermark] = await programState(page);
    assert.equal(programs, watermark);
    assert.deepEqual(errors, []);
});
