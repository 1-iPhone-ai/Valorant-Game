'use strict';
// V2.3 (WP5): weapon animations (design 8; setting weaponAnims 'v23' | 'classic'). One boot. For every gun in GUN_ORDER
// and the knife: tactical and empty reloads that differ and are deterministic at ammo 1, exact rest (magRestY,
// slideRestZ, the sniper magazine's matrixAutoUpdate), the magazine out of the gun into the off hand and back, the
// support hand taken away and given back (WP4's V23.fp.offHand), the reload hand never faster than 0.08 per 16 ms frame;
// magFX (rises, capped per tier after 20 reloads, round-robin; finishClip and cancelReload end the clip's pending drop,
// while magazines already on the floor live out their 6 s; a settled one uploads nothing); a cancelled reload never
// refills and switching is refused mid-reload; the draw stays 380 / 280 ms with a holster ghost a shot snaps away;
// inspects last 2400 ms, differ per class (and by agent at the flourish) and end on ADS, a cast and a shot; the sway holds
// while a V2.3 clip runs (not under 'classic'); the slide stays locked back after the last shot (Classic, Frenzy, Ghost,
// Bandit; not the Sheriff, not 'classic') until a refill; the spare magazine is the live one (its geometry and material)
// at its kit scale; ADS positions unchanged; 'classic' equals the V2.2 clips (the hooks with V23.vm absent) and shows
// none of V2.3's objects; no Math.random inside V23.vm; no first-use upload in play (the boot agent, and an agent picked
// after boot once WP4's own first use is out of the way); programs == watermark, 0 stalls.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser, programState } = require('./harness');

after(closeBrowser);

// Steps the viewmodel animator by hand (synchronously): base placement, offsets, the gun pose, then V23.vm.step (the
// reload hand, drops, magFX, the ghost, the slide lock), as animate does
const VM = `
    window.__vm = (t0, t1, sample) => {
        for (let t = t0; t <= t1; t += 16) {
            applyWeaponBobbing(t, false);
            if (V23.vm) V23.vm.step(0.016, t);
            if (sample) sample(t, game.weapons[game.activeWeapon].model);
        }
    };
    window.__rest = () => {
        const L = vmAnim.last, B = enhancedAnim.on ? eaFP.breath : { py: 0, rx: 0 };
        return Math.abs(L.px) + Math.abs(L.py - B.py) + Math.abs(L.pz) + Math.abs(L.rx - B.rx) + Math.abs(L.ry) + Math.abs(L.rz);
    };
    window.__path = (keyOf) => {
        const out = [];
        return { out, sample: (t, m) => { const k = keyOf(t); if (k !== null) out.push([vmAnim.last.px, vmAnim.last.py, vmAnim.last.pz, vmAnim.last.rx, vmAnim.last.ry, vmAnim.last.rz].map((x) => +x.toFixed(4))); } };
    };
`;

test('weapon animations: every gun and the knife, reloads, magFX, draws, holster ghost, inspects, classic = V2.2', { timeout: 240000 }, async () => {
    const { page, errors, frames, evaluate } = await boot({ quality: 'medium', initScript: () => {
        // headless pointer lock leaks renderer memory when play resumes many times
        Element.prototype.requestPointerLock = function () {};
        document.exitPointerLock = function () {};
    } });
    await page.addScriptTag({ content: VM });

    // no first-use upload in play (first, as the boot agent, before anything else is shown): the first live drops into magFX
    // (a magazine and brass), the spare magazine and the shells in the hand make no new GL buffer (gl.bufferData), because
    // the warm-up drew them all. The same guns and reloads run first under 'classic' (V2.2's own first uses, e.g. a gun kit's
    // parts the first time it is shown, happen there), then under 'v23', which must add none; idle frames are the floor.
    // Each reload is stretched (its clip made 1e8 ms long) and walked through by hand, a rendered frame at each of 7
    // points (the hand out, the drops at 0.2 and 0.24, the magazine or the shells in the hand, the release), so every
    // part of it is drawn however slow the frames are; then it runs out.
    const bufferData = () => evaluate(() => perfTelemetry.glBufferDataCalls);
    await evaluate(() => perfTelemetry.instrumentGL());
    const idle0 = await bufferData();
    await frames(20);
    const idle = (await bufferData()) - idle0;
    const walk = async (mode, list) => {
        const seen = { drops: 0, alive: 0, spare: false, shells: false, hand: false };
        const d0 = await evaluate(() => V23.vm.state.stats.drops);
        for (const [gun, ammo] of list) {
            await evaluate(([g, a, m]) => {
                game.userSettings.weaponAnims = m; game.userSettings.infiniteAmmo = false; window.updateEnemies = () => {};
                if (vmAnim.clip) vmAnim.finishClip(game.weapons[game.activeWeapon]);
                game.reloading = false; equipGun(g);
                if (vmAnim.clip) vmAnim.finishClip(game.weapons[game.activeWeapon]);
                const w = game.weapons[game.activeWeapon]; w.ammo = a; reload();
                const c = vmAnim.clip; c.dur = 1e8; window.__walk = c;
            }, [gun, ammo, mode]);
            // (what the last frame drew is read as the next point is set)
            const at = (p) => evaluate((p) => {
                const R = V23.vm.state.slots[game.activeWeapon];
                const st = { alive: V23.vm.state.alive, spare: !!(R && R.spare.visible), shells: !!(R && R.shells[0].visible), hand: V23.vm.state.handOn };
                if (p !== null) __walk.start = performance.now() - p * 1e8;
                return st;
            }, p);
            const PTS = [0.1, 0.25, 0.35, 0.5, 0.65, 0.8, 0.9];
            for (let i = 0; i <= PTS.length; i++) {
                const st = await at(i < PTS.length ? PTS[i] : null);
                if (i > 0) { seen.alive = Math.max(seen.alive, st.alive); seen.spare = seen.spare || st.spare; seen.shells = seen.shells || st.shells; seen.hand = seen.hand || st.hand; }
                if (i < PTS.length) await frames(1);
            }
            // the clip runs out (its refill timer may have fired already: the clip is the animator's, not the reload's)
            await evaluate(() => { if (vmAnim.clip === __walk) __walk.start = performance.now() - 1e8; });
            await frames(4);
            await evaluate(() => { game.reloading = false; });
        }
        seen.drops = (await evaluate(() => V23.vm.state.stats.drops)) - d0;
        seen.alive = Math.min(seen.alive, 1);   // (seen alive while drawn; how many at once depends on the frames' pace)
        return seen;
    };
    const UPLOAD_SET = [['vandal', 0], ['bucky', 3], ['outlaw', 0]];
    const uploads = {}, seen = {};
    for (const mode of ['classic', 'v23']) {
        const b0 = await bufferData();
        seen[mode] = await walk(mode, UPLOAD_SET);
        uploads[mode] = (await bufferData()) - b0;
    }
    assert.deepEqual(seen.v23, { drops: 2, alive: 1, spare: true, shells: true, hand: true }, 'the walk drew the drops, the spare magazine, the shells and the hand');
    assert.deepEqual(seen.classic, { drops: 0, alive: 0, spare: false, shells: false, hand: false }, "'classic' draws none of them");
    assert.ok(uploads.v23 <= idle, `no new GL buffer for the drops, the spare magazine and the shells (v23 ${uploads.v23}, classic ${uploads.classic}, idle ${idle})`);
    // an agent picked after boot: its first V2.3 reload draws WP4's support-forearm halves and its cast hand for the first
    // time (WP4's first use, logged: a gap of WP4's, V23.fp.reapply does not draw them at the agent change); after that,
    // V2.3's reloads add nothing (the magFX meshes, spare magazines and shells are the same for every agent)
    const other = await evaluate(() => { const a = game.activeAgent === 'omen' ? 'sage' : 'omen'; agentSystem.selectAgent(a); return a; });
    await frames(6);
    let b1 = await bufferData();
    await walk('v23', [['vandal', 1]]);
    const wp4First = (await bufferData()) - b1;
    b1 = await bufferData();
    seen.after = await walk('v23', UPLOAD_SET);
    uploads.afterAgent = (await bufferData()) - b1;
    assert.ok(uploads.afterAgent <= idle, `an agent picked after boot (${other}): no new GL buffer from V2.3's reloads (${uploads.afterAgent}, idle ${idle})`);
    console.log('V23WP5UPLOADS ' + JSON.stringify({ idle, classic: uploads.classic, v23: uploads.v23, agent: other, wp4FirstUse: wp4First, afterAgent: uploads.afterAgent }));

    const r = await evaluate(() => {
        window.updateEnemies = () => {};
        window.presentPlayerCamera = () => {};
        game.userSettings.infiniteAmmo = false;
        game.userSettings.weaponAnims = 'v23';
        game.userSettings.leftHanded = false;
        enhancedAnim.set(false);
        agentSystem.selectAgent('sage');
        const out = { guns: {}, errs: [] };
        const cc = characterController;
        cc.position.set(0, cc.standHeight, 22); cc.velocity.set(0, 0, 0); camera.position.copy(cc.position); camera.rotation.set(0, 0, 0, 'YXZ');
        // Math.random calls while a V23.vm function runs (there must be none)
        let inVm = 0, vmRandom = 0;
        const real = Math.random;
        Math.random = function () { if (inVm) vmRandom++; return real.call(Math); };
        for (const k of Object.keys(V23.vm)) {
            const f = V23.vm[k];
            if (typeof f !== 'function') continue;
            V23.vm[k] = function () { inVm++; try { return f.apply(this, arguments); } finally { inVm--; } };
        }
        let T = performance.now() + 10000;
        const take = (gun) => {
            if (gun === 'knife') switchWeapon('knife'); else { applyGunDef(gun); switchWeapon(GUN_DEFS[gun].slot); }
            __vm(T, T + 500); T += 516;   // the draw ends
            game.reloading = false;
        };
        const settle = () => { __vm(T, T + 1600); T += 1616; };
        const slotOf = (gun) => gun === 'knife' ? 'knife' : GUN_DEFS[gun].slot;
        // one reload, stepped through; its path (every 10%), the phases, the hand and the parts
        const reloadOnce = (gun, ammo) => {
            const slot = slotOf(gun), w = game.weapons[slot];
            w.ammo = ammo; game.reloading = false;
            const alive0 = V23.vm.state.alive, drops0 = V23.vm.state.stats.drops;
            reload();
            const c = vmAnim.clip;
            const res = { kind: c && c.kind, empty: c && c.empty, dur: c && c.dur, phases: '', hand: false, spare: false, off: false, magHid: false, handMax: 0, handAt: -1 };
            c.start = T;
            const R = V23.vm.state.slots[slot];
            const path = __path((t) => { const p = (t - T) / c.dur; return p > 0 && p < 1 && Math.round(p * 100) % 10 === 0 ? 1 : null; });
            let last = '', hp = null;
            __vm(T, T + c.dur + 200, (t, m) => {
                path.sample(t, m);
                const ph = V23.vm.state.clip ? V23.vm.state.phase : '-';
                if (ph !== last) { res.phases += ph; last = ph; }
                if (V23.vm.state.handOn && castFX.group.visible) res.hand = true;
                // the reload hand's move this frame (castFX.group in the viewmodel's space)
                const g = castFX.group;
                if (V23.vm.state.handOn && g.visible) {
                    if (hp) { const d = Math.hypot(g.position.x - hp[0], g.position.y - hp[1], g.position.z - hp[2]); if (d > res.handMax) { res.handMax = +d.toFixed(4); res.handAt = +((t - T) / c.dur).toFixed(3); } }
                    hp = [g.position.x, g.position.y, g.position.z];
                } else hp = null;
                if (R && R.spare.visible) res.spare = true;
                if (V23.vm.state.offModel === w.model) res.off = true;
                if (R && R.mag && !R.mag.visible) res.magHid = true;
            });
            T += c.dur + 216;
            game.reloading = false;
            settle();
            res.path = JSON.stringify(path.out);
            res.drops = V23.vm.state.stats.drops - drops0;
            res.alive = V23.vm.state.alive - alive0;
            res.rest = __rest();
            res.clipAfter = vmAnim.clip ? vmAnim.clip.kind : null;
            res.mag = R && R.mag ? R.mag.position.distanceTo(R.restP) + (R.mag.visible ? 0 : 1) + (R.mag.quaternion.angleTo(R.restQ)) + (R.mag.matrixAutoUpdate === R.mau ? 0 : 1) : 0;
            res.magRestY = w.magazine && w.magRestY !== undefined ? Math.abs(w.magazine.position.y - w.magRestY) : 0;
            res.slide = w.slide && w.slideRestZ !== undefined ? Math.abs(w.slide.position.z - w.slideRestZ) : 0;
            res.after = { off: V23.vm.state.offModel, hand: castFX.group.visible, spare: R ? R.spare.visible : false };
            return res;
        };
        // ---- every gun: tactical twice (deterministic at ammo 1), empty, inspect, draw ----------------------------------
        for (const gun of GUN_ORDER.concat(['knife'])) {
            take(gun);
            const g = out.guns[gun] = {};
            if (gun !== 'knife') {
                g.tac = reloadOnce(gun, 1);
                g.tac2 = reloadOnce(gun, 1);
                g.empty = reloadOnce(gun, 0);
                g.cls = GUN_DEFS[gun].cls;
            } else {
                // the knife's R: its 560 ms flourish under the reload lock
                const w = game.weapons.knife;
                game.reloading = false;
                reload();
                g.flourish = { kind: vmAnim.clip.kind, dur: vmAnim.clip.dur, locked: game.reloading };
                vmAnim.clip.start = T;
                const path = __path((t) => Math.round((t - T) / 56) % 1 === 0 && t - T < 560 ? 1 : null);
                __vm(T, T + 760, path.sample); T += 776;
                game.reloading = false;
                g.flourish.path = JSON.stringify(path.out);
                settle();
                g.flourish.rest = __rest();
                g.cls = 'knife';
            }
            // the inspect: 2400 ms, its path
            game.reloading = false;
            inspectWeapon();
            const c = vmAnim.clip;
            g.inspect = { kind: c.kind, dur: c.dur };
            c.start = T;
            const ip = __path((t) => { const p = (t - T) / 2400; return p > 0 && p < 1 && Math.round(p * 100) % 5 === 0 ? 1 : null; });
            __vm(T, T + 2600, ip.sample); T += 2616;
            settle();
            g.inspect.path = JSON.stringify(ip.out);
            g.inspect.rest = __rest();
            g.inspect.after = vmAnim.clip ? vmAnim.clip.kind : null;
        }
        // ---- determinism and the agent: Omen's flourish differs from Sage's; the same agent repeats exactly ---------------
        take('vandal');
        const inspectPath = () => {
            inspectWeapon();
            const c = vmAnim.clip; c.start = T;
            const ip = __path((t) => { const p = (t - T) / 2400; return p > 0.8 && p < 1 && Math.round(p * 100) % 2 === 0 ? 1 : null; });
            __vm(T, T + 2600, ip.sample); T += 2616; settle();
            return JSON.stringify(ip.out);
        };
        out.flourish = { sage: inspectPath(), sage2: inspectPath() };
        agentSystem.selectAgent('omen');
        out.flourish.omen = inspectPath();
        agentSystem.selectAgent('sage');
        // ---- inspects end on ADS, a cast and a shot ---------------------------------------------------------------------
        const ends = {};
        inspectWeapon(); vmAnim.clip.start = T; __vm(T, T + 300); T += 316;
        game.adsActive = true; __vm(T, T + 32); T += 48; ends.ads = vmAnim.clip ? vmAnim.clip.kind : null;
        game.adsActive = false; game.adsProgress = 0; settle();
        inspectWeapon(); vmAnim.clip.start = T; __vm(T, T + 300); T += 316;
        castFX.start('cast', 0x34d399, 'sage.q'); ends.cast = vmAnim.clip ? vmAnim.clip.kind : null;
        castFX.active = null; castFX.hide(); settle();
        inspectWeapon(); vmAnim.clip.start = T; __vm(T, T + 300); T += 316;
        const w0 = game.weapons.rifle; w0.ammo = 10; game.lastShot = 0; game.reloading = false;
        shoot(); ends.shot = vmAnim.clip ? vmAnim.clip.kind : null;
        settle();
        out.ends = ends;
        // ---- the sway holds while a V2.3 clip runs (a draw, an inspect); under 'classic' it sways as V2.2 does ----------
        const sway = {};
        for (const mode of ['classic', 'v23']) {
            game.userSettings.weaponAnims = mode;
            const m = game.weapons.rifle.model;
            const sw = () => {
                const x0 = m.rotation.x, z0 = m.rotation.z;
                for (let i = 0; i < 10; i++) applyWeaponSway(4000, 4000);
                const d = [+(m.rotation.x - x0).toFixed(6), +(m.rotation.z - z0).toFixed(6), vmAnim.clip ? vmAnim.clip.kind : null];
                m.rotation.x = x0; m.rotation.z = z0;   // the classic sway's turn taken back (nothing else would)
                return d;
            };
            take('classic');
            applyGunDef('vandal'); switchWeapon('rifle'); vmAnim.clip.start = T; __vm(T, T + 100); T += 116;
            const r = { draw: sw() };
            settle();
            game.reloading = false; inspectWeapon(); vmAnim.clip.start = T; __vm(T, T + 300); T += 316;
            r.inspect = sw();
            __vm(T, T + 2400); T += 2416; settle();
            sway[mode] = r;
        }
        game.userSettings.weaponAnims = 'v23';
        out.sway = sway;
        // ---- the slide locked back after the last shot, until a refill (shoot reloads on the next pull, not this one) ---
        const lock = {};
        for (const mode of ['v23', 'classic']) {
            game.userSettings.weaponAnims = mode;
            for (const gun of ['classic', 'frenzy', 'ghost', 'bandit', 'sheriff']) {
                take(gun);
                const w = game.weapons.pistol;
                w.ammo = 1; game.lastShot = 0; game.reloading = false;
                shoot();
                const ammo = w.ammo;
                __vm(T, T + 200); T += 216;
                const locked = V23.vm.state.locked, reloading = game.reloading;
                w.ammo = w.maxAmmo;   // a refill
                __vm(T, T + 200); T += 216;
                lock[mode + '.' + gun] = [ammo, reloading, locked, V23.vm.state.locked];
                settle();
            }
        }
        game.userSettings.weaponAnims = 'v23';
        out.lock = lock;
        // ---- the spare magazine is the live one: its geometry and material, at its kit scale ----------------------------
        // (another geometry and material put in the magazine's place for the check, both already drawn; nothing is
        // rendered here, and both go back)
        const spare = {};
        for (const gun of ['spectre', 'odin', 'vandal']) {
            take(gun);
            const w = game.weapons.rifle, R = V23.vm.state.slots.rifle, mag = R.mag, g0 = mag.geometry, m0 = mag.material;
            const otherMat = w.model.children.find((c) => c.isMesh && c !== mag && !c.userData.isHands && c.material && c.material !== m0).material;
            mag.geometry = V23.vm.state.slots.pistol.mag.geometry; mag.material = otherMat;
            w.ammo = 1; game.reloading = false; reload(); vmAnim.clip.start = T;
            __vm(T, T + 0.3 * vmAnim.clip.dur); T += 0.3 * w.reloadTime * 1000 + 16;
            const sp = R.spare;
            spare[gun] = { visible: sp.visible, geometry: sp.geometry === mag.geometry, material: sp.material === mag.material,
                scale: Math.max(Math.abs(sp.scale.x - mag.scale.x / 1.3), Math.abs(sp.scale.y - mag.scale.y / 1.3), Math.abs(sp.scale.z - mag.scale.z / 1.3)),
                kit: [mag.scale.x, mag.scale.y, mag.scale.z] };
            cancelReload(); game.reloading = false;
            mag.geometry = g0; mag.material = m0;
            settle();
        }
        out.spare = spare;
        // ---- the draw: 380 / 280 ms, the holster ghost, a shot snaps it ---------------------------------------------------
        const draw = {};
        take('vandal');
        switchWeapon('pistol');
        draw.pistol = vmAnim.clip.dur;
        const ghostModel = V23.vm.state.ghost;
        draw.ghost = ghostModel === game.weapons.rifle.model && ghostModel.visible;
        const y0 = ghostModel ? ghostModel.position.y : 0;
        vmAnim.clip.start = T; V23.vm._ghost.start = T;
        __vm(T, T + 0.2 * 380); T += 0.2 * 380 + 16;
        draw.sinking = ghostModel ? y0 - ghostModel.position.y : 0;
        draw.stillGhost = V23.vm.state.ghost === ghostModel && ghostModel.visible;
        __vm(T, T + 300); T += 316;
        draw.ghostAfter = { ghost: V23.vm.state.ghost, visible: game.weapons.rifle.model.visible };
        settle();
        switchWeapon('rifle');
        const g2 = V23.vm.state.ghost;
        vmAnim.clip.start = T; V23.vm._ghost.start = T;
        __vm(T, T + 40); T += 56;
        const wr = game.weapons.rifle; wr.ammo = 10; game.lastShot = 0; game.reloading = false;
        shoot();
        draw.snapped = { ghost: V23.vm.state.ghost, visible: g2 ? g2.visible : null, was: g2 === game.weapons.pistol.model };
        draw.rifle = vmAnim.clip ? vmAnim.clip.dur : 380;
        settle();
        switchWeapon('knife'); draw.knife = vmAnim.clip.dur; settle();
        // a draw ended early (finishClip) puts the ghost away at once
        switchWeapon('rifle');
        const g3 = V23.vm.state.ghost;
        vmAnim.finishClip(game.weapons.rifle);
        draw.finished = { ghost: V23.vm.state.ghost, visible: g3 ? g3.visible : null, was: g3 === game.weapons.knife.model };
        settle();
        // draws per class: each its own shape
        const drawPath = (gun) => {
            take(gun === 'knife' ? 'vandal' : (GUN_DEFS[gun].slot === 'rifle' ? 'classic' : 'vandal'));
            if (gun === 'knife') switchWeapon('knife'); else { applyGunDef(gun); switchWeapon(GUN_DEFS[gun].slot); }
            const c = vmAnim.clip; c.start = T;
            const dp = __path((t) => (t - T) < c.dur ? 1 : null);
            __vm(T, T + c.dur + 100, dp.sample); T += c.dur + 116; settle();
            return { path: JSON.stringify(dp.out), rest: __rest() };
        };
        draw.byClass = {};
        for (const [cls, gun] of [['rifle', 'vandal'], ['smg', 'spectre'], ['shotgun', 'bucky'], ['pistol', 'classic'], ['sniper', 'operator'], ['heavy', 'odin'], ['knife', 'knife']]) draw.byClass[cls] = drawPath(gun);
        out.draw = draw;
        // ---- a cancelled reload never refills; switching is refused during a reload; reset ends the clip's drop ---------
        take('vandal');
        const wv = game.weapons.rifle;
        wv.ammo = 0; game.reloading = false;
        const drops0 = V23.vm.state.stats.drops;
        reload();
        vmAnim.clip.start = T;
        __vm(T, T + 0.1 * 2200); T += 0.1 * 2200 + 16;
        switchWeapon('pistol');
        out.cancel = { refused: game.activeWeapon === 'rifle', reloading: game.reloading };
        cancelReload();
        __vm(T, T + 2400); T += 2416;
        out.cancel.dropped = V23.vm.state.stats.drops - drops0;
        out.cancel.ammo = wv.ammo;
        out.cancel.mag = wv.magazine.visible && Math.abs(wv.magazine.position.y - wv.magRestY) < 1e-9;
        out.cancel.off = V23.vm.state.offModel;
        out.cancel.hand = castFX.group.visible;
        // finishClip mid-swap: the parts back, the hand released
        wv.ammo = 1; game.reloading = false; reload(); vmAnim.clip.start = T;
        __vm(T, T + 0.35 * 2200); T += 0.35 * 2200 + 16;
        out.midSwap = { spare: V23.vm.state.slots.rifle.spare.visible, magHidden: !wv.magazine.visible, off: V23.vm.state.offModel === wv.model };
        vmAnim.finishClip(wv);
        __vm(T, T + 32); T += 48;
        out.midSwap.after = { spare: V23.vm.state.slots.rifle.spare.visible, mag: wv.magazine.visible && Math.abs(wv.magazine.position.y - wv.magRestY) < 1e-9, off: V23.vm.state.offModel, hand: castFX.group.visible };
        game.reloading = false;
        settle();
        // ---- magFX: 20 empty reloads (each stepped past its drop, then cancelled), capped per tier ------------------------
        const burst = (n) => {
            let maxAlive = 0;
            for (let i = 0; i < n; i++) {
                wv.ammo = 0; game.reloading = false; reload(); vmAnim.clip.start = T;
                __vm(T, T + 0.26 * 2200, () => { maxAlive = Math.max(maxAlive, V23.vm.state.alive); }); T += 0.26 * 2200 + 16;
                cancelReload();
            }
            return maxAlive;
        };
        const mf = {};
        mf.medium = { cap: V23.vm.state.cap, max: burst(20), reused: V23.vm.state.stats.reused };
        adaptiveSettings.currentQuality = 'high';
        mf.high = { cap: V23.vm.state.cap, max: burst(20) };
        adaptiveSettings.currentQuality = 'low';
        __vm(T, T + 32); T += 48;
        mf.low = { cap: V23.vm.state.cap, aliveAfterSwitch: V23.vm.state.alive, max: burst(3) };
        adaptiveSettings.currentQuality = 'medium';
        __vm(T, T + 7000); T += 7016;
        mf.expired = V23.vm.state.alive;
        const meshes = V23.vm.state.meshes;
        mf.meshes = Object.keys(meshes).map((k) => ({ cls: k, instanced: meshes[k].isInstancedMesh, color: meshes[k].instanceColor, visible: meshes[k].visible, count: meshes[k].count, mapped: !!meshes[k].material.map, toneMapped: meshes[k].material.toneMapped }));
        // one drop, then it lands on the floor and settles flat
        wv.ammo = 0; game.reloading = false; reload(); vmAnim.clip.start = T;
        __vm(T, T + 2400); T += 2416; game.reloading = false;
        __vm(T, T + 2000); T += 2016;
        const floor = Math.max(0, cc.position.y - (cc.height || 1.7));
        const rifleMesh = meshes.rifle, M = new THREE.Matrix4(), P = new THREE.Vector3(), Q = new THREE.Quaternion(), Sc = new THREE.Vector3();
        if (rifleMesh.count) { rifleMesh.getMatrixAt(0, M); M.decompose(P, Q, Sc); }
        mf.landed = { count: rifleMesh.count, y: P.y - floor, visible: rifleMesh.visible };
        // a settled magazine uploads nothing (about 4 s old here); its last half second fades (uploads), then it is gone
        const v0 = rifleMesh.instanceMatrix.version;
        __vm(T, T + 500); T += 516;
        mf.uploads = { settled: rifleMesh.instanceMatrix.version - v0 };
        __vm(T, T + 1600); T += 1616;
        mf.uploads.fading = rifleMesh.instanceMatrix.version - v0 - mf.uploads.settled;
        mf.uploads.count = rifleMesh.count;
        out.magfx = mf;
        // ---- ADS positions unchanged after V2.3 clips -----------------------------------------------------------------
        const ads = {};
        for (const slot of ['rifle', 'sniper', 'pistol']) {
            const w = game.weapons[slot];
            ads[slot] = { hip: JSON.stringify(w.hipPos), ads: JSON.stringify(w.adsPos) };
        }
        out.ads = ads;
        // ---- left-handed, Enhanced Animations ------------------------------------------------------------------------
        take('vandal');
        out.ea = { off: reloadOnce('vandal', 1) };
        enhancedAnim.set(true);
        out.ea.on = reloadOnce('vandal', 1);
        out.ea.onEmpty = reloadOnce('vandal', 0);
        enhancedAnim.set(false);
        game.userSettings.leftHanded = true;
        take('vandal');
        let mirrored = false, side = null, lhp = null, lMax = 0;
        const wl = game.weapons.rifle;
        wl.ammo = 1; game.reloading = false; reload(); vmAnim.clip.start = T;
        const lSample = () => {
            const g = castFX.group;
            if (g.visible && g.scale.x < 0) mirrored = true;
            const e = V23.fp.state.models.find((m) => m.slot === 'rifle');
            if (e && e.offSide) side = e.offSide;
            if (V23.vm.state.handOn && g.visible) { if (lhp) lMax = Math.max(lMax, g.position.distanceTo(lhp)); lhp = g.position.clone(); } else lhp = null;
        };
        __vm(T, T + 0.3 * 2200, lSample);
        T += 0.3 * 2200 + 16;
        __vm(T, T + 2200, lSample); T += 2216; game.reloading = false; settle();
        out.lefty = { mirrored, side, rest: __rest(), handMax: lMax };
        game.userSettings.leftHanded = false;
        take('vandal');
        // ---- Agent Identity off: the same V2.3 reload with V2.2's hands and cast hand (the off-hand API works either way) -----
        game.userSettings.agentIdentity = 'off';
        V23.core.applySettings(game.userSettings, 'agentIdentity');
        out.identityOff = { tac: reloadOnce('vandal', 1), empty: reloadOnce('vandal', 0), mat: castFX.hand.material.color.getHexString() };
        game.userSettings.agentIdentity = 'on';
        V23.core.applySettings(game.userSettings, 'agentIdentity');
        take('vandal');
        // ---- 'classic' equals V2.2's clips: the same steps with V23.vm absent (every hook short-circuits) ---------------
        // both runs start at the same time on the synthetic clock (Enhanced Animations' breathing reads the absolute time)
        const TC = T + 1e6;
        const VMS = V23.vm.state;
        // V2.3's objects shown on a frame of a 'classic' run (the spare magazines, the shells in the hand, the magFX meshes,
        // the reload hand, the holster ghost): there must be none
        const extras = () => {
            let n = castFX.group.visible ? 1 : 0;
            for (const R of Object.values(VMS.slots)) n += (R.spare.visible ? 1 : 0) + (R.shells[0].visible ? 1 : 0) + (R.shells[1].visible ? 1 : 0);
            for (const m of Object.values(VMS.meshes)) n += m.visible ? 1 : 0;
            return n + (VMS.ghost ? 1 : 0);
        };
        const classicRun = () => {
            const res = {};
            let shown = 0;
            T = TC; vmAnim.lastT = TC - 16; eaFP.lastT = TC - 16;
            eaFP.reset(); eaFP.bobPh = 0; vmAnim.sprint = 0; vmAnim.wasGrounded = true;
            for (const k of Object.keys(vmAnim.sp)) vmAnim.sp[k] = 0;
            for (const [gun, ammo] of [['vandal', 1], ['classic', 1], ['operator', 1], ['bucky', 3], ['odin', 0]]) {
                take(gun);
                const w = game.weapons[GUN_DEFS[gun].slot];
                w.ammo = ammo; game.reloading = false; reload();
                const c = vmAnim.clip; c.start = T;
                const p = __path(() => 1);
                __vm(T, T + c.dur + 100, (t, m) => { p.sample(t, m); p.out.push([w.magazine ? +w.magazine.position.y.toFixed(5) : 0, w.magazine ? w.magazine.visible : 0, w.slide ? +w.slide.position.z.toFixed(5) : 0]); shown += extras(); });
                T += c.dur + 116; game.reloading = false;
                res[gun] = JSON.stringify(p.out);
            }
            take('vandal');
            const both = (s) => (t, m) => { s(t, m); shown += extras(); };
            inspectWeapon(); vmAnim.clip.start = T;
            const ip = __path(() => 1); __vm(T, T + 2500, both(ip.sample)); T += 2516;
            res.inspect = JSON.stringify(ip.out);
            switchWeapon('knife'); vmAnim.clip.start = T;
            const kp = __path(() => 1); __vm(T, T + 300, both(kp.sample)); T += 316;
            res.draw = JSON.stringify(kp.out);
            game.reloading = false; reload(); vmAnim.clip.start = T;
            const fp = __path(() => 1); __vm(T, T + 600, both(fp.sample)); T += 616;
            res.knife = JSON.stringify(fp.out);
            game.reloading = false;
            settle();
            return [res, shown];
        };
        game.userSettings.weaponAnims = 'classic';
        for (const ea of [false, true]) {
            enhancedAnim.set(ea);
            const [a, shownA] = classicRun();
            const keep = V23.vm;
            V23.vm = undefined;
            const [b, shownB] = classicRun();
            V23.vm = keep;
            out['classicShown' + (ea ? 'EA' : '')] = [shownA, shownB];
            out['classic' + (ea ? 'EA' : '')] = Object.keys(a).map((k) => {
                if (a[k] === b[k]) return [k, true, a[k].length];
                const A = JSON.parse(a[k]), B = JSON.parse(b[k]);
                let i = 0; while (i < Math.max(A.length, B.length) && JSON.stringify(A[i]) === JSON.stringify(B[i])) i++;
                return [k, false, 'frame ' + i + ' of ' + A.length + '/' + B.length + ': ' + JSON.stringify(A[i]) + ' vs ' + JSON.stringify(B[i])];
            });
        }
        enhancedAnim.set(false);
        game.userSettings.weaponAnims = 'v23';
        out.vmRandom = vmRandom;
        Math.random = real;
        return out;
    });

    // a cancelled reload never refills, on the game's own timers (the refill timer runs out with the reload cancelled)
    const until = await evaluate(() => {
        applyGunDef('vandal'); switchWeapon('rifle'); if (vmAnim.clip) vmAnim.finishClip(game.weapons.rifle);
        game.reloading = false;
        const w = game.weapons.rifle; w.ammo = 0;
        reload();
        cancelReload();
        return performance.now() + w.reloadTime * 1000 + 400;
    });
    await page.waitForFunction((t) => performance.now() > t, until, { timeout: 120000, polling: 100 });
    assert.deepEqual(await evaluate(() => [game.weapons.rifle.ammo, game.reloading]), [0, false], 'the cancelled reload never refilled');

    // ---- every gun and the knife --------------------------------------------------------------------------------------
    const drop = { rifle: 'rifle', smg: 'rifle', heavy: 'rifle', pistol: 'pistol', sniper: 'sniper' };
    const status = [];
    for (const [gun, g] of Object.entries(r.guns)) {
        if (gun === 'knife') {
            assert.equal(g.flourish.kind, 'inspect'); assert.equal(g.flourish.dur, 560, 'the knife flourish keeps its 560 ms'); assert.ok(g.flourish.locked, 'under the reload lock');
            assert.ok(g.flourish.rest < 1e-6, `knife: back at rest (${g.flourish.rest})`);
        } else {
            for (const k of ['tac', 'tac2', 'empty']) {
                const x = g[k];
                assert.equal(x.kind, 'reload', `${gun} ${k}`);
                assert.equal(x.clipAfter, null, `${gun} ${k}: the reload ends`);
                assert.ok(x.rest < 1e-6, `${gun} ${k}: back exactly at rest (${x.rest})`);
                assert.ok(x.mag < 1e-9 && x.magRestY < 1e-9 && x.slide < 1e-9, `${gun} ${k}: magazine (${x.mag}, ${x.magRestY}) and slide (${x.slide}) back at rest`);
                assert.deepEqual([x.after.off, x.after.hand, x.after.spare], [null, false, false], `${gun} ${k}: the support hand back, the reload hand gone`);
                assert.ok(x.hand && x.off, `${gun} ${k}: the off hand does the reload (castFX up: ${x.hand}, the gun's support hand away: ${x.off})`);
                assert.ok(x.handMax < 0.08, `${gun} ${k}: the reload hand moves at most 0.08 per 16 ms frame (${x.handMax} at p ${x.handAt})`);
            }
            assert.equal(g.tac.empty, false, `${gun}: ammo 1 is tactical`);
            assert.equal(g.empty.empty, true, `${gun}: ammo 0 is empty`);
            assert.equal(g.tac.path, g.tac2.path, `${gun}: the tactical path is deterministic at ammo 1`);
            assert.notEqual(g.tac.path, g.empty.path, `${gun}: tactical and empty differ`);
            const kind = { bucky: 'shell', outlaw: 'break', marshal: 'bolt1', sheriff: 'side' }[gun] || 'mag';
            if (kind === 'mag') {
                assert.equal(g.tac.phases, 'GHG-', `${gun}: tactical: the magazine leaves into the hand and returns (${g.tac.phases})`);
                assert.equal(g.empty.phases, 'GNHG-', `${gun}: empty: the magazine drops, a fresh one comes up in the hand (${g.empty.phases})`);
                assert.ok(g.tac.spare && g.tac.magHid && g.empty.spare, `${gun}: the spare magazine shows in the hand`);
                assert.equal(g.tac.drops, 0, `${gun}: a tactical reload drops nothing`);
                assert.equal(g.empty.drops, 1, `${gun}: an empty reload drops its magazine into magFX`);
                assert.equal(g.empty.alive, 1, `${gun}: magFX count rises`);
            }
            // (reload() ejects V2.2's casing at 0.78 for every sniper-slot gun: with it, one spent shell after one barrel, two
            // after both)
            if (gun === 'outlaw') assert.deepEqual([g.tac.drops, g.empty.drops], [0, 1], 'Outlaw: the break drops the spent shells but V2.2\'s own');
            if (gun === 'sheriff') assert.deepEqual([g.tac.drops, g.empty.drops], [0, 2], 'Sheriff: the brass falls out on an empty reload');
            status.push({ gun, cls: g.cls, kind, tactical: 'ok', empty: 'ok', drops: g.empty.drops, inspect: g.inspect.dur, hand: Math.max(g.tac.handMax, g.empty.handMax) });
        }
        assert.equal(g.inspect.kind, 'inspect'); assert.equal(g.inspect.dur, 2400, `${gun}: the inspect lasts 2400 ms`);
        assert.equal(g.inspect.after, null); assert.ok(g.inspect.rest < 1e-6, `${gun}: back at rest after the inspect (${g.inspect.rest})`);
    }
    console.log('V23WP5 ' + JSON.stringify(status));
    // inspects differ per class
    const byCls = {};
    for (const g of Object.values(r.guns)) (byCls[g.cls] = byCls[g.cls] || new Set()).add(g.inspect.path);
    const classPaths = Object.values(r.guns).reduce((m, g) => { if (!m.has(g.cls)) m.set(g.cls, g.inspect.path); return m; }, new Map());
    assert.equal(new Set(classPaths.values()).size, classPaths.size, `each class inspects its own way (${[...classPaths.keys()]})`);
    assert.equal(classPaths.size, 7, 'rifle, smg, shotgun, pistol, sniper, heavy, knife');
    // per-gun accents: the guns of a class do not all inspect alike
    assert.ok(byCls.rifle.size >= 3 && byCls.pistol.size >= 3, 'per-gun inspect overrides');
    assert.equal(r.flourish.sage, r.flourish.sage2, 'the flourish repeats exactly');
    assert.notEqual(r.flourish.sage, r.flourish.omen, "the flourish is the agent's own");
    assert.deepEqual(r.ends, { ads: null, cast: null, shot: null }, 'an inspect ends on ADS, a cast and a shot');
    // the sway hold
    for (const k of ['draw', 'inspect']) {
        assert.deepEqual(r.sway.v23[k], [0, 0, k], `v23 ${k}: applyWeaponSway leaves the gun's pitch and roll alone (${JSON.stringify(r.sway.v23[k])})`);
        assert.ok(Math.abs(r.sway.classic[k][0]) > 0.1 && Math.abs(r.sway.classic[k][1]) > 0.1 && r.sway.classic[k][2] === k, `classic ${k}: the sway turns the gun as in V2.2 (${JSON.stringify(r.sway.classic[k])})`);
    }
    // the slide lock: [ammo after the shot, reloading, locked, locked after a refill]
    for (const gun of ['classic', 'frenzy', 'ghost', 'bandit']) assert.deepEqual(r.lock['v23.' + gun], [0, false, true, false], `${gun}: the slide locked back after the last shot, released by a refill`);
    assert.deepEqual(r.lock['v23.sheriff'], [0, false, false, false], 'the Sheriff has no slide lock');
    for (const gun of ['classic', 'frenzy', 'ghost', 'bandit', 'sheriff']) assert.deepEqual(r.lock['classic.' + gun], [0, false, false, false], `'classic' ${gun}: no slide lock (V2.2)`);
    // the spare magazine
    for (const [gun, x] of Object.entries(r.spare)) {
        assert.ok(x.visible && x.geometry && x.material, `${gun}: the spare magazine draws the live magazine's geometry and material (${JSON.stringify(x)})`);
        assert.ok(x.scale < 1e-9, `${gun}: at its kit scale (${x.kit}; off by ${x.scale})`);
    }
    assert.ok(r.spare.odin.kit[2] > 2 && r.spare.spectre.kit[1] > 1.4, 'the kits resize their magazines');
    // the draw
    assert.equal(r.draw.pistol, 380); assert.equal(r.draw.rifle, 380); assert.equal(r.draw.knife, 280);
    assert.ok(r.draw.ghost, 'the gun put away stays as a ghost');
    assert.ok(r.draw.sinking > 0.05 && r.draw.stillGhost, `it sinks for the first 30% (${r.draw.sinking})`);
    assert.deepEqual(r.draw.ghostAfter, { ghost: null, visible: false }, 'then it is gone');
    assert.deepEqual(r.draw.snapped, { ghost: null, visible: false, was: true }, 'a shot snaps the ghost away');
    assert.deepEqual(r.draw.finished, { ghost: null, visible: false, was: true }, 'finishClip puts the ghost away');
    const drawPaths = Object.values(r.draw.byClass).map((d) => d.path);
    assert.equal(new Set(drawPaths).size, 7, 'draws are class-shaped');
    for (const [cls, d] of Object.entries(r.draw.byClass)) assert.ok(d.rest < 1e-6, `${cls} draw: back at rest`);
    // cancel and switch
    assert.deepEqual(r.cancel, { refused: true, reloading: true, dropped: 0, ammo: 0, mag: true, off: null, hand: false }, 'a cancelled reload never refills, drops nothing and puts the parts back');
    assert.deepEqual(r.midSwap, { spare: true, magHidden: true, off: true, after: { spare: false, mag: true, off: null, hand: false } }, 'finishClip mid-swap: everything back');
    // magFX
    assert.equal(r.magfx.medium.cap, 4); assert.equal(r.magfx.high.cap, 8); assert.equal(r.magfx.low.cap, 0);
    assert.ok(r.magfx.medium.max === 4 && r.magfx.medium.reused > 0, `Medium: capped at 4, reused round-robin (${JSON.stringify(r.magfx.medium)})`);
    assert.ok(r.magfx.high.max > 4 && r.magfx.high.max <= 8, `High: up to 8 (${r.magfx.high.max})`);
    assert.deepEqual([r.magfx.low.aliveAfterSwitch, r.magfx.low.max], [0, 0], 'Low: none');
    assert.equal(r.magfx.expired, 0, 'each lives 6 s');
    console.log('V23WP5MAGFX ' + JSON.stringify({ medium: r.magfx.medium, high: r.magfx.high, low: r.magfx.low, landed: r.magfx.landed, uploads: r.magfx.uploads }));
    console.log('V23WP5FEEL ' + JSON.stringify({ sway: r.sway, lock: r.lock, spare: r.spare, lefty: r.lefty.handMax, ea: [r.ea.off.handMax, r.ea.on.handMax, r.ea.onEmpty.handMax] }));
    for (const m of r.magfx.meshes) assert.deepEqual([m.instanced, m.color, m.mapped, m.toneMapped], [true, null, false, true], `magFX ${m.cls}: instanced, no instanceColor, shellFX's program`);
    assert.ok(r.magfx.landed.count === 1 && r.magfx.landed.visible && r.magfx.landed.y > 0 && r.magfx.landed.y < 0.05, `the dropped magazine lies on the floor (${JSON.stringify(r.magfx.landed)})`);
    assert.equal(r.magfx.uploads.settled, 0, 'a settled magazine uploads nothing');
    assert.ok(r.magfx.uploads.fading > 0 && r.magfx.uploads.count === 0, `it fades over its last half second, then it is gone (${JSON.stringify(r.magfx.uploads)})`);
    // ADS
    assert.deepEqual(r.ads, {
        rifle: { hip: JSON.stringify({ x: 0.3, y: -0.3, z: -0.5 }), ads: JSON.stringify({ x: 0.0, y: -0.12, z: -0.36 }) },
        sniper: { hip: JSON.stringify({ x: 0.3, y: -0.3, z: -0.5 }), ads: JSON.stringify({ x: 0.0, y: -0.225, z: -0.32 }) },
        pistol: { hip: JSON.stringify({ x: 0.26, y: -0.28, z: -0.45 }), ads: JSON.stringify({ x: 0.0, y: -0.063, z: -0.42 }) }
    }, 'hip and ADS positions unchanged');
    // EA, left-handed
    assert.ok(r.ea.on.rest < 1e-6 && r.ea.onEmpty.rest < 1e-6, 'EA on: back at rest');
    assert.notEqual(r.ea.on.path, r.ea.off.path, 'EA adds its secondary motion');
    assert.ok(r.ea.on.hand && r.ea.on.off && r.ea.on.spare, 'EA on: the same off-hand reload');
    assert.deepEqual([r.lefty.mirrored, r.lefty.side], [true, 'R'], 'left-handed: the right hand reloads, mirrored');
    assert.ok(r.lefty.handMax > 0 && r.lefty.handMax < 0.08, `left-handed: the reload hand moves at most 0.08 per 16 ms frame (${r.lefty.handMax})`);
    for (const k of ['off', 'on', 'onEmpty']) assert.ok(r.ea[k].handMax < 0.08, `EA ${k}: the reload hand moves at most 0.08 per frame (${r.ea[k].handMax})`);
    assert.ok(r.lefty.rest < 1e-6);
    for (const k of ['tac', 'empty']) {
        const x = r.identityOff[k];
        assert.ok(x.hand && x.off && x.spare && x.rest < 1e-6 && x.mag < 1e-9, `identity off, ${k}: the V2.3 reload with V2.2's hands, back at rest`);
        assert.ok(x.handMax < 0.08, `identity off, ${k}: the reload hand moves at most 0.08 per frame (${x.handMax})`);
        assert.deepEqual([x.after.off, x.after.hand, x.after.spare], [null, false, false]);
    }
    assert.equal(r.identityOff.tac.path, r.guns.vandal.tac.path, 'identity off: the same gun path');
    // classic = V2.2
    for (const row of r.classic.concat(r.classicEA)) assert.ok(row[1], `'classic' ${row[0]}: the V2.2 clip exactly (${row[2]})`);
    assert.deepEqual([r.classicShown, r.classicShownEA], [[0, 0], [0, 0]], "'classic' shows none of V2.3's objects on any frame (spares, shells, magFX, the reload hand, the ghost)");
    assert.equal(r.vmRandom, 0, 'no Math.random inside V23.vm');
    // the viewmodel pass's draws mid-swap (p 0.3), 'v23' against 'classic' (logged for the report: the reload hand, its
    // forearm and the spare magazine are transient draws of a reload)
    const draws = await evaluate(() => {
        const count = (mode) => {
            game.userSettings.weaponAnims = mode;
            applyGunDef('vandal'); switchWeapon('rifle'); if (vmAnim.clip) vmAnim.finishClip(game.weapons.rifle);
            const w = game.weapons.rifle; w.ammo = 1; game.reloading = false; reload();
            const c = vmAnim.clip; c.dur = 1e8; const t = performance.now(); c.start = t - 0.3e8;
            updateWeaponPosition(); applyWeaponBobbing(t, false); V23.vm.step(0.016, t); syncViewmodelCamera();
            const ar = renderer.info.autoReset; renderer.info.autoReset = false; renderer.info.reset();
            renderer.render(viewmodelScene, viewmodelCamera);
            const n = renderer.info.render.calls; renderer.info.autoReset = ar;
            cancelReload(); game.reloading = false; V23.vm.step(0.016, t + 16);
            return n;
        };
        const out = { classic: count('classic'), v23: count('v23') };
        game.userSettings.weaponAnims = 'v23';
        return out;
    });
    console.log('V23WP5DRAWS ' + JSON.stringify(draws));
    const [programs, watermark, stalls] = await programState(page);
    assert.equal(programs, watermark, 'no new shader programs');
    assert.equal(stalls, 0);
    assert.deepEqual(errors, []);
});
