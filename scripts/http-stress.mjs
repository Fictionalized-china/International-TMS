import { performance } from "node:perf_hooks";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5189";
const email = process.env.STRESS_EMAIL || "admin@e2e.test";
const password = process.env.STRESS_PASSWORD || "OulingTMS2026!";
const concurrency = positiveInteger(process.env.CONCURRENCY,20);
const rounds = positiveInteger(process.env.ROUNDS,25);
const timeoutMs = positiveInteger(process.env.REQUEST_TIMEOUT_MS,10_000);
const routes = (process.env.STRESS_ROUTES || "/admin/portal,/admin/orders,/admin/workflow,/admin/customers")
  .split(",").map((item)=>item.trim()).filter(Boolean);

const login = await fetch(`${baseUrl}/login`,{
  method:"POST",
  redirect:"manual",
  headers:{"content-type":"application/x-www-form-urlencoded"},
  body:new URLSearchParams({email,password}),
});
const cookie = login.headers.get("set-cookie")?.split(";")[0];
if (![302,303].includes(login.status) || !cookie) {
  throw new Error(`Pressure-test login failed: HTTP ${login.status}`);
}

const samples = [];
const failures = [];
const statusCounts = new Map();
let cursor = 0;
const total = concurrency * rounds;
async function worker() {
  while (true) {
    const index = cursor++;
    if (index >= total) return;
    const route = routes[index % routes.length];
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(),timeoutMs);
    const started = performance.now();
    try {
      const response = await fetch(`${baseUrl}${route}`,{
        headers:{cookie,accept:"text/html"},
        redirect:"manual",
        signal:controller.signal,
      });
      const responseBody = await response.text();
      const duration = performance.now()-started;
      samples.push(duration);
      const key = `${route}:${response.status}`;
      statusCounts.set(key,(statusCounts.get(key)||0)+1);
      if (response.status !== 200) failures.push({
        index,
        route,
        status:response.status,
        duration,
        responseBody:failureSnippet(responseBody),
      });
    } catch (error) {
      failures.push({index,route,error:error instanceof Error?error.message:String(error)});
    } finally {
      clearTimeout(timer);
    }
  }
}

const wallStarted = performance.now();
await Promise.all(Array.from({length:concurrency},()=>worker()));
const wallMs = performance.now()-wallStarted;
samples.sort((a,b)=>a-b);
const report = {
  baseUrl,
  concurrency,
  rounds,
  total,
  success:total-failures.length,
  failures:failures.length,
  wallMs:Number(wallMs.toFixed(1)),
  requestsPerSecond:Number((total/(wallMs/1000)).toFixed(2)),
  latencyMs:{
    min:round(samples[0]),
    p50:round(percentile(samples,.50)),
    p95:round(percentile(samples,.95)),
    p99:round(percentile(samples,.99)),
    max:round(samples.at(-1)),
  },
  statusCounts:Object.fromEntries([...statusCounts].sort(([a],[b])=>a.localeCompare(b))),
  failureExamples:failures.slice(0,10),
};
console.log(JSON.stringify(report,null,2));
if (failures.length) process.exitCode=1;

function positiveInteger(value,fallback) {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`Expected positive integer, received: ${value}`);
  const parsed=Number(value);
  if (!Number.isSafeInteger(parsed)||parsed<1||parsed>10_000) throw new Error(`Integer out of range: ${value}`);
  return parsed;
}
function percentile(values,ratio) {
  if (!values.length) return null;
  return values[Math.min(values.length-1,Math.ceil(values.length*ratio)-1)];
}
function round(value) {
  return typeof value === "number"?Number(value.toFixed(1)):null;
}

function failureSnippet(body) {
  const normalized=body.replace(/\s+/g," ").trim();
  const needles=["D1_ERROR","SQLITE","Internal Server Error","Error","error"];
  const matchedIndex=needles
    .map((needle)=>normalized.indexOf(needle))
    .filter((index)=>index>=0)
    .sort((a,b)=>a-b)[0];
  const start=matchedIndex===undefined?0:Math.max(0,matchedIndex-120);
  return normalized.slice(start,start+800);
}
