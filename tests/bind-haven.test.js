'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser } = require('./harness');
const mapSuite = require('./map-suite');

after(closeBrowser);

// V2.1 Bind and Haven: their own layouts in Ascent's format (plan, build, layout, callouts).
// Every check runs on the game's own geometry (pieces, colliders, walk grid, line of sight); the
// shared checks are in map-suite.js, Bind's teleporters below.

// Per map: lane interiors (plan rects, cut short of the spawns and the site doors, where lanes
// may meet), the lane pairs that may see each other, each site's entrances (a point in each
// doorway), the heaven spot, and callouts at known points
const MAPS = {
    bind: {
        keys: ['A', 'B'],
        lanes: {
            CAMEL: [['roadW', { zMax: -14 }], ['roadN'], ['roadJog']],
            HALL: [['hallLane', { zMax: -10 }], ['hall']],
            CARAVAN: [['cRoadW', { zMin: 14 }], ['cRoadS', { xMax: -6 }]],
            CISTERN: [['cisLane', { zMin: 10 }], ['cistern']],
            COPPER: [['copperN', { zMax: -14 }], ['copperW', { xMin: 22 }]],
            ARCADE: [['arcS', { zMin: 14 }], ['arcW', { xMin: 24 }]],
            CLOCK: [['clockUp'], ['clockLane', { xMin: 23 }]]
        },
        meet: [['ARCADE', 'CLOCK']],
        siteRects: { A: 'aSite', B: 'bSite' },
        entrances: { A: [[0.3, -38], [0.3, -30.5], [15.7, -35.5]], B: [[4.3, 42], [6, 28.3], [19.7, 31.5], [19.7, 42]] },
        chokes: [['x', -32, 'roadN'], ['x', -22.5, 'hallExit'], ['x', -28, 'cRoadS'], ['x', -18.5, 'cisExit'], ['x', 29.5, 'copperW'], ['x', 29.5, 'arcW']],
        heaven: { from: [4.6, -42.5], yaw: -Math.PI / 2, x: 10.6, zone: 'A TOWER' },
        zones: [[-44, -25, 'CAMEL ROAD'], [-27, -31, 'SPICE HALL'], [8, -39, 'A SITE'], [45, -22, 'COPPER LANE'], [-44, 25, 'CARAVAN ROAD'], [-10, 43, 'PALM GARDEN'],
            [-25, 26, 'CISTERN'], [12, 40, 'B SITE'], [45, 20, 'LANTERN ARCADE'], [27, 42, 'CLOCK LANE'], [29.5, 0, 'CARAVANSERAI'], [-44, 0, 'ATTACKER SPAWN'], [44, 0, 'DEFENDER SPAWN']]
    },
    haven: {
        keys: ['A', 'B', 'C'],
        smallest: 'B',
        nearest: 'B',
        lanes: {
            LONG: [['longW', { zMax: -14 }], ['longN']],
            CLOISTER: [['cloister', { zMax: -15 }], ['cloisterE', { xMax: -3 }]],
            MID: [['court'], ['midW', { xMin: -33 }]],
            GRANARY: [['granN', { zMin: 15 }], ['granary'], ['granExit', { xMax: -3 }]],
            ALLEY: [['longCW', { zMin: 14 }], ['longCS']],
            LIBRARY: [['aLinkN', { zMax: -14 }], ['aLinkW', { xMin: 32 }], ['libLink']],
            KITCHEN: [['cLinkN', { zMin: 14 }], ['cLinkW', { xMin: 32 }]]
        },
        meet: [['CLOISTER', 'MID'], ['GRANARY', 'MID'], ['LIBRARY', 'KITCHEN']],
        siteRects: { A: 'aSite', B: 'bSite', C: 'cSite' },
        entrances: { A: [[2.3, -38], [2.3, -30.5], [17.7, -35.5]], B: [[18.3, -5], [18.3, 2.75], [27, -8.7], [27, 8.7]], C: [[2.3, 38], [2.3, 30.5], [17.7, 35.5]] },
        chokes: [['x', -28, 'longN'], ['x', -28, 'longCS'], ['x', -9.5, 'cloisterE'], ['x', -9.5, 'granExit'], ['x', -31, 'midW'], ['x', 4.5, 'winLane'], ['x', 31.5, 'aLinkW'], ['x', 31.5, 'cLinkW']],
        heaven: { from: [6.6, -42.5], yaw: -Math.PI / 2, x: 12.6, zone: 'BELL TOWER' },
        zones: [[-44, -25, 'PILGRIM WALK'], [-23, -22, 'CLOISTER'], [9, -38, 'A SITE'], [45, -22, 'LIBRARY'], [-16, 4, 'PRAYER COURT'], [8, -5, 'LAMP WINDOW'], [8, 2.75, 'SHRINE DOORS'],
            [21, -5, 'B SITE'], [-21, 27, 'GRANARY'], [-21, 46, 'MILL NOOK'], [-36, 41, 'MILL ALLEY'], [8, 37, 'C SITE'], [27, 20, 'KITCHEN YARD'], [-44, 0, 'ATTACKER SPAWN'], [44, 0, 'DEFENDER SPAWN']]
    }
};

mapSuite('Bind and Haven', MAPS);

test('Bind teleporters: one-way pads from the layout, a loud arrival sound, nothing on the other maps', { timeout: 300000 }, async () => {
    const { errors, frames, evaluate } = await boot({ quality: 'low' });
    await evaluate(() => { window.updateEnemies = () => {}; tacticalDirector.setGameMode('wave'); rebuildMapPreset('bind'); });
    await frames(3);
    const r = await evaluate(() => {
        const td = tacticalDirector, L = mapLayout(), cc = characterController, out = { pads: [], trips: [], back: [] };
        let exits = 0;
        const realExit = soundFX.teleporterExit;
        soundFX.teleporterExit = function () { exits++; return realExit.apply(this, arguments); };
        td.updateBindTeleporters(0.016, performance.now());
        out.subtitle = MAP_PRESETS.bind.subtitle;
        out.shown = td.bindTeleporterGroup.visible;
        for (const p of td.bindPads) out.pads.push([p.pad.visible, +p.pad.position.x.toFixed(2), +p.pad.position.z.toFixed(2)]);
        for (const t of L.teleporters) {
            // On the pad: sent to the exit, facing the way the layout says
            td.lastPlayerTeleportAt = 0;
            cc.position.set(t.from.x, cc.standHeight, t.from.z); cc.prevSimPosition.copy(cc.position);
            td.updateBindTeleporters(0.016, performance.now() + 10000);
            out.trips.push([+cc.position.x.toFixed(2), +cc.position.z.toFixed(2), +camera.rotation.y.toFixed(3), t.to.x, t.to.z, +t.to.yaw.toFixed(3)]);
            // At the exit: no way back
            td.lastPlayerTeleportAt = 0;
            td.updateBindTeleporters(0.016, performance.now() + 20000);
            out.back.push([+cc.position.x.toFixed(2), +cc.position.z.toFixed(2)]);
        }
        out.exits = exits;
        soundFX.teleporterExit = realExit;
        rebuildMapPreset('haven');
        td.updateBindTeleporters(0.016, performance.now());
        out.onHaven = td.bindTeleporterGroup.visible;
        rebuildMapPreset('ascent');
        td.updateBindTeleporters(0.016, performance.now());
        out.onAscent = td.bindTeleporterGroup.visible;
        return out;
    });
    assert.match(r.subtitle, /One-Way/);
    assert.equal(r.shown, true);
    assert.equal(r.pads.length, 2);
    for (const p of r.pads) assert.equal(p[0], true);
    for (const t of r.trips) {
        assert.deepEqual(t.slice(0, 2), t.slice(3, 5), 'sent to the exit');
        assert.equal(t[2], t[5], 'facing the layout\'s way');
    }
    for (let i = 0; i < r.back.length; i++) assert.deepEqual(r.back[i], r.trips[i].slice(0, 2), 'one way: standing at the exit sends you nowhere');
    assert.equal(r.exits, 2, 'a loud sound on each arrival');
    assert.equal(r.onHaven, false);
    assert.equal(r.onAscent, false);
    await frames(2);
    assert.deepEqual(errors, []);
});
