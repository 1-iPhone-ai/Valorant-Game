'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser, programState } = require('./harness');

after(closeBrowser);

// Steps the viewmodel animator by hand (synchronously) so the result does not
// depend on how fast the software renderer draws frames
const STEP = `
    window.__vmStep = (t0, t1, sample) => {
        const model = game.weapons[game.activeWeapon].model;
        const out = [];
        for (let t = t0; t <= t1; t += 16) {
            vmAnim.begin(model);
            vmAnim.end(model, t);
            if (sample) out.push(sample(t, model));
        }
        return out;
    };
    window.__pose = (m) => [m.position.x, m.position.y, m.position.z, m.rotation.x, m.rotation.y, m.rotation.z];
    window.__dist = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0);
`;

test('ability casts: the off-hand comes up in the agent colour, throws, and the gun returns exactly', { timeout: 300000 }, async () => {
    const { page, errors, evaluate } = await boot({ quality: 'high' });
    await page.addScriptTag({ content: STEP });
    const r = await evaluate(() => {
        window.updateEnemies = () => {};
        const out = {};
        agentSystem.selectAgent('jett');
        const model = game.weapons[game.activeWeapon].model;
        let t = performance.now() + 1000;
        __vmStep(t - 600, t);                       // settle
        const rest = __pose(model);
        agentSystem.castAbility('c');
        const a = castFX.active;
        out.kind = a && a.kind;
        out.colour = a && a.hex;
        a.start = t;
        let seen = { hand: false, glow: false, maxAside: 0 };
        __vmStep(t, t + a.dur + 200, (tt, m) => {
            if (castFX.group.visible) seen.hand = true;
            if (castFX.halo.visible && castFX.haloMat.opacity > 0.3) seen.glow = true;
            seen.maxAside = Math.max(seen.maxAside, rest[1] - m.position.y);
        });
        out.seen = seen;
        out.after = { active: castFX.active, hand: castFX.group.visible, glow: castFX.halo.visible, drift: __dist(__pose(model), rest) };

        // A cast during a reload leaves the reload running (the magazine still comes back)
        const w = game.weapons.rifle;
        w.ammo = 1;
        reload();
        t = performance.now() + 5000;
        vmAnim.clip.start = t;
        agentSystem.castAbility('q');
        castFX.active.start = t;
        __vmStep(t, t + 300);
        out.reloadKept = vmAnim.clip && vmAnim.clip.kind === 'reload';
        __vmStep(t + 300, t + w.reloadTime * 1000 + 400);
        out.magBack = w.magazine ? Math.abs(w.magazine.position.y - w.magRestY) < 1e-9 && w.magazine.visible : true;

        // Left-handed: the off-hand is the right hand (mirrored)
        game.userSettings.leftHanded = true;
        castFX.start('cast', '#ff0000');
        t = performance.now() + 9000;
        castFX.active.start = t;
        __vmStep(t, t + 200);
        out.mirrored = castFX.group.scale.x < 0 && castFX.group.position.x > 0;
        game.userSettings.leftHanded = false;
        __vmStep(t + 200, t + 1200);
        return out;
    });
    assert.equal(r.kind, 'cast');
    assert.equal(r.colour, 0x38f6ff, 'Jett cyan');
    assert.ok(r.seen.hand && r.seen.glow, 'hand and energy shown');
    assert.ok(r.seen.maxAside > 0.04, `gun moves aside (${r.seen.maxAside})`);
    assert.deepEqual([r.after.active, r.after.hand, r.after.glow], [null, false, false], 'hidden afterwards');
    assert.ok(r.after.drift < 1e-6, `gun back at rest (${r.after.drift})`);
    assert.ok(r.reloadKept, 'reload not interrupted');
    assert.ok(r.magBack, 'magazine seated after the reload');
    assert.ok(r.mirrored, 'left-handed mirrors the hand');
    const [programs, watermark, stalls] = await programState(page);
    assert.equal(programs, watermark, 'no new shader programs');
    assert.equal(stalls, 0);
    assert.deepEqual(errors, []);
});

test('ultimates gather with wisps and a release shake; flicks do not cut them short; knife slashes and stabs', { timeout: 300000 }, async () => {
    const { page, errors, evaluate } = await boot({ quality: 'high' });
    await page.addScriptTag({ content: STEP });
    const r = await evaluate(() => {
        window.updateEnemies = () => {};
        const out = {};
        agentSystem.selectAgent('phoenix');
        game.ultPoints = game.maxUltPoints;
        agentSystem.castAbility('x');
        const a = castFX.active;
        out.kind = a && a.kind;
        let t = performance.now() + 1000;
        a.start = t;
        castFX.start('tap', '#ffffff');
        out.notCut = castFX.active === a;
        fxKit.trauma = 0;
        let wisps = 0, traumaAt = -1;
        __vmStep(t, t + a.dur + 100, (tt) => {
            wisps = Math.max(wisps, castFX.wisps.filter((w) => w.visible).length);
            if (traumaAt < 0 && fxKit.trauma > 0) traumaAt = (tt - t) / a.dur;
        });
        out.wisps = wisps;
        out.traumaAt = traumaAt;
        out.done = castFX.active === null;

        // Knife: slashes alternate sides, the heavy attack is a stab; it returns to rest
        switchWeapon('knife');
        const knife = game.weapons.knife.model;
        t = performance.now() + 4000;
        __vmStep(t - 800, t);
        const rest = __pose(knife);
        game.lastShot = 0;
        meleeAttack(false);
        out.slash1 = [vmAnim.clip.kind, vmAnim.clip.side];
        vmAnim.clip.start = t;
        let swing = 0;
        __vmStep(t, t + 500, (tt, m) => { swing = Math.max(swing, __dist(__pose(m), rest)); });
        out.swing = swing;
        game.lastShot = 0;
        meleeAttack(false);
        out.slash2 = [vmAnim.clip.kind, vmAnim.clip.side];
        vmAnim.clip.start = t + 500;
        __vmStep(t + 500, t + 1000);
        game.lastShot = 0;
        meleeAttack(true);
        out.stab = vmAnim.clip.kind;
        vmAnim.clip.start = t + 1000;
        let lunge = 0;
        __vmStep(t + 1000, t + 1600, (tt, m) => { lunge = Math.min(lunge, m.position.z - rest[2]); });
        out.lunge = lunge;
        out.drift = __dist(__pose(knife), rest);
        return out;
    });
    assert.equal(r.kind, 'ult');
    assert.ok(r.notCut, 'a flick does not cut an ultimate short');
    assert.ok(r.wisps >= 3, 'wisps orbit while it gathers');
    assert.ok(r.traumaAt > 0.6 && r.traumaAt < 0.8, `release shake near the burst (${r.traumaAt})`);
    assert.ok(r.done);
    assert.equal(r.slash1[0], 'slash');
    assert.equal(r.slash2[0], 'slash');
    assert.equal(r.slash1[1], -r.slash2[1], 'slashes alternate sides');
    assert.ok(r.swing > 0.5, 'the knife swings');
    assert.equal(r.stab, 'stab');
    assert.ok(r.lunge < -0.3, `the stab lunges forward (${r.lunge})`);
    assert.ok(r.drift < 1e-6, `knife back at rest (${r.drift})`);
    assert.deepEqual(errors, []);
});
