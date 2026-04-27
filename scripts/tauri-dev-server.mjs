import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';

const PORT = 1420;
const HOST = '127.0.0.1';
const PROJECT_ROOT = process.cwd();
const VITE_BIN = path.join(PROJECT_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function fetchRoot(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const request = http.get(
      {
        host: HOST,
        port: PORT,
        path: '/',
        timeout: timeoutMs
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          resolve({
            ok: true,
            statusCode: response.statusCode ?? 0,
            body
          });
        });
      }
    );

    request.on('timeout', () => {
      request.destroy();
      resolve({ ok: false, statusCode: 0, body: '' });
    });

    request.on('error', () => {
      resolve({ ok: false, statusCode: 0, body: '' });
    });
  });
}

function getListeningProcess() {
  if (process.platform !== 'win32') {
    return null;
  }

  const command = `
    $conn = Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1;
    if (-not $conn) { return }
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $($conn.OwningProcess)";
    if ($proc) {
      $proc | Select-Object ProcessId, ParentProcessId, CommandLine | ConvertTo-Json -Compress
    }
  `;

  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], {
    encoding: 'utf8'
  });

  if (result.status !== 0) {
    return null;
  }

  const output = result.stdout.trim();
  if (!output) {
    return null;
  }

  try {
    return JSON.parse(output);
  } catch {
    return null;
  }
}

function isProjectViteProcess(info) {
  const commandLine = String(info?.CommandLine ?? '');
  return (
    commandLine.includes(path.join(PROJECT_ROOT, 'node_modules')) &&
    commandLine.includes('vite') &&
    commandLine.includes(`--port ${PORT}`)
  );
}

async function stopProcess(pid) {
  if (!pid) {
    return;
  }

  if (process.platform === 'win32') {
    spawnSync('powershell.exe', ['-NoProfile', '-Command', `Stop-Process -Id ${pid} -Force`], {
      stdio: 'ignore'
    });
  } else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return;
    }
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const info = getListeningProcess();
    if (!info) {
      return;
    }
    await wait(250);
  }
}

function isExpectedViteHtml(body) {
  return body.includes('/@vite/client') && body.includes('Kerbodyne Ground Station');
}

async function preparePort() {
  const response = await fetchRoot();
  if (!response.ok) {
    return;
  }

  const info = getListeningProcess();
  if (info && isProjectViteProcess(info)) {
    console.log(`Restarting existing Vite dev server on port ${PORT}.`);
    await stopProcess(info.ProcessId);
    return;
  }

  if (isExpectedViteHtml(response.body)) {
    console.log(`Reusing existing dev server on http://${HOST}:${PORT}.`);
    process.exit(0);
  }

  console.error(
    `Port ${PORT} is already in use by another process. Stop it or change the Vite/Tauri dev port before retrying.`
  );
  process.exit(1);
}

async function main() {
  await preparePort();

  const child = spawn(process.execPath, [VITE_BIN, '--host', '0.0.0.0', '--port', String(PORT)], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit'
  });

  const stopChild = () => {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  };

  process.on('SIGINT', () => {
    stopChild();
  });

  process.on('SIGTERM', () => {
    stopChild();
  });

  child.on('exit', (code) => {
    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
