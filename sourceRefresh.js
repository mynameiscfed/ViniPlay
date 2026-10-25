// One refresh timer per provider, refreshing only that provider (plus the guide managed
// by an XC provider). Managed XC guides are covered by their parent's timer.
function planSourceRefreshes(settings) {
    const m3uSources = settings.m3uSources || [];
    const epgSources = settings.epgSources || [];
    const managedEpgIds = new Set(m3uSources.filter((s) => s.type === 'xc').map((s) => `epg_for_${s.id}`));
    const plan = [];

    for (const source of m3uSources) {
        if (!source.isActive || !(source.refreshHours > 0)) continue;
        if (source.type === 'url') {
            plan.push({ id: source.id, name: source.name, hours: source.refreshHours, onlyIds: [source.id] });
        } else if (source.type === 'xc') {
            plan.push({ id: source.id, name: source.name, hours: source.refreshHours, onlyIds: [source.id, `epg_for_${source.id}`] });
        }
    }

    for (const source of epgSources) {
        if (!source.isActive || !(source.refreshHours > 0) || source.type !== 'url') continue;
        if (managedEpgIds.has(source.id)) continue;
        plan.push({ id: source.id, name: source.name, hours: source.refreshHours, onlyIds: [source.id] });
    }

    return plan;
}

module.exports = { planSourceRefreshes };
