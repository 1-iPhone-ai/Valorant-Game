'use strict';
// V2.3 first-person identity (WP4; design 2.5, 7.1 and 17.1), one boot with Agent Identity saved 'off':
//  - nothing is built: the V2.2 hands (0xffdbac), no arms, and the off-hand drawRange API (V23.fp.offHand) follows every
//    hands swap on V2.2's own geometries (a tier change while the support hand is away, and back);
//  - then the settings Reset path turns identity on (settingsManager.applyAllSettings: V23.core.applySettings(cfg, null),
//    which applies nothing yet): the first cast builds nothing inside castAbility (it keeps V2.2's gesture), the set is
//    built and applied by the end of that frame's task, and the next cast plays its gesture. (Once CORE's
//    applySettings(cfg, null) builds and applies at the settings change, the set is applied before the first cast; the
//    test then checks that branch: the cast still builds nothing.) Programs == watermark, no stalls.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser, programState } = require('./harness');

after(closeBrowser);

const SETTINGS_KEY = 'valorant_v16_user_settings';

test('Agent Identity off from boot: nothing built, the off-hand drawRange follows every hands swap; the Reset path builds outside the cast', { timeout: 300000 }, async () => {
    const { page, errors, frames, evaluate } = await boot({ quality: 'medium', viewport: { width: 480, height: 270 }, initArg: SETTINGS_KEY, initScript: (key) => {
        try { const o = JSON.parse(localStorage.getItem(key) || '{}'); o.agentIdentity = 'off'; localStorage.setItem(key, JSON.stringify(o)); } catch (e) {}
    } });
    await frames(4);
    const r = await evaluate(() => {
        Element.prototype.requestPointerLock = function () {};
        document.exitPointerLock = function () {};
        const out = { identity: game.userSettings.agentIdentity, enabled: V23.core.enabled(), built: V23.fp.state.built };
        const m = game.weapons.pistol.model, h = m.children.find((c) => c.userData.isHands);
        const dr = (g) => [g.drawRange.start, g.drawRange.count];
        const n = (g) => (g.index ? g.index.count : g.attributes.position.count);
        out.skin = h.material.color.getHexString() === new THREE.Color(0xffdbac).convertSRGBToLinear().getHexString();
        out.arms = m.children.some((c) => c.userData.isAgentArm);
        const g0 = h.geometry, wasHd = characterDetail.enabled;
        out.api = V23.fp.offHand(m, true);
        out.g0 = [dr(g0), n(g0)];
        characterDetail.set(!wasHd);   // a tier swap while the support hand is away (a reload on an Auto-quality step)
        const g1 = h.geometry;
        out.swapped = g1 !== g0;
        out.g1 = [dr(g1), n(g1)];
        out.g0After = dr(g0);
        V23.fp.offHand(m, false);   // the reload ends
        out.g1Shown = dr(g1);
        V23.fp.offHand(m, true);    // another reload, and the tier goes back during it
        characterDetail.set(wasHd);
        out.back = h.geometry === g0;
        out.g0Back = dr(g0); out.g1Back = dr(g1);
        V23.fp.offHand(m, false);
        out.final = [dr(g0), dr(g1)];
        out.builtAfter = V23.fp.state.built;
        return out;
    });
    assert.deepEqual([r.identity, r.enabled, r.built, r.skin, r.arms], ['off', false, false, true, false], 'identity off from boot: V2.2 hands, nothing built');
    assert.equal(r.api, true);
    assert.deepEqual(r.g0[0], [0, r.g0[1] / 2], 'the left hand away on the V2.2 geometry');
    assert.equal(r.swapped, true, 'the tier swap changed the hands geometry');
    assert.deepEqual(r.g1[0], [0, r.g1[1] / 2], 'the new geometry takes the off-hand state');
    assert.deepEqual(r.g0After, [0, Infinity], 'the geometry left behind draws whole again');
    assert.deepEqual(r.g1Shown, [0, Infinity], 'offHand(false) on the new geometry');
    assert.equal(r.back, true);
    assert.deepEqual([r.g0Back, r.g1Back], [[0, r.g0[1] / 2], [0, Infinity]], 'the swap back carries the state again');
    assert.deepEqual(r.final, [[0, Infinity], [0, Infinity]], 'both hands on both geometries at the end');
    assert.equal(r.builtAfter, false, 'still nothing built');
    let [programs, watermark, stalls] = await programState(page);
    assert.equal(programs, watermark);
    assert.equal(stalls, 0);

    // ---- the settings Reset path turns Agent Identity on --------------------------------------------------------------
    const reset = await evaluate(() => {
        window.updateEnemies = () => {};
        try { tacticalEnhancements.toggleWingmanAI(false); } catch (e) {}
        game.userSettings.agentIdentity = 'on';
        settingsManager.applyAllSettings(false);   // the Reset button's and the settings load's path (V23.core.applySettings(cfg, null))
        game.userSettings.infiniteAbilities = true;
        const st = V23.fp.state;
        return { enabled: V23.core.enabled(), built: st.built, applied: st.applied };
    });
    assert.equal(reset.enabled, true, 'identity on after the Reset path');
    await frames(3);
    const first = await evaluate(() => {
        const st = V23.fp.state, hands = game.weapons.rifle.model.children.find((c) => c.userData.isHands);
        const out = { before: { built: st.built, applied: st.applied, builds: st.builds } };
        const t0 = performance.now();
        agentSystem.castAbility('c');
        out.castMs = performance.now() - t0;
        out.inCast = { builds: st.builds, built: st.built, active: !!castFX.active, skip: !!castFX.active && st.skip === castFX.active, gesture: st.cur ? st.cur.name : null, grouped: !!hands.geometry.userData.v23Src };
        return out;
    });
    await frames(2);
    const next = await evaluate(() => {
        const st = V23.fp.state, hands = game.weapons.rifle.model.children.find((c) => c.userData.isHands);
        const out = { built: st.built, applied: st.applied, builds: st.builds, buildMs: st.buildMs, grouped: !!hands.geometry.userData.v23Src, arm: game.weapons.rifle.model.children.some((c) => c.userData.isAgentArm && c.visible) };
        // the first cast keeps V2.2's gesture to its end
        const a = castFX.active;
        out.firstStill = { active: !!a, gesture: a && st.cur && st.cur.active === a ? st.cur.name : null };
        if (castFX.active) { castFX.active = null; castFX.hide(); }
        const b0 = st.builds;
        agentSystem.castAbility('q');
        out.next = { builds: st.builds - b0, gesture: st.cur ? st.cur.name : null };
        if (castFX.active) { castFX.active = null; castFX.hide(); }
        return out;
    });
    console.log('V23RESET ' + JSON.stringify({ reset, first, next }));
    if (first.before.applied) {
        // CORE built and applied it at the settings change (applySettings(cfg, null) after boot)
        assert.equal(first.inCast.builds, first.before.builds, 'the first cast builds nothing');
        assert.ok(first.inCast.gesture, 'the first cast plays its gesture');
    } else {
        // CORE applied nothing at the settings change: the cast builds nothing, keeps V2.2's gesture, and the build runs
        // at the end of that frame's task
        assert.deepEqual([first.before.built, first.inCast.builds, first.inCast.built, first.inCast.active, first.inCast.skip, first.inCast.gesture, first.inCast.grouped],
            [false, 0, false, true, true, null, false], 'the first cast builds nothing inside castAbility and keeps V2.2\'s gesture');
        assert.deepEqual(next.firstStill.gesture, null, 'that cast stays V2.2\'s to its end');
    }
    assert.deepEqual([next.built, next.applied, next.builds, next.grouped, next.arm], [true, true, 1, true, true], 'built and applied once, outside the cast: grouped hands and the arms');
    assert.deepEqual([next.next.builds, !!next.next.gesture], [0, true], 'the next cast builds nothing and plays its gesture');
    await frames(4);
    [programs, watermark, stalls] = await programState(page);
    assert.equal(programs, watermark, 'programs == watermark after the build');
    assert.equal(stalls, 0, 'no stalls');
    assert.deepEqual(errors, []);
});
