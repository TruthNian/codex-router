import childProcess from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const entry = path.basename(process.argv[1] || '');
const target = /^request-diagnostics-router(?:-stress-\d+)?\.test\.mjs$/.test(entry);
const router = entry === 'router.mjs' && process.env.ROUTER_STARTUP_TRACED === '1';
const directory = process.env.ROUTER_STARTUP_TRACE_DIR;
if (directory && (target || router)) {
  fs.mkdirSync(directory, { recursive: true });
  const identity = `${process.pid}-${Math.round(performance.timeOrigin)}`;
  const fd = fs.openSync(path.join(directory, `${target ? 'parent' : 'router'}-${identity}.jsonl`), 'a');
  const write = fs.writeSync;
  const cpu = process.cpuUsage();
  function record(event, detail = {}) {
    write(fd, `${JSON.stringify({ pid: process.pid, ppid: process.ppid, event, ms: performance.now(), epoch: performance.timeOrigin + performance.now(), cpu: process.cpuUsage(cpu), ...detail })}\n`);
  }
  record('preload', { node: process.version });
  if (target) {
    const spawn = childProcess.spawn;
    childProcess.spawn = function (file, args, options) {
      if (file !== process.execPath || !args?.some(arg => path.basename(arg) === 'router.mjs')) return spawn.call(this, file, args, options);
      record('spawn.begin');
      const child = spawn.call(this, file, args, { ...options, env: { ...options.env, ROUTER_STARTUP_TRACED: '1' } });
      record('spawn.return', { childPid: child.pid });
      child.once('spawn', () => record('spawn.event', { childPid: child.pid }));
      child.once('exit', (code, signal) => record('child.exit', { childPid: child.pid, code, signal }));
      child.stderr?.once('data', () => record('child.first-stderr', { childPid: child.pid }));
      // Preserve the original five-second failure, but briefly quarantine a
      // still-initializing failed fixture so its eventual startup profile is
      // available. This changes diagnostic cleanup only, never test success.
      const kill = child.kill.bind(child);
      let listening = false;
      let pendingKill;
      let quarantine;
      let stderr = '';
      child.stderr?.on('data', chunk => {
        stderr = `${stderr}${chunk}`.slice(-1000);
        if (stderr.includes('[codex-router] listening')) {
          listening = true;
          if (pendingKill) { clearTimeout(quarantine); kill(pendingKill); }
        }
      });
      child.kill = function (signal = 'SIGTERM') {
        if (!listening && process.env.ROUTER_STARTUP_QUARANTINE === '1') {
          if (!pendingKill) {
            pendingKill = signal;
            record('startup-failed-before-listening', { childPid: child.pid });
            quarantine = setTimeout(() => kill(signal), 15_000);
          }
          return true;
        }
        return kill(signal);
      };
      child.once('close', () => clearTimeout(quarantine));
      return child;
    };
    const fetch = globalThis.fetch;
    globalThis.fetch = async function (url, options) {
      const leaf = String(url).split('/').at(-1)?.split('?')[0];
      const begin = performance.now();
      try {
        const response = await fetch(url, options);
        if (leaf === 'models') record('probe.response', { status: response.status, duration: performance.now() - begin });
        return response;
      } catch (error) {
        if (leaf === 'models') record('probe.error', { code: error.cause?.code, duration: performance.now() - begin });
        throw error;
      }
    };
  } else {
    let profiler;
    if (process.env.ROUTER_STARTUP_PROFILE === '1') {
      const Session = createRequire(import.meta.url)('node:inspector').Session;
      profiler = new Session();
      profiler.connect();
      profiler.post('Profiler.enable');
      profiler.post('Profiler.start');
      record('profile.started');
    }
    for (const name of ['execFileSync', 'spawnSync', 'spawn']) {
      const original = childProcess[name];
      childProcess[name] = function (file, ...args) {
        const begin = performance.now();
        const command = path.basename(String(file));
        record(`${name}.begin`, { command, stack: new Error().stack.split('\n').slice(2, 7).map(line => line.replaceAll(process.cwd(), '<repo>')) });
        try {
          const result = original.call(this, file, ...args);
          record(`${name}.end`, { command, duration: performance.now() - begin });
          return result;
        } catch (error) {
          record(`${name}.error`, { command, duration: performance.now() - begin, code: error.code, status: error.status });
          throw error;
        }
      };
    }
    const filesystem = new Map();
    for (const name of ['readFileSync', 'readdirSync', 'statSync', 'lstatSync', 'existsSync', 'mkdirSync']) {
      const original = fs[name];
      fs[name] = function (...args) {
        const begin = performance.now();
        try { return original.apply(this, args); }
        finally {
          const duration = performance.now() - begin;
          const stats = filesystem.get(name) || { count: 0, duration: 0, maximum: 0 };
          stats.count++; stats.duration += duration; stats.maximum = Math.max(stats.maximum, duration);
          filesystem.set(name, stats);
          if (duration > 50) record('slow-fs', { operation: name, duration, basename: path.basename(String(args[0])) });
        }
      };
    }
    const listen = net.Server.prototype.listen;
    net.Server.prototype.listen = function (...args) {
      record('listen.called', { filesystem: Object.fromEntries(filesystem) });
      if (profiler) {
        const session = profiler;
        profiler = undefined;
        const slow = performance.now() > 2000;
        session.post('Profiler.stop', (error, result) => {
          if (!error && slow) fs.writeFileSync(path.join(directory, `startup-${identity}.cpuprofile`), JSON.stringify(result.profile));
          session.disconnect();
        });
      }
      this.once('listening', () => record('listen.ready'));
      return listen.apply(this, args);
    };
    const emit = http.Server.prototype.emit;
    http.Server.prototype.emit = function (event, ...args) {
      if (event === 'request') {
        const [request, response] = args;
        const leaf = request.url?.split('/').at(-1)?.split('?')[0];
        record('request', { method: request.method, leaf });
        response.once('finish', () => record('response', { leaf, status: response.statusCode, filesystem: leaf === 'models' ? Object.fromEntries(filesystem) : undefined }));
      }
      return emit.call(this, event, ...args);
    };
    let previous = performance.now();
    const heartbeat = setInterval(() => {
      const now = performance.now();
      record('heartbeat', { delay: now - previous, filesystem: Object.fromEntries(filesystem) });
      previous = now;
    }, 1_000);
    heartbeat.unref();
  }
  syncBuiltinESMExports();
  process.once('exit', code => record('exit', { code }));
}
