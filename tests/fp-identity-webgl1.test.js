'use strict';
// V2.3 first-person identity (WP4; design 2.5 and 17.1), one boot without WebGL2 (Ultra unsupported, so the shader
// warm-up's ultraRealism.warm, which applies identity on WebGL2, returns early): the first-person set is built and
// applied before play (initCast's queued build at the end of initGame's task), and the first cast builds nothing.
// Programs == watermark, no stalls.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser, programState } = require('./harness');

after(closeBrowser);

test('without WebGL2 (Ultra unsupported): the first-person set is built and applied before play, the first cast builds nothing', { timeout: 300000 }, async () => {
    const { page, errors, frames, evaluate } = await boot({ quality: 'medium', viewport: { width: 480, height: 270 }, initScript: () => {
        const orig = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type, attrs) { if (type === 'webgl2') return null; return orig.call(this, type, attrs); };
    } });
    const r = await evaluate(() => {
        Element.prototype.requestPointerLock = function () {};
        document.exitPointerLock = function () {};
        window.updateEnemies = () => {};
        try { tacticalEnhancements.toggleWingmanAI(false); } catch (e) {}
        const st = V23.fp.state, hands = game.weapons.rifle.model.children.find((c) => c.userData.isHands);
        const out = { webgl2: renderer.capabilities.isWebGL2, ultra: ultraRealism.isSupported(), enabled: V23.core.enabled(), built: st.built, applied: st.applied, builds: st.builds,
            grouped: !!hands.geometry.userData.v23Src, arm: game.weapons.rifle.model.children.some((c) => c.userData.isAgentArm && c.visible), buildMs: st.buildMs };
        game.userSettings.infiniteAbilities = true;
        const t0 = performance.now();
        agentSystem.castAbility('c');
        out.castMs = performance.now() - t0;
        out.buildsAfterCast = st.builds;
        out.gesture = st.cur ? st.cur.name : null;
        return out;
    });
    console.log('V23WEBGL1 ' + JSON.stringify(r));
    assert.deepEqual([r.webgl2, r.ultra, r.enabled], [false, false, true], 'WebGL1, Ultra unsupported, identity on');
    assert.deepEqual([r.built, r.applied, r.builds, r.grouped, r.arm], [true, true, 1, true, true], 'built and applied at boot: grouped hands and the arms');
    assert.equal(r.buildsAfterCast, 1, 'the first cast builds nothing');
    assert.ok(r.gesture, 'the cast plays its gesture');
    await frames(4);
    const [programs, watermark, stalls] = await programState(page);
    assert.equal(programs, watermark);
    assert.equal(stalls, 0);
    assert.deepEqual(errors, []);
});
