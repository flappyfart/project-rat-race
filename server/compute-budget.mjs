import { mkdir, open, readFile, rename, unlink, stat } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const TOTAL = 750000n,
  CHAT = 100000n,
  MAX_RECORDS = 100000;
const hash = (s) =>
  createHash("sha256").update(JSON.stringify(s)).digest("hex");
const integer = (s) =>
  typeof s === "string" && /^(0|[1-9][0-9]{0,17})$/.test(s);
const dayValid = (s) =>
  typeof s === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  Number.isFinite(Date.parse(s)) &&
  new Date(s).toISOString().slice(0, 10) === s;
const keys = (x, names) =>
  x &&
  typeof x === "object" &&
  !Array.isArray(x) &&
  Object.keys(x).sort().join(",") === names.split(",").sort().join(",");
// Decimal conversion uses integer arithmetic, including scientific notation. Never rounds down.
export function usdToMicrosCeil(value) {
  const s = String(value),
    m = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(s);
  if (!m || s.length > 100) throw Error("invalid compute cost");
  const exponent = Number(m[3] ?? 0) - (m[2]?.length ?? 0) + 6;
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 100)
    throw Error("invalid compute cost");
  const n = BigInt(m[1] + (m[2] ?? ""));
  return (
    exponent >= 0
      ? n * 10n ** BigInt(exponent)
      : (n + 10n ** BigInt(-exponent) - 1n) / 10n ** BigInt(-exponent)
  ).toString();
}
export class ComputeBudgetWaitError extends Error {
  constructor(now) {
    super(
      "daily compute allowance unavailable; please try again after the next utc day",
    );
    this.code = "COMPUTE_BUDGET_WAIT";
    this.knownUnspent = true;
    this.retryAfterMs =
      Date.parse(new Date(now).toISOString().slice(0, 10)) +
      24 * 60 * 60 * 1000 -
      now;
  }
}
function validate(s) {
  if (
    !keys(s, "version,legacy,records") ||
    s.version !== 1 ||
    !Array.isArray(s.legacy) ||
    !Array.isArray(s.records) ||
    s.records.length > MAX_RECORDS
  )
    throw Error("compute ledger invalid");
  const days = new Set(),
    ids = new Set();
  for (const l of s.legacy) {
    if (
      !keys(l, "day,costUsdMicros,requests") ||
      !dayValid(l.day) ||
      days.has(l.day) ||
      !integer(l.costUsdMicros) ||
      !Number.isSafeInteger(l.requests) ||
      l.requests < 0
    )
      throw Error("compute legacy ledger invalid");
    days.add(l.day);
  }
  for (const r of s.records) {
    if (
      !keys(r, "id,channel,day,maximumUsdMicros,state,chargedUsdMicros") ||
      typeof r.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(r.id) ||
      ids.has(r.id) ||
      !["agent", "chat"].includes(r.channel) ||
      !dayValid(r.day) ||
      !integer(r.maximumUsdMicros) ||
      BigInt(r.maximumUsdMicros) < 1n ||
      BigInt(r.maximumUsdMicros) > 20000n ||
      !integer(r.chargedUsdMicros) ||
      !["reserved", "settled", "uncertain", "released"].includes(r.state) ||
      (["reserved", "uncertain"].includes(r.state) &&
        r.chargedUsdMicros !== r.maximumUsdMicros) ||
      (r.state === "released" && r.chargedUsdMicros !== "0")
    )
      throw Error("compute reservation ledger invalid");
    ids.add(r.id);
  }
  return s;
}
function totals(s, day) {
  let total = 0n,
    chat = 0n,
    requests = 0;
  for (const l of s.legacy)
    if (l.day === day) {
      total += BigInt(l.costUsdMicros);
      requests += l.requests;
    }
  for (const r of s.records)
    if (r.day === day) {
      total += BigInt(r.chargedUsdMicros);
      if (r.channel === "chat") chat += BigInt(r.chargedUsdMicros);
      if (r.state !== "released") requests++;
    }
  return { total, chat, requests };
}

export class ComputeBudget {
  #queue = Promise.resolve();
  #ready = false;
  constructor({ root, now = Date.now }) {
    if (typeof root !== "string" || !root) throw Error("compute root required");
    this.root = root;
    this.now = now;
    this.file = path.join(root, "compute-budget.json");
  }
  async #syncDirectory() {
    const h = await open(this.root, "r");
    try {
      await h.sync();
    } finally {
      await h.close();
    }
  }
  async #exclusive(fn) {
    const work = this.#queue.then(async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      let lock;
      try {
        lock = await open(
          path.join(this.root, "compute-budget.lock"),
          "wx",
          0o600,
        );
      } catch (e) {
        if (e.code === "EEXIST")
          throw Error(
            "compute ledger locked; manual stale-lock review required",
          );
        throw e;
      }
      try {
        await lock.writeFile(
          JSON.stringify({ pid: process.pid, nonce: randomUUID() }),
        );
        await lock.sync();
        return await fn();
      } finally {
        await lock.close();
        await unlink(path.join(this.root, "compute-budget.lock"));
        await this.#syncDirectory();
      }
    });
    this.#queue = work.catch(() => {});
    return work;
  }
  async #load() {
    try {
      if ((await stat(this.file)).size > 64000000) throw Error();
      const e = JSON.parse(await readFile(this.file, "utf8"));
      if (!keys(e, "state,hash") || e.hash !== hash(e.state)) throw Error();
      return validate(e.state);
    } catch {
      throw Error(
        "compute ledger unavailable or corrupt; refusing paid requests",
      );
    }
  }
  async #save(state) {
    validate(state);
    const tmp = this.file + "." + randomUUID() + ".tmp",
      h = await open(tmp, "wx", 0o600);
    try {
      await h.writeFile(JSON.stringify({ state, hash: hash(state) }));
      await h.sync();
    } finally {
      await h.close();
    }
    await rename(tmp, this.file);
    await this.#syncDirectory();
  }
  async initialize({ legacyDays = {} } = {}) {
    return this.#exclusive(async () => {
      let exists = true;
      try {
        await stat(this.file);
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
        exists = false;
      }
      if (exists) {
        await this.#load();
      } else {
        const marker = path.join(this.root, "compute-budget.initialized");
        let seen = false;
        try {
          await stat(marker);
          seen = true;
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
        if (seen) throw Error("compute ledger missing after initialization");
        if (
          !legacyDays ||
          typeof legacyDays !== "object" ||
          Array.isArray(legacyDays)
        )
          throw Error("invalid legacy compute days");
        const legacy = Object.entries(legacyDays).map(([day, d]) => {
          if (
            !d ||
            typeof d.costUsd !== "number" ||
            !Number.isFinite(d.costUsd) ||
            d.costUsd < 0
          )
            throw Error("invalid legacy compute cost");
          return {
            day,
            costUsdMicros: usdToMicrosCeil(d.costUsd),
            requests: d.requests,
          };
        });
        const state = validate({ version: 1, legacy, records: [] });
        const h = await open(marker, "wx", 0o600);
        try {
          await h.writeFile("1");
          await h.sync();
        } finally {
          await h.close();
        }
        await this.#syncDirectory();
        await this.#save(state);
      }
      this.#ready = true;
      return this;
    });
  }
  #requireReady() {
    if (!this.#ready) throw Error("compute budget not initialized");
  }
  async reserve({ id, channel = "agent", maximumUsdMicros = "20000" }) {
    this.#requireReady();
    return this.#exclusive(async () => {
      const s = await this.#load(),
        now = this.now(),
        day = new Date(now).toISOString().slice(0, 10);
      const r = {
        id,
        channel,
        day,
        maximumUsdMicros,
        state: "reserved",
        chargedUsdMicros: maximumUsdMicros,
      };
      validate({ version: 1, legacy: [], records: [r] });
      // Keep tombstones permanently, with a hard storage bound: exhaustion fails closed, never evicts IDs.
      if (s.records.some((r) => r.id === id)) {
        const e = Error(
          "compute request already recorded; automatic replay refused",
        );
        e.code = "COMPUTE_DUPLICATE";
        e.knownUnspent = true;
        throw e;
      }
      if (s.records.length >= MAX_RECORDS)
        throw Error("compute ledger capacity reached");
      const t = totals(s, day),
        amount = BigInt(maximumUsdMicros);
      if (
        t.total + amount > TOTAL ||
        (channel === "chat" && t.chat + amount > CHAT)
      )
        throw new ComputeBudgetWaitError(now);
      s.records.push(r);
      await this.#save(s);
      return Object.freeze({ id, channel, day, maximumUsdMicros });
    });
  }
  async #finish(reservation, state, amount) {
    this.#requireReady();
    return this.#exclusive(async () => {
      const s = await this.#load(),
        r = s.records.find((x) => x.id === reservation?.id);
      if (
        !r ||
        !keys(reservation, "id,channel,day,maximumUsdMicros") ||
        ["id", "channel", "day", "maximumUsdMicros"].some(
          (k) => r[k] !== reservation[k],
        )
      )
        throw Error("compute reservation mismatch");
      if (!integer(amount)) throw Error("invalid compute settlement");
      if (r.state !== "reserved") {
        if (r.state === state && r.chargedUsdMicros === amount) return;
        throw Error("compute reservation already finalized");
      }
      r.state = state;
      r.chargedUsdMicros = amount;
      await this.#save(s);
    });
  }
  async settle(reservation, { actualUsdMicros }) {
    return this.#finish(reservation, "settled", actualUsdMicros);
  }
  async fail(reservation, { knownUnspent }) {
    if (typeof knownUnspent !== "boolean")
      throw Error("compute failure certainty required");
    return this.#finish(
      reservation,
      knownUnspent ? "released" : "uncertain",
      knownUnspent ? "0" : reservation.maximumUsdMicros,
    );
  }
  async status() {
    this.#requireReady();
    return this.#exclusive(async () => {
      const s = await this.#load(),
        day = new Date(this.now()).toISOString().slice(0, 10),
        t = totals(s, day),
        remaining = TOTAL > t.total ? TOTAL - t.total : 0n,
        chatRemaining = CHAT > t.chat ? CHAT - t.chat : 0n;
      return {
        day,
        totalCapUsdMicros: String(TOTAL),
        chatCapUsdMicros: String(CHAT),
        usedUsdMicros: String(t.total),
        chatUsedUsdMicros: String(t.chat),
        availableUsdMicros: String(remaining),
        chatAvailableUsdMicros: String(
          remaining < chatRemaining ? remaining : chatRemaining,
        ),
        requests: t.requests,
      };
    });
  }
}
