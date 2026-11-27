'use strict';
// V2.2: High Fidelity looks, Sentinels (their role block in the game file; the API is in abilityLook's header). Add each
// converted ability with the key>renderer pairs it binds; roleTest checks it and the role's budget.
require('./hifi-kit').roleTest('Sentinels', {
    'sage.q': ['sage.q>projectile', 'sage.q>groundZone'],
    'killjoy.q': ['killjoy.q>deployable', 'killjoy.q>blast'],
    'sage.e': ['sage.e>self'],
    'sage.x': ['sage.x>self'],
    'killjoy.c': ['killjoy.c>projectile', 'killjoy.c>groundZone'],
    'killjoy.x': ['killjoy.x>deployable', 'killjoy.x>groundZone', 'killjoy.x>pulse'],
    'cypher.c': ['cypher.c>deployable', 'cypher.c>beam', 'cypher.c>flash'],
    'cypher.q': ['cypher.q>projectile', 'cypher.q>smoke'],
    'cypher.e': ['cypher.e>deployable', 'cypher.e>flash'],
    'cypher.x': ['cypher.x>pulse'],
    'chamber.c': ['chamber.c>deployable', 'chamber.c>groundZone', 'chamber.c>flash'],
    'chamber.q': ['chamber.q>beam'],
    'chamber.e': ['chamber.e>deployable', 'chamber.e>flash', 'chamber.e>self', 'chamber.e>groundZone'],
    'chamber.x': ['chamber.x>beam', 'chamber.x>flash', 'chamber.x>groundZone'],
    'deadlock.c': ['deadlock.c>projectile', 'deadlock.c>groundZone', 'deadlock.c>deployable'],
    'deadlock.q': ['deadlock.q>deployable', 'deadlock.q>blast'],
    'deadlock.e': ['deadlock.e>wall', 'deadlock.e>deployable'],
    'deadlock.x': ['deadlock.x>deployable', 'deadlock.x>beam', 'deadlock.x>blast'],
    'vyse.c': ['vyse.c>deployable', 'vyse.c>wall'],
    'vyse.q': ['vyse.q>deployable', 'vyse.q>flash'],
    'vyse.e': ['vyse.e>projectile', 'vyse.e>groundZone', 'vyse.e>deployable'],
    'vyse.x': ['vyse.x>groundZone', 'vyse.x>deployable', 'vyse.x>blast'],
    'veto.c': ['veto.c>deployable', 'veto.c>flash', 'veto.c>self'],
    'veto.q': ['veto.q>projectile', 'veto.q>groundZone', 'veto.q>blast'],
    'veto.e': ['veto.e>deployable', 'veto.e>flash', 'veto.e>beam'],
    'veto.x': ['veto.x>self', 'veto.x>pulse']
}, {
    // the Interceptor lands short of the wall ahead of the default spot (z 18.6): its target on this side, in its sight
    recipes: { 'veto.e': { target: [0, 20.5] } }
});
