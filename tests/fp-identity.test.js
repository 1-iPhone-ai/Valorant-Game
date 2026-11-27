'use strict';
// V2.3 first-person identity (WP4; design 7 and 17.1). One boot. With Agent Identity set on explicitly:
//  - for every agent (AGENT_ORDER; ROLE=<role> filters): each gun model's arm Group sits right after its hands with the
//    agent's V23.parts.fpArms pair, the sleeve and detail materials take the palette slots the pair names, the look's fp
//    fields (sleeve, cuff, wrist, overlay) show, the wrist module stands out of the forearm at the wrist, and the glove
//    and tip materials match the palette (the tips are skin for fingerless gloves); castFX's hand, sleeve and detail
//    follow; V23MATRIX rows for the sleeve, glove and tips, and wrist columns;
//  - the grouped hands: 4 groups with hand A exactly the first half (simple with 2 and 4 fingers, High Detail, Ultra),
//    the off-hand drawRange API, and the drawRange kept across tier swaps;
//  - for every agent, each slot's cast (and the ultimate) plays the look's mapped gesture, reaches its release key at p
//    0.10-0.16 with the hand at the key and castFX.core on the energy point, makes no Math.random call, and leaves the
//    gun exactly at rest (drift < 1e-6); with Enhanced Animations off and on;
//  - an ultimate leaves the centre clear: after p 0.25 no energy card within 0.28 NDC of the centre, the centre crop's
//    luminance within 10% at p 0.7, and the #ult-cue vignette (clear centre, opacity caps, below the crosshair);
//  - render crops for Sage, Omen and 4 others in every hand tier (the session's simple hands, High Detail, Ultra) and in
//    left-handed mode, through the plain, Cinematic and Ultra pipelines, with programs == watermark and no stalls;
//  - identity off: the V2.2 hands (0xffdbac), no arms, V2.2's castFX and pose.
// Crops are written as PNG files when FP_SHOTS=<dir> is set.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { boot, closeBrowser, programState } = require('./harness');

after(closeBrowser);

const ROLE = process.env.ROLE ? String(process.env.ROLE).toUpperCase() : null;
const SHOTS = process.env.FP_SHOTS || null;
const CROP_AGENTS = ['sage', 'omen', 'jett', 'sova', 'killjoy', 'viper'];
const matrix = (agent, column, ok, detail) => console.log('V23MATRIX ' + JSON.stringify({ agent, column, ok: !!ok, detail: detail === undefined ? '' : detail }));

// In the page: steps the viewmodel animator by hand (synchronously, as cast.test does), so a gesture is sampled at
// exact clip progress whatever the renderer's speed
const PAGE = `
    window.__vmStep = (t0, t1, sample) => {
        const model = game.weapons[game.activeWeapon].model;
        for (let t = t0; t <= t1; t += 16) { vmAnim.begin(model); vmAnim.end(model, t); if (sample) sample(t, model); }
    };
    window.__pose = (m) => [m.position.x, m.position.y, m.position.z, m.rotation.x, m.rotation.y, m.rotation.z];
    window.__dist = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0);
    window.__lin = (hex) => new THREE.Color(hex).convertSRGBToLinear();
    window.__same = (c, hex) => { const l = __lin(hex); return Math.abs(c.r - l.r) < 1e-4 && Math.abs(c.g - l.g) < 1e-4 && Math.abs(c.b - l.b) < 1e-4; };
    window.__identity = (on) => { game.userSettings.agentIdentity = on ? 'on' : 'off'; V23.core.applySettings(game.userSettings, 'agentIdentity'); };
    // one synchronous frame of the active pipeline into the canvas, then the crop's RGBA (rows bottom-up)
    window.__frame = () => {
        const now = performance.now();
        if (typeof ultraPost !== 'undefined' && ultraPost.active) ultraPost.render(now);
        else if (typeof postFX !== 'undefined' && postFX.enabled) postFX.render(now);
        else {
            renderer.setRenderTarget(null);
            renderer.setClearColor(scene.background, 1);
            renderer.clear();
            renderer.render(scene, camera);
            renderer.clearDepth();
            viewmodelScene.environment = scene.environment;
            syncViewmodelCamera();
            renderer.render(viewmodelScene, viewmodelCamera);
        }
    };
    window.__crop = (x0, y0, w, h) => {
        const gl = renderer.getContext(), px = new Uint8Array(w * h * 4);
        gl.readPixels(x0, y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return px;
    };
    window.__luma = (px) => { let s = 0; for (let i = 0; i < px.length; i += 4) s += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]; return s / (px.length / 4); };
    window.__png = (px, w, h) => {
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const g = c.getContext('2d'), img = g.createImageData(w, h);
        for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
        g.putImageData(img, 0, 0);
        return c.toDataURL('image/png');
    };
`;

test('first-person identity: arms, gloves, wrists, gestures, ultimate cue, render crops, identity off', { timeout: 600000 }, async () => {
    const { page, errors, frames, evaluate } = await boot({ quality: 'medium', viewport: { width: 480, height: 270 } });
    await page.addScriptTag({ content: PAGE });
    await evaluate(() => {
        Element.prototype.requestPointerLock = function () {};
        document.exitPointerLock = function () {};
        window.updateEnemies = () => {};
        try { tacticalEnhancements.toggleWingmanAI(false); } catch (e) {}
        game.userSettings.infiniteAbilities = true;
        game.userSettings.infiniteUlt = true;
        __identity(true);
        if (enhancedAnim.on) enhancedAnim.set(false);
    });
    const agents = await evaluate((role) => AGENT_ORDER.filter((id) => !role || AGENT_DEFS[id].role === role), ROLE);
    assert.ok(agents.length >= (ROLE ? 1 : 29), `agents (${agents.length})`);

    // ---- 1. every agent's arms, gloves, wrists and cast forearm, from data ---------------------------------------------
    const RIG_FORE = { lean: 0.050, std: 0.054, broad: 0.060, tall: 0.051, heavy: 0.065, compact: 0.056 };   // PARTS _RIG_DIMS fore
    const data = await evaluate(([agents, RIG_FORE]) => {
        const out = {};
        const st = V23.fp.state;
        const a = new THREE.Vector3(0, -0.75, 0.66).normalize(), W = new THREE.Vector3(0.08, -0.09, 0), v = new THREE.Vector3(), d = new THREE.Vector3();
        for (const id of agents) {
            agentSystem.selectAgent(id);
            const look = V23.core.resolve(id), res = V23.parts.fpArms(look), P = look.palette, probs = [];
            const slotHex = (s) => (P[s] || (s === 'visor' ? P.glow : null) || P.base).c;
            if (st.agent !== id) probs.push('V23.fp follows the agent (' + st.agent + ')');
            // arms on the 4 models: right after the hands, the agent's pair, materials per group from the slots it names
            const models = st.models;
            for (const m of models) {
                const arm = m.arm;
                if (!arm || !arm.userData.isAgentArm || !arm.visible) { probs.push(m.slot + ': no visible arm'); continue; }
                if (m.armIndex !== m.handsIndex + 1) probs.push(m.slot + ': arm at ' + m.armIndex + ', hands at ' + m.handsIndex);
                const [sl, dt] = arm.children;
                if (sl.geometry !== res.sleeve || dt.geometry !== res.detail) probs.push(m.slot + ': not the agent\'s fpArms pair');
                for (const [mesh, slots] of [[sl, res.slots.sleeve], [dt, res.slots.detail]]) {
                    for (const gr of mesh.geometry.groups) {
                        const mat = mesh.material[gr.materialIndex], s = slots[gr.materialIndex] || slots[0];
                        if (!__same(mat.color, slotHex(s))) probs.push(m.slot + ': group ' + gr.materialIndex + ' is not palette.' + s);
                        if (mat.toneMapped !== false) probs.push(m.slot + ': arm material toneMapped');
                    }
                }
            }
            // the look's fp fields
            const fp = look.fp;
            const sleeveOk = res.slots.sleeve[0] === fp.sleeve && res.draws <= 3 && res.sleeve.index.count > 0;
            const cuffOk = res.cuffFolded ? res.slots.detail.length === 1 && res.slots.detail[0] === 'glow' : res.slots.detail[0] === fp.cuff;
            if (!sleeveOk) probs.push('sleeve slots ' + res.slots.sleeve.join('+') + ' draws ' + res.draws);
            if (!cuffOk) probs.push('detail slots ' + res.slots.detail.join('+'));
            if (res.overlay !== (fp.overlay || null)) probs.push('overlay ' + res.overlay);
            // the wrist module: it emits parts, the set names it, and the right arm has vertices at the wrist band that
            // stand out of the bare forearm (8% beyond its radius there)
            const wristParts = V23.parts.module(fp.wrist, { n: look.gloves.wrist.n }, 'show').length;
            const rWrist = RIG_FORE[look.rig] * 0.85 * 0.75;
            let out8 = 0;
            for (const g of [res.sleeve, res.detail]) {
                const p = g.attributes.position;
                for (let i = 0; i < p.count; i++) {
                    v.fromBufferAttribute(p, i);
                    if (v.x <= 0) continue;
                    d.subVectors(v, W);
                    const t = d.dot(a);
                    if (t < 0.003 || t > 0.05) continue;
                    if (d.addScaledVector(a, -t).length() > rWrist * 1.08) out8++;
                }
            }
            const wristOk = res.wrist === fp.wrist && wristParts > 0 && out8 > 0;
            if (!wristOk) probs.push('wrist ' + fp.wrist + ': parts ' + wristParts + ', vertices out at the wrist ' + out8);
            // gloves and tips
            const G = look.gloves, gloveHex = G.type === 'bare' ? P.skin.c : slotHex(fp.glove), two = G.type !== 'bare' && (G.tips === 'skin' || G.type === 'fingerless' || G.type === 'wrap') && P.skin.c !== gloveHex;
            const hands = models.map((m) => game.weapons[m.slot].model.children[m.handsIndex]);
            let gloveOk = st.two === two;
            for (const h of hands) {
                const mats = Array.isArray(h.material) ? h.material : [h.material];
                if (two !== Array.isArray(h.material)) gloveOk = false;
                if (!__same(mats[0].color, gloveHex) || mats[0].toneMapped !== false) gloveOk = false;
                if (two && !__same(mats[1].color, P.skin.c)) gloveOk = false;
                if (!h.geometry.userData.v23Src || h.geometry.groups.length < 2) gloveOk = false;
            }
            if (G.type === 'fingerless' && !two) gloveOk = false;   // fingerless: the tips are skin
            if (!gloveOk) probs.push('gloves ' + G.type + ' two ' + two + '/' + st.two);
            // castFX: the same glove materials, the agent's forearm (the right half of the pair, sharing its buffers)
            const fx = castFX;
            const castOk = fx.hand.material === hands[0].material && fx.sleeve.geometry.attributes.position === res.sleeve.attributes.position
                && fx.sleeve.geometry.index.count > 0 && fx.sleeve.geometry.index.count < res.sleeve.index.count && st.castDetail.visible
                && st.castDetail.geometry.attributes.position === res.detail.attributes.position;
            if (!castOk) probs.push('castFX hand, sleeve or detail');
            out[id] = { probs, sleeve: sleeveOk, cuff: cuffOk, wrist: wristOk, glove: gloveOk, cast: castOk, draws: res.draws, slots: res.slots.sleeve.join('+') + '/' + res.slots.detail.join('+'), type: G.type, two };
        }
        return out;
    }, [agents, RIG_FORE]);
    for (const id of agents) {
        const r = data[id];
        matrix(id, 'first-person sleeve', r.sleeve && r.cast, `${r.slots}, ${r.draws} arm draws`);
        matrix(id, 'first-person glove and tips', r.glove, `${r.type}${r.two ? ' (skin tips)' : ''}`);
        matrix(id, 'first-person wrist detail', r.wrist && r.cuff, '');
        assert.deepEqual(r.probs, [], `${id}: arms, gloves, wrist`);
    }
    // the pilots' looks: Sage's rolled ceramic sleeve over skin with the ampoules as the accent and skin fingertips;
    // Omen's undersuit sleeve with trim plate overlays (on the left forearm) and one dark gauntlet material
    if (data.sage) assert.deepEqual([data.sage.slots, data.sage.two, data.sage.type], ['base+skin/glow', true, 'fingerless']);
    if (data.omen) {
        assert.deepEqual([data.omen.slots.split('/')[0], data.omen.two, data.omen.type], ['under', false, 'gauntlet']);
        const plates = await evaluate(() => {
            const r = V23.parts.fpArms(V23.core.resolve('omen')).detail.attributes.position;
            let L = 0, R = 0;
            for (let i = 0; i < r.count; i++) { if (r.getX(i) < 0) L++; else R++; }
            return { L, R };
        });
        assert.ok(plates.L > plates.R, `Omen's plate overlay sits on the left forearm (${plates.L} vs ${plates.R} detail vertices)`);
    }

    // ---- 2. grouped hands: hand A is the first half; the off-hand drawRange API across tier swaps -------------------------
    const grouped = await evaluate(() => {
        const out = {};
        const check = (g) => {
            const n = g.index.count, half = g.userData.v23Half, gr = g.groups;
            return { n, half, groups: gr.length, mats: gr.map((x) => x.materialIndex).join(''), firstHalf: half * 2 === n && gr.filter((x) => x.start < half).every((x) => x.start + x.count <= half) };
        };
        for (const [k, f] of [['simple2', 2], ['simple4', 4]]) out[k] = check(V23.fp._handsGeometry('simple', 0.2, f));
        out.detailed = check(V23.fp._handsGeometry('detailed', 0.2, 4));
        out.ultra = check(V23.fp._handsGeometry('ultra', 0.2, 4));
        const pistol = game.weapons.pistol.model, hands = pistol.children.find((c) => c.userData.isHands);
        out.live = check(hands.geometry);
        out.fingers = CONTENT.fingers;
        out.api = V23.fp.offHand(pistol, true);
        out.hidden = [hands.geometry.drawRange.start, hands.geometry.drawRange.count, hands.geometry.userData.v23Half];
        out.unknown = V23.fp.offHand(new THREE.Group(), true);
        return out;
    });
    for (const k of ['simple2', 'simple4', 'detailed', 'ultra', 'live']) {
        assert.equal(grouped[k].groups, 4, `${k}: 4 groups`);
        assert.equal(grouped[k].mats, '0101', `${k}: [glove, tips, glove, tips]`);
        assert.ok(grouped[k].firstHalf, `${k}: hand A is exactly the first half of the index buffer`);
    }
    assert.equal(grouped.api, true, 'offHand on a gun model');
    assert.deepEqual(grouped.hidden, [grouped.live.half, grouped.live.half, grouped.live.half], 'hidden: only the second half draws');
    assert.equal(grouped.unknown, false, 'offHand on an unknown model');

    // ---- 3. every agent's gestures, Enhanced Animations off and on ---------------------------------------------------------
    for (const ea of [false, true]) {
        const g = await evaluate(([agents, ea]) => {
            enhancedAnim.set(ea);
            const out = {}, real = Math.random;
            let draws = 0;
            for (const id of agents) {
                agentSystem.selectAgent(id);
                switchWeapon('rifle');
                const look = V23.core.resolve(id), probs = [], cells = [];
                const model = game.weapons.rifle.model;
                let t = performance.now() + 1000;
                __vmStep(t - 500, t);
                // the gun's pose net of Enhanced Animations' idle breathing (eaFP.breath: this frame's offset, which a cast
                // pauses in V2.2 as well), so the drift measures what the gesture leaves behind
                const net = () => { const q = __pose(model); if (enhancedAnim.on) { q[1] -= eaFP.breath.py; q[3] -= eaFP.breath.rx; } return q; };
                const rest = net();
                for (const slot of ['c', 'q', 'e', 'x']) {
                    const kind = slot === 'x' ? 'ult' : 'cast';
                    if (castFX.active) { castFX.active = null; castFX.hide(); }
                    castFX.start(kind, AGENT_DEFS[id].themeColor, id + '.' + slot);
                    const A = castFX.active, cur = V23.fp.state.cur;
                    const want = look.gestures[slot];
                    if (!cur || cur.name !== want) { probs.push(slot + ': gesture ' + (cur && cur.name) + ', mapped ' + want); continue; }
                    A.start = t;
                    const pr = cur.pr, gest = V23.motion.gesture(want), key = gest.fp[1], hand = 1, M = look.motion;
                    if (!(pr >= 0.10 - 1e-9 && pr <= 0.16 + 1e-9)) probs.push(slot + ': release at p ' + pr.toFixed(3));
                    // no Math.random while the gesture plays
                    Math.random = function () { draws++; return real(); };
                    let atRelease = null, released = false;
                    try {
                        const tRel = t + pr * A.dur + 0.01;   // on the release key (a hundredth of a ms past it)
                        __vmStep(t, tRel - 1);
                        // the frame on the release key itself
                        vmAnim.begin(model); vmAnim.end(model, tRel);
                        const gp = castFX.group.position, gr = castFX.group.rotation, e = cur.energy;
                        // the release key, with the FP block's in-view floor (palm centre at NDC y >= -0.85 at the key's depth)
                        const keyY = Math.max(key[2], -0.85 * Math.max(0.05, -key[3]) / viewmodelCamera.projectionMatrix.elements[5]);
                        atRelease = {
                            pos: Math.hypot(gp.x - (key[1] - 0.018 * M.asym) * hand, gp.y - keyY, gp.z - key[3]),
                            rot: Math.abs(gr.x - key[4]) + Math.abs(gr.y - key[5] * hand) + Math.abs(gr.z - key[6] * hand),
                            core: castFX.core.position.distanceTo(e), toHand: e.distanceTo(gp), visible: castFX.group.visible, released: cur.released
                        };
                        __vmStep(tRel + 16, t + A.dur + 200);
                        released = cur.released;
                    } finally { Math.random = real; }
                    if (atRelease.pos > 2e-3 || atRelease.rot > 2e-3) probs.push(slot + ': at the release key the hand is ' + atRelease.pos.toFixed(4) + ' m / ' + atRelease.rot.toFixed(4) + ' rad off the key');
                    if (atRelease.core > 1e-9 || atRelease.toHand > 0.12) probs.push(slot + ': castFX.core ' + atRelease.core + ' off the energy point, which is ' + atRelease.toHand.toFixed(3) + ' m from the hand');
                    if (!atRelease.visible || !atRelease.released || !released) probs.push(slot + ': hand shown and the release key passed');
                    const drift = __dist(net(), rest);
                    if (drift >= 1e-6) probs.push(slot + ': drift ' + drift);
                    if (castFX.active !== null || castFX.group.visible) probs.push(slot + ': still shown after the clip');
                    cells.push(slot + ' ' + want + ' @' + pr.toFixed(3));
                }
                out[id] = { probs, cells };
            }
            enhancedAnim.set(false);
            return { out, draws };
        }, [agents, ea]);
        assert.equal(g.draws, 0, `EA ${ea ? 'on' : 'off'}: no Math.random call while gestures play`);
        for (const id of agents) {
            if (!ea) matrix(id, 'first-person gestures C/Q/E/X match the mapping', g.out[id].probs.length === 0, g.out[id].cells.join(', '));
            assert.deepEqual(g.out[id].probs, [], `${id} gestures with Enhanced Animations ${ea ? 'on' : 'off'}`);
        }
    }

    // ---- 4. ultimates leave the centre clear; the #ult-cue vignette ------------------------------------------------------
    const ultAgents = agents.filter((id) => CROP_AGENTS.includes(id));
    const ult = await evaluate((ultAgents) => {
        const out = {};
        switchWeapon('rifle');
        const cc = characterController;
        cc.position.set(0, cc.standHeight, 22); cc.prevSimPosition.copy(cc.position); camera.position.copy(cc.position);
        camera.rotation.set(0, 0, 0, 'YXZ'); if (cc.targetRotation) cc.targetRotation.y = 0;
        updateWeaponPosition();
        const W = renderer.getContext().drawingBufferWidth, H = renderer.getContext().drawingBufferHeight;
        const cw = Math.round(W * 0.15), ch = Math.round(H * 0.15), cx = Math.round((W - cw) / 2), cy = Math.round((H - ch) / 2);
        const model = game.weapons.rifle.model;
        for (const id of ultAgents) {
            agentSystem.selectAgent(id);
            if (castFX.active) { castFX.active = null; castFX.hide(); }
            let t = performance.now() + 1000;
            __vmStep(t - 500, t);
            __frame();
            const base = __luma(__crop(cx, cy, cw, ch));
            castFX.start('ult', AGENT_DEFS[id].themeColor, id + '.x');
            const A = castFX.active;
            A.start = t;
            const P = viewmodelCamera.projectionMatrix.elements;
            let minCard = 9, minHand = 9;
            const ndc = (o) => { const z = -o.position.z; return Math.hypot(P[0] * o.position.x / z, P[5] * o.position.y / z); };
            __vmStep(t, t + A.dur * 0.7, (tt) => {
                const p = (tt - t) / A.dur;
                if (p < 0.25) return;
                for (const o of [castFX.halo, castFX.core].concat(castFX.wisps)) if (o.visible) minCard = Math.min(minCard, ndc(o));
                const gp = castFX.group.position, z = -gp.z;
                if (castFX.group.visible) minHand = Math.min(minHand, Math.abs(P[0] * gp.x / z));
            });
            // the frame at p 0.7
            vmAnim.begin(model); vmAnim.end(model, t + A.dur * 0.7);
            __frame();
            const lum = __luma(__crop(cx, cy, cw, ch));
            out[id] = { minCard, minHand, base, lum, delta: Math.abs(lum - base) / Math.max(1, base), glow: A.hex === V23.core.resolve(id).palette.glow.c };
            __vmStep(t + A.dur * 0.7 + 16, t + A.dur + 100);
        }
        // the cue: shown, clear centre, caps, layer
        const el = document.getElementById('ult-cue'), cs = getComputedStyle(el), cross = getComputedStyle(document.getElementById('crosshair'));
        const peak = () => Math.max.apply(null, el.getAnimations().flatMap((a) => a.effect.getKeyframes().map((k) => +k.opacity)));
        V23.fp.ultCue('sage');
        const cue = { on: el.classList.contains('v23-on'), display: cs.display, pointer: cs.pointerEvents, z: +cs.zIndex, crossZ: +cross.zIndex, bg: cs.backgroundImage, peak: peak() };
        game.userSettings.atmosphereMode = 'competitive'; V23.fp.ultCue('omen'); cue.comp = peak();
        game.userSettings.reduceFlashes = true; V23.fp.ultCue('omen'); cue.rfComp = peak(); cue.rfBg = getComputedStyle(el).backgroundImage;
        game.userSettings.atmosphereMode = 'daylight'; V23.fp.ultCue('omen'); cue.rf = peak();
        game.userSettings.reduceFlashes = false;
        out.cue = cue;
        return out;
    }, ultAgents);
    for (const id of ultAgents) {
        const u = ult[id];
        const ok = u.minCard >= 0.28 && u.minHand >= 0.29 && u.delta <= 0.10 && u.glow;
        matrix(id, 'ultimate cue keeps the centre clear', ok, `cards >= ${u.minCard.toFixed(3)} NDC, hands >= ${u.minHand.toFixed(3)}, centre luminance ${(u.delta * 100).toFixed(1)}%`);
        assert.ok(u.minCard >= 0.28, `${id}: no energy card within 0.28 NDC of the centre after p 0.25 (${u.minCard.toFixed(3)})`);
        assert.ok(u.minHand >= 0.29, `${id}: the hands keep off the centre line (${u.minHand.toFixed(3)})`);
        assert.ok(u.delta <= 0.10, `${id}: centre crop luminance at p 0.7 within 10% (${u.base.toFixed(1)} -> ${u.lum.toFixed(1)})`);
        assert.ok(u.glow, `${id}: the release light takes the palette's glow`);
    }
    const cue = ult.cue;
    assert.equal(cue.on, true);
    assert.equal(cue.display, 'block');
    assert.equal(cue.pointer, 'none', 'the cue never takes the pointer');
    assert.ok(cue.z < cue.crossZ, `below the crosshair (${cue.z} < ${cue.crossZ})`);
    assert.match(cue.bg, /(?:transparent|rgba\(0, 0, 0, 0\)) 55%/, 'the centre 55% of the short side stays clear');
    assert.ok(Math.abs(cue.peak - 0.35) < 1e-6 && Math.abs(cue.comp - 0.175) < 1e-6, `opacity 0.35, half in Competitive (${cue.peak}, ${cue.comp})`);
    assert.ok(cue.rf < cue.comp && cue.rfComp <= cue.rf / 2 + 1e-6 && /(?:transparent|rgba\(0, 0, 0, 0\)) 8\d%/.test(cue.rfBg), `Reduce Flashes: thin and dim (${cue.rf}, ${cue.rfComp}, ${cue.rfBg})`);

    // ---- 5. render crops: 6 agents x every hand tier (+ left-handed), plain, Cinematic and Ultra -------------------------
    const tiers = [['medium', 'simple'], ['cinematic', 'detailed'], ['ultraRealism', 'ultra']];
    const cropAgents = agents.filter((id) => CROP_AGENTS.includes(id));
    const hashes = {};
    for (const [quality, kind] of tiers) {
        await evaluate((q) => { setQualitySettings(q); if (q === 'ultraRealism') ultraPrep.finish(); }, quality);
        await frames(6);
        const r = await evaluate(([cropAgents, kind, shots]) => {
            const out = { kind, live: null, crops: {}, pngs: {} };
            switchWeapon('pistol');
            const model = game.weapons.pistol.model, hands = model.children.find((c) => c.userData.isHands);
            const W = renderer.getContext().drawingBufferWidth, H = renderer.getContext().drawingBufferHeight;
            // the pistol raised into view so its hands, wrists and sleeves show (the hip view keeps them below the frame)
            const place = (left) => {
                model.position.set(0.1 * (left ? -1 : 1), -0.02, -0.42);
                model.rotation.set(0.25, 0, 0);
                model.updateMatrixWorld(true);
            };
            const cropOf = () => {
                const box = new THREE.Box3().setFromObject(hands).union(new THREE.Box3().setFromObject(model.children.find((c) => c.userData.isAgentArm) || hands));
                const pts = [];
                for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) pts.push(new THREE.Vector3(x, y, z).project(viewmodelCamera));
                let x0 = 1, x1 = -1, y0 = 1, y1 = -1;
                for (const p of pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
                const px = (v) => Math.round((v + 1) / 2 * W), py = (v) => Math.round((v + 1) / 2 * H);
                const a = Math.max(0, px(x0)), b = Math.min(W, px(x1)), c = Math.max(0, py(y0)), d = Math.min(H, py(y1));
                return [a, c, Math.max(8, b - a), Math.max(8, d - c)];
            };
            const shot = (label, left) => {
                game.userSettings.leftHanded = !!left;
                place(left);
                syncViewmodelCamera();
                weaponGroup.position.copy(camera.position); weaponGroup.rotation.set(camera.rotation.x, camera.rotation.y, 0, 'YXZ'); weaponGroup.updateMatrixWorld(true);
                const rc = cropOf();
                __frame();
                const px = __crop(rc[0], rc[1], rc[2], rc[3]);
                let h = 2166136261;
                for (let i = 0; i < px.length; i += 16) { h ^= px[i] ^ (px[i + 1] << 8) ^ (px[i + 2] << 16); h = Math.imul(h, 16777619) >>> 0; }
                out.crops[label] = { hash: h, luma: __luma(px), w: rc[2], h: rc[3], px: Array.from(px.subarray(0, Math.min(px.length, 4096))) };
                if (shots) out.pngs[label] = __png(px, rc[2], rc[3]);
                game.userSettings.leftHanded = false;
            };
            out.live = { src: hands.geometry.userData.v23Kind || null, grouped: !!hands.geometry.userData.v23Src, offHidden: hands.geometry.drawRange.count === hands.geometry.userData.v23Half };
            for (const id of cropAgents) {
                agentSystem.selectAgent(id);
                shot(id, false);
                shot(id + '-left', true);
            }
            __identity(false);
            shot('off', false);
            out.offState = { mat: hands.material.color.getHexString(), grouped: !!hands.geometry.userData.v23Src };
            __identity(true);
            return out;
        }, [cropAgents, kind, !!SHOTS]);
        assert.equal(r.live.src, kind, `${quality}: the hands draw the grouped ${kind} variant`);
        assert.ok(r.live.offHidden, `${quality}: the off-hand stays hidden across the tier swap (drawRange reapplied)`);
        assert.equal(r.offState.grouped, false, `${quality}: identity off draws V2.2's own hands geometry`);
        const off = r.crops.off;
        for (const id of cropAgents) {
            for (const label of [id, id + '-left']) {
                const c = r.crops[label];
                assert.ok(c.w >= 8 && c.h >= 8, `${quality} ${label}: a crop`);
                assert.notEqual(c.hash, off.hash, `${quality} ${label}: the agent's hands and arms differ from the identity-off picture`);
                if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); fs.writeFileSync(path.join(SHOTS, `crop-${kind}-${label}.png`), Buffer.from(r.pngs[label].split(',')[1], 'base64')); }
            }
            hashes[kind + ':' + id] = r.crops[id].hash;
        }
        if (SHOTS) fs.writeFileSync(path.join(SHOTS, `crop-${kind}-off.png`), Buffer.from(r.pngs.off.split(',')[1], 'base64'));
        if (cropAgents.includes('sage') && cropAgents.includes('omen')) assert.notEqual(r.crops.sage.hash, r.crops.omen.hash, `${quality}: Sage and Omen look different`);
        const [programs, watermark, stalls] = await programState(page);
        assert.equal(programs, watermark, `${quality}: programs == watermark`);
        assert.equal(stalls, 0, `${quality}: no stalls`);
    }
    await evaluate(() => { setQualitySettings('medium'); V23.fp.offHand(game.weapons.pistol.model, false); });
    await frames(4);
    const shown = await evaluate(() => { const h = game.weapons.pistol.model.children.find((c) => c.userData.isHands); return [h.geometry.drawRange.start, h.geometry.drawRange.count]; });
    assert.deepEqual(shown, [0, Infinity], 'offHand(false) draws both hands again');

    // ---- 6. identity off: the V2.2 hands, no arms, V2.2's castFX and pose ---------------------------------------------------
    const off = await evaluate(() => {
        __identity(false);
        agentSystem.selectAgent('sage');
        const st = V23.fp.state, out = { applied: st.applied, models: [] };
        for (const m of st.models) {
            const model = game.weapons[m.slot].model, hands = model.children[m.handsIndex];
            out.models.push({ slot: m.slot, skin: hands.material.color.getHexString(), single: !Array.isArray(hands.material), v22Geom: !hands.geometry.userData.v23Src, armHidden: !m.arm || !m.arm.visible });
        }
        const lin = __lin(0xffdbac);
        out.skin = lin.getHexString();
        out.castHand = castFX.hand.material === game.weapons.rifle.model.children.find((c) => c.userData.isHands).material && !castFX.hand.geometry.userData.v23Half;
        out.castSleeve = !Array.isArray(castFX.sleeve.material) && castFX.sleeve.position.length() === 0 && castFX.sleeve.quaternion.w === 1;
        out.extrasHidden = !st.hand2.visible && !st.castDetail.visible;
        castFX.start('cast', '#38f6ff', 'sage.c');
        out.pose = V23.fp.pose(castFX, 'cast', 0.3, performance.now(), null);
        out.cur = st.cur;
        if (castFX.active) { castFX.active = null; castFX.hide(); }
        __identity(true);
        out.back = st.applied;
        return out;
    });
    assert.equal(off.applied, false);
    for (const m of off.models) assert.deepEqual([m.skin, m.single, m.v22Geom, m.armHidden], [off.skin, true, true, true], `${m.slot}: 0xffdbac V2.2 hands, no arms`);
    assert.ok(off.castHand && off.castSleeve && off.extrasHidden, 'castFX is V2.2\'s (hand, sleeve, no hand2 or detail)');
    assert.equal(off.pose, null, 'V2.2\'s cast pose runs');
    assert.equal(off.cur, null, 'no V2.3 gesture');
    assert.equal(off.back, true, 'identity on again');
    const [programs, watermark, stalls] = await programState(page);
    assert.equal(programs, watermark, 'no shader compiled after the warm-up');
    assert.equal(stalls, 0, 'no first-use stalls');
    assert.deepEqual(errors, []);
});
