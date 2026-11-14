'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser, programState } = require('./harness');

after(closeBrowser);

// Average brightness of the scene from the player's camera, drawn into a small
// sRGB target (the same shader programs as the screen)
const LUM = `
    window.__lum = (region) => {
        if (!window.__lrt) { window.__lrt = new THREE.WebGLRenderTarget(96, 54); window.__lrt.texture.encoding = THREE.sRGBEncoding; }
        const rt = window.__lrt;
        camera.updateMatrixWorld();
        renderer.setRenderTarget(rt);
        renderer.setClearColor(scene.background, 1);
        renderer.clear();
        renderer.render(scene, camera);
        const px = new Uint8Array(96 * 54 * 4);
        renderer.readRenderTargetPixels(rt, 0, 0, 96, 54, px);
        renderer.setRenderTarget(null);
        let sum = 0, n = 0;
        const y1 = region === 'bottom' ? 27 : 54;
        for (let y = 0; y < y1; y++) for (let x = 0; x < 96; x++) { const i = (y * 96 + x) * 4; sum += px[i] * 0.3 + px[i + 1] * 0.55 + px[i + 2] * 0.15; n++; }
        return sum / n;
    };
`;
const look = (evaluate) => evaluate(() => {
    window.updateEnemies = () => {};
    characterController.position.set(0, 1.7, 30); characterController.prevSimPosition.copy(characterController.position);
    camera.position.set(0, 1.7, 30); camera.rotation.set(-0.25, 0, 0);
});

test('floor reflections: on for Ultra/Cinematic, only when wet on High, never on Medium/Low; mirror camera clips below the floor', { timeout: 300000 }, async () => {
    const { page, errors, frames, evaluate } = await boot({ quality: 'ultra' });
    await page.addScriptTag({ content: LUM });
    await look(evaluate);
    const r = await evaluate(() => {
        const out = {};
        const run = (n) => { const before = reflectFX.renders; for (let i = 0; i < n; i++) reflectFX.render(); return reflectFX.renders - before; };
        setQualitySettings('ultra');
        out.ultra = [run(6), reflectU.uReflect.value];
        setQualitySettings('cinematic');
        out.cinematic = [run(6), reflectU.uReflect.value];
        setQualitySettings('high');
        out.highDry = [run(6), reflectU.uReflect.value];
        game.userSettings.weather = 'rain'; weatherFX.refresh(true);
        out.highWet = [run(6), reflectU.uReflect.value];
        setQualitySettings('medium');
        out.medium = [run(6), reflectU.uReflect.value];
        setQualitySettings('low');
        out.low = [run(6), reflectU.uReflect.value];
        // Oblique near plane: a point below the floor is clipped, one above is kept
        setQualitySettings('ultra');
        reflectFX.render();
        const clipZ = (x, y, z) => { const v = new THREE.Vector4(x, y, z, 1).applyMatrix4(reflectFX.cam.matrixWorldInverse).applyMatrix4(reflectFX.cam.projectionMatrix); return v.z / v.w; };
        out.below = clipZ(0, -0.5, 20);
        out.above = clipZ(0, 0.5, 20);
        // The texture matrix maps a floor point in view into the texture
        const t = new THREE.Vector4(0, 0, 22, 1).applyMatrix4(reflectU.uReflMatrix.value);
        out.uv = [t.x / t.w, t.y / t.w];
        out.size = [reflectFX.rt.width, reflectFX.rt.height];
        return out;
    });
    assert.deepEqual(r.ultra, [6, 1], 'Ultra: every frame');
    assert.deepEqual(r.cinematic, [6, 1], 'Cinematic: every frame');
    assert.deepEqual(r.highDry, [0, 0], 'High: off while the floor is dry');
    assert.ok(r.highWet[0] >= 2 && r.highWet[0] <= 4 && r.highWet[1] === 1, `High + rain: every other frame (${r.highWet})`);
    assert.deepEqual(r.medium, [0, 0]);
    assert.deepEqual(r.low, [0, 0]);
    assert.ok(r.below < -1, `below the floor is clipped (${r.below})`);
    assert.ok(r.above > -1 && r.above < 1, `above the floor is kept (${r.above})`);
    assert.ok(r.uv.every((v) => v > 0 && v < 1), `floor point inside the reflection texture (${r.uv})`);

    // The wet floor actually shows the reflection
    const diff = await evaluate(() => {
        reflectFX.render();
        const on = __lum('bottom');
        reflectU.uReflect.value = 0;
        const off = __lum('bottom');
        return Math.abs(on - off);
    });
    assert.ok(diff > 0.5, `reflection changes the floor (${diff})`);
    await frames(3);
    const [programs, watermark, stalls] = await programState(page);
    assert.equal(programs, watermark, 'the reflection pass reuses every program');
    assert.equal(stalls, 0);
    assert.deepEqual(errors, []);
});

test('ability lights: blasts, fire zones and gunfire light the floor and walls, fade out, nearest win; off on Low; Cinematic shafts', { timeout: 300000 }, async () => {
    const { page, errors, evaluate } = await boot({ quality: 'ultra' });
    await page.addScriptTag({ content: LUM });
    await look(evaluate);
    const r = await evaluate(() => {
        const out = {};
        game.userSettings.atmosphereMode = 'night'; settingsManager.applyAtmosphereTheme();
        abilityLights.flashes.length = 0;
        abilityLights.update(performance.now());
        out.dark = __lum();
        // A blast in front of the player
        fxKit.burst(0, 1.2, 22, 0xff5500, 4);
        const now = performance.now();
        abilityLights.update(now + 30);
        out.blast = { shown: abilityLights.shown, on: abilityLightU.uALOn.value, pos: abilityLightU.uALPos.value[0].toArray() };
        out.lit = __lum();
        abilityLights.update(now + 5000);
        out.after = [abilityLights.shown, abilityLightU.uALOn.value, abilityLights.flashes.length];
        out.back = __lum();
        // Fire zone: a light only while the zone is burning (re-added every frame)
        fxKit.embers(0, 0, 22, 0xff7b00, 3, 1 / 60);
        abilityLights.update(now + 5016);
        out.fire = abilityLights.shown;
        abilityLights.update(now + 5032);
        out.fireGone = abilityLights.shown;
        // Many at once: the 6 nearest/brightest are used
        for (let i = 0; i < 10; i++) abilityLights.flash(0, 1, 30 - i * 6, 0xffffff, 6, 2, 1000);
        abilityLights.update(performance.now());
        out.many = abilityLights.shown;
        out.nearest = Math.min(...abilityLightU.uALPos.value.map((p) => Math.abs(p.z - 30)));
        out.farthestUsed = Math.max(...abilityLightU.uALPos.value.map((p) => Math.abs(p.z - 30)));
        abilityLights.flashes.length = 0;
        // Gunfire
        game.lastShot = 0;
        const w = game.weapons[game.activeWeapon]; w.ammo = w.maxAmmo; game.reloading = false;
        shoot();
        out.muzzle = abilityLights.flashes.length;
        abilityLights.flashes.length = 0;
        // Low: nothing
        setQualitySettings('low');
        fxKit.burst(0, 1.2, 22, 0xff5500, 4);
        abilityLights.flash(0, 1, 22, 0xffffff, 6, 2, 1000);
        abilityLights.update(performance.now());
        out.low = [abilityLights.shown, abilityLightU.uALOn.value];
        // Cinematic: shafts from the light in view
        setQualitySettings('cinematic');
        abilityLights.flash(0, 1.5, 20, 0xff3300, 9, 3, 100000);
        abilityLights.update(performance.now());
        postFX.render(performance.now());
        out.shaft = postFX.mats.rays.uniforms.uLight.value.w;
        return out;
    });
    assert.ok(r.blast.shown >= 1 && r.blast.on === 1, 'blast light on');
    assert.deepEqual(r.blast.pos.slice(0, 3), [0, 1.2, 22]);
    assert.ok(r.lit > r.dark * 1.05, `the blast lights the scene (${r.dark.toFixed(2)} -> ${r.lit.toFixed(2)})`);
    assert.deepEqual(r.after, [0, 0, 0], 'faded out');
    assert.ok(Math.abs(r.back - r.dark) < 0.05, 'and the scene is exactly as before');
    assert.equal(r.fire, 1, 'fire zone lit');
    assert.equal(r.fireGone, 0, 'gone once the zone stops');
    assert.equal(r.many, 6, 'capped at 6');
    assert.ok(r.nearest < 0.01 && r.farthestUsed <= 30 + 1e-9, 'nearest ones used');
    assert.equal(r.muzzle, 1, 'each shot flashes a light');
    assert.deepEqual(r.low, [0, 0], 'off on Low');
    assert.ok(r.shaft > 0.3, `Cinematic shafts from the light (${r.shaft})`);
    const [programs, watermark, stalls] = await programState(page);
    assert.equal(programs, watermark, 'lights never change a shader program');
    assert.equal(stalls, 0);
    assert.deepEqual(errors, []);
});
