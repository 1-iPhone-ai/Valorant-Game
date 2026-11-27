'use strict';
// V2.3 benchmark tool (DESIGN.md section 18). A command-line tool, NOT a test: CI (.github/workflows/tests.yml) runs
// `npm test`, i.e. `node --test` in tests/ with Node's default patterns (**/*.test.js, **/test/**/*.js and the like),
// none of which match tests/tools/bench.js.
//
// Run from the repository root (it uses tests/harness.js and the tests' node_modules):
//   NODE_PATH=tests/node_modules node tests/tools/bench.js --mode D --a '(V2.2) valorant-fps.html' --b '(V2.3) valorant-fps.html' --out /tmp/bench-d.json
//   NODE_PATH=tests/node_modules node tests/tools/bench.js --mode R --seconds 60 --res --out /tmp/bench-r.json
//   ... --quick            smoke check: 300 frames, 1 pair (Mode R records 300 frames)
//   ... --bOpts '{"enhancedAnim":true}'   a variant: settings applied after boot (see --help)
// Mode D (default) drives the game's frames itself on a fixed 1000/60 clock with Math.random seeded, so both
// builds render the same frames; Mode R measures the real requestAnimationFrame loop with perfTelemetry. Both play
// the same scripted route. A and B are copied at start-up and every run loads the copies; the report (--out) is
// rewritten after every run, so a failed or interrupted benchmark keeps the runs it finished.
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const harness = require(path.join(REPO, 'tests', 'harness.js'));

const HELP = `V2.3 benchmark tool (tests/tools/bench.js)

  --mode D|R        D: deterministic driver and scripted route (default); R: the real rAF loop, same route
  --a <file>        build A (default '(V2.2) valorant-fps.html'); a path from the cwd or the repository root
  --b <file>        build B (default '(V2.3) valorant-fps.html'); 'none' runs build A only
  --pairs <n>       interleaved pairs A B, B A, A B ... (default 5); each run is a fresh browser and the
                    first pair is discarded when there is more than one (--keep-first keeps it)
  --frames <n>      Mode D: route length in frames (default 3600). Mode R: record n frames instead of --seconds
  --seconds <s>     Mode R: recording time (default 60); the route's event frames are scaled to seconds x warm FPS
  --warm <n>        Mode R: frames before perfTelemetry.reset (default 300)
  --res             960x540 instead of 480x270 (dpr 1); --viewport WxH for any other size
  --aOpts/--bOpts   JSON applied after boot. Keys: enhancedAnim (bool), highDetail (bool), quality, botAbilityAI,
                    wingmen, js (code run in the page), waitFor (a page expression to wait for before starting; an
                    abilityEffects 'hifi' variant waits for High Fidelity to be built), or any game.userSettings field
                    (then settingsManager.applyAllSettings)
  --aPre/--bPre     JSON merged into the saved settings written before load (contentTierMode and the like)
  --quick           smoke check: 300 frames and 1 pair
  --out <file>      JSON report (per run, per build, ratios, the frame hashes), rewritten after every run
  --keep-going      a run that fails is recorded and the next one starts (default: stop, after writing the report)
  --run-dir <dir>   where the copies of A and B go (default <out>.builds/, or a new folder in the OS temp dir);
                    every run loads these copies, so edits to the sources during the benchmark change nothing
  --allow-load      run even while other browsers or test jobs are running (those runs are flagged)
  --wait-idle <s>   without --allow-load: how long to wait before each run for them to finish (default 600);
                    a run that still finds them is refused
  --staged n=<js>   a time-sliced builder: <js> is true while it builds (repeatable; abilityLook and ultraPrep are
                    built in). The tool waits until none builds before measuring, and labels frames where one
                    builds staged:<n>. Mode D cannot represent time-sliced work (its clock stands still inside a
                    frame, so a staged build runs whole in one frame): read those spikes in Mode R
  --gpu             launch Chromium in the tool instead of the harness: headed, on the system GPU (no SwiftShader
                    flags), with --disable-gpu-vsync --disable-frame-rate-limit; the same init scripts, routes and
                    boot steps as harness.boot. --headless keeps it headless; --chrome-arg <arg> adds an argument
  --chunk <n>       Mode D: frames per page call (default 60)
  --preroll <n>     Mode D: untimed frames driven from the setup before frame 0 (default 120), so visual state
                    left from the real-time boot frames (e.g. Enhanced Animations' blends) has settled
  --hash-every <n>  Mode D: frames between frame hashes (default frames/24, at least 15)
  --seed <n>        Math.random seed (default 20221)
  --min-health <n>  damage to you is clamped to keep this much health (default 25), except the forced death
  --trace           print where you were at each hashed frame (Mode D)
  --no-render       Mode D route check only: nothing is drawn (frame times are meaningless; hashes are state only)
  --reset-js '<js>' code run at the route's setup, to start a build's own smoothed visual state fresh
                    (the tool already does so for V2.2's Enhanced Animations); check with the frame hashes
  --probe '<js>'    Mode D: an expression evaluated at each hashed frame and stored beside the hashes (JSON), to
                    find what differs when a variant does not render the same frames twice

  Frame time. Mode D: the game's work in a driven frame = its calls made by the route (casts, fire, reload, the
  forced death) + due timers + the rAF callback + a 1-pixel readPixels, on the real clock; the tool's own steering
  is left out (routeToolMs). cbOnly is the rAF callback + readPixels alone. Mode R: perfTelemetry's frame
  intervals (vsync-quantised on this machine: see vsyncQuantized) and cpuMs (the fine-grained figure).
`;

const STALL_MS = 180000;   // a wait fails only when no frame at all is rendered for this long

// ---- options ------------------------------------------------------------------------------------------------
function parseArgs(argv) {
    const o = {
        mode: 'D', a: '(V2.2) valorant-fps.html', b: '(V2.3) valorant-fps.html', pairs: 5, frames: null, seconds: 60, warm: 300,
        viewport: { width: 480, height: 270 }, aOpts: {}, bOpts: {}, aPre: {}, bPre: {}, out: null, quick: false, chunk: 60,
        hashEvery: null, seed: 20221, minHealth: 25, trace: false, keepFirst: false, framesGiven: false, pairsGiven: false, noRender: false, preroll: 120, probe: null, resetJs: null,
        keepGoing: false, runDir: null, allowLoad: false, waitIdle: 600, staged: [], gpu: false, headless: false, chromeArgs: []
    };
    const json = (k, v) => { try { return JSON.parse(v); } catch (e) { throw new Error(k + ': not JSON: ' + v); } };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        const val = () => { if (i + 1 >= argv.length) throw new Error(k + ' needs a value'); return argv[++i]; };
        switch (k) {
            case '--mode': o.mode = val().toUpperCase(); break;
            case '--a': o.a = val(); break;
            case '--b': o.b = val(); break;
            case '--pairs': o.pairs = Math.max(1, parseInt(val(), 10)); o.pairsGiven = true; break;
            case '--frames': o.frames = Math.max(2, parseInt(val(), 10)); o.framesGiven = true; break;
            case '--seconds': o.seconds = Math.max(1, parseFloat(val())); break;
            case '--warm': o.warm = Math.max(0, parseInt(val(), 10)); break;
            case '--res': o.viewport = { width: 960, height: 540 }; break;
            case '--viewport': { const m = /^(\d+)x(\d+)$/.exec(val()); if (!m) throw new Error('--viewport WxH'); o.viewport = { width: +m[1], height: +m[2] }; break; }
            case '--aOpts': o.aOpts = json(k, val()); break;
            case '--bOpts': o.bOpts = json(k, val()); break;
            case '--aPre': o.aPre = json(k, val()); break;
            case '--bPre': o.bPre = json(k, val()); break;
            case '--quick': o.quick = true; break;
            case '--out': o.out = val(); break;
            case '--keep-going': o.keepGoing = true; break;
            case '--run-dir': o.runDir = val(); break;
            case '--allow-load': o.allowLoad = true; break;
            case '--wait-idle': o.waitIdle = Math.max(0, parseFloat(val())); break;
            case '--staged': { const v = val(), j = v.indexOf('='); if (j < 1) throw new Error('--staged name=<js>'); o.staged.push([v.slice(0, j), v.slice(j + 1)]); break; }
            case '--gpu': o.gpu = true; break;
            case '--headless': o.headless = true; break;
            case '--chrome-arg': o.chromeArgs.push(val()); break;
            case '--chunk': o.chunk = Math.max(1, parseInt(val(), 10)); break;
            case '--preroll': o.preroll = Math.max(0, parseInt(val(), 10) || 0); break;
            case '--hash-every': o.hashEvery = Math.max(1, parseInt(val(), 10)); break;
            case '--seed': o.seed = parseInt(val(), 10) || 20221; break;
            case '--min-health': o.minHealth = Math.max(1, parseInt(val(), 10)); break;
            case '--trace': o.trace = true; break;
            case '--keep-first': o.keepFirst = true; break;
            case '--no-render': o.noRender = true; break;
            case '--probe': o.probe = val(); break;
            case '--reset-js': o.resetJs = val(); break;
            case '-h': case '--help': console.log(HELP); process.exit(0); break;
            default: throw new Error('unknown option ' + k + ' (see --help)');
        }
    }
    if (o.mode !== 'D' && o.mode !== 'R') throw new Error('--mode is D or R');
    if (o.headless && !o.gpu) throw new Error('--headless goes with --gpu (the harness launch is always headless)');
    if (o.quick) { if (!o.framesGiven) o.frames = 300; if (!o.pairsGiven) o.pairs = 1; }
    if (o.mode === 'D' && !o.frames) o.frames = 3600;
    if (!o.hashEvery) o.hashEvery = Math.max(15, Math.round((o.frames || 3600) / 24));
    o.aFile = resolveBuild(o.a);
    o.bFile = /^none$/i.test(o.b) ? null : resolveBuild(o.b);
    return o;
}
function resolveBuild(f) {
    const cands = path.isAbsolute(f) ? [f] : [path.resolve(process.cwd(), f), path.resolve(REPO, f)];
    for (const c of cands) if (fs.existsSync(c)) return c;
    throw new Error('build not found: ' + f);
}
const rel = (f) => (f.startsWith(REPO + path.sep) ? path.relative(REPO, f) : f);

// Time-sliced builders the game has (name, page expression true while it builds); --staged adds more
const DEFAULT_BUILDERS = [
    ['abilityLook', "typeof abilityLook !== 'undefined' && abilityLook.state === 'building'"],   // High Fidelity's staged build (3 ms a frame)
    ['ultraPrep', "typeof ultraPrep !== 'undefined' && !!ultraPrep.running"]                       // Ultra Realism's background preparation
];

// ---- the builds: copied once, every run loads the copy ---------------------------------------------------------
function fileInfo(f) {
    const buf = fs.readFileSync(f), st = fs.statSync(f);
    const m = /class="loading-text">[^<]*?\b(V\d+(?:\.\d+)+)/.exec(buf.toString('utf8'));
    return { sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: st.size, mtime: st.mtime.toISOString(), versionLabel: m ? m[1] : null };
}
function prepareBuilds(args) {
    const dir = args.runDir ? path.resolve(args.runDir)
        : args.out ? path.resolve(args.out).replace(/\.json$/i, '') + '.builds'
        : fs.mkdtempSync(path.join(os.tmpdir(), 'valorant-bench-'));
    const out = {};
    for (const [L, src] of [['A', args.aFile], ['B', args.bFile]]) {
        if (!src) continue;
        const d = path.join(dir, L);
        fs.mkdirSync(d, { recursive: true });
        const copy = path.join(d, path.basename(src));   // the same file name, so document.URL only changes its folder
        let si = null, ci = null;
        for (let tries = 0; tries < 3; tries++) {
            fs.copyFileSync(src, copy);
            si = fileInfo(src); ci = fileInfo(copy);
            if (si.sha256 === ci.sha256) break;
        }
        if (si.sha256 !== ci.sha256) throw new Error(src + ' kept changing while it was copied');
        out[L] = { source: rel(src), copy, sha256: ci.sha256, size: ci.size, sourceMtime: si.mtime, versionLabel: ci.versionLabel };
    }
    return { dir, builds: out };
}

// ---- other jobs on the machine ---------------------------------------------------------------------------------
// Browsers and test jobs this tool did not start (ps: not this process or its children, nor its ancestors)
function foreignLoad() {
    const out = { at: new Date().toISOString(), loadavg: os.loadavg().map((v) => +v.toFixed(2)), browsers: 0, browserProcs: 0, jobs: [], busy: false };
    let text;
    try { text = execFileSync('ps', ['-eo', 'pid=,ppid=,stat=,args='], { encoding: 'utf8', maxBuffer: 32 << 20 }); }
    catch (e) { out.error = 'ps: ' + e.message; return out; }
    const procs = [], parent = new Map();
    for (const line of text.split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
        if (!m || m[3].startsWith('Z')) continue;
        const p = { pid: +m[1], ppid: +m[2], args: m[4] };
        procs.push(p); parent.set(p.pid, p.ppid);
    }
    const mine = (pid) => { for (let p = pid, i = 0; p > 1 && i < 100; p = parent.get(p), i++) if (p === process.pid) return true; return false; };
    const ancestors = new Set();
    for (let p = process.ppid, i = 0; p > 1 && i < 100; p = parent.get(p), i++) ancestors.add(p);
    for (const p of procs) {
        if (mine(p.pid) || ancestors.has(p.pid)) continue;
        if (/chrome-headless-shell|\/chrom(e|ium)(\.real)?(\s|$)|chromium-browser|google-chrome/.test(p.args)) {
            out.browserProcs++;
            if (!/--type=/.test(p.args)) out.browsers++;
        } else if (/(^|\/)node(js)?\s/.test(p.args) && /--test\b|\.test\.js|tests\/tools\/|playwright/.test(p.args)) out.jobs.push(p.pid + ' ' + p.args.slice(0, 160));
    }
    out.busy = out.browsers > 0 || out.jobs.length > 0;
    return out;
}
const describeLoad = (L) => `load ${L.loadavg.join(' ')}, ${L.browsers} other browser(s) (${L.browserProcs} processes), ${L.jobs.length} test/tool job(s)` + (L.jobs.length ? ': ' + L.jobs.map((j) => j.slice(0, 90)).join(' | ') : '');
async function waitIdle(args, say) {
    let L = foreignLoad();
    if (!L.busy) return { load: L, refused: false, waitedS: 0 };
    if (args.allowLoad) { say('  WARNING: ' + describeLoad(L) + ' (--allow-load: running anyway; the run is flagged)'); return { load: L, refused: false, waitedS: 0 }; }
    say(`  other jobs are running (${describeLoad(L)}): waiting up to ${args.waitIdle} s for them to finish (--allow-load runs anyway)`);
    const t0 = Date.now();
    while (L.busy && Date.now() - t0 < args.waitIdle * 1000) { await sleep(15000); L = foreignLoad(); }
    return { load: L, refused: L.busy, waitedS: Math.round((Date.now() - t0) / 1000) };
}

// ---- in the page, before any game script (page.addInitScript through the harness) --------------------------
// Writes the saved settings the game reads at startup (settingsManager.LS_CONSENT_KEY / LS_DATA_KEY, and the
// Content Tier read by readSavedContentTier), seeds Math.random for the boot, wraps requestAnimationFrame for
// the game's own loop (function animate: Mode R's route and recording hooks run around it, and its first request,
// made right after initGame(), times the boot), and in Mode D keeps a list of the real timers still pending so the
// driver can take them over.
const PRE_INIT = (cfg) => {
    try {
        localStorage.setItem('valorant_v16_ls_consent', 'true');
        localStorage.setItem('valorant_v16_user_settings', JSON.stringify(cfg.settings));
    } catch (e) { window.__benchStorageError = String(e && e.message || e); }
    const realPerf = window.__benchRealPerf = performance.now.bind(performance);
    if (cfg.seed) {
        let s = cfg.seed >>> 0 || 1;
        window.__benchBootRandom = true;
        Math.random = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
    }
    const realRAF = window.requestAnimationFrame.bind(window);
    const N = 60000;
    const rec = window.__benchRec = { on: false, n: 0, k: 0, N, calls: new Float32Array(N), tris: new Float32Array(N), progs: new Float32Array(N), up: new Float64Array(N), gm: new Float32Array(N),
        pre: null, post: null, hookErrors: 0, hookError: null };
    const hook = (f) => { try { f(); } catch (e) { rec.hookErrors++; rec.hookError = String(e && e.message || e); } };
    window.requestAnimationFrame = function (cb) {
        if (!cb || cb.name !== 'animate') return realRAF(cb);
        // animate's first statement asks for the next frame: the first request is the end of initGame()
        if (window.__benchFirstRafAt === undefined) window.__benchFirstRafAt = realPerf();
        return realRAF(function (t) {
            if (window.__benchFirstFrameAt === undefined) window.__benchFirstFrameAt = realPerf();
            if (rec.pre) hook(rec.pre);
            cb(t);
            if (rec.post) hook(rec.post);
        });
    };
    if (cfg.track) {
        const rST = window.setTimeout.bind(window), rSI = window.setInterval.bind(window);
        const rCT = window.clearTimeout.bind(window), rCI = window.clearInterval.bind(window);
        const pend = window.__benchPending = new Map();
        window.__benchReal = { setTimeout: rST, setInterval: rSI, clearTimeout: rCT, clearInterval: rCI };
        const call = (fn, args) => (typeof fn === 'function' ? fn.apply(window, args) : (0, eval)(String(fn)));
        window.setTimeout = function (fn, ms, ...args) {
            let id = 0;
            id = rST(() => { pend.delete(id); call(fn, args); }, ms);
            pend.set(id, { fn, args, due: performance.now() + Math.max(0, +ms || 0), every: 0 });
            return id;
        };
        window.setInterval = function (fn, ms, ...args) {
            const every = Math.max(1, +ms || 0);
            const ent = { fn, args, due: performance.now() + every, every };
            const id = rSI(() => { ent.due += every; call(fn, args); }, ms);
            pend.set(id, ent);
            return id;
        };
        window.clearTimeout = function (id) { pend.delete(id); return rCT(id); };
        window.clearInterval = function (id) { pend.delete(id); return rCI(id); };
    }
};

// ---- in the page, after boot: setup, variants, Mode R recording, the Mode D driver and route --------------
const PAGE_LIB = () => {
    if (window.__bench) return true;
    const B = window.__bench = { allowDeath: false, damageClamped: 0, damageCalls: 0, gameMs: 0, builders: [], routeErrors: [] };
    const realPerf = window.__benchRealPerf || performance.now.bind(performance);
    const f5 = (v) => (typeof v === 'number' ? +v.toFixed(5) : v);
    const p3 = (o) => (o && o.position ? [f5(o.position.x), f5(o.position.y), f5(o.position.z)] : null);
    const fnvBytes = (b) => { let h = 0x811c9dc5; for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16).padStart(8, '0'); };
    const fnvStr = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16).padStart(8, '0'); };
    const has = (name) => { try { return typeof (0, eval)(name) !== 'undefined'; } catch (e) { return false; } };
    const progs = () => (renderer.info.programs ? renderer.info.programs.length : 0);
    const activeBots = () => enemyObjects.filter((e) => e.isActive && !e.hit).length;
    // the game's own calls made by the route are timed (Mode D counts them as the game's work, not the tool's)
    const G = (fn) => { const t = realPerf(); try { return fn(); } finally { B.gameMs += realPerf() - t; } };

    // What is set and what exists (reported, so a missing hook shows up instead of being assumed)
    B.info = () => {
        const gl = renderer.getContext(), us = game.userSettings || {};
        let glRenderer = null;
        try { const ext = gl.getExtension('WEBGL_debug_renderer_info'); glRenderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); } catch (e) { /* not exposed */ }
        const lt = document.querySelector('.loading-text'), vm = lt && /V\d+(?:\.\d+)+/.exec(lt.textContent || '');
        return {
            versionLabel: vm ? vm[0] : null, url: decodeURIComponent(location.pathname), glRenderer,
            contentTier: has('contentTier') ? contentTier : null,
            contentTierChoice: has('contentTierChoice') ? contentTierChoice : null,
            enemiesPerTier: has('CONTENT') ? CONTENT.enemies : null,
            quality: adaptiveSettings.currentQuality, autoQuality: qualityController.auto,
            map: game.mapPreset, mode: game.gameMode, botAbilityAI: game.botAbilityAI,
            enemiesActive: activeBots(), enemyPool: enemyObjects.length,
            wingmen: (tacticalEnhancements.wingmanBots || []).length, wingmenOn: !!tacticalEnhancements.wingmanEnabled,
            agent: game.activeAgent, weapon: game.activeWeapon,
            pixelRatio: renderer.getPixelRatio(), buffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
            webgl2: !!(renderer.capabilities && renderer.capabilities.isWebGL2),
            shaderWarmupMs: typeof perfTelemetry.shaderWarmupMs === 'number' ? perfTelemetry.shaderWarmupMs : null,
            // page time (from navigation start) of the game loop's first frame request, right after initGame(), and of its first frame
            bootToFirstFrameMs: typeof window.__benchFirstRafAt === 'number' ? window.__benchFirstRafAt : null,
            firstRafCallbackMs: typeof window.__benchFirstFrameAt === 'number' ? window.__benchFirstFrameAt : null,
            programs: progs(), watermark: perfTelemetry.programWatermark, stalls: perfTelemetry.firstUseStalls,
            saved: { qualityMode: us.qualityMode, contentTierMode: us.contentTierMode, skipMenu: us.skipMenu, animDetail: us.animDetail, mapDetail: us.mapDetail,
                charDetail: us.charDetail, abilityEffects: us.abilityEffects, botMechanics: us.botMechanics, localStorageEnabled: us.localStorageEnabled },
            storageError: window.__benchStorageError || null, bootRandomSeeded: !!window.__benchBootRandom,
            hooks: { exportRun: typeof perfTelemetry.exportRun === 'function', reset: typeof perfTelemetry.reset === 'function',
                runFrame: !!perfTelemetry.runFrame, runCpu: !!perfTelemetry.runCpu, setManual: typeof qualityController.setManual === 'function',
                takeDamage: typeof window.takeDamage === 'function', stepSimulation: typeof window.stepSimulation === 'function',
                gameNow: has('gameNow'), startFire: !!(has('gamepadController') && gamepadController.startFire), enhancedAnim: has('enhancedAnim'), abilityLook: has('abilityLook'),
                firstRafHooked: typeof window.__benchFirstRafAt === 'number' }
        };
    };

    // Time-sliced builders: [name, expression true while it builds]
    B.setBuilders = (list) => {
        const bad = [];
        B.builders = [];
        for (const [name, expr] of list) { try { B.builders.push([name, new Function('return !!(' + expr + ');')]); } catch (e) { bad.push(name + ': ' + e.message); } }
        return { builders: B.builders.map((b) => b[0]), bad };
    };
    B.building = () => { const out = []; for (const [n, f] of B.builders) { try { if (f()) out.push(n); } catch (e) { /* not in this build */ } } return out; };

    // perfTelemetry's cumulative counters, tracked frame by frame (a perfTelemetry.reset in between counts from 0)
    const CNT = ['glUploadBytes', 'glUploadCalls', 'glBufferDataBytes', 'glBufferDataCalls', 'requestedUploadBytes', 'firstUseStalls'];
    B.cntSnap = () => CNT.map((k) => +perfTelemetry[k] || 0);
    B.cntTotals = (S) => { const o = {}; CNT.forEach((k, i) => { o[k] = S.tot[i]; }); return o; };
    B.newTrack = () => ({ lastProgs: progs(), killcam: !!replayDirector.clip, dead: game.health <= 0, round: game.roundNumber, cnt: B.cntSnap(), tot: CNT.map(() => 0) });
    // After a frame: the counters' change, and its events (compiles, first-use stalls, kill cam, death, round,
    // time-sliced builds). Returns the bytes sent to GL in it (bufferSubData + bufferData).
    B.afterFrame = (S, ev) => {
        const cur = B.cntSnap();
        let reset = false;
        for (let i = 0; i < CNT.length; i++) if (cur[i] < S.cnt[i]) reset = true;
        const d = cur.map((v, i) => (reset ? v : v - S.cnt[i]));
        for (let i = 0; i < CNT.length; i++) S.tot[i] += d[i];
        S.cnt = cur;
        if (reset) ev.push('telemetry-reset');
        const pc = progs();
        if (pc > S.lastProgs) { ev.push('compile+' + (pc - S.lastProgs)); S.lastProgs = pc; }
        if (d[5] > 0) ev.push('stall+' + d[5]);
        const kc = !!replayDirector.clip;
        if (kc !== S.killcam) { ev.push(kc ? 'killcam-start' : 'killcam-end'); S.killcam = kc; }
        const dead = game.health <= 0;
        if (dead !== S.dead) { ev.push(dead ? 'down' : 'respawn'); S.dead = dead; }
        if (game.roundNumber !== S.round) { ev.push('round' + game.roundNumber); S.round = game.roundNumber; }
        for (const n of B.building()) ev.push('staged:' + n);
        return d[0] + d[2];
    };

    // Variants: settings applied after boot
    B.applyOpts = (o) => {
        const res = { applied: [], unknown: [], errors: [] };
        if (!o || typeof o !== 'object') return res;
        const us = game.userSettings;
        let apply = false, refreshLook = false;
        for (const k of Object.keys(o)) {
            const v = o[k];
            try {
                if (k === 'enhancedAnim') { us.animDetail = v ? 'on' : 'off'; apply = true; }
                else if (k === 'highDetail') { us.mapDetail = v ? 'on' : 'off'; us.charDetail = v ? 'on' : 'off'; apply = true; }
                else if (k === 'quality') { us.qualityMode = String(v); apply = true; }
                else if (k === 'botAbilityAI') tacticalDirector.toggleBotAbilityAI(!!v);
                else if (k === 'wingmen') tacticalEnhancements.toggleWingmanAI(!!v);
                else if (k === 'js') (0, eval)(String(v));
                else if (k === 'waitFor') { /* the tool waits for it after applying */ }
                else {
                    const known = (k in us) || (has('DEFAULT_USER_SETTINGS') && k in DEFAULT_USER_SETTINGS);
                    if (!known) res.unknown.push(k);
                    us[k] = v; apply = true;
                    if (k === 'abilityEffects') refreshLook = true;
                }
                res.applied.push(k);
            } catch (e) { res.errors.push(k + ': ' + e.message); }
        }
        if (apply) { try { settingsManager.applyAllSettings(false); } catch (e) { res.errors.push('applyAllSettings: ' + e.message); } }
        if (refreshLook && has('abilityLook') && abilityLook.refresh) { try { abilityLook.refresh(); } catch (e) { res.errors.push('abilityLook.refresh: ' + e.message); } }
        res.state = {
            quality: adaptiveSettings.currentQuality, autoQuality: qualityController.auto,
            enhancedAnim: has('enhancedAnim') ? !!enhancedAnim.on : null, look: has('abilityLook') ? abilityLook.mode : null,
            mapDetail: us.mapDetail, charDetail: us.charDetail, botAbilityAI: game.botAbilityAI
        };
        return res;
    };

    // The common start: Ascent, Wave reset, Bot Ability AI on, you at the route's start, no ability item out,
    // casts never run out, the replay recorder empty (a kill cam then replays only what the run recorded)
    B.setup = (s) => {
        if (game.mapPreset !== 'ascent') tacticalDirector.cycleMapPreset('ascent');
        if (!game.botAbilityAI) tacticalDirector.toggleBotAbilityAI(true);
        game.userSettings.infiniteAbilities = true;
        game.userSettings.infiniteUlt = true;
        const end = (it) => { if (!it || typeof it !== 'object' || it.isObject3D) return; if ('expireAt' in it) it.expireAt = 1; if ('endTime' in it) it.endTime = 1; if ('executeAt' in it) it.executeAt = 1; };
        for (const key of Object.keys(agentSystem)) {
            const v = agentSystem[key];
            if (Array.isArray(v)) { for (const it of v) if (it && typeof it === 'object' && ('inUse' in it || 'active' in it)) end(it); }
            else if (v && typeof v === 'object' && ('inUse' in v || 'active' in v)) end(v);
        }
        if (agentSystem.projectiles) for (const p of agentSystem.projectiles) if (p.inUse) { p.inUse = false; p.mesh.visible = false; }
        game.ultActiveUntil = 0; game.ultAgent = null; game.ultChargesLeft = 0;
        if (castFX.active) { castFX.active = null; castFX.hide(); }
        tacticalDirector.setGameMode('wave');
        agentSystem.selectAgent(s.agent || 'sage');
        const cc = characterController;
        cc.position.set(s.at[0], s.at[1], s.at[2]); cc.prevSimPosition.copy(cc.position); if (cc.velocity) cc.velocity.set(0, 0, 0);
        camera.position.copy(cc.position);
        camera.rotation.set(s.aim[0], s.aim[1], 0, 'YXZ');
        if (cc.targetRotation) cc.targetRotation.y = s.aim[1];
        game.health = 100; game.shield = 50; game.isDead = false;
        (tacticalEnhancements.wingmanBots || []).forEach((w, i) => {
            w.patrolPhase = i * Math.PI; w.lastFireAt = 0;
            w.group.position.set(cc.position.x + w.offsetX, 0, cc.position.z + w.offsetZ); w.group.rotation.set(0, 0, 0);
        });
        if (has('replayRec') && replayRec.init) { replayRec.init(); replayRec.lastAt = -1e9; }
        // V2.2 Enhanced Animations' first-person bob and sway keep smoothed state from every frame before (the real-time
        // boot frames too) that only decays, so the same run would draw a slightly different viewmodel: started fresh
        if (has('eaFP')) {
            try { eaFP.reset(); eaFP.lastT = 0; eaFP.bobPh = 0; eaFP.offT = 0; eaFP.offW = 0; eaFP.offKind = null; eaFP._doorAt = -1e9; } catch (e) { /* older build */ }
        }
        // ...and so do its wingman rigs and bot poses (gait phase, blends, aim, idle): set up again where they now stand
        if (has('enhancedAnim') && typeof enhancedAnim._initState === 'function') {
            try {
                for (const r of enhancedAnim.wingRigs || []) { enhancedAnim._initState(r.st, r.bot.group, r.st.slot * 5); r.recoil = 0; r.fire = r.bot.lastFireAt || 0; }
                for (const e of enemyObjects) if (e.eaV) enhancedAnim._initState(e, e.mesh, e.slot);
            } catch (e) { /* older build */ }
        }
        // a later build's own smoothed visual state (--reset-js)
        let resetError = null;
        if (s.resetJs) { try { (0, eval)(String(s.resetJs)); } catch (e) { resetError = e.message; } }
        return { resetError, map: game.mapPreset, mode: game.gameMode, agent: game.activeAgent, enemiesActive: activeBots(), enemyPool: enemyObjects.length };
    };

    // Damage to you is clamped to keep minHealth (the forced death sets allowDeath)
    B.installClamp = (minHealth) => {
        if (B._clamp) return true;
        const real = window.takeDamage;
        if (typeof real !== 'function') return false;
        window.takeDamage = function (amount) {
            const args = Array.prototype.slice.call(arguments);
            B.damageCalls++;
            if (!B.allowDeath && typeof amount === 'number') {
                const room = Math.max(0, game.health - minHealth);
                if (amount > room) { B.damageClamped += amount - room; args[0] = room; }
            }
            return real.apply(this, args);
        };
        B._clamp = true;
        return true;
    };

    // ---- Mode R: hold still at the start during the warm-up, then the route on the real clock ----
    B.holdStart = (aim) => {
        const rec = window.__benchRec;
        rec.post = null;
        rec.pre = () => {
            game.keys.w = false; game.keys.a = false; game.keys.s = false; game.keys.d = false;
            camera.rotation.set(aim[0], aim[1], 0, 'YXZ'); characterController.targetRotation.y = aim[1];
        };
        return true;
    };
    B.recStart = (spec) => {
        const rec = window.__benchRec;
        B.D = { spec };          // routeFrame reads its timeline from B.D.spec
        B.routeInit(spec);
        perfTelemetry.reset(performance.now());
        const S = B.RS = B.newTrack();
        B.recFrom = { programs: progs(), watermark: perfTelemetry.programWatermark, stalls: perfTelemetry.firstUseStalls };
        rec.n = 0; rec.k = 0; rec.ev = {}; rec.evk = {}; rec.cur = null; rec.on = true;
        rec.pre = () => {
            if (!rec.on) return;
            const ev = rec.cur = [];
            B.gameMs = 0;
            try { B.routeFrame(rec.k, ev); } catch (e) { if (B.routeErrors.length < 50) B.routeErrors.push(rec.k + ' route: ' + e.message); }
        };
        rec.post = () => {
            if (!rec.on) return;
            const ev = rec.cur || [];
            rec.cur = null;
            const up = B.afterFrame(S, ev);
            if (rec.n < rec.N) {
                const r = renderer.info.render;
                rec.calls[rec.n] = r.calls; rec.tris[rec.n] = r.triangles; rec.progs[rec.n] = progs(); rec.up[rec.n] = up; rec.gm[rec.n] = B.gameMs;
                rec.n++;
            }
            if (ev.length) {
                rec.evk[rec.k] = ev;
                // this callback's CPU time and the interval it produced are recorded by the next callback, at index runCount
                const i = perfTelemetry.runCount;
                (rec.ev[i] = rec.ev[i] || []).push(...ev);
            }
            rec.k++;
        };
        B.recT0 = realPerf();
        return B.recFrom;
    };
    B.recStop = () => {
        const rec = window.__benchRec;
        rec.on = false; rec.pre = null; rec.post = null;
        const R = B.R;
        if (R && R.firing) { try { fireStop(); } catch (e) { /* ignore */ } R.firing = false; }
        game.keys.w = false; game.keys.a = false; game.keys.s = false; game.keys.d = false;
        const n = perfTelemetry.runCount;
        return {
            wallMs: realPerf() - B.recT0,
            run: perfTelemetry.exportRun(), truncated: !!perfTelemetry.runTruncated, runCapacity: perfTelemetry.runCapacity,
            frame: Array.from(perfTelemetry.runFrame.subarray(0, n), (v) => +v.toFixed(3)),
            cpu: Array.from(perfTelemetry.runCpu.subarray(0, n), (v) => +v.toFixed(3)),
            calls: Array.from(rec.calls.subarray(0, rec.n)), tris: Array.from(rec.tris.subarray(0, rec.n)), progs: Array.from(rec.progs.subarray(0, rec.n)), up: Array.from(rec.up.subarray(0, rec.n)), gm: Array.from(rec.gm.subarray(0, rec.n), (v) => +v.toFixed(3)),
            ev: rec.ev, evk: rec.evk, callbacks: rec.k, counters: B.cntTotals(B.RS),
            from: B.recFrom, programs: progs(), watermark: perfTelemetry.programWatermark, stalls: perfTelemetry.firstUseStalls,
            route: B.routeSummary(), routeErrors: B.routeErrors.splice(0), hookErrors: rec.hookErrors, hookError: rec.hookError,
            clamped: B.damageClamped, damageCalls: B.damageCalls, deaths: game.playerDeaths || 0, killcams: replayDirector.played || 0, round: game.roundNumber,
            quality: adaptiveSettings.currentQuality, autoQuality: qualityController.auto, enemiesActive: activeBots(), enemyPool: enemyObjects.length
        };
    };

    // ---- Mode D: the driver (the V2.2 everything-off driver's approach) ----
    B.installDriver = () => {
        window.__rafQ = [];
        window.__timers = [];
        window.__timerId = 1e6;
        window.__clock = null;
        const real = window.__benchReal || { setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window), clearInterval: window.clearInterval.bind(window) };
        B.realSetTimeout = real.setTimeout;
        // the real timers still pending go into the queue (begin puts them on the fake clock, in creation order)
        let taken = 0;
        if (window.__benchPending) {
            for (const [id, t] of window.__benchPending) {
                (t.every ? real.clearInterval : real.clearTimeout)(id);
                __timers.push({ id, at: t.due, fn: t.fn, args: t.args, every: t.every, taken: true });
                taken++;
            }
            window.__benchPending.clear();
        }
        window.requestAnimationFrame = (cb) => { __rafQ.push(cb); return __rafQ.length; };
        window.cancelAnimationFrame = () => {};
        const addTimer = (fn, ms, args, every) => {
            const id = ++__timerId, delay = Math.max(0, +ms || 0);
            const at = (__clock === null ? performance.now() : __clock) + delay;
            __timers.push({ id, at, fn, args, every: every ? Math.max(1, delay) : 0, delay });
            return id;
        };
        window.setTimeout = (fn, ms, ...args) => addTimer(fn, ms, args, false);
        window.setInterval = (fn, ms, ...args) => addTimer(fn, ms, args, true);
        window.clearTimeout = window.clearInterval = (id) => { const i = __timers.findIndex((t) => t.id === id); if (i >= 0) __timers.splice(i, 1); };
        // the sound buffers made on first use take Math.random() calls: made here, before the seeded run
        try {
            const ctx = soundFX.ensureContext && soundFX.ensureContext();
            if (ctx) {
                if (soundFX._ensureReverb) soundFX._ensureReverb(ctx);
                if (!soundFX._noiseBuffer || soundFX._noiseBuffer.sampleRate !== ctx.sampleRate) {
                    const b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate), d = b.getChannelData(0);
                    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
                    soundFX._noiseBuffer = b;
                }
            }
        } catch (e) { B.audioError = e.message; }
        return { takenTimers: taken };
    };

    const runTimers = (errors, k) => {
        for (;;) {
            let best = -1;
            for (let i = 0; i < __timers.length; i++) {
                const t = __timers[i];
                if (t.at <= __clock && (best < 0 || t.at < __timers[best].at || (t.at === __timers[best].at && t.id < __timers[best].id))) best = i;
            }
            if (best < 0) break;
            const t = __timers[best];
            if (t.every) t.at += t.every; else __timers.splice(best, 1);
            try { typeof t.fn === 'function' ? t.fn(...(t.args || [])) : (0, eval)(String(t.fn)); } catch (e) { errors.push(k + ' timer: ' + e.message); }
        }
    };

    // What the game is doing (the driver's snapshot): you, the bots, the wingmen, ability items, hazards, spike, mode
    B.snap = () => {
        const cc = characterController, out = {};
        const cn = has('gameNow') ? gameNow() : performance.now();
        out.you = [p3(cc), f5(cc.velocity ? cc.velocity.x : 0), f5(cc.velocity ? cc.velocity.z : 0), game.health, game.shield, f5(camera.rotation.x), f5(camera.rotation.y)];
        const fx = (e) => (e.blindedUntil > cn ? 'b' : '') + (e.slowedUntil > cn ? 's' : '') + (e.revealedUntil > cn ? 'r' : '') + (e.concussedUntil > cn ? 'c' : '') + (e.suppressedUntil > cn ? 'u' : '');
        out.bots = enemyObjects.map((e) => (e.isActive && !e.hit ? [e.slot, p3(e.mesh), f5(e.mesh.rotation.y), f5(e.health), e.aiState || '', e.archetype || '', fx(e)] : [e.slot, e.isActive ? 1 : 0, e.hit ? 1 : 0]));
        out.wing = (tacticalEnhancements.wingmanBots || []).map((b) => [p3(b.group), f5(b.health)]);
        const items = [];
        for (const k of Object.keys(agentSystem)) {
            const v = agentSystem[k];
            if (Array.isArray(v)) {
                for (let i = 0; i < v.length; i++) {
                    const it = v[i];
                    if (!it || typeof it !== 'object' || it.isObject3D) continue;
                    if (it.inUse === true || it.active === true) { const m = it.mesh || it.group; items.push([k, i, p3(m), m && m.scale ? f5(m.scale.x) : null]); }
                }
            } else if (v && typeof v === 'object' && !v.isObject3D && (v.inUse === true || v.active === true)) {
                const m = v.group || v.mesh || v.domeMesh;
                items.push([k, -1, p3(m), m && m.scale ? f5(m.scale.x) : null]);
            }
        }
        out.items = items;
        out.hazards = (tacticalDirector.botHazardsPool || []).filter((h) => h && (h.active || h.inUse)).map((h) => p3(h.mesh || h.group));
        out.spike = [tacticalDirector.spikeState, f5(tacticalDirector.spikePlantProgress || 0), f5(tacticalDirector.spikeDefuseProgress || 0)];
        out.mode = [game.gameMode, game.roundNumber, replayDirector.clip ? replayDirector.clip.kind : 0];
        return out;
    };

    // The scripted route: waypoints walked with the game's own movement (W toward the next point), look sweeps,
    // bursts through the game's fire path, casts, reloads and one forced death, all on fixed frames
    const aimNearest = (R, maxD) => {
        const cc = characterController;
        let best = null, bd = maxD;
        for (const e of enemyObjects) {
            if (!e.isActive || e.hit) continue;
            const d = e.mesh.position.distanceTo(cc.position);
            if (d < bd) { bd = d; best = e; }
        }
        if (!best) return false;
        const dx = best.mesh.position.x - cc.position.x, dz = best.mesh.position.z - cc.position.z, dy = best.mesh.position.y + 1.3 - cc.position.y;
        R.yaw = Math.atan2(-dx, -dz);
        R.pitch = Math.max(-0.6, Math.min(0.4, Math.atan2(dy, Math.hypot(dx, dz))));
        return true;
    };
    const fireStart = () => {
        if (has('gamepadController') && gamepadController.startFire) { gamepadController.startFire(); return; }
        game.mouseDown = true; shoot();
        const w = game.weapons[game.activeWeapon];
        if (w && w.automatic && game.autoShootInterval === null) game.autoShootInterval = setInterval(() => { if (game.mouseDown) shoot(); }, 35);
    };
    const fireStop = () => {
        if (has('gamepadController') && gamepadController.stopFire) { gamepadController.stopFire(); return; }
        game.mouseDown = false;
        if (game.autoShootInterval !== null) { clearInterval(game.autoShootInterval); game.autoShootInterval = null; }
    };
    const alive = () => game.health > 0 && !replayDirector.busy();
    const endUlt = () => { game.ultActiveUntil = 0; game.ultAgent = null; game.ultChargesLeft = 0; if (castFX.active) { castFX.active = null; castFX.hide(); } };
    B.routeInit = (spec) => {
        const s = spec.start;
        B.R = { wp: 0, walking: true, yaw: s.aim[1], pitch: s.aim[0], sweep: null, burstUntil: -1, firing: false,
            walkFrames: 0, chkX: s.at[0], chkZ: s.at[2], unstuck: [], casts: [], skipped: [], reloads: [], wpAt: [], deathAt: -1, killer: null, laps: 0 };
    };
    B.routeSummary = () => {
        const R = B.R, spec = B.D && B.D.spec;
        if (!R) return null;
        return { frames: spec ? spec.frames : null, laps: R.laps, wpReached: R.wpAt.length, wpTotal: spec ? spec.waypoints.length : null, wpAt: R.wpAt, unstuck: R.unstuck,
            casts: R.casts, skipped: R.skipped, reloads: R.reloads, deathAt: R.deathAt, killer: R.killer };
    };
    B.routeFrame = (k, ev) => {
        const R = B.R, spec = B.D.spec, cc = characterController, W = spec.waypoints;
        const acts = spec.timeline[k];
        if (acts) for (const a of acts) {
            if (a.t === 'sweep') { R.sweep = { k0: k, dur: a.dur, amp: a.amp, base: R.yaw }; ev.push('sweep'); }
            else if (a.t === 'burst') {
                if (alive()) { if (a.aim) aimNearest(R, 35); camera.rotation.set(R.pitch, R.yaw, 0, 'YXZ'); cc.targetRotation.y = R.yaw; camera.updateMatrixWorld(); G(fireStart); R.firing = true; R.burstUntil = k + a.dur; ev.push('burst'); }
                else ev.push('skip:burst');
            } else if (a.t === 'agent') { G(() => agentSystem.selectAgent(a.id)); ev.push('agent:' + a.id); }
            else if (a.t === 'cast') {
                if (alive()) {
                    const slot = a.key.split('.')[1];
                    if (game.activeAgent !== a.key.split('.')[0]) G(() => agentSystem.selectAgent(a.key.split('.')[0]));
                    if (typeof a.pitch === 'number') R.pitch = a.pitch;
                    if (a.yawOff) R.yaw += a.yawOff;
                    camera.rotation.set(R.pitch, R.yaw, 0, 'YXZ'); cc.targetRotation.y = R.yaw; camera.updateMatrixWorld();
                    if (slot === 'x') {
                        // one ultimate at a time: an earlier one still running (Sage's Resurrection lasts) ends first
                        if (game.ultActiveUntil > gameNow() || game.ultAgent) { G(endUlt); ev.push('ult-ended'); }
                        game.ultPoints = game.maxUltPoints;
                    }
                    G(() => agentSystem.castAbility(slot));
                    R.casts.push([k, a.key]); ev.push('cast:' + a.key);
                } else { R.skipped.push([k, a.key]); ev.push('skip:' + a.key); }
            } else if (a.t === 'reload') {
                // logged only when a reload really started (a full magazine, a reload already running or being dead does nothing)
                const was = !!game.reloading;
                if (alive()) G(() => reload());
                if (!was && game.reloading) { R.reloads.push(k); ev.push('reload'); } else { R.skipped.push([k, 'reload']); ev.push('skip:reload'); }
            } else if (a.t === 'death') {
                let killer = null, bd = 1e9;
                for (const e of enemyObjects) { if (!e.isActive || e.hit) continue; const d = e.mesh.position.distanceTo(cc.position); if (d < bd) { bd = d; killer = e; } }
                if (!killer) killer = enemyObjects[0] || null;
                cc.dashTimer = 0;
                endUlt();   // Sage's Resurrection (or any revive ult) would bring you straight back
                if ('reynaDismissUntil' in agentSystem) agentSystem.reynaDismissUntil = 0;
                if (agentSystem.isoShieldActive) agentSystem.isoShieldActive = false;
                if (R.firing) { G(fireStop); R.firing = false; }
                B.allowDeath = true;
                try { G(() => takeDamage(1000, killer ? killer.mesh.position : null, killer ? { enemy: killer } : null)); } finally { B.allowDeath = false; }
                R.walking = false; R.deathAt = k; R.killer = killer ? enemyObjects.indexOf(killer) : -1;
                ev.push('death');
            }
        }
        if (R.firing && k >= R.burstUntil) { G(fireStop); R.firing = false; }
        game.keys.w = false; game.keys.a = false; game.keys.s = false; game.keys.d = false;
        if (!alive()) return;
        if (R.sweep && k < R.sweep.k0 + R.sweep.dur) {
            const u = (k - R.sweep.k0) / R.sweep.dur;
            R.yaw = R.sweep.base + R.sweep.amp * Math.sin(2 * Math.PI * u);
            R.pitch = -0.04 + 0.07 * Math.sin(4 * Math.PI * u);
            R.walkFrames = 0; R.chkX = cc.position.x; R.chkZ = cc.position.z;
        } else if (R.firing) {
            R.walkFrames = 0; R.chkX = cc.position.x; R.chkZ = cc.position.z;
        } else {
            R.sweep = null;
            if (R.walking && R.wp < W.length) {
                const t = W[R.wp], dx = t[0] - cc.position.x, dz = t[1] - cc.position.z;
                if (Math.hypot(dx, dz) < 0.9) { R.wp++; R.wpAt.push(k); ev.push('wp' + R.wp); }
                else {
                    const want = Math.atan2(-dx, -dz);
                    let diff = want - R.yaw;
                    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
                    R.yaw += Math.max(-0.07, Math.min(0.07, diff));
                    R.pitch += (-0.05 - R.pitch) * 0.1;
                    if (Math.abs(diff) < 0.6) {
                        game.keys.w = true;
                        if (++R.walkFrames >= 60) {
                            // stuck (a wall, a bot, a barrier): on to the next point, the same way in every run
                            if (Math.hypot(cc.position.x - R.chkX, cc.position.z - R.chkZ) < 0.6) {
                                cc.position.set(t[0], cc.standHeight, t[1]); cc.prevSimPosition.copy(cc.position); cc.velocity.set(0, 0, 0);
                                R.unstuck.push([k, R.wp]); R.wp++; ev.push('unstuck');
                            }
                            R.walkFrames = 0; R.chkX = cc.position.x; R.chkZ = cc.position.z;
                        }
                    }
                }
            } else R.pitch += (-0.04 - R.pitch) * 0.08;
            if (R.walking && R.wp >= W.length && spec.loop) { R.wp = 0; R.laps++; ev.push('lap' + R.laps); }
        }
        camera.rotation.set(R.pitch, R.yaw, 0, 'YXZ');
        cc.targetRotation.y = R.yaw;
        camera.updateMatrixWorld();
    };

    B.begin = (spec, T0) => {
        // frames k < 0 are the pre-roll (untimed, nothing recorded); the route's frame 0 is at T0
        const P = Math.max(0, spec.preroll | 0), Ts = T0 - P * (1000 / 60);
        const D = B.D = { spec, T0, k: -P, seed: spec.seed || 20221, errors: [], realDate: Date.now, realRandom: Math.random,
            realStep: window.stepSimulation, inStep: 0, lastProgs: 0, prerollCompiles: 0, S: null, from: null };
        window.stepSimulation = function (dt, t) { D.inStep++; try { return D.realStep(dt, t); } finally { D.inStep--; } };
        window.__clock = Ts;
        simClock = Ts; simAccumulator = 0;
        performance.now = () => (D.inStep ? simClock : simClock + simAccumulator * 1000);
        Date.now = () => 1.7e12 + performance.now();
        Math.random = () => { D.seed = (D.seed * 16807) % 2147483647; return (D.seed - 1) / 2147483646; };
        if (has('gameNow')) { gameTime = Ts; gameClock = Ts; }
        timingResetPending = true;
        if (spec.noRender) { D.realRender = renderer.render; renderer.render = function () {}; }
        // the timers go onto the fake clock: intervals one period after the first frame; timeouts taken over from
        // the real clock (whose remaining delay depends on boot timing) at the first frame; later ones after their delay
        for (const t of __timers) t.at = Ts + (t.every ? t.every : (t.taken ? 0 : t.delay || 0));
        const setup = B.setup(spec.start);
        B.routeInit(spec);
        D.lastProgs = progs();
        return { setup, timers: __timers.length, rafQ: __rafQ.length };
    };

    // n frames; each timed with the real clock (see the frame-time note in --help)
    B.step = async (n) => {
        await new Promise((r) => B.realSetTimeout(r, 20));   // let the compositor finish the last chunk's frame
        const D = B.D, spec = D.spec, gl = renderer.getContext(), px1 = B.px1 || (B.px1 = new Uint8Array(4));
        const out = { k0: D.k, ms: [], cb: [], tm: [], rt: [], tot: [], up: [], calls: [], tris: [], progs: [], ev: {}, hashes: [], done: false };
        for (let j = 0; j < n && D.k < spec.frames; j++, D.k++) {
            const k = D.k;
            __clock = D.T0 + k * (1000 / 60);
            if (k < 0) {
                // pre-roll: you stand at the start looking along the route's first aim; the game runs as usual
                const cc = characterController, a = spec.start.aim;
                game.keys.w = false; game.keys.a = false; game.keys.s = false; game.keys.d = false;
                camera.rotation.set(a[0], a[1], 0, 'YXZ'); cc.targetRotation.y = a[1]; camera.updateMatrixWorld();
                runTimers(D.errors, k);
                const q = __rafQ; __rafQ = [];
                for (const cb of q) { try { cb(__clock); } catch (e) { D.errors.push(k + ': ' + e.message + ' @ ' + String(e.stack || '').split('\n')[1]); } }
                const pc = progs();
                if (pc > D.lastProgs) { D.prerollCompiles += pc - D.lastProgs; D.lastProgs = pc; }
                continue;
            }
            if (k === 0 || !D.S) {
                // the measured route starts: the programs and perfTelemetry's counters from here on are the route's
                D.from = { programs: progs(), watermark: perfTelemetry.programWatermark, stalls: perfTelemetry.firstUseStalls };
                D.S = B.newTrack();
            }
            const ev = [];
            B.gameMs = 0;
            const t0 = realPerf();
            try { B.routeFrame(k, ev); } catch (e) { D.errors.push(k + ' route: ' + e.message); }
            const ta = realPerf();
            runTimers(D.errors, k);
            const tb = realPerf();
            const q = __rafQ; __rafQ = [];
            for (const cb of q) { try { cb(__clock); } catch (e) { D.errors.push(k + ': ' + e.message + ' @ ' + String(e.stack || '').split('\n')[1]); } }
            gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px1);
            const t1 = realPerf();
            const g = B.gameMs;
            out.ms.push(+(t1 - ta + g).toFixed(3));   // the game's work (route calls + timers + callback + readPixels)
            out.cb.push(+(t1 - tb).toFixed(3));       // the callback + readPixels alone
            out.tm.push(+(tb - ta).toFixed(3));       // due timers
            out.rt.push(+(ta - t0 - g).toFixed(3));   // the tool's steering (left out of ms)
            out.tot.push(+(t1 - t0).toFixed(3));
            const r = renderer.info.render;
            out.calls.push(r.calls); out.tris.push(r.triangles);
            out.progs.push(progs());
            out.up.push(B.afterFrame(D.S, ev));
            if (ev.length) out.ev[k] = ev;
            if (k % spec.hashEvery === 0 || k === spec.frames - 1) {
                const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
                if (!B.pxFull || B.pxFull.length !== w * h * 4) B.pxFull = new Uint8Array(w * h * 4);
                gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, B.pxFull);
                let s = '';
                try { s = JSON.stringify(B.snap()); } catch (e) { s = 'snap error: ' + e.message; }
                const p = characterController.position;
                const hr = [k, fnvBytes(B.pxFull), fnvStr(s), [f5(p.x), f5(p.y), f5(p.z)], game.health];
                if (spec.probe) { try { hr.push(JSON.stringify((0, eval)(spec.probe)).slice(0, 4000)); } catch (e) { hr.push('probe error: ' + e.message); } }
                out.hashes.push(hr);
            }
        }
        out.done = D.k >= spec.frames;
        out.k = D.k;
        out.errors = D.errors.splice(0);
        return out;
    };

    B.end = () => {
        const D = B.D, R = B.R;
        performance.now = realPerf; Date.now = D.realDate; Math.random = D.realRandom;
        window.stepSimulation = D.realStep;
        if (D.realRender) renderer.render = D.realRender;
        if (R && R.firing) { try { fireStop(); } catch (e) { /* ignore */ } }
        return {
            route: B.routeSummary(), from: D.from, counters: D.S ? B.cntTotals(D.S) : null,
            stalls: D.S ? D.S.tot[5] : null, prerollStalls: D.from ? D.from.stalls : null,
            programs: progs(), watermark: perfTelemetry.programWatermark,
            preroll: D.spec.preroll | 0, prerollCompiles: D.prerollCompiles, clamped: B.damageClamped, damageCalls: B.damageCalls, deaths: game.playerDeaths || 0, killcams: replayDirector.played || 0,
            round: game.roundNumber, health: game.health, quality: adaptiveSettings.currentQuality, autoQuality: qualityController.auto,
            audioError: B.audioError || null, enemiesActive: activeBots(), enemyPool: enemyObjects.length
        };
    };
    return true;
};

// ---- the route -------------------------------------------------------------------------------------------------
// Ascent, from mid (the Wave start, -8 11, facing north) through A Link into A Site, out of its west door into
// A Main past the chokepoint, and back the same way to mid; then round again (the game walks at up to 0.85 m a
// tick, so one way takes only ~15 s). Event frames are for 3600 frames and scale with the route's length (for a
// shorter route, sweeps and bursts are shortened too). Mode R scales them to the frames it expects to record.
const ROUTE_START = { at: [-8, 1.7, 11], aim: [-0.04, 0], agent: 'sage' };
const ROUTE_OUT = [[-4, 0], [6, -10], [6, -17], [1, -20], [-1.25, -24], [-1.25, -28], [3, -31], [-2, -36.5], [-5.5, -37.5], [-10, -37], [-20, -37], [-30, -37]];
const ROUTE_WAYPOINTS = ROUTE_OUT.concat(ROUTE_OUT.slice(1, -1).reverse());   // ... back to (6, -10), then (-4, 0) again
function buildRoute(F, args) {
    const s = F / 3600, tl = {};
    // a short route (--quick) keeps every event, with sweeps and bursts shortened so that it still walks
    const add = (f, a) => {
        const k = Math.min(F - 1, Math.max(1, Math.round(f * s)));
        if (a.dur && s < 1) a = Object.assign({}, a, { dur: Math.max(a.t === 'sweep' ? 20 : 8, Math.round(a.dur * s)) });
        (tl[k] = tl[k] || []).push(a);
    };
    add(90, { t: 'sweep', dur: 75, amp: 0.9 });
    add(200, { t: 'burst', dur: 14, aim: true });
    add(260, { t: 'cast', key: 'sage.c', pitch: -0.25, yawOff: 1.3 });   // the wall to one side, off the path
    add(380, { t: 'burst', dur: 18 });
    add(470, { t: 'cast', key: 'sage.q', pitch: -0.15 });
    add(560, { t: 'reload' });
    add(640, { t: 'sweep', dur: 90, amp: 1.2 });
    add(760, { t: 'cast', key: 'sage.e', pitch: -0.4 });
    add(860, { t: 'burst', dur: 14, aim: true });
    add(960, { t: 'cast', key: 'sage.x', pitch: -0.1 });
    add(1080, { t: 'sweep', dur: 75, amp: 0.8 });
    add(1200, { t: 'agent', id: 'omen' });
    add(1260, { t: 'cast', key: 'omen.c', pitch: -0.6 });                // a short step ahead
    add(1380, { t: 'burst', dur: 16, aim: true });
    add(1440, { t: 'cast', key: 'omen.q', pitch: -0.05 });
    add(1560, { t: 'reload' });
    add(1620, { t: 'cast', key: 'omen.e', pitch: -0.2 });
    add(1740, { t: 'sweep', dur: 90, amp: 1.0 });
    add(1860, { t: 'cast', key: 'omen.x', pitch: -0.5 });                // its blink lands a few metres ahead
    add(1980, { t: 'burst', dur: 18, aim: true });
    add(2100, { t: 'sweep', dur: 75, amp: 1.1 });
    add(2220, { t: 'reload' });
    add(2340, { t: 'burst', dur: 14, aim: true });
    add(2460, { t: 'sweep', dur: 90, amp: 0.9 });
    add(2620, { t: 'burst', dur: 18, aim: true });
    add(2740, { t: 'reload' });
    add(2860, { t: 'sweep', dur: 75, amp: 1.2 });
    add(2980, { t: 'burst', dur: 14, aim: true });
    // the forced death: late enough that the kill cam replays only this run, early enough that it plays
    const death = Math.max(Math.round(F * 0.6), F - 480);
    (tl[death] = tl[death] || []).push({ t: 'death' });
    return { frames: F, start: Object.assign({}, ROUTE_START, args.resetJs ? { resetJs: args.resetJs } : {}), waypoints: ROUTE_WAYPOINTS, loop: true, timeline: tl, hashEvery: args.hashEvery, seed: args.seed, deathAt: death, noRender: !!args.noRender, preroll: args.preroll, probe: args.probe };
}

// ---- statistics ----------------------------------------------------------------------------------------------
function frameStats(ms) {
    const n = ms.length;
    if (!n) return null;
    const sorted = Float64Array.from(ms).sort();
    let sum = 0, max = -1, maxAt = -1;
    for (let i = 0; i < n; i++) { sum += ms[i]; if (ms[i] > max) { max = ms[i]; maxAt = i; } }
    const mean = sum / n;
    const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
    const q = (p) => sorted[Math.min(n - 1, Math.max(0, Math.ceil(n * p) - 1))];
    const lowN = Math.min(n, Math.max(36, Math.ceil(n * 0.01)));
    let lowSum = 0;
    for (let i = n - lowN; i < n; i++) lowSum += sorted[i];
    return { n, meanMs: mean, medianMs: median, p95Ms: q(0.95), p99Ms: q(0.99), maxMs: max, maxFrame: maxAt, avgFps: 1000 / mean, low1Fps: 1000 / (lowSum / lowN), low1Frames: lowN };
}
function median(a) { if (!a || !a.length) return null; const s = Float64Array.from(a).sort(), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; }
function meanSd(a) { const v = a.filter((x) => typeof x === 'number' && isFinite(x)); if (!v.length) return { mean: null, sd: null, n: 0 }; const m = v.reduce((s, x) => s + x, 0) / v.length; const sd = v.length > 1 ? Math.sqrt(v.reduce((s, x) => s + (x - m) * (x - m), 0) / (v.length - 1)) : 0; return { mean: m, sd, min: Math.min(...v), max: Math.max(...v), n: v.length }; }
const meanOf = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
// Spikes: frames over 2x the median, frames over 50 ms, and frames over both, each with the scripted/game events at or
// up to two frames before it
function spikes(ms, med, events) {
    const near = (i) => {
        if (!events) return undefined;
        const out = [];
        for (let d = 0; d <= 2; d++) { const e = events[i - d]; if (e) for (const x of e) out.push(d ? '-' + d + ':' + x : x); }
        return out;
    };
    const list = (pred) => {
        const idx = [];
        for (let i = 0; i < ms.length; i++) if (pred(ms[i])) idx.push(i);
        return { count: idx.length, frames: idx.slice(0, 60).map((i) => ({ i, ms: +ms[i].toFixed(2), events: near(i) })), truncated: idx.length > 60 };
    };
    return { over2xMedian: list((v) => v > 2 * med), over50ms: list((v) => v > 50), over2xMedianAnd50ms: list((v) => v > 2 * med && v > 50) };
}
// Bytes sent to GL per frame (bufferSubData + bufferData), against section 15's 1 KB a frame and 256 KB an event
function uploadStats(up, counters, events) {
    if (!up || !up.length) return null;
    const total = up.reduce((s, x) => s + x, 0);
    const over = (lim) => { const idx = []; for (let i = 0; i < up.length; i++) if (up[i] > lim) idx.push(i); return idx; };
    const big = over(256 * 1024);
    return {
        frames: up.length, bytes: total, perFrame: r2(total / up.length), medianPerFrame: median(up), maxFrameBytes: Math.max(...up), framesOver1KB: over(1024).length,
        over256KB: { count: big.length, frames: big.slice(0, 40).map((i) => ({ i, bytes: up[i], events: events && events[i] ? events[i] : undefined })) },
        counters
    };
}
// Share of frame intervals that are whole multiples of the 60 Hz vsync period
function vsyncShare(ms) {
    if (!ms.length) return null;
    const q = 1000 / 60;
    let n = 0;
    for (const v of ms) { const r = Math.round(v / q); if (r >= 1 && Math.abs(v - r * q) < 0.05) n++; }
    return n / ms.length;
}
// Frames in which a time-sliced builder was building (labelled staged:<name>)
function stagedFrames(events) {
    const out = {};
    for (const k of Object.keys(events)) for (const e of events[k]) if (e.startsWith('staged:')) { const n = e.slice(7); (out[n] = out[n] || []).push(+k); }
    return out;
}
function countEvents(events) {
    const c = {};
    for (const k of Object.keys(events)) for (const e of events[k]) {
        const key = e.replace(/^(compile|stall)\+\d+$/, '$1').replace(/^wp\d+$/, 'waypoint').replace(/^round\d+$/, 'round').replace(/^lap\d+$/, 'lap');
        c[key] = (c[key] || 0) + 1;
    }
    return c;
}
async function heapUsage(page) {
    try {
        const cdp = await page.context().newCDPSession(page);
        const h1 = await cdp.send('Runtime.getHeapUsage');
        await cdp.send('HeapProfiler.collectGarbage');
        const h2 = await cdp.send('Runtime.getHeapUsage');
        await cdp.detach();
        return { usedMB: +(h1.usedSize / 1048576).toFixed(2), afterGcMB: +(h2.usedSize / 1048576).toFixed(2), totalMB: +(h2.totalSize / 1048576).toFixed(2) };
    } catch (e) { return { error: e.message }; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r2 = (v) => (typeof v === 'number' && isFinite(v) ? +v.toFixed(2) : v);

// ---- waiting on the game -------------------------------------------------------------------------------------
// n more rendered frames, however slow: fails only when no frame at all comes for STALL_MS (the harness's
// frames(n) gives up after 120 s whatever the frame rate, which a 960x540 warm-up on SwiftShader exceeds)
async function waitFrames(page, n, what) {
    let last = await page.evaluate(() => frameIndex);
    const target = last + n;
    for (;;) {
        try { await page.waitForFunction((t) => frameIndex >= t, target, { timeout: STALL_MS, polling: 100 }); return; }
        catch (e) {
            if (!/timeout/i.test(String(e && e.message))) throw e;
            const f = await page.evaluate(() => frameIndex);
            if (f === last) throw new Error(`${what}: no frame rendered in ${STALL_MS / 1000} s (frame ${f}, waiting for ${target})`);
            last = f;
        }
    }
}
async function waitBuildersIdle(page) {
    const busy = await page.evaluate(() => __bench.building());
    if (!busy.length) return { waitedMs: 0, builders: [] };
    const t0 = Date.now();
    try { await page.waitForFunction(() => __bench.building().length === 0, null, { timeout: 15 * 60000, polling: 250 }); }
    catch (e) { throw new Error('a time-sliced build is still running after 15 min: ' + busy.join(', ')); }
    return { waitedMs: Date.now() - t0, builders: busy };
}

// ---- the browser: the harness, or (--gpu) the tool's own launch with the harness's boot steps -------------------
let own = null, ownLaunchArgs = null;
async function ownBoot(args, options) {
    const { chromium } = require('playwright');
    if (!own) {
        const launchArgs = ['--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--disable-gpu-vsync', '--disable-frame-rate-limit'].concat(args.chromeArgs);
        own = { browser: await chromium.launch({ headless: !!args.headless, args: launchArgs }), launchArgs };
        ownLaunchArgs = launchArgs;
    }
    const page = await own.browser.newPage({ viewport: options.viewport });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    await page.addInitScript(() => { window.__skipMainMenu = true; });
    await page.addInitScript(options.initScript, options.initArg);
    const THREE_JS = fs.readFileSync(require.resolve('three/build/three.min.js'));
    await page.route('https://cdnjs.cloudflare.com/**', (r) => r.fulfill({ body: THREE_JS, contentType: 'application/javascript' }));
    await page.route((url) => !url.href.startsWith('file:') && !url.href.startsWith('https://cdnjs.cloudflare.com'), (r) => r.abort());
    await page.goto('file://' + options.file);
    await page.waitForFunction(() => window.perfTelemetry && perfTelemetry.programWatermark > 0, null, { timeout: 180000 });
    const frames = (n = 1) => waitFrames(page, n, 'boot');
    await page.evaluate((q) => setQualitySettings(q), options.quality);
    for (let i = 0; i < 3; i++) await frames(6);
    return { page, errors, frames, evaluate: (fn, arg) => page.evaluate(fn, arg) };
}
async function closeAll() {
    await harness.closeBrowser().catch(() => {});
    if (own) { const b = own.browser; own = null; await b.close().catch(() => {}); }
}

// ---- one run -------------------------------------------------------------------------------------------------
async function bootBuild(args, build, pre) {
    const settings = Object.assign({ contentTierMode: 'medium', skipMenu: true, qualityMode: 'medium' }, pre || {});
    const opt = { file: build.copy, viewport: args.viewport, quality: 'medium', initScript: PRE_INIT, initArg: { settings, track: args.mode === 'D', seed: args.seed } };
    const t0 = Date.now();
    const g = args.gpu ? await ownBoot(args, opt) : await harness.boot(opt);
    const launchAndBootMs = Date.now() - t0;
    const bootPrograms = await harness.programState(g.page);
    await g.page.evaluate(PAGE_LIB);
    const builders = await g.page.evaluate((l) => __bench.setBuilders(l), DEFAULT_BUILDERS.concat(args.staged));
    const info = await g.page.evaluate(() => __bench.info());
    return { g, launchAndBootMs, bootPrograms, info, settings, builders };
}

// A variant's settings, then what it builds lazily (Enhanced Animations' rigs, High Fidelity's staged build) settles
// in real frames before anything is measured
async function applyOpts(g, opts) {
    const res = await g.page.evaluate((o) => __bench.applyOpts(o), opts);
    const conds = [];
    if (opts && opts.abilityEffects === 'hifi') conds.push("typeof abilityLook === 'undefined' || abilityLook.mode === 'hifi'");
    if (opts && opts.waitFor) conds.push(String(opts.waitFor));
    for (const c of conds) await g.page.waitForFunction(c, null, { timeout: 15 * 60000, polling: 100 });
    await waitFrames(g.page, 30, 'after applying the options');
    return res;
}

function commonFields(label, build, args, b, opts, pre, optsRes, idle, endPrograms, heap, stalls) {
    const { launchAndBootMs, bootPrograms, info, settings, builders } = b;
    return {
        build: label, source: build.source, file: build.copy, sha256: build.sha256, versionLabel: info.versionLabel, glRenderer: info.glRenderer,
        viewport: args.viewport, opts, pre: pre || {}, settings, optsResult: optsRes, builders: Object.assign({}, builders, { idleWait: idle }),
        launchAndBootMs, bootToFirstFrameMs: r2(info.bootToFirstFrameMs), firstRafCallbackMs: r2(info.firstRafCallbackMs), shaderWarmupMs: r2(info.shaderWarmupMs), info,
        bootPrograms: { programs: bootPrograms[0], watermark: bootPrograms[1], stalls: bootPrograms[2] },
        endPrograms: { programs: endPrograms[0], watermark: endPrograms[1], stalls: endPrograms[2] },
        inPlayOk: endPrograms[0] <= endPrograms[1] && stalls === 0,
        heap
    };
}

async function runD(args, label, build, opts, pre) {
    const b = await bootBuild(args, build, pre);
    const { g } = b;
    const page = g.page;
    const optsRes = await applyOpts(g, opts);
    const idle = await waitBuildersIdle(page);
    const clampOk = await page.evaluate((m) => __bench.installClamp(m), args.minHealth);
    const drv = await page.evaluate(() => __bench.installDriver());
    // the real frame already asked for re-registers itself in the queue
    const tq = Date.now();
    let queued = false;
    while (!(queued = await page.evaluate(() => __rafQ.length > 0)) && Date.now() - tq < STALL_MS) await sleep(50);
    if (!queued) throw new Error('the game never queued a frame after the driver took over');
    const spec = buildRoute(args.frames, args);
    const begin = await page.evaluate(([spec, T0]) => __bench.begin(spec, T0), [spec, 5e6]);
    const A = { ms: [], cb: [], tm: [], rt: [], tot: [], up: [], calls: [], tris: [], progs: [] };
    const hashes = [], events = {}, pageErrors = [];
    const tDrive = Date.now();
    let lastK = null;
    for (;;) {
        const r = await page.evaluate((n) => __bench.step(n), args.chunk);
        for (const key of Object.keys(A)) for (const v of r[key]) A[key].push(v);
        Object.assign(events, r.ev);
        for (const h of r.hashes) hashes.push(h);
        for (const e of r.errors) pageErrors.push(e);
        if (r.done) break;
        if (r.k === lastK) throw new Error('Mode D: the driver made no progress at frame ' + r.k);
        lastK = r.k;
    }
    const driveS = (Date.now() - tDrive) / 1000;
    const end = await page.evaluate(() => __bench.end());
    const heap = await heapUsage(page);
    const endPrograms = await harness.programState(page);
    const errors = g.errors.slice();
    await closeAll();
    const ms = A.ms, st = frameStats(ms);
    const staged = stagedFrames(events), warnings = [];
    for (const n of Object.keys(staged)) warnings.push(`the time-sliced build ${n} ran in ${staged[n].length} route frame(s) from frame ${staged[n][0]}: Mode D's clock stands still inside a frame, so its work lands whole in single frames (read it in Mode R)`);
    return Object.assign(commonFields(label, build, args, b, opts, pre, optsRes, idle, endPrograms, heap, end.stalls), {
        mode: 'D', stagedFrames: staged,
        startPrograms: end.from ? { programs: end.from.programs, watermark: end.from.watermark } : null,
        frames: ms.length, driveS: r2(driveS),
        frameBasis: 'route game calls + due timers + rAF callback + 1-pixel readPixels (real clock)',
        ...mapStats(st), cbOnly: mapStats(frameStats(A.cb)), total: mapStats(frameStats(A.tot)),
        spikes: spikes(ms, st.medianMs, events),
        timersMs: { mean: r2(meanOf(A.tm)), max: r2(Math.max(...A.tm)) }, routeToolMs: { mean: r2(meanOf(A.rt)), max: r2(Math.max(...A.rt)) },
        drawCalls: median(A.calls), triangles: median(A.tris), drawCallsMax: Math.max(...A.calls), programsMax: Math.max(...A.progs),
        stalls: end.stalls, prerollStalls: end.prerollStalls, preroll: end.preroll, prerollCompiles: end.prerollCompiles,
        uploads: uploadStats(A.up, end.counters, events),
        glBufferDataBytes: end.counters ? end.counters.glBufferDataBytes : null, glUploadBytes: end.counters ? end.counters.glUploadBytes : null,
        route: end.route, deaths: end.deaths, killcams: end.killcams, round: end.round, damageClamped: end.clamped, damageCalls: end.damageCalls,
        enemiesActive: { setup: begin.setup.enemiesActive, end: end.enemiesActive }, enemyPool: end.enemyPool,
        endState: { quality: end.quality, autoQuality: end.autoQuality, health: end.health, audioError: end.audioError },
        driver: { takenTimers: drv.takenTimers, clamp: clampOk, begin },
        eventCounts: countEvents(events), events, hashes, frameMs: ms, cbMs: A.cb, uploadBytesPerFrame: A.up, errors, pageErrors, warnings
    });
}

async function runR(args, label, build, opts, pre) {
    const b = await bootBuild(args, build, pre);
    const { g } = b;
    const page = g.page;
    const optsRes = await applyOpts(g, opts);
    const idle = await waitBuildersIdle(page);
    const setup = await page.evaluate((s) => { const r = __bench.setup(s); __bench.installClamp(s.minHealth); __bench.holdStart(s.aim); return r; }, Object.assign({}, ROUTE_START, { minHealth: args.minHealth, resetJs: args.resetJs }));
    // the warm-up: standing at the start; its frame rate sets the route's length when recording by time
    const w0 = await page.evaluate(() => [frameIndex, __benchRealPerf()]);
    await waitFrames(page, Math.max(args.warm, 10), 'Mode R warm-up');
    const w1 = await page.evaluate(() => [frameIndex, __benchRealPerf()]);
    const warmFps = (w1[0] - w0[0]) * 1000 / Math.max(1, w1[1] - w0[1]);
    const byFrames = !!(args.framesGiven || args.quick);
    const F = byFrames ? args.frames : Math.max(60, Math.round(args.seconds * warmFps));
    const spec = buildRoute(F, args);
    const from = await page.evaluate((s) => __bench.recStart(s), spec);
    const tRec = Date.now();
    if (byFrames) {
        let last = -1, lastAt = Date.now();
        for (;;) {
            await sleep(500);
            const n = await page.evaluate(() => perfTelemetry.runCount);
            if (n >= F) break;
            if (n !== last) { last = n; lastAt = Date.now(); }
            else if (Date.now() - lastAt > STALL_MS) throw new Error(`Mode R: no frame recorded in ${STALL_MS / 1000} s (${n} of ${F})`);
        }
    } else await sleep(args.seconds * 1000);
    const rec = await page.evaluate(() => __bench.recStop());
    const heap = await heapUsage(page);
    const endPrograms = await harness.programState(page);
    const errors = g.errors.slice();
    await closeAll();
    let frame = rec.frame, cpu = rec.cpu;
    if (byFrames) { frame = frame.slice(0, F); cpu = cpu.slice(0, F); }
    const st = frameStats(frame), sc = frameStats(cpu);
    const warnings = [];
    if (rec.truncated) warnings.push(`perfTelemetry kept only ${rec.runCapacity} frames (runTruncated): the recording was cut`);
    const vq = vsyncShare(frame);
    if (vq !== null && vq > 0.9) warnings.push(`${(vq * 100).toFixed(0)}% of frame intervals are whole vsync periods: FPS, 1% low and max move in 16.7 ms steps (cpuMs is the fine-grained figure)`);
    if (rec.hookErrors) warnings.push(`the route hook threw ${rec.hookErrors} time(s): ${rec.hookError}`);
    return Object.assign(commonFields(label, build, args, b, opts, pre, optsRes, idle, endPrograms, heap, rec.stalls), {
        mode: 'R', setup, stagedFrames: stagedFrames(rec.ev),
        startPrograms: { programs: from.programs, watermark: from.watermark },
        warmFps: r2(warmFps), routeFrames: F, callbacks: rec.callbacks,
        frames: frame.length, recordS: r2(rec.wallMs / 1000),
        frameBasis: 'perfTelemetry frame interval (rAF timestamps)',
        ...mapStats(st),
        cpuMs: sc ? { mean: r2(sc.meanMs), p95: r2(sc.p95Ms), max: r2(sc.maxMs) } : null,
        // the route's own game calls (casts, fire, reload, the death) run from the rAF hook, outside animate(), so like
        // input handlers in real play they are not in perfTelemetry's cpuMs; their time per callback:
        routeGameMs: rec.gm.length ? { mean: r2(meanOf(rec.gm)), max: r2(Math.max(...rec.gm)), total: r2(rec.gm.reduce((s, x) => s + x, 0)) } : null,
        vsyncQuantized: vq === null ? null : +vq.toFixed(3), truncated: rec.truncated,
        spikes: spikes(frame, st.medianMs, rec.ev),
        drawCalls: median(rec.calls), triangles: median(rec.tris), drawCallsMax: rec.calls.length ? Math.max(...rec.calls) : null,
        stalls: rec.stalls, uploads: uploadStats(rec.up, rec.counters, rec.evk),
        glBufferDataBytes: rec.counters.glBufferDataBytes, glUploadBytes: rec.counters.glUploadBytes,
        route: rec.route, routeErrors: rec.routeErrors,
        damageClamped: rec.clamped, damageCalls: rec.damageCalls, deaths: rec.deaths, killcams: rec.killcams, round: rec.round,
        enemiesActive: { setup: setup.enemiesActive, end: rec.enemiesActive }, enemyPool: rec.enemyPool,
        endState: { quality: rec.quality, autoQuality: rec.autoQuality }, exportRun: rec.run,
        eventCounts: countEvents(rec.ev), events: rec.ev, frameMs: frame, cpuMsPerFrame: cpu, uploadBytesPerFrame: rec.up, errors, warnings
    });
}
function mapStats(st) {
    return { avgFps: r2(st.avgFps), low1Fps: r2(st.low1Fps), low1Frames: st.low1Frames, meanMs: r2(st.meanMs), medianMs: r2(st.medianMs), p95Ms: r2(st.p95Ms), p99Ms: r2(st.p99Ms), maxMs: r2(st.maxMs), maxFrame: st.maxFrame };
}

// ---- report --------------------------------------------------------------------------------------------------
function buildSummary(runs) {
    if (!runs.length) return null;
    const pick = (f) => runs.map(f);
    const D = runs[0].mode === 'D', R = runs[0].mode === 'R';
    const lastPair = Math.max(...pick((r) => r.pair));
    const lp = runs.filter((r) => r.pair === lastPair);
    return {
        runs: runs.length, contaminated: runs.filter((r) => r.contaminated).length,
        avgFps: meanSd(pick((r) => r.avgFps)), low1Fps: meanSd(pick((r) => r.low1Fps)), medianMs: meanSd(pick((r) => r.medianMs)),
        maxMs: Math.max(...pick((r) => r.maxMs)),
        cbOnlyAvgFps: D ? meanSd(pick((r) => r.cbOnly.avgFps)) : undefined, cbOnlyLow1Fps: D ? meanSd(pick((r) => r.cbOnly.low1Fps)) : undefined,
        spikesOver2xMedian: meanSd(pick((r) => r.spikes.over2xMedian.count)), spikesOver50ms: meanSd(pick((r) => r.spikes.over50ms.count)),
        spikesOverBoth: meanSd(pick((r) => r.spikes.over2xMedianAnd50ms.count)),
        cpuMsMean: R ? meanSd(pick((r) => r.cpuMs && r.cpuMs.mean)) : undefined, cpuMsP95: R ? meanSd(pick((r) => r.cpuMs && r.cpuMs.p95)) : undefined,
        vsyncQuantized: R ? meanSd(pick((r) => r.vsyncQuantized)) : undefined,
        drawCalls: median(pick((r) => r.drawCalls)), triangles: median(pick((r) => r.triangles)),
        // programs: the boot watermark (the +0 budget against V2.2), the watermark when measuring starts (after the
        // options: a variant may warm programs on purpose), and the end count against the end watermark (in play)
        bootWatermark: pick((r) => r.bootPrograms.watermark), startWatermark: pick((r) => r.startPrograms && r.startPrograms.watermark),
        endPrograms: pick((r) => r.endPrograms.programs), endWatermark: pick((r) => r.endPrograms.watermark), stalls: pick((r) => r.stalls),
        inPlayLastPair: { pair: lastPair, programs: lp.map((r) => r.endPrograms.programs), watermark: lp.map((r) => r.endPrograms.watermark), stalls: lp.map((r) => r.stalls), ok: lp.every((r) => r.inPlayOk) },
        heapAfterGcMB: meanSd(pick((r) => r.heap && r.heap.afterGcMB)), heapUsedMB: meanSd(pick((r) => r.heap && r.heap.usedMB)),
        shaderWarmupMs: meanSd(pick((r) => r.shaderWarmupMs)), bootToFirstFrameMs: meanSd(pick((r) => r.bootToFirstFrameMs)), launchAndBootMs: meanSd(pick((r) => r.launchAndBootMs)),
        uploadBytesPerFrame: meanSd(pick((r) => r.uploads && r.uploads.perFrame)), uploadMedianPerFrame: meanSd(pick((r) => r.uploads && r.uploads.medianPerFrame)),
        uploadEventsOver256KB: meanSd(pick((r) => r.uploads && r.uploads.over256KB.count)),
        glBufferDataBytes: meanSd(pick((r) => r.glBufferDataBytes))
    };
}
function ratios(runs, A, Bs, mode) {
    const pairs = [...new Set(runs.map((r) => r.pair))].sort((x, y) => x - y);
    const pairRatios = (f) => {
        const v = [];
        for (const p of pairs) {
            const a = runs.find((r) => r.pair === p && r.build === 'A'), b = runs.find((r) => r.pair === p && r.build === 'B');
            if (a && b) v.push(f(b) / f(a));
        }
        return v;
    };
    const out = {
        avgFps: Bs.avgFps.mean / A.avgFps.mean, low1Fps: Bs.low1Fps.mean / A.low1Fps.mean,
        avgFpsPairMedian: median(pairRatios((r) => r.avgFps)), low1FpsPairMedian: median(pairRatios((r) => r.low1Fps)),
        avgFpsPairs: pairRatios((r) => r.avgFps), low1FpsPairs: pairRatios((r) => r.low1Fps)
    };
    if (mode === 'D') { out.cbOnlyAvgFps = Bs.cbOnlyAvgFps.mean / A.cbOnlyAvgFps.mean; out.cbOnlyLow1Fps = Bs.cbOnlyLow1Fps.mean / A.cbOnlyLow1Fps.mean; }
    if (mode === 'R' && A.cpuMsMean.mean) out.cpuMsMean = Bs.cpuMsMean.mean / A.cpuMsMean.mean;
    return out;
}
// Mode D: does each build reproduce itself (pixels + state, or state only with --no-render), and do A and B play
// the same game (state only: a B that changes visuals by design still has to)?
function determinism(runs, noRender) {
    const sig = (r, px) => r.hashes.map((h) => h[0] + ':' + (px ? h[1] + ':' : '') + h[2]).join(',');
    const cmp = (list, px) => {
        const basis = px ? 'pixels + game state' : 'game state only';
        if (list.length < 2) return { basis, runs: list.length, identical: null, verdict: 'n/a (fewer than 2 runs)' };
        const groups = {};
        list.forEach((r) => { const s = sig(r, px); (groups[s] = groups[s] || []).push(r.build + '#' + r.index); });
        const keys = Object.keys(groups), out = { basis, runs: list.length, identical: keys.length === 1, groups: keys.map((k) => groups[k]) };
        out.verdict = out.identical ? 'IDENTICAL' : 'DIFFER';
        if (!out.identical) {
            const a = list[0], b = list.find((r) => sig(r, px) !== sig(a, px));
            for (let i = 0; i < Math.max(a.hashes.length, b.hashes.length); i++) {
                const x = a.hashes[i] || [], y = b.hashes[i] || [];
                if ((px && x[1] !== y[1]) || x[2] !== y[2] || x[0] !== y[0]) { out.firstDiff = { frame: x[0], pixels: px ? x[1] !== y[1] : undefined, state: x[2] !== y[2], a: [a.build + '#' + a.index].concat(x), b: [b.build + '#' + b.index].concat(y) }; break; }
            }
        }
        return out;
    };
    const A = runs.filter((r) => r.build === 'A'), Bs = runs.filter((r) => r.build === 'B');
    return {
        hashedFrames: runs[0] ? runs[0].hashes.map((h) => h[0]) : [], noRender: !!noRender,
        withinA: cmp(A, !noRender), withinB: Bs.length ? cmp(Bs, !noRender) : null,
        AvsB: A.length && Bs.length ? cmp([A[0], Bs[0]].concat(A.slice(1), Bs.slice(1)), false) : null
    };
}
function makeReport(ctx, runs, failures, status) {
    const { args, files, discardFirst, order } = ctx;
    const kept = runs.filter((r) => !r.discarded);
    const report = {
        tool: 'tests/tools/bench.js (V2.3 benchmark)', status, startedAt: ctx.startedAt, updatedAt: new Date().toISOString(),
        runsPlanned: order.length, runsDone: runs.length, runsFailed: failures.length, failures,
        mode: args.mode, viewport: args.viewport, frames: args.frames,
        seconds: args.mode === 'R' && !(args.framesGiven || args.quick) ? args.seconds : null, warm: args.mode === 'R' ? args.warm : null,
        pairs: args.pairs, discardFirst, runDir: files.dir, files: files.builds,
        opts: { A: args.aOpts }, pre: { A: args.aPre },
        launcher: args.gpu ? { kind: 'tool (--gpu)', headless: !!args.headless, args: ownLaunchArgs } : { kind: 'harness', note: 'headless SwiftShader (tests/harness.js LAUNCH_ARGS)' },
        builders: DEFAULT_BUILDERS.concat(args.staged).map((b) => b[0]),
        machine: { cpus: os.cpus().length, node: process.version, loadAtStart: ctx.loadAtStart, loadAtEnd: ctx.loadAtEnd || null },
        contaminatedRuns: runs.filter((r) => r.contaminated).map((r) => r.index),
        warnings: ctx.warnings.concat(...runs.map((r) => (r.warnings || []).map((w) => `run ${r.index} (${r.build}): ${w}`))),
        frameBasis: args.mode === 'D' ? 'the game\'s work per driven frame: its calls made by the route + due timers + rAF callback + 1-pixel readPixels (cbOnly: callback + readPixels alone)'
            : 'perfTelemetry.runFrame intervals; cpuMs = perfTelemetry.runCpu',
        route: args.mode === 'D' ? buildRoute(args.frames, args) : null,
        builds: { A: buildSummary(kept.filter((r) => r.build === 'A')) }, runs
    };
    if (files.builds.B) {
        report.opts.B = args.bOpts; report.pre.B = args.bPre;
        report.builds.B = buildSummary(kept.filter((r) => r.build === 'B'));
        if (report.builds.A && report.builds.B) report.ratios = ratios(kept, report.builds.A, report.builds.B, args.mode);
    }
    if (args.mode === 'D' && runs.length) report.determinism = determinism(runs, args.noRender);
    return report;
}
function writeReport(args, report) {
    if (!args.out) return;
    const f = path.resolve(args.out);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f + '.tmp', JSON.stringify(report, null, 1));
    fs.renameSync(f + '.tmp', f);
}
function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function lpad(s, n) { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; }
function fmt(v, d = 1) { return typeof v === 'number' && isFinite(v) ? v.toFixed(d) : '-'; }
function printTable(report) {
    const R = report.mode === 'R';
    const head = [pad('run', 4), pad('build', 6), lpad('pair', 4), lpad('load', 6), lpad('FPS', 7), lpad('1%low', 7), lpad('med', 6), lpad('max', 7), lpad('@frame', 7), lpad('>2xm', 5), lpad('>50', 5), lpad('both', 5)]
        .concat(R ? [lpad('cpu', 6), lpad('cpu95', 6), lpad('vsync', 6)] : [lpad('cbFPS', 6), lpad('cb1%', 6)])
        .concat([lpad('draws', 6), lpad('tris', 8), lpad('wm b/s', 8), lpad('prog/wm', 8), lpad('stall', 5), lpad('upB/f', 7), lpad('heapMB', 7), lpad('warmMs', 7), lpad('1stFrm', 7)]).join(' ');
    console.log(head);
    for (const r of report.runs) {
        const ld = r.load && r.load.before ? fmt(r.load.before.loadavg[0], 2) + (r.contaminated ? '!' : '') : '-';
        console.log([pad(r.index, 4), pad(r.build + (r.discarded ? '*' : ''), 6), lpad(r.pair, 4), lpad(ld, 6), lpad(fmt(r.avgFps), 7), lpad(fmt(r.low1Fps), 7), lpad(fmt(r.medianMs), 6), lpad(fmt(r.maxMs), 7), lpad(r.maxFrame, 7),
            lpad(r.spikes.over2xMedian.count, 5), lpad(r.spikes.over50ms.count, 5), lpad(r.spikes.over2xMedianAnd50ms.count, 5)]
            .concat(R ? [lpad(fmt(r.cpuMs && r.cpuMs.mean, 2), 6), lpad(fmt(r.cpuMs && r.cpuMs.p95, 2), 6), lpad(fmt(r.vsyncQuantized, 2), 6)] : [lpad(fmt(r.cbOnly.avgFps), 6), lpad(fmt(r.cbOnly.low1Fps), 6)])
            .concat([lpad(fmt(r.drawCalls, 0), 6), lpad(fmt(r.triangles, 0), 8), lpad(r.bootPrograms.watermark + '/' + (r.startPrograms ? r.startPrograms.watermark : '-'), 8),
                lpad(r.endPrograms.programs + '/' + r.endPrograms.watermark, 8), lpad(r.stalls, 5), lpad(fmt(r.uploads && r.uploads.perFrame, 0), 7),
                lpad(fmt(r.heap && r.heap.afterGcMB), 7), lpad(fmt(r.shaderWarmupMs, 0), 7), lpad(fmt(r.bootToFirstFrameMs, 0), 7)]).join(' '));
    }
    for (const f of report.failures) console.log(`${pad(f.index, 4)} ${pad(f.build, 6)} ${lpad(f.pair, 4)}  FAILED: ${f.error.split('\n')[0].slice(0, 160)}`);
    if (report.runs.some((r) => r.discarded)) console.log('(* discarded: the first pair)');
    if (report.contaminatedRuns.length) console.log(`(! other browsers or test jobs were running before, during or after: runs ${report.contaminatedRuns.join(', ')}; their figures are not comparable)`);
    console.log('(load: 1-min load average before the run; wm b/s: watermark at boot / at measuring start; prog/wm: programs / watermark at the end; upB/f: bytes to GL a frame; heapMB: after GC; 1stFrm: page ms to the game loop\'s first frame)');
    for (const b of Object.keys(report.builds)) {
        const s = report.builds[b];
        if (!s) continue;
        const fl = report.files[b];
        console.log(`${b}: ${fl.source} (${fl.versionLabel || '?'}, sha256 ${fl.sha256.slice(0, 12)})  runs ${s.runs}  FPS ${fmt(s.avgFps.mean)} ±${fmt(s.avgFps.sd)}  1% low ${fmt(s.low1Fps.mean)} ±${fmt(s.low1Fps.sd)}` +
            (s.cbOnlyAvgFps ? `  (cb only ${fmt(s.cbOnlyAvgFps.mean)} / ${fmt(s.cbOnlyLow1Fps.mean)})` : '') +
            `  spikes >2x median ${fmt(s.spikesOver2xMedian.mean)} >50 ms ${fmt(s.spikesOver50ms.mean)} both ${fmt(s.spikesOverBoth.mean)}  max ${fmt(s.maxMs)} ms` + (s.cpuMsMean ? `  cpu ${fmt(s.cpuMsMean.mean, 2)}/${fmt(s.cpuMsP95.mean, 2)} ms` : '') +
            `  draws ${fmt(s.drawCalls, 0)}  tris ${fmt(s.triangles, 0)}  heap ${fmt(s.heapAfterGcMB.mean)} MB  warm-up ${fmt(s.shaderWarmupMs.mean, 0)} ms  first frame ${fmt(s.bootToFirstFrameMs.mean, 0)} ms` +
            `  uploads ${fmt(s.uploadBytesPerFrame.mean, 0)} B/frame  in play (pair ${s.inPlayLastPair.pair}) ${s.inPlayLastPair.ok ? 'ok' : 'NOT ok'}`);
        if (fl.sourceAtEnd && fl.sourceAtEnd.changed) console.log(`   ${b}'s source changed during the benchmark (now sha256 ${fl.sourceAtEnd.sha256.slice(0, 12)}): the runs used the copy made at start-up`);
    }
    if (report.ratios) {
        const q = report.ratios;
        console.log(`B/A: avg FPS ${fmt(q.avgFps, 3)} (per pair median ${fmt(q.avgFpsPairMedian, 3)}), 1% low ${fmt(q.low1Fps, 3)} (per pair median ${fmt(q.low1FpsPairMedian, 3)})` +
            (q.cbOnlyAvgFps ? `; cb only ${fmt(q.cbOnlyAvgFps, 3)} / ${fmt(q.cbOnlyLow1Fps, 3)}` : '') + (q.cpuMsMean ? `; cpuMs mean ${fmt(q.cpuMsMean, 3)}` : ''));
    }
    if (report.determinism) {
        const d = report.determinism;
        const line = (name, v) => {
            if (!v) return;
            console.log(`Mode D ${name}: ${v.verdict} (${v.basis}, ${v.runs} runs, ${d.hashedFrames.length} hashed frames)` +
                (v.firstDiff ? ` - first difference at frame ${v.firstDiff.frame} (${[v.firstDiff.pixels ? 'pixels' : '', v.firstDiff.state ? 'state' : ''].filter(Boolean).join(' and ')})` : ''));
        };
        line('within A', d.withinA); line('within B', d.withinB); line('A vs B', d.AvsB);
    }
    for (const w of report.warnings) console.log('WARNING: ' + w);
    const errs = report.runs.reduce((n, r) => n + r.errors.length + (r.pageErrors ? r.pageErrors.length : 0) + (r.routeErrors ? r.routeErrors.length : 0), 0);
    console.log(`page errors: ${errs}; status: ${report.status}`);
}

// ---- main ----------------------------------------------------------------------------------------------------
async function main() {
    const args = parseArgs(process.argv.slice(2));
    const say = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
    const files = prepareBuilds(args);
    const builds = { A: Object.assign({ opts: args.aOpts, pre: args.aPre }, files.builds.A) };
    if (files.builds.B) builds.B = Object.assign({ opts: args.bOpts, pre: args.bPre }, files.builds.B);
    const order = [];
    for (let p = 0; p < args.pairs; p++) {
        const pair = builds.B ? (p % 2 === 0 ? ['A', 'B'] : ['B', 'A']) : ['A'];
        for (const b of pair) order.push({ build: b, pair: p });
    }
    const discardFirst = args.pairs > 1 && !args.keepFirst;
    const ctx = { args, files, discardFirst, order, startedAt: new Date().toISOString(), loadAtStart: foreignLoad(), warnings: [] };
    say(`mode ${args.mode}, ${args.viewport.width}x${args.viewport.height}, ${args.mode === 'D' ? args.frames + ' frames' : (args.framesGiven || args.quick ? args.frames + ' frames' : args.seconds + ' s') + ' after ' + args.warm + ' warm frames'}, ` +
        `${args.pairs} pair(s)${discardFirst ? ' (first discarded)' : ''}; A = ${builds.A.source} (${builds.A.versionLabel})${builds.B ? ', B = ' + builds.B.source + ' (' + builds.B.versionLabel + ')' : ''}; copies in ${files.dir}` +
        (args.gpu ? `; own launch (${args.headless ? 'headless' : 'headed'}, system GPU)` : ''));
    const runs = [], failures = [];
    let stopped = false;
    for (let i = 0; i < order.length; i++) {
        const o = order[i], b = builds[o.build];
        say(`run ${i + 1}/${order.length}: ${o.build} (pair ${o.pair})`);
        const fn = args.mode === 'D' ? runD : runR;
        const before = await waitIdle(args, say);
        // other jobs are also sampled during the run (one that starts and ends inside it shows only here)
        const during = { samples: 0, busy: 0, maxLoad1: 0, jobs: [] };
        const sampler = setInterval(() => {
            const L = foreignLoad();
            during.samples++; during.maxLoad1 = Math.max(during.maxLoad1, L.loadavg[0]);
            if (L.busy) { during.busy++; for (const j of L.jobs) if (during.jobs.length < 20 && !during.jobs.includes(j)) during.jobs.push(j); }
        }, 15000);
        let r = null;
        try {
            if (before.refused) throw new Error(`refused: other jobs still running after ${before.waitedS} s (${describeLoad(before.load)}); --allow-load runs anyway`);
            const now = fileInfo(b.copy);
            if (now.sha256 !== b.sha256) throw new Error(`the copy ${b.copy} changed since start-up (sha256 ${now.sha256.slice(0, 12)})`);
            r = await fn(args, o.build, b, b.opts, b.pre);
        } catch (e) {
            await closeAll();
            const f = { index: i, build: o.build, pair: o.pair, error: String(e && e.message || e), stack: String(e && e.stack || '').split('\n').slice(0, 6).join('\n'), load: before.load, loadDuring: during };
            failures.push(f);
            say(`  ${o.build} FAILED: ${f.error.split('\n')[0]}`);
        }
        clearInterval(sampler);
        const after = foreignLoad();
        if (r) {
            r.index = i; r.pair = o.pair; r.discarded = discardFirst && o.pair === 0;
            r.load = { before: before.load, during, after, waitedS: before.waitedS };
            r.contaminated = !!(before.load.busy || during.busy || after.busy);
            runs.push(r);
            say(`  ${o.build}: ${fmt(r.avgFps)} FPS, 1% low ${fmt(r.low1Fps)}, median ${fmt(r.medianMs)} ms, max ${fmt(r.maxMs)} ms @${r.maxFrame}, ` +
                `spikes ${r.spikes.over2xMedian.count}/${r.spikes.over50ms.count}/${r.spikes.over2xMedianAnd50ms.count}, draws ${fmt(r.drawCalls, 0)}, programs ${r.endPrograms.programs}/${r.endPrograms.watermark} (boot wm ${r.bootPrograms.watermark}), stalls ${r.stalls}, ` +
                `errors ${r.errors.length + (r.pageErrors ? r.pageErrors.length : 0)}, load ${before.load.loadavg[0]}${r.contaminated ? ' (other jobs running)' : ''}, launch+boot ${(r.launchAndBootMs / 1000).toFixed(1)} s` + (r.driveS ? `, drive ${r.driveS} s` : ''));
            for (const w of r.warnings) say('  WARNING: ' + w);
            if (args.trace && r.hashes) for (const h of r.hashes) say(`    frame ${h[0]} pixels ${h[1]} state ${h[2]} you ${JSON.stringify(h[3])} health ${h[4]}`);
        }
        writeReport(args, makeReport(ctx, runs, failures, 'incomplete'));
        if (!r && !args.keepGoing) { stopped = true; break; }
    }
    // the sources may have been edited meanwhile (the runs used the start-up copies)
    for (const L of Object.keys(files.builds)) {
        const fb = files.builds[L], src = path.resolve(REPO, fb.source);
        try { const now = fileInfo(src); fb.sourceAtEnd = { sha256: now.sha256, size: now.size, mtime: now.mtime, changed: now.sha256 !== fb.sha256 }; }
        catch (e) { fb.sourceAtEnd = { error: e.message, changed: true }; }
        if (fb.sourceAtEnd.changed) ctx.warnings.push(`${L}'s source ${fb.source} changed during the benchmark; the runs used the copy made at start-up (sha256 ${fb.sha256.slice(0, 12)})`);
    }
    ctx.loadAtEnd = foreignLoad();
    if (runs.some((r) => r.contaminated)) ctx.warnings.push('other browsers or test jobs were running during some runs (see contaminatedRuns): those figures are not comparable');
    const status = stopped ? 'stopped' : failures.length ? 'complete-with-failures' : 'complete';
    const report = makeReport(ctx, runs, failures, status);
    console.log('');
    printTable(report);
    writeReport(args, report);
    if (args.out) console.log('report: ' + path.resolve(args.out));
    if (failures.length) process.exitCode = 1;
}

main().catch(async (e) => {
    console.error(e && e.stack || e);
    await closeAll();
    process.exit(1);
});
