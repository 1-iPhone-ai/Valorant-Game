'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser, programState } = require('./harness');

after(closeBrowser);

// End the current match with a given score and stats (the real finish path)
const HELPERS = () => {
    window.__finish = (us, them, kills, deaths) => {
        matchMode.us = us; matchMode.them = them;
        matchMode.stats.kills = kills; matchMode.stats.deaths = deaths;
        matchMode.finish(performance.now());
        return rankedLadder.lastChange;
    };
    window.__placeAt = (step, rr) => {
        rankedLadder.placed = true; rankedLadder.placements = [1, 2, 3, 4, 5].map(() => ({ won: true, diff: 0, perf: 0 }));
        rankedLadder.step = step; rankedLadder.rr = rr; rankedLadder.shield = false;
    };
};

test('ranked: a main menu mode that runs a full Match; five placements, then a rank; casual modes no longer move your rank', { timeout: 400000 }, async () => {
    const { page, errors, evaluate } = await boot({ quality: 'medium', menu: true });
    await evaluate(HELPERS);
    const r = await evaluate(() => {
        const out = {};
        document.querySelector('[data-act="modes"]').click();
        document.querySelector('[data-mode="ranked"]').click();
        out.label = document.getElementById('mm-mode-val').textContent;
        mainMenu.resume();
        out.mode = [currentModeId(), game.gameMode, matchMode.ranked, matchMode.variant, matchMode.cfg.winTarget === MATCH.winTarget];
        out.hud0 = document.getElementById('open-career-btn').textContent;
        out.bots0 = game.userSettings.botDifficulty;
        // Casual rank changes are gone
        tacticalEnhancements.onRoundWon('ELIMINATED', 'wave', performance.now());
        tacticalEnhancements.onRangeCompleted(25, 80, 50, 'S');
        out.casual = [rankedLadder.placed, rankedLadder.placements.length, rankedLadder.rr];
        // Placements: no rank until the fifth
        const results = [[7, 3], [7, 4], [5, 7], [7, 2], [7, 5]];
        out.steps = results.map(([us, them], i) => {
            const c = __finish(us, them, 16, 10);
            const placed = rankedLadder.placed;
            if (i < 4) matchMode.start('match', true);
            return [c.event, placed, document.getElementById('open-career-btn').textContent];
        });
        out.rank = [rankedLadder.nameOf(rankedLadder.step), rankedLadder.rr, rankedLadder.step];
        out.panel = document.querySelector('#match-result .rk-panel').textContent.replace(/\s+/g, ' ').trim();
        out.restored = game.userSettings.botDifficulty;
        out.history = rankedLadder.history.length;
        return out;
    });
    assert.equal(r.label, 'RANKED');
    assert.deepEqual(r.mode, ['ranked', 'match', true, 'match', true], 'a full Match flagged ranked');
    assert.equal(r.hud0, 'UNRANKED 0/5 [K]');
    assert.equal(r.bots0, 'gold', 'placements are against Gold bots');
    assert.deepEqual(r.casual, [false, 0, 0], 'casual rounds and the Range leave the rank alone');
    assert.deepEqual(r.steps.slice(0, 4).map((s) => s.slice(0, 2)), [['placement', false], ['placement', false], ['placement', false], ['placement', false]]);
    assert.equal(r.steps[1][2], 'UNRANKED 2/5 [K]');
    assert.deepEqual(r.steps[4].slice(0, 2), ['placed', true], 'the fifth match places you');
    assert.ok(r.rank[2] >= 3 && r.rank[2] <= 14, `placed between Bronze 1 and Platinum 3 (${r.rank[0]})`);
    assert.match(r.panel, /YOUR RANK/);
    assert.match(r.steps[4][2], new RegExp(`${r.rank[0]} • ${r.rank[1]} RR`));
    assert.equal(r.restored, 'gold', 'your Bot Skill setting is back after the match');
    assert.equal(r.history, 5);

    // Saved across a reload
    await page.reload();
    await page.waitForFunction(() => window.perfTelemetry && perfTelemetry.programWatermark > 0, null, { timeout: 180000 });
    const saved = await evaluate(() => [rankedLadder.placed, rankedLadder.nameOf(rankedLadder.step), rankedLadder.rr, rankedLadder.history.length]);
    assert.deepEqual(saved, [true, r.rank[0], r.rank[1], 5]);
    const [programs, watermark] = await programState(page);
    assert.equal(programs, watermark);
    assert.deepEqual(errors, []);
});

test('ranked RR: wins and losses scale with the margin and your play; promotion with a demotion shield; demotion; floors and the top', { timeout: 300000 }, async () => {
    const { errors, evaluate } = await boot({ quality: 'medium' });
    await evaluate(HELPERS);
    const r = await evaluate(() => {
        const L = rankedLadder, out = {};
        const R = (won, us, them, kills, deaths, mvps) => L.rrFor({ won, us, them, kills, deaths, mvps: mvps || 0 });
        out.winBig = R(true, 7, 1, 20, 8); out.winClose = R(true, 7, 6, 20, 8);
        out.winCarry = R(true, 7, 5, 25, 8, 3); out.winBottom = R(true, 7, 5, 4, 12);
        out.lossClose = R(false, 6, 7, 15, 12); out.lossBig = R(false, 1, 7, 15, 12);
        out.lossGood = R(false, 5, 7, 22, 9, 2); out.lossBad = R(false, 5, 7, 3, 14);
        tacticalDirector.setGameMode('ranked');
        // Gold 2 at 90 RR: a win promotes to Gold 3 with a shield
        __placeAt(10, 90);
        let c = __finish(7, 3, 18, 9);
        out.promote = [c.event, L.nameOf(L.step), L.rr < 90, L.shield];
        out.banner = document.querySelector('#match-result .rk-panel').textContent.replace(/\s+/g, ' ');
        // The next heavy loss is absorbed by the shield (stays Gold 3 at 0 RR)
        L.rr = 5; matchMode.start('match', true);
        c = __finish(1, 7, 3, 14);
        out.shielded = [c.event, L.nameOf(L.step), L.rr, L.shield];
        // Without a shield, dropping below 0 demotes
        L.rr = 5; matchMode.start('match', true);
        c = __finish(1, 7, 3, 14);
        out.demote = [c.event, L.nameOf(L.step), L.rr > 70];
        // Iron 1 floor; Radiant top keeps counting RR
        __placeAt(0, 3); matchMode.start('match', true);
        c = __finish(0, 7, 1, 14);
        out.floor = [L.nameOf(L.step), L.rr];
        __placeAt(24, 150); matchMode.start('match', true);
        c = __finish(7, 2, 20, 6);
        out.top = [L.nameOf(L.step), L.rr > 150];
        return out;
    });
    assert.ok(r.winBig > r.winClose, `a bigger win gives more (${r.winBig} vs ${r.winClose})`);
    assert.ok(r.winCarry > r.winBottom, `playing better gives more (${r.winCarry} vs ${r.winBottom})`);
    assert.ok(r.winBottom > 0 && r.lossGood < 0);
    assert.ok(r.lossClose > r.lossBig, `a close loss costs less (${r.lossClose} vs ${r.lossBig})`);
    assert.ok(r.lossGood > r.lossBad, `playing well in a loss costs less (${r.lossGood} vs ${r.lossBad})`);
    assert.deepEqual(r.promote, ['promoted', 'GOLD 3', true, true]);
    assert.match(r.banner, /PROMOTED TO GOLD 3/);
    assert.deepEqual(r.shielded, ['shielded', 'GOLD 3', 0, false], 'the shield stops the first drop');
    assert.deepEqual(r.demote, ['demoted', 'GOLD 2', true]);
    assert.deepEqual(r.floor, ['IRON 1', 0]);
    assert.deepEqual(r.top, ['RADIANT', true]);
    assert.deepEqual(errors, []);
});

test('ranked: bots play at your level; leaving after a round counts as a loss, leaving before it starts does not', { timeout: 300000 }, async () => {
    const { errors, evaluate } = await boot({ quality: 'medium' });
    await evaluate(HELPERS);
    const r = await evaluate(() => {
        const L = rankedLadder, out = {};
        game.userSettings.botDifficulty = 'gold';
        const skillAt = (step) => { __placeAt(step, 50); tacticalDirector.setGameMode('ranked'); const s = game.userSettings.botDifficulty; tacticalDirector.setGameMode('wave'); return s; };
        out.skills = [skillAt(1), skillAt(10), skillAt(17), skillAt(24)];
        out.after = game.userSettings.botDifficulty;
        // Leave before any round is played: nothing recorded
        __placeAt(10, 50);
        const n0 = L.history.length;
        tacticalDirector.setGameMode('ranked');
        tacticalDirector.setGameMode('wave');
        out.earlyLeave = [L.history.length - n0, L.rr];
        // Leave after a round: a loss
        tacticalDirector.setGameMode('ranked');
        matchMode.us = 1; matchMode.them = 2; matchMode.round = 4;
        tacticalDirector.setGameMode('wave');
        out.lateLeave = [L.history[0].abandoned, L.history[0].won, L.rr < 50];
        return out;
    });
    assert.deepEqual(r.skills, ['iron', 'gold', 'immortal', 'radiant'], 'Bronze, Gold, Diamond, Radiant');
    assert.equal(r.after, 'gold', 'your setting is restored');
    assert.deepEqual(r.earlyLeave, [0, 50]);
    assert.deepEqual(r.lateLeave, [true, false, true]);
    assert.deepEqual(errors, []);
});
