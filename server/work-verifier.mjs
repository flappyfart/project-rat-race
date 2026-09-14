import { createHash, randomBytes } from "node:crypto";
export const workHash = (files) =>
  createHash("sha256")
    .update(
      JSON.stringify([...files].sort((a, b) => a.name.localeCompare(b.name))),
    )
    .digest("hex");
export async function verifyWork({ runner, files, module, exportName, cases }) {
  if (
    !runner ||
    !/^([a-zA-Z0-9_][a-zA-Z0-9_.-]*\/)*[a-zA-Z0-9_][a-zA-Z0-9_.-]*\.(mjs|js|cjs)$/.test(
      module ?? "",
    ) ||
    module.includes("..") ||
    !/^[$a-zA-Z_][$\w]*$/.test(exportName ?? "") ||
    !files.some((f) => f.name === module)
  )
    throw Error("invalid verification target");
  if (!Array.isArray(cases) || cases.length < 3 || cases.length > 20)
    throw Error("provide at least three explicit assertion cases");
  for (const c of cases) {
    if (
      typeof c.argsJson !== "string" ||
      typeof c.expectedJson !== "string" ||
      typeof c.throws !== "boolean" ||
      c.argsJson.length > 6000 ||
      c.expectedJson.length > 6000 ||
      !Array.isArray(JSON.parse(c.argsJson))
    )
      throw Error("invalid assertion case");
    JSON.parse(c.expectedJson);
  }
  const positives = cases.filter((c) => !c.throws);
  if (
    positives.length < 2 ||
    !cases.some((c) => c.throws) ||
    new Set(positives.map((c) => c.expectedJson)).size < 2
  )
    throw Error(
      "verification requires distinct positive results and an invalid-input rejection",
    );
  const nonce = randomBytes(12).toString("hex"),
    name = "verify_" + nonce + ".mjs";
  const code = `import assert from 'node:assert/strict';const equal=assert.deepStrictEqual.bind(assert);const cases=${JSON.stringify(cases)};const mod=await import('./'+${JSON.stringify(module)});const fn=mod[${JSON.stringify(exportName)}]??mod.default?.[${JSON.stringify(exportName)}];assert.equal(typeof fn,'function');let count=0;for(const c of cases){let result,error;try{result=await fn(...JSON.parse(c.argsJson));}catch(e){error=e;}if(c.throws){assert(error,'invalid input must throw');}else{if(error)throw error;if(process.argv[2]==='mutate')result={deliberatelyWrong:true};equal(result,JSON.parse(c.expectedJson));}count++;}console.log(${JSON.stringify("RAT_ASSERTIONS_" + nonce + ":")}+count);`;
  const input = [...files, { name, content: code }],
    positive = await runner.run({ files: input, entry: name, args: [] });
  if (
    positive.exitCode !== 0 ||
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
