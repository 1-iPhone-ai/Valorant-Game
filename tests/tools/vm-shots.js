#!/usr/bin/env node
'use strict';
// V2.3 (WP5): vm-shots.js, weapon-animation screenshots (a tool, not a test). It boots the game like tests/harness.js
// (SwiftShader, three.js from node_modules, every other request blocked) at deviceScaleFactor 2, and for each agent and
// gun freezes weapon clips at chosen progress points and takes a screenshot of each (the HUD hidden, bots frozen):
//   <gun>-tac@p      a tactical reload (ammo 1) frozen at p (0.3: the magazine in the off hand mid-swap)
//   <gun>-empty@p    an empty reload (ammo 0) frozen at p
//   <gun>-drop       an empty reload played past its drop, then the view tipped down at the magazine on the floor
//   <gun>-draw@p     the draw from another slot frozen at p (p < 0.3: the holster ghost sinking beside it)
//   <gun>-inspect@p  the inspect frozen at p (p > 0.8: the agent's flourish)
// A clip is frozen by stretching it (vmAnim.clip.dur, and the holster ghost's own timer) so its progress stands still
// while the game keeps rendering.
// Usage (from the repository root, NODE_PATH=tests/node_modules):
//   node tests/tools/vm-shots.js [--agents sage,omen] [--guns vandal,classic] [--views tac@0.3,empty@0.5,drop,draw@0.15,inspect@0.3]
//        [--out <dir>] [--quality medium] [--width 640 --height 360] [--ea] [--lefty] [--classic]
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
const GUNS = String(args.guns || 'vandal,classic').split(',');
const VIEWS = String(args.views || 'tac@0.3,empty@0.45,drop,draw@0.15,inspect@0.3,inspect@0.9').split(',');
const OUT = path.resolve(args.out || path.join(REPO, 'vm-shots'));
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
    await page.evaluate(([q, ea, lefty, classic]) => {
        setQualitySettings(q);
        window.updateEnemies = () => {};
        Element.prototype.requestPointerLock = function () {};
        document.exitPointerLock = function () {};
        try { tacticalEnhancements.toggleWingmanAI(false); } catch (e) {}
        game.userSettings.infiniteAmmo = false;
        game.userSettings.leftHanded = !!lefty;
        game.userSettings.weaponAnims = classic ? 'classic' : 'v23';
        enhancedAnim.set(!!ea);
        document.getElementById('ui-root').style.visibility = 'hidden';
        const cc = characterController;
        cc.position.set(0, cc.standHeight, 22); cc.prevSimPosition.copy(cc.position); camera.position.copy(cc.position);
        camera.rotation.set(-0.05, 0, 0, 'YXZ'); if (cc.targetRotation) { cc.targetRotation.x = -0.05; cc.targetRotation.y = 0; }
    }, [args.quality || 'medium', !!args.ea, !!args.lefty, !!args.classic]);
    await frames(12);
    const shot = async (name) => { await frames(4); await page.screenshot({ path: path.join(OUT, name + '.png') }); console.log('wrote', name + '.png'); };
    const look = async (pitch) => page.evaluate((pt) => { camera.rotation.set(pt, 0, 0, 'YXZ'); const cc = characterController; if (cc.targetRotation) { cc.targetRotation.x = pt; cc.targetRotation.y = 0; } }, pitch);
    const clear = async () => {
        await page.evaluate(() => {
            if (castFX.active) { castFX.active = null; castFX.hide(); }
            if (vmAnim.clip) vmAnim.finishClip(game.weapons[game.activeWeapon]);
            if (typeof cancelReload === 'function') cancelReload();
            game.reloading = false;
        });
        await look(-0.05);
        await frames(3);
    };
    for (const agent of AGENTS) {
        await page.evaluate((a) => agentSystem.selectAgent(a), agent);
        await frames(4);
        for (const gun of GUNS) {
            for (const view of VIEWS) {
                const [kind, ps] = view.split('@');
                const p = ps === undefined ? null : +ps;
                await clear();
                await page.evaluate((g) => { equipGun(g); }, gun);
                await page.waitForFunction(() => !vmAnim.clip, null, { timeout: 120000, polling: 50 });
                await frames(6);
                const name = agent + '-' + gun + '-' + kind + (p === null ? '' : '@' + p) + (args.lefty ? '-lefty' : '') + (args.ea ? '-ea' : '') + (args.classic ? '-classic' : '');
                if (kind === 'tac' || kind === 'empty') {
                    await page.evaluate(([k, p]) => {
                        const w = game.weapons[game.activeWeapon];
                        w.ammo = k === 'empty' ? 0 : 1; game.reloading = false;
                        reload();
                        const c = vmAnim.clip; c.dur = 1e8; c.start = performance.now() - p * 1e8;
                    }, [kind, p]);
                    await frames(3);
                    await shot(name);
                } else if (kind === 'drop') {
                    await page.evaluate(() => { const w = game.weapons[game.activeWeapon]; w.ammo = 0; game.reloading = false; reload(); });
                    await page.waitForFunction(() => V23.vm.state.alive > 0, null, { timeout: 120000, polling: 50 });
                    await page.waitForFunction(() => !vmAnim.clip, null, { timeout: 120000, polling: 50 });
                    // a step back from where it fell, looking down at it (it lies about 0.4 m in front of the feet)
                    await page.evaluate(() => {
                        const cc = characterController;
                        cc.position.z += 0.7; cc.prevSimPosition.copy(cc.position); camera.position.copy(cc.position);
                    });
                    await look(-0.95);
                    await frames(20);
                    await shot(name);
                    await page.evaluate(() => {
                        const cc = characterController;
                        cc.position.z -= 0.7; cc.prevSimPosition.copy(cc.position); camera.position.copy(cc.position);
                    });
                } else if (kind === 'draw') {
                    await page.evaluate(([p]) => {
                        const from = game.activeWeapon === 'pistol' ? 'rifle' : 'pistol';
                        switchWeapon(from);
                        if (vmAnim.clip) vmAnim.finishClip(game.weapons[from]);
                        const to = GUN_DEFS[game.weapons[from].gunId] ? null : null;
                        return to;
                    }, [p]);
                    await frames(8);
                    await page.evaluate(([g, p]) => {
                        const slot = GUN_DEFS[g] ? GUN_DEFS[g].slot : 'knife';
                        switchWeapon(slot);
                        const c = vmAnim.clip; c.dur = 1e8; c.start = performance.now() - p * 1e8;
                        const G = V23.vm._ghost; if (G && G.model) { G.dur = 0.3 * 1e8; G.start = c.start; }
                    }, [gun, p]);
                    await frames(3);
                    await shot(name);
                } else if (kind === 'inspect') {
                    await page.evaluate(([p]) => {
                        inspectWeapon();
                        const c = vmAnim.clip; c.dur = 1e8; c.start = performance.now() - p * 1e8;
                    }, [p]);
                    await frames(3);
                    await shot(name);
                }
            }
        }
    }
    await clear();
    // V2.3: the harness's programState: the program count, the warm-up's watermark and perfTelemetry.firstUseStalls (a
    // frame that compiled a program after the warm-up); the run fails unless programs equal the watermark with 0 stalls
    const st = await page.evaluate(() => ({ programs: renderer.info.programs.length, watermark: perfTelemetry.programWatermark, stalls: perfTelemetry.firstUseStalls }));
    console.log('programs', st.programs, 'watermark', st.watermark, 'stalls', st.stalls, 'errors', JSON.stringify(errors));
    await browser.close();
    if (st.programs !== st.watermark || !(st.stalls === 0)) {
        console.error(`vm-shots: programs ${st.programs} != watermark ${st.watermark} or stalls ${st.stalls} > 0`);
        process.exit(2);
    }
})().catch((e) => { console.error(e); process.exit(1); });
