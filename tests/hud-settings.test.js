'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser } = require('./harness');

after(closeBrowser);

const rect = (page, sel) => page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const shown = cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.05 && r.width > 0;
    return { x: r.left, y: r.top, r: r.right, b: r.bottom, shown };
}, sel);
const overlap = (a, b) => a && b && a.shown && b.shown && a.x < b.r && b.x < a.r && a.y < b.b && b.y < a.b;

test('HUD at 1280x720: FPS cluster clear of the mode bar; help clear of the ability bar, then collapses', { timeout: 300000 }, async () => {
    const { page, errors, frames } = await boot({ viewport: { width: 1280, height: 720 } });
    const top = await rect(page, '#tactical-top-bar');
    for (const sel of ['#fps-display', '#quality-toggle', '#fps-sparkline-widget']) {
        assert.ok(!overlap(await rect(page, sel), top), `${sel} must not cover the mode bar`);
    }
    // Opens at start on a 1280x720 window. (Booting under load can take longer
    // than the 12 s auto-hide, so the start state is recorded, not sampled late.)
    assert.equal(await page.evaluate(() => controlsHelp.startedExpanded), true, 'help is shown at start');
    // Collapses to the pill after 12 s
    await page.waitForFunction(() => !controlsHelp.expanded, null, { timeout: 30000 });
    // The pill fades in: wait for the fade rather than a fixed number of frames
    await page.waitForFunction(() => parseFloat(getComputedStyle(document.getElementById('controls-hint-pill')).opacity) > 0.8, null, { timeout: 10000 });
    assert.equal((await rect(page, '#controls-hint-pill')).shown, true, 'pill shows after auto-collapse');
    // I re-opens it, clear of the centred agent/ability bars
    await page.keyboard.press('KeyI');
    assert.equal(await page.evaluate(() => controlsHelp.expanded), true, 'I re-opens the help');
    await page.waitForFunction(() => parseFloat(getComputedStyle(document.getElementById('controls-hint-box')).opacity) > 0.95, null, { timeout: 10000 });
    const help = await rect(page, '#controls-hint-box');
    assert.ok(help.shown);
    assert.ok(!overlap(help, await rect(page, '#ability-bar')), 'help must not cover the ability bar');
    assert.ok(!overlap(help, await rect(page, '#agent-switcher-bar')), 'help must not cover the agent bar');
    await page.keyboard.press('KeyI');
    assert.equal(await page.evaluate(() => controlsHelp.expanded), false);
    // The HUD "hints" setting hides the pill too
    await page.evaluate(() => { game.userSettings.showHints = false; settingsManager.applyHudVisibility(); });
    assert.equal((await rect(page, '#controls-hint-pill')).shown, false);
    assert.deepEqual(errors, []);
});

test('HUD at 1024x600: help starts collapsed and the mode bar clears the minimap', { timeout: 300000 }, async () => {
    const { page, errors } = await boot({ viewport: { width: 1024, height: 600 } });
    assert.equal(await page.evaluate(() => controlsHelp.expanded), false, 'small windows start collapsed');
    assert.ok(!overlap(await rect(page, '#tactical-top-bar'), await rect(page, '#minimap-container')), 'mode bar must not run under the minimap');
    assert.deepEqual(errors, []);
});

test('settings are remembered across reloads by default, and the opt-out sticks', { timeout: 400000 }, async () => {
    const { page, errors } = await boot();
    const reload = async () => {
        await page.reload();
        await page.waitForFunction(() => window.perfTelemetry && perfTelemetry.programWatermark > 0, null, { timeout: 180000 });
    };
    // Fresh browser: saving is on, a change survives a reload
    await page.evaluate(() => localStorage.clear());
    await reload();
    assert.equal(await page.evaluate(() => game.userSettings.localStorageEnabled), true, 'saving is on by default');
    // V1.9: the FPS graph is off for a new player, and a saved choice still loads
    assert.equal(await page.evaluate(() => game.userSettings.showSparkline), false, 'FPS graph off by default');
    await page.evaluate(() => { game.userSettings.showSparkline = true; settingsManager.saveToStorage(); });
    await reload();
    assert.equal(await page.evaluate(() => game.userSettings.showSparkline), true, 'a saved FPS graph setting is kept');
    // V1.9: ability names are on by default, also for a save from before the setting existed,
    // and a saved choice to hide them is kept
    assert.equal(await page.evaluate(() => game.userSettings.showAbilityNames), true, 'ability names on by default');
    await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('valorant_v16_user_settings')); delete s.showAbilityNames; localStorage.setItem('valorant_v16_user_settings', JSON.stringify(s)); });
    await reload();
    assert.equal(await page.evaluate(() => game.userSettings.showAbilityNames), true, 'an older save gets ability names on');
    await page.evaluate(() => { game.userSettings.showAbilityNames = false; settingsManager.saveToStorage(); });
    await reload();
    assert.deepEqual(await page.evaluate(() => [game.userSettings.showAbilityNames, document.getElementById('ability-bar').classList.contains('show-names')]), [false, false], 'a saved choice to hide them is kept');
    await page.evaluate(() => {
        game.userSettings.atmosphereMode = 'night';
        game.userSettings.brightness = 125;
        settingsManager.saveToStorage();
    });
    await reload();
    assert.deepEqual(await page.evaluate(() => [game.userSettings.atmosphereMode, game.userSettings.brightness]), ['night', 125], 'settings restored after reload');

    // Opting out clears the save and stays off after a reload
    await page.evaluate(() => document.getElementById('settings-ls-toggle-btn').click());
    assert.equal(await page.evaluate(() => game.userSettings.localStorageEnabled), false);
    await reload();
    const after = await page.evaluate(() => ({ on: game.userSettings.localStorageEnabled, atmo: game.userSettings.atmosphereMode, label: document.getElementById('settings-ls-toggle-btn').textContent }));
    assert.equal(after.on, false, 'opt-out is remembered');
    assert.equal(after.atmo, 'daylight', 'saved settings were cleared');
    assert.match(after.label, /OFF/);
    assert.deepEqual(errors, []);
});

// V1.7 HUD Size: every panel scales together, nothing overlaps or leaves the
// window at any size, and the size is capped on small windows
// V1.9: the weapon list (now at the right edge) is checked too
const PANELS = ['#minimap-container', '#tactical-top-bar', '#fps-display', '#quality-toggle', '#fps-sparkline-widget',
    '#controls-hint-box', '#ability-bar', '#agent-switcher-bar', '.vitals-panel', '.ammo-display', '#weapon-selector', '.score', '#kill-feed'];
test('HUD Size 80-130%: panels scale together with no overlaps at 1280x720, 1920x1080 and 1024x600', { timeout: 600000 }, async () => {
    for (const [w, h] of [[1280, 720], [1920, 1080], [1024, 600]]) {
        const { page, errors, evaluate } = await boot({ viewport: { width: w, height: h } });
        // Show the help panel so it is checked too
        await evaluate(() => controlsHelp.set(true));
        for (const pct of [80, 100, 130]) {
            const r = await evaluate(([pct, PANELS]) => {
                const el = document.getElementById('setting-hud-scale');
                el.value = pct;
                el.dispatchEvent(new Event('input'));
                const rects = {};
                for (const q of PANELS) {
                    const node = document.querySelector(q);
                    if (!node) continue;
                    const cs = getComputedStyle(node);
                    const b = node.getBoundingClientRect();
                    if (b.width === 0 || cs.display === 'none' || parseFloat(cs.opacity) < 0.05) continue;
                    // The kill feed is empty here: reserve room for a few entries
                    rects[q] = q === '#kill-feed' ? { left: b.left, right: b.right, top: b.top, bottom: b.top + 120 } : b;
                }
                const keys = Object.keys(rects), overlaps = [];
                for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
                    const a = rects[keys[i]], b = rects[keys[j]];
                    if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) overlaps.push(`${keys[i]} x ${keys[j]}`);
                }
                const offscreen = keys.filter((k) => rects[k].left < -1 || rects[k].top < -1 || rects[k].right > innerWidth + 1 || rects[k].bottom > innerHeight + 1);
                // V1.9 clear zone: nothing permanent between the left and right columns from 20%
                // to 85% of the height (the help panel, agent strip and kill feed come and go)
                const left = ['#minimap-container', '.vitals-panel', '#fps-display', '#quality-toggle', '#fps-sparkline-widget'].filter((k) => rects[k]).map((k) => rects[k].right);
                const right = ['#weapon-selector', '.score'].filter((k) => rects[k]).map((k) => rects[k].left);
                const zone = { left: Math.max(...left), right: Math.min(...right), top: innerHeight * 0.2, bottom: innerHeight * 0.85 };
                const inZone = keys.filter((k) => !['#controls-hint-box', '#agent-switcher-bar', '#kill-feed'].includes(k))
                    .filter((k) => rects[k].left < zone.right && zone.left < rects[k].right && rects[k].top < zone.bottom && zone.top < rects[k].bottom);
                const rowTop = document.querySelector('.center-hud-column').getBoundingClientRect().top;
                // every weapon name fits its row
                const cutNames = Array.from(document.querySelectorAll('#weapon-selector .weapon-name')).filter((n) => n.scrollWidth > n.clientWidth + 0.5).map((n) => n.textContent);
                return {
                    overlaps, offscreen, inZone, cutNames, rowTall: innerHeight - rowTop, scale: hudScale.value(),
                    minimap: document.getElementById('minimap-container').getBoundingClientRect().width,
                    saved: JSON.parse(localStorage.getItem('valorant_v16_user_settings') || '{}').hudScale
                };
            }, [pct, PANELS]);
            const tag = `${w}x${h} @ ${pct}%`;
            assert.deepEqual(r.overlaps, [], `${tag}: no overlapping panels`);
            assert.deepEqual(r.offscreen, [], `${tag}: everything on screen`);
            assert.deepEqual(r.inZone, [], `${tag}: nothing permanent in the middle of the screen`);
            assert.deepEqual(r.cutNames, [], `${tag}: weapon names fit`);
            // V1.9: one bottom row, at most 96 px tall with its margin at the reference size
            assert.ok(r.rowTall <= 96 * r.scale + 0.5, `${tag}: bottom row ${r.rowTall.toFixed(1)} px tall`);
            assert.ok(Math.abs(r.minimap - 186 * r.scale) < 2, `${tag}: minimap scaled to ${r.scale}`);
            assert.ok(r.scale <= pct / 100 + 1e-9 && r.scale >= 0.8, `${tag}: scale ${r.scale} within the chosen size`);
            assert.equal(r.saved, pct, `${tag}: saved`);
        }
        assert.deepEqual(errors, []);
    }
});

// V1.9 HUD layout: one bottom row of ability slots (named by default; 56 px squares with
// Ability Names off) and the ammo, a short-lived agent strip, the weapons listed at the
// right edge, one-line teammate plates and a one-line FPS readout
test('V1.9 HUD: bottom row, agent strip, weapon list, teammate plates and one-line FPS readout', { timeout: 300000 }, async () => {
    const { page, errors, frames, evaluate } = await boot({ viewport: { width: 1280, height: 720 } });
    const row = await evaluate(() => {
        const r = (q) => document.querySelector(q).getBoundingClientRect();
        const slot = r('#ability-slot-c'), bar = r('#ability-bar'), ammo = r('.ammo-display'), weapons = r('#weapon-selector'), score = r('.score');
        return {
            slot: [Math.round(slot.width), Math.round(slot.height)],
            tall: innerHeight - Math.min(bar.top, ammo.top),
            sameRow: ammo.left >= bar.right && ammo.top < bar.bottom && bar.top < ammo.bottom,
            nameShown: getComputedStyle(document.getElementById('ability-name-c')).display !== 'none',
            title: document.getElementById('ability-slot-c').title, name: document.getElementById('ability-name-c').textContent,
            weaponsAboveScore: weapons.bottom <= score.top && weapons.right > innerWidth - 40,
            rows: Array.from(document.querySelectorAll('#weapon-selector .weapon-slot')).map((s) => s.getBoundingClientRect().height)
        };
    });
    assert.deepEqual(row.slot, [78, 64], 'with Ability Names on (the default) the slots are 78 x 64 px');
    assert.ok(row.tall <= 96, `the bottom row stays within 96 px of the bottom (${row.tall})`);
    assert.ok(row.sameRow, 'the ammo sits beside the abilities');
    assert.equal(row.nameShown, true, 'ability names show under the icons by default');
    assert.equal(row.title, row.name, 'the slot tooltip names the ability');
    assert.ok(row.weaponsAboveScore, 'the weapons are listed at the right edge above the score');
    assert.ok(row.rows.length === 4 && row.rows.every((h) => h < 30), 'one short row per weapon');

    // Every agent's ability names show in full: a long one gets a smaller line or two lines
    const cut = await evaluate(() => {
        const out = [];
        for (const id of AGENT_ORDER) {
            agentSystem.selectAgent(id);
            for (const k of ['c', 'q', 'e', 'x']) {
                const n = document.getElementById('ability-name-' + k), slot = n.parentElement;
                const nb = n.getBoundingClientRect(), pb = document.getElementById('ability-pips-' + k).getBoundingClientRect();
                const lines = Math.round(nb.height / parseFloat(getComputedStyle(n).lineHeight));
                if (n.scrollWidth > n.clientWidth + 0.5 || lines > (slot.classList.contains('two-line') ? 2 : 1) || nb.bottom > pb.top + 0.5) out.push(`${id} ${k}: ${n.textContent}`);
            }
        }
        return out;
    });
    assert.deepEqual(cut, [], 'every ability name fits its slot');
    // Hiding them (Settings > HUD) gives the compact 56 px slots
    await evaluate(() => document.querySelector('#setting-hud-abilitynames-pills [data-abilitynames="hide"]').click());
    assert.deepEqual(await evaluate(() => { const b = document.getElementById('ability-slot-c').getBoundingClientRect(); return [Math.round(b.width), Math.round(b.height), getComputedStyle(document.getElementById('ability-name-c')).display]; }), [56, 56, 'none']);
    await evaluate(() => document.querySelector('#setting-hud-abilitynames-pills [data-abilitynames="show"]').click());

    // Agent strip: shows on an agent change and at a new round, gone after 4 s; the passive
    // and the [G]/[TAB] hint are in the controls help
    await evaluate(() => agentSystem.selectAgent('sage'));
    assert.deepEqual(await evaluate(() => { const el = document.getElementById('agent-switcher-bar'); return [el.classList.contains('show'), el.textContent.replace(/\s+/g, ' ').trim()]; }), [true, 'SAGE SENTINEL']);
    await page.waitForFunction(() => getComputedStyle(document.getElementById('agent-switcher-bar')).visibility === 'hidden', null, { timeout: 30000 });
    await evaluate(() => tacticalDirector.advanceWave('TEST', performance.now()));
    assert.equal(await evaluate(() => document.getElementById('agent-switcher-bar').classList.contains('show')), true, 'a new wave shows the strip');
    const help = await evaluate(() => document.querySelector('#controls-hint-box .hint-agent-line').textContent);
    assert.ok(help.includes(await evaluate(() => AGENT_DEFS[game.activeAgent].passiveText)) && /\[G\] PICKER/.test(help), 'passive and picker hint are in the help');

    // FPS readout: one line; the quality name cycles the quality, the FPS opens Settings > FPS;
    // the quality pill and the graph are hidden by default
    const perf = await evaluate(() => ({ text: fpsDisplay.textContent, pill: getComputedStyle(qualityToggle).display, graph: getComputedStyle(document.getElementById('fps-sparkline-widget')).display }));
    assert.match(perf.text, /^\d+ FPS \/ Medium$/);
    assert.deepEqual([perf.pill, perf.graph], ['none', 'none']);
    await evaluate(() => document.querySelector('#fps-display .perf-q').click());
    assert.deepEqual(await evaluate(() => [adaptiveSettings.currentQuality, !!game.settingsOpen, fpsDisplay.textContent.split(' / ')[1]]), ['high', false, 'High']);
    await evaluate(() => document.querySelector('#fps-display .perf-fps').click());
    assert.deepEqual(await evaluate(() => [!!game.settingsOpen, document.querySelector('#settings-tabs-bar .settings-tab-btn.active').dataset.tab]), [true, 'fps']);
    // The detailed mode keeps its quality pill under the multi-line text
    await evaluate(() => document.querySelector('#setting-fps-mode-pills [data-fpsmode="detailed"]').click());
    assert.deepEqual(await evaluate(() => [qualityToggle.style.display, qualityToggle.style.top]), ['block', '318px']);
    await evaluate(() => { document.querySelector('#setting-fps-mode-pills [data-fpsmode="compact"]').click(); settingsManager.toggleSettings(false); });

    // Teammate plates: the agent name on one line over a thin health bar, at most 96 px
    // wide; health shows on the bar; faded while near the crosshair
    const plates = await evaluate(() => tacticalEnhancements.wingmanBots.map((b) => ({ text: b.hudEl.textContent.trim(), w: b.hudEl.offsetWidth, h: b.hudEl.offsetHeight })));
    assert.deepEqual(plates.map((p) => p.text), ['SAGE', 'REYNA']);
    assert.ok(plates.every((p) => p.w <= 96 && p.h <= 24), `small one-line plates (${JSON.stringify(plates)})`);
    await evaluate(() => {
        const b = tacticalEnhancements.wingmanBots[0];
        b.health = 40;
        window.__look = setInterval(() => camera.rotation.set(0, Math.atan2(-(b.group.position.x - camera.position.x), -(b.group.position.z - camera.position.z)), 0), 5);
    });
    await frames(6);
    const near = await evaluate(() => { const b = tacticalEnhancements.wingmanBots[0]; return [b.hpFillEl.style.width, b.hudEl.classList.contains('near-crosshair'), getComputedStyle(b.hudEl).opacity]; });
    await evaluate(() => { clearInterval(window.__look); delete tacticalEnhancements.wingmanBots[0].health; });
    assert.deepEqual(near.slice(0, 2), ['40%', true], 'health on the bar; faded near the crosshair');
    assert.ok(Math.abs(parseFloat(near[2]) - 0.35) < 0.05, `about 35% opacity (${near[2]})`);
    assert.deepEqual(errors, []);
});
