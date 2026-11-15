'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser, programState } = require('./harness');

after(closeBrowser);

// Shared in-page helpers: run the 60 Hz player step directly, with the frame loop's
// own player update paused so only these ticks move the player
const HELPERS = () => {
    window.updateEnemies = () => {};
    const cc = characterController;
    window.__mv = {
        place(x, z, yaw) {
            cc.reset();
            cc.position.set(x, cc.standHeight, z);
            cc.velocity.set(0, 0, 0);
            cc.grounded = true;
            cc.slideCooldown = 0;
            camera.rotation.set(0, yaw, 0, 'YXZ');
            for (const k of Object.keys(game.keys)) game.keys[k] = false;
        },
        tick(n) { for (let i = 0; i < n; i++) cc.update(1 / 60); },
        speed() { return Math.hypot(cc.velocity.x, cc.velocity.z); },
        foot() { return +(cc.position.y - cc.height).toFixed(2); }
    };
};

test('slide: crouch while sprinting slides low and fast, ends on its own, has a cooldown, keeps speed into a jump, tilts the view and can be turned off', { timeout: 300000 }, async () => {
    const { page, errors, evaluate } = await boot({ quality: 'medium' });
    await evaluate(HELPERS);
    const r = await evaluate(() => {
        const cc = characterController, mv = __mv, out = {};
        const sprintTop = cc.terminalSpeed(cc.sprintSpeed);
        // Sprint east along an open lane, then crouch
        mv.place(-30, 32, -Math.PI / 2);
        game.keys.w = true; cc.setSprinting(true);
        mv.tick(40);
        out.sprint = mv.speed();
        cc.setCrouching(true);
        out.started = cc.slideTimer > 0 && cc.slideStarts === 1;
        out.boost = mv.speed() > sprintTop * 1.1;
        const x0 = cc.position.x;
        mv.tick(20);
        out.low = cc.height < cc.standHeight - 0.4;
        out.slideDist = cc.position.x - x0;
        mv.tick(60);
        out.ended = cc.slideTimer === 0;
        // Crouch-walking the same 20 ticks covers far less ground
        mv.place(-30, 32, -Math.PI / 2);
        game.keys.w = true; cc.setCrouching(true);
        mv.tick(30);
        const x1 = cc.position.x;
        mv.tick(20);
        out.crouchDist = cc.position.x - x1;
        out.noSlideFromWalk = cc.slideStarts === 1;
        // Cooldown: an immediate second slide is refused
        mv.place(-30, 32, -Math.PI / 2);
        game.keys.w = true; cc.setSprinting(true); mv.tick(40);
        cc.setCrouching(true); cc.setCrouching(false); cc.setSprinting(true); mv.tick(2);
        cc.setCrouching(true);
        out.cooldown = cc.slideStarts === 2 && cc.slideTimer === 0;
        // Jumping out of a slide keeps the speed in the air
        mv.place(-30, 32, -Math.PI / 2);
        game.keys.w = true; cc.setSprinting(true); mv.tick(40);
        cc.setCrouching(true); mv.tick(5);
        game.keys.space = true; jumpQueued = true; mv.tick(1); game.keys.space = false;
        out.jumpAir = !cc.grounded && cc.slideTimer === 0;
        mv.tick(6);
        out.airSpeed = mv.speed();
        out.walkTop = cc.terminalSpeed(cc.walkSpeed);
        // Setting off: crouching while sprinting is just a crouch
        document.querySelector('#setting-slide-pills [data-slide="off"]').click();
        mv.place(-30, 32, -Math.PI / 2);
        game.keys.w = true; cc.setSprinting(true); mv.tick(40);
        const before = cc.slideStarts;
        cc.setCrouching(true);
        out.offNoSlide = cc.slideStarts === before && cc.slideTimer === 0;
        out.saved = JSON.parse(localStorage.getItem('valorant_v16_user_settings') || '{}').slide;
        document.querySelector('#setting-slide-pills [data-slide="on"]').click();
        game.keys.w = false;
        return out;
    });
    assert.ok(r.started, 'crouch while sprinting starts a slide');
    assert.ok(r.boost, 'the slide starts faster than a sprint');
    assert.ok(r.low, 'you are low while sliding');
    assert.ok(r.slideDist > r.crouchDist * 1.6, `slide covers more ground than crouch-walking (${r.slideDist.toFixed(1)} vs ${r.crouchDist.toFixed(1)})`);
    assert.ok(r.ended, 'the slide ends on its own');
    assert.ok(r.noSlideFromWalk, 'no slide when not sprinting');
    assert.ok(r.cooldown, 'a second slide right away is refused');
    assert.ok(r.jumpAir, 'jumping ends the slide in the air');
    assert.ok(r.airSpeed > r.walkTop * 1.2, `speed carries into the jump (${r.airSpeed.toFixed(2)})`);
    assert.ok(r.offNoSlide, 'Slide Off: no slide');
    assert.equal(r.saved, false, 'the setting is saved');

    // The view tilts while sliding and comes back level exactly
    const tilt = await evaluate(() => {
        const cc = characterController, mv = __mv;
        const z0 = camera.rotation.z;
        mv.place(-30, 32, -Math.PI / 2);
        game.keys.w = true; cc.setSprinting(true); mv.tick(40);
        cc.setCrouching(true);
        let max = 0;
        for (let i = 0; i < 20; i++) { mv.tick(1); slideCamera.update(1 / 60); max = Math.max(max, Math.abs(camera.rotation.z - z0)); }
        cc.setCrouching(false); game.keys.w = false;
        for (let i = 0; i < 120; i++) { mv.tick(1); slideCamera.update(1 / 60); }
        return { max, back: camera.rotation.z - z0, roll: slideCamera.roll };
    });
    assert.ok(tilt.max > 0.03, `the view tilts while sliding (${tilt.max.toFixed(3)})`);
    assert.equal(tilt.back, 0, 'and levels out exactly');
    assert.equal(tilt.roll, 0);
    const [programs, watermark] = await programState(page);
    assert.equal(programs, watermark);
    assert.deepEqual(errors, []);
});

test('mantle: jumping into a chest-high ledge climbs onto it; too high or Mantle off does not', { timeout: 300000 }, async () => {
    const { errors, evaluate } = await boot({ quality: 'medium' });
    await evaluate(HELPERS);
    const r = await evaluate(() => {
        tacticalDirector.cycleMapPreset('skyline');
        const cc = characterController, mv = __mv, out = {};
        // Run at the east deck (top 2.2 m, no steps at z = 6) and jump into it
        const jumpInto = (x, z, yaw) => {
            mv.place(x, z, yaw);
            game.keys.w = true;
            mv.tick(3);
            game.keys.space = true; jumpQueued = true; mv.tick(1); game.keys.space = false;
            let mantled = false;
            for (let i = 0; i < 60; i++) {
                mv.tick(1);
                if (cc.mantleT >= 0) mantled = true;
                else if (mantled) break;      // on top: stop there
            }
            game.keys.w = false;
            cc.velocity.x = cc.velocity.z = 0;
            mv.tick(20);
            return { mantled, foot: mv.foot(), x: +cc.position.x.toFixed(2) };
        };
        out.deck = jumpInto(27.5, 6, -Math.PI / 2);
        out.count = cc.mantleCount;
        // The helipad (3 m) is out of reach
        out.helipad = jumpInto(8.5, 3, Math.PI / 2);
        // Without pushing forward into it, no mantle: jump straight up next to the deck
        mv.place(29.4, 6, -Math.PI / 2);
        game.keys.space = true; jumpQueued = true; mv.tick(1); game.keys.space = false;
        mv.tick(40);
        out.noPush = { count: cc.mantleCount, foot: mv.foot() };
        // Mantle Off
        document.querySelector('#setting-mantle-pills [data-mantle="off"]').click();
        out.off = jumpInto(27.5, 6, -Math.PI / 2);
        document.querySelector('#setting-mantle-pills [data-mantle="on"]').click();
        return out;
    });
    assert.ok(r.deck.mantled, 'climbs the 2.2 m deck');
    assert.equal(r.deck.foot, 2.2, 'standing on top');
    assert.ok(r.deck.x > 30, 'on the deck, not at its edge');
    assert.equal(r.count, 1);
    assert.equal(r.helipad.mantled, false, 'a 3 m block is too high');
    assert.equal(r.helipad.foot, 0);
    assert.deepEqual(r.noPush, { count: 1, foot: 0 }, 'no mantle without moving into the ledge');
    assert.equal(r.off.mantled, false, 'Mantle Off');
    assert.equal(r.off.foot, 0);
    assert.deepEqual(errors, []);
});

test('air movement: momentum carries further in the air than on the ground, you can steer, and you never gain speed', { timeout: 300000 }, async () => {
    const { errors, evaluate } = await boot({ quality: 'medium' });
    await evaluate(HELPERS);
    const r = await evaluate(() => {
        const cc = characterController, mv = __mv, out = {};
        // Coast on the ground: release W at full sprint
        mv.place(-30, 32, -Math.PI / 2);
        game.keys.w = true; cc.setSprinting(true); mv.tick(40);
        game.keys.w = false; let x0 = cc.position.x; mv.tick(4);
        out.groundCoast = cc.position.x - x0;
        // Coast in the air: jump at full sprint, release W
        mv.place(-30, 32, -Math.PI / 2);
        game.keys.w = true; cc.setSprinting(true); mv.tick(40);
        const takeoff = mv.speed();
        game.keys.space = true; jumpQueued = true; mv.tick(1); game.keys.space = false;
        game.keys.w = false; x0 = cc.position.x; mv.tick(4);
        out.airCoast = cc.position.x - x0;
        // Never faster than at takeoff or top speed on foot, even holding W and strafing
        mv.place(-30, 32, -Math.PI / 2);
        game.keys.w = true; cc.setSprinting(true); mv.tick(40);
        game.keys.space = true; jumpQueued = true; mv.tick(1); game.keys.space = false;
        game.keys.d = true;
        let maxAir = 0;
        const z0 = cc.position.z;
        while (!cc.grounded) { mv.tick(1); maxAir = Math.max(maxAir, mv.speed()); }
        out.noGain = maxAir <= Math.max(takeoff, cc.terminalSpeed(cc.sprintSpeed)) + 1e-9;
        out.steered = cc.position.z - z0;   // D while facing +x moves towards +z
        game.keys.w = game.keys.d = false;
        return out;
    });
    assert.ok(r.airCoast > r.groundCoast * 1.1, `momentum carries in the air (${r.airCoast.toFixed(2)} vs ${r.groundCoast.toFixed(2)})`);
    assert.ok(r.noGain, 'no speed gained in the air');
    assert.ok(r.steered > 0.3, `steering in the air works (${r.steered.toFixed(2)})`);
    assert.deepEqual(errors, []);
});
