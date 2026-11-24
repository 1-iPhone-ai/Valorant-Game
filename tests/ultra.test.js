'use strict';
// V1.8 Part 3: the Ultra Realism graphics tier
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser, programState } = require('./harness');

after(closeBrowser);

// What the Cinematic tier has in place (to prove Ultra puts it all back)
const cinematicState = (evaluate) => evaluate(() => {
    const live = [];
    for (const chunk of enemyChunks.values()) for (const page of chunk.pages) live.push(page);
    const fpsMat = fxKit.add ? fxKit.add.material : null;
    return {
        mapMat: mapBatches.every((b) => b.mesh.material === mapMaterial),
        decorMat: mapDecor.batches.every((b) => b.material === mapMaterial),
        floor: floor.material === floorMaterial,
        sky: skyDome.material.type,
        env: scene.environment ? scene.environment.uuid : null,
        enemyPos: live.map((p) => p.meshes.map((m) => m.geometry.attributes.position.uuid).join(',')).join('|'),
        hands: Object.keys(game.weapons).map((k) => { const w = game.weapons[k]; let id = ''; if (w && w.model) w.model.traverse((o) => { if (o.isMesh && o.userData.isHands) id += o.geometry.uuid; }); return id; }).join(','),
        gunMats: Object.keys(game.weapons).map((k) => { const w = game.weapons[k]; let s = ''; if (w && w.model) w.model.traverse((o) => { if (o.isMesh && o.material && o.material.isMeshStandardMaterial) s += o.material.metalness.toFixed(3) + '/' + o.material.roughness.toFixed(3) + ';'; }); return s; }).join(','),
        shell: shellFX.mesh ? shellFX.mesh.geometry.uuid : null,
        fx: fpsMat ? fpsMat.uuid + ':' + fxKit.add.layers.mask + ':' + fxKit.smoke.layers.mask : null,
        refl: reflectFX.scale,
        post: postFX.enabled,
        ultraPost: ultraPost.active,
        decorShown: !!(ultraDecor.group && ultraDecor.group.visible),
        nearHook: !!(ultraLight.hook && ultraLight.hook.visible)
    };
});

// Map collision, the bots' walk grid and the enemy hit proxies: identical on every tier
const physicsState = (evaluate) => evaluate(() => {
    let sum = 0;
    for (const c of staticColliders) { const b = c.bounds || c.box || c; if (b && b.min) sum += b.min.x + b.min.y * 3 + b.min.z * 7 + b.max.x * 11 + b.max.y * 13 + b.max.z * 17; }
    let blocked = 0;
    if (navGrid.blocked) for (let i = 0; i < navGrid.blocked.length; i++) blocked += navGrid.blocked[i] ? 1 : 0;
    return {
        colliders: staticColliders.length, sum: sum.toFixed(3), revision: collisionIndex.revision, blocked,
        leaves: enemyObjects.every((e) => e.leaves[0].geometry === actorTemplates.enemyTorso && e.leaves[1].geometry === actorTemplates.enemyHead && e.leaves[2].geometry === actorTemplates.enemyLegs)
    };
});

test('Ultra Realism: a manual tier above Cinematic with its own settings box; Auto never picks it; Cinematic without WebGL 2', { timeout: 420000 }, async () => {
    const { page, errors, frames, evaluate } = await boot({ quality: null, viewport: { width: 480, height: 270 } });
    const s = await evaluate(() => ({
        levels: Object.keys(GRAPHICS_PROFILES),
        autoOrder: QUALITY_ORDER.slice(),
        auto: qualityController.auto, quality: adaptiveSettings.currentQuality,
        supported: ultraRealism.isSupported(),
        pill: !!document.querySelector('#settings-quality-pills [data-quality="ultraRealism"]'),
        box: !!document.getElementById('settings-ultra-box'),
        master: [...document.querySelectorAll('#setting-ultra-pills [data-ultra]')].map((b) => b.getAttribute('data-ultra')),
        features: ULTRA_FEATURES.map((f) => [...document.querySelectorAll('#setting-ultrafx-' + f + '-pills [data-ufx]')].map((b) => b.getAttribute('data-ufx')).join('/'))
    }));
    assert.deepEqual(s.levels, ['low', 'medium', 'high', 'ultra', 'cinematic', 'ultraRealism']);
    assert.ok(!s.autoOrder.includes('ultraRealism'), 'Auto never steps into Ultra Realism');
    assert.equal(s.auto, true);
    assert.notEqual(s.quality, 'ultraRealism');
    assert.equal(s.supported, true, 'the test browser has WebGL 2');
    assert.ok(s.pill && s.box);
    assert.deepEqual(s.master.sort(), ['off', 'on']);
    assert.equal(s.features.length, 9);
    for (const f of s.features) assert.equal(f.split('/').sort().join('/'), 'off/on');

    // The master switch turns the tier on (manual), a feature switch is saved, off goes to Cinematic
    await evaluate(() => document.querySelector('#setting-ultra-pills [data-ultra="on"]').click());
    await frames(2);
    let st = await evaluate(() => ({ q: adaptiveSettings.currentQuality, auto: qualityController.auto, active: ultraRealism.active, status: document.getElementById('settings-ultra-status').textContent, label: qualityLabel(adaptiveSettings.currentQuality) }));
    assert.deepEqual(st, { q: 'ultraRealism', auto: false, active: true, status: 'ON', label: 'ULTRA REALISM' });
    await evaluate(() => document.querySelector('#setting-ultrafx-reflections-pills [data-ufx="off"]').click());
    st = await evaluate(() => ({ on: ultraRealism.is('reflections'), saved: game.userSettings.ultraFx.reflections, others: ULTRA_FEATURES.filter((f) => f !== 'reflections').every((f) => ultraRealism.is(f)) }));
    assert.deepEqual(st, { on: false, saved: false, others: true });
    await evaluate(() => document.querySelector('#setting-ultrafx-reflections-pills [data-ufx="on"]').click());
    assert.equal(await evaluate(() => ultraRealism.is('reflections')), true);
    // The FPS readout names the tier and reports the frame time (V1.9: one line,
    // "N FPS / Ultra Realism", with the frame time in its tooltip)
    await frames(4);
    const fps = await evaluate(() => ({ text: document.getElementById('fps-display').textContent, title: document.getElementById('fps-display').title }));
    assert.match(fps.text, /^\d+ FPS \/ Ultra Realism$/);
    assert.match(fps.title, /^\d+\.\d ms per frame/);
    // Auto from Ultra Realism drops to High
    await evaluate(() => qualityController.setAuto());
    assert.equal(await evaluate(() => adaptiveSettings.currentQuality), 'high');
    assert.equal(await evaluate(() => ultraRealism.active), false);
    await evaluate(() => document.querySelector('#setting-ultra-pills [data-ultra="on"]').click());
    await evaluate(() => document.querySelector('#setting-ultra-pills [data-ultra="off"]').click());
    assert.equal(await evaluate(() => adaptiveSettings.currentQuality), 'cinematic');

    // Without WebGL 2 the tier falls back to Cinematic and says so
    const fb = await evaluate(() => {
        ultraRealism.forceUnsupported = true;
        qualityController.setManual('ultraRealism');
        const r = { q: adaptiveSettings.currentQuality, active: ultraRealism.active, status: document.getElementById('settings-ultra-status').textContent };
        ultraRealism.forceUnsupported = false;
        return r;
    });
    assert.equal(fb.q, 'cinematic');
    assert.equal(fb.active, false);
    assert.match(fb.status, /NOT AVAILABLE \(NEEDS WebGL 2\): USES CINEMATIC/);
    const [programs, watermark, stalls] = await programState(page);
    assert.equal(programs, watermark, 'no shader compiled after the warm-up');
    assert.equal(stalls, 0);
    assert.deepEqual(errors, []);
});

test('Ultra Realism draws every feature with no new shader programs, keeps hitboxes and collision, and gives Cinematic back exactly', { timeout: 900000 }, async () => {
    const { page, errors, frames, evaluate } = await boot({ quality: 'cinematic', viewport: { width: 480, height: 270 } });
    await evaluate(() => {
        // a still scene: bots frozen and no wingmen walking into the comparison frames
        window.updateEnemies = () => {};
        tacticalEnhancements.toggleWingmanAI(false);
        const cc = characterController; cc.position.set(5, 1.7, 11.6); cc.prevSimPosition.copy(cc.position);
        camera.rotation.set(-0.05, 0, 0, 'YXZ');
    });
    await frames(3);
    const luma = () => evaluate(() => {
        if (ultraPost.active) ultraPost.render(performance.now());
        else postFX.render(performance.now());
        const gl = renderer.getContext(), w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
        const px = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let s = 0;
        for (let i = 0; i < px.length; i += 4) s += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
        return s / (w * h);
    });
    const cine = await cinematicState(evaluate);
    const phys = await physicsState(evaluate);
    const lumaCine = await luma();
    assert.equal(cine.mapMat && cine.floor && cine.post && !cine.ultraPost && !cine.decorShown && !cine.nearHook, true);

    // Switch: the call itself does no heavy work (textures, light bake and probe come later in small steps)
    const sw = await evaluate(() => {
        const t0 = performance.now();
        setQualitySettings('ultraRealism');
        const ms = performance.now() - t0;
        return { ms, prep: ultraPrep.queue.length };
    });
    assert.ok(sw.ms < 250, `switching to Ultra Realism took ${sw.ms.toFixed(1)} ms`);
    // Let the background preparation run on its own for a few frames (each within its budget), then finish it
    await frames(6);
    await evaluate(() => ultraPrep.finish());
    await frames(4);
    const u = await evaluate(() => {
        const live = [];
        for (const chunk of enemyChunks.values()) for (const page of chunk.pages) live.push(page);
        let handsUltra = true;
        for (const h of ultraGuns.hands) if (h.mesh.geometry !== h.ultra) handsUltra = false;
        const w = ultraPost.rt.world;
        return {
            active: ultraRealism.active, features: ULTRA_FEATURES.every((f) => ultraRealism.is(f)),
            sky: skyDome.material === ultraSky.mat && scene.environment === ultraSky.envTex,
            tex: ultraTex.ready, matOn: ultraU.uMatOn.value, mapMat: mapBatches.every((b) => b.mesh.material === ultraMats.mapMat), floor: floor.material === ultraMats.floorMat,
            decor: ultraDecor.count, decorShown: ultraDecor.group.visible, lamps: ultraDecor.lamps.length, roofs: ultraDecor.roofs.length,
            vol: ultraU.uVolOn.value, near: ultraU.uNearParams.value.w, nearMap: !!ultraLight.nearLight.shadow.map,
            probe: ultraU.uProbeMix.value,
            samples: w.samples, depth: !!w.depthTexture, aoFull: ultraPost.rt.ao.width === w.width && ultraPost.rt.ao.height === w.height,
            haveLum: ultraPost.haveLum,
            enemies: live.length > 0 && live.every((p) => p.meshes.every((m, i) => !ultraChars.geo[enemyPartSpecs[i].name] || m.geometry.attributes.position === ultraChars.geo[enemyPartSpecs[i].name].attributes.position)),
            handsUltra: handsUltra && ultraGuns.hands.length > 0,
            shell: shellFX.mesh.geometry === ultraGuns.shellGeo,
            fx: fxKit.add.material === ultraFX.addMat && fxKit.smoke.material === ultraFX.smokeMat && fxKit.add.layers.mask === 4 && ultraPost.softParticles,
            nearOk: ULTRA_NEAR_OK
        };
    });
    assert.deepEqual(u, {
        active: true, features: true, sky: true, tex: true, matOn: 1, mapMat: true, floor: true,
        decor: u.decor, decorShown: true, lamps: u.lamps, roofs: u.roofs, vol: 1, near: 1, nearMap: true, probe: 1,
        samples: 4, depth: true, aoFull: true, haveLum: true, enemies: true, handsUltra: true, shell: true, fx: true, nearOk: true
    });
    assert.ok(u.decor > 1000 && u.lamps > 10 && u.roofs > 20, `Ascent detail: ${u.decor} parts, ${u.lamps} lamps, ${u.roofs} roofs`);
    // Smooth bodies stay inside the original hit volume (the rifle may reach forward)
    const inside = await evaluate(() => {
        const hit = new THREE.Box3();
        for (const g of [actorTemplates.enemyTorso, actorTemplates.enemyHead, actorTemplates.enemyLegs, actorTemplates.enemyWeapon]) { if (!g) continue; g.computeBoundingBox(); hit.union(g.boundingBox); }
        hit.expandByScalar(0.03);
        return enemyPartSpecs.every((spec) => {
            const g = ultraChars.geo[spec.name];
            if (!g) return true;
            g.computeBoundingBox();
            const b = g.boundingBox;
            return b.min.x >= hit.min.x && b.max.x <= hit.max.x && b.min.y >= hit.min.y && b.max.y <= hit.max.y && b.max.z <= hit.max.z && b.min.z >= -1.25;
        });
    });
    assert.ok(inside, 'smooth bodies stay inside the original hit volume');
    // Debris from an impact, smoke from a shot
    const fx = await evaluate(() => {
        materialImpact(new THREE.Vector3(5, 1, 6), new THREE.Vector3(0, 0, 1), MAP_SURF.concrete);
        const chips = ultraFX.chips.filter((c) => c.alive).length;
        const before = fxKit.smokes.filter((r) => r.alive).length;
        ultraGuns.onShot();
        return { chips, smoke: fxKit.smokes.filter((r) => r.alive).length - before };
    });
    assert.ok(fx.chips >= 5, `impact debris (${fx.chips})`);
    assert.equal(fx.smoke, 1, 'muzzle smoke');
    await frames(3);
    assert.ok(await evaluate(() => ultraFX.debris.count) > 0, 'debris is drawn');
    const lumaUltra = await luma();
    assert.ok(lumaUltra > 20 && lumaUltra < 235, `a normally exposed frame (${lumaUltra.toFixed(1)})`);

    // Hitboxes, collision and the walk grid are the same as on Cinematic
    assert.deepEqual(await physicsState(evaluate), phys);

    // Every feature off and on again: still no new programs
    for (const f of ['sky', 'materials', 'detail', 'lighting', 'post', 'reflections', 'guns', 'characters', 'effects']) {
        await evaluate((f) => { game.userSettings.ultraFx = Object.assign({}, game.userSettings.ultraFx, { [f]: false }); ultraRealism.refresh(); }, f);
        await frames(2);
        await evaluate((f) => { game.userSettings.ultraFx = Object.assign({}, game.userSettings.ultraFx, { [f]: true }); ultraRealism.refresh(); }, f);
        await frames(1);
    }
    for (const w of ['sniper', 'pistol', 'knife', 'rifle']) { await evaluate((w) => switchWeapon(w), w); await frames(2); }
    let [programs, watermark, stalls] = await programState(page);
    assert.equal(programs, watermark, 'no shader compiled after the warm-up');
    assert.equal(stalls, 0);

    // Photo Mode holds its exposure while open
    const photo = await evaluate(() => { photoMode.enter(); photoMode.panelHidden = true; return renderer.toneMappingExposure; });
    await frames(4);
    const held = await evaluate(() => renderer.toneMappingExposure);
    assert.ok(Math.abs(held - photo) < 1e-6, `Photo Mode keeps its exposure (${photo} -> ${held})`);
    await evaluate(() => photoMode.exit());
    await frames(2);

    // Back to Cinematic: everything as it was, same picture
    await evaluate(() => setQualitySettings('cinematic'));
    await frames(4);
    assert.deepEqual(await cinematicState(evaluate), cine);
    const lumaBack = await luma();
    assert.ok(Math.abs(lumaBack - lumaCine) < Math.max(1, lumaCine * 0.02), `Cinematic looks the same afterwards (${lumaCine.toFixed(2)} -> ${lumaBack.toFixed(2)})`);
    assert.deepEqual(await physicsState(evaluate), phys);
    [programs, watermark, stalls] = await programState(page);
    assert.equal(programs, watermark);
    assert.equal(stalls, 0);
    assert.deepEqual(errors, []);
});

test('Ultra Realism on another map and time of day: no Ascent detail, light rebaked, no errors', { timeout: 900000 }, async () => {
    const { page, errors, frames, evaluate } = await boot({ quality: 'cinematic', viewport: { width: 480, height: 270 } });
    await evaluate(() => { window.updateEnemies = () => {}; setQualitySettings('ultraRealism'); ultraPrep.finish(); });
    await frames(2);
    const ascentKey = await evaluate(() => ultraLight.bakedKey);
    // V2.1: a map not rebuilt yet (Bind and Haven have their own detail now, checked below)
    await evaluate(() => { rebuildMapPreset('icebox'); ultraPrep.finish(); });
    await frames(3);
    const bind = await evaluate(() => ({ map: game.mapPreset, decor: ultraDecor.count, shown: ultraDecor.group.visible, vol: ultraU.uVolOn.value, key: ultraLight.bakedKey, plaster: ultraU.uPlaster.value, matOn: ultraU.uMatOn.value }));
    assert.equal(bind.map, 'icebox');
    assert.equal(bind.decor, 0, 'the Ascent detail is Ascent only');
    assert.equal(bind.shown, false);
    assert.equal(bind.vol, 1, 'the light is baked for this map');
    assert.notEqual(bind.key, ascentKey);
    assert.equal(bind.plaster, 0);
    assert.equal(bind.matOn, 1);
    // V2.1: Bind and Haven build their own detail (lamps included) and plaster their tall walls
    for (const m of ['bind', 'haven']) {
        await evaluate((m) => { rebuildMapPreset(m); ultraPrep.finish(); }, m);
        await frames(2);
        const own = await evaluate(() => ({ map: game.mapPreset, decor: ultraDecor.count, meshes: ultraDecor.meshes.length, lamps: ultraDecor.lamps.length, shown: ultraDecor.group.visible, plaster: ultraU.uPlaster.value, key: ultraLight.bakedKey }));
        assert.equal(own.map, m);
        assert.ok(own.decor > 1000, `${m}: its own detail (${own.decor} pieces)`);
        assert.ok(own.meshes <= 6, `${m}: ${own.meshes} instanced meshes`);
        assert.ok(own.lamps >= 10, `${m}: ${own.lamps} wall lanterns`);
        assert.equal(own.shown, true);
        assert.equal(own.plaster, 1);
        assert.notEqual(own.key, ascentKey, `${m}: light baked for this map`);
    }
    // Night: the sky, the lamps and the bake follow the atmosphere
    await evaluate(() => { game.userSettings.atmosphereMode = 'night'; settingsManager.applyAtmosphereTheme(); ultraPrep.finish(); });
    await frames(3);
    const night = await evaluate(() => ({ key: ultraLight.bakedKey, glow: ultraU.uLampGlow.value, night: ultraSky.mat.uniforms.uNight ? ultraSky.mat.uniforms.uNight.value : null }));
    assert.match(night.key, /\|night\|/);
    assert.ok(night.glow > 2, 'lanterns glow at night');
    await evaluate(() => { rebuildMapPreset('ascent'); ultraPrep.finish(); });
    await frames(3);
    assert.ok(await evaluate(() => ultraDecor.count) > 1000);
    const [programs, watermark, stalls] = await programState(page);
    assert.equal(programs, watermark);
    assert.equal(stalls, 0);
    assert.deepEqual(errors, []);
});
