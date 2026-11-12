'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser, programState } = require('./harness');

after(closeBrowser);

// Spies on the AudioContext the game creates: every PannerNode (with the
// position it was given) and every low-pass filter used for wall occlusion.
async function instrumentAudio(evaluate) {
    return evaluate(() => {
        game.soundEnabled = true;
        const ctx = soundFX.ensureContext();
        window.__panners = [];
        window.__occlusionFilters = 0;
        const cp = ctx.createPanner.bind(ctx);
        ctx.createPanner = () => { const n = cp(); window.__panners.push(n); return n; };
        const cb = ctx.createBiquadFilter.bind(ctx);
        ctx.createBiquadFilter = () => {
            const n = cb();
            setTimeout(() => { if (n.type === 'lowpass' && Math.abs(n.frequency.value - 650) < 1) window.__occlusionFilters++; }, 0);
            return n;
        };
        return !!ctx;
    });
}

test('3D audio: panner routing, wall occlusion, listener tracking, enemy gunfire and footsteps', { timeout: 300000 }, async () => {
    const { page, errors, frames, evaluate } = await boot();
    assert.ok(await instrumentAudio(evaluate), 'AudioContext available');

    // A sound in the open: one panner at the source position, no occlusion filter
    const open = await evaluate(() => {
        characterController.position.set(0, 1.7, 30); characterController.prevSimPosition.copy(characterController.position);
        camera.position.set(0, 1.7, 30); camera.updateMatrixWorld();
        __panners.length = 0;
        soundFX.at(6, 1.5, 24, () => soundFX.enemyGunshot());
        const p = __panners[0];
        return { panners: __panners.length, x: p && p.positionX.value, z: p && p.positionZ.value, model: p && p.panningModel };
    });
    await page.waitForTimeout(50);
    assert.ok(open.panners >= 1, 'positional sound goes through a PannerNode');
    assert.equal(open.x, 6); assert.equal(open.z, 24);
    assert.equal(open.model, 'HRTF');
    assert.equal(await evaluate(() => __occlusionFilters), 0, 'no muffling with clear line of sight');

    // Behind the central tower (z -10..10 on Ascent): muffled
    await evaluate(() => { soundFX.at(0, 1.5, -20, () => soundFX.enemyGunshot()); });
    await page.waitForTimeout(50);
    assert.ok((await evaluate(() => __occlusionFilters)) >= 1, 'sound behind a wall is low-passed');

    // Setting OFF: plays without a panner
    const off = await evaluate(() => {
        game.userSettings.positionalAudio = false;
        __panners.length = 0;
        soundFX.at(6, 1.5, 24, () => soundFX.enemyGunshot());
        game.userSettings.positionalAudio = true;
        return __panners.length;
    });
    assert.equal(off, 0, '3D audio OFF bypasses the panner');

    // Listener follows the camera
    await frames(3);
    const l = await evaluate(() => ({ lx: soundFX.ctx.listener.positionX.value, lz: soundFX.ctx.listener.positionZ.value, cx: camera.position.x, cz: camera.position.z }));
    assert.ok(Math.abs(l.lx - l.cx) < 0.5 && Math.abs(l.lz - l.cz) < 0.5, 'listener tracks the camera');

    // Enemy gunfire is audible: enemyShoot plays a positional shot when it fires
    const shots = await evaluate(() => {
        window.__shots = 0;
        const o = soundFX.enemyGunshot.bind(soundFX);
        soundFX.enemyGunshot = () => { window.__shots++; return o(); };
        const e = enemyObjects.find((x) => x.isActive && !x.hit);
        game.gameMode = 'wave';
        for (let i = 0; i < 12 && window.__shots === 0; i++) {
            e.mesh.position.set(0, 0, 20);
            e.blindedUntil = 0;
            enemyShoot(e);
        }
        return window.__shots;
    });
    assert.ok(shots >= 1, 'enemy gunfire makes a sound');

    // Footsteps: an enemy walking within 22 m steps; one walking 40 m away does not
    const steps = await evaluate(() => {
        window.__steps = 0;
        const o = soundFX.enemyStep.bind(soundFX);
        soundFX.enemyStep = () => { window.__steps++; return o(); };
        return true;
    });
    assert.ok(steps);
    const walk = async (z) => {
        await evaluate(() => { window.__steps = 0; });
        for (let i = 0; i < 12; i++) {
            await evaluate(([z, i]) => {
                for (const e of enemyObjects) { if (e.isActive && !e.hit) { e.mesh.position.set(-8 + i * 0.6, 0, z); } }
            }, [z, i]);
            await frames(1);
        }
        return evaluate(() => window.__steps);
    };
    assert.ok((await walk(18)) >= 1, 'nearby enemies make footsteps');
    assert.equal(await walk(-45), 0, 'enemies beyond 22 m are silent');

    const [programs, watermark] = await programState(page);
    assert.equal(programs, watermark);
    assert.deepEqual(errors, []);
});

test('hit feedback: body tick, red kill marker, rumble, low-health warning', { timeout: 300000 }, async () => {
    const { errors, frames, evaluate } = await boot();
    const r = await evaluate(() => {
        game.soundEnabled = true;
        soundFX.ensureContext();
        const out = {};
        window.__ticks = []; window.__rumbles = 0;
        const t = soundFX.hitTick.bind(soundFX);
        soundFX.hitTick = (a) => { __ticks.push(a); return t(a); };
        gamepadController.rumble = () => { window.__rumbles++; };
        const e = enemyObjects.find((x) => x.isActive && !x.hit);
        e.armor = 0;
        damageEnemyActor(e, 10, performance.now(), Date.now(), 'Test', 'torso');
        out.tickBody = __ticks.slice();
        e.armor = 50;
        damageEnemyActor(e, 10, performance.now(), Date.now(), 'Test', 'torso');
        out.tickArmor = __ticks.slice();
        damageEnemyActor(e, 9999, performance.now(), Date.now(), 'Test', 'torso');
        out.killMarker = document.getElementById('hitmarker').classList.contains('kill');
        out.rumbles = __rumbles;
        return out;
    });
    assert.deepEqual(r.tickBody, [false], 'body hit plays the tick');
    assert.deepEqual(r.tickArmor, [false, true], 'armour hit plays the armour ping');
    assert.equal(r.killMarker, true, 'kill shows the red kill marker');
    assert.ok(r.rumbles >= 3, 'hits and the kill rumble the controller');

    await evaluate(() => {
        window.__beats = 0;
        const h = soundFX.heartbeat.bind(soundFX);
        soundFX.heartbeat = (u) => { window.__beats++; return h(u); };
        game.health = 20;
    });
    await frames(4);
    const low = await evaluate(() => ({ active: document.getElementById('low-health-vignette').classList.contains('active'), beats: __beats }));
    assert.equal(low.active, true, 'red edges at 20 HP');
    assert.ok(low.beats >= 1, 'heartbeat at 20 HP');
    await evaluate(() => { game.health = 100; });
    await frames(3);
    assert.equal(await evaluate(() => document.getElementById('low-health-vignette').classList.contains('active')), false, 'warning clears at full health');
    assert.deepEqual(errors, []);
});
