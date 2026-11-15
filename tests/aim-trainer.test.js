'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser, programState } = require('./harness');

after(closeBrowser);

// Aim the camera at a point and fire a real shot (first-tap accuracy)
const HELPERS = () => {
    window.__aimAt = (p) => {
        const cam = camera.position;
        const dx = p.x - cam.x, dy = p.y - cam.y, dz = p.z - cam.z;
        camera.rotation.set(Math.atan2(dy, Math.hypot(dx, dz)), Math.atan2(-dx, -dz), 0, 'YXZ');
    };
    window.__fire = () => { game.lastShot = 0; game.recoilHeat = 0; game.sprayIndex = 0; shoot(); };
};

test('aim trainer: a main menu mode with no bots or wingmen, a drill picker, then Gridshot scores real shots with reaction time and saves a best', { timeout: 400000 }, async () => {
    const { page, errors, frames, evaluate } = await boot({ quality: 'medium', menu: true });
    await evaluate(HELPERS);
    const pick = await evaluate(() => {
        document.querySelector('[data-act="modes"]').click();
        document.querySelector('[data-mode="aim"]').click();
        const label = document.getElementById('mm-mode-val').textContent;
        mainMenu.resume();
        return {
            label, mode: game.gameMode, state: aimTrainer.state,
            cards: Array.from(document.querySelectorAll('#aim-trainer .aim-card b')).map((b) => b.textContent),
            bots: enemyObjects.filter((e) => e.isActive).length, menuOpen: mainMenu.open
        };
    });
    assert.equal(pick.label, 'AIM TRAINER');
    assert.deepEqual([pick.mode, pick.state], ['aim', 'pick']);
    assert.deepEqual(pick.cards, ['GRIDSHOT', 'FLICK', 'TRACKING']);
    assert.equal(pick.bots, 0, 'no bots');
    assert.equal(pick.menuOpen, false, 'letting go of the mouse for the picker does not open the pause menu');
    await frames(3);
    assert.equal(await evaluate(() => tacticalEnhancements.wingmanGroup.visible), false, 'no wingmen');

    await evaluate(() => document.querySelector('[data-aim="drill:gridshot"]').click());
    assert.equal(await evaluate(() => aimTrainer.state), 'countdown');
    await page.waitForFunction(() => aimTrainer.state === 'live', null, { timeout: 60000, polling: 50 });
    const live = await evaluate(() => {
        const out = { up: aimTrainer.targets.filter((t) => t.alive).length };
        // Three real hits, then a deliberate miss (straight up)
        for (let i = 0; i < 3; i++) { const t = aimTrainer.targets.find((x) => x.alive); __aimAt(t.mesh.position); __fire(); }
        out.afterHits = [aimTrainer.hits, aimTrainer.misses, aimTrainer.reactions.length];
        const scoreAfterHits = aimTrainer.score;
        camera.rotation.set(1.2, 0, 0, 'YXZ'); __fire();
        out.afterMiss = [aimTrainer.hits, aimTrainer.misses, aimTrainer.score === scoreAfterHits - 25];
        out.scoreEach = scoreAfterHits >= 300;
        out.ammoFull = game.weapons[game.activeWeapon].ammo;
        return out;
    });
    assert.equal(live.up, 3, 'three targets up');
    assert.deepEqual(live.afterHits, [3, 0, 3], 'real shots hit the targets and time the reaction');
    assert.deepEqual(live.afterMiss, [3, 1, true], 'a miss costs 25');
    assert.ok(live.scoreEach, 'each hit scores at least 100');
    await frames(3);
    assert.equal(await evaluate(() => aimTrainer.targets.filter((t) => t.alive).length), 3, 'hit targets come back elsewhere');
    assert.equal(await evaluate(() => { const w = game.weapons[game.activeWeapon]; return w.ammo === w.maxAmmo; }), true, 'unlimited ammo');

    // Time up: results, best saved, XP, the pause menu stays shut
    const done = await evaluate(() => { aimTrainer.t = 999; return progression.totalXp; });
    await page.waitForFunction(() => aimTrainer.state === 'done', null, { timeout: 30000 });
    const res = await evaluate((xp0) => ({
        result: aimTrainer.lastResult, xp: progression.totalXp - xp0, menu: mainMenu.open,
        card: document.querySelector('#aim-trainer .aim-score-big').textContent,
        saved: JSON.parse(localStorage.getItem('valorant_v17_aim_best') || '{}').gridshot
    }), done);
    assert.equal(res.result.hits, 3);
    assert.equal(res.result.misses, 1);
    assert.equal(res.result.accuracy, 75);
    assert.ok(res.result.avgReaction > 0, 'average reaction time');
    assert.equal(res.result.best, true, 'first run is a new best');
    assert.match(res.card, /NEW BEST/);
    assert.equal(res.saved.score, res.result.score, 'best score saved');
    assert.equal(res.xp, res.result.xp, 'XP awarded');
    assert.ok(res.xp >= 150);
    assert.equal(res.menu, false);

    // Leave: back to Wave with the bots and wingmen
    await evaluate(() => document.querySelector('#aim-trainer [data-aim="leave"]').click());
    await frames(3);
    const left = await evaluate(() => ({ mode: game.gameMode, active: aimTrainer.active, targets: aimTrainer.group.visible, bots: enemyObjects.filter((e) => e.isActive).length, wing: tacticalEnhancements.wingmanGroup.visible }));
    assert.deepEqual([left.mode, left.active, left.targets], ['wave', false, false]);
    assert.ok(left.bots > 0, 'bots are back');
    assert.equal(left.wing, true, 'wingmen are back');
    const [programs, watermark, stalls] = await programState(page);
    assert.equal(programs, watermark, 'no new shader programs');
    assert.equal(stalls, 0);
    assert.deepEqual(errors, []);
});

test('aim trainer: Flick shows one small target; Tracking scores time on a moving target; a lower score is not a new best', { timeout: 400000 }, async () => {
    const { page, errors, frames, evaluate } = await boot({ quality: 'medium' });
    await evaluate(HELPERS);
    await evaluate(() => { tacticalDirector.setGameMode('aim'); aimTrainer.begin('flick'); aimTrainer.countdown = 0; });
    await page.waitForFunction(() => aimTrainer.state === 'live', null, { timeout: 30000 });
    const flick = await evaluate(() => {
        const up = aimTrainer.targets.filter((t) => t.alive);
        const t = up[0];
        const size = t.mesh.scale.x;
        __aimAt(t.mesh.position); __fire();
        return { up: up.length, size, grid: AIM_DRILLS.gridshot.size, hits: aimTrainer.hits };
    });
    assert.equal(flick.up, 1, 'one target');
    assert.ok(flick.size < flick.grid, 'smaller than Gridshot');
    assert.equal(flick.hits, 1);

    await evaluate(() => { aimTrainer.begin('tracking'); aimTrainer.countdown = 0; });
    await page.waitForFunction(() => aimTrainer.state === 'live', null, { timeout: 30000 });
    // Follow the target for a while, then look away
    const pos0 = await evaluate(() => aimTrainer.targets[0].mesh.position.clone());
    for (let i = 0; i < 20; i++) {
        await evaluate(() => __aimAt(aimTrainer.targets[0].mesh.position));
        await frames(1);
    }
    const on = await evaluate(() => ({ onTime: aimTrainer.onTime, total: aimTrainer.total, score: aimTrainer.score, moved: aimTrainer.targets[0].mesh.position.distanceTo(new THREE.Vector3()) }));
    await evaluate(() => camera.rotation.set(1.2, 0, 0, 'YXZ'));
    await frames(10);
    const off = await evaluate(() => ({ onTime: aimTrainer.onTime, total: aimTrainer.total, pos: aimTrainer.targets[0].mesh.position.clone() }));
    assert.ok(on.onTime > 0 && on.score === Math.round(on.onTime * 100), `time on target scores (${on.onTime.toFixed(2)} s)`);
    assert.ok(off.total > on.total && Math.abs(off.onTime - on.onTime) < 0.05, 'looking away stops the score');
    assert.ok(Math.hypot(off.pos.x - pos0.x, off.pos.y - pos0.y) > 0.05, 'the target moves');

    // Gridshot best 5000 already; a weaker run is not a new best
    const notBest = await evaluate(() => {
        aimTrainer.best.gridshot = { score: 5000, acc: 90, at: 0 };
        aimTrainer.begin('gridshot'); aimTrainer.state = 'live'; aimTrainer.score = 100;
        aimTrainer.finish();
        return [aimTrainer.lastResult.best, aimTrainer.best.gridshot.score];
    });
    assert.deepEqual(notBest, [false, 5000]);
    assert.deepEqual(errors, []);
});
