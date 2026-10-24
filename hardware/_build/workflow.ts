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
// __test "1": Slack goes to Andy's DM instead of the channel and the record is marked test (the page hides it).
// Every change is one atomic commit through the Git data API, retried if the branch moved underneath it.

const sdk = createZapierSdk();

const GH = "github_main";
const SLACK = "slack_main";
const REPO = "https://api.github.com/repos/andranf/ranfurlie-greens";
const PAGES = "https://andranf.github.io/ranfurlie-greens/hardware/";
const LIVE_PATH = "hardware/live.json";
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
function melTime(iso: string): string {
  return new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Melbourne", hour: "numeric", minute: "2-digit", hour12: true })
    .format(new Date(iso)).replace(/\s+/g, "").toLowerCase();
}
function melDay(iso: string): string {
  return new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Melbourne", weekday: "short", day: "numeric", month: "short" }).format(new Date(iso));
}
function permalink(ch: string, ts: string): string {
  return `https://ranfurliegolfclub.slack.com/archives/${ch}/p${ts.replace(".", "")}`;
}
function blankLive(): any {
  return { v: 1, updated: null, records: [], events: [], cirrus: {} };
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
        const up = await gh("/git/refs/heads/main", "PATCH", { sha: nc.json.sha, force: false });
        if (up.status === 200) return { ok: true, sha: nc.json.sha };
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
  sent_at: z.unknown().nullable().optional(),
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
  if (!["add", "move", "edit", "fix", "remove", "purge_test"].includes(kind)) return { skipped: true, reason: "bad-kind" };
  const isTest = clip(input.__test, 5) === "1";

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

  const now: { iso: string } = await ctx.step("capture-now", async () => ({ iso: new Date().toISOString() }));
  const time = melTime(now.iso);

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

    // wait for GitHub Pages to serve the pin page so Slack can show its preview
    let pageLive = false;
    if (saved?.ok) {
      const url = `${PAGES}p/${id}.html`;
      for (let i = 0; i < 12 && !pageLive; i++) {
        if (i > 0) await ctx.wait(`wait-for-pages-${i}`, 12);
        const st: any = await ctx.step(`check-pin-page-${i}`, async () => {
          try {
            const r = await fetch(`${url}?v=${Date.now()}`, { method: "GET", redirect: "manual" as any });
            return { status: r.status };
          } catch (e: any) {
            return { status: 0, error: String(e?.message ?? e).slice(0, 120) };
          }
        });
        pageLive = st?.status === 200;
      }
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
