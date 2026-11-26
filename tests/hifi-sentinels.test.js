'use strict';
// V2.2: High Fidelity looks, Sentinels (their role block in the game file; HIFI-CONTRACT.md). Add each
// converted ability with the key>renderer pairs it binds; roleTest checks it and the role's budget.
require('./hifi-kit').roleTest('Sentinels', {
    'sage.q': ['sage.q>projectile', 'sage.q>groundZone'],
    'killjoy.q': ['killjoy.q>deployable', 'killjoy.q>blast']
});
