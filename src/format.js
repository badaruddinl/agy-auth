export function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

export function printAccounts(registry) {
  const accounts = registry.accounts || [];
  console.log('     ACCOUNT                         ALIAS        AUTH     GEMINI 5H          GEMINI WEEKLY      OTHER 5H           OTHER WEEKLY       LAST REFRESH');
  console.log('------------------------------------------------------------------------------------------------------------------------------------------');
  if (accounts.length === 0) {
    console.log('  -- no AGY accounts captured; run `agy-auth import`');
    return;
  }
  for (const [index, account] of accounts.entries()) {
    const marker = account.accountKey === registry.activeAccountKey ? '*' : ' ';
    const alias = account.alias || '-';
    const auth = account.hasSnapshot === false ? 'missing' : 'yes';
    const usage = formatUsageColumns(account.usage);
    const refreshed = formatLastRefresh(account.usageAt || account.usage?.capturedAt);
    console.log(
      `${marker} ${String(index + 1).padStart(2, '0')} `
      + `${String(account.email || account.accountKey || '-').padEnd(31)} `
      + `${alias.padEnd(12)} `
      + `${auth.padEnd(8)} `
      + `${usage.geminiFiveHour.padEnd(18)} `
      + `${usage.geminiWeekly.padEnd(18)} `
      + `${usage.otherFiveHour.padEnd(18)} `
      + `${usage.otherWeekly.padEnd(18)} `
      + refreshed,
    );
  }
}

export function formatUsageColumns(usage) {
  const groups = Array.isArray(usage?.groups) ? usage.groups : [];
  const gemini = groups.find(group => /gemini/i.test(group.name)) || null;
  const other = groups.find(group => /claude|gpt/i.test(group.name)) || null;
  return {
    geminiFiveHour: formatLimit(gemini?.fiveHour),
    geminiWeekly: formatLimit(gemini?.weekly),
    otherFiveHour: formatLimit(other?.fiveHour),
    otherWeekly: formatLimit(other?.weekly),
  };
}

function formatLimit(limit) {
  if (!limit) return '-';
  const percent = Number.isFinite(limit.remainingPercent) ? `${limit.remainingPercent}%` : '?';
  return limit.refreshesIn ? `${percent} (${limit.refreshesIn})` : percent;
}

export function formatMinQuota(usage) {
  const groups = Array.isArray(usage?.groups) ? usage.groups : [];
  const values = groups.flatMap(group => [
    group.weekly?.remainingPercent,
    group.fiveHour?.remainingPercent,
  ]).filter(Number.isFinite);
  if (values.length === 0) return '-';
  return `${Math.min(...values)}% min`;
}

export function formatFirstReset(usage) {
  const groups = Array.isArray(usage?.groups) ? usage.groups : [];
  const resets = groups.flatMap(group => [
    group.weekly?.refreshesIn,
    group.fiveHour?.refreshesIn,
  ]).filter(Boolean);
  return resets[0] || '-';
}

export function formatLastRefresh(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 0) return date.toLocaleString();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'Now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
