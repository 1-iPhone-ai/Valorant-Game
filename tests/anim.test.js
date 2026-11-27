'use strict';
// V2.2 Enhanced Animations (Settings > Video & Quality, off by default)
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { boot, closeBrowser, programState } = require('./harness');

after(closeBrowser);

const onPill = (evaluate, on) => evaluate((on) => document.querySelector(`#setting-anim-detail-pills [data-animdetail="${on ? 'on' : 'off'}"]`).click(), on);

test('Enhanced Animations is off by default: nothing of it is built and no shader program is added', { timeout: 240000 }, async () => {
    const { page, errors, frames, evaluate } = await boot();
    await frames(5);
    const s = await evaluate(() => {
        const pages = [];
        for (const c of enemyChunks.values()) for (const pg of c.pages) pages.push(pg);
        return {
            setting: game.userSettings.animDetail,
            pill: document.querySelector('#setting-anim-detail-pills .active').dataset.animdetail,
            on: enhancedAnim.on, built: enhancedAnim.built, uniform: enemyAnimUniforms.uAnimDetail.value,
            pages: pages.length,
            pageExtras: pages.some((pg) => pg.meshes.some((m) => m.geometry.attributes.instanceAnim2 || m.geometry.attributes.aBone)),
            bones: enemyPartSpecs.some((spec) => !!spec.geometry.attributes.aBone),
            rigs: enhancedAnim.wingRigs.length,
            wingmenPlain: tacticalEnhancements.wingmanBots.every((b) => b.group.children.filter((c) => c.isGroup).length === 1),
            botState: enemyObjects.some((e) => e.eaV),
            actions: enemyObjects.every((e) => e.animAction === null && e.animActionAt === 0)
        };
    });
    assert.deepEqual(s, { setting: 'off', pill: 'off', on: false, built: false, uniform: 0, pages: s.pages, pageExtras: false, bones: false, rigs: 0, wingmenPlain: true, botState: false, actions: true });
    assert.ok(s.pages > 0, 'some bots are drawn');
    const [programs, watermark, stalls] = await programState(page);
    assert.equal(programs, watermark, 'no shader programs after the warm-up');
    assert.equal(stalls, 0);
    assert.deepEqual(errors, []);
});

// The classic (off) path of the bot shader must draw exactly what V2.1 drew. The same posed bots (several
// walk phases, a flinch, a recoil) are drawn alone, in both looks (box and High Detail figures), in this
// build and in a boot of V2.1: the pixels must be identical. In this build the same frame is also drawn
// with V2.1's own shader code (taken from the V2.1 file, compiled as a second material): identical too.
// V2.2 final check: V2.1 drew each bot with its back to where the AI turns it (the figure is built facing -Z,
// the AI turns a bot's +Z to its target); this build draws it half a turn round, facing its target. So the
// V2.1 boot's bots are turned half a turn (turn: π) to draw what this build draws.
const SHOOT = ({ v21Src, turn }) => {
    window.updateEnemies = () => {};
    if (tacticalEnhancements.wingmanEnabled) tacticalEnhancements.toggleWingmanAI(false);
    while (enemyObjects.length < 5) createEnemyActor('standard');
    // phase, stride, flinch, recoil
    const poses = [[0.0, 0.0, 0, 0], [1.2, 0.9, 0, 0], [2.6, 1.0, 0, 0], [4.4, 0.6, 0.8, 0], [5.6, 0.3, 0, 1]];
    const cam = new THREE.PerspectiveCamera(42, 480 / 270, 0.1, 100);
    cam.position.set(-10.8, 1.5, 8.5); cam.lookAt(-10.8, 1.0, 2); cam.updateMatrixWorld();
    const shot = () => {
        // A new render frame: r128 uploads changed geometry attributes (the bots' animation values, a
        // swapped shape) once per info frame, and the game resets info itself each frame
        renderer.info.reset();
        renderer.setRenderTarget(null); renderer.setClearColor(0, 1); renderer.clear(); renderer.render(scene, cam);
        const gl = renderer.getContext(), px = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
        gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return px;
    };
    const theirs = v21Src ? (() => {
        const install = new Function('THREE', v21Src + '\nreturn installEnemyAnimation;')(THREE);
        return enemyPartMaterials.map((m, p) => { const o = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.3 }); install(o, p); return o; });
    })() : null;
    const b64 = (px) => { let s = ''; for (let i = 0; i < px.length; i += 8192) s += String.fromCharCode.apply(null, px.subarray(i, i + 8192)); return btoa(s); };
    const look = () => {
        for (let i = 0; i < 5; i++) {
            const e = enemyObjects[i];
            activateEnemy(e, -14 + i * 1.6, 0, 2, 'standard');
            e.mesh.rotation.set(0, 0.5 - i * 0.25 + turn, 0);
            [e.animPhase, e.animAmt, e.animFlinch, e.animRecoil] = poses[i];
            e.poseDirty = true;
        }
        for (let i = 5; i < enemyObjects.length; i++) { const e = enemyObjects[i]; e.isActive = false; e.hit = true; e.renderActive = false; e.mesh.visible = false; }
        packEnemyBatches();
        // Only the bots and the lights; no muzzle-flash light left on; the shadow map of just them
        const meshes = [];
        for (const c of enemyChunks.values()) for (const pg of c.pages) pg.meshes.forEach((m, p) => meshes.push([m, p]));
        const keep = new Set(meshes.map((x) => x[0])), hidden = [];
        for (const o of scene.children) if (!keep.has(o) && !o.isLight && o.visible) { hidden.push(o); o.visible = false; }
        for (const f of enemyFlashLights) f.object.visible = false;
        shadowManager.markEvent(); shadowManager.beforeRender(performance.now() + 1e5);
        const mine = shot();
        let v21diff = null;
        if (theirs) {
            for (const [m, p] of meshes) m.material = theirs[p];
            const px = shot();
            for (const [m, p] of meshes) m.material = enemyPartMaterials[p];
            v21diff = 0;
            for (let i = 0; i < mine.length; i++) if (mine[i] !== px[i]) v21diff++;
        }
        for (const [m] of meshes) m.visible = false;
        const none = shot();
        for (const [m] of meshes) m.visible = true;
        for (const o of hidden) o.visible = true;
        let bot = 0;
        for (let i = 0; i < mine.length; i += 4) if (mine[i] !== none[i] || mine[i + 1] !== none[i + 1] || mine[i + 2] !== none[i + 2]) bot++;
        return { px: b64(mine), bot, v21diff };
    };
    const out = { classic: look() };
    game.userSettings.charDetail = 'on'; applyVisualOverrides();
    out.detailed = look();
    out.uniform = typeof enemyAnimUniforms.uAnimDetail === 'undefined' ? null : enemyAnimUniforms.uAnimDetail.value;
    return out;
};

test('off, bots draw exactly as V2.1 drew them turned to face their target (same posed bots in both looks; and against V2.1 shader code in the same frame)', { timeout: 400000 }, async () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', '(V2.1) valorant-fps.html'), 'utf8');
    const a = src.indexOf('function installEnemyAnimation(material, partIndex) {');
    const b = src.indexOf("material.customProgramCacheKey = () => 'enemyAnim';", a);
    assert.ok(a > 0 && b > a, 'V2.1 bot animation found');
    const v21Install = src.slice(a, b) + "material.customProgramCacheKey = () => 'enemyAnimV21';\n}";
    const mine = await boot({ quality: 'high' });
    const r = await mine.evaluate(SHOOT, { v21Src: v21Install, turn: 0 });
    assert.deepEqual(mine.errors, []);
    const v21 = await boot({ quality: 'high', file: '(V2.1) valorant-fps.html' });
    const old = await v21.evaluate(SHOOT, { v21Src: null, turn: Math.PI });
    assert.deepEqual(v21.errors, []);
    assert.equal(r.uniform, 0);
    for (const k of ['classic', 'detailed']) {
        assert.ok(r[k].bot > 3000 && old[k].bot > 3000, `${k}: the bots cover the picture (${r[k].bot} / ${old[k].bot} px)`);
        const x = Buffer.from(r[k].px, 'base64'), y = Buffer.from(old[k].px, 'base64');
        let diff = 0;
        for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) diff++;
        assert.equal(x.length, y.length);
        assert.equal(diff, 0, `${k}: identical to V2.1 (${diff} bytes differ)`);
        assert.equal(r[k].v21diff, 0, `${k}: identical to V2.1's shader code in the same frame (${r[k].v21diff} bytes differ)`);
    }
});

test('on: bots step, aim, gesture and react by zone; hit proxies and draw calls as off; switching compiles nothing', { timeout: 400000 }, async () => {
    const { page, errors, frames, evaluate } = await boot();
    await onPill(evaluate, true);
    await frames(3);
    const r = await evaluate(() => {
        window.updateEnemies = () => {};
        const out = {};
        out.saved = JSON.parse(localStorage.getItem('valorant_v16_user_settings') || '{}').animDetail;
        out.built = enhancedAnim.built && enemyAnimUniforms.uAnimDetail.value === 1;
        const P = characterController.position;
        P.set(-11, 1.7, 14); characterController.prevSimPosition.copy(P);
        const e = enemyObjects.find((x) => x.isActive && !x.hit);
        // A fresh bot at the courtyard, facing you (the AI faces +Z at you)
        const fresh = () => {
            e.generation++;
            activateEnemy(e, -11, 0, 4, 'standard');
            e.mesh.rotation.y = 0;
            e.hasSight = true;
            e.animAction = null;
            packEnemyBatches();
        };
        const step = (n, move) => { for (let i = 0; i < n; i++) { if (move) move(i); updateEnemyAnimation(1 / 60); gameTime += 1000 / 60; } packEnemyBatches(); };
        const slotVals = () => {
            const pg = e.page, s = pg.members.indexOf(e), g = pg.meshes[0].geometry.attributes;
            return [g.instanceAnim, g.instanceAnim2, g.instanceAnim3].map((a) => [a.getX(s), a.getY(s), a.getZ(s), a.getW(s)]);
        };
        const proxies = () => e.leaves.map((l) => { l.updateMatrixWorld(true); return Array.from(l.matrixWorld.elements).map((x) => +x.toFixed(6)).join(','); }).join('|');
        // The same moves with the setting off and on: hit proxies identical
        const scenario = (on) => {
            enhancedAnim.set(on);
            fresh();
            const rec = [];
            step(30, () => { e.mesh.position.x -= 3 / 60; });   // strafing
            rec.push(proxies());
            step(20, () => { e.mesh.rotation.y += 0.04; });     // turning on the spot
            rec.push(proxies());
            e.health = 1e4;
            damageEnemyActor(e, 1, performance.now(), Date.now(), 'Test', 'head');
            step(5);
            rec.push(proxies());
            return rec;
        };
        out.proxiesSame = JSON.stringify(scenario(false)) === JSON.stringify(scenario(true));
        // Strafing (to its right: the AI faces +Z, so its right is -X): a side step
        fresh();
        step(40, () => { e.mesh.position.x -= 3 / 60; });
        out.strafe = { walk: e.eaV[1], dir: e.eaV[2] };
        out.slot = slotVals();
        // Backwards
        fresh();
        step(40, () => { e.mesh.position.z -= 2.2 / 60; });
        out.back = e.eaV[2];
        // You on a 5 m deck above it: the aim pitch rises
        fresh();
        P.set(-11, 6.7, 9);
        step(40);
        out.aimUp = e.eaV[3];
        P.set(-11, 1.7, 14);
        // Turning on the spot shuffles the feet
        fresh();
        step(20, () => { e.mesh.rotation.y += 0.05; });
        out.turn = { walk: e.eaV[1], dir: e.eaV[2] };
        // Reload after a magazine of shots (looks only), a cast when its ability timer moves on
        fresh();
        for (let k = 0; k < enhancedAnim._mag(e); k++) { e.animRecoil = 1; step(30); }
        step(12);
        out.reload = { code: Math.floor(e.eaV[6] + 0.005), action: e.animAction };
        step(150);
        out.reloadDone = { code: e.eaV[6], action: e.animAction };
        fresh();
        e.nextAbilityAt = gameNow() + 5000; step(2);
        e.nextAbilityAt = gameNow() + 9000; step(15);
        out.cast = { code: Math.floor(e.eaV[6] + 0.005), action: e.animAction };
        // Defusing your planted spike (wave mode): the first bot within 4.2 m of it
        fresh();
        const td = tacticalDirector, was = [td.spikeState, td.activeSpikeSitePos.clone()];
        td.spikeState = 'planted'; td.activeSpikeSitePos.set(-11, 0, 5);
        step(30);
        out.defuse = { code: Math.floor(e.eaV[6] + 0.005), action: e.animAction, w: e.eaV[6] % 1 };
        td.spikeState = was[0]; td.activeSpikeSitePos.copy(was[1]);
        step(30);
        out.defuseDone = e.animAction;
        // Planting (a Match, the bots attacking): the bot on the site
        fresh();
        const mm = matchMode, keep = [mm.active, mm.phase, mm.side, mm.botPlantProgress, mm.plantSiteKey];
        const key = Object.keys(td.spikeSites)[0];
        Object.assign(mm, { active: true, phase: 'live', side: 'defend', botPlantProgress: 0.2, plantSiteKey: key });
        e.mesh.position.set(td.spikeSites[key].pos.x, 0, td.spikeSites[key].pos.z);
        step(30);
        out.plant = { code: Math.floor(e.eaV[6] + 0.005), action: e.animAction };
        [mm.active, mm.phase, mm.side, mm.botPlantProgress, mm.plantSiteKey] = keep;
        step(30);
        out.plantDone = e.animAction;
        // The map-mechanics moves: climbing a rope, pushing a door
        fresh();
        e.animAction = 'climb'; e.animActionAt = gameNow();
        step(20, () => { e.mesh.position.y += 0.2; });
        out.climb = { code: Math.floor(e.eaV[6] + 0.005), action: e.animAction, phase: e.eaV[7] };
        e.animAction = null; e.mesh.position.y = 0;
        fresh();
        e.animAction = 'push'; e.animActionAt = gameNow();
        step(20);
        out.push = { code: Math.floor(e.eaV[6] + 0.005), action: e.animAction };
        e.animAction = null;
        // Hit reactions by zone: the head snaps back, the legs buckle
        fresh();
        e.health = 1e4;
        damageEnemyActor(e, 1, performance.now(), Date.now(), 'Test', 'head');
        step(3);
        out.head = e.eaV[5];
        step(90);
        damageEnemyActor(e, 1, performance.now(), Date.now(), 'Test', 'legs');
        step(3);
        out.legs = e.eaV[5];
        // Breathing and weight shifts at rest: the idle phase moves on, and the slot with it
        fresh();
        step(10);
        const i0 = slotVals()[2][3];
        step(60);
        out.idle = [i0, slotVals()[2][3]];
        // A death falls away from the shot: shot from in front (you at +Z), it tips toward -Z
        fresh();
        e.health = 1; e.armor = 0;
        damageEnemyActor(e, 999, performance.now(), Date.now(), 'Test', 'torso');
        for (let i = 0; i < 40; i++) stepActorAnimations();
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(e.mesh.quaternion);
        out.fallFront = up.z;
        respawnEnemy(e);
        // ...and shot from behind (you at -Z), it tips toward +Z
        fresh();
        P.set(-11, 1.7, -6);
        e.health = 1; e.armor = 0;
        damageEnemyActor(e, 999, performance.now(), Date.now(), 'Test', 'torso');
        for (let i = 0; i < 40; i++) stepActorAnimations();
        out.fallBack = new THREE.Vector3(0, 1, 0).applyQuaternion(e.mesh.quaternion).z;
        P.set(-11, 1.7, 14);
        respawnEnemy(e);
        packEnemyBatches();
        // The plant / defuse bend is shallow: the head (the chain the shader poses, at full weight)
        // drops at most about 12 cm and stays over the feet, inside the 1.6-2.2 m head hit box
        const hv = new Float32Array(12);
        out.bendHead = [3, 4].map((code) => {
            hv[6] = code + 0.99; hv[7] = 2;
            const c = new THREE.Vector3(0, 1.93, 0).applyMatrix4(enhancedAnim._headMatrix(hv, new THREE.Matrix4()));
            return { drop: 1.93 - c.y, forward: -c.z };
        });
        return out;
    });
    assert.equal(r.saved, 'on', 'saved');
    assert.ok(r.built, 'built and switched on');
    assert.ok(r.proxiesSame, 'hit proxies are where they are with the setting off');
    assert.ok(r.strafe.walk > 0.5 && Math.abs(r.strafe.dir - Math.PI / 2) < 0.2, `strafing to its right: a side step (${JSON.stringify(r.strafe)})`);
    assert.ok(Math.abs(r.slot[1][0] - Math.PI / 2) < 0.2 && r.slot[0][1] > 0.5, 'the page slot carries the direction and the stride');
    assert.ok(Math.abs(Math.abs(r.back) - Math.PI) < 0.2, `walking backwards (${r.back})`);
    assert.ok(r.aimUp > 0.3, `aims up at you (${r.aimUp})`);
    assert.ok(r.turn.walk > 0.1 && Math.abs(Math.abs(r.turn.dir) - Math.PI / 2) < 0.01, `turning on the spot steps (${JSON.stringify(r.turn)})`);
    assert.deepEqual(r.reload, { code: 1, action: 'reload' });
    assert.deepEqual(r.reloadDone, { code: 0, action: null }, 'the reload ends and the action clears');
    assert.deepEqual(r.cast, { code: 2, action: 'cast' });
    assert.equal(r.defuse.code, 4); assert.equal(r.defuse.action, 'defuse'); assert.ok(r.defuse.w > 0.9);
    assert.equal(r.defuseDone, null);
    assert.deepEqual(r.plant, { code: 3, action: 'plant' });
    assert.equal(r.plantDone, null);
    assert.equal(r.climb.code, 5); assert.equal(r.climb.action, 'climb'); assert.ok(r.climb.phase > 1, 'hand over hand with the height climbed');
    assert.deepEqual(r.push, { code: 6, action: 'push' });
    assert.ok(r.head > 0.5, `head hit: the head snaps back (${r.head})`);
    assert.ok(r.legs < -0.5, `leg hit: the legs buckle (${r.legs})`);
    assert.ok(Math.abs(r.idle[1] - r.idle[0]) > 0.5, `idle breathing moves on (${r.idle})`);
    assert.ok(r.fallFront < -0.6, `shot from in front, it falls away from you (${r.fallFront})`);
    assert.ok(r.fallBack > 0.6, `shot from behind, it falls forwards, away from you (${r.fallBack})`);
    for (const h of r.bendHead) assert.ok(h.drop > 0.03 && h.drop <= 0.12 && h.forward < 0.15, `a shallow bend: the head drops ${h.drop.toFixed(3)} m, ${h.forward.toFixed(3)} m forward`);

    // Draw calls: bots and wingmen, off and on (the same pages and as many wingman meshes)
    const calls = await evaluate(() => {
        const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 200);
        cam.position.set(-11, 6, 20); cam.lookAt(-11, 0, 4); cam.updateMatrixWorld();
        const te = tacticalEnhancements;
        if (!te.wingmanEnabled) te.toggleWingmanAI(true);
        te.wingmanGroup.visible = true;
        te.wingmanBots.forEach((b, i) => b.group.position.set(-13 + i * 4, 0, 8));
        const count = (on, what) => {
            enhancedAnim.set(on);
            for (const e of enemyObjects) e.poseDirty = true;
            packEnemyBatches();
            const keep = new Set();
            if (what === 'bots') { for (const c of enemyChunks.values()) for (const pg of c.pages) for (const m of pg.meshes) keep.add(m); }
            else keep.add(te.wingmanGroup);
            const hidden = [];
            for (const o of scene.children) if (!keep.has(o) && !o.isLight && o.visible) { hidden.push(o); o.visible = false; }
            renderer.info.reset();
            renderer.setRenderTarget(null); renderer.clear(); renderer.render(scene, cam);
            const n = renderer.info.render.calls;
            for (const o of hidden) o.visible = true;
            return n;
        };
        return { botsOff: count(false, 'bots'), botsOn: count(true, 'bots'), wingOff: count(false, 'wing'), wingOn: count(true, 'wing') };
    });
    assert.ok(calls.botsOff > 0 && calls.wingOff > 0, JSON.stringify(calls));
    assert.equal(calls.botsOn, calls.botsOff, 'bots: one draw per part per page either way');
    assert.equal(calls.wingOn, calls.wingOff, 'wingmen: as many draws either way');

    // Switching on and off mid-game compiles nothing
    for (const on of [false, true, false, true]) {
        await onPill(evaluate, on);
        await frames(4);
    }
    const [programs, watermark, stalls] = await programState(page);
    assert.equal(programs, watermark, 'no new shader programs');
    assert.equal(stalls, 0);
    assert.deepEqual(errors, []);
});

// Steps the viewmodel animator by hand (synchronously): base placement, offsets, the gun pose
const VM = `
    window.__vm = (t0, t1, sample) => {
        const out = [];
        for (let t = t0; t <= t1; t += 16) {
            applyWeaponBobbing(t, !!(game.keys.w || game.keys.a || game.keys.s || game.keys.d));
            if (sample) out.push(sample(t, game.weapons[game.activeWeapon].model));
        }
        return out;
    };
`;

test('first person on: no bob walking into a wall, a lift on a jump and a dip on landing, a reload per gun type back exactly to rest; off as before', { timeout: 400000 }, async () => {
    const { page, errors, evaluate } = await boot({ quality: 'medium' });
    await page.addScriptTag({ content: VM });
    const r = await evaluate(() => {
        window.updateEnemies = () => {};
        window.presentPlayerCamera = () => {};
        game.userSettings.infiniteAmmo = false;
        const out = {};
        const cc = characterController;
        // Walking into a wall: hold W into a wall for a second of steps, the gun's height over time
        const intoWall = () => {
            applyGunDef('vandal'); switchWeapon('rifle'); vmAnim.clip = null;
            cc.reset();
            // Ascent mid courtyard, half a metre from the nearest wall to the west, facing it (-X)
            const d = acoustics._dist(new THREE.Vector3(-11, 1.2, 4), new THREE.Vector3(-1, 0, 0), 30);
            out.wallAt = -11 - d;
            cc.position.set(-11 - d + cc.radius + 0.1, cc.standHeight, 4); cc.velocity.set(0, 0, 0); cc.grounded = true;
            camera.rotation.set(0, Math.PI / 2, 0, 'YXZ');
            camera.position.copy(cc.position);
            let t = performance.now() + 2000;
            __vm(t - 600, t);
            game.keys.w = true;
            const ys = [], xs = [];
            for (let i = 0; i < 60; i++) {
                cc.update(1 / 60);
                camera.position.copy(cc.position);
                t += 16;
                __vm(t, t, (tt, m) => { ys.push(m.position.y); xs.push(cc.position.x); });
            }
            game.keys.w = false;
            const span = (a) => Math.max(...a.slice(20)) - Math.min(...a.slice(20));
            return { gunSpan: span(ys), moved: span(xs) };
        };
        // A jump and a landing: the recoil spring's height shortly after each
        const jumpLand = () => {
            let t = performance.now() + 6000;
            cc.grounded = true; cc.velocity.set(0, 0, 0);
            __vm(t - 1200, t);
            cc.grounded = false; cc.velocity.y = cc.jumpForce;
            let lift = 0, dip = 0;
            __vm(t, t + 100, () => { lift = Math.max(lift, vmAnim.sp.y); });
            cc.velocity.y = -0.42;
            __vm(t + 116, t + 300);
            cc.grounded = true; cc.velocity.y = 0;
            __vm(t + 316, t + 420, () => { dip = Math.min(dip, vmAnim.sp.y); });
            __vm(t + 436, t + 1600);
            return { lift, dip };
        };
        // A full reload of each gun type: its path, and where everything ends up
        const reloads = () => {
            const res = {};
            for (const [gun, slot] of [['vandal', 'rifle'], ['spectre', 'rifle'], ['bucky', 'rifle'], ['classic', 'pistol'], ['operator', 'sniper']]) {
                applyGunDef(gun); switchWeapon(slot); vmAnim.clip = null;
                const w = game.weapons[slot];
                let t = performance.now() + 20000;
                __vm(t - 1500, t);
                w.ammo = 1; game.reloading = false;
                reload();
                vmAnim.clip.start = t;
                const dur = vmAnim.clip.dur;
                const path = [];
                __vm(t, t + dur + 400, (tt) => {
                    const p = (tt - t) / dur;
                    if (p > 0 && p < 1 && Math.round(p * 100) % 10 === 0) path.push([vmAnim.last.rz, vmAnim.last.ry, vmAnim.last.rx, vmAnim.last.py, vmAnim.last.pz].map((x) => +x.toFixed(3)));
                });
                __vm(t + dur + 416, t + dur + 1600);   // springs settle
                const L = vmAnim.last, B = enhancedAnim.on ? eaFP.breath : { py: 0, rx: 0 };
                res[gun] = {
                    cls: enhancedAnim.on ? eaFP.gunClass(w) : null, path: JSON.stringify(path), clip: vmAnim.clip,
                    rest: Math.abs(L.px) + Math.abs(L.py - B.py) + Math.abs(L.pz) + Math.abs(L.rx - B.rx) + Math.abs(L.ry) + Math.abs(L.rz),
                    mag: w.magazine ? Math.abs(w.magazine.position.y - w.magRestY) + (w.magazine.visible ? 0 : 1) : 0,
                    slide: w.slide ? Math.abs(w.slide.position.z - w.slideRestZ) : 0
                };
                game.reloading = false;
            }
            applyGunDef('vandal'); switchWeapon('rifle'); vmAnim.clip = null;
            return res;
        };
        out.off = { wall: intoWall(), jump: jumpLand(), reloads: reloads() };
        enhancedAnim.set(true);
        out.on = { wall: intoWall(), jump: jumpLand(), reloads: reloads() };
        // Breathing at rest: the gun moves a little with nothing else going on
        let t = performance.now() + 40000;
        __vm(t - 3000, t);
        const bys = [];
        __vm(t, t + 2000, (tt, m) => bys.push(m.position.y));
        out.on.breathe = Math.max(...bys) - Math.min(...bys);
        // Your body: side steps spread the legs, walking backwards still swings them, they tuck up
        // in the air and the body squashes on landing
        const pb = playerBody, step = cc.terminalSpeed(cc.walkSpeed * (cc.speedMultiplier || 1));
        const walkBody = (dx, dz, n, sample) => { for (let i = 0; i < n; i++) { camera.position.x += dx; camera.position.z += dz; pb.update(1 / 60); if (sample) sample(); } };
        camera.rotation.set(0, 0, 0, 'YXZ'); camera.position.set(-11, 1.7, 4); pb.lastX = -11; pb.lastZ = 4;
        cc.grounded = true; cc.height = 1.7; cc.velocity.set(0, 0, 0);
        let spread = 0;
        walkBody(step, 0, 50, () => { spread = Math.max(spread, pb.legs[1].rotation.z, -pb.legs[0].rotation.z); });
        out.body = { spread };
        walkBody(0, 0, 40);
        let swing = 0;
        walkBody(0, step, 50, () => { swing = Math.max(swing, Math.abs(pb.legs[0].rotation.x)); });
        out.body.back = { fwd: eaBody.fwd, swing };
        cc.grounded = false; cc.velocity.y = -0.4;
        walkBody(0, 0, 30);
        out.body.air = [pb.legs[0].rotation.x, pb.legs[1].rotation.x];
        cc.grounded = true; cc.velocity.y = 0;
        walkBody(0, 0, 2);
        out.body.land = { land: eaBody.land, scale: pb.group.scale.y };
        walkBody(0, 0, 90);
        out.body.after = { scale: pb.group.scale.y, z: [pb.legs[0].rotation.z, pb.legs[1].rotation.z] };
        enhancedAnim.set(false);
        walkBody(0, 0, 2);
        out.body.off = [pb.legs[0].rotation.z, pb.legs[1].rotation.z, eaBody.used];
        return out;
    });
    // Off: as before (the key-driven bob bobs even into a wall; the classic reload)
    assert.ok(r.off.wall.moved < 0.01, `pressed into the wall (${r.off.wall.moved})`);
    assert.ok(r.off.wall.gunSpan > 0.004, `off: the classic bob follows the keys (${r.off.wall.gunSpan})`);
    assert.ok(r.off.jump.lift < 0.002, `off: no jump lift (${r.off.jump.lift})`);
    // On
    assert.ok(r.on.wall.moved < 0.01);
    assert.ok(r.on.wall.gunSpan < 0.0015, `on: no bob walking into a wall (${r.on.wall.gunSpan})`);
    assert.ok(r.on.jump.lift > 0.01, `on: the gun lifts on a jump (${r.on.jump.lift})`);
    assert.ok(r.on.jump.dip < -0.01, `on: and dips on landing (${r.on.jump.dip})`);
    assert.ok(r.on.breathe > 0.001 && r.on.breathe < 0.01, `on: breathing at rest (${r.on.breathe})`);
    const classes = Object.values(r.on.reloads).map((x) => x.cls);
    assert.deepEqual(classes, ['rifle', 'smg', 'shotgun', 'pistol', 'sniper']);
    const paths = new Set(Object.values(r.on.reloads).map((x) => x.path));
    assert.equal(paths.size, 5, 'each gun type reloads its own way');
    for (const [gun, x] of Object.entries(r.on.reloads)) {
        assert.equal(x.clip, null, `${gun}: the reload ends`);
        assert.ok(x.rest < 1e-6, `${gun}: back exactly at rest (${x.rest})`);
        assert.ok(x.mag < 1e-9 && x.slide < 1e-9, `${gun}: magazine and slide back in place`);
        assert.notEqual(x.path, r.off.reloads[gun].path, `${gun}: not the classic reload`);
    }
    // Off: every gun has the one classic reload shape (bar its bolt / slide / handle accents) and is back at rest
    for (const [gun, x] of Object.entries(r.off.reloads)) assert.ok(x.rest < 1e-6 && x.mag < 1e-9, `off ${gun}: back at rest`);
    // Your body
    assert.ok(r.body.spread > 0.05, `side steps spread the legs (${r.body.spread})`);
    assert.ok(r.body.back.fwd < -0.5 && r.body.back.swing > 0.2, `walking backwards swings the legs (${JSON.stringify(r.body.back)})`);
    assert.ok(r.body.air[0] > 0.3 && r.body.air[1] > 0.2, `legs tuck up in the air (${r.body.air})`);
    assert.ok(r.body.land.land > 0.5 && r.body.land.scale < 0.97, `a landing squashes the body (${JSON.stringify(r.body.land)})`);
    assert.ok(Math.abs(r.body.after.scale - 1) < 1e-3 && Math.abs(r.body.after.z[0]) < 1e-3, 'then stands as before');
    assert.deepEqual(r.body.off, [0, 0, false], 'off again: the classic legs');
    const [programs, watermark, stalls] = await programState(page);
    assert.equal(programs, watermark, 'no new shader programs');
    assert.equal(stalls, 0);
    assert.deepEqual(errors, []);
});

test('kill cam with Enhanced Animations on plays back the recorded values (a reload recorded earlier), then the live ones', { timeout: 400000 }, async () => {
    const { page, errors, frames, evaluate } = await boot({ quality: 'medium' });
    await onPill(evaluate, true);
    await evaluate(() => {
        window.updateEnemies = () => {};
        const e = enemyObjects.find((x) => x.isActive && !x.hit);
        window.__k = e;
        const p = characterController.position;
        e.mesh.position.set(p.x + 4, 0, p.z - 7);
        e.poseDirty = true;
        // A long reload gesture while the recorder runs
        if (!e.eaV) enhancedAnim._initState(e, e.mesh, e.slot);
        enhancedAnim._oneShot(e, 1, 2.5);
    });
    // The moment to play back: a recorder capture well inside the reload, so the captures either side of
    // it both hold the reload and the new values. (Taken just as the reload starts, the capture before
    // it can be one from before Enhanced Animations went on, and a replay frame between a capture
    // without the new values and one with them draws the classic pose: CI caught that on a fast runner.)
    await page.waitForFunction(() => __k.eaGCode === 1 && __k.eaGT > 0.6 && replayRec.count > 6, null, { timeout: 60000 });
    const rec = await evaluate(() => { const R = replayRec, i = (R.head - 1 + R.N) % R.N; return { t: R.t[i], on: R.eaOn[i], code: __k.eaGCode }; });
    assert.equal(rec.on, 1, 'the capture played back holds the new values');
    await page.waitForFunction(() => __k.eaGCode === 0, null, { timeout: 60000 });
    await frames(5);
    const death = await evaluate(() => {
        game.shield = 0;
        for (let i = 0; i < 6; i++) takeDamage(25, __k.mesh.position, { enemy: __k });
        return { health: game.health, pending: !!replayDirector.pending, frames: replayRec.eaOn ? replayRec.eaOn.reduce((a, b) => a + b, 0) : 0 };
    });
    assert.equal(death.health, 0);
    assert.ok(death.pending, 'kill cam queued');
    assert.ok(death.frames > 10, `the new values were recorded (${death.frames} frames)`);
    await page.waitForFunction(() => !!replayDirector.clip, null, { timeout: 30000 });
    const mid = await evaluate((t) => {
        const k = __k, slot = () => { const pg = k.page, s = pg.members.indexOf(k), a = pg.meshes[0].geometry.attributes; return [a.instanceAnim3.getX(s), a.instanceAnim2.getY(s)]; };
        // One replay frame at the moment the reload was recorded
        replayDirector.pt = t;
        replayDirector.lastReal = performance.now();
        replayDirector.beginFrame(performance.now());
        const during = slot();
        const recorded = Array.from(k.eaRep);
        replayDirector.endFrame();
        packEnemyBatches();
        const live = slot();
        return { during, recorded, live, liveCode: k.eaV[6], repOn: k.eaRepOn };
    }, rec.t);
    assert.equal(Math.floor(mid.during[0] + 0.005), 1, `the replay draws the recorded reload (${mid.during})`);
    assert.ok(Math.abs(mid.during[0] - mid.recorded[6]) < 1e-6, 'from the recording');
    assert.equal(mid.liveCode, 0);
    assert.equal(Math.floor(mid.live[0] + 0.005), 0, 'after the frame the live values are back');
    assert.equal(mid.repOn, false);
    await evaluate(() => replayDirector.skip());
    await page.waitForFunction(() => !replayDirector.clip, null, { timeout: 20000 });
    const [programs, watermark, stalls] = await programState(page);
    assert.equal(programs, watermark);
    assert.equal(stalls, 0);
    assert.deepEqual(errors, []);
});
