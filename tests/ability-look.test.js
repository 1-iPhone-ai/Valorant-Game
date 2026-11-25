'use strict';
// V2.0: Settings > Video & Quality > Ability Effects (Auto / Classic / High Fidelity) and the
// High Fidelity look of the ten proof abilities (abilityLook)
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser, programState } = require('./harness');

after(closeBrowser);

// The ten proof abilities and the renderer that draws each part (key>renderer, logged on bind)
const PROOF = [
    ['omen', 'e', ['omen.e>projectile', 'omen.e>smoke']],
    ['sage', 'c', ['sage.c>wall']],
    ['phoenix', 'c', ['phoenix.c>projectile', 'phoenix.c>groundZone']],
    ['sova', 'q', ['sova.q>projectile', 'sova.q>blast']],
    ['raze', 'e', ['raze.e>projectile', 'raze.e>blast']],
    ['phoenix', 'q', ['phoenix.q>projectile', 'phoenix.q>flash']],
    ['sova', 'x', ['sova.x>beam']],
    ['breach', 'e', ['breach.e>pulse']],
    ['killjoy', 'e', ['killjoy.e>deployable']],
    ['jett', 'e', ['jett.e>self']]
];

// Cast one ability from a fixed spot and aim (X: the ultimate is switched on first, a second X fires)
const cast = (evaluate, agent, slot) => evaluate(([agent, slot]) => {
    try {
        agentSystem.selectAgent(agent);
        game.ultActiveUntil = 0;
        game.ultAgent = null;
        characterController.position.set(0, 1.7, 22);
        characterController.prevSimPosition.copy(characterController.position);
        camera.position.copy(characterController.position);   // casts start at the camera, which follows the player next frame
        camera.rotation.set(-0.3, 0, 0, 'YXZ');
        if (slot === 'x') { game.ultPoints = game.maxUltPoints; agentSystem.castAbility('x'); }
        agentSystem.castAbility(slot);
        return null;
    } catch (e) { return e.message; }
}, [agent, slot]);

// Log every binding (key>renderer) and keep the casts from running out
const instrument = (evaluate) => evaluate(() => {
    game.userSettings.infiniteAbilities = true;
    game.userSettings.infiniteUlt = true;
    window.__bound = new Set();
    const bind = abilityLook.bind;
    abilityLook.bind = function (it, kind, key, now) {
        const b = bind.call(this, it, kind, key, now);
        if (b) __bound.add(key + '>' + this.route(kind, key));
        return b;
    };
});

test('Ability Effects: both defaults, older saves load as Auto, Auto follows Ultra Realism, the toggle overrides it, Low and no WebGL 2 use Classic', { timeout: 600000 }, async () => {
    // A save from before V2.0 (no abilityEffects key)
    const { page, errors, frames, evaluate } = await boot({
        quality: 'medium',
        initScript: () => {
            try {
                localStorage.setItem('valorant_v16_ls_consent', 'true');
                localStorage.setItem('valorant_v16_user_settings', JSON.stringify({ localStorageEnabled: true, glowHalos: false }));
            } catch (e) {}
        }
    });
    const st = () => evaluate(() => ({
        setting: game.userSettings.abilityEffects, mode: abilityLook.mode, wanted: abilityLook.wanted, state: abilityLook.state,
        status: document.getElementById('setting-abilityfx-status').textContent,
        pill: (document.querySelector('#setting-abilityfx-pills .active') || {}).textContent
    }));
    const pick = (v) => evaluate((v) => document.querySelector(`#setting-abilityfx-pills [data-abilityfx="${v}"]`).click(), v);
    const r0 = await evaluate(() => ({
        defaults: [game.userSettings.abilityEffects, DEFAULT_USER_SETTINGS.abilityEffects],
        loadedSave: game.userSettings.glowHalos,
        pills: [...document.querySelectorAll('#setting-abilityfx-pills [data-abilityfx]')].map((b) => b.getAttribute('data-abilityfx') + ':' + b.textContent.trim()),
        built: !!abilityLook.root, programs: renderer.info.programs.length, watermark: perfTelemetry.programWatermark
    }));
    assert.deepEqual(r0.defaults, ['auto', 'auto'], 'Auto in both defaults blocks; an older save gets it');
    assert.equal(r0.loadedSave, false, 'the older save itself still loads');
    assert.deepEqual(r0.pills, ['auto:AUTO', 'classic:CLASSIC', 'hifi:HIGH FIDELITY']);
    assert.equal(r0.built, false, 'Classic builds nothing');
    assert.equal(r0.programs, r0.watermark);
    await evaluate(() => settingsManager.syncAllUI());
    assert.deepEqual(await st(), { setting: 'auto', mode: 'classic', wanted: 'classic', state: 'idle', status: 'CLASSIC', pill: 'AUTO' }, 'Auto outside Ultra Realism is Classic');

    // High Fidelity: built in small steps, then drawn; saved
    await pick('hifi');
    await page.waitForFunction(() => abilityLook.mode === 'hifi', null, { timeout: 120000 });
    let s = await st();
    assert.equal(s.setting, 'hifi');
    assert.equal(s.pill, 'HIGH FIDELITY');
    assert.match(s.status, /^HIGH FIDELITY/);
    assert.equal(await evaluate(() => JSON.parse(localStorage.getItem('valorant_v16_user_settings')).abilityEffects), 'hifi');
    // Low quality always uses Classic (and says why); back on Medium it is High Fidelity again
    await evaluate(() => setQualitySettings('low'));
    await frames(3);
    s = await st();
    assert.equal(s.mode, 'classic');
    assert.equal(s.status, 'LOW QUALITY: USES CLASSIC');
    await evaluate(() => setQualitySettings('medium'));
    await frames(3);
    assert.equal((await st()).mode, 'hifi');
    // A browser without WebGL 2 falls back to Classic and the panel says so
    await evaluate(() => { abilityLook.forceUnsupported = true; abilityLook.refresh(); });
    s = await st();
    assert.equal(s.mode, 'classic');
    assert.equal(s.status, 'NOT AVAILABLE (NEEDS WEBGL 2): USES CLASSIC');
    await evaluate(() => { abilityLook.forceUnsupported = false; abilityLook.refresh(); });
    assert.equal((await st()).mode, 'hifi');

    // Auto: Classic on Medium, High Fidelity in Ultra Realism; Classic overrides it there
    await pick('auto');
    s = await st();
    assert.deepEqual([s.setting, s.mode, s.status], ['auto', 'classic', 'CLASSIC']);
    await evaluate(() => setQualitySettings('ultraRealism'));
    await frames(4);
    s = await st();
    assert.equal(await evaluate(() => ultraRealism.active), true);
    assert.deepEqual([s.setting, s.mode], ['auto', 'hifi'], 'Auto picks High Fidelity in Ultra Realism');
    await pick('classic');
    s = await st();
    assert.deepEqual([s.setting, s.mode, s.status], ['classic', 'classic', 'CLASSIC'], 'the toggle overrides Auto');
    await pick('hifi');
    await frames(3);
    assert.equal((await st()).mode, 'hifi');
    const [programs, watermark, stalls] = await programState(page);
    assert.equal(programs, watermark, 'no shader compiled outside the warm steps');
    assert.equal(stalls, 0);
    assert.deepEqual(errors, []);
});

test('Classic builds and compiles nothing; High Fidelity draws the ten proof abilities, hides only their Classic look, compiles nothing in play and switches back cleanly', { timeout: 900000 }, async () => {
    const { page, errors, frames, evaluate } = await boot({ quality: 'medium' });
    await instrument(evaluate);
    const waitBound = async (keys) => {
        await page.waitForFunction((keys) => keys.every((k) => __bound.has(k)), keys, { timeout: 45000, polling: 50 })
            .catch(() => {});
        return evaluate((keys) => keys.filter((k) => !__bound.has(k)), keys);
    };

    // Classic: every proof ability, nothing bound, nothing built, no new program
    for (const [agent, slot] of PROOF) {
        assert.equal(await cast(evaluate, agent, slot), null, `${agent}.${slot} casts`);
        await frames(4);
    }
    await frames(20);
    let r = await evaluate(() => ({ bound: [...__bound], built: !!abilityLook.root, state: abilityLook.state, programs: renderer.info.programs.length, watermark: perfTelemetry.programWatermark }));
    assert.deepEqual(r.bound, []);
    assert.equal(r.built, false);
    assert.equal(r.state, 'idle');
    assert.equal(r.programs, r.watermark, 'Classic compiles nothing new');

    // High Fidelity, switched on mid-match: the warm steps raise the watermark; play compiles nothing
    await evaluate(() => { game.userSettings.abilityEffects = 'hifi'; abilityLook.refresh(); });
    await page.waitForFunction(() => abilityLook.mode === 'hifi', null, { timeout: 120000 });
    const warmed = await evaluate(() => renderer.info.programs.length);
    // the ten converted abilities, each look tag (AGENT_TUNING's where it has one) served by a renderer
    const looks = await evaluate(() => Object.keys(abilityLook.CONVERTED).map((k) => [k, abilityLook.lookOf(k).length, abilityLook.lookOf(k).filter((t) => !abilityLook.R[t]).length]));
    assert.equal(looks.length, 10);
    for (const [k, n, missing] of looks) {
        assert.ok(n > 0, `${k} has look tags`);
        assert.equal(missing, 0, `${k}: every look tag has a renderer`);
    }
    const missing = [];
    for (const [agent, slot, keys] of PROOF) {
        assert.equal(await cast(evaluate, agent, slot), null, `${agent}.${slot} casts in High Fidelity`);
        missing.push(...(await waitBound(keys)));
    }
    assert.deepEqual(missing, [], 'every proof ability is drawn by its renderer');
    // All four flash items out (Paint Shells' clusters): a Curveball that pops then, and has its item
    // taken back before the next frame, is still drawn (a claimed burst is bound as it spawns)
    const reused = await evaluate(() => {
        __bound.delete('phoenix.q>flash');
        const A = agentSystem, now = gameNow();
        const burst = (tag, x, col) => { abilityLook.tag = tag; A.spawnFlashBurst(x, 1, 10, col, 5.5, 420, now); abilityLook.tag = null; };
        for (let k = 0; k < 4; k++) burst('raze.e', -6 + k * 3, 0xfb923c);
        burst('phoenix.q', 0, 0xffe066);
        burst('raze.e', 3, 0xfb923c);
        return __bound.has('phoenix.q>flash');
    });
    assert.equal(reused, true, 'a Curveball whose flash item is reused at once is still drawn');

    // Tailwind's wind wraps the off-hand on the existing cast gesture's own clock (driven directly, as cast.test does)
    const hand = await evaluate(() => {
        // no gesture still playing (a cast never cuts into an ultimate's, e.g. Sova's just above)
        if (castFX.active) { castFX.active = null; castFX.hide(); }
        agentSystem.selectAgent('jett');
        agentSystem.castAbility('e');
        const a = castFX.active;
        if (!a) return 'no cast gesture';
        abilityLook.update(a.start + 60, 0.016);
        let swirl = null;
        abilityLook.vmRoot.traverse((o) => { if (o.isMesh) swirl = o; });
        return { kind: a.kind, swirl: swirl.visible, onHand: swirl.position.distanceTo(castFX.core.position) < 1e-6, fade: swirl.material.uniforms.uFade.value > 0 };
    });
    assert.deepEqual(hand, { kind: 'cast', swirl: true, onHand: true, fade: true }, 'the wind swirl rides the cast gesture');

    // While bound, only that item's Classic materials are hidden; colliders and shot proxies stay
    r = await evaluate(() => {
        const out = { hiddenWhileBound: true, wallProxyIntact: true };
        const lists = agentSystem;
        for (const list of [lists.smokes, lists.mollies, lists.iceWalls, lists.kjTurrets]) {
            for (const it of list) {
                if (!(it._hf && it._hf.on)) continue;
                if (!it._hf.mats.every((m) => m.visible === false)) out.hiddenWhileBound = false;
            }
        }
        for (const w of agentSystem.iceWalls) if (w.inUse && (!w.shotPiece || w.shotPiece.proxy !== w.mesh || !w.collider)) out.wallProxyIntact = false;
        return out;
    });
    assert.deepEqual(r, { hiddenWhileBound: true, wallProxyIntact: true });

    // Abilities that are not converted yet keep their Classic look in High Fidelity, without errors
    for (const [agent, slot] of [['viper', 'e'], ['harbor', 'e'], ['neon', 'c'], ['astra', 'q'], ['cypher', 'c'], ['brimstone', 'e']]) {
        assert.equal(await cast(evaluate, agent, slot), null, `${agent}.${slot} casts in High Fidelity`);
        await frames(3);
    }
    await frames(30);
    r = await evaluate((warmed) => ({ programs: renderer.info.programs.length, watermark: perfTelemetry.programWatermark, warmed, stalls: perfTelemetry.firstUseStalls }), warmed);
    assert.equal(r.programs, r.warmed, 'no shader compiled while abilities played in High Fidelity');
    assert.equal(r.programs, r.watermark);
    assert.equal(r.stalls, 0);

    // Back to Classic at once: every Classic material visible, nothing High Fidelity drawn
    await evaluate(() => { game.userSettings.abilityEffects = 'classic'; abilityLook.refresh(); });
    await frames(2);
    r = await evaluate(() => {
        const A = agentSystem;
        let hidden = 0, bound = 0;
        for (const list of [A.projectiles, A.smokes, A.mollies, A.iceWalls, A.flashes, A.windRings, A.breachFaultLines, A.kjTurrets, tacticalDirector.botHazardsPool]) {
            for (const it of list) {
                for (const m of (it._hfMats || [])) if (!m.visible) hidden++;
                if (it._hf && it._hf.on) bound++;
            }
        }
        return { hidden, bound, root: abilityLook.root.visible, vm: abilityLook.vmRoot.visible, mode: abilityLook.mode };
    });
    assert.deepEqual(r, { hidden: 0, bound: 0, root: false, vm: false, mode: 'classic' });
    assert.deepEqual(errors, []);
});

test('gameplay is identical in both looks: smoke sight lines, wall shots and blocks, fire zone area; bots and the kill cam show High Fidelity', { timeout: 900000 }, async () => {
    const { page, errors, frames, evaluate } = await boot({ quality: 'medium' });
    await instrument(evaluate);
    await evaluate(() => { window.updateEnemies = () => {}; });   // the bots hold still
    // Sample the gameplay of a smoke, a wall and a fire zone placed the same way in each look
    const sample = (look) => evaluate((look) => {
        game.userSettings.abilityEffects = look;
        abilityLook.refresh();
        const A = agentSystem, now = gameNow();
        // expire what is out, through the normal update path
        for (const list of [A.smokes, A.mollies, A.iceWalls]) for (const it of list) if (it.inUse) it.expireAt = 1;
        return now;
    }, look).then(async () => {
        await frames(3);
        // an open stretch of the map: the player at (-40, 0) looking along +Z, nothing in the way for 40 m
        await evaluate(() => {
            const A = agentSystem, now = gameNow();
            A.spawnSmokeSphere(-36, 1.2, 14, 0x6d28d9, 4.6, 9000, now);
            A.spawnMollyZone(-45, 0, 10, now, false, false, false);
            agentSystem.selectAgent('sage');
            characterController.position.set(-40, 1.7, 0);
            characterController.prevSimPosition.copy(characterController.position);
            camera.position.copy(characterController.position);
            camera.rotation.set(-0.1, Math.PI, 0, 'YXZ');   // level enough that the wall goes 3.4 m ahead (looking down boosts you up on it)
            agentSystem.castAbility('c');
        });
        await frames(look === 'hifi' ? 8 : 4);
        return evaluate(() => {
            const A = agentSystem;
            const smoke = A.smokes.find((s) => s.inUse);
            const wall = A.iceWalls.find((w) => w.inUse);
            const molly = A.mollies.find((m) => m.inUse);
            // sight lines across the smoke (a 9 x 5 fan from two eyes)
            const sight = [];
            for (const o of [new THREE.Vector3(-40, 1.6, 2), new THREE.Vector3(-30, 1.6, 4)]) {
                for (let i = 0; i < 9; i++) for (let j = 0; j < 5; j++) {
                    const t = new THREE.Vector3(-42 + i * 1.5, 0.2 + j * 0.6, 26);
                    sight.push(A.isBlockedBySmoke(o, t) ? 1 : 0);
                }
            }
            // bullets at the wall from the player's side, across its width and past both ends: what is hit first, and where
            // (the shot index exact-tests with the game's own raycaster, as a bullet does)
            const shots = [];
            const ray = raycaster.ray, savedO = ray.origin.clone(), savedD = ray.direction.clone(), savedFar = raycaster.far;
            const wc = wall.collider, midX = (wc.minX + wc.maxX) / 2, midY = (wc.minY + wc.maxY) / 2;
            for (let i = 0; i < 7; i++) {
                ray.origin.set(midX - 3 + i, midY, wc.minZ - 3);
                ray.direction.set(0, 0, 1);
                raycaster.far = 40;
                _shotHits.length = 0;
                envShotIndex.raycast(ray, 40);
                _shotHits.sort(compareHitDistance);
                const h = _shotHits[0];
                shots.push(h ? [h.object === wall.mesh, +h.distance.toFixed(3)] : null);
                _shotHits.length = 0;
            }
            ray.origin.copy(savedO); ray.direction.copy(savedD); raycaster.far = savedFar;
            const c = wall.collider;
            return {
                bound: abilityLook.mode === 'hifi' ? [!!(smoke._hf && smoke._hf.on), !!(wall._hf && wall._hf.on), !!(molly._hf && molly._hf.on)] : null,
                smoke: [smoke.position.toArray().map((v) => +v.toFixed(3)), smoke.radius],
                sight,
                shots,
                wall: [c.minX, c.maxX, c.minY, c.maxY, c.minZ, c.maxZ].map((v) => +v.toFixed(3)),
                fire: [molly.position.toArray().map((v) => +v.toFixed(3)), molly.radius]
            };
        });
    });
    const classic = await sample('classic');
    await evaluate(() => { game.userSettings.abilityEffects = 'hifi'; abilityLook.refresh(); });
    await page.waitForFunction(() => abilityLook.mode === 'hifi', null, { timeout: 120000 });
    const hifi = await sample('hifi');
    assert.deepEqual(hifi.bound, [true, true, true], 'High Fidelity draws all three');
    assert.ok(classic.sight.some((v) => v) && classic.sight.some((v) => !v), 'the fan crosses the smoke edge');
    assert.ok(classic.shots.some((h) => h && h[0]), 'shots reach the wall');
    for (const k of ['smoke', 'sight', 'shots', 'wall', 'fire']) assert.deepEqual(hifi[k], classic[k], `${k} is the same in both looks`);

    // A bot rusher's Tailwind dash and Curveball orb
    await evaluate(() => { tacticalDirector.setGameMode('wave'); });
    await frames(6);
    const bot = await evaluate(() => {
        const e = enemyObjects.find((x) => x.isActive && !x.hit && x.archetype === 'rusher') || enemyObjects.find((x) => x.isActive && !x.hit);
        if (!e) return 'no bot';
        const arch = e.archetype;
        e.archetype = 'rusher';
        game.botAbilityAI = true;
        e.nextAbilityAt = 1;
        tacticalDirector.lastBotAbilityCastAt = -1e9;
        tacticalDirector.tryCastBotAbility(e, gameNow(), 12, 0, 1, 1, 0);
        e.archetype = arch;
        // the dash leaves wind streaks along its path at once
        let streaks = 0;
        abilityLook.root.traverse((o) => { if (o.isMesh && o.visible && o.material.uniforms && o.material.uniforms.uMode && o.material.uniforms.uMode.value === 4) streaks++; });
        return streaks > 0 ? null : 'no wind streaks';
    });
    assert.equal(bot, null, 'the bot rusher dash draws High Fidelity wind');
    await page.waitForFunction(() => __bound.has('phoenix.q>flash'), null, { timeout: 30000 });

    // The kill cam replays the death with the High Fidelity smoke in view
    await evaluate(() => {
        window.updateEnemies = () => {};
        const e = enemyObjects.find((x) => x.isActive && !x.hit);
        window.__k = e;
        const p = characterController.position;
        e.mesh.position.set(p.x + 6, 0, p.z - 9);
        e.poseDirty = true;
        agentSystem.spawnSmokeSphere(p.x + 3, 1.2, p.z - 5, 0x6d28d9, 4.6, 20000, gameNow());
    });
    await page.waitForTimeout(3000);
    await evaluate(() => { game.shield = 0; for (let i = 0; i < 6; i++) takeDamage(25, __k.mesh.position, { enemy: __k }); });
    await page.waitForFunction(() => !!replayDirector.clip, null, { timeout: 30000 });
    await frames(3);
    const kc = await evaluate(() => {
        const s = agentSystem.smokes.find((x) => x.inUse && x.lookKey === 'omen.e');
        let drawn = 0;
        abilityLook.root.traverse((o) => { if (o.isMesh && o.visible) drawn++; });
        return { clip: replayDirector.clip && replayDirector.clip.kind, bound: !!(s && s._hf && s._hf.on), classicHidden: !!(s && s.outerMat.visible === false), drawn: drawn > 0, root: abilityLook.root.visible };
    });
    assert.deepEqual(kc, { clip: 'killcam', bound: true, classicHidden: true, drawn: true, root: true });
    const [programs, watermark] = await programState(page);
    assert.equal(programs, watermark);
    assert.deepEqual(errors, []);
});
