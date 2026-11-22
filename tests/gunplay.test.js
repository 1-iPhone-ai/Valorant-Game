'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser, programState } = require('./harness');

after(closeBrowser);

// An open lane on Ascent: from (-36, 1.7, 44) looking down -Z nothing is in the way for 90 m.
// __spray fires n bullets of a gun as a held trigger (each shot exactly one fire interval after
// the last, the mouse untouched) and returns where each bullet went, in degrees right of and
// above the first one, read from the real shot rays. __hits stands still or moves at a share of
// run speed and counts single first shots that hit a bot 20 m away.
const HELPERS = `
    window.__lane = { x: -36, z: 44 };
    window.updateEnemies = () => {};
    window.__deg = 180 / Math.PI;
    window.__reset = (yaw) => {
        const cc = characterController;
        cc.position.set(__lane.x, 1.7, __lane.z); cc.prevSimPosition.copy(cc.position); cc.velocity.set(0, 0, 0);
        cc.grounded = true; cc.crouchBlend = 0; cc.dashTimer = 0;
        camera.position.copy(cc.position);
        camera.rotation.set(0, yaw || 0, 0, 'YXZ');
        game.recoilAccumPitch = 0; game.recoilAccumYaw = 0; game.recoilHeat = 0; game.sprayShotCount = 0;
        game.adsActive = false; game.adsProgress = 0; game.reloading = false; game.lastShot = 0;
    };
    window.__spray = (gun, n, yaw) => {
        game.reloading = false;
        equipGun(gun);
        const w = game.weapons[game.activeWeapon];
        __reset(yaw);
        const seq0 = gunplay.traceSeq;
        for (let i = 0; i < n; i++) { w.ammo = w.maxAmmo; game.lastShot = i === 0 ? 0 : Date.now() - w.fireRate; shoot(); }
        const shots = gunplay.lastShots(gunplay.traceSeq - seq0);
        const y0 = shots[0].yaw, p0 = shots[0].pitch;
        __reset(yaw);
        return shots.map((s) => [-(s.yaw - y0) * __deg, (s.pitch - p0) * __deg, s.idx]);
    };
    window.__bot = null;
    window.__hitCount = 0;
    window.__placeBot = (dist) => {
        const e = enemyObjects.find((x) => x.isActive && !x.hit);
        e.mesh.position.set(__lane.x, 0, __lane.z - dist); e.mesh.rotation.y = 0; e.poseDirty = true;
        e.health = 9999; e.armor = 0; syncEnemyBroadphase(e); packEnemyBatches();
        __bot = e;
        return e;
    };
    window.__hits = (gun, frac, opts) => {
        opts = opts || {};
        game.reloading = false;
        equipGun(gun);
        const w = game.weapons[game.activeWeapon];
        const cc = characterController, runTop = cc.terminalSpeed(cc.walkSpeed);
        const orig = window.damageEnemyActor;
        let hits = 0, dmg = [];
        window.damageEnemyActor = (en, amt) => { if (en === __bot) { hits++; dmg.push(amt); } en.health = 9999; return false; };
        const n = opts.n || 60;
        for (let i = 0; i < n; i++) {
            __reset(0);
            camera.lookAt(__lane.x, 1.2, __bot.mesh.position.z); camera.updateMatrixWorld();
            cc.velocity.set(runTop * frac, 0, 0);
            cc.grounded = !opts.air;
            cc.crouchBlend = opts.crouch ? 1 : 0;
            w.ammo = w.maxAmmo;
            shoot();
        }
        window.damageEnemyActor = orig;
        __reset(0);
        return { pct: Math.round(hits / n * 100), dmg };
    };
`;

const maxDiff = (a, b) => Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1])));

test('spray patterns: two uncompensated sprays draw the same shape (any facing); first shots near-perfect; each gun resets on its own time', { timeout: 400000 }, async () => {
    const { page, errors, evaluate } = await boot({ quality: 'low' });
    await page.addScriptTag({ content: HELPERS });
    const r = await evaluate(() => {
        const out = {};
        const autos = GUN_ORDER.filter((id) => GUN_DEFS[id].automatic);
        out.autos = autos.map((id) => [id, GUN_DEFS[id].pattern ? GUN_DEFS[id].pattern.length : 0]);
        out.distinctPatterns = new Set(autos.map((id) => JSON.stringify(GUN_DEFS[id].pattern))).size === autos.length;
        out.resets = new Set(GUN_ORDER.map((id) => GUN_DEFS[id].reset)).size;
        out.vandal = [__spray('vandal', 20, 0), __spray('vandal', 20, 0), __spray('vandal', 20, Math.PI / 2), __spray('vandal', 20, -2.4)];
        out.phantom = [__spray('phantom', 20, 0), __spray('phantom', 20, 1.1)];
        out.spectre = [__spray('spectre', 20, 0), __spray('spectre', 20, 0)];
        out.odin = [__spray('odin', 24, 0), __spray('odin', 24, 0)];
        // First shot standing still: near-perfect
        out.first = {};
        for (const id of ['vandal', 'phantom', 'guardian', 'sheriff', 'ghost', 'classic']) {
            equipGun(id); __reset(0); const w = game.weapons[game.activeWeapon]; w.ammo = w.maxAmmo; shoot();
            out.first[id] = gunplay.lastErr * __deg;
        }
        // Per-gun reset: after 8 Vandal bullets, a short pause goes part of the way back,
        // a pause longer than the Vandal's reset time starts the pattern again
        const after = (gun, pauseMs) => {
            equipGun(gun); __reset(0); const w = game.weapons[game.activeWeapon];
            for (let i = 0; i < 8; i++) { w.ammo = w.maxAmmo; game.lastShot = i === 0 ? 0 : Date.now() - w.fireRate; shoot(); }
            w.ammo = w.maxAmmo; game.lastShot = Date.now() - pauseMs; shoot();
            return gunplay.lastShots(1)[0].idx;
        };
        out.vandalHeld = after('vandal', 102);
        out.vandalShortPause = after('vandal', 290);
        out.vandalLongPause = after('vandal', GUN_DEFS.vandal.reset + 30);
        out.spectreAfter300 = after('spectre', 300);
        out.odinAfter300 = after('odin', 300);
        // The camera climbs with the spray and comes back after it
        equipGun('vandal'); __reset(0);
        const w = game.weapons.rifle;
        for (let i = 0; i < 10; i++) { w.ammo = w.maxAmmo; game.lastShot = i === 0 ? 0 : Date.now() - w.fireRate; shoot(); }
        out.camClimb = camera.rotation.x * __deg;
        return out;
    });
    for (const [id, n] of r.autos) assert.ok(n >= 8 && n <= 12, `${id}: its own pattern of 8-12 bullets (${n})`);
    assert.ok(r.distinctPatterns, 'every automatic gun has its own pattern');
    assert.ok(r.resets >= 8, `reset times differ by gun (${r.resets} different)`);

    const [v1, v2, v3, v4] = r.vandal;
    const extent = Math.max(...v1.map((p) => Math.hypot(p[0], p[1])));
    assert.ok(extent > 4, `the Vandal spray climbs (${extent.toFixed(2)}°)`);
    assert.ok(maxDiff(v1, v2) < 0.7, `two Vandal sprays draw the same shape (max ${maxDiff(v1, v2).toFixed(2)}°)`);
    assert.ok(maxDiff(v1, v3) < 0.7 && maxDiff(v1, v4) < 0.7, 'facing another way draws the same shape');
    // First bullets go up, then the spray sways left and right inside a bound
    assert.ok(v1.slice(1, 6).every((p, i) => Math.abs(p[0]) < 0.6 && p[1] > v1[i][1]), 'the first bullets climb straight up');
    const top = v1.slice(12);
    assert.ok(Math.max(...top.map((p) => p[0])) > 0.5 && Math.min(...top.map((p) => p[0])) < -0.5, 'then it sways left and right');
    assert.ok(top.every((p) => Math.abs(p[0]) < 2.2 && p[1] < 6.4), 'the sway stays bounded');
    assert.ok(maxDiff(r.phantom[0], r.phantom[1]) < 0.7, 'Phantom sprays repeat');
    assert.ok(maxDiff(r.spectre[0], r.spectre[1]) < 1.2, 'Spectre sprays repeat (a little looser)');
    assert.ok(maxDiff(r.odin[0], r.odin[1]) < 1.3, 'Odin sprays repeat');
    assert.ok(maxDiff(v1, r.phantom[0]) > 0.5, 'the Phantom pattern is not the Vandal pattern');

    for (const id in r.first) assert.ok(r.first[id] < 0.11, `${id}: first shot standing still is near-perfect (${r.first[id].toFixed(3)}°)`);
    assert.equal(r.vandalHeld, 8, 'a held trigger walks on along the pattern');
    assert.ok(r.vandalShortPause > 0 && r.vandalShortPause < 8, `a short pause goes part of the way back (${r.vandalShortPause})`);
    assert.equal(r.vandalLongPause, 0, 'after the reset time the pattern starts again');
    assert.ok(r.spectreAfter300 < r.odinAfter300, `the Spectre resets faster than the Odin (${r.spectreAfter300} vs ${r.odinAfter300})`);
    assert.ok(r.camClimb > 3, `the crosshair climbs with the spray (${r.camClimb.toFixed(2)}°)`);
    assert.deepEqual(errors, []);
});

test('movement error: accurate below 30% of run speed; a running Vandal at 20 m mostly misses; SMGs and shotguns suffer less, pistols between; the trainer and pill show it', { timeout: 400000 }, async () => {
    const { page, errors, evaluate } = await boot({ quality: 'low' });
    await page.addScriptTag({ content: HELPERS });
    const r = await evaluate(() => {
        __placeBot(20);
        const out = {};
        out.vandal = { still: __hits('vandal', 0).pct, strafe: __hits('vandal', 0.25).pct, run: __hits('vandal', 1).pct, air: __hits('vandal', 0, { air: true }).pct, runCrouch: __hits('vandal', 1, { crouch: true }).pct };
        out.sheriffRun = __hits('sheriff', 1).pct;
        out.spectreRun = __hits('spectre', 1).pct;
        out.operatorRun = __hits('operator', 1).pct;
        // The error itself (rad at run speed) by class
        const cc = characterController, runTop = cc.terminalSpeed(cc.walkSpeed);
        const errAt = (id, frac) => { cc.velocity.set(runTop * frac, 0, 0); cc.grounded = true; const e = gunplay.moveError(GUN_DEFS[id]); cc.velocity.set(0, 0, 0); return e; };
        out.err = {};
        for (const id of ['vandal', 'operator', 'odin', 'sheriff', 'ghost', 'spectre', 'stinger', 'bucky', 'judge']) out.err[id] = errAt(id, 1);
        out.window = [errAt('vandal', 0.29), errAt('vandal', 0.35) > 0];
        // Pill and trainer
        game.userSettings.showRecoilTrainer = true;
        settingsManager.applyHudVisibility();
        equipGun('vandal'); __reset(0);
        settingsManager.updateRecoilTrainerMovement();
        const pill = document.getElementById('recoil-strafe-pill');
        out.pillStill = [pill.textContent, pill.classList.contains('moving')];
        cc.velocity.set(runTop, 0, 0);
        settingsManager.updateRecoilTrainerMovement();
        out.pillRun = [pill.textContent, pill.classList.contains('moving')];
        cc.velocity.set(0, 0, 0);
        __spray('vandal', 10, 0);
        out.trainerPoints = settingsManager._sprayN;
        return out;
    });
    assert.ok(r.vandal.still >= 95 && r.vandal.strafe >= 95, `Vandal standing ${r.vandal.still}%, counter-strafing at 25% speed ${r.vandal.strafe}%`);
    assert.ok(r.vandal.run < 45, `a running Vandal at 20 m mostly misses (${r.vandal.run}% hits)`);
    assert.ok(r.vandal.air < 45, `jumping is inaccurate (${r.vandal.air}%)`);
    assert.ok(r.vandal.runCrouch > r.vandal.run, 'crouching still halves the error');
    assert.ok(r.spectreRun >= 80, `an SMG barely suffers from running (${r.spectreRun}%)`);
    assert.ok(r.vandal.run < r.sheriffRun && r.sheriffRun < r.spectreRun, `pistols sit between (Vandal ${r.vandal.run}%, Sheriff ${r.sheriffRun}%, Spectre ${r.spectreRun}%)`);
    assert.ok(r.operatorRun < 45, `a running Operator mostly misses (${r.operatorRun}%)`);
    const e = r.err;
    assert.ok(Math.min(e.vandal, e.operator) > Math.max(e.sheriff, e.ghost), 'rifles and snipers suffer more than pistols');
    assert.ok(Math.min(e.sheriff, e.ghost) > Math.max(e.spectre, e.stinger, e.bucky, e.judge), 'pistols suffer more than SMGs and shotguns');
    assert.ok(e.odin > e.sheriff, 'heavies suffer from running too');
    assert.deepEqual(r.window, [0, true], 'no movement error inside the counter-strafe window, some above it');
    assert.equal(r.pillStill[1], false);
    assert.match(r.pillStill[0], /^ACCURATE 0%/);
    assert.equal(r.pillRun[1], true);
    assert.match(r.pillRun[0], /^100% \+5\.2°$/, `the pill shows speed and error (${r.pillRun[0]})`);
    assert.equal(r.trainerPoints, 10, 'the Recoil Trainer plots every bullet of the spray');
    assert.deepEqual(errors, []);
});

test('damage falloff: none for the Vandal, three bands for the Phantom, steep for SMGs, pistols and shotguns', { timeout: 300000 }, async () => {
    const { page, errors, evaluate } = await boot({ quality: 'low' });
    await page.addScriptTag({ content: HELPERS });
    const r = await evaluate(() => {
        const at = (gun, dist) => { __placeBot(dist); const h = __hits(gun, 0, { n: 1 }); return h.dmg[0]; };
        const pellets = (gun, dist) => { __placeBot(dist); const h = __hits(gun, 0, { n: 1 }); return h.dmg.length ? Math.max(...h.dmg) : 0; };
        return {
            vandal: [at('vandal', 5), at('vandal', 25), at('vandal', 45)],
            phantom: [at('phantom', 10), at('phantom', 20), at('phantom', 40)],
            spectre: [at('spectre', 8), at('spectre', 30)],
            stinger: [at('stinger', 8), at('stinger', 30)],
            classic: [at('classic', 8), at('classic', 35)],
            ghost: [at('ghost', 10), at('ghost', 40)],
            sheriff: [at('sheriff', 10), at('sheriff', 35)],
            bucky: [pellets('bucky', 5), pellets('bucky', 16)],
            judge: [pellets('judge', 5), pellets('judge', 16)],
            bands: { vandal: GUN_DEFS.vandal.falloff || null, phantom: GUN_DEFS.phantom.falloff.length }
        };
    });
    assert.deepEqual(r.vandal, [40, 40, 40], 'the Vandal does the same damage at every range');
    assert.equal(r.bands.vandal, null);
    assert.equal(r.bands.phantom, 3);
    assert.deepEqual(r.phantom, [39, 35, 31], 'the Phantom has three bands');
    for (const gun of ['spectre', 'stinger', 'classic', 'ghost']) {
        assert.ok(r[gun][1] <= Math.round(r[gun][0] * 0.68), `${gun} falls off steeply (${r[gun].join(' -> ')})`);
    }
    assert.ok(r.sheriff[1] < r.sheriff[0], 'the Sheriff falls off too');
    assert.ok(r.bucky[1] <= r.bucky[0] * 0.35 && r.judge[1] <= r.judge[0] * 0.45, `shotgun pellets fall off hard (Bucky ${r.bucky.join(' -> ')}, Judge ${r.judge.join(' -> ')})`);
    assert.deepEqual(errors, []);
});

test('new guns: Ghost, Bandit, Stinger, Spectre, Bucky, Guardian, Ares and Odin have stats, a viewmodel, their own sound, a kill-feed name and skins; no new shader programs', { timeout: 400000 }, async () => {
    const { page, errors, frames, evaluate } = await boot({ quality: 'medium' });
    const [baseline] = await programState(page);
    await page.addScriptTag({ content: HELPERS });
    const NEW = ['ghost', 'bandit', 'stinger', 'spectre', 'bucky', 'guardian', 'ares', 'odin'];
    const r = await evaluate((NEW) => {
        const out = { guns: {} };
        soundFX.ensureContext();
        for (const id of NEW) {
            const d = GUN_DEFS[id];
            game.reloading = false;
            equipGun(id);
            const w = game.weapons[game.activeWeapon];
            const kit = viewmodelKits.groups[id];
            const mats = new Set(w.model.children.filter((c) => c.material).map((c) => c.material));
            let kitShares = true;
            kit.group.traverse((o) => { if (o.isMesh && !mats.has(o.material)) kitShares = false; });
            kit.slideGroup.traverse((o) => { if (o.isMesh && !mats.has(o.material)) kitShares = false; });
            // Fire one shot and kill a bot with it
            __placeBot(6);
            __reset(0); camera.lookAt(__lane.x, 1.25, __bot.mesh.position.z); camera.updateMatrixWorld();
            __bot.health = 1; __bot.armor = 0;
            w.ammo = w.maxAmmo;
            const feed = document.getElementById('kill-feed');
            const before = feed.children.length;
            shoot();
            // The kill line (a cleared wave can add its own line after it)
            const lastFeed = Array.from(feed.children).slice(before).map((m) => m.textContent).join(' | ');
            out.guns[id] = {
                slot: game.activeWeapon === d.slot, name: w.name, stats: [w.damage, w.maxAmmo, w.fireRate, d.price > 0],
                kitShown: viewmodelKits.shown[d.slot] === id && kit.group.visible, kitShares,
                sound: soundFX.lastGun, killFeed: lastFeed.includes('with ' + d.name)
            };
            if (__bot.hit) { respawnEnemy(__bot); packEnemyBatches(); }
        }
        // Only the equipped gun's kit shows; the plain Vandal has none
        equipGun('vandal');
        out.vandalPlain = viewmodelKits.shown.rifle === null && !viewmodelKits.groups.odin.group.visible && !viewmodelKits.groups.spectre.group.visible;
        // A skin recolours the kits through the shared materials
        equipGun('odin');
        settingsManager.applyWeaponSkin('prime');
        const odinBody = viewmodelKits.groups.odin.group.children[0].material;
        out.skinned = odinBody === game.weapons.rifle.model.children[0].material
            && odinBody.color.equals(linearColorFromHex(WEAPON_SKIN_THEMES.prime.body));
        settingsManager.applyWeaponSkin('standard');
        // 18 guns, 18 different sounds
        out.sounds = new Set(GUN_ORDER.map((id) => GUN_DEFS[id].sound)).size;
        out.soundTable = GUN_ORDER.every((id) => !!soundFX.GUN_SOUNDS[GUN_DEFS[id].sound]);
        out.recipes = new Set(GUN_ORDER.map((id) => JSON.stringify(soundFX.GUN_SOUNDS[GUN_DEFS[id].sound]))).size;
        return out;
    }, NEW);
    for (const id of NEW) {
        const g = r.guns[id];
        assert.ok(g.slot, `${id}: on its slot`);
        assert.ok(g.stats[0] > 0 && g.stats[1] > 0 && g.stats[2] > 0 && g.stats[3], `${id}: stats and a price`);
        assert.ok(g.kitShown, `${id}: its own viewmodel parts are shown`);
        assert.ok(g.kitShares, `${id}: the parts use the gun's own materials (skins, no new shaders)`);
        assert.equal(g.sound, id, `${id}: its own sound`);
        assert.ok(g.killFeed, `${id}: the kill feed names the ${g.name}`);
    }
    assert.ok(r.vandalPlain, 'only the equipped gun shows its parts');
    assert.ok(r.skinned, 'skins recolour the new parts');
    assert.equal(r.sounds, 18);
    assert.ok(r.soundTable);
    assert.equal(r.recipes, 18, 'every gun has its own sound recipe');
    await frames(10);
    const [programs, watermark] = await programState(page);
    assert.equal(programs, baseline);
    assert.equal(programs, watermark, 'no shader compiles');
    assert.deepEqual(errors, []);
});

test('Match and Ranked: one primary + one sidearm + knife on the credit ladder; losing the pistol round leaves no rifle and heavy armour; other modes pick any gun free; Spike Rush is locked', { timeout: 500000 }, async () => {
    const { page, errors, frames, evaluate } = await boot({ quality: 'low' });
    const skipPhase = () => evaluate(() => { matchMode.phaseEndsAt = performance.now(); replayDirector.stop(); });
    const LADDER = { classic: 0, frenzy: 450, ghost: 500, bandit: 600, sheriff: 800, bucky: 850, marshal: 950, stinger: 1100, spectre: 1600, ares: 1600,
        judge: 1850, bulldog: 2050, guardian: 2250, outlaw: 2400, phantom: 2900, vandal: 2900, odin: 3200, operator: 4700 };
    await evaluate(() => tacticalDirector.setGameMode('match'));
    await frames(3);
    const start = await evaluate(() => {
        const st = () => [game.creds, loadout.primary, loadout.sidearm, game.activeWeapon];
        const out = { mode: loadout.mode(), start: st(), shield: game.shield };
        switchWeapon('rifle'); switchWeapon('sniper');
        out.keysNoPrimary = game.activeWeapon;
        out.cards = {};
        document.querySelectorAll('#armory-grid .gun-card').forEach((c) => { out.cards[c.getAttribute('data-buy').slice(4)] = +c.getAttribute('data-cost'); });
        out.cats = Array.from(document.querySelectorAll('#armory-grid .armory-col .buy-col-title')).map((t) => t.textContent);
        tacticalDirector.purchaseItem('gun:ghost'); out.ghost = st();
        tacticalDirector.purchaseItem('gun:frenzy'); out.swap = st();
        tacticalDirector.purchaseItem('gun:frenzy'); out.sold = st();
        tacticalDirector.purchaseItem('upgrade_rifle'); out.noOverclock = [game.creds, game.weaponUpgrades.vandalOverclock];
        return out;
    });
    assert.equal(start.mode, 'economy');
    assert.deepEqual(start.start, [800, null, 'classic', 'pistol'], 'a Match starts with 800 and a Classic');
    assert.equal(start.shield, 0, 'no free armour in the pistol round');
    assert.equal(start.keysNoPrimary, 'pistol', 'no primary to take out yet');
    assert.deepEqual(start.cards, LADDER, 'the buy ladder');
    assert.deepEqual(start.cats, ['SIDEARMS', 'SMGS', 'SHOTGUNS', 'RIFLES', 'SNIPERS', 'HEAVIES']);
    assert.deepEqual(start.ghost, [300, null, 'ghost', 'pistol']);
    assert.deepEqual(start.swap, [350, null, 'frenzy', 'pistol'], 'a sidearm replaces the sidearm (the one bought this round is sold back)');
    assert.deepEqual(start.sold, [800, null, 'classic', 'pistol'], 'selling it back returns the money and the Classic');
    assert.deepEqual(start.noOverclock, [800, false], 'no overclocks in a Match');

    // Live: no buying. Kill 4 of the 5 defenders, then die: the pistol round is lost
    await skipPhase();
    await frames(3);
    const lost = await evaluate(() => {
        const out = { phase: matchMode.phase };
        tacticalDirector.purchaseItem('gun:sheriff');
        tacticalDirector.purchaseItem('light_shield');
        out.liveBuys = [game.creds, loadout.sidearm, game.shield];
        const live = enemyObjects.filter((e) => e.isActive && !e.hit);
        out.killed = live.length - 1;
        for (let i = 0; i < live.length - 1; i++) damageEnemyActor(live[i], 9999, performance.now(), Date.now(), 'Test', 'head', 4, 0.85, true);
        out.killCreds = game.creds;
        const e = live[live.length - 1];
        game.shield = 0;
        for (let i = 0; i < 6; i++) takeDamage(25, e.mesh.position, { enemy: e });
        out.dead = matchMode.playerDead;
        return out;
    });
    assert.equal(lost.phase, 'live');
    assert.deepEqual(lost.liveBuys, [800, 'classic', 0], 'nothing can be bought after the buy phase');
    assert.ok(lost.killed >= 1);
    assert.equal(lost.killCreds, 800 + lost.killed * 200, 'a kill pays a flat 200 in a Match (headshot or wallbang)');
    // Even the best lost pistol round (no buys, 4 of 5 killed) stays under rifle + heavy armour
    assert.ok(800 + 4 * 200 + 1900 < 2900 + 1000);
    assert.ok(lost.dead);
    await skipPhase();
    await frames(3);
    const r2 = await evaluate(() => {
        const out = { round: matchMode.round, phase: matchMode.phase, creds: game.creds };
        tacticalDirector.purchaseItem('gun:vandal');
        tacticalDirector.purchaseItem('heavy_shield');
        out.after = [game.creds, loadout.primary, game.shield];
        return out;
    });
    assert.deepEqual([r2.round, r2.phase], [2, 'buy']);
    assert.equal(r2.creds, 800 + lost.killed * 200 + 1900, 'loss bonus 1900');
    assert.ok(r2.creds < 2900 + 1000, 'after losing the pistol round a rifle and heavy armour are out of reach');
    assert.ok(r2.after[1] !== 'vandal' || r2.after[2] < 50, `not both (${r2.after})`);

    // Round 2: buy a Phantom (sell the shield purchase's money back is not possible; just play it),
    // win the round alive and keep it; then die with it and lose it
    const keep = await evaluate(() => {
        game.creds = 4000;
        tacticalDirector.purchaseItem('gun:phantom');
        return [loadout.primary, game.activeWeapon, game.weapons.rifle.gunId];
    });
    assert.deepEqual(keep, ['phantom', 'rifle', 'phantom']);
    await skipPhase();
    await frames(3);
    await evaluate(() => { game.weapons.rifle.ammo = 3; for (const e of enemyObjects) if (e.isActive && !e.hit) damageEnemyActor(e, 9999, performance.now(), Date.now(), 'Test', 'torso'); });
    await frames(3);
    await skipPhase();
    await frames(3);
    const carried = await evaluate(() => {
        const out = { round: matchMode.round, primary: loadout.primary, active: game.activeWeapon, ammo: game.weapons.rifle.ammo };
        switchWeapon('sniper');
        out.key2 = game.activeWeapon;
        out.slot2Empty = document.getElementById('weapon-slot-2').classList.contains('empty');
        out.slot1 = document.querySelector('#weapon-slot-1 .weapon-name').textContent;
        // Buy an Operator: it replaces the Phantom as the primary
        game.creds = 6000;
        tacticalDirector.purchaseItem('gun:operator');
        out.op = [loadout.primary, game.activeWeapon];
        switchWeapon('rifle');
        out.key1 = game.activeWeapon;
        return out;
    });
    assert.deepEqual([carried.round, carried.primary, carried.active, carried.ammo], [3, 'phantom', 'rifle', 30], 'surviving keeps the gun, with full ammo');
    assert.equal(carried.key2, 'rifle', 'keys 1 and 2 both take out the primary');
    assert.equal(carried.slot2Empty, true);
    assert.equal(carried.slot1, 'Phantom');
    assert.deepEqual(carried.op, ['operator', 'sniper'], 'one primary: the Operator replaces the Phantom');
    assert.equal(carried.key1, 'sniper');
    await skipPhase();
    await frames(3);
    await evaluate(() => {
        const e = enemyObjects.find((x) => x.isActive && !x.hit);
        game.shield = 0;
        for (let i = 0; i < 6; i++) takeDamage(25, e.mesh.position, { enemy: e });
    });
    await skipPhase();
    await frames(3);
    const died = await evaluate(() => [matchMode.round, loadout.primary, loadout.sidearm, game.activeWeapon]);
    assert.deepEqual(died, [4, null, 'classic', 'pistol'], 'dying loses the guns');

    // Ranked runs the same rules
    await evaluate(() => tacticalDirector.setGameMode('ranked'));
    await frames(3);
    assert.deepEqual(await evaluate(() => [matchMode.ranked, loadout.mode(), loadout.primary, game.creds]), [true, 'economy', null, 800]);

    // Other modes: every gun free; [V] cycles every primary
    await evaluate(() => tacticalDirector.setGameMode('wave'));
    await frames(3);
    const free = await evaluate(() => {
        const out = { mode: loadout.mode(), empty: document.querySelectorAll('.weapon-slot.empty').length };
        tacticalDirector.toggleBuyMenu(true);
        out.labels = Array.from(document.querySelectorAll('#armory-grid .gun-card .buy-card-cost')).map((c) => c.textContent);
        tacticalDirector.toggleBuyMenu(false);
        const c0 = game.creds;
        tacticalDirector.purchaseItem('gun:odin');
        out.odin = [game.activeWeapon, game.weapons.rifle.gunId, game.creds === c0];
        tacticalDirector.purchaseItem('gun:marshal');
        out.marshal = [game.activeWeapon, game.weapons.sniper.gunId];
        switchWeapon('rifle');
        const seen = new Set();
        for (let i = 0; i < 10; i++) { cycleWeaponVariant(); seen.add(game.weapons.rifle.gunId); }
        out.cycled = seen.size;
        return out;
    });
    assert.deepEqual([free.mode, free.empty], ['free', 0]);
    assert.ok(free.labels.length === 18 && free.labels.every((t) => t === 'FREE' || t === 'EQUIPPED'), 'the weapon picker: every gun free');
    assert.deepEqual(free.odin, ['rifle', 'odin', true]);
    assert.deepEqual(free.marshal, ['sniper', 'marshal']);
    assert.equal(free.cycled, 10, '[V] cycles all 10 primaries');

    // Spike Rush: the round's gun only
    await evaluate(() => tacticalDirector.setGameMode('spikerush'));
    await frames(3);
    const rush = await evaluate(() => {
        const g = spikeRush.gun;
        tacticalDirector.purchaseItem(g[1] === 'vandal' ? 'gun:odin' : 'gun:vandal');
        cycleWeaponVariant();
        const w = game.weapons[g[0]];
        return { mode: loadout.mode(), kept: w.gunId === g[1] };
    });
    assert.deepEqual(rush, { mode: 'locked', kept: true });
    const [programs, watermark] = await programState(page);
    assert.equal(programs, watermark);
    assert.deepEqual(errors, []);
});
