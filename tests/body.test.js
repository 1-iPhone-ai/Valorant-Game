'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser, programState } = require('./harness');

after(closeBrowser);

test('your body: shown in play in your agent colour, hidden in menus, replays, while down and with Show Body off', { timeout: 300000 }, async () => {
    const { errors, frames, evaluate } = await boot({ quality: 'high' });
    await evaluate(() => { window.updateEnemies = () => {}; agentSystem.selectAgent('phoenix'); });
    await frames(3);
    const r = await evaluate(() => {
        const out = {};
        const vis = () => { playerBody.update(1 / 60); return playerBody.group.visible; };
        out.play = vis();
        const c = playerBody.accentMat.color.clone().convertLinearToSRGB(), want = new THREE.Color('#ff9d2e');
        out.colour = Math.abs(c.r - want.r) + Math.abs(c.g - want.g) + Math.abs(c.b - want.b) < 0.02;
        const feet = camera.position.y - characterController.height;
        out.feet = Math.abs(playerBody.group.position.y - feet) < 1e-6;
        // Behind the eye, facing the same way
        const yaw = camera.rotation.y;
        out.behind = (playerBody.group.position.x - camera.position.x) * -Math.sin(yaw) + (playerBody.group.position.z - camera.position.z) * -Math.cos(yaw) < 0;
        out.yaw = Math.abs(playerBody.group.rotation.y - yaw) < 1e-6;
        mainMenu.show('pause'); out.menu = vis(); mainMenu.resume();
        replayDirector.clip = { kind: 'test' }; out.replay = vis(); replayDirector.clip = null;
        game.health = 0; out.dead = vis(); game.health = 100;
        document.querySelector('#setting-showbody-pills [data-showbody="off"]').click(); out.off = vis();
        document.querySelector('#setting-showbody-pills [data-showbody="on"]').click(); out.on = vis();
        out.saved = JSON.parse(localStorage.getItem('valorant_v16_user_settings') || '{}').showBody;
        return out;
    });
    assert.equal(r.play, true);
    assert.ok(r.colour, 'Phoenix orange');
    assert.ok(r.feet && r.behind && r.yaw, 'stands under and just behind the eye, facing your way');
    assert.deepEqual([r.menu, r.replay, r.dead, r.off, r.on, r.saved], [false, false, false, false, true, true]);
    assert.deepEqual(errors, []);
});

test('walk, stand, jump and crouch poses; the body casts a shadow; no new shader programs', { timeout: 300000 }, async () => {
    const { page, errors, evaluate } = await boot({ quality: 'high' });
    const r = await evaluate(() => {
        window.updateEnemies = () => {};
        window.presentPlayerCamera = () => {};
        const out = {};
        const cc = characterController;
        const step = (dx, n) => { for (let i = 0; i < n; i++) { camera.position.x += dx; playerBody.update(1 / 60); } };
        camera.position.set(0, 1.7, 22); camera.rotation.set(0, 0, 0, 'YXZ');
        playerBody.lastX = 0; playerBody.lastZ = 22;
        cc.grounded = true; cc.height = 1.7;
        // Walking (6 m/s): legs swing in opposite directions
        let maxSwing = 0, opposite = true;
        for (let i = 0; i < 60; i++) {
            step(0.1, 1);
            const a = playerBody.legs[0].rotation.x, b = playerBody.legs[1].rotation.x;
            maxSwing = Math.max(maxSwing, Math.abs(a));
            if (Math.abs(a) > 0.05 && Math.sign(a) === Math.sign(b)) opposite = false;
        }
        out.walk = { amp: playerBody.amp, maxSwing, opposite };
        // Standing still: the stride settles
        step(0, 90);
        out.stand = playerBody.amp;
        // In the air: legs tuck
        cc.grounded = false; step(0, 30);
        out.air = [playerBody.legs[0].rotation.x, playerBody.legs[1].rotation.x];
        cc.grounded = true; step(0, 60);
        // Crouched: shorter, feet still on the floor
        cc.height = 1.0; camera.position.y = 1.0; step(0, 1);
        out.crouch = { scale: playerBody.group.scale.y, feet: playerBody.group.position.y };
        cc.height = 1.7; camera.position.y = 1.7; step(0, 1);

        // Shadow: the floor next to the body is darker with the body shown
        const rt = new THREE.WebGLRenderTarget(64, 64); rt.texture.encoding = THREE.sRGBEncoding;
        // A narrow view of the floor where the shadow falls (about 2 m across, the body
        // itself out of frame), so the shadow is a large part of the picture
        const cam = new THREE.PerspectiveCamera(14, 1, 0.1, 100);
        const sun = directionalLight.position.clone().normalize();
        const p = playerBody.group.position;
        // Where the body's shadow falls: away from the sun, about 1 m out
        const sx = p.x - sun.x / Math.max(0.2, sun.y) * 1.0, sz = p.z - sun.z / Math.max(0.2, sun.y) * 1.0;
        cam.position.set(sx, 9, sz + 0.01); cam.lookAt(sx, 0, sz);
        const lum = () => {
            shadowManager.markEvent(); shadowManager.beforeRender(performance.now() + 1e5);
            renderer.setRenderTarget(rt); renderer.setClearColor(0, 1); renderer.clear(); renderer.render(scene, cam);
            const px = new Uint8Array(64 * 64 * 4); renderer.readRenderTargetPixels(rt, 0, 0, 64, 64, px); renderer.setRenderTarget(null);
            let s = 0; for (let i = 0; i < px.length; i += 4) s += px[i] + px[i + 1] + px[i + 2]; return s / (64 * 64 * 3);
        };
        playerBody.group.visible = true;
        const withBody = lum();
        playerBody.group.visible = false;
        const without = lum();
        playerBody.group.visible = true;
        out.shadow = [withBody, without];
        return out;
    });
    assert.ok(r.walk.amp > 0.8 && r.walk.maxSwing > 0.3, `walking swings the legs (${r.walk.amp.toFixed(2)}, ${r.walk.maxSwing.toFixed(2)})`);
    assert.ok(r.walk.opposite, 'legs swing in opposite directions');
    assert.ok(r.stand < 0.05, `standing still settles (${r.stand})`);
    assert.ok(r.air[0] < -0.1 && r.air[1] < -0.05, 'legs tuck in the air');
    assert.ok(r.crouch.scale < 0.65 && Math.abs(r.crouch.feet) < 1e-6, `crouched: shorter (${r.crouch.scale.toFixed(2)}) with feet on the floor`);
    assert.ok(r.shadow[0] < r.shadow[1] - 3, `the body casts a shadow (${r.shadow[0].toFixed(1)} vs ${r.shadow[1].toFixed(1)})`);
    const [programs, watermark, stalls] = await programState(page);
    assert.equal(programs, watermark);
    assert.equal(stalls, 0);
    assert.deepEqual(errors, []);
});
