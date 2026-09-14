import { Wallet, verifyMessage } from "ethers";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, chmod, access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";

// No private material is printed, accepted on argv, or written to the project tree.
const root = path.join(homedir(), ".local/share/project-rat-race");
const helper = path.join(root, "keychain-helper");
if (process.platform !== "darwin")
  throw new Error("macos keychain is required");
await mkdir(root, { recursive: true, mode: 0o700 });
await chmod(root, 0o700);
await access(helper);
function keychain(mode, input) {
  const r = spawnSync(helper, [mode], {
    input,
    encoding: "utf8",
    timeout: 20000,
    maxBuffer: 8192,
  });
  if (r.status !== 0)
    throw new Error(
      "keychain operation failed or user authorization is required. no wallet address will be issued.",
    );
  return r.stdout.trim();
}
let wallet,
  password,
  created = false;
const presence = keychain("probe");
if (presence === "absent") {
  // Refuse to orphan an existing encrypted wallet if its Keychain entry is missing.
  try {
    await access(path.join(root, "wallet.keystore.json"));
    throw new Error(
      "existing recovery file found without keychain entry. manual recovery required.",
    );
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  wallet = new Wallet("0x" + randomBytes(32).toString("hex"));
  password = randomBytes(48).toString("base64url");
  keychain(
    "create",
    JSON.stringify({ privateKey: wallet.privateKey, backupPassword: password }),
  );
  created = true;
}
const stored = JSON.parse(keychain("read"));
wallet = new Wallet(stored.privateKey);
password = stored.backupPassword;
if (!password || password.length < 40)
  throw new Error("incomplete secure storage");
const backupFile = path.join(root, "wallet.keystore.json");
let encrypted;
try {
  encrypted = await readFile(backupFile, "utf8");
} catch (e) {
  if (e.code !== "ENOENT") throw e;
  encrypted = await wallet.encrypt(password);
  await writeFile(backupFile, encrypted, { flag: "wx", mode: 0o600 });
}
await chmod(backupFile, 0o600);
const restored = await Wallet.fromEncryptedJson(encrypted, password);
if (restored.address !== wallet.address)
  throw new Error("backup does not restore receiving address");
const message =
  "project rat race. local custody verification only. no transaction authorization.";
const signature = await restored.signMessage(message);
if (verifyMessage(message, signature) !== wallet.address)
  throw new Error("local recovery challenge failed");
const publicRecord = {
  address: wallet.address,
  chainId: 4663,
  network: "robinhood chain",
  asset: "native ETH",
  createdOrRecovered: new Date().toISOString(),
  keyStorage: "macos login keychain",
  backup: "encrypted keystore outside project",
  backupRoundTripVerified: true,
  localSignatureVerified: true,
  automaticSigningEnabled: false,
};
await writeFile(
  path.join(root, "wallet.public.json"),
  JSON.stringify(publicRecord, null, 2),
  { mode: 0o600 },
);
console.log(
  JSON.stringify(
    {
      ...publicRecord,
      created,
      publicRecordPath: path.join(root, "wallet.public.json"),
      encryptedBackupPath: backupFile,
    },
    null,
    2,
  ),
);
