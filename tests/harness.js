// Shared browser harness for the regression tests.
//
// Loads the game in headless Chromium (software WebGL via SwiftShader, so no GPU
// is needed in CI). The game's Three.js r128 <script> from cdnjs is served from
// node_modules instead, and every other network request is blocked, so the tests
// are hermetic.
//
// SwiftShader is slow and can stall for seconds while it compiles shaders, so
// never wait on wall-clock time for game behaviour: use frames(n), which waits
// until the game has actually rendered n more frames.
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const GAME_FILE = path.resolve(__dirname, '..', process.env.GAME_FILE || '(V1.7) valorant-fps.html');
const THREE_JS = fs.readFileSync(require.resolve('three/build/three.min.js'));

// Autoplay is allowed so the Web Audio graph runs without a user gesture (the
// audio tests inspect the nodes the game creates; nothing needs to be heard).
const LAUNCH_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'];

let browserPromise = null;
function getBrowser() {
    if (!browserPromise) browserPromise = chromium.launch({ args: LAUNCH_ARGS });
    return browserPromise;
}

async function closeBrowser() {
    currentPage = null;
    if (browserPromise) {
        const b = await browserPromise;
        browserPromise = null;
        await b.close();
    }
}

/**
 * Opens the game and waits until initGame() (including shader warm-up) has run.
 * options.initScript: function run in the page before any game script.
 * options.quality: graphics profile to force (default 'medium'); pass null to keep Auto.
 * options.menu: true to keep the start screen (it is skipped by default).
 * Returns { page, errors, frames, evaluate }.
 */
// Only one game runs at a time: a page left open keeps its render loop going
// and slows every later test (SwiftShader shares the CPU).
let currentPage = null;

async function boot(options = {}) {
    const browser = await getBrowser();
    if (currentPage) { await currentPage.close().catch(() => {}); currentPage = null; }
    const page = await browser.newPage({ viewport: options.viewport || { width: 480, height: 270 } });
    currentPage = page;
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    // The start screen pauses the game: tests start in play unless they ask for the menu
    if (!options.menu) await page.addInitScript(() => { window.__skipMainMenu = true; });
    if (options.initScript) await page.addInitScript(options.initScript, options.initArg);
    await page.route('https://cdnjs.cloudflare.com/**', (r) => r.fulfill({ body: THREE_JS, contentType: 'application/javascript' }));
    await page.route((url) => !url.href.startsWith('file:') && !url.href.startsWith('https://cdnjs.cloudflare.com'), (r) => r.abort());
    await page.goto('file://' + GAME_FILE);
    await page.waitForFunction(() => window.perfTelemetry && perfTelemetry.programWatermark > 0, null, { timeout: 180000 });

    const frames = async (n = 1) => {
        const f0 = await page.evaluate(() => frameIndex);
        await page.waitForFunction(([f0, n]) => frameIndex >= f0 + n, [f0, n], { timeout: 120000, polling: 20 });
    };
    const quality = options.quality === undefined ? 'medium' : options.quality;
    if (quality) {
        // Manual quality stops the Auto controller from switching profiles mid-test
        await page.evaluate((q) => setQualitySettings(q), quality);
        for (let i = 0; i < 3; i++) await frames(6);
    }
    return { page, errors, frames, evaluate: (fn, arg) => page.evaluate(fn, arg) };
}

/** [current program count, warm-up watermark, first-use stalls] */
function programState(page) {
    return page.evaluate(() => [renderer.info.programs.length, perfTelemetry.programWatermark, perfTelemetry.firstUseStalls]);
}

module.exports = { boot, closeBrowser, programState, GAME_FILE };
