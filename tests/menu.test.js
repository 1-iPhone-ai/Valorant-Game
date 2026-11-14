'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser, programState } = require('./harness');

after(closeBrowser);

function fakePad() {
    const pad = { id: 'Xbox Wireless Controller (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard', axes: [0, 0, 0, 0],
        buttons: Array.from({ length: 18 }, () => ({ pressed: false, value: 0 })), vibrationActuator: { playEffect: () => Promise.resolve('complete') } };
    window.__press = (i, on) => { pad.buttons[i].pressed = on; pad.buttons[i].value = on ? 1 : 0; };
    navigator.getGamepads = () => [pad, null, null, null];
}

test('start screen: game paused under an orbiting camera; keyboard menus; agent select with descriptions; lock in starts the chosen mode', { timeout: 400000 }, async () => {
    const { page, errors, frames, evaluate } = await boot({ quality: 'medium', menu: true, viewport: { width: 1024, height: 600 } });
    const start = await evaluate(() => ({
        open: mainMenu.open, kind: mainMenu.kind, play: document.querySelector('[data-act="play"]').textContent,
        hud: getComputedStyle(document.getElementById('crosshair')).visibility,
        p: characterController.position.toArray(), cam: camera.position.toArray(),
        bots: enemyObjects.filter((e) => e.isActive).map((e) => e.mesh.position.x)
    }));
    assert.deepEqual([start.open, start.kind, start.play, start.hud], [true, 'start', 'PLAY', 'hidden']);
    // Paused: holding W does nothing and the bots stand still; the camera orbits
    await evaluate(() => { game.keys.w = true; });
    await frames(20);
    const paused = await evaluate(() => {
        const r = { p: characterController.position.toArray(), cam: camera.position.toArray(), bots: enemyObjects.filter((e) => e.isActive).map((e) => e.mesh.position.x), showcase: mainMenu.showcase.visible };
        game.keys.w = false;
        return r;
    });
    assert.deepEqual(paused.p, start.p, 'player does not move');
    assert.deepEqual(paused.bots, start.bots, 'bots do not move');
    assert.notDeepEqual(paused.cam, start.cam, 'camera orbits the map');
    assert.ok(paused.showcase, 'agent preview shown');

    // Keyboard: down to MODES, Enter, pick MATCH, Escape back
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    assert.equal(await evaluate(() => mainMenu.view), 'modes');
    await page.click('[data-mode="match"]');
    assert.deepEqual(await evaluate(() => [mainMenu.view, mainMenu.mode, document.getElementById('mm-mode-val').textContent]), ['main', 'match', 'MATCH']);
    await page.click('[data-act="controls"]');
    assert.match(await evaluate(() => document.querySelector('.mm-view.active').textContent), /Abilities and ultimate/);
    await page.keyboard.press('Escape');
    assert.equal(await evaluate(() => mainMenu.view), 'main');

    // PLAY: agent select; Escape out goes back to the menu
    await page.click('[data-act="play"]');
    assert.deepEqual(await evaluate(() => [game.agentPickerOpen, document.body.classList.contains('agent-select')]), [true, true]);
    await page.keyboard.press('Escape');
    assert.deepEqual(await evaluate(() => [game.agentPickerOpen, mainMenu.open, mainMenu.selecting]), [false, true, false]);
    await page.click('[data-act="play"]');
    // Every agent has a description for all four abilities, shown in the inspector
    const descs = await evaluate(() => {
        const missing = AGENT_ORDER.filter((id) => !ABILITY_DESC[id] || ABILITY_DESC[id].length !== 4 || ABILITY_DESC[id].some((d) => !d || d.length < 10));
        tacticalDirector.inspectAgentInPicker('sage');
        return { missing, shown: document.querySelectorAll('#inspector-abilities-list .inspector-ability-desc').length, text: document.getElementById('inspector-abilities-list').textContent };
    });
    assert.deepEqual(descs.missing, []);
    assert.equal(descs.shown, 4);
    assert.match(descs.text, /Healing orb/);
    await page.click('#agent-picker-lock-btn');
    await frames(3);
    const play = await evaluate(() => ({ open: mainMenu.open, started: mainMenu.started, agent: game.activeAgent, mode: game.gameMode, match: matchMode.active,
        hud: getComputedStyle(document.getElementById('crosshair')).visibility, showcase: mainMenu.showcase.visible, gun: weaponGroup.visible }));
    assert.deepEqual(play, { open: false, started: true, agent: 'sage', mode: 'match', match: true, hud: 'visible', showcase: false, gun: true });

    // Esc in play: the pause menu, which also pauses the round timer
    await page.keyboard.press('Escape');
    const pause = await evaluate(() => ({ open: mainMenu.open, kind: mainMenu.kind, play: document.querySelector('[data-act="play"]').textContent, left: matchMode.phaseEndsAt - performance.now() }));
    assert.deepEqual([pause.open, pause.kind, pause.play], [true, 'pause', 'RESUME']);
    await page.waitForTimeout(2500);
    const left2 = await evaluate(() => matchMode.phaseEndsAt - performance.now());
    assert.ok(Math.abs(left2 - pause.left) < 600, `buy timer paused (${Math.round(pause.left)} -> ${Math.round(left2)} ms)`);
    await page.keyboard.press('Escape');
    assert.equal(await evaluate(() => mainMenu.open), false, 'Esc again resumes');
    const [programs, watermark, stalls] = await programState(page);
    assert.equal(programs, watermark, 'the menu and the agent preview add no shader programs');
    assert.equal(stalls, 0);
    assert.deepEqual(errors, []);
});

test('controller drives the menu (Start pauses, D-pad and A select, B backs out); Skip Menu On Start is remembered', { timeout: 400000 }, async () => {
    const { page, errors, frames, evaluate } = await boot({ quality: 'low', menu: true, initScript: fakePad });
    const press = async (i) => { await evaluate((i) => __press(i, true), i); await frames(2); await evaluate((i) => __press(i, false), i); await frames(2); };
    assert.equal(await evaluate(() => mainMenu.open), true);
    // D-pad to MODES, then A (start screen: PLAY, MODES, SETTINGS, CONTROLS; AGENT SELECT is hidden).
    // Steer from either side: a held D-pad auto-repeats, so a slow frame can move twice.
    const focusAct = () => evaluate(() => gamepadController.navFocus && gamepadController.navFocus.dataset.act);
    const order = ['play', 'modes', 'settings', 'controls'];
    await press(13);
    for (let i = 0; i < 10; i++) {
        const at = order.indexOf(await focusAct());
        if (at === 1) break;
        await press(at > 1 ? 12 : 13);
    }
    assert.equal(await focusAct(), 'modes', 'D-pad moves the focus');
    await press(0);
    assert.equal(await evaluate(() => mainMenu.view), 'modes');
    await press(1);
    assert.equal(await evaluate(() => mainMenu.view), 'main', 'B goes back');
    // Start the game from the menu, then Start pauses and Start resumes
    await evaluate(() => { mainMenu.openAgentSelect(); tacticalDirector.lockInPickerAgent('jett'); });
    await frames(3);
    assert.equal(await evaluate(() => mainMenu.open), false);
    await press(9);
    assert.deepEqual(await evaluate(() => [mainMenu.open, mainMenu.kind]), [true, 'pause']);
    await press(9);
    assert.equal(await evaluate(() => mainMenu.open), false);

    // Skip Menu On Start: saved, and the next load goes straight into the game
    await evaluate(() => document.querySelector('#setting-skipmenu-pills [data-skipmenu="on"]').click());
    assert.equal(await evaluate(() => JSON.parse(localStorage.getItem('valorant_v16_user_settings') || '{}').skipMenu), true);
    await page.reload();
    await page.waitForFunction(() => window.perfTelemetry && perfTelemetry.programWatermark > 0 && typeof mainMenu !== 'undefined' && mainMenu.el, null, { timeout: 180000 });
    await page.waitForFunction(() => mainMenu.started || mainMenu.open, null, { timeout: 30000 });
    assert.deepEqual(await evaluate(() => [mainMenu.open, mainMenu.started]), [false, true]);
    assert.deepEqual(errors, []);
});
