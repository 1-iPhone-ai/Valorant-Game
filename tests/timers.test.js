'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser } = require('./harness');

after(closeBrowser);

// V2.2: ability timers run on game time (gameNow), which moves only with the 60 Hz steps. So a pause
// (the menu, photo mode) and the time a long frame drops no longer use up a smoke, a cooldown or a
// blind, as they did on the real clock; at a steady frame rate nothing changes.

// Counts the game's 60 Hz steps, so a check can say how much game time passed
const COUNT_STEPS = () => {
    window.updateEnemies = () => {};
    const orig = window.stepSimulation;
    window.__steps = 0;
    window.stepSimulation = function (dt, t) { __steps++; return orig(dt, t); };
};

test('ability timers stand still while paused (menu, photo mode) and lose only the game time a long frame keeps', { timeout: 300000 }, async () => {
    const { page, errors, frames, evaluate } = await boot({ quality: 'low' });
    await evaluate(COUNT_STEPS);
    // Omen's Dark Cover (a 15 s smoke, and its charge starts recharging), and a bot blinded for 20 s
    await evaluate(() => {
        agentSystem.selectAgent('omen');
        const st = agentSystem.stateByAgent.omen;
        for (const k of ['c', 'q', 'e']) { st[k].charges = st[k].maxCharges; st[k].rechargeEnd = 0; }
        const cc = characterController;
        cc.position.set(0, cc.standHeight, 22); cc.prevSimPosition.copy(cc.position);
        camera.rotation.set(-0.6, 0, 0, 'YXZ');
        agentSystem.castAbility('e');
        const e = enemyObjects.find((x) => x.isActive && !x.hit);
        window.__bot = e;
        agentSystem.applyEnemyBlind(e, gameNow(), 20000);
    });
    await page.waitForFunction(() => agentSystem.smokes.some((s) => s.inUse), null, { timeout: 60000, polling: 50 });
    const read = () => evaluate(() => {
        const now = gameNow();
        const sm = agentSystem.smokes.find((s) => s.inUse);
        const e = agentSystem.stateByAgent.omen.e;
        return {
            steps: __steps, real: performance.now(),
            smoke: sm ? sm.expireAt - now : null,
            recharge: e.rechargeEnd ? e.rechargeEnd - now : null,
            blind: __bot.blindedUntil - now
        };
    });
    const phase = async (name, run) => {
        const a = await read();
        await run();
        const b = await read();
        const gameMs = (b.steps - a.steps) * 1000 / 60, realMs = b.real - a.real;
        for (const k of ['smoke', 'recharge', 'blind']) {
            assert.ok(a[k] !== null && b[k] !== null, `${name}: ${k} still running`);
            const used = a[k] - b[k];
            // one step's leeway: the reading between steps includes the time waiting to be simulated
            assert.ok(Math.abs(used - gameMs) <= 1000 / 60 + 1, `${name}: the ${k} used ${used.toFixed(0)} ms, the game moved ${gameMs.toFixed(0)} ms (real ${realMs.toFixed(0)} ms)`);
        }
        assert.ok(realMs > gameMs + 500, `${name}: real time ran on (${realMs.toFixed(0)} ms) while the game moved ${gameMs.toFixed(0)} ms`);
    };
    await phase('pause menu', async () => {
        await evaluate(() => mainMenu.show('pause'));
        await page.waitForTimeout(1500);
        await evaluate(() => mainMenu.resume());
        await frames(2);
    });
    await phase('photo mode', async () => {
        await evaluate(() => photoMode.enter());
        await page.waitForTimeout(1500);
        await evaluate(() => photoMode.exit());
        await frames(2);
    });
    await phase('one 900 ms frame', async () => {
        await evaluate(() => { const t = performance.now(); while (performance.now() - t < 900) {} });
        await frames(2);
    });
    // The bot is still blinded: its blind stood still with the game
    assert.ok(await evaluate(() => __bot.blindedUntil > gameNow()), 'the bot is still blinded');
    assert.deepEqual(errors, []);
});

test('game time: moves only with the game steps, never goes back, and a timer lasts its length in game time', { timeout: 300000 }, async () => {
    const { page, errors, evaluate } = await boot({ quality: 'low' });
    await evaluate(COUNT_STEPS);
    // Sample game time every frame for a while: it never goes back, and it moves by the steps taken
    const r = await evaluate(() => new Promise((resolve) => {
        const out = { back: 0, samples: 0 };
        let last = gameNow(), steps0 = __steps, g0 = gameNow(), n = 0;
        const tick = () => {
            const g = gameNow();
            if (g < last) out.back++;
            last = g; out.samples++;
            if (++n < 40) requestAnimationFrame(tick);
            else { out.gameMs = g - g0; out.stepMs = (__steps - steps0) * 1000 / 60; resolve(out); }
        };
        requestAnimationFrame(tick);
    }));
    assert.equal(r.back, 0, 'game time never goes back');
    // between steps it includes what waits to be simulated (under one step)
    assert.ok(Math.abs(r.gameMs - r.stepMs) < 1000 / 60, `game time ${r.gameMs.toFixed(1)} ms vs steps ${r.stepMs.toFixed(1)} ms`);

    // A smoke lasts its length in game time, whatever the frame rate here (a short one, 2 s). Smokes are
    // checked once a frame, against that frame's game time, so it ends in the first frame whose game time
    // has passed its end, and the frames before were not past it. (Counting steps to that frame gives up
    // to three more than its length on a slow machine, where one frame runs up to four steps: 123 on CI.)
    // A frame exactly at the end may still show it: game time adds 1000/60 ms a step and 120 of them can
    // come to a hair under 2000 ms, so the check allows a microsecond either way.
    await evaluate(() => {
        const t = gameNow();
        agentSystem.spawnSmokeSphere(0, 1, 18, 0x6d28d9, 4.6, 2000, t);
        const sm = agentSystem.smokes.find((s) => s.inUse && s.expireAt === t + 2000);
        window.__sm = { t: t, prev: null, end: null };
        const orig = agentSystem.updateRender;
        let last = t;
        agentSystem.updateRender = function (time, now, delta) {
            const was = sm.inUse;
            const r = orig.call(this, time, now, delta);
            if (was && !sm.inUse && __sm.end === null) { __sm.prev = last; __sm.end = now; }
            last = now;
            return r;
        };
    });
    await page.waitForFunction(() => __sm.end !== null, null, { timeout: 240000, polling: 'raf' });
    const sm = await evaluate(() => __sm);
    assert.ok(sm.prev - sm.t <= 2000 + 1e-3 && sm.end - sm.t >= 2000 - 1e-3,
        `the smoke ended in the frame at ${(sm.end - sm.t).toFixed(1)} ms of game time, the frame before was at ${(sm.prev - sm.t).toFixed(1)} ms (2000 ms)`);
    assert.deepEqual(errors, []);
});
