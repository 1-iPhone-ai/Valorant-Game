'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser, programState } = require('./harness');

after(closeBrowser);

// Mean luminance of one fixed view, rendered on demand
const meanLuma = (evaluate, view) => evaluate((v) => {
    const [x, y, z, yaw, pitch] = v;
    camera.position.set(x, y, z);
    camera.rotation.set(pitch, yaw, 0);
    camera.updateMatrixWorld();
    renderer.clear();
    renderer.render(scene, camera);
    const gl = renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) sum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
    return sum / (w * h);
}, view);

test('High Detail Maps is off by default and costs nothing until enabled', { timeout: 240000 }, async () => {
    const { errors, evaluate } = await boot();
    const s = await evaluate(() => ({
        setting: game.userSettings.mapDetail,
        uniform: mapHiDetailUniform.value,
        floor: floorHDUniform.value,
        decorVisible: mapDecor.group.visible,
        texturesBuilt: surfaceTextureFactory.ready,
        textureSize: surfaceTextureFactory.textures.concrete.image.width,
        pill: document.querySelector('#setting-map-detail-pills .active').dataset.mapdetail
    }));
    assert.deepEqual(s, { setting: 'off', uniform: 0, floor: 0, decorVisible: false, texturesBuilt: false, textureSize: 1, pill: 'off' });
    assert.deepEqual(errors, []);
});

test('High Detail Maps on every map: props and textures, no shader compiles, same brightness, off on Low', { timeout: 600000 }, async () => {
    const { page, errors, frames, evaluate } = await boot({ quality: 'high' });
    // Turned on from the settings pill, like a player would
    await evaluate(() => document.querySelector('#setting-map-detail-pills [data-mapdetail="on"]').click());
    await frames(3);
    const on = await evaluate(() => ({
        setting: game.userSettings.mapDetail, uniform: mapHiDetailUniform.value, floor: floorHDUniform.value,
        decor: mapDecor.group.visible, size: surfaceTextureFactory.textures.stone.image.width,
        saved: JSON.parse(localStorage.getItem('valorant_v16_user_settings') || '{}').mapDetail
    }));
    assert.deepEqual(on, { setting: 'on', uniform: 1, floor: 1, decor: true, size: 512, saved: 'on' });

    for (const map of ['ascent', 'bind', 'haven', 'icebox', 'lotus', 'split']) {
        await evaluate((m) => tacticalDirector.cycleMapPreset(m), map);
        await frames(4);
        const m = await evaluate(() => ({
            decor: mapDecor.instanceCount,
            aoBaked: !mapHiDetail.aoStale,
            surfaced: mapPieces.filter((p) => p.surf > 0).length,
            pieces: mapPieces.length
        }));
        assert.ok(m.decor > 100, `${map}: props are built (${m.decor})`);
        assert.ok(m.aoBaked, `${map}: floor shading is baked for this map`);
        assert.equal(m.surfaced, m.pieces, `${map}: every map piece has a surface`);
        // Textures add detail, not an overall brightness shift
        const view = [0, 1.7, 30, 0, 0.05];
        const lumOn = await meanLuma(evaluate, view);
        await evaluate(() => mapHiDetail.set(false));
        const lumOff = await meanLuma(evaluate, view);
        await evaluate(() => mapHiDetail.set(true));
        assert.ok(Math.abs(lumOn - lumOff) / lumOff < 0.15, `${map}: brightness ${lumOff.toFixed(1)} -> ${lumOn.toFixed(1)}`);
        const [programs, watermark, stalls] = await programState(page);
        assert.equal(programs, watermark, `${map}: no new shader programs`);
        assert.equal(stalls, 0);
    }

    // The Low profile turns it off; leaving Low turns it back on
    await evaluate(() => setQualitySettings('low'));
    await frames(3);
    assert.deepEqual(await evaluate(() => [mapHiDetailUniform.value, mapDecor.group.visible]), [0, false]);
    await evaluate(() => setQualitySettings('high'));
    await frames(3);
    assert.deepEqual(await evaluate(() => [mapHiDetailUniform.value, mapDecor.group.visible]), [1, true]);
    const [programs, watermark] = await programState(page);
    assert.equal(programs, watermark);
    assert.deepEqual(errors, []);
});
