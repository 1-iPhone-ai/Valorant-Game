'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser, programState } = require('./harness');

after(closeBrowser);

// A scripted stand-in for navigator.getGamepads(): standard mapping, 18 buttons.
function fakePad(id) {
    const pad = {
        id, index: 0, connected: true, mapping: 'standard',
        axes: [0, 0, 0, 0],
        buttons: Array.from({ length: 18 }, () => ({ pressed: false, value: 0 })),
        vibrationActuator: { playEffect: () => { window.__rumbles = (window.__rumbles || 0) + 1; return Promise.resolve('complete'); } }
    };
    window.__pad = pad;
    window.__press = (i, on) => { pad.buttons[i].pressed = on; pad.buttons[i].value = on ? 1 : 0; };
    navigator.getGamepads = () => [pad, null, null, null];
}

async function bootWithPad(id) {
    const ctx = await boot({ initScript: fakePad, initArg: id });
    const press = async (i, holdMs = 0) => {
        await ctx.evaluate((i) => __press(i, true), i);
        await ctx.frames(2);
        if (holdMs) await ctx.page.waitForTimeout(holdMs);
        await ctx.frames(1);
        await ctx.evaluate((i) => __press(i, false), i);
        await ctx.frames(3);
    };
    return { ...ctx, press };
}

test('PlayStation pad: detection, analog movement, look, fire, ADS, menus', { timeout: 600000 }, async () => {
    const { page, errors, frames, evaluate, press } = await bootWithPad('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)');
    assert.equal(await evaluate(() => gamepadController.family), 'playstation');

    // Analog speed: half tilt (after deadzone rescale) moves at half speed. Open lane, facing +X.
    const speed = async (axis) => {
        await evaluate(() => { characterController.position.set(-40, 1.7, 40); characterController.prevSimPosition.copy(characterController.position); characterController.velocity.set(0, 0, 0); camera.rotation.set(0, -Math.PI / 2, 0); });
        await frames(3);
        await evaluate((a) => { __pad.axes[1] = a; }, axis);
        await frames(6);
        const a0 = await evaluate(() => ({ x: characterController.position.x, t: simClock }));
        await frames(10);
        const a1 = await evaluate(() => ({ x: characterController.position.x, t: simClock }));
        await evaluate(() => { __pad.axes[1] = 0; });
        await frames(4);
        return Math.abs(a1.x - a0.x) / (a1.t - a0.t);
    };
    const ratio = (await speed(-0.56)) / (await speed(-1));
    assert.ok(Math.abs(ratio - 0.5) < 0.08, `half tilt should be ~half speed (got ${ratio.toFixed(2)})`);
    assert.equal(await evaluate(() => game.keys.w), false, 'stick release clears movement keys');
    assert.deepEqual(await evaluate(() => Array.from(document.querySelectorAll('#ability-bar .ability-key')).map((e) => e.textContent)), ['D←', 'L1', 'R1', 'D↑']);

    // Look
    const yaw0 = await evaluate(() => camera.rotation.y);
    await evaluate(() => { __pad.axes[2] = 1; });
    await frames(6);
    await evaluate(() => { __pad.axes[2] = 0; });
    await frames(2);
    assert.ok((await evaluate(() => camera.rotation.y)) < yaw0 - 0.1, 'right stick turns right');

    // Fire (automatic) and release
    await evaluate(() => { characterController.position.set(0, 1.7, 30); characterController.prevSimPosition.copy(characterController.position); camera.rotation.set(0, 0, 0); switchWeapon('rifle'); });
    await frames(4);
    const ammo0 = await evaluate(() => game.weapons.rifle.ammo);
    await evaluate(() => __press(7, true));
    await frames(8);
    await evaluate(() => __press(7, false));
    await frames(3);
    assert.ok(ammo0 - (await evaluate(() => game.weapons.rifle.ammo)) >= 2, 'holding R2 fires repeatedly');
    assert.equal(await evaluate(() => game.mouseDown || game.autoShootInterval !== null), false, 'releasing R2 stops firing');

    // ADS hold
    await evaluate(() => __press(6, true));
    await frames(4);
    assert.equal(await evaluate(() => game.adsActive), true);
    await evaluate(() => __press(6, false));
    await frames(3);
    assert.equal(await evaluate(() => game.adsActive), false);

    // Abilities via LB/RB/D-pad
    await evaluate(() => { game.userSettings.infiniteAbilities = true; window.__casts = []; const c = agentSystem.castAbility.bind(agentSystem); agentSystem.castAbility = (k) => { __casts.push(k); return c(k); }; });
    for (const b of [14, 4, 5, 12]) await press(b);
    assert.deepEqual(await evaluate(() => __casts), ['c', 'q', 'e', 'x']);

    // Menus: Options opens the pause menu; D-pad to SETTINGS and Cross opens it; R1 changes tab;
    // Circle closes settings, Circle again resumes. Hold Triangle opens buy menu.
    await press(9);
    assert.deepEqual(await evaluate(() => [mainMenu.open, mainMenu.kind]), [true, 'pause']);
    const focusAct = () => evaluate(() => gamepadController.navFocus && gamepadController.navFocus.dataset.act);
    // Steer to SETTINGS from either side (a held D-pad auto-repeats, so a slow frame can move twice)
    const order = ['play', 'agent', 'modes', 'settings', 'controls'];
    for (let i = 0; i < 10; i++) {
        const at = order.indexOf(await focusAct());
        if (at === 3) break;
        await press(at > 3 ? 12 : 13);
    }
    assert.equal(await focusAct(), 'settings', 'D-pad reaches SETTINGS');
    await press(0);
    assert.equal(await evaluate(() => game.settingsOpen), true);
    const tab0 = await evaluate(() => document.querySelector('.settings-tab-btn.active').dataset.tab);
    await press(5);
    assert.notEqual(await evaluate(() => document.querySelector('.settings-tab-btn.active').dataset.tab), tab0);
    await press(1);
    assert.deepEqual(await evaluate(() => [game.settingsOpen, mainMenu.open]), [false, true]);
    await press(1);
    assert.equal(await evaluate(() => mainMenu.open), false, 'Circle resumes the game');
    await press(3, 700);
    assert.equal(await evaluate(() => game.buyMenuOpen), true);
    await press(13);
    assert.ok(await evaluate(() => !!gamepadController.navFocus), 'D-pad focuses a menu item');
    await press(1);
    assert.equal(await evaluate(() => game.buyMenuOpen), false);

    // Keyboard input hands the prompts back
    await page.keyboard.press('KeyW');
    assert.deepEqual(await evaluate(() => Array.from(document.querySelectorAll('#ability-bar .ability-key')).map((e) => e.textContent)), ['C', 'Q', 'E', 'X']);

    const [programs, watermark] = await programState(page);
    assert.equal(programs, watermark);
    assert.deepEqual(errors, []);
});

test('Xbox pad is detected as Xbox (not PlayStation) and aim assist only slows', { timeout: 300000 }, async () => {
    const { errors, evaluate } = await bootWithPad('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)');
    assert.equal(await evaluate(() => gamepadController.family), 'xbox');
    // Aim assist is checked inside one synchronous page step: the enemy and
    // camera are placed and look() is driven with a fixed stick input and
    // frame time. (Driving it through real frames was timing dependent: on a
    // slow CI runner the crosshair had already turned past the enemy, or the
    // enemy had walked away, before the check ran.)
    const r = await evaluate(() => {
        const e = enemyObjects.find((x) => x.isActive && !x.hit);
        const place = (yaw) => {
            characterController.position.set(0, 1.7, 30);
            camera.position.set(0, 1.7, 30);
            camera.rotation.set(0, yaw, 0);
            camera.updateMatrixWorld();
            e.mesh.position.set(0, 0, 18);
            e.mesh.updateMatrixWorld();
        };
        const turn = (assist) => {
            game.userSettings.gpAimAssist = assist;
            place(0);
            gamepadController.lookHeldMs = 0;
            gamepadController.look({ x: 0.25, y: 0, mag: 0.25 }, 1 / 60);
            return { turned: Math.abs(camera.rotation.y), flagged: gamepadController.assistActive };
        };
        const out = { off: turn(false), on: turn(true) };
        place(0);
        out.targetAhead = !!gamepadController.aimAssistTarget();
        place(0.6); // ~34 degrees away from the enemy
        out.targetAway = !!gamepadController.aimAssistTarget();
        return out;
    });
    assert.equal(r.targetAhead, true, 'an enemy straight ahead is an aim-assist target');
    assert.equal(r.targetAway, false, 'an enemy far off the crosshair is not');
    assert.equal(r.off.flagged, false);
    assert.equal(r.on.flagged, true, 'assist engages on a visible enemy under the crosshair');
    assert.ok(r.on.turned < r.off.turned * 0.75, 'assist slows turning');
    assert.ok(r.on.turned > 0, 'assist never stops or reverses the player\'s input');
    assert.deepEqual(errors, []);
});
