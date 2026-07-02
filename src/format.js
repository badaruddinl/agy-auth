export function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

export function printAccounts(registry) {
  const accounts = registry.accounts || [];
  console.log('     ACCOUNT                         ALIAS        AUTH     QUOTA       RESET');
  console.log('----------------------------------------------------------------------------');
  if (accounts.length === 0) {
    console.log('  -- no AGY accounts captured; run `agy-auth import`');
    return;
  }
  for (const [index, account] of accounts.entries()) {
    const marker = account.accountKey === registry.activeAccountKey ? '*' : ' ';
    const alias = account.alias || '-';
    const auth = account.hasSnapshot === false ? 'missing' : 'yes';
    const quota = formatQuota(account.usage);
    const reset = formatReset(account.usage);
    console.log(`${marker} ${String(index + 1).padStart(2, '0')} ${String(account.email || account.accountKey || '-').padEnd(31)} ${alias.padEnd(12)} ${auth.padEnd(8)} ${quota.padEnd(11)} ${reset}`);
  }
}

export function formatQuota(usage) {
  const groups = Array.isArray(usage?.groups) ? usage.groups : [];
  const values = groups.flatMap(group => [
    group.weekly?.remainingPercent,
    group.fiveHour?.remainingPercent,
  ]).filter(Number.isFinite);
  if (values.length === 0) return '-';
  return `${Math.min(...values)}% min`;
}

export function formatReset(usage) {
  const groups = Array.isArray(usage?.groups) ? usage.groups : [];
  const resets = groups.flatMap(group => [
    group.weekly?.refreshesIn,
    group.fiveHour?.refreshesIn,
  ]).filter(Boolean);
  return resets[0] || '-';
}
