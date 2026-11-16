'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser, programState } = require('./harness');

after(closeBrowser);

test('photo mode: J freezes the game and hides HUD, gun and body; a free camera flies, looks and zooms; Esc puts everything back exactly', { timeout: 400000 }, async () => {
    const { page, errors, frames, evaluate } = await boot({ quality: 'medium', viewport: { width: 800, height: 450 } });
    await frames(3);
    // The view at the moment photo mode starts (read in the same step)
    const before = await evaluate(() => {
        photoMode.noDownload = true;
        const b = {
            rot: [camera.rotation.x, camera.rotation.y, camera.rotation.z], fov: camera.fov, exposure: renderer.toneMappingExposure,
            player: characterController.position.toArray()
        };
        photoMode.enter();
        return b;
    });
    const on = await evaluate(() => ({
        active: photoMode.active, hud: document.body.classList.contains('photo-on'),
        panel: getComputedStyle(document.getElementById('photo-mode')).display !== 'none',
        hudHidden: getComputedStyle(document.getElementById('crosshair') || document.querySelector('#ui-root > *:not(#photo-mode)')).visibility === 'hidden',
        clock: simClock, bots: enemyObjects.filter((e) => e.isActive).map((e) => e.mesh.position.x.toFixed(3)).join()
    }));
    assert.deepEqual([on.active, on.hud, on.panel, on.hudHidden], [true, true, true, true]);

    // Fly forward and up, drag to look, wheel to zoom
    await page.keyboard.down('KeyW'); await page.keyboard.down('KeyE');
    await frames(30);
    await page.keyboard.up('KeyW'); await page.keyboard.up('KeyE');
    await page.mouse.move(300, 220); await page.mouse.down();
    await page.mouse.move(360, 240, { steps: 4 }); await page.mouse.up();
    await page.mouse.move(300, 220);
    await page.mouse.wheel(0, 300);
    await frames(4);
    const fly = await evaluate((b) => ({
        moved: camera.position.distanceTo(new THREE.Vector3(b.player[0], b.player[1], b.player[2])),
        up: camera.position.y > b.player[1] + 0.3,
        turned: Math.abs(camera.rotation.y - b.rot[1]) > 0.1,
        zoom: camera.fov, wantZoom: photoMode.fov,
        playerStill: characterController.position.toArray().every((v, i) => Math.abs(v - b.player[i]) < 1e-9),
        keysClear: !game.keys.w,
        gunHidden: !weaponGroup.visible, bodyHidden: !playerBody.group.visible,
        clockFrozen: simClock, bots: enemyObjects.filter((e) => e.isActive).map((e) => e.mesh.position.x.toFixed(3)).join()
    }), before);
    assert.ok(fly.moved > 1, `the camera flew (${fly.moved.toFixed(2)} m)`);
    assert.ok(fly.up, 'and rose');
    assert.ok(fly.turned, 'dragging looks around');
    assert.equal(fly.zoom, fly.wantZoom);
    assert.ok(fly.zoom > before.fov, 'wheel zooms out');
    assert.ok(fly.playerStill && fly.keysClear, 'the player does not move');
    assert.ok(fly.gunHidden && fly.bodyHidden, 'gun and body hidden');
    assert.equal(fly.clockFrozen, on.clock, 'the game is frozen');
    assert.equal(fly.bots, on.bots, 'bots stand still');

    // Look: filter, brightness, letterbox; take a photo
    const shot = await evaluate(() => {
        document.querySelector('#photo-mode [data-pm="filter:noir"]').click();
        document.querySelector('#photo-mode [data-pm="letterbox"]').click();
        const exp = document.getElementById('pm-exp');
        exp.value = 150; exp.dispatchEvent(new Event('input', { bubbles: true }));
        return { filter: renderer.domElement.style.filter };
    });
    assert.match(shot.filter, /grayscale/);
    await page.keyboard.press('Enter');
    await frames(3);
    const photo = await evaluate(() => new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            const c = document.createElement('canvas');
            c.width = img.width; c.height = img.height;
            const g = c.getContext('2d');
            g.drawImage(img, 0, 0);
            const top = g.getImageData(0, 2, img.width, 1).data;
            const mid = g.getImageData(0, Math.floor(img.height / 2), img.width, 1).data;
            let topMax = 0, midSum = 0, grey = true;
            for (let i = 0; i < top.length; i += 4) topMax = Math.max(topMax, top[i], top[i + 1], top[i + 2]);
            for (let i = 0; i < mid.length; i += 4) { midSum += mid[i] + mid[i + 1] + mid[i + 2]; if (Math.abs(mid[i] - mid[i + 1]) > 3 || Math.abs(mid[i + 1] - mid[i + 2]) > 3) grey = false; }
            resolve({ count: photoMode.photos, name: photoMode.lastName, w: img.width, h: img.height, canvasW: renderer.domElement.width, topMax, midLit: midSum > 0, grey,
                exposure: renderer.toneMappingExposure, base: photoMode._baseExposure });
        };
        img.src = photoMode.lastPhoto;
    }));
    assert.equal(photo.count, 1);
    assert.match(photo.name, /^valorant-photo-\d{8}-\d{6}\.png$/);
    assert.equal(photo.w, photo.canvasW, 'full resolution');
    assert.equal(photo.topMax, 0, 'letterbox bar in the photo');
    assert.ok(photo.midLit, 'the picture is not blank');
    assert.ok(photo.grey, 'the noir filter is in the photo');
    assert.ok(Math.abs(photo.exposure - photo.base * 1.5) < 1e-9, 'brightness slider');

    // Esc: everything back exactly, the game runs again
    await page.keyboard.press('Escape');
    await frames(3);
    const off = await evaluate(() => ({
        active: photoMode.active, hud: document.body.classList.contains('photo-on'),
        rot: [camera.rotation.x, camera.rotation.y, camera.rotation.z], fov: camera.fov, exposure: renderer.toneMappingExposure,
        filter: renderer.domElement.style.filter, gun: weaponGroup.visible, clock: simClock,
        cam: camera.position.distanceTo(characterController.position)
    }));
    assert.deepEqual([off.active, off.hud, off.filter, off.gun], [false, false, '', true]);
    assert.deepEqual(off.rot, before.rot, 'view direction restored');
    assert.equal(off.fov, before.fov);
    assert.equal(off.exposure, before.exposure);
    assert.ok(off.cam < 0.5, 'camera back at the player');
    assert.ok(off.clock > on.clock, 'the game runs again');
    const [programs, watermark, stalls] = await programState(page);
    assert.equal(programs, watermark, 'no new shader programs');
    assert.equal(stalls, 0);
    assert.deepEqual(errors, []);
});

test('photo mode: J in and out, not from the main menu; the pause menu has a PHOTO MODE button; round timers stand still', { timeout: 300000 }, async () => {
    const { page, errors, frames, evaluate } = await boot({ quality: 'medium' });
    await evaluate(() => { photoMode.noDownload = true; });
    await page.keyboard.press('KeyJ');
    assert.equal(await evaluate(() => photoMode.active), true, 'J enters');
    await page.keyboard.press('KeyJ');
    assert.equal(await evaluate(() => photoMode.active), false, 'J leaves');
    const r = await evaluate(() => {
        photoMode.noDownload = true;
        mainMenu.show('pause');
        const blocked = photoMode.enter() === false && !photoMode.active;
        document.querySelector('[data-act="photo"]').click();
        return { blocked, active: photoMode.active, menu: mainMenu.open };
    });
    assert.deepEqual(r, { blocked: true, active: true, menu: false });
    // A planted spike's timer does not run down while in photo mode
    // The freeze is applied once per frame; bring it up to date before each read so the
    // time since the last frame does not count as lost (as the menu test does)
    const t0 = await evaluate(() => { mainMenu._freezeTimers(performance.now()); tacticalDirector.spikeState = 'planted'; tacticalDirector.spikeDetonateAt = performance.now() + 30000; return tacticalDirector.spikeDetonateAt - performance.now(); });
    await frames(30);
    const t1 = await evaluate(() => { mainMenu._freezeTimers(performance.now()); return tacticalDirector.spikeDetonateAt - performance.now(); });
    assert.ok(Math.abs(t1 - t0) < 150, `spike timer frozen (${(t0 - t1).toFixed(0)} ms lost)`);
    await evaluate(() => { photoMode.exit(); tacticalDirector.spikeState = 'unplanted'; });
    assert.deepEqual(errors, []);
});
