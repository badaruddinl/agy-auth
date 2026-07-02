export function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

export function printAccounts(registry) {
  const accounts = registry.accounts || [];
  console.log('     ACCOUNT                         ALIAS        AUTH');
  console.log('---------------------------------------------------------------');
  if (accounts.length === 0) {
    console.log('  -- no AGY accounts captured; run `agy-auth import`');
    return;
  }
  for (const [index, account] of accounts.entries()) {
    const marker = account.accountKey === registry.activeAccountKey ? '*' : ' ';
    const alias = account.alias || '-';
    const auth = account.hasSnapshot === false ? 'missing' : 'yes';
    console.log(`${marker} ${String(index + 1).padStart(2, '0')} ${String(account.email || account.accountKey || '-').padEnd(31)} ${alias.padEnd(12)} ${auth}`);
  }
}
