'use strict';
// V2.2: High Fidelity looks, Duelists (their role block in the game file; the API is in abilityLook's header). Add each
// converted ability with the key>renderer pairs it binds; roleTest checks it and the role's budget.
// Phoenix's Run It Back comes last: its anchor ends only with its ultimate, which a cast's reset skips, so
// it stays out. A kill's soul orb (Reyna's passive, drawn by Devour's look) is dropped for Empress, which
// leaves it out; Devour and Dismiss eat theirs at once. Iso's Double Tap gets a kill first, for its orb.
// Fakeout's decoy is sent down the long open corridor: from the default spot it bounces off cover before it
// reaches the bot, and never pops.
require('./hifi-kit').roleTest('Duelists', {
    'iso.c': ['iso.c>wall'],
    'neon.e': ['neon.e>self'],
    'raze.x': ['raze.x>projectile', 'raze.x>blast'],
    'jett.c': ['jett.c>projectile', 'jett.c>smoke'],
    'jett.q': ['jett.q>self'],
    'jett.x': ['jett.x>self'],
    'phoenix.e': ['phoenix.e>flash', 'phoenix.e>self'],
    'reyna.c': ['reyna.c>deployable'],
    'reyna.q': ['reyna.q>beam', 'reyna.q>self'],
    'reyna.e': ['reyna.e>beam', 'reyna.e>self'],
    'reyna.x': ['reyna.x>flash', 'reyna.x>self', 'reyna.q>projectile'],
    'raze.c': ['raze.c>deployable', 'raze.c>blast'],
    'raze.q': ['raze.q>blast', 'raze.q>self'],
    'yoru.c': ['yoru.c>deployable', 'yoru.c>flash'],
    'yoru.q': ['yoru.q>projectile', 'yoru.q>flash'],
    'yoru.e': ['yoru.e>deployable', 'yoru.e>groundZone', 'yoru.e>flash', 'yoru.e>self'],
    'yoru.x': ['yoru.x>flash', 'yoru.x>self'],
    'neon.c': ['neon.c>wall', 'neon.c>groundZone'],
    'neon.q': ['neon.q>projectile', 'neon.q>blast'],
    'neon.x': ['neon.x>flash', 'neon.x>beam', 'neon.x>self'],
    'iso.q': ['iso.q>projectile', 'iso.q>flash'],
    'iso.e': ['iso.e>flash', 'iso.e>self', 'iso.e>projectile'],
    'iso.x': ['iso.x>wall', 'iso.x>groundZone', 'iso.x>flash', 'iso.x>self'],
    'waylay.c': ['waylay.c>projectile', 'waylay.c>groundZone', 'waylay.c>deployable', 'waylay.c>blast'],
    'waylay.q': ['waylay.q>self'],
    'waylay.e': ['waylay.e>deployable', 'waylay.e>flash'],
    'waylay.x': ['waylay.x>groundZone', 'waylay.x>deployable', 'waylay.x>blast'],
    'phoenix.x': ['phoenix.x>deployable']
}, { recipes: { 'reyna.x': { orb: [1.5, 20] }, 'yoru.c': { at: [-40, 1.7, 0], aim: [-0.1, Math.PI], target: [-40, 9] }, 'iso.e': { orb: [0, 14] } } });
