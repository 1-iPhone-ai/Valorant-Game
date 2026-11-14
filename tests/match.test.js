'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser, programState } = require('./harness');

after(closeBrowser);

// Skipping a phase also skips any round-highlight replay (the post-round pause waits for it)
const skipPhase = (evaluate) => evaluate(() => { matchMode.phaseEndsAt = performance.now(); replayDirector.stop(); });
const killAll = (evaluate) => evaluate(() => {
    for (const e of enemyObjects) if (e.isActive && !e.hit) damageEnemyActor(e, 9999, performance.now(), Date.now(), 'Test', 'torso');
});

test('Match: buy phase locks the player; rounds, economy, death with no respawn, death recap', { timeout: 300000 }, async () => {
    const { page, errors, frames, evaluate } = await boot({ quality: 'low' });
    await evaluate(() => document.getElementById('mode-match-btn').click());
    const start = await evaluate(() => ({
        mode: game.gameMode, phase: matchMode.phase, round: matchMode.round, side: matchMode.side,
        creds: game.creds, bots: matchMode.botsAlive(), x: Math.round(characterController.position.x),
        wingmen: tacticalEnhancements.wingmanGroup ? tacticalEnhancements.wingmanGroup.visible : false
    }));
    assert.deepEqual(start, { mode: 'match', phase: 'buy', round: 1, side: 'attack', creds: 800, bots: start.bots, x: -42, wingmen: start.wingmen });
    assert.ok(start.bots >= 2, 'defenders spawned');

    // Buy phase: holding W does not move the player, and shots are blocked
    const before = await evaluate(() => { game.keys.w = true; return [characterController.position.x, characterController.position.z, game.lastShot]; });
    await frames(20);
    const during = await evaluate(() => { shoot(); game.keys.w = false; return [characterController.position.x, characterController.position.z, game.lastShot]; });
    assert.deepEqual(during, before, 'frozen in the buy phase');
    assert.equal(await evaluate(() => tacticalEnhancements.wingmanGroup ? tacticalEnhancements.wingmanGroup.visible : false), false, 'no wingmen in a match');

    // Live: eliminating the defenders wins the round (+3000 and kill rewards)
    await skipPhase(evaluate);
    await frames(3);
    assert.equal(await evaluate(() => matchMode.phase), 'live');
    const credsLive = await evaluate(() => game.creds);
    await killAll(evaluate);
    await frames(3);
    const r1 = await evaluate(() => ({ phase: matchMode.phase, us: matchMode.us, them: matchMode.them, creds: game.creds }));
    assert.deepEqual([r1.phase, r1.us, r1.them], ['post', 1, 0]);
    assert.ok(r1.creds >= credsLive + 3000, 'round-win money');
    // Dead bots stay dead during the pause; the next round brings them back
    await skipPhase(evaluate);
    await frames(3);
    assert.deepEqual(await evaluate(() => [matchMode.phase, matchMode.round, matchMode.botsAlive() > 0]), ['buy', 2, true]);

    // Killed by a bot: round lost, no respawn, the recap names the killer
    await skipPhase(evaluate);
    await frames(3);
    const recap = await evaluate(() => {
        const e = enemyObjects.find((x) => x.isActive && !x.hit);
        game.shield = 0;
        for (let i = 0; i < 6; i++) takeDamage(25, e.mesh.position, { enemy: e });
        const el = document.getElementById('death-recap');
        return {
            them: matchMode.them, dead: matchMode.playerDead, health: game.health,
            visible: el.classList.contains('visible'), text: el.textContent,
            name: ENEMY_ARCHETYPES[e.archetype].shortName, lossBonus: game.creds
        };
    });
    assert.equal(recap.them, 1);
    assert.equal(recap.dead, true);
    assert.ok(recap.visible && recap.text.includes(recap.name), 'recap names the killer');
    assert.match(recap.text, /took 100/, 'recap shows the damage taken');
    await page.waitForTimeout(3600);
    assert.equal(await evaluate(() => game.health), 0, 'no respawn mid-round in a match');
    await skipPhase(evaluate);
    await frames(3);
    assert.deepEqual(await evaluate(() => [game.health, matchMode.playerDead, document.getElementById('death-recap').classList.contains('visible')]), [100, false, false]);
    assert.deepEqual(errors, []);
});

test('Match: attack plant and detonation; halftime swap; bots plant and the player defuses; victory screen', { timeout: 400000 }, async () => {
    const { page, errors, frames, evaluate } = await boot({ quality: 'low' });
    await evaluate(() => {
        tacticalDirector.setGameMode('match');
        window.__god = setInterval(() => { if (game.health > 0) { game.health = 100; game.shield = 50; } }, 30);
    });
    await skipPhase(evaluate);
    await frames(3);

    // Attack: plant on site A, detonation wins
    await evaluate(() => {
        const a = tacticalDirector.spikeSites.A.pos;
        window.__hold = setInterval(() => { characterController.position.set(a.x, 1.7, a.z); game.keys.f = true; }, 20);
    });
    await page.waitForFunction(() => tacticalDirector.spikeState === 'planted', null, { timeout: 60000 });
    await evaluate(() => { clearInterval(__hold); game.keys.f = false; });
    assert.equal(await evaluate(() => tacticalDirector.spikeDetonateDurationMs), 45000, 'match spike timer');
    await evaluate(() => { for (const e of enemyObjects) e.blindedUntil = performance.now() + 60000; tacticalDirector.spikeDetonateAt = performance.now() + 50; });
    await page.waitForFunction(() => matchMode.phase === 'post', null, { timeout: 60000 });
    assert.deepEqual(await evaluate(() => [matchMode.us, matchMode.them, matchMode.stats.plants]), [1, 0, 1]);

    // Jump to the end of the first half
    await evaluate(() => { matchMode.round = 6; matchMode.us = 5; matchMode.them = 1; game.creds = 7000; });
    await skipPhase(evaluate);
    await frames(3);
    const half = await evaluate(() => ({ round: matchMode.round, side: matchMode.side, creds: game.creds, x: Math.round(characterController.position.x) }));
    assert.deepEqual(half, { round: 7, side: 'defend', creds: 800, x: 42 }, 'sides swap and money resets at half');

    // Bots carry the spike to the target site and plant it
    await skipPhase(evaluate);
    await frames(3);
    const plant = await evaluate(() => {
        const key = matchMode.plantSiteKey, site = tacticalDirector.spikeSites[key].pos;
        const goal = matchMode.botGoal();
        const e = enemyObjects.find((x) => x.isActive && !x.hit);
        e.mesh.position.set(site.x + 1, 0, site.z);
        e.blindedUntil = 0;
        matchMode.update(4.2, performance.now());
        return { key, goalIsSite: goal === site, state: tacticalDirector.spikeState, at: tacticalDirector.activeSpikeSiteKey };
    });
    assert.ok(plant.goalIsSite, 'attacking bots head for the target site');
    assert.equal(plant.state, 'planted');
    assert.equal(plant.at, plant.key);

    // The player defuses it: round won, which is the 7th
    await evaluate(() => {
        for (const e of enemyObjects) if (e.isActive && !e.hit) e.blindedUntil = performance.now() + 60000;
        const p = tacticalDirector.activeSpikeSitePos;
        window.__hold = setInterval(() => { characterController.position.set(p.x, 1.7, p.z); game.keys.f = true; }, 20);
    });
    await page.waitForFunction(() => matchMode.phase === 'post', null, { timeout: 60000 });
    await evaluate(() => { clearInterval(__hold); game.keys.f = false; });
    assert.deepEqual(await evaluate(() => [matchMode.us, matchMode.stats.defuses]), [6, 1]);

    await evaluate(() => { matchMode.us = 6; });
    await skipPhase(evaluate);
    await frames(3);
    await skipPhase(evaluate);
    await frames(3);
    await killAll(evaluate);
    await frames(3);
    await skipPhase(evaluate);
    await frames(3);
    const end = await evaluate(() => {
        const el = document.getElementById('match-result');
        return { phase: matchMode.phase, us: matchMode.us, visible: el && el.classList.contains('visible'), text: el ? el.textContent : '' };
    });
    assert.equal(end.phase, 'over');
    assert.equal(end.us, 7);
    assert.ok(end.visible && /VICTORY/.test(end.text) && /7 : /.test(end.text), 'victory screen with the score');

    // Back to Wave mode from the result screen
    await evaluate(() => document.getElementById('match-exit-btn').click());
    await frames(3);
    assert.deepEqual(await evaluate(() => [game.gameMode, matchMode.active, document.getElementById('match-result').classList.contains('visible')]), ['wave', false, false]);
    await evaluate(() => clearInterval(__god));
    const [programs, watermark] = await programState(page);
    assert.equal(programs, watermark);
    assert.deepEqual(errors, []);
});

test('death recap in Wave mode: shown on death, gone after the respawn', { timeout: 240000 }, async () => {
    const { page, errors, evaluate } = await boot({ quality: 'low' });
    const r = await evaluate(() => {
        const e = enemyObjects.find((x) => x.isActive && !x.hit);
        damageEnemyActor(e, 20, performance.now(), Date.now(), 'Vandal', 'torso');
        game.shield = 0;
        for (let i = 0; i < 4; i++) takeDamage(30, e.mesh.position, { enemy: e });
        const el = document.getElementById('death-recap');
        return { visible: el.classList.contains('visible'), text: el.textContent };
    });
    assert.ok(r.visible);
    assert.match(r.text, /KILLED BY/);
    assert.match(r.text, /dealt 20/, 'shows the damage you dealt to the killer');
    await page.waitForFunction(() => game.health === 100, null, { timeout: 30000 });
    assert.equal(await evaluate(() => document.getElementById('death-recap').classList.contains('visible')), false);
    assert.deepEqual(errors, []);
});

test('defence round: the bots route round the map to the site and plant on their own', { timeout: 300000 }, async () => {
    const { page, errors, evaluate } = await boot({ quality: 'low' });
    const route = await evaluate(() => {
        tacticalDirector.setGameMode('match');
        window.__god = setInterval(() => { game.health = 100; }, 30);
        matchMode.round = 6;
        matchMode.startRound(performance.now());
        matchMode.phaseEndsAt = performance.now();
        // A route from the attacker spawn to the target site never crosses a blocked cell
        const site = tacticalDirector.spikeSites[matchMode.plantSiteKey].pos;
        const path = navGrid.findPath(-42, 0, site.x, site.z);
        let clear = !!path, prev = { x: -42, z: 0 };
        for (const p of path || []) { if (!navGrid._clearLine(prev.x, prev.z, p.x, p.z)) clear = false; prev = p; }
        return { side: matchMode.side, ok: clear, end: path ? path[path.length - 1] : null, site: { x: site.x, z: site.z } };
    });
    assert.equal(route.side, 'defend');
    assert.ok(route.ok, 'route stays clear of walls');
    assert.deepEqual(route.end, route.site, 'route ends at the site');
    await page.waitForFunction(() => tacticalDirector.spikeState === 'planted', null, { timeout: 200000, polling: 250 });
    assert.equal(await evaluate(() => tacticalDirector.activeSpikeSiteKey === matchMode.plantSiteKey), true);
    await evaluate(() => clearInterval(__god));
    assert.deepEqual(errors, []);
});
