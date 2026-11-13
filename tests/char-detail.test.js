'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser, programState } = require('./harness');

after(closeBrowser);

test('High Detail Characters & Guns is off by default and builds nothing until enabled', { timeout: 240000 }, async () => {
    const { errors, evaluate } = await boot();
    const s = await evaluate(() => ({
        setting: game.userSettings.charDetail,
        enabled: characterDetail.enabled,
        built: characterDetail.built,
        torsoIsOriginal: enemyPartSpecs[0].geometry === actorTemplates.enemyTorso,
        pill: document.querySelector('#setting-char-detail-pills .active').dataset.chardetail
    }));
    assert.deepEqual(s, { setting: 'off', enabled: false, built: false, torsoIsOriginal: true, pill: 'off' });
    assert.deepEqual(errors, []);
});

test('High Detail Characters & Guns: detailed bots, wingmen and guns; hitboxes, skins and shaders unchanged', { timeout: 600000 }, async () => {
    const { page, errors, frames, evaluate } = await boot({ quality: 'high' });
    await evaluate(() => document.querySelector('#setting-char-detail-pills [data-chardetail="on"]').click());
    await frames(3);
    const on = await evaluate(() => {
        const live = [];
        for (const chunk of enemyChunks.values()) for (const page of chunk.pages) live.push(page);
        const detailedPages = live.every((page) => page.meshes.every((m, p) => m.geometry.attributes.position === characterDetail.detailed[enemyPartSpecs[p].name].attributes.position));
        // Hit proxies keep the original boxes
        const leavesOriginal = enemyObjects.every((e) => e.leaves[0].geometry === actorTemplates.enemyTorso && e.leaves[1].geometry === actorTemplates.enemyHead && e.leaves[2].geometry === actorTemplates.enemyLegs);
        // Everything drawn stays inside the original overall hit volume (small tolerance)
        const hit = new THREE.Box3();
        for (const g of [actorTemplates.enemyTorso, actorTemplates.enemyHead, actorTemplates.enemyLegs, actorTemplates.enemyWeapon]) {
            if (!g) continue;
            g.computeBoundingBox();
            hit.union(g.boundingBox);
        }
        hit.expandByScalar(0.03);
        const inside = enemyPartSpecs.every((spec) => { const g = characterDetail.detailed[spec.name]; g.computeBoundingBox(); return hit.containsBox(g.boundingBox); });
        return {
            setting: game.userSettings.charDetail,
            saved: JSON.parse(localStorage.getItem('valorant_v16_user_settings') || '{}').charDetail,
            livePages: live.length, detailedPages, leavesOriginal, inside,
            gunSwaps: characterDetail.gunSwaps.length,
            kitsVisible: characterDetail.kits.length > 0 && characterDetail.kits.every((k) => k.visible),
            wingmen: characterDetail.wingmanKits.length
        };
    });
    assert.equal(on.setting, 'on');
    assert.equal(on.saved, 'on');
    assert.ok(on.livePages > 0, 'some enemies are on screen');
    assert.ok(on.detailedPages, 'enemy batches draw the detailed geometry');
    assert.ok(on.leavesOriginal, 'hit proxies keep the original boxes');
    assert.ok(on.inside, 'detailed bots stay inside the original hit volume');
    assert.ok(on.gunSwaps >= 20, `gun parts are rounded (${on.gunSwaps})`);
    assert.ok(on.kitsVisible, 'gun detail kits are shown');
    assert.equal(on.wingmen, 2, 'both wingmen get detail');

    // Every gun drawn with detail, and new enemy pages (respawns) use it too
    for (const w of ['sniper', 'pistol', 'knife', 'rifle']) {
        await evaluate((w) => switchWeapon(w), w);
        await frames(6);
    }
    await evaluate(() => { for (const e of enemyObjects) if (e.isActive && !e.hit) damageEnemyActor(e, 9999, performance.now(), Date.now(), 'Test', 'torso'); });
    await frames(10);
    await evaluate(() => { for (const e of enemyObjects) if (e.hit) respawnEnemy(e); packEnemyBatches(); });
    await frames(6);
    const respawned = await evaluate(() => {
        let ok = true, n = 0;
        for (const chunk of enemyChunks.values()) for (const page of chunk.pages) page.meshes.forEach((m, p) => { n++; if (m.geometry.index !== characterDetail.detailed[enemyPartSpecs[p].name].index) ok = false; });
        return { ok, n };
    });
    assert.ok(respawned.n > 0 && respawned.ok, 'respawned enemies use the detailed geometry');

    // Skins recolour the kit through the shared materials; hands keep their skin tone
    const skin = await evaluate(() => {
        settingsManager.applyWeaponSkin('prime');
        const rifle = game.weapons.rifle.model;
        const hands = rifle.children.find((c) => c.userData.isHands);
        const kit = characterDetail.kits.find((k) => k.name === 'rifleDetailKit');
        const mats = new Set(rifle.children.filter((c) => c.material).map((c) => c.material));
        return {
            handsSkinTone: hands.material.color.equals(linearColorFromHex(0xffdbac)),
            kitSharesMaterials: kit.children.every((m) => mats.has(m.material))
        };
    });
    assert.deepEqual(skin, { handsSkinTone: true, kitSharesMaterials: true });

    // Low turns it off (original boxes back); leaving Low turns it on again
    await evaluate(() => setQualitySettings('low'));
    await frames(3);
    assert.deepEqual(await evaluate(() => [characterDetail.enabled, enemyPartSpecs[0].geometry === actorTemplates.enemyTorso, game.weapons.rifle.model.children[0].geometry.type]), [false, true, 'BoxGeometry']);
    await evaluate(() => setQualitySettings('high'));
    await frames(3);
    assert.equal(await evaluate(() => characterDetail.enabled), true);

    const [programs, watermark, stalls] = await programState(page);
    assert.equal(programs, watermark, 'no new shader programs');
    assert.equal(stalls, 0);
    assert.deepEqual(errors, []);
});
