'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser, programState } = require('./harness');

after(closeBrowser);

// Mean luminance of what is on the canvas right after a render
const frameLuma = (evaluate) => evaluate(() => {
    if (postFX.enabled) postFX.render(performance.now());
    else { renderer.setRenderTarget(null); renderer.clear(); renderer.render(scene, camera); }
    const gl = renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let s = 0;
    for (let i = 0; i < px.length; i += 4) s += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
    return s / (w * h);
});
const rtStats = (evaluate, name, index) => evaluate(([name, index]) => {
    const rt = index === null ? postFX.rt[name] : postFX.rt[name][index];
    const px = new Uint8Array(rt.width * rt.height * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, rt.width, rt.height, px);
    let sum = 0, min = 255, max = 0;
    for (let i = 0; i < px.length; i += 4) { sum += px[i]; min = Math.min(min, px[i]); max = Math.max(max, px[i]); }
    return { mean: sum / (px.length / 4) / 255, min: min / 255, max: max / 255 };
}, [name, index]);

test('Cinematic: above Ultra, never picked by Auto, post passes compiled in the warm-up', { timeout: 240000 }, async () => {
    const { page, errors, evaluate } = await boot({ quality: null });
    const s = await evaluate(() => ({
        levels: Object.keys(GRAPHICS_PROFILES),
        auto: qualityController.auto, quality: adaptiveSettings.currentQuality, post: postFX.enabled,
        passesReady: postFX.ready, pill: !!document.querySelector('#settings-quality-pills [data-quality="cinematic"]')
    }));
    assert.deepEqual(s.levels, ['low', 'medium', 'high', 'ultra', 'cinematic']);
    assert.equal(s.auto, true);
    assert.notEqual(s.quality, 'cinematic');
    assert.equal(s.post, false, 'post-processing is off unless Cinematic is chosen');
    assert.equal(s.passesReady, true, 'post passes were built during the warm-up');
    assert.ok(s.pill);
    // Auto from Cinematic drops to High
    await evaluate(() => { setQualitySettings('cinematic'); qualityController.setAuto(); });
    assert.equal(await evaluate(() => adaptiveSettings.currentQuality), 'high');
    const [programs, watermark] = await programState(page);
    assert.equal(programs, watermark);
    assert.deepEqual(errors, []);
});

test('Cinematic renders AO, bloom and the composite with no new shader programs', { timeout: 300000 }, async () => {
    const { page, errors, frames, evaluate } = await boot({ quality: 'ultra', viewport: { width: 640, height: 360 } });
    await evaluate(() => {
        window.updateEnemies = () => {};
        characterController.position.set(0, 1.7, 30); characterController.prevSimPosition.copy(characterController.position);
        camera.rotation.set(0.05, 0, 0);
    });
    await frames(3);
    const lumaUltra = await frameLuma(evaluate);
    await evaluate(() => document.querySelector('#settings-quality-pills [data-quality="cinematic"]').click());
    await frames(6);
    const on = await evaluate(() => ({ post: postFX.enabled, map: mapHiDetail.enabled, chars: characterDetail.enabled, frames: postFX.frame }));
    assert.equal(on.post, true);
    assert.equal(on.map, true, 'Cinematic turns on High Detail Maps');
    assert.equal(on.chars, true, 'and High Detail Characters & Guns');
    assert.ok(on.frames > 0, 'the post pipeline is drawing frames');
    const lumaCine = await frameLuma(evaluate);
    assert.ok(lumaCine > lumaUltra * 0.6 && lumaCine < lumaUltra * 1.5, `same overall exposure (${lumaUltra.toFixed(1)} -> ${lumaCine.toFixed(1)})`);
    // AO darkens some of the image but leaves most of it alone
    const ao = await rtStats(evaluate, 'aoBlur', null);
    assert.ok(ao.min < 0.85, `AO darkens contact areas (min ${ao.min.toFixed(2)})`);
    assert.ok(ao.mean > 0.8, `AO leaves open areas alone (mean ${ao.mean.toFixed(2)})`);
    // Bloom picks up the bright parts of the frame
    const bloom = await rtStats(evaluate, 'bloom', 0);
    assert.ok(bloom.max > 0.05, `bloom has bright sources (max ${bloom.max.toFixed(2)})`);
    // Reduce Flashes also drops the edge colour fringing
    await evaluate(() => { game.userSettings.reduceFlashes = true; postFX.render(performance.now()); });
    assert.equal(await evaluate(() => postFX.mats.composite.uniforms.uCA.value), 0);
    await evaluate(() => { game.userSettings.reduceFlashes = false; });
    const [programs, watermark, stalls] = await programState(page);
    assert.equal(programs, watermark, 'no shader compiled after the warm-up');
    assert.equal(stalls, 0);
    // Back to Ultra: post off, detail back to the player's own settings (off)
    await evaluate(() => setQualitySettings('ultra'));
    await frames(3);
    assert.deepEqual(await evaluate(() => [postFX.enabled, mapHiDetail.enabled, characterDetail.enabled]), [false, false, false]);
    assert.deepEqual(errors, []);
});
