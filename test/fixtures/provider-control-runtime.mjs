import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";

// Execute real control mutation/rollback and process-tree code, substituting
// only runtime installation and model publication subprocesses. No service or
// package manager command can escape this synthetic runtime fixture.
export function stageProviderControlRuntime(directory, { mode = "stub" } = {}) {
  if (!["stub", "boundary"].includes(mode)) throw new Error("Unknown provider runtime fixture mode");
  const runtime = path.join(directory, "runtime");
  mkdirSync(runtime, { recursive: true });
  const driver = path.join(runtime, "driver.mjs");
  const wrapper = path.join(runtime, process.platform === "win32" ? "node.cmd" : "node");
  writeFileSync(driver, `
    import fs from "node:fs";
    import path from "node:path";
    import {spawnSync} from "node:child_process";
    const [script,...args]=process.argv.slice(2);
    const name=path.basename(script||"");
    const state=process.env.MODEL_ROUTER_STATE_DIR;
    const root=process.env.FIXTURE_PROVIDER_RUNTIME_ROOT;
    const boundary=process.env.FIXTURE_PROVIDER_RUNTIME_MODE==="boundary";
    if(!root||!state)throw new Error("Unbound runtime fixture");
    for(const field of ["HOME","USERPROFILE","APPDATA","LOCALAPPDATA","CODEX_HOME","MODEL_ROUTER_STATE_DIR","CODEX_ROUTER_STATE_DIR"]){
      const value=process.env[field];
      if(!value||!path.isAbsolute(value)||path.relative(root,value).startsWith(".."))throw new Error("Unbound runtime fixture root: "+field);
    }
    if(state!==process.env.CODEX_ROUTER_STATE_DIR)throw new Error("Unbound runtime fixture state aliases");
    const log=path.join(root,"runtime-events.jsonl");
    function event(phase){
      fs.appendFileSync(log,JSON.stringify({phase,time:Date.now(),deadline:Number(process.env.CODEX_ROUTER_OPERATION_DEADLINE_MS)})+"\\n");
    }
    function fail(phase){
      const marker=path.join(root,"failed-"+phase);
      if(process.env.FIXTURE_PROVIDER_FAIL_PHASE===phase&&!fs.existsSync(marker)){
        fs.writeFileSync(marker,"failed");process.stderr.write("Synthetic "+phase+" failure\\n");process.exit(17);
      }
    }
    if(name==="runtime-dependency-preparation.mjs"){
      event("dependencies");fail("dependencies");
      if(boundary){
        const {prepareRuntimeDependencies}=await import((await import("node:url")).pathToFileURL(script).href);
        // Package provisioning is the external boundary. Execute the real
        // freshly loaded route requirement calculation with fixture deps ready.
        process.stdout.write(JSON.stringify(await prepareRuntimeDependencies({stepStatus:()=>"skip"})));
      }else process.stdout.write(JSON.stringify({prepared:true,installed:false,needsGateway:true}));
    }else if(name==="model-overlay-publication.mjs"){
      const phase=args[0]==="--prepare-in-fresh-process"?"prepare":"publish";
      event(phase);fail(phase);
      if(boundary){
        const result=spawnSync(${JSON.stringify(process.execPath)},[script,...args],{encoding:"utf8",env:process.env});
        if(result.stdout)process.stdout.write(result.stdout);
        if(result.stderr)process.stderr.write(result.stderr);
        if(result.status===0&&phase==="prepare"){
          const fingerprint=JSON.parse(result.stdout).expectedFingerprint;
          if(!/^[a-f0-9]{64}$/.test(fingerprint))throw new Error("Real prepare returned no fingerprint");
          fs.writeFileSync(path.join(root,"prepared-fingerprint"),fingerprint);
        }
        process.exit(result.status??1);
      }else process.stdout.write(JSON.stringify(phase==="prepare"?{expectedFingerprint:"a".repeat(64)}:{targetsRefreshed:[]}));
    }else if(name==="service.mjs"){
      event("service-"+args[0]);
      if(boundary){
        if(args[0]==="restart"){
          let fingerprint=fs.readFileSync(path.join(root,"prepared-fingerprint"),"utf8");
          const rejected=path.join(root,"adoption-rejected");
          if(process.env.FIXTURE_PROVIDER_REJECT_ADOPTION==="1"&&!fs.existsSync(rejected)){
            fs.writeFileSync(rejected,"rejected");fingerprint="0".repeat(64);
          }
          fs.writeFileSync(path.join(root,"active-fingerprint"),fingerprint);
        }
        process.stdout.write(JSON.stringify(args[0]==="restart"?{state:"running"}:{installed:true,loaded:true,state:"running",platform:"darwin"})+"\\n");
      }else{
        const installed=process.env.FIXTURE_PROVIDER_MANAGED_SERVICE==="1";
        process.stdout.write(JSON.stringify({installed,loaded:false,state:"stopped",platform:"darwin"}));
      }
    }else{
      if(name==="control.mjs")event("control");
      const result=spawnSync(${JSON.stringify(process.execPath)},[script,...args],{stdio:"inherit",env:process.env});
      process.exit(result.status??1);
    }
  `);
  if (process.platform === "win32") {
    writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "${driver}" %*\r\nexit /b %errorlevel%\r\n`);
  } else {
    const quote = (value) => `'${value.replace(/'/g, `'"'"'`)}'`;
    writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(driver)} "$@"\n`, { mode: 0o755 });
  }
  return { CODEX_ROUTER_NODE_BIN: wrapper, FIXTURE_PROVIDER_RUNTIME_ROOT: directory,
    ...(mode === "boundary" ? { FIXTURE_PROVIDER_RUNTIME_MODE: mode } : {}) };
}

// Real preparation, fingerprint verification, gateway writes and target
// publication stay intact. Only package readiness and the OS managed service
// are substituted; health is an actual loopback listener, never a no-op verifier.
export async function startProviderControlRuntime(directory) {
  const environment = stageProviderControlRuntime(directory, { mode: "boundary" });
  const server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/health") {
      response.writeHead(404);
      response.end();
      return;
    }
    const active = path.join(directory, "active-fingerprint");
    const fingerprint = existsSync(active) ? readFileSync(active, "utf8") : undefined;
    appendFileSync(path.join(directory, "runtime-events.jsonl"), JSON.stringify({
      phase: "health-adoption", fingerprint, time: Date.now(),
    }) + "\n");
    response.writeHead(fingerprint ? 200 : 503, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: Boolean(fingerprint), service: "codex-router",
      degraded: fingerprint ? [] : ["fixture service has not adopted routes"],
      ...(fingerprint ? { executionPlan: { fingerprint } } : {}),
    }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = String(server.address().port);
  return {
    environment: { ...environment, MODEL_ROUTER_PORT: port, CODEX_ROUTER_PORT: port,
      CODEX_ROUTER_CALLER_KEY: "fixture-caller-capability-with-sufficient-length",
      CODEX_ROUTER_INTERNAL_KEY: "fixture-internal-capability-with-sufficient-length",
      KIMI_INTERNAL_KEY: "fixture-internal-capability-with-sufficient-length" },
    events: () => {
      const log = path.join(directory, "runtime-events.jsonl");
      return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : [];
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export function runProviderFixtureNode(args, environment, { cwd = path.resolve(import.meta.dirname, "../..") } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env: environment, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}
