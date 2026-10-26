import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

// Hardware map (Ranfurlie, v1.0 24 Oct 2026). Catch hook for andranf.github.io/ranfurlie-greens/hardware/
//   kind "add"     a new pin. Problems (leak, wet spot, blocked drain...) and hardware marked Needs work / Failed
//                  post to #irrigation or #drainage. Before posting, one commit adds the record to hardware/live.json,
//                  the aerial snapshot (hardware/snaps/ID.jpg, drawn by the page) and a small pin page
//                  (hardware/p/ID.html) whose link preview shows the spot and opens the map at the pin.
//                  The post waits (up to ~2.5 min) for GitHub Pages to serve that page so Slack can show the preview.
//   kind "move"    the pin moved (thread reply for an open problem).
//   kind "edit"    label, plan code, condition, size, depth, notes. Hardware newly marked Needs work / Failed gets a post.
//   kind "fix"     a problem fixed: thread reply, ✅ on the post, record status fixed.
//   kind "remove"  pin taken off the map (kept in the file as removed).
//   kind "purge_test" (with __test "1") drops test records and their files.
//   kind "net"     a mainline edit from the page: the whole network (pipes, valves, pump, head links) in "net",
//                  checked and committed as hardware/network.json with a log line (who, what, sid). No Slack post.
//                  With __test "1" it goes to hardware/network.test.json instead.
//   kind "shut"    valves shut on the course (mainline map): logged in live.json "shuts", posted to #irrigation.
//                  Reminders in the thread while they stay shut: back on today -> 3pm, then 7pm with Andy, Ben and
//                  Neil tagged, then each morning at 7am; staying off -> each morning at 7am. Stops once all are open.
//   kind "open"    some or all of a shutdown's valves back on: thread reply; all back on -> ✅ on the post.
//   kind "keep"    a shutdown is staying off for now (reminders move to the mornings).
// __test "1": Slack goes to Andy's DM instead of the channel and the record is marked test (the page hides it).
// Every change is one atomic commit through the Git data API, retried if the branch moved underneath it.

const sdk = createZapierSdk();

const GH = "github_main";
const SLACK = "slack_main";
const REPO = "https://api.github.com/repos/andranf/ranfurlie-greens";
const PAGES = "https://andranf.github.io/ranfurlie-greens/hardware/";
const LIVE_PATH = "hardware/live.json";
const NET_PATH = "hardware/network.json";
const NET_TEST_PATH = "hardware/network.test.json";
const NET_KINDS = ["src", "j", "end", "sv", "mv", "iv", "ov"];
const IRR_CH = "C06HV77DBQV";
const DRN_CH = "C0B885SR474";
const ANDY = "U06BCCG4HT9";
const BEN = "U06NBNSR9LG";
const NEIL = "U06FJ0J1RH8";
const BOT = "Hardware map";
const ICON = ":round_pushpin:";

type TypeDef = { cat: "issue" | "asset"; fam: "irr" | "drn"; name: string; emoji?: string };
const TYPES: Record<string, TypeDef> = {
  leak: { cat: "issue", fam: "irr", name: "Leak", emoji: ":droplet:" },
  headfault: { cat: "issue", fam: "irr", name: "Head fault", emoji: ":warning:" },
  box: { cat: "issue", fam: "irr", name: "Broken or sunken box", emoji: ":warning:" },
  other_irr: { cat: "issue", fam: "irr", name: "Irrigation problem", emoji: ":warning:" },
  wet: { cat: "issue", fam: "drn", name: "Wet or boggy spot", emoji: ":ocean:" },
  blocked: { cat: "issue", fam: "drn", name: "Blocked or slow drain", emoji: ":no_entry:" },
  other_drn: { cat: "issue", fam: "drn", name: "Drainage problem", emoji: ":warning:" },
  iv: { cat: "asset", fam: "irr", name: "Isolation valve" },
  sv: { cat: "asset", fam: "irr", name: "Sluice valve" },
  mv: { cat: "asset", fam: "irr", name: "MV valve" },
  qcv: { cat: "asset", fam: "irr", name: "Quick coupler (QCV)" },
  vbox: { cat: "asset", fam: "irr", name: "Valve box" },
  head: { cat: "asset", fam: "irr", name: "Sprinkler head" },
  dec: { cat: "asset", fam: "irr", name: "Decoder or splice" },
  air: { cat: "asset", fam: "irr", name: "Air valve" },
  dp: { cat: "asset", fam: "drn", name: "Drain pit" },
  do: { cat: "asset", fam: "drn", name: "Drain outlet" },
  co: { cat: "asset", fam: "drn", name: "Cleanout or flush point" },
  other_hw: { cat: "asset", fam: "irr", name: "Hardware" },
};
const CONDS: Record<string, string> = { good: "works fine", work: "needs work", fail: "failed" };

// ---------- pure helpers ----------
function clip(v: unknown, n: number): string {
  return String(v ?? "").replace(/[\u0000-\u001f]+/g, " ").replace(/\s*[—–]\s*/g, ", ").replace(/\s+/g, " ").trim().slice(0, n);
}
function clipLines(v: unknown, n: number): string {
  return String(v ?? "").replace(/\r/g, "").replace(/[\u0000-\u0009\u000b-\u001f]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, n);
}
function num(v: unknown): number | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}
function slackSafe(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function htmlSafe(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function b64enc(s: string): string {
  const B: any = (globalThis as any).Buffer;
  if (B) return B.from(s, "utf8").toString("base64");
  return btoa(unescape(encodeURIComponent(s)));
}
function b64dec(s: string): string {
  const c = String(s || "").replace(/\s+/g, "");
  const B: any = (globalThis as any).Buffer;
  if (B) return B.from(c, "base64").toString("utf8");
  return decodeURIComponent(escape(atob(c)));
}
// only call inside a step (Date is guarded outside steps)
function melTime(d: Date): string {
  return new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Melbourne", hour: "numeric", minute: "2-digit", hour12: true })
    .format(d).replace(/\s+/g, "").toLowerCase();
}
function permalink(ch: string, ts: string): string {
  return `https://ranfurliegolfclub.slack.com/archives/${ch}/p${ts.replace(".", "")}`;
}
function blankLive(): any {
  return { v: 1, updated: null, records: [], events: [], cirrus: {}, shuts: [] };
}
// Melbourne wall clock: minutes since midnight and the date (only call inside a step)
function melClock(d: Date): { mins: number; date: string } {
  const parts = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Melbourne", hour: "2-digit", minute: "2-digit", hour12: false, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const g = (t: string) => parts.find((x) => x.type === t)?.value ?? "0";
  return { mins: (Number(g("hour")) % 24) * 60 + Number(g("minute")), date: `${g("year")}-${g("month")}-${g("day")}` };
}
function fmtDur(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  if (h < 48) return r ? `${h} h ${r} min` : `${h} h`;
  return `${Math.round(h / 24)} days`;
}
function shutUrl(id: string): string {
  return `${PAGES}?shut=${id}`;   // no & in Slack links (Slack escapes it to &amp;)
}
function pinUrl(id: string, lat: number, lng: number): string {
  return `${PAGES}?pin=${id}#${lat.toFixed(6)},${lng.toFixed(6)}`;
}
function pinPage(rec: any, snapPath: string | null): string {
  const t = TYPES[rec.type];
  const title = `${rec.label ? rec.label + " · " : ""}${t.cat === "asset" && rec.cond ? t.name + ": " + CONDS[rec.cond] : t.name}${rec.place ? " · " + rec.place : ""}`;
  const desc = [rec.near, rec.notes, rec.by].filter(Boolean).join(" · ").slice(0, 280);
  const img = snapPath ? `${PAGES}${snapPath.replace(/^hardware\//, "")}` : `${PAGES}og.jpg`;
  const to = `../?pin=${rec.id}#${Number(rec.lat).toFixed(6)},${Number(rec.lng).toFixed(6)}`;
  return `<!doctype html>
<html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${htmlSafe(title)}</title>
<meta property="og:title" content="${htmlSafe(title)}">
<meta property="og:description" content="${htmlSafe(desc || "Open the pin on the Ranfurlie hardware map")}">
<meta property="og:image" content="${img}">
${snapPath ? '<meta property="og:image:width" content="640">\n<meta property="og:image:height" content="400">\n' : ""}<meta property="og:site_name" content="Ranfurlie hardware map">
<meta name="twitter:card" content="summary_large_image">
<meta http-equiv="refresh" content="0;url=${htmlSafe(to)}">
<script>location.replace(${JSON.stringify(to)})</script>
<a href="${htmlSafe(to)}">Open the pin on the map</a>
</html>
`;
}

// A mainline file from the page: shape and size checks only (the page is the editor).
function netProblem(net: any): string {
  if (!net || typeof net !== "object") return "not JSON";
  if (!Array.isArray(net.nodes) || !Array.isArray(net.pipes)) return "no nodes or pipes";
  if (net.nodes.length < 2 || net.nodes.length > 4000 || net.pipes.length < 1 || net.pipes.length > 5000) return "too big or empty";
  const inBox = (lat: any, lng: any) => typeof lat === "number" && typeof lng === "number" && lat > -38.14 && lat < -38.10 && lng > 145.22 && lng < 145.27;
  const ids = new Set<string>();
  for (const n of net.nodes) {
    if (!n || typeof n.id !== "string" || !/^n\d{1,6}$/.test(n.id) || ids.has(n.id)) return "bad node id";
    if (!NET_KINDS.includes(n.k)) return `bad node kind ${String(n.k).slice(0, 8)}`;
    if (!inBox(n.lat, n.lng)) return `node ${n.id} off the course`;
    ids.add(n.id);
  }
  if (!net.nodes.some((n: any) => n.k === "src")) return "no pump";
  const pids = new Set<string>();
  for (const p of net.pipes) {
    if (!p || typeof p.id !== "string" || !/^p\d{1,6}$/.test(p.id) || pids.has(p.id)) return "bad pipe id";
    if (!ids.has(p.a) || !ids.has(p.b)) return `pipe ${p.id} has a missing end`;
    if (!Array.isArray(p.pts) || p.pts.length > 2000) return `pipe ${p.id} bad points`;
    for (const q of p.pts) if (!Array.isArray(q) || !inBox(q[0], q[1])) return `pipe ${p.id} point off the course`;
    pids.add(p.id);
  }
  if (net.feeds && typeof net.feeds !== "object") return "bad feeds";
  return "";
}

// ---------- error collection ----------
const ERRS = new WeakMap<object, string[]>();
function errs(ctx: any): string[] {
  let a = ERRS.get(ctx);
  if (!a) { a = []; ERRS.set(ctx, a); }
  return a;
}

// ---------- GitHub ----------
async function gh(path: string, method: string, body?: any): Promise<{ status: number; json: any; text: string }> {
  const r = await sdk.fetch(`${REPO}${path}`, {
    connection: GH,
    method,
    headers: { Accept: "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text: text.slice(0, 300) };
}
async function readLive(ctx: any, name: string): Promise<any> {
  const out: any = await ctx.step(name, async () => {
    try {
      const g = await gh(`/contents/${LIVE_PATH}?ref=main`, "GET");
      if (g.status === 404) return blankLive();
      if (g.status !== 200) return { ...blankLive(), __error: `GET ${g.status}` };
      return JSON.parse(b64dec(g.json.content));
    } catch (e: any) {
      return { ...blankLive(), __error: String(e?.message ?? e).slice(0, 200) };
    }
  });
  if (out?.__error) errs(ctx).push(`${name}: ${out.__error}`);
  return out;
}
// One atomic commit: extra files (base64 content, or null to delete) plus a read-modify-write of live.json.
async function commit(ctx: any, name: string, message: string, files: Record<string, string | null>, mutate: ((live: any) => void) | null): Promise<any> {
  const out: any = await ctx.step(name, async () => {
    let last = "";
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const ref = await gh("/git/ref/heads/main", "GET");
        if (ref.status !== 200) { last = `ref ${ref.status}`; await new Promise((r) => setTimeout(r, 800 * (attempt + 1))); continue; }
        const head = ref.json.object.sha;
        const hc = await gh(`/git/commits/${head}`, "GET");
        if (hc.status !== 200) { last = `commit ${hc.status}`; continue; }
        const tree: any[] = [];
        for (const [path, b64] of Object.entries(files)) {
          if (b64 === null) { tree.push({ path, mode: "100644", type: "blob", sha: null }); continue; }
          const bl = await gh("/git/blobs", "POST", { content: b64, encoding: "base64" });
          if (bl.status !== 201) throw new Error(`blob ${path} ${bl.status} ${bl.text}`);
          tree.push({ path, mode: "100644", type: "blob", sha: bl.json.sha });
        }
        if (mutate) {
          const g = await gh(`/contents/${LIVE_PATH}?ref=${head}`, "GET");
          let live: any = blankLive();
          if (g.status === 200) { try { live = JSON.parse(b64dec(g.json.content)); } catch { live = blankLive(); } }
          else if (g.status !== 404) { last = `live GET ${g.status}`; continue; }
          live.records = live.records || []; live.events = live.events || [];
          mutate(live);
          live.events = (live.events || []).slice(-400);
          live.updated = new Date().toISOString();
          const bl = await gh("/git/blobs", "POST", { content: b64enc(JSON.stringify(live)), encoding: "base64" });
          if (bl.status !== 201) throw new Error(`blob live ${bl.status} ${bl.text}`);
          tree.push({ path: LIVE_PATH, mode: "100644", type: "blob", sha: bl.json.sha });
        }
        const nt = await gh("/git/trees", "POST", { base_tree: hc.json.tree.sha, tree });
        if (nt.status !== 201) throw new Error(`tree ${nt.status} ${nt.text}`);
        const nc = await gh("/git/commits", "POST", { message, tree: nt.json.sha, parents: [head] });
        if (nc.status !== 201) throw new Error(`commit ${nc.status} ${nc.text}`);
        const at = new Date().toISOString();
        const up = await gh("/git/refs/heads/main", "PATCH", { sha: nc.json.sha, force: false });
        if (up.status === 200) return { ok: true, sha: nc.json.sha, at };
        last = `ref update ${up.status} ${up.text}`;
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1) + Math.floor(Math.random() * 500)));
      } catch (e: any) {
        last = String(e?.message ?? e).slice(0, 300);
        await new Promise((r) => setTimeout(r, 900 * (attempt + 1)));
      }
    }
    return { ok: false, error: last };
  });
  if (!out?.ok) errs(ctx).push(`${name}: not saved (${out?.error ?? "unknown"})`);
  return out;
}

// ---------- Slack ----------
async function slackPost(ctx: any, name: string, channel: string, text: string, threadTs: string | null, unfurl: boolean): Promise<string | null> {
  const r: any = await ctx.step(name, async () => {
    try {
      return await sdk.runAction({
        appKey: "SlackCLIAPI",
        actionType: "write",
        actionKey: "channel_message",
        connection: SLACK,
        inputs: {
          channel,
          text,
          as_bot: "yes",
          username: BOT,
          icon: ICON,
          unfurl: unfurl ? "yes" : "no",
          link_names: "yes",
          add_edit_link: "no",
          ...(threadTs ? { thread_ts: threadTs } : {}),
        },
      });
    } catch (e: any) {
      return { __error: String(e?.message ?? e).slice(0, 300) };
    }
  });
  if (r?.__error) { errs(ctx).push(`${name}: ${r.__error}`); return null; }
  const item = r?.data?.[0] ?? {};
  return item.ts ?? item.message?.ts ?? item.message__ts ?? null;
}
async function slackDmAndy(ctx: any, name: string, text: string, unfurl: boolean) {
  return ctx.step(name, async () => {
    try {
      return await sdk.runAction({
        appKey: "SlackCLIAPI",
        actionType: "write",
        actionKey: "direct_message",
        connection: SLACK,
        inputs: { channel: ANDY, as_bot: "yes", send_multi: "no", username: BOT, icon: ICON, unfurl: unfurl ? "yes" : "no", add_edit_link: "no", text },
      });
    } catch (e: any) {
      return { failed: String(e?.message ?? e).slice(0, 300) };
    }
  });
}
async function slackReact(ctx: any, name: string, channel: string, ts: string, emoji: string) {
  return ctx.step(name, async () => {
    try {
      return await sdk.runAction({
        appKey: "SlackCLIAPI",
        actionType: "write",
        actionKey: "add_reaction_v0",
        connection: SLACK,
        inputs: { channel, timestamp: ts, emoji },
      });
    } catch (e: any) {
      return { reactionFailed: true, error: String(e?.message ?? e).slice(0, 300) };
    }
  });
}
async function reportErrors(ctx: any, id: string, isTest: boolean) {
  const e = errs(ctx);
  if (!e.length) return;
  await slackDmAndy(ctx, "dm-errors", `Hardware map: something didn't save for pin ${id}${isTest ? " (test)" : ""}.\n${slackSafe(e.join("\n").slice(0, 700))}`, false);
}

// ---------- input ----------
const InputSchema = z.object({
  kind: z.unknown().nullable().optional(),
  id: z.unknown().nullable().optional(),
  ev: z.unknown().nullable().optional(),
  type: z.unknown().nullable().optional(),
  lat: z.unknown().nullable().optional(),
  lng: z.unknown().nullable().optional(),
  acc: z.unknown().nullable().optional(),
  fixes: z.unknown().nullable().optional(),
  gps_acc: z.unknown().nullable().optional(),
  adj: z.unknown().nullable().optional(),
  label: z.unknown().nullable().optional(),
  ref: z.unknown().nullable().optional(),
  cond: z.unknown().nullable().optional(),
  size: z.unknown().nullable().optional(),
  depth: z.unknown().nullable().optional(),
  notes: z.unknown().nullable().optional(),
  urgent: z.unknown().nullable().optional(),
  near: z.unknown().nullable().optional(),
  place: z.unknown().nullable().optional(),
  hole: z.unknown().nullable().optional(),
  by: z.unknown().nullable().optional(),
  by_slack: z.unknown().nullable().optional(),
  snap: z.unknown().nullable().optional(),
  net: z.unknown().nullable().optional(),
  base: z.unknown().nullable().optional(),
  note: z.unknown().nullable().optional(),
  sid: z.unknown().nullable().optional(),
  valves: z.unknown().nullable().optional(),
  target: z.unknown().nullable().optional(),
  why: z.unknown().nullable().optional(),
  keep: z.unknown().nullable().optional(),
  off_n: z.unknown().nullable().optional(),
  off_text: z.unknown().nullable().optional(),
  sent_at: z.unknown().nullable().optional(),
  __fast: z.unknown().nullable().optional(),
  __test: z.unknown().nullable().optional(),
}).loose();

function normalizeInput(raw: unknown): unknown {
  let v: any = raw;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { v = {}; }
  }
  if (v && typeof v === "object") {
    const qs = v.querystring && typeof v.querystring === "object" ? v.querystring : {};
    return { ...qs, ...v };
  }
  return {};
}

const workflow = defineDurable<unknown, unknown>("hardware-map", async (ctx, rawInput) => {
  const input: any = InputSchema.parse(normalizeInput(rawInput));

  const kind = clip(input.kind, 12);
  if (!["add", "move", "edit", "fix", "remove", "purge_test", "net", "shut", "open", "keep"].includes(kind)) return { skipped: true, reason: "bad-kind" };
  const isTest = clip(input.__test, 5) === "1";

  if (kind === "net") {
    const by = clip(input.by, 60) || "Someone";
    const note = clip(input.note, 200) || "edited";
    const sid = clip(input.sid, 24);
    const base = clip(input.base, 30);
    let net: any = null;
    try { net = typeof input.net === "string" ? JSON.parse(input.net) : input.net; } catch { net = null; }
    const bad = netProblem(net);
    if (bad) {
      await slackDmAndy(ctx, "dm-net-bad", `Mainline map: an edit from ${slackSafe(by)} wasn't saved (${slackSafe(bad)}).`, false);
      return { ok: false, kind, reason: bad };
    }
    const path = isTest ? NET_TEST_PATH : NET_PATH;
    const nowN: { iso: string } = await ctx.step("capture-now-net", async () => ({ iso: new Date().toISOString() }));
    const cur: any = await ctx.step("read-net", async () => {
      try {
        const g = await gh(`/contents/${path}?ref=main`, "GET");
        if (g.status !== 200) return { updated: null };
        const j = JSON.parse(b64dec(g.json.content));
        return { updated: j.updated ?? null };
      } catch (e: any) { return { updated: null, __error: String(e?.message ?? e).slice(0, 200) }; }
    });
    const over = cur.updated && base && cur.updated !== base ? cur.updated : null;
    const out = {
      v: 1,
      updated: nowN.iso,
      source: clip(net.source, 300),
      nodes: net.nodes,
      pipes: net.pipes,
      feeds: net.feeds && typeof net.feeds === "object" ? net.feeds : {},
      log: [...(Array.isArray(net.log) ? net.log : []).slice(-199), { at: nowN.iso, by, note, ...(sid ? { sid } : {}), ...(over ? { over } : {}) }],
    };
    const res = await commit(ctx, "commit-net", `Mainline map: ${note} (${by})${isTest ? " [test]" : ""}`.slice(0, 200), { [path]: b64enc(JSON.stringify(out)) }, null);
    if (!res?.ok) await slackDmAndy(ctx, "dm-net-fail", `Mainline map: an edit from ${slackSafe(by)} didn't save.\n${slackSafe(errs(ctx).join("\n").slice(0, 600))}`, false);
    return { ok: !!res?.ok, kind, test: isTest, updated: nowN.iso, nodes: out.nodes.length, pipes: out.pipes.length, overwrote: over };
  }

  // ---------------- valves shut on the course ----------------
  if (kind === "shut" || kind === "open" || kind === "keep") {
    const sid = clip(input.id, 20).toUpperCase();
    if (!/^SHUT-[A-Z0-9]{4,12}$/.test(sid)) return { skipped: true, reason: "bad-id" };
    const ev = clip(input.ev, 24) || "";
    const by = clip(input.by, 60) || "Someone";
    const bySlackRaw = clip(input.by_slack, 16);
    const bySlack = /^U[A-Z0-9]{6,14}$/.test(bySlackRaw) ? bySlackRaw : "";
    const who = bySlack ? `<@${bySlack}>` : slackSafe(by);
    let list: any[] = [];
    try { const v = typeof input.valves === "string" ? JSON.parse(input.valves) : input.valves; if (Array.isArray(v)) list = v; } catch { list = []; }
    const live = await readLive(ctx, `read-live-${kind}`);
    const rec0: any = (live.shuts || []).find((r: any) => r.id === sid) || null;
    const now: { iso: string; time: string; ms: number; offMs: number } = await ctx.step(`capture-now-${kind}`, async () => {
      const d = new Date();
      const t0 = rec0?.at ? Date.parse(rec0.at) : NaN;
      return { iso: d.toISOString(), time: melTime(d), ms: d.getTime(), offMs: Number.isFinite(t0) ? d.getTime() - t0 : 0 };
    });
    if (rec0 && ev && (rec0.evs || []).includes(ev)) return { skipped: true, reason: "duplicate", id: sid };
    const send = async (name: string, text: string, threadTs: string | null, testRec: boolean): Promise<string | null> => {
      if (testRec) { await slackDmAndy(ctx, name, `Test (would go to #irrigation${threadTs ? ", in the thread" : ""}):\n${text}`, false); return null; }
      return slackPost(ctx, name, IRR_CH, text, threadTs, false);
    };

    if (kind === "shut") {
      if (rec0) return { skipped: true, reason: "id exists", id: sid };
      const valves = list.map((v: any) => ({ id: clip(v?.id, 10), name: clip(v?.name, 24) })).filter((v) => /^n\d{1,6}$/.test(v.id) && v.name).slice(0, 30);
      if (!valves.length) return { skipped: true, reason: "no valves" };
      const target = clip(input.target, 80);
      const why = clip(input.why, 160);
      const keep = clip(input.keep, 8) === "longer" ? "longer" : "today";
      const offN = Math.max(0, Math.min(999, Math.round(num(input.off_n) ?? 0)));
      const offText = clip(input.off_text, 300);
      const rec: any = { id: sid, at: now.iso, by, bySlack, target, why, keep, valves, opened: [], off: { n: offN, text: offText }, status: "shut", evs: ev ? [ev] : [], ...(isTest ? { test: true } : {}) };
      const saved = await commit(ctx, "commit-shut", `Mainline: ${valves.map((v) => v.name).join(", ")} shut${isTest ? " (test)" : ""}`.slice(0, 200), {}, (lv) => {
        lv.shuts = lv.shuts || [];
        if (lv.shuts.some((r: any) => r.id === sid)) return;
        lv.shuts.push(rec);
        lv.shuts = lv.shuts.filter((r: any) => r.status === "shut" || r.id === sid).concat(lv.shuts.filter((r: any) => r.status !== "shut" && r.id !== sid).slice(-60));
        lv.events.push({ at: now.iso, kind, id: sid, by, ...(isTest ? { test: true } : {}) });
      });
      const names = valves.map((v) => v.name).join(", ");
      const text = [`:no_entry: *Water off* · ${slackSafe(why || target || "repair")}`,
        `Shut: ${slackSafe(names)}`,
        ...(offText ? [`Off: ${slackSafe(offText)}`] : []),
        `${who} · ${now.time} · ${keep === "longer" ? "staying off for now" : "back on today"}`,
        `<${shutUrl(sid)}|Open the mainline map>`].join("\n");
      const ts = await send("post-shut", text, null, isTest);
      if (ts) {
        await commit(ctx, "commit-shut-slack", `Mainline: Slack link for ${sid}`, {}, (lv) => {
          const r = (lv.shuts || []).find((x: any) => x.id === sid);
          if (r) r.slack = { ch: IRR_CH, ts, link: permalink(IRR_CH, ts) };
        });
      }
      await reportErrors(ctx, sid, isTest);
      if (!saved?.ok) return { ok: false, kind, id: sid };

      // reminders while they stay shut
      let keepNow = keep;
      let shutDate = "";
      const fast = isTest && clip(input.__fast, 2) === "1";   // test only: 3pm, 7pm and morning reminders 20 s apart
      for (let i = 0; i < (fast ? 3 : 14); i++) {
        const plan: { mins: number; date: string } = await ctx.step(`plan-reminder-${i}`, async () => melClock(new Date()));
        if (i === 0) shutDate = plan.date;
        const sameDay = plan.date === shutDate;
        // next slot: same day 15:00 / 19:00 while "back on today", otherwise 07:00 the next morning
        let at = 7 * 60 + 24 * 60, slot = "morning";
        if (keepNow === "today" && sameDay && plan.mins < 15 * 60 - 20) { at = 15 * 60; slot = "3pm"; }
        else if (keepNow === "today" && sameDay && plan.mins < 19 * 60 - 10) { at = 19 * 60; slot = "7pm"; }
        else if (plan.mins < 7 * 60) at = 7 * 60;
        if (fast) slot = keepNow === "longer" ? "morning" : ["3pm", "7pm", "morning"][i];
        await ctx.wait(`wait-reminder-${i}`, fast ? 20 : Math.max(300, (at - plan.mins) * 60));
        const cur: any = await ctx.step(`check-shut-${i}`, async () => {
          try {
            const g = await gh(`/contents/${LIVE_PATH}?ref=main`, "GET");
            if (g.status !== 200) return { found: false, error: `GET ${g.status}` };
            const lv = JSON.parse(b64dec(g.json.content));
            const r = (lv.shuts || []).find((x: any) => x.id === sid);
            if (!r) return { found: false };
            const still = (r.valves || []).filter((v: any) => !(r.opened || []).includes(v.id)).map((v: any) => v.name);
            return { found: true, status: r.status, keep: r.keep, still, ts: r.slack?.ts ?? null, ms: Date.now() };
          } catch (e: any) { return { found: false, error: String(e?.message ?? e).slice(0, 120) }; }
        });
        if (cur.error) continue;                       // couldn't read: try again at the next slot
        if (!cur.found || cur.status !== "shut" || !cur.still?.length) return { ok: true, kind, id: sid, reminders: i };
        const wasToday = keepNow === "today";
        keepNow = cur.keep === "longer" ? "longer" : "today";
        if (!wasToday && slot !== "morning") continue;
        if (keepNow === "longer" && slot !== "morning") continue;   // switched to staying off since: wait for the morning
        const still = slackSafe(cur.still.join(", "));
        const forWhat = slackSafe(why || target || "repair");
        const since = fmtDur(cur.ms - now.ms);
        let msg: string;
        if (slot === "3pm") msg = `:warning: Still shut: ${still} · ${forWhat}\nTurn them back on before tonight's irrigation, or mark them Staying off on the map. ${who}`;
        else if (slot === "7pm") msg = `:rotating_light: Still shut at 7pm: ${still} · ${forWhat}\nTonight's irrigation won't reach what they feed. ${who} ${[ANDY, BEN, NEIL].filter((u) => u !== bySlack).map((u) => `<@${u}>`).join(" ")}`;
        else msg = `:droplet: Still shut (${since}): ${still} · ${forWhat}\n<${shutUrl(sid)}|Open the mainline map> · ${who}`;
        await send(`remind-${i}`, msg, cur.ts, isTest);
      }
      return { ok: true, kind, id: sid, reminders: "max" };
    }

    if (!rec0) return { skipped: true, reason: "no such shutdown", id: sid };
    const testRec = !!rec0.test || isTest;
    const sl = rec0.slack || null;

    if (kind === "keep") {
      const res = await commit(ctx, "commit-keep", `Mainline: ${sid} staying off`, {}, (lv) => {
        const r = (lv.shuts || []).find((x: any) => x.id === sid);
        if (!r) return;
        r.keep = "longer"; r.evs = [...(r.evs || []), ev].filter(Boolean).slice(-20);
        lv.events.push({ at: now.iso, kind, id: sid, by, ...(testRec ? { test: true } : {}) });
      });
      await send("reply-keep", `:pushpin: Staying off for now · ${who} · ${now.time}`, sl?.ts ?? null, testRec);
      await reportErrors(ctx, sid, testRec);
      return { ok: !!res?.ok, kind, id: sid };
    }

    // open: some or all back on
    const valveIds = (rec0.valves || []).map((v: any) => v.id);
    let ids = list.map((x: any) => clip(x, 10)).filter((x: string) => valveIds.includes(x));
    if (!ids.length) ids = valveIds;
    const already: string[] = rec0.opened || [];
    const nowOpen = ids.filter((x: string) => !already.includes(x));
    const openedAll = [...already, ...nowOpen];
    const allOn = valveIds.every((x: string) => openedAll.includes(x));
    const res = await commit(ctx, "commit-open", `Mainline: ${sid} ${allOn ? "back on" : "partly back on"}`, {}, (lv) => {
      const r = (lv.shuts || []).find((x: any) => x.id === sid);
      if (!r) return;
      r.opened = Array.from(new Set([...(r.opened || []), ...ids]));
      r.opens = [...(r.opens || []), { at: now.iso, by, ids }].slice(-20);
      if ((r.valves || []).every((v: any) => r.opened.includes(v.id))) { r.status = "open"; r.opened_at = now.iso; r.opened_by = by; }
      r.evs = [...(r.evs || []), ev].filter(Boolean).slice(-20);
      lv.events.push({ at: now.iso, kind, id: sid, by, ...(testRec ? { test: true } : {}) });
    });
    const nameOf = (id: string) => (rec0.valves.find((v: any) => v.id === id)?.name ?? id);
    const onNames = slackSafe((nowOpen.length ? nowOpen : ids).map(nameOf).join(", "));
    let text: string;
    if (allOn) text = `:white_check_mark: *Water back on* · ${onNames} · ${who} · ${now.time} · off ${fmtDur(now.offMs)}`;
    else text = `:large_blue_circle: ${onNames} back on · still shut: ${slackSafe(valveIds.filter((x: string) => !openedAll.includes(x)).map(nameOf).join(", "))} · ${who} · ${now.time}`;
    await send("reply-open", text, sl?.ts ?? null, testRec);
    if (allOn && sl?.ts && !testRec) await slackReact(ctx, "react-open", sl.ch, sl.ts, "white_check_mark");
    await reportErrors(ctx, sid, testRec);
    return { ok: !!res?.ok, kind, id: sid, allOn };
  }

  if (kind === "purge_test") {
    if (!isTest) return { skipped: true, reason: "purge needs __test" };
    const live0 = await readLive(ctx, "read-live-purge");
    const gone: string[] = (live0.records || []).filter((r: any) => r.test).map((r: any) => r.id);
    const files: Record<string, string | null> = {};
    for (const r of (live0.records || []).filter((x: any) => x.test)) {
      if (r.page) files[r.page] = null;
      if (r.snap) files[r.snap] = null;
    }
    const res = await commit(ctx, "commit-purge-tests", `Hardware map: remove ${gone.length} test pins`, files, (live) => {
      live.records = (live.records || []).filter((r: any) => !r.test);
      live.events = (live.events || []).filter((e: any) => !e.test);
      live.shuts = (live.shuts || []).filter((r: any) => !r.test);
    });
    return { ok: !!res?.ok, purged: gone };
  }

  const id = clip(input.id, 16).toUpperCase();
  if (!/^PIN-[A-Z0-9]{4,10}$/.test(id)) return { skipped: true, reason: "bad-id" };
  const ev = clip(input.ev, 24) || "";
  const by = clip(input.by, 60) || "Someone";
  const bySlackRaw = clip(input.by_slack, 16);
  const bySlack = /^U[A-Z0-9]{6,14}$/.test(bySlackRaw) ? bySlackRaw : "";
  const who = bySlack ? `<@${bySlack}>` : slackSafe(by);

  const now: { iso: string; time: string } = await ctx.step("capture-now", async () => {
    const d = new Date();
    return { iso: d.toISOString(), time: melTime(d) };
  });
  const time = now.time;

  const live = await readLive(ctx, "read-live");
  const existing = (live.records || []).find((r: any) => r.id === id) || null;
  if (existing && ev && (existing.evs || []).includes(ev)) return { skipped: true, reason: "duplicate", id };

  const lat = num(input.lat), lng = num(input.lng);
  const posOk = lat !== null && lng !== null && lat > -38.14 && lat < -38.10 && lng > 145.22 && lng < 145.27;
  const acc = num(input.acc);
  const fixes = Math.max(0, Math.min(999, Math.round(num(input.fixes) ?? 0)));
  const gpsAcc = num(input.gps_acc);
  const adj = num(input.adj);
  const near = clip(input.near, 80);
  const place = clip(input.place, 60);
  const holeN = num(input.hole);
  const hole = holeN !== null && holeN >= 1 && holeN <= 18 ? Math.round(holeN) : null;
  const condRaw = clip(input.cond, 6);
  const cond = CONDS[condRaw] ? condRaw : "";
  const sizeRaw = clip(input.size, 4);
  const size = /^(\d{2,3}|\?)$/.test(sizeRaw) ? sizeRaw : "";
  const depthN = num(input.depth);
  const depth = depthN !== null && depthN >= 0 && depthN < 1000 ? String(Math.round(depthN)) : "";
  const label = clip(input.label, 40);
  const ref = clip(input.ref, 16);
  const notes = clipLines(input.notes, 600);

  // ---------------- add ----------------
  if (kind === "add") {
    const type = clip(input.type, 12);
    const t = TYPES[type];
    if (!t) return { skipped: true, reason: "bad-type" };
    if (!posOk) return { skipped: true, reason: "position off the course" };
    if (existing) return { skipped: true, reason: "id exists", id };
    const urgent = t.cat === "issue" && clip(input.urgent, 2) === "1";
    const status = t.cat === "issue" ? "open" : "active";
    const rec: any = {
      id, cat: t.cat, type, lat: Math.round(lat! * 1e7) / 1e7, lng: Math.round(lng! * 1e7) / 1e7,
      acc: fixes ? acc : null, fixes, gpsAcc: fixes ? null : gpsAcc, adj: fixes ? null : adj,
      label, ref, cond: t.cat === "asset" ? cond : "", size: t.cat === "asset" ? size : "", depth: t.cat === "asset" ? depth : "",
      notes, urgent, near, place, hole, by, bySlack, at: now.iso, status, evs: ev ? [ev] : [], updated: now.iso,
      ...(isTest ? { test: true } : {}),
    };
    const alert = t.cat === "issue" || cond === "work" || cond === "fail";
    const files: Record<string, string | null> = {};
    let snapPath: string | null = null;
    if (alert) {
      const snap = String(input.snap ?? "").replace(/\s+/g, "");
      if (snap.length > 1000 && snap.length < 900000 && /^[A-Za-z0-9+/]+=*$/.test(snap) && snap.startsWith("/9j/")) {
        snapPath = `hardware/snaps/${id}.jpg`;
        files[snapPath] = snap;
      }
      const pagePath = `hardware/p/${id}.html`;
      files[pagePath] = b64enc(pinPage(rec, snapPath));
      rec.page = pagePath;
      if (snapPath) rec.snap = snapPath;
    }
    const saved = await commit(ctx, "commit-new-pin", `Hardware map: ${t.name.toLowerCase()} ${id}${isTest ? " (test)" : ""}`, files, (lv) => {
      lv.records = lv.records || [];
      if (lv.records.some((r: any) => r.id === id)) return;
      lv.records.push(rec);
      lv.events = lv.events || [];
      lv.events.push({ at: now.iso, kind, id, type, by, ...(isTest ? { test: true } : {}) });
    });
    if (!alert) {
      await reportErrors(ctx, id, isTest);
      return { ok: !!saved?.ok, kind, id, alert: false, test: isTest };
    }

    // wait for GitHub Pages to deploy a commit at or after ours, so Slack can read the pin page's preview
    let pageLive = false;
    if (saved?.ok) {
      const since = String(saved.at || "").slice(0, 19);
      for (let i = 0; i < 12 && !pageLive; i++) {
        await ctx.wait(`wait-for-pages-${i}`, i === 0 ? 25 : 10);
        const st: any = await ctx.step(`check-pages-deploy-${i}`, async () => {
          try {
            const r = await gh("/actions/runs?per_page=10", "GET");
            if (r.status !== 200) return { live: false, status: r.status };
            const live = (r.json?.workflow_runs || []).some((w: any) => w.name === "pages build and deployment" && w.status === "completed"
              && w.conclusion === "success" && String(w.created_at || "").slice(0, 19) >= since);
            return { live, status: 200 };
          } catch (e: any) {
            return { live: false, status: 0, error: String(e?.message ?? e).slice(0, 120) };
          }
        });
        if (st?.status !== 200 && i >= 3) { pageLive = true; break; } // can't see deploys: a minute is normally enough
        pageLive = !!st?.live;
      }
      if (pageLive) await ctx.wait("wait-for-cdn", 6);
    }
    const linkUrl = pageLive ? `${PAGES}p/${id}.html` : pinUrl(id, rec.lat, rec.lng);
    const ch = t.fam === "drn" ? DRN_CH : IRR_CH;
    let head: string;
    if (t.cat === "issue") head = `${urgent ? ":rotating_light: *Urgent* · " : ""}${t.emoji} *${t.name}*`;
    else head = `${cond === "fail" ? ":red_circle:" : ":large_orange_circle:"} *${t.name}: ${CONDS[cond]}*`;
    const where = [place, near].filter(Boolean).join(", ");
    const lines = [`${head}${where ? " · " + slackSafe(where) : ""}`];
    const tags = [label, ref && ref !== label ? ref : "", size && size !== "?" ? `${size} mm` : ""].filter(Boolean);
    if (tags.length) lines.push(slackSafe(tags.join(" · ")));
    if (notes) lines.push(slackSafe(notes));
    lines.push(`${who} · ${time}${urgent ? ` · <@${ANDY}> <@${BEN}> <@${NEIL}>` : ""}`);
    lines.push(`<${linkUrl}|Open the pin on the map>`);
    const text = lines.join("\n");

    let ts: string | null = null;
    if (isTest) {
      await slackDmAndy(ctx, "dm-test-alert", `Test (would go to #${t.fam === "drn" ? "drainage" : "irrigation"}):\n${text}`, true);
    } else {
      ts = await slackPost(ctx, "post-alert", ch, text, null, true);
    }
    if (ts) {
      await commit(ctx, "commit-slack-link", `Hardware map: Slack link for ${id}`, {}, (lv) => {
        const r = (lv.records || []).find((x: any) => x.id === id);
        if (r) r.slack = { ch, ts, link: permalink(ch, ts) };
      });
    }
    await reportErrors(ctx, id, isTest);
    return { ok: !!saved?.ok, kind, id, alert: true, pageLive, posted: !!ts || isTest, test: isTest, errors: errs(ctx) };
  }

  // ---------------- changes to an existing pin ----------------
  const rec0: any = existing;
  const t0 = rec0 ? TYPES[rec0.type] : null;
  const isIssue = t0?.cat === "issue";
  const sl = rec0?.slack || null;
  const testRec = !!rec0?.test || isTest;

  if (kind === "move") {
    if (!posOk) return { skipped: true, reason: "position off the course" };
    const res = await commit(ctx, "commit-move", `Hardware map: moved ${id}`, {}, (lv) => {
      const r = (lv.records || []).find((x: any) => x.id === id);
      if (!r) return;
      r.moves = [...(r.moves || []), { at: now.iso, by, from: [r.lat, r.lng] }].slice(-5);
      r.lat = Math.round(lat! * 1e7) / 1e7; r.lng = Math.round(lng! * 1e7) / 1e7;
      r.acc = fixes ? acc : null; r.fixes = fixes; r.gpsAcc = fixes ? null : gpsAcc; r.adj = fixes ? null : adj;
      if (near) r.near = near; if (place) r.place = place; r.hole = hole;
      r.evs = [...(r.evs || []), ev].filter(Boolean).slice(-10); r.updated = now.iso;
      lv.events.push({ at: now.iso, kind, id, by, ...(testRec ? { test: true } : {}) });
    });
    if (isIssue && rec0.status !== "fixed" && sl?.ts && !testRec) {
      const moved = rec0.lat != null ? Math.round(Math.hypot((lat! - rec0.lat) * 111320, (lng! - rec0.lng) * 111320 * Math.cos(lat! * Math.PI / 180)) * 10) / 10 : null;
      await slackPost(ctx, "reply-moved", sl.ch, `Pin moved${moved !== null ? ` ${moved} m` : ""}${place || near ? ` · ${slackSafe([place, near].filter(Boolean).join(", "))}` : ""} · ${who}\n<${pinUrl(id, lat!, lng!)}|Open the pin on the map>`, sl.ts, false);
    }
    await reportErrors(ctx, id, testRec);
    return { ok: !!res?.ok, kind, id };
  }

  if (kind === "edit") {
    const res = await commit(ctx, "commit-edit", `Hardware map: edited ${id}`, {}, (lv) => {
      const r = (lv.records || []).find((x: any) => x.id === id);
      if (!r) return;
      r.label = label; r.ref = ref; r.notes = notes;
      if (r.cat === "asset") { r.cond = cond; r.size = size; r.depth = depth; }
      r.evs = [...(r.evs || []), ev].filter(Boolean).slice(-10); r.updated = now.iso;
      lv.events.push({ at: now.iso, kind, id, by, ...(testRec ? { test: true } : {}) });
    });
    // hardware newly marked Needs work / Failed: post it like a problem
    if (rec0 && t0 && t0.cat === "asset" && (cond === "work" || cond === "fail") && rec0.cond !== cond) {
      const ch = t0.fam === "drn" ? DRN_CH : IRR_CH;
      const where = [rec0.place, rec0.near].filter(Boolean).join(", ");
      const tags = [label, ref && ref !== label ? ref : "", size && size !== "?" ? `${size} mm` : ""].filter(Boolean);
      const text = [`${cond === "fail" ? ":red_circle:" : ":large_orange_circle:"} *${t0.name}: ${CONDS[cond]}*${where ? " · " + slackSafe(where) : ""}`,
        ...(tags.length ? [slackSafe(tags.join(" · "))] : []), ...(notes ? [slackSafe(notes)] : []),
        `${who} · ${time}`, `<${pinUrl(id, rec0.lat, rec0.lng)}|Open the pin on the map>`].join("\n");
      if (testRec) await slackDmAndy(ctx, "dm-test-edit-alert", `Test (would go to #${t0.fam === "drn" ? "drainage" : "irrigation"}):\n${text}`, false);
      else {
        const ts = await slackPost(ctx, "post-edit-alert", ch, text, sl?.ts && sl.ch === ch ? sl.ts : null, false);
        if (ts && !sl?.ts) {
          await commit(ctx, "commit-edit-slack-link", `Hardware map: Slack link for ${id}`, {}, (lv) => {
            const r = (lv.records || []).find((x: any) => x.id === id);
            if (r) r.slack = { ch, ts, link: permalink(ch, ts) };
          });
        }
      }
    }
    await reportErrors(ctx, id, testRec);
    return { ok: !!res?.ok, kind, id };
  }

  if (kind === "fix") {
    const res = await commit(ctx, "commit-fixed", `Hardware map: fixed ${id}`, {}, (lv) => {
      const r = (lv.records || []).find((x: any) => x.id === id);
      if (!r) return;
      r.status = r.cat === "issue" ? "fixed" : r.status;
      if (r.cat === "asset" && (r.cond === "work" || r.cond === "fail")) r.cond = "good";
      r.fixed_at = now.iso; r.fixed_by = by; r.fix_notes = notes;
      r.evs = [...(r.evs || []), ev].filter(Boolean).slice(-10); r.updated = now.iso;
      lv.events.push({ at: now.iso, kind, id, by, ...(testRec ? { test: true } : {}) });
    });
    const text = `:white_check_mark: *Fixed* · ${who} · ${time}${notes ? "\n" + slackSafe(notes) : ""}`;
    if (testRec) await slackDmAndy(ctx, "dm-test-fixed", `Test (thread reply):\n${text}`, false);
    else if (sl?.ts) {
      await slackPost(ctx, "reply-fixed", sl.ch, text, sl.ts, false);
      await slackReact(ctx, "react-fixed", sl.ch, sl.ts, "white_check_mark");
    }
    await reportErrors(ctx, id, testRec);
    return { ok: !!res?.ok, kind, id };
  }

  // remove
  const res = await commit(ctx, "commit-removed", `Hardware map: removed ${id}`, {}, (lv) => {
    const r = (lv.records || []).find((x: any) => x.id === id);
    if (!r) return;
    r.status = "removed"; r.removed_at = now.iso; r.removed_by = by; r.remove_notes = notes;
    r.evs = [...(r.evs || []), ev].filter(Boolean).slice(-10); r.updated = now.iso;
    lv.events.push({ at: now.iso, kind, id, by, ...(testRec ? { test: true } : {}) });
  });
  if (isIssue && rec0.status !== "fixed" && sl?.ts && !testRec) {
    await slackPost(ctx, "reply-removed", sl.ch, `Pin taken off the map · ${who}${notes ? " · " + slackSafe(notes) : ""}`, sl.ts, false);
  }
  await reportErrors(ctx, id, testRec);
  return { ok: !!res?.ok, kind, id };
});

export default workflow;
