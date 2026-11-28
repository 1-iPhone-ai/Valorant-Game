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
        // V2.3 (WP5): pinned to Weapon Animations 'classic' (V2.2's reload); 'v23' is checked below
        game.userSettings.weaponAnims = 'classic';
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

        // V2.3 (WP5): Weapon Animations 'v23': the reload's off hand (castFX) holds the magazine; a cast takes the hand (the
        // gun's own support hand comes back, the spare magazine hides), the reload runs on, and the hand returns after it
        game.userSettings.weaponAnims = 'v23';
        game.reloading = false;
        w.ammo = 1;
        reload();
        t = performance.now() + 7000;
        const R = V23.vm.state.slots.rifle, dur = vmAnim.clip.dur;
        vmAnim.clip.start = t;
        const step = (a, b) => { for (let x = a; x <= b; x += 16) { vmAnim.begin(model); vmAnim.end(model, x); V23.vm.step(0.016, x); } };
        step(t, t + 0.3 * dur);
        const v = out.v23 = { before: [V23.vm.state.offModel === model, R.spare.visible, castFX.group.visible] };
        castFX.start('cast', 0x38f6ff, 'jett.q');
        castFX.active.start = t + 0.3 * dur + 16;
        step(t + 0.3 * dur + 16, t + 0.3 * dur + 200);
        v.during = [V23.vm.state.offModel, R.spare.visible, vmAnim.clip && vmAnim.clip.kind];
        // (the cast's 620 ms are over by +636; the hand holds the fresh magazine until it pushes it into the well at
        // 0.645 of the clip: +700 is p 0.62 of the Vandal's 2.2 s)
        step(t + 0.3 * dur + 216, t + 0.3 * dur + 700);
        v.after = [castFX.active, V23.vm.state.offModel === model, R.spare.visible, vmAnim.clip && vmAnim.clip.kind];
        step(t + 0.3 * dur + 716, t + dur + 400);
        v.end = [w.magazine.visible && Math.abs(w.magazine.position.y - w.magRestY) < 1e-9, V23.vm.state.offModel, castFX.group.visible, vmAnim.clip];
        game.reloading = false;

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
    assert.deepEqual(r.v23.before, [true, true, true], 'v23: mid-swap the off hand holds the magazine, the support hand is away');
    assert.deepEqual(r.v23.during, [null, false, 'reload'], 'v23: a cast takes the hand, the support hand is back, the reload runs on');
    assert.deepEqual(r.v23.after, [null, true, true, 'reload'], 'v23: after the cast the off hand has the magazine again');
    assert.deepEqual(r.v23.end, [true, null, false, null], 'v23: the magazine seated, the hands back, the clip over');
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
