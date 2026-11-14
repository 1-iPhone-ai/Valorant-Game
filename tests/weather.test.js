'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser, programState } = require('./harness');

after(closeBrowser);

const setWeather = (evaluate, w) => evaluate((w) => document.querySelector(`#setting-weather-pills [data-weather="${w}"]`).click(), w);

test('weather: off by default; each map has its own; rain wets the floor; off on Low; surfaces fade', { timeout: 300000 }, async () => {
    const { page, errors, evaluate } = await boot({ quality: 'high' });
    const def = await evaluate(() => ({
        setting: game.userSettings.weather, kind: weatherFX.kind, shown: weatherFX.mesh.visible,
        wet: weatherSurf.uWet.value, snow: weatherSurf.uSnow.value,
        fog: scene.fog.density, sun: directionalLight.intensity, env: floorMaterial.envMapIntensity
    }));
    assert.deepEqual([def.setting, def.kind, def.shown, def.wet, def.snow], ['off', 'clear', false, 0, 0], 'off by default');

    // Map: each map's own weather
    const perMap = await evaluate(() => {
        game.userSettings.weather = 'map';
        const out = {};
        const was = game.mapPreset;
        for (const m of ['ascent', 'bind', 'haven', 'split', 'icebox', 'lotus']) { game.mapPreset = m; out[m] = weatherFX.resolve(); }
        game.mapPreset = was;
        game.userSettings.weather = 'off';
        return out;
    });
    assert.deepEqual(perMap, { ascent: 'leaves', bind: 'rain', haven: 'sand', split: 'storm', icebox: 'snow', lotus: 'leaves' });

    // Rain from the settings pill: particles and splashes on, wet floor, darker and foggier
    await setWeather(evaluate, 'rain');
    const rain = await evaluate(() => ({
        kind: weatherFX.kind, shown: weatherFX.mesh.visible, splash: weatherFX.splash.visible,
        n: weatherFX.mesh.geometry.drawRange.count, wet: weatherSurf.uWet.value, rainU: weatherSurf.uRain.value,
        fog: scene.fog.density, sun: directionalLight.intensity, env: floorMaterial.envMapIntensity,
        pill: document.querySelector('#setting-weather-pills [data-weather="rain"]').classList.contains('active'),
        saved: JSON.parse(localStorage.getItem('valorant_v16_user_settings') || '{}').weather
    }));
    assert.equal(rain.kind, 'rain');
    assert.ok(rain.shown && rain.splash && rain.n > 1000, `rain drawn (${rain.n / 6} drops)`);
    assert.deepEqual([rain.wet, rain.rainU], [1, 1], 'wet floor with ripples');
    assert.ok(rain.fog > def.fog * 1.3 && rain.sun < def.sun * 0.7 && rain.env > def.env, 'foggier, dimmer, glossier');
    assert.ok(rain.pill && rain.saved === 'rain');

    // Weather moves with the camera (GPU wrap): the uniforms follow it
    const follows = await evaluate(() => {
        weatherFX.update(1 / 60, performance.now());
        return weatherFX.mesh.material.uniforms.uCam.value.distanceTo(camera.position) < 1e-6 && weatherFX.mesh.material.uniforms.uTime.value > 0;
    });
    assert.ok(follows);

    // Low quality: no weather at all; back on High it returns
    const low = await evaluate(() => { setQualitySettings('low'); return [weatherFX.kind, weatherFX.mesh.visible]; });
    assert.deepEqual(low, ['clear', false]);
    await evaluate(() => setQualitySettings('high'));
    assert.equal(await evaluate(() => weatherFX.kind), 'rain');

    // Turning it off: the floor dries over a few seconds instead of snapping
    const fade = await evaluate(() => {
        game.userSettings.weather = 'off';
        weatherFX.refresh();
        const now = performance.now();
        for (let i = 0; i < 60; i++) weatherFX.update(1 / 60, now + i * 16);
        const mid = weatherSurf.uWet.value;
        for (let i = 0; i < 60 * 30; i++) weatherFX.update(1 / 60, now + 1000 + i * 16);
        return { mid, end: weatherSurf.uWet.value, shown: weatherFX.mesh.visible, fog: scene.fog.density };
    });
    assert.ok(fade.mid > 0.3 && fade.mid < 1, `drying (${fade.mid})`);
    assert.equal(fade.end, 0);
    assert.equal(fade.shown, false);
    assert.ok(Math.abs(fade.fog - def.fog) < 1e-9, 'fog back to normal');

    // Snow and sand: their own surfaces
    await setWeather(evaluate, 'snow');
    assert.deepEqual(await evaluate(() => [weatherSurf.uSnow.value, weatherSurf.uWet.value, weatherSurf.uSand.value]), [1, 0, 0]);
    await setWeather(evaluate, 'sand');
    assert.deepEqual(await evaluate(() => [weatherSurf.uSnow.value, weatherSurf.uSand.value]), [0, 1]);

    const [programs, watermark, stalls] = await programState(page);
    assert.equal(programs, watermark, 'weather adds no shader compiles during play');
    assert.equal(stalls, 0);
    assert.deepEqual(errors, []);
});

test('storms: lightning flashes and fades (softened by Reduce Flashes); sunset and dawn move the sun and refit the shadows', { timeout: 300000 }, async () => {
    const { page, errors, evaluate } = await boot({ quality: 'high' });
    await setWeather(evaluate, 'storm');
    const storm = await evaluate(() => {
        const base = weatherState.baseAmbient;
        const t = performance.now() + 100000;
        weatherFX.nextStrikeAt = 0;
        weatherFX.update(1 / 60, t);
        const peak = ambientLight.intensity;
        const count = weatherFX.strikeCount;
        weatherFX.update(1 / 60, t + 1500);
        weatherFX.update(1 / 60, t + 1600);
        const after = ambientLight.intensity;
        game.userSettings.reduceFlashes = true;
        weatherFX.strike(t + 2000);
        weatherFX.update(1 / 60, t + 2000);
        const soft = ambientLight.intensity;
        game.userSettings.reduceFlashes = false;
        weatherFX.update(1 / 60, t + 4000);
        return { base, peak, count, after, soft, next: weatherFX.nextStrikeAt - t };
    });
    assert.equal(storm.count, 1, 'a strike');
    assert.ok(storm.peak > storm.base + 1, `lightning lights the map (${storm.peak} vs ${storm.base})`);
    assert.ok(Math.abs(storm.after - storm.base) < 1e-9, 'and fades back exactly');
    assert.ok(storm.soft < storm.base + 0.5, `Reduce Flashes softens it (${storm.soft})`);
    assert.ok(storm.next >= 7000, 'next strike seconds later');

    const tod = await evaluate(() => {
        const snap = () => {
            const c = directionalLight.shadow.camera;
            return { pos: directionalLight.position.toArray(), box: [c.left, c.right, c.top, c.bottom, c.near, c.far], col: directionalLight.color.getHex(), sky: scene.background.getHex() };
        };
        game.userSettings.weather = 'off';
        weatherFX.refresh(true);
        const day = snap();
        const click = (v) => document.querySelector(`#setting-atmosphere-pills [data-atmos="${v}"]`).click();
        click('sunset');
        const sunset = snap();
        // Every corner of the arena is inside the refitted shadow camera
        directionalLight.updateMatrixWorld();
        directionalLight.shadow.updateMatrices(directionalLight);
        const fr = directionalLight.shadow.getFrustum();
        let inside = true;
        for (const x of [-50, 50]) for (const y of [0, 19.9]) for (const z of [-50, 50]) if (!fr.containsPoint(new THREE.Vector3(x, y, z))) inside = false;
        click('dawn');
        const dawn = snap();
        click('daylight');
        const back = snap();
        return { day, sunset, dawn, back, inside };
    });
    assert.ok(tod.sunset.pos[0] < -40 && tod.dawn.pos[0] > 40, 'sun in the west at sunset and the east at dawn');
    assert.ok(tod.sunset.pos[1] < tod.day.pos[1], 'lower sun');
    assert.ok(tod.inside, 'the whole arena stays inside the shadow camera');
    assert.notEqual(tod.sunset.col, tod.day.col, 'warm sun colour');
    assert.deepEqual(tod.back, tod.day, 'daylight restores the exact sun and shadow setup');
    const [programs, watermark] = await programState(page);
    assert.equal(programs, watermark);
    assert.deepEqual(errors, []);
});

test('Map weather on all 6 maps at sunset: each map gets its own weather, no errors, no shader compiles', { timeout: 400000 }, async () => {
    const { page, errors, frames, evaluate } = await boot({ quality: 'high' });
    const [baseline] = await programState(page);
    await evaluate(() => {
        document.querySelector('#setting-atmosphere-pills [data-atmos="sunset"]').click();
        document.querySelector('#setting-weather-pills [data-weather="map"]').click();
    });
    const want = { ascent: 'leaves', bind: 'rain', haven: 'sand', icebox: 'snow', lotus: 'leaves', split: 'storm' };
    for (const map of Object.keys(want)) {
        await evaluate((map) => tacticalDirector.cycleMapPreset(map), map);
        await frames(4);
        const s = await evaluate(() => ({ map: game.mapPreset, kind: weatherFX.kind, shown: weatherFX.mesh.visible, programs: renderer.info.programs.length, sunX: directionalLight.position.x }));
        assert.equal(s.map, map);
        assert.equal(s.kind, want[map], `${map} weather`);
        assert.ok(s.shown);
        assert.ok(s.sunX < -40, 'still sunset after the map change');
        assert.equal(s.programs, baseline, `${map} must not compile shaders`);
    }
    assert.deepEqual(errors, []);
});
