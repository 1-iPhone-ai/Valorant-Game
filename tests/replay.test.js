'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser, programState } = require('./harness');

after(closeBrowser);

test('kill cam: replays the death from the killer, leaves the live world untouched, delays the respawn, skips with Space, can be turned off', { timeout: 400000 }, async () => {
    const { page, errors, frames, evaluate } = await boot({ quality: 'medium' });
    await evaluate(() => {
        window.updateEnemies = () => {};
        const e = enemyObjects.find((x) => x.isActive && !x.hit);
        window.__k = e;
        const p = characterController.position;
        e.mesh.position.set(p.x + 6, 0, p.z - 9);
        e.poseDirty = true;
    });
    await page.waitForTimeout(3000);
    const death = await evaluate(() => {
        game.shield = 0;
        for (let i = 0; i < 6; i++) takeDamage(25, __k.mesh.position, { enemy: __k });
        return { health: game.health, pending: !!replayDirector.pending, recorded: replayRec.count, span: replayRec.newest() - replayRec.oldest() };
    });
    assert.equal(death.health, 0);
    assert.ok(death.pending, `kill cam queued (recorded ${death.recorded} frames over ${Math.round(death.span)} ms)`);
    await page.waitForFunction(() => !!replayDirector.clip, null, { timeout: 30000 });
    await frames(4);
    const mid = await evaluate(() => {
        // One replay frame, synchronously: the world is posed for the draw and put back exactly
        const snap = () => enemyObjects.map((x) => [x.mesh.position.x, x.mesh.position.y, x.mesh.position.z, x.mesh.rotation.x, x.mesh.rotation.y, x.mesh.rotation.z, x.renderActive, x.mesh.visible].join(','))
            .concat([camera.position.toArray().join(','), camera.rotation.toArray().join(','), camera.fov]).join('|');
        const before = snap();
        replayDirector.beginFrame(performance.now());
        const posed = snap();
        replayDirector.endFrame();
        const same = snap() === before;
        return {
            moved: posed !== before,
            kind: replayDirector.clip.kind, name: document.querySelector('#replay-overlay .replay-name').textContent,
            overlay: document.getElementById('replay-overlay').classList.contains('visible'), ghost: replayDirector.ghost.visible,
            hudHidden: getComputedStyle(document.getElementById('crosshair')).visibility === 'hidden',
            liveIntact: same, cam: characterController.position.distanceTo(camera.position) < 0.5, health: game.health,
            recording: replayRec.recording
        };
    });
    assert.equal(mid.kind, 'killcam');
    assert.equal(mid.name, await evaluate(() => ENEMY_ARCHETYPES[__k.archetype].shortName), 'names the killer');
    assert.ok(mid.overlay && mid.ghost && mid.hudHidden);
    assert.ok(mid.moved, 'a replay frame poses the bots and the camera');
    assert.ok(mid.liveIntact, 'and puts them back exactly after the draw');
    assert.ok(mid.cam, 'the camera is back on the player between frames');
    assert.equal(mid.recording, false, 'the replay is not recorded over itself');
    // The respawn waits for the kill cam
    await page.waitForTimeout(3500);
    assert.deepEqual(await evaluate(() => [game.health, !!replayDirector.clip]), [0, true], 'still in the kill cam, no respawn yet');
    // Space skips (and does not jump)
    await page.keyboard.press('Space');
    await page.waitForFunction(() => !replayDirector.clip, null, { timeout: 20000 });
    await page.waitForFunction(() => game.health === 100, null, { timeout: 20000 });
    const done = await evaluate(() => ({ overlay: document.getElementById('replay-overlay').classList.contains('visible'), ghost: replayDirector.ghost.visible, gun: weaponGroup.visible, rec: replayRec.recording }));
    assert.deepEqual(done, { overlay: false, ghost: false, gun: true, rec: true });

    // Setting off: no kill cam, normal 3 s respawn
    await evaluate(() => document.querySelector('#setting-killcam-pills [data-killcam="off"]').click());
    const off = await evaluate(() => {
        game.shield = 0;
        for (let i = 0; i < 6; i++) takeDamage(25, __k.mesh.position, { enemy: __k });
        return { pending: !!replayDirector.pending, saved: JSON.parse(localStorage.getItem('valorant_v16_user_settings') || '{}').killCam };
    });
    assert.deepEqual(off, { pending: false, saved: false });
    await page.waitForFunction(() => game.health === 100, null, { timeout: 20000 });
    const [programs, watermark, stalls] = await programState(page);
    assert.equal(programs, watermark);
    assert.equal(stalls, 0);
    assert.deepEqual(errors, []);
});

test('Match: round MVP card, the round highlight replay holds the next round until it ends, round strip and best play on the result screen', { timeout: 400000 }, async () => {
    const { page, errors, frames, evaluate } = await boot({ quality: 'low' });
    await evaluate(() => {
        tacticalDirector.setGameMode('match');
        window.__god = setInterval(() => { if (game.health > 0) { game.health = 100; game.shield = 50; } }, 30);
        matchMode.phaseEndsAt = performance.now();
    });
    await frames(3);
    assert.equal(await evaluate(() => matchMode.phase), 'live');
    await page.waitForTimeout(2500);
    // Two quick headshot kills, then the rest
    await evaluate(() => {
        const alive = enemyObjects.filter((x) => x.isActive && !x.hit);
        damageEnemyActor(alive[0], 9999, performance.now(), Date.now(), 'Vandal', 'head');
        damageEnemyActor(alive[1], 9999, performance.now(), Date.now(), 'Vandal', 'head');
    });
    await page.waitForTimeout(600);
    const end = await evaluate(() => {
        for (const e of enemyObjects) if (e.isActive && !e.hit) damageEnemyActor(e, 9999, performance.now(), Date.now(), 'Vandal', 'torso');
        return {
            phase: matchMode.phase, kills: matchMode.rs.kills.length,
            mvp: document.getElementById('round-mvp').classList.contains('visible'), mvpText: document.getElementById('round-mvp').textContent,
            queued: replayDirector.queue.length + (replayDirector.clip ? 1 : 0),
            label: (replayDirector.queue[0] || replayDirector.clip || {}).name, log: matchMode.roundLog.slice()
        };
    });
    assert.equal(end.phase, 'post');
    assert.ok(end.mvp && /YOU/.test(end.mvpText) && /headshot/.test(end.mvpText), `MVP card: ${end.mvpText}`);
    assert.equal(end.queued, 1, 'highlight queued');
    assert.match(end.label, /KILL|ACE/, `highlight: ${end.label}`);
    assert.deepEqual(end.log.map((r) => [r.won, r.mvp]), [[true, true]]);
    await page.waitForFunction(() => !!replayDirector.clip, null, { timeout: 20000 });
    assert.equal(await evaluate(() => replayDirector.clip.kind), 'highlight');
    // The post-round pause waits for the replay
    await evaluate(() => { matchMode.phaseEndsAt = performance.now(); });
    await frames(3);
    assert.equal(await evaluate(() => matchMode.phase), 'post', 'next round waits for the highlight');
    await evaluate(() => replayDirector.skip());
    await page.waitForFunction(() => matchMode.phase === 'buy', null, { timeout: 20000 });
    assert.equal(await evaluate(() => matchMode.round), 2);

    // Result screen: round strip, K/D, MVPs and the best play
    const res = await evaluate(() => {
        matchMode.us = 6;
        matchMode.phaseEndsAt = performance.now();
        return true;
    });
    assert.ok(res);
    await frames(3);
    await evaluate(() => { for (const e of enemyObjects) if (e.isActive && !e.hit) damageEnemyActor(e, 9999, performance.now(), Date.now(), 'Vandal', 'torso'); replayDirector.stop(); matchMode.phaseEndsAt = performance.now(); });
    await page.waitForFunction(() => matchMode.phase === 'over', null, { timeout: 20000 });
    const scr = await evaluate(() => {
        const el = document.getElementById('match-result');
        return { strip: el.querySelectorAll('#match-rounds span').length, mvps: el.querySelectorAll('#match-rounds .mvp').length, text: el.textContent };
    });
    assert.equal(scr.strip, 2, 'one square per round');
    assert.ok(scr.mvps >= 1);
    assert.match(scr.text, /K\/D/);
    assert.match(scr.text, /ROUND MVPS/);
    assert.match(scr.text, /Best play: .*KILL/);
    await evaluate(() => clearInterval(__god));
    const [programs, watermark] = await programState(page);
    assert.equal(programs, watermark);
    assert.deepEqual(errors, []);
});
