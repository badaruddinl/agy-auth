import { spawn } from 'node:child_process';

export function spawnAgyProcess(args = [], options = {}) {
  const command = process.platform === 'win32' ? 'cmd.exe' : 'agy';
  const commandArgs = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'agy', ...args]
    : args;
  const child = spawn(command, commandArgs, {
    cwd: process.cwd(),
    env: options.env || process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  return {
    onData(handler) {
      child.stdout.on('data', handler);
      child.stderr.on('data', handler);
    },
    onExit(handler) {
      child.on('exit', (exitCode, signal) => handler({ exitCode, signal }));
      child.on('error', error => handler({ exitCode: null, signal: null, error }));
    },
    write(value) {
      if (!child.stdin.destroyed) child.stdin.write(value);
    },
    kill() {
      try {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      } catch {
        // best effort
      }
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        killer.on('error', () => {});
        killer.unref();
      }
      child.kill();
      child.unref();
    },
  };
}

export function spawnAgyForeground(args = [], options = {}) {
  const command = process.platform === 'win32' ? 'cmd.exe' : 'agy';
  const commandArgs = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'agy', ...args]
    : args;
  const child = spawn(command, commandArgs, {
    cwd: process.cwd(),
    env: options.env || process.env,
    stdio: ['pipe', 'inherit', 'inherit'],
    windowsHide: false,
  });
  let attachedInput = null;

  return {
    onExit(handler) {
      child.on('exit', (exitCode, signal) => handler({ exitCode, signal }));
      child.on('error', error => handler({ exitCode: null, signal: null, error }));
    },
    write(value) {
      if (!child.stdin.destroyed) child.stdin.write(value);
    },
    attachInput(input = process.stdin) {
      if (attachedInput || child.stdin.destroyed || input.destroyed) return;
      attachedInput = input;
      input.pipe(child.stdin);
    },
    kill() {
      if (attachedInput) {
        try {
          attachedInput.unpipe(child.stdin);
        } catch {
          // best effort
        }
      }
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        killer.on('error', () => {});
        killer.unref();
      }
      child.kill();
      child.unref();
    },
  };
}
