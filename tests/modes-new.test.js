'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser, programState } = require('./harness');

after(closeBrowser);

test('Deathmatch: free-for-all board, your kills and deaths, bots killing each other, quick respawns, first to 40 wins', { timeout: 400000 }, async () => {
    const { page, errors, frames, evaluate } = await boot({ quality: 'low' });
    await evaluate(() => document.getElementById('mode-dm-btn').click());
    await frames(3);
    const start = await evaluate(() => ({
        mode: game.gameMode, active: dmMode.active, board: document.getElementById('dm-board').classList.contains('visible'),
        bots: enemyObjects.filter((e) => e.isActive && !e.hit).length, entries: dmMode.scores.size,
        wingmen: tacticalEnhancements.wingmanGroup ? tacticalEnhancements.wingmanGroup.visible : false,
        spike: tacticalDirector.spikeGroup ? tacticalDirector.spikeGroup.visible : false
    }));
    assert.deepEqual([start.mode, start.active, start.board, start.wingmen, start.spike], ['deathmatch', true, true, false, false]);
    assert.ok(start.bots >= 6 && start.entries === start.bots + 1, `${start.bots} bots on the board`);

    // You kill a bot: your score, and it respawns 2 s later somewhere else
    const k = await evaluate(() => {
        const e = enemyObjects.find((x) => x.isActive && !x.hit);
        window.__k = e;
        const pos = e.mesh.position.clone();
        damageEnemyActor(e, 9999, performance.now(), Date.now(), 'Vandal', 'head');
        return { you: dmMode.scores.get('you').kills, deaths: dmMode._botEntry(e).deaths, pos: pos.toArray() };
    });
    assert.deepEqual([k.you, k.deaths], [1, 1]);
    await page.waitForFunction(() => __k.isActive && !__k.hit, null, { timeout: 30000 });
    // Two bots face to face: they trade fire until one goes down
    const duel = await evaluate(() => {
        const bots = enemyObjects.filter((x) => x.isActive && !x.hit).slice(0, 2);
        const p = characterController.position;
        // Far from the player, in the open, 6 m apart with nothing between them. A random open spot
        // alone put the second bot inside or behind a wall of the walled Ascent about 40% of the
        // time, and then neither bot ever had a shot (the test failed at random)
        let spot = null;
        for (let i = 0; i < 200 && !spot; i++) {
            const s = findOpenSpot(30, 0), s2 = s.clone();
            s2.x += 6;
            if (resolveEnemyMapCollision(s2.clone(), 0.8, true)) continue;
            if (agentSystem.hasWallLineOfSight(new THREE.Vector3(s.x, 1.45, s.z), new THREE.Vector3(s2.x, 1.3, s2.z), 6)) spot = s;
        }
        bots[0].mesh.position.set(spot.x, 0, spot.z); bots[1].mesh.position.set(spot.x + 6, 0, spot.z);
        for (const b of enemyObjects) if (b !== bots[0] && b !== bots[1] && b.isActive) { b.mesh.position.set(-45, 0, -45 + b.slot * 2); }
        for (const b of bots) { b.poseDirty = true; syncEnemyBroadphase(b); b.dmNextShotAt = 0; }
        window.updateEnemies = () => {};
        let t = performance.now();
        for (let i = 0; i < 200 && !bots.some((b) => b.hit); i++) { t += 600; for (const b of bots) b.dmNextShotAt = 0; dmMode._duels(t); }
        return { down: bots.some((b) => b.hit), botKills: dmMode.botKills, feed: document.getElementById('kill-feed').textContent };
    });
    assert.ok(duel.down && duel.botKills >= 1, 'bots kill each other');
    assert.match(duel.feed, /eliminated/);

    // A bot kills you: its score and your death; you respawn at full health somewhere else
    const died = await evaluate(() => {
        const e = enemyObjects.find((x) => x.isActive && !x.hit);
        const before = characterController.position.clone();
        game.shield = 0;
        for (let i = 0; i < 6; i++) takeDamage(25, e.mesh.position, { enemy: e });
        window.__before = before;
        return { you: dmMode.scores.get('you').deaths, bot: dmMode._botEntry(e).kills };
    });
    assert.ok(died.you === 1 && died.bot >= 1);
    await page.waitForFunction(() => game.health === 100, null, { timeout: 60000 });

    // First to 40: the result screen with your placing
    const fin = await evaluate(() => {
        dmMode.scores.get('you').kills = 39;
        const e = enemyObjects.find((x) => x.isActive && !x.hit);
        damageEnemyActor(e, 9999, performance.now(), Date.now(), 'Vandal', 'head');
        const el = document.getElementById('dm-result');
        return { over: dmMode.over, shown: el && el.classList.contains('visible'), text: el ? el.textContent : '' };
    });
    assert.ok(fin.over && fin.shown, 'match over at 40 kills');
    assert.match(fin.text, /1ST PLACE/);
    await evaluate(() => document.getElementById('dm-exit-btn').click());
    await frames(3);
    assert.deepEqual(await evaluate(() => [game.gameMode, dmMode.active, document.getElementById('dm-board').classList.contains('visible')]), ['wave', false, false]);
    assert.equal(await evaluate(() => enemyObjects.filter((e) => e.dmExtra && e.isActive).length), 0, 'the extra bots leave with the mode');
    const [programs, watermark] = await programState(page);
    assert.equal(programs, watermark);
    assert.deepEqual(errors, []);
});

test('Spike Rush: first to 4, a random gun each round, full abilities, power-up orbs, no buying; menu and keys', { timeout: 400000 }, async () => {
    const { page, errors, frames, evaluate } = await boot({ quality: 'low' });
    await page.keyboard.press('F9');
    await frames(3);
    const r = await evaluate(() => ({
        mode: currentModeId(), variant: matchMode.variant, win: matchMode.cfg.winTarget, half: matchMode.cfg.halfRounds,
        creds: game.creds, gun: spikeRush.gun, active: game.activeWeapon, orbs: spikeRush.orbs.filter((o) => o.active && o.mesh.visible).length,
        charges: ['c', 'q', 'e'].every((k) => { const s = agentSystem.stateByAgent[game.activeAgent][k]; return s.charges === s.maxCharges; }),
        title: document.getElementById('round-title') ? document.getElementById('round-title').textContent : '',
        btn: document.getElementById('mode-rush-btn').classList.contains('active'), matchBtn: document.getElementById('mode-match-btn').classList.contains('active'),
        // The start phase is 4 s (a slow runner can be past it already, then the round is live)
        cfgBuy: matchMode.cfg.buyMs, phase: matchMode.phase,
        buyMs: matchMode.phase === 'buy' ? matchMode.phaseEndsAt - performance.now() : 0
    }));
    assert.equal(r.mode, 'spikerush');
    assert.deepEqual([r.variant, r.win, r.half, r.creds], ['spikerush', 4, 3, 0]);
    assert.ok(r.gun && r.active === r.gun[0], `random gun ${r.gun}`);
    assert.equal(r.orbs, 4, 'four power-up orbs');
    assert.ok(r.charges, 'abilities full');
    assert.ok(r.btn && !r.matchBtn);
    assert.equal(r.cfgBuy, 4000, 'short 4 s start, no buy phase');
    assert.ok(r.phase === 'live' || r.buyMs <= 4100, `start phase within 4 s (${r.phase}, ${Math.round(r.buyMs)} ms)`);

    // Picking up orbs
    const orbs = await evaluate(() => {
        const out = {};
        game.health = 40; game.shield = 0; game.ultPoints = 0;
        for (const o of spikeRush.orbs) {
            characterController.position.set(o.x, 1.7, o.z);
            spikeRush.update(1 / 60, performance.now());
            out[o.type] = !o.active && !o.mesh.visible;
        }
        out.health = game.health; out.shield = game.shield; out.ultPts = game.ultPoints; out.haste = game.powerHasteUntil > performance.now();
        return out;
    });
    assert.deepEqual([orbs.haste, orbs.armor, orbs.ult, orbs.heal], [true, true, true, true], 'all four picked up');
    assert.deepEqual([orbs.health, orbs.shield, orbs.ultPts], [100, 50, 2]);
    assert.ok(orbs.haste);

    // Rounds: a win, then a new round with a (possibly different) random gun; 4 wins ends it.
    // Each step waits for the phase it needs: on a slow runner the 4 s start can already be
    // over, and ending a live round early would count as running out of time.
    const goLive = async () => {
        await evaluate(() => { if (matchMode.phase === 'buy') matchMode.phaseEndsAt = performance.now(); });
        await page.waitForFunction(() => matchMode.phase === 'live', null, { timeout: 30000 });
    };
    const winRound = async () => {
        await evaluate(() => { for (const e of enemyObjects) if (e.isActive && !e.hit) damageEnemyActor(e, 9999, performance.now(), Date.now(), 'Vandal', 'torso'); });
        await page.waitForFunction(() => matchMode.phase === 'post' || matchMode.phase === 'over', null, { timeout: 30000 });
        await evaluate(() => { replayDirector.stop(); if (matchMode.phase === 'post') matchMode.phaseEndsAt = performance.now(); });
    };
    await goLive();
    await winRound();
    await page.waitForFunction(() => matchMode.round === 2 && matchMode.phase !== 'post', null, { timeout: 30000 });
    assert.deepEqual(await evaluate(() => [matchMode.round, matchMode.us, spikeRush.orbs.filter((o) => o.active).length]), [2, 1, 4], 'round 2 with fresh orbs');
    await evaluate(() => { matchMode.us = 3; });
    await goLive();
    await winRound();
    await page.waitForFunction(() => matchMode.phase === 'over', null, { timeout: 30000 });
    assert.equal(await evaluate(() => matchMode.us), 4, 'first to 4');

    // Both modes are in the main menu
    const menu = await evaluate(() => Array.from(document.querySelectorAll('.mm-mode')).map((b) => b.dataset.mode));
    assert.ok(menu.includes('deathmatch') && menu.includes('spikerush'));
    await evaluate(() => tacticalDirector.setGameMode('wave'));
    await frames(2);
    assert.deepEqual(await evaluate(() => [currentModeId(), spikeRush.orbs.filter((o) => o.mesh.visible).length]), ['wave', 0]);
    const [programs, watermark] = await programState(page);
    assert.equal(programs, watermark);
    assert.deepEqual(errors, []);
});
