'use strict';
// V2.2: High Fidelity looks, Duelists (their role block in the game file; HIFI-CONTRACT.md). Add each
// converted ability with the key>renderer pairs it binds; roleTest checks it and the role's budget.
require('./hifi-kit').roleTest('Duelists', {
    'iso.c': ['iso.c>wall'],
    'neon.e': ['neon.e>self'],
    'raze.x': ['raze.x>projectile', 'raze.x>blast']
});
