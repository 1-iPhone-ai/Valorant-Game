'use strict';
// V2.2: High Fidelity looks, Initiators (their role block in the game file; HIFI-CONTRACT.md). Add each
// converted ability with the key>renderer pairs it binds; roleTest checks it and the role's budget.
require('./hifi-kit').roleTest('Initiators', {
    'sova.e': ['sova.e>projectile', 'sova.e>pulse', 'sova.e>deployable'],
    'kayo.c': ['kayo.c>projectile', 'kayo.c>groundZone', 'kayo.c>blast'],
    'breach.q': ['breach.q>projectile', 'breach.q>flash']
});
