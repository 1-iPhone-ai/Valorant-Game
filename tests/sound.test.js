'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser, programState } = require('./harness');

after(closeBrowser);

// Records the layers each sound builds: filters (type, frequency) and oscillators (start frequency)
const SPY = `
    game.soundEnabled = true;
    window.__ctx = soundFX.ensureContext();
    window.__layers = [];
    const cb = __ctx.createBiquadFilter.bind(__ctx), co = __ctx.createOscillator.bind(__ctx);
    __ctx.createBiquadFilter = () => { const n = cb(); __layers.push({ kind: 'filter', n }); return n; };
    __ctx.createOscillator = () => { const n = co(); __layers.push({ kind: 'osc', n }); return n; };
    window.__take = () => { const out = __layers.map((l) => l.kind === 'filter' ? 'f:' + l.n.type + ':' + Math.round(l.n.frequency.value / 100) : 'o:' + Math.round(l.n.frequency.value / 10)); __layers.length = 0; return out; };
`;

test('every gun has its own layered sound; the suppressed Phantom has no crack; bursts fire three times', { timeout: 300000 }, async () => {
    const { page, errors, evaluate } = await boot();
    await page.addScriptTag({ content: SPY });
    const r = await evaluate(() => {
        const sig = {};
        const crack = {};
        for (const k of ['rifle', 'phantom', 'bulldog', 'judge', 'sniper', 'outlaw', 'marshal', 'frenzy']) {
            __take();
            const orig = Math.random; Math.random = () => 0.5;   // no shot-to-shot variation while comparing
            soundFX.gunshot(k);
            Math.random = orig;
            const layers = __take();
            sig[k] = layers.slice().sort().join(',');
            crack[k] = layers.filter((l) => l.startsWith('f:bandpass')).length;
        }
        game.pistolVariant = 'sheriff'; __take(); soundFX.gunshot('pistol'); const sheriff = __take().length;
        game.pistolVariant = 'classic'; soundFX.gunshot('pistol'); const classic = __take().join(',');
        soundFX.gunshot('pistol_burst'); const burst = __take().length;
        return { sig, crack, distinct: new Set(Object.values(sig)).size, sheriff, classic, burst, last: soundFX.lastGun };
    });
    assert.equal(r.distinct, 8, 'eight different gun sounds');
    assert.equal(r.crack.rifle, 1);
    assert.equal(r.crack.sniper, 1);
    assert.ok(r.sig.phantom !== r.sig.rifle && r.sig.phantom.includes('bandpass:17'), 'Phantom: a soft thwip instead of the rifle crack');
    assert.ok(r.burst >= r.sheriff * 2, 'a burst fires three times');
    assert.deepEqual(errors, []);
});

test('footsteps change with the surface and the weather; landings thud; the echo is stronger in enclosed spaces', { timeout: 300000 }, async () => {
    const { page, errors, evaluate } = await boot();
    await page.addScriptTag({ content: SPY });
    const r = await evaluate(() => {
        window.updateEnemies = () => {};
        const out = {};
        const cc = characterController;
        // Walk 8 m in small steps on whatever supports us, collecting the step sounds
        const walk = (support) => {
            const kinds = [];
            const orig = soundFX.step.bind(soundFX);
            soundFX.step = (k, loud) => { kinds.push(k); return orig(k, loud); };
            footsteps.lastX = null; footsteps.dist = 0; footsteps.wasGrounded = true;
            cc.grounded = true;
            for (let i = 0; i < 80; i++) { cc.position.x += 0.1; cc.supportRec = support; footsteps.update(); }
            soundFX.step = orig;
            return kinds;
        };
        cc.position.set(0, 1.7, 30);
        out.floor = walk(null);
        const wood = createBox(30, 0.5, 30, 2, 1, 2, 0x6b4f2a); wood.surf = MAP_SURF.wood;
        const metal = createBox(34, 0.5, 30, 2, 1, 2, 0x555555); metal.surf = MAP_SURF.metal;
        out.wood = walk({ owner: wood });
        out.metal = walk({ owner: metal });
        out.barrel = walk({ owner: null });
        weatherSurf.uWet.value = 1; out.rain = walk(null); weatherSurf.uWet.value = 0;
        weatherSurf.uSnow.value = 1; out.snow = walk(null); weatherSurf.uSnow.value = 0;
        // Crouched: shorter stride, quieter
        cc.crouchBlend = 1;
        const quiet = [];
        const orig = soundFX.step.bind(soundFX);
        soundFX.step = (k, loud) => { quiet.push(loud); return orig(k, loud); };
        footsteps.lastX = null; footsteps.dist = 0;
        for (let i = 0; i < 80; i++) { cc.position.x += 0.1; cc.supportRec = null; footsteps.update(); }
        cc.crouchBlend = 0;
        // A landing
        const lands = [];
        soundFX.step = (k, loud) => { lands.push(loud); return orig(k, loud); };
        cc.grounded = false; footsteps.update(); cc.position.y -= 1.5; cc.grounded = true; footsteps.update();
        soundFX.step = orig;
        out.crouch = quiet; out.land = lands;
        // Echo: open courtyard vs. a tight box of walls
        camera.position.set(0, 1.7, 30);
        const open = acoustics.measure();
        createBox(0, 2, 33, 8, 4, 0.5); createBox(0, 2, 27, 8, 4, 0.5); createBox(3.2, 2, 30, 0.5, 4, 8); createBox(-3.2, 2, 30, 0.5, 4, 8);
        const closed = acoustics.measure();
        acoustics.nextAt = 0; acoustics.update(performance.now());
        out.echo = { open, closed, wet: acoustics.wet, reverb: !!(soundFX._reverb && soundFX._reverb.wet) };
        // Every sound also feeds the echo
        __take(); soundFX.gunshot('rifle');
        out.sent = soundFX._reverb ? soundFX._reverb.input.numberOfInputs > 0 : false;
        return out;
    });
    const all = (list, k) => list.length >= 2 && list.every((x) => x === k);
    assert.ok(all(r.floor, 'concrete'), `floor: ${r.floor}`);
    assert.ok(all(r.wood, 'wood'), `wood crate: ${r.wood}`);
    assert.ok(all(r.metal, 'metal'), `metal: ${r.metal}`);
    assert.ok(all(r.barrel, 'metal'), 'barrel tops ring');
    assert.ok(all(r.rain, 'wet'), `rain: ${r.rain}`);
    assert.ok(all(r.snow, 'snow'), `snow: ${r.snow}`);
    assert.ok(r.crouch.length > r.floor.length && r.crouch.every((l) => l < 1), 'crouched: shorter, quieter steps');
    assert.ok(r.land.length === 1 && r.land[0] > 1, 'a landing thuds');
    assert.ok(r.echo.closed > r.echo.open + 0.3, `enclosed ${r.echo.closed.toFixed(2)} vs open ${r.echo.open.toFixed(2)}`);
    assert.ok(r.echo.reverb && r.echo.wet > 0.2, 'the echo gets stronger');
    const [programs, watermark] = await programState(page);
    assert.equal(programs, watermark);
    assert.deepEqual(errors, []);
});
