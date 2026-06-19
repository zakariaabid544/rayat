#!/usr/bin/env node
// Rayat Intelligence — Sprint 2.7B · Comando replay storico (manuale, NON schedulato).
// Uso:
//   node scripts/run-historical-replay.js --from 2025-01-01 --to 2025-06-01 [--batch 500] [--dry-run] [--rebuild] [--owner <id>] [--device <id>]
//   node scripts/run-historical-replay.js --cancel --from ... --to ... [--owner|--device]
// Richiede DATABASE_URL. NON esegue automaticamente la catena Sprint 2 (lanciala dopo se vuoi rigenerare le derivate).
'use strict';
require('../config/env');
const { runHistoricalReplay, requestReplayCancel, replayKey, ensureReplaySchema } = require('../utils/historical-replay');

function arg(name, def) {
    const i = process.argv.indexOf(`--${name}`);
    if (i === -1) { return def; }
    const v = process.argv[i + 1];
    return (v && !v.startsWith('--')) ? v : true;
}

(async () => {
    const from = arg('from');
    const to = arg('to');
    if (!from || !to) { console.error('ERRORE: --from e --to sono obbligatori (ISO date).'); process.exit(1); }
    const scope = {};
    if (arg('owner')) { scope.ownerUserId = Number(arg('owner')); }
    if (arg('device')) { scope.deviceId = Number(arg('device')); }
    const opts = {
        from, to,
        batchSize: arg('batch') ? Number(arg('batch')) : undefined,
        dryRun: !!arg('dry-run'),
        rebuild: !!arg('rebuild'),
        scope: (scope.ownerUserId != null || scope.deviceId != null) ? scope : null
    };
    try {
        await ensureReplaySchema();
        if (arg('cancel')) {
            const id = replayKey({ fromTs: from, toTs: to, scope: opts.scope });
            const r = await requestReplayCancel(id);
            console.log('[replay] cancel richiesto per', id, '->', r ? r.status : 'n/d');
            process.exit(0);
        }
        console.log('[replay] avvio', JSON.stringify(opts));
        const summary = await runHistoricalReplay(opts);
        console.log('[replay] risultato:', JSON.stringify(summary, null, 2));
        process.exit(0);
    } catch (error) {
        console.error('[replay] ERRORE (fail-closed):', error && error.message);
        process.exit(1);
    }
})();
