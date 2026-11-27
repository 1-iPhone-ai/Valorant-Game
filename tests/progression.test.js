'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser, programState } = require('./harness');

after(closeBrowser);

test('progression: XP for kills and headshots (not wingman kills), levels with a toast, unlocks, locked skins refused until earned', { timeout: 300000 }, async () => {
    const { page, errors, evaluate } = await boot({ quality: 'medium' });
    const r = await evaluate(() => {
        window.updateEnemies = () => {};
        const out = {};
        out.fresh = [progression.level, progression.xp, progression.unlocked.card.slice(), progression.unlocked.spray.slice(), progression.unlocked.skin.slice()];
        // A locked skin cannot be equipped from Settings
        document.querySelector('#setting-skin-cards [data-skin="ember"]').click();
        out.lockedRefused = game.userSettings.weaponSkin === 'standard';
        out.lockTag = document.querySelector('#setting-skin-cards [data-skin="ember"] .skin-lock').textContent;
        out.freeSkin = progression.has('skin', 'prime');
        // Kills: 100 XP, +50 for a headshot; wingman kills give nothing
        switchWeapon('pistol');
        const bots = enemyObjects.filter((e) => e.isActive && !e.hit);
        damageEnemyActor(bots[0], 9999, performance.now(), Date.now(), 'Sheriff', 'head');
        out.afterHs = progression.xp;
        damageEnemyActor(bots[1], 9999, performance.now(), Date.now(), 'Sheriff', 'torso');
        out.afterBody = progression.xp;
        damageEnemyActor(bots[2], 9999, performance.now(), Date.now(), tacticalEnhancements.wingmanBots[0].name, 'torso');
        out.afterWingman = progression.xp;
        out.stats = [progression.stats.kills, progression.stats.headshots];
        // Level up: 800 XP for level 2 unlocks the Night Shift card, with a toast
        progression.award(800 - progression.xp, 'test');
        out.level2 = [progression.level, progression.xp, progression.has('card', 'nightshift')];
        const t = document.getElementById('level-toast');
        out.toast = [t.classList.contains('visible'), t.textContent];
        // Up to level 4: the Ember skin unlocks and can be equipped
        progression.award(progression.need(2) + progression.need(3), 'test');
        out.level4 = [progression.level, progression.has('skin', 'ember')];
        document.querySelector('#setting-skin-cards [data-skin="ember"]').click();
        out.emberOn = game.userSettings.weaponSkin;
        out.unlockedTag = document.querySelector('#setting-skin-cards [data-skin="ember"] .skin-lock').textContent;
        return out;
    });
    assert.deepEqual(r.fresh, [1, 0, ['protocol'], ['star'], []], 'a new player starts at level 1 with the starter card and spray');
    assert.ok(r.lockedRefused, 'a locked skin is refused');
    assert.match(r.lockTag, /UNLOCKS AT LEVEL 4/);
    assert.ok(r.freeSkin, 'the original skins stay free');
    assert.equal(r.afterHs, 150, 'headshot kill: 150 XP');
    assert.equal(r.afterBody, 250, 'kill: 100 XP');
    assert.equal(r.afterWingman, 250, 'wingman kills give no XP');
    assert.deepEqual(r.stats, [2, 1]);
    assert.deepEqual(r.level2, [2, 0, true], 'level 2 unlocks the Night Shift card');
    assert.equal(r.toast[0], true);
    assert.match(r.toast[1], /LEVEL 2/);
    assert.match(r.toast[1], /NIGHT SHIFT CARD/);
    assert.deepEqual(r.level4, [4, true]);
    assert.equal(r.emberOn, 'ember', 'an unlocked skin can be equipped');
    assert.match(r.unlockedTag, /LEVEL 4 REWARD/);
    const [programs, watermark] = await programState(page);
    assert.equal(programs, watermark);
    assert.deepEqual(errors, []);
});

test('progression: XP for round wins, plants, defuses and finished matches', { timeout: 300000 }, async () => {
    const { errors, evaluate } = await boot({ quality: 'medium' });
    const r = await evaluate(() => {
        window.updateEnemies = () => {};
        // V2.2: today's daily challenges are finished first, so they pay nothing here: they are picked by the
        // date, and on a day whose three include 'Finish a Match' the first match end paid its 700 XP too
        progression.ensureDaily();
        for (const c of progression.daily.list) c.done = true;
        const out = {};
        const gain = (fn) => { const before = progression.totalXp; fn(); return progression.totalXp - before; };
        out.plant = gain(() => tacticalDirector.completeSpikePlant(performance.now(), 'A'));
        out.round = gain(() => tacticalEnhancements.onRoundWon('ELIMINATED', 'wave', performance.now()));
        out.matchWin = gain(() => progression.onMatchEnd(true, 'match'));
        out.matchLoss = gain(() => progression.onMatchEnd(false, 'match'));
        out.dmFirst = gain(() => progression.onMatchEnd(true, 'deathmatch', 1));
        out.dmFifth = gain(() => progression.onMatchEnd(false, 'deathmatch', 5));
        out.stats = Object.assign({}, progression.stats);
        return out;
    });
    assert.equal(r.plant, 150);
    assert.equal(r.round, 250);
    assert.equal(r.matchWin, 1000);
    assert.equal(r.matchLoss, 400);
    assert.equal(r.dmFirst, 1000);
    assert.equal(r.dmFifth, 500);
    assert.equal(r.stats.plants, 1);
    assert.equal(r.stats.rounds, 1);
    assert.equal(r.stats.matches, 4);
    assert.deepEqual(errors, []);
});

test('daily challenges: three a day, the same all day, new ones the next day; finishing one pays its XP; slides count', { timeout: 300000 }, async () => {
    const { errors, evaluate } = await boot({ quality: 'medium' });
    const r = await evaluate(() => {
        window.updateEnemies = () => {};
        const out = {};
        progression._today = '2030-01-01';
        progression.ensureDaily();
        const day1 = progression.daily.list.map((c) => c.id);
        out.three = day1.length === 3 && new Set(day1).size === 3;
        progression.daily.list[0].progress = 1;
        progression.ensureDaily();
        out.sameDay = progression.daily.list.map((c) => c.id).join() === day1.join() && progression.daily.list[0].progress === 1;
        progression._today = '2030-01-02';
        progression.ensureDaily();
        out.newDay = progression.daily.list.every((c) => c.progress === 0) && progression.daily.date === '2030-01-02';
        // Same date, same list (for everyone)
        progression._today = '2030-01-01';
        progression.daily.date = '';
        progression.ensureDaily();
        out.repeatable = progression.daily.list.map((c) => c.id).join() === day1.join();
        // A slide challenge: real slides count, the tenth completes it and pays 400 XP
        progression.daily.list = [{ id: 'slide10', progress: 0, done: false }, { id: 'kills15', progress: 0, done: false }, { id: 'defuse1', progress: 0, done: false }];
        // Sprint-and-slide runs need a long straight: Icebox's Reefer Row, along z = -46 from its west
        // end (a 40-tick sprint covers about 50 m; the row is clear for 53 m from x = -46); props off
        tacticalDirector.cycleMapPreset('icebox');
        game.userSettings.breakables = false; breakables.applyEnabled();
        const cc = characterController;
        const before = progression.totalXp;
        for (let i = 0; i < 10; i++) {
            cc.reset(); cc.position.set(-46, cc.standHeight, -46); cc.grounded = true; cc.slideCooldown = 0;
            camera.rotation.set(0, -Math.PI / 2, 0, 'YXZ');
            game.keys.w = true; cc.setSprinting(true);
            for (let k = 0; k < 40; k++) cc.update(1 / 60);
            cc.setCrouching(true); cc.setCrouching(false);
        }
        game.keys.w = false;
        const ch = progression.daily.list[0];
        out.slide = [ch.progress, ch.done, progression.totalXp - before];
        out.toast = document.getElementById('level-toast').textContent;
        return out;
    });
    assert.ok(r.three, 'three different challenges');
    assert.ok(r.sameDay, 'the same challenges and progress all day');
    assert.ok(r.newDay, 'new challenges the next day');
    assert.ok(r.repeatable, 'the list depends only on the date');
    assert.deepEqual(r.slide, [10, true, 400], 'ten slides complete the challenge and pay 400 XP');
    assert.match(r.toast, /CHALLENGE COMPLETE|LEVEL/);
    assert.deepEqual(errors, []);
});

test('Career screen in the main menu, sprays with [N], and progress saved across a reload', { timeout: 400000 }, async () => {
    const { page, errors, frames, evaluate } = await boot({ quality: 'medium', menu: true });
    const r = await evaluate(() => {
        const out = {};
        progression.award(5200, 'test');            // level 5
        out.menuLevel = document.getElementById('mm-level-val').textContent;
        document.querySelector('[data-act="career"]').click();
        out.view = mainMenu.view;
        const el = document.getElementById('mm-career');
        out.level = el.querySelector('#cr-level').textContent;
        out.challenges = el.querySelectorAll('.cr-ch').length;
        out.locked = el.querySelectorAll('.cr-item.locked').length;
        // Equip the unlocked Skyline card and Chevrons spray; a locked spray is refused
        el.querySelector('[data-equip="card:skyline"]').click();
        document.getElementById('mm-career').querySelector('[data-equip="spray:chevrons"]').click();
        document.getElementById('mm-career').querySelector('[data-equip="spray:crown"]').click();
        out.equipped = [progression.card, progression.spray];
        out.menuCard = document.getElementById('mm-card').textContent;
        mainMenu.back();
        out.back = mainMenu.view;
        return out;
    });
    assert.equal(r.menuLevel, 'LEVEL 5');
    assert.equal(r.view, 'career');
    assert.equal(r.level, 'LEVEL 5');
    assert.equal(r.challenges, 3);
    assert.ok(r.locked > 0, 'locked rewards are shown with their level');
    assert.deepEqual(r.equipped, ['skyline', 'chevrons'], 'unlocked items equip; locked ones do not');
    assert.match(r.menuCard, /SKYLINE/);
    assert.equal(r.back, 'main');

    // Spray on the wall in front of you, and not again straight away
    await evaluate(() => mainMenu.resume());
    await frames(2);
    const spray = await evaluate(() => {
        window.updateEnemies = () => {};
        window.presentPlayerCamera = () => {};
        camera.position.set(0, 1.7, 47); camera.rotation.set(0, Math.PI, 0, 'YXZ'); camera.updateMatrixWorld();
        const t = performance.now();
        const first = progression.doSpray(t);
        const m = progression.sprayMesh;
        const again = progression.doSpray(t + 200);
        tacticalDirector.cycleMapPreset('bind');
        return { first, again, z: m.position.z, facing: new THREE.Vector3(0, 0, 1).applyQuaternion(m.quaternion).z, hiddenOnMapChange: !m.visible };
    });
    assert.equal(spray.first, true);
    assert.ok(spray.z > 49 && spray.z < 49.6, `on the wall (z ${spray.z})`);
    assert.ok(spray.facing < -0.99, 'facing back towards you');
    assert.equal(spray.again, false, 'a short cooldown');
    assert.ok(spray.hiddenOnMapChange, 'cleared when the map changes');

    // Saved: still level 5 with the same card after a reload
    await page.reload();
    await page.waitForFunction(() => window.perfTelemetry && perfTelemetry.programWatermark > 0, null, { timeout: 180000 });
    const saved = await evaluate(() => [progression.level, progression.card, progression.spray, progression.has('skin', 'ember')]);
    assert.deepEqual(saved, [5, 'skyline', 'chevrons', true]);
    const [programs, watermark, stalls] = await programState(page);
    assert.equal(programs, watermark, 'no new shader programs');
    assert.equal(stalls, 0);
    assert.deepEqual(errors, []);
});
