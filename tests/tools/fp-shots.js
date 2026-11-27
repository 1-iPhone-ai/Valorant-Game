#!/usr/bin/env node
'use strict';
// V2.3 (WP4): fp-shots.js, first-person identity screenshots (a tool, not a test). It boots the game like
// tests/harness.js (SwiftShader, three.js from node_modules, every other request blocked) but at deviceScaleFactor 2,
// and for each agent freezes a few first-person poses where the gun hands, gloves, wrists and sleeves are in view, then
// takes a screenshot of each:
//   pistol-ads     the pistol aimed down the sights (the gun hands sit below the hip-fire view, as in V2.2)
//   rifle-inspect  the rifle's inspect, turned to show its left side (p 0.2)
//   knife-inspect  the knife's inspect, mid flip (p 0.3)
//   cast-<slot>    the off-hand cast gesture just after its release key (p 0.3 of the clip)
//   ult            the ultimate's gesture at p 0.5 (hand2 up, the centre clear)
// A pose is frozen by stretching its clip (castFX.active.dur, vmAnim.clip.dur) so its progress stands still while the
// game keeps rendering. The HUD is hidden so the viewmodel shows in full; bots are frozen.
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
const VIEWS = String(args.views || 'pistol-ads,rifle-inspect,knife-inspect,cast-c,cast-q,cast-e,ult').split(',');
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
    const reset = () => page.evaluate(() => {
        if (castFX.active) { castFX.active = null; castFX.hide(); }
        if (vmAnim.clip) vmAnim.finishClip(game.weapons[game.activeWeapon]);
        setAdsState(false);
        game.ultActiveUntil = 0; game.ultAgent = null; game.ultChargesLeft = 0;
    });
    const setView = async (view) => {
        await reset();
        if (view === 'pistol-ads') {
            await page.evaluate(() => { switchWeapon('pistol'); });
            await frames(30);
            await page.evaluate(() => setAdsState(true));
            await page.waitForFunction(() => game.adsProgress === 1, null, { timeout: 120000, polling: 50 });
        } else if (view === 'rifle-inspect' || view === 'knife-inspect') {
            const w = view.split('-')[0];
            await page.evaluate((w) => { switchWeapon(w); }, w);
            await frames(30);
            await page.evaluate((p) => {
                vmAnim.play('inspect', 2400);
                const c = vmAnim.clip; c.dur = 1e8; c.start = performance.now() - p * 1e8;
            }, w === 'rifle' ? 0.2 : 0.3);
        } else if (view.startsWith('cast-') || view === 'ult') {
            const slot = view === 'ult' ? 'x' : view.slice(5);
            await page.evaluate(() => { switchWeapon('rifle'); });
            await frames(30);
            await page.evaluate(([slot, p]) => {
                if (slot === 'x') game.ultPoints = game.maxUltPoints;
                agentSystem.castAbility(slot);
                const a = castFX.active;
                if (a) { a.dur = 1e8; a.start = performance.now() - p * 1e8; }
            }, [slot, view === 'ult' ? 0.5 : 0.3]);
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
                await shot(agent + '-' + view + (off ? '-off' : ''));
            }
        }
    }
    await reset();
    const prog = await page.evaluate(() => [renderer.info.programs.length, perfTelemetry.programWatermark, perfTelemetry.firstUseStalls]);
    console.log('programs, watermark, stalls', prog.join(', '));
    console.log('page errors', errors.length ? errors : 'none');
    await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
