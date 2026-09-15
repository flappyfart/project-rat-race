import { createHash, randomBytes } from "node:crypto";
export const workHash = (files) =>
  createHash("sha256")
    .update(
      JSON.stringify([...files].sort((a, b) => a.name.localeCompare(b.name))),
    )
    .digest("hex");
const moduleName = (value) =>
  typeof value === "string" &&
  value.length < 180 &&
  /^([a-zA-Z0-9_][a-zA-Z0-9_.-]*\/)*[a-zA-Z0-9_][a-zA-Z0-9_.-]*\.(mjs|js|cjs)$/.test(
    value,
  ) &&
  !value.includes("..");
function invalid(field, message, extra = {}) {
  const error = new Error(`verification input ${field}: ${message}`);
  error.code = "VERIFICATION_INPUT";
  error.field = field;
  Object.assign(error, extra);
  throw error;
}
function decode(value, field) {
  if (typeof value !== "string" || value.length > 6000)
    invalid(field, "must be a JSON string no longer than 6000 characters");
  try {
    return JSON.parse(value);
  } catch {
    invalid(
      field,
      'must contain valid JSON encoded exactly once. For one string argument, argsJson is a JSON array such as ["invalid input"], not a quoted array or a bare string.',
    );
  }
}
function stable(value) {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + stable(value[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export function validateVerificationInput({
  files,
  module,
  exportName,
  cases,
}) {
  if (!Array.isArray(files))
    invalid("files", "workspace file list unavailable");
  const availableModules = files
    .map((f) => f.name)
    .filter(moduleName)
    .slice(0, 80);
  if (!moduleName(module))
    invalid(
      "module",
      "must be a relative existing .mjs, .js or .cjs workspace path",
      { availableModules },
    );
  if (!files.some((f) => f.name === module))
    invalid(
      "module",
      "not found in the workspace. Use list_files and read_file to inspect the actual module and export; do not guess a new filename.",
      { availableModules },
    );
  if (typeof exportName !== "string" || !/^[$a-zA-Z_][$\w]*$/.test(exportName))
    invalid("exportName", "must be the exact exported function name");
  if (!Array.isArray(cases) || cases.length < 3 || cases.length > 20)
    invalid(
      "cases",
      "provide three to twenty cases: two distinct positive results and one invalid input that throws",
    );
  const normalized = cases.map((c, index) => {
    const base = `cases[${index}]`;
    if (!c || typeof c !== "object" || Array.isArray(c))
      invalid(base, "must be an object with argsJson, expectedJson and throws");
    if (typeof c.throws !== "boolean")
      invalid(base + ".throws", "must be a boolean");
    const args = decode(c.argsJson, base + ".argsJson");
    if (!Array.isArray(args))
      invalid(
        base + ".argsJson",
        'must decode to an array of function arguments, even for a single invalid input. Use ["invalid input"], not "invalid input".',
      );
    const expected = decode(c.expectedJson, base + ".expectedJson");
    return {
      argsJson: JSON.stringify(args),
      expectedJson: JSON.stringify(expected),
      throws: c.throws,
    };
  });
  const positives = normalized.filter((c) => !c.throws);
  if (
    positives.length < 2 ||
    !normalized.some((c) => c.throws) ||
    new Set(positives.map((c) => stable(JSON.parse(c.expectedJson)))).size < 2
  )
    invalid(
      "cases",
      "verification requires distinct positive results and an invalid-input rejection",
    );
  return { module, exportName, cases: normalized };
}
export async function verifyWork({ runner, files, module, exportName, cases }) {
  if (!runner) throw Error("isolated verification runner unavailable");
  ({ module, exportName, cases } = validateVerificationInput({
    files,
    module,
    exportName,
    cases,
  }));
  const nonce = randomBytes(12).toString("hex"),
    name = "verify_" + nonce + ".mjs";
  const code = `import assert from 'node:assert/strict';const equal=assert.deepStrictEqual.bind(assert);const cases=${JSON.stringify(cases)};const mod=await import('./'+${JSON.stringify(module)});const fn=mod[${JSON.stringify(exportName)}]??mod.default?.[${JSON.stringify(exportName)}];assert.equal(typeof fn,'function');let count=0;for(const c of cases){let result,error;try{result=await fn(...JSON.parse(c.argsJson));}catch(e){error=e;}if(c.throws){assert(error,'invalid input must throw');}else{if(error)throw error;if(process.argv[2]==='mutate')result={deliberatelyWrong:true};equal(result,JSON.parse(c.expectedJson));}count++;}console.log(${JSON.stringify("RAT_ASSERTIONS_" + nonce + ":")}+count);`;
  const input = [...files, { name, content: code }],
    positive = await runner.run({ files: input, entry: name, args: [] });
  if (
    positive.exitCode !== 0 ||
    positive.timedOut ||
    positive.outputLimited ||
    !positive.stdout?.includes("RAT_ASSERTIONS_" + nonce + ":" + cases.length)
  )
    return {
      verified: false,
      sourceHash: workHash(files),
      reason: "assertion harness failed",
      stdout: positive.stdout?.slice(-4000),
      stderr: positive.stderr?.slice(-5000),
    };
  const negative = await runner.run({
    files: input,
    entry: name,
    args: ["mutate"],
  });
  if (negative.exitCode === 0 || negative.timedOut || negative.outputLimited)
    return {
      verified: false,
      sourceHash: workHash(files),
      reason: "negative control did not demonstrate assertion failure",
    };
  return {
    verified: true,
    kind: "executed assertions with negative control",
    sourceHash: workHash(files),
    module,
    exportName,
    assertions: cases.length,
    cases,
    negativeControl: "failed as required",
    verifiedAt: new Date().toISOString(),
  };
}
