#!/usr/bin/env node
'use strict';
// V2.3 (WP4): fp-shots.js, first-person identity screenshots (a tool, not a test). It boots the game like
// tests/harness.js (SwiftShader, three.js from node_modules, every other request blocked) but at deviceScaleFactor 2,
// and for each agent freezes a few first-person poses where the gun hands, gloves, wrists and sleeves are in view, then
// takes a screenshot of each:
//   pistol-ads     the pistol aimed down the sights (the gun hands sit below the hip-fire view, as in V2.2)
//   rifle-ads      the rifle aimed down the sights
//   rifle-raised   the rifle raised into view, as the fp-identity crops raise the pistol (its hipPos 30 cm up and 6 cm in,
//                  pitched up 0.25 rad, for the shot only): the rifle's hands sit under the frame at the hip and in ADS
//                  (V2.2's framing), so this is the rifle view that shows its hands, wrists and sleeves
//   rifle-inspect  the rifle's inspect at p 0.45 (--inspect-p; not in the default set: the hands stay under the frame)
//   knife-inspect  the knife's inspect, mid flip (p 0.3)
//   cast-<slot>    the off-hand cast gesture just after its release key (p 0.3 of the clip; cast-<slot>@p another p)
//   ult            the ultimate's gesture at p 0.5 (hand2 up, the centre clear; ult@p another p)
// A pose is frozen by stretching its clip (castFX.active.dur, vmAnim.clip.dur) so its progress stands still while the
// game keeps rendering. The HUD is hidden so the viewmodel shows in full; bots are frozen. Between views every ability
// item still out is ended through its own update path (agent-casts' clear), so no earlier cast (a wall, a smoke) is in
// the next agent's frames.
// Usage (from the repository root, NODE_PATH=tests/node_modules):
//   node tests/tools/fp-shots.js [--agents sage,omen] [--out <dir>] [--views pistol-ads,rifle-inspect,...] [--off]
//        [--quality medium] [--width 640 --height 360]
// --off also takes each view with Agent Identity off (the V2.2 picture), named <agent>-<view>-off.png.
const path = require('path'), fs = require('fs');
const { chromium } = require('playwright');
const THREE_JS = fs.readFileSync(require.resolve('three/build/three.min.js'));
const LAUNCH_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'];
const REPO = path.resolve(__dirname, '..', '..');
const GAME = path.resolve(REPO, process.env.GAME_FILE || '(V2.3) valorant-fps.html');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) args[a.slice(2, eq)] = a.slice(eq + 1);
    else if (process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) args[a.slice(2)] = process.argv[++i];
    else args[a.slice(2)] = true;
}
const AGENTS = String(args.agents || 'sage,omen').split(',');
const VIEWS = String(args.views || 'pistol-ads,rifle-raised,knife-inspect,cast-c,cast-q,cast-e,ult').split(',');
const INSPECT_P = +(args['inspect-p'] || 0.45);
const OUT = path.resolve(args.out || path.join(REPO, 'fp-shots'));
const W = +(args.width || 640), H = +(args.height || 360);

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const browser = await chromium.launch({ args: LAUNCH_ARGS });
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    await page.addInitScript(() => { window.__skipMainMenu = true; });
    await page.route('https://cdnjs.cloudflare.com/**', (r) => r.fulfill({ body: THREE_JS, contentType: 'application/javascript' }));
    await page.route((url) => !url.href.startsWith('file:') && !url.href.startsWith('https://cdnjs.cloudflare.com'), (r) => r.abort());
    await page.goto('file://' + GAME);
    await page.waitForFunction(() => window.perfTelemetry && perfTelemetry.programWatermark > 0, null, { timeout: 240000 });
    const frames = async (n) => {
        const f0 = await page.evaluate(() => frameIndex);
        await page.waitForFunction(([f0, n]) => frameIndex >= f0 + n, [f0, n], { timeout: 180000, polling: 20 });
    };
    await page.evaluate((q) => {
        setQualitySettings(q);
        window.updateEnemies = () => {};
        Element.prototype.requestPointerLock = function () {};
        document.exitPointerLock = function () {};
        try { tacticalEnhancements.toggleWingmanAI(false); } catch (e) {}
        game.userSettings.infiniteAbilities = true;
        game.userSettings.infiniteUlt = true;
        document.getElementById('ui-root').style.visibility = 'hidden';
        // a quiet spot looking down the open range, level
        const cc = characterController;
        cc.position.set(0, cc.standHeight, 22); cc.prevSimPosition.copy(cc.position); camera.position.copy(cc.position);
        camera.rotation.set(-0.05, 0, 0, 'YXZ'); if (cc.targetRotation) cc.targetRotation.y = 0;
    }, args.quality || 'medium');
    await frames(12);
    const shot = async (name) => { await frames(4); await page.screenshot({ path: path.join(OUT, name + '.png') }); console.log('wrote', name + '.png'); };
    // every ability item still out ends through its own update path (as agent-casts' __clear does), the clips stop, the
    // rifle's hip placement is its own again
    const reset = async () => {
        await page.evaluate(() => {
            game.ultActiveUntil = 0; game.ultAgent = null; game.ultChargesLeft = 0;
            const end = (it) => { if (!it || typeof it !== 'object' || it.isObject3D) return; if ('expireAt' in it) it.expireAt = 1; if ('endTime' in it) it.endTime = 1; if ('executeAt' in it) it.executeAt = 1; };
            const A = agentSystem;
            for (const k of Object.keys(A)) {
                const v = A[k];
                if (Array.isArray(v)) { for (const it of v) if (it && typeof it === 'object' && ('inUse' in it || 'active' in it)) end(it); }
                else if (v && typeof v === 'object' && ('inUse' in v || 'active' in v)) end(v);
            }
            for (const p of A.projectiles) if (p.inUse) { p.inUse = false; p.mesh.visible = false; }
            for (const k of ['neonHighGearUntil', 'isoDoubleTapUntil', 'clovePickMeUpUntil', 'waylayLightspeedUntil', 'miksHarmonizeUntil', 'reynaDismissUntil', 'brimStimUntil']) if (typeof A[k] === 'number') A[k] = 0;
            if (castFX.active) { castFX.active = null; castFX.hide(); }
            if (vmAnim.clip) vmAnim.finishClip(game.weapons[game.activeWeapon]);
            setAdsState(false);
            if (window.__hip) { game.weapons.rifle.hipPos = window.__hip; window.__hip = null; }
            if (window.__pitch) { game.weapons.rifle.model.rotation.x -= window.__pitch; window.__pitch = 0; }
        });
        await frames(3);
    };
    const setView = async (view) => {
        await reset();
        if (view === 'pistol-ads') {
            await page.evaluate(() => { switchWeapon('pistol'); });
            await frames(30);
            await page.evaluate(() => setAdsState(true));
            await page.waitForFunction(() => game.adsProgress === 1, null, { timeout: 120000, polling: 50 });
        } else if (view === 'rifle-ads') {
            await page.evaluate(() => { switchWeapon('rifle'); });
            await frames(30);
            await page.evaluate(() => setAdsState(true));
            await page.waitForFunction(() => game.adsProgress === 1, null, { timeout: 120000, polling: 50 });
        } else if (view === 'rifle-raised') {
            await page.evaluate(() => {
                switchWeapon('rifle');
                const w = game.weapons.rifle, h = w.hipPos || { x: 0.3, y: -0.3, z: -0.5 };
                window.__hip = w.hipPos;
                w.hipPos = { x: h.x - 0.06, y: h.y + 0.3, z: h.z + 0.04 };   // for this shot only (reset puts it back)
                w.model.rotation.x += 0.25;   // outside vmAnim's offsets, so it stays until reset takes it off
                window.__pitch = 0.25;
            });
            await frames(40);
        } else if (view === 'rifle-inspect' || view === 'knife-inspect') {
            const w = view.split('-')[0];
            await page.evaluate((w) => { switchWeapon(w); }, w);
            await frames(30);
            await page.evaluate((p) => {
                vmAnim.play('inspect', 2400);
                const c = vmAnim.clip; c.dur = 1e8; c.start = performance.now() - p * 1e8;
            }, w === 'rifle' ? INSPECT_P : 0.3);
        } else if (view.startsWith('cast-') || view.startsWith('ult')) {
            // cast-<slot>[@p], ult[@p]: the clip progress to freeze at (default 0.3, the ultimate 0.5)
            const [v, at] = view.split('@');
            const slot = v === 'ult' ? 'x' : v.slice(5), p = at !== undefined ? +at : (v === 'ult' ? 0.5 : 0.3);
            await page.evaluate(() => { switchWeapon('rifle'); });
            await frames(30);
            await page.evaluate(([slot, p]) => {
                if (slot === 'x') game.ultPoints = game.maxUltPoints;
                agentSystem.castAbility(slot);
                const a = castFX.active;
                if (a) { a.dur = 1e8; a.start = performance.now() - p * 1e8; }
            }, [slot, p]);
        }
    };
    for (const agent of AGENTS) {
        for (const off of args.off ? [false, true] : [false]) {
            await page.evaluate(([agent, off]) => {
                game.userSettings.agentIdentity = off ? 'off' : 'on';
                V23.core.applySettings(game.userSettings, 'agentIdentity');
                agentSystem.selectAgent(agent);
            }, [agent, off]);
            for (const view of VIEWS) {
                await setView(view);
                await shot(agent + '-' + view.replace('@', '-p') + (off ? '-off' : ''));
            }
        }
    }
    await reset();
    const prog = await page.evaluate(() => [renderer.info.programs.length, perfTelemetry.programWatermark, perfTelemetry.firstUseStalls]);
    console.log('programs, watermark, stalls', prog.join(', '));
    console.log('page errors', errors.length ? errors : 'none');
    await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
