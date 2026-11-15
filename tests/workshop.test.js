'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser, programState } = require('./harness');

after(closeBrowser);

// Colours survive the linear/sRGB round trip to within one step per channel
const close = (hexA, hexB) => {
    const a = parseInt(hexA, 16), b = parseInt(hexB, 16);
    return [16, 8, 0].every((sh) => Math.abs(((a >> sh) & 255) - ((b >> sh) & 255)) <= 2);
};

// Linear colour of a material as an sRGB hex number
const SRGB = () => { window.__srgb = (c) => c.clone().convertLinearToSRGB().getHex(); };

test('skins colour the body, trim and glow parts separately (not the whole gun in the glow colour)', { timeout: 300000 }, async () => {
    const { errors, evaluate } = await boot({ quality: 'medium' });
    await evaluate(SRGB);
    const r = await evaluate(() => {
        settingsManager.applyWeaponSkin('prime');
        const t = WEAPON_SKIN_THEMES.prime;
        const kids = game.weapons.rifle.model.children.filter((c) => c.material && c.material.emissive && !c.userData.isHands);
        const glow = kids.filter((c) => c.userData.skinGlowBase > 0);
        const near = (a, b) => Math.abs((a >> 16) - (b >> 16)) <= 2 && Math.abs(((a >> 8) & 255) - ((b >> 8) & 255)) <= 2 && Math.abs((a & 255) - (b & 255)) <= 2;
        return {
            glowParts: glow.length, parts: kids.length,
            body: near(__srgb(kids[0].material.color), t.body),
            glowColour: glow.every((c) => near(__srgb(c.material.color), t.accent)),
            notAllGlow: kids.some((c) => !near(__srgb(c.material.color), t.accent))
        };
    });
    assert.ok(r.glowParts >= 1 && r.glowParts < r.parts, `some parts glow, not all (${r.glowParts}/${r.parts})`);
    assert.ok(r.body, 'the body takes the body colour');
    assert.ok(r.glowColour, 'glowing parts take the glow colour');
    assert.ok(r.notAllGlow);
    assert.deepEqual(errors, []);
});

test('workshop: design in the main menu with a live preview, leave without saving to undo, save and equip into a slot, kept after a reload', { timeout: 400000 }, async () => {
    const { page, errors, frames, evaluate } = await boot({ quality: 'medium', menu: true });
    await evaluate(SRGB);
    await evaluate(() => document.querySelector('[data-act="workshop"]').click());
    await frames(3);
    const live = await evaluate(() => {
        const out = { view: mainMenu.view, preview: !!skinWorkshop.preview && skinWorkshop.preview.parent === mainMenu.showcase, figureHidden: !mainMenu.figure.visible };
        document.querySelector('[data-ws="body:#ff2bd6"]').click();
        document.querySelector('[data-ws="accent:#facc15"]').click();
        document.querySelector('[data-ws="finish:chrome"]').click();
        const glowIn = document.getElementById('ws-glow');
        glowIn.value = 50; glowIn.dispatchEvent(new Event('input', { bubbles: true }));
        const rifle = game.weapons.rifle.model.children;
        const g = rifle.find((c) => c.userData.skinGlowBase > 0);
        out.body = __srgb(rifle[0].material.color).toString(16);
        out.metal = [rifle[0].material.metalness, rifle[0].material.roughness];
        out.glow = [__srgb(g.material.emissive).toString(16), +(g.material.emissiveIntensity / g.userData.skinGlowBase).toFixed(2)];
        out.cloneShares = (() => { let shared = false; skinWorkshop.preview.traverse((o) => { if (o.material === rifle[0].material) shared = true; }); return shared; })();
        out.equippedStill = game.userSettings.weaponSkin;
        return out;
    });
    assert.deepEqual([live.view, live.preview, live.figureHidden], ['workshop', true, true], 'the gun turns in place of the figure');
    assert.ok(close(live.body, 'ff2bd6'), `the preview follows the body colour (${live.body})`);
    assert.deepEqual(live.metal, [1, 0.08], 'chrome finish');
    assert.ok(close(live.glow[0], 'facc15'), 'glow colour');
    assert.equal(live.glow[1], 0.5, 'glow strength');
    assert.ok(live.cloneShares, 'the preview shares the real gun materials');
    assert.equal(live.equippedStill, 'standard', 'nothing is equipped until saved');

    // BACK without saving puts the equipped skin back
    const undone = await evaluate(() => {
        mainMenu.back();
        const rifle = game.weapons.rifle.model.children;
        return { view: mainMenu.view, body: __srgb(rifle[0].material.color), want: WEAPON_SKIN_THEMES.standard.body, preview: !!skinWorkshop.preview };
    });
    assert.equal(undone.view, 'main');
    assert.ok(close(undone.body.toString(16), undone.want.toString(16)), 'back to the equipped skin');
    await frames(2);
    assert.equal(await evaluate(() => !!skinWorkshop.preview || !mainMenu.figure.visible), false, 'preview gone, figure back');

    // Slot 2: name it, design, save & equip
    const saved = await evaluate(() => {
        document.querySelector('[data-act="workshop"]').click();
        document.querySelector('[data-ws="slot:1"]').click();
        const name = document.getElementById('ws-name');
        name.value = 'Night Wave'; name.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('[data-ws="body:#6366f1"]').click();
        document.querySelector('[data-ws="tracer:#2bf0a5"]').click();
        document.querySelector('[data-ws="save"]').click();
        const card = document.querySelector('#setting-skin-cards [data-skin="custom2"]');
        return {
            equipped: game.userSettings.weaponSkin,
            slots: game.userSettings.customSkins.map((d) => d && d.name),
            card: [card.style.display, card.querySelector('.ws-card-name').textContent, card.classList.contains('active')],
            menuVal: document.getElementById('mm-skin-val').textContent,
            stored: JSON.parse(localStorage.getItem('valorant_v16_user_settings')).customSkins[1].name,
            tracer: __srgb(effectBatches.trail.mesh.material.color).toString(16),
            career: (progression.renderCareer(), !!document.querySelector('#mm-career [data-equip="skin:custom2"]'))
        };
    });
    assert.equal(saved.equipped, 'custom2');
    assert.deepEqual(saved.slots, [null, 'Night Wave']);
    assert.deepEqual(saved.card, ['', 'NIGHT WAVE // WORKSHOP', true], 'shown and selected in Settings');
    assert.equal(saved.menuVal, 'NIGHT WAVE');
    assert.equal(saved.stored, 'Night Wave');
    assert.ok(close(saved.tracer, '2bf0a5'), 'tracer colour');
    assert.ok(saved.career, 'listed in the Career screen');

    await page.reload();
    await page.waitForFunction(() => window.perfTelemetry && perfTelemetry.programWatermark > 0, null, { timeout: 180000 });
    await evaluate(SRGB);
    const after = await evaluate(() => [game.userSettings.weaponSkin, __srgb(game.weapons.rifle.model.children[0].material.color).toString(16)]);
    assert.equal(after[0], 'custom2', 'still equipped after a reload');
    assert.ok(close(after[1], '6366f1'));
    const [programs, watermark, stalls] = await programState(page);
    assert.equal(programs, watermark, 'no new shader programs');
    assert.equal(stalls, 0);
    assert.deepEqual(errors, []);
});
