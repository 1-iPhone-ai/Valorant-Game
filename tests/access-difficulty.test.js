'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser } = require('./harness');

after(closeBrowser);

test('Reduce Flashes: off by default; on softens screen washes and flashbangs and stops the low-health pulse', { timeout: 240000 }, async () => {
    const { errors, evaluate, frames } = await boot();
    const off = await evaluate(() => {
        agentSystem.triggerScreenWash('rgba(255, 251, 235, 0.78)', 620);
        return { setting: game.userSettings.reduceFlashes, cls: document.body.classList.contains('reduce-flashes'), wash: agentSystem._washEl.style.background };
    });
    assert.equal(off.setting, false);
    assert.equal(off.cls, false);
    assert.match(off.wash, /0\.78\)/, 'full-strength wash by default');

    await evaluate(() => document.querySelector('#setting-reduce-flash-pills [data-reduceflash="on"]').click());
    const on = await evaluate(() => {
        agentSystem.triggerScreenWash('rgba(255, 251, 235, 0.78)', 620);
        lowHealthFx.el.classList.add('active');
        const cs = getComputedStyle(lowHealthFx.el);
        return {
            setting: game.userSettings.reduceFlashes,
            cls: document.body.classList.contains('reduce-flashes'),
            wash: agentSystem._washEl.style.background,
            fade: agentSystem._washEl.style.transition,
            pulse: cs.animationName,
            saved: JSON.parse(localStorage.getItem('valorant_v16_user_settings') || '{}').reduceFlashes
        };
    });
    assert.equal(on.setting, true);
    assert.equal(on.cls, true);
    assert.match(on.wash, /0\.23\d*\)/, `wash alpha cut to 30% (${on.wash})`);
    assert.match(on.fade, /280ms/, 'and kept short');
    assert.equal(on.pulse, 'none', 'low-health warning no longer pulses');
    assert.equal(on.saved, true, 'the choice is saved');

    // Flashbang overlay: a 0.42 peak shows at no more than 35% of that
    await evaluate(() => { agentSystem.playerBlindPeak = 0.42; agentSystem.playerBlindUntil = performance.now() + 450; });
    await frames(1);
    const flash = await evaluate(() => parseFloat(document.getElementById('fx-flash').style.opacity) || 0);
    assert.ok(flash <= 0.42 * 0.35 + 0.01, `flashbang overlay softened (${flash})`);
    assert.deepEqual(errors, []);
});

test('Cyan (protanopia) enemy colour recolours bots', { timeout: 240000 }, async () => {
    const { errors, evaluate } = await boot();
    const r = await evaluate(() => {
        document.querySelector('#setting-enemy-color-pills [data-enemycol="cyan"]').click();
        const e = enemyObjects.find((x) => x.isActive);
        return { torso: e.leaves[0].material.color.getHex(), want: new THREE.Color(0x0891b2).convertSRGBToLinear().getHex(), setting: game.userSettings.enemyHighlightColor };
    });
    assert.deepEqual(r, { torso: r.want, want: r.want, setting: 'cyan' });
    assert.deepEqual(errors, []);
});

test('bot tactics follow Bot Skill: Iron never flanks or repositions; Radiant flanks and peeks pre-aimed', { timeout: 240000 }, async () => {
    const { errors, evaluate } = await boot();
    const r = await evaluate(() => {
        tacticalEnhancements.toggleWingmanAI(false);
        const bots = enemyObjects.filter((e) => e.isActive && !e.hit).sort((a, b) => a.slot - b.slot);
        const [a, b] = bots;
        const player = new THREE.Vector3(0, 1.7, 22);
        const tryFlank = (diff) => {
            game.userSettings.botDifficulty = diff;
            enemyTactics.reset(b);
            a.hasSight = true;
            b.mesh.position.set(7, 0, 11);
            b.nextFlankAt = 0;
            b.nextCoverAllowed = 1e15; // isolate the flank decision
            const now = performance.now();
            enemyTactics.step(b, b.mesh.position, player, 13, now, 1, 1);
            return { state: b.aiState, reposition: b.repositionAt };
        };
        const iron = tryFlank('iron');
        const gold = tryFlank('gold');
        const radiant = tryFlank('radiant');
        // Peeking on Radiant clears the shot timer so the first sight fires at once
        enemyTactics.reset(a);
        a.mesh.position.set(-7, 0, 11);
        a.coverIdx = enemyTactics._pickCover(a, a.mesh.position, player, 1);
        a.aiState = 'cover'; a.aiUntil = 0; a.hasSight = true; a.lastShot = Date.now();
        enemyTactics.step(a, a.mesh.position, player, 13, performance.now(), 1, 1);
        const radiantPeek = { state: a.aiState, lastShot: a.lastShot };
        game.userSettings.botDifficulty = 'gold';
        return { iron, gold, radiant, radiantPeek, levels: Object.keys(BOT_TACTIC_LEVELS) };
    });
    assert.deepEqual(r.levels, ['iron', 'gold', 'immortal', 'radiant']);
    assert.equal(r.iron.state, 'engage', 'iron does not flank');
    assert.equal(r.iron.reposition, Infinity, 'iron never repositions on a timer');
    assert.equal(r.gold.state, 'flank');
    assert.equal(r.radiant.state, 'flank');
    assert.deepEqual(r.radiantPeek, { state: 'peek', lastShot: 0 }, 'radiant peeks pre-aimed');
    assert.deepEqual(errors, []);
});
