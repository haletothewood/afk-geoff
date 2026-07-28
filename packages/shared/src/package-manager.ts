import fs from "node:fs";
import path from "node:path";

export const packageManagerNames = ["npm", "pnpm", "yarn", "bun"] as const;

export type PackageManagerName = typeof packageManagerNames[number];

const lockfiles: Record<PackageManagerName, string[]> = {
  npm: ["package-lock.json", "npm-shrinkwrap.json"],
  pnpm: ["pnpm-lock.yaml"],
  yarn: ["yarn.lock"],
  bun: ["bun.lock", "bun.lockb"]
};

export interface PackageManagerContract {
  selected?: PackageManagerName;
  declared?: PackageManagerName;
  detectedLockfiles: Array<{ manager: PackageManagerName; filename: string }>;
}

export function resolvePackageManagerContract(
  repoRoot: string,
  verificationCommands: string[] = []
): PackageManagerContract {
  const declared = readDeclaredPackageManager(repoRoot);
  const detectedLockfiles = packageManagerNames.flatMap((manager) =>
    lockfiles[manager]
      .filter((filename) => fs.existsSync(path.join(repoRoot, filename)))
      .map((filename) => ({ manager, filename }))
  );
  const managers = new Set<PackageManagerName>([
    ...(declared ? [declared] : []),
    ...detectedLockfiles.map((lockfile) => lockfile.manager)
  ]);

  if (managers.size > 1) {
    const details = [
      ...(declared ? [`packageManager declares ${declared}`] : []),
      ...detectedLockfiles.map((lockfile) => `${lockfile.filename} selects ${lockfile.manager}`)
    ];
    throw new Error(
      `Package manager conflict: ${details.join(", ")}. Keep one package manager and remove accidental secondary lockfiles.`
    );
  }

  const selected = [...managers][0];
  const commandManagers = new Set(verificationCommands.flatMap(findCommandPackageManagers));
  if (selected && [...commandManagers].some((manager) => manager !== selected)) {
    throw new Error(
      `Package manager conflict: repository selects ${selected}, but verification uses ${[...commandManagers].join(", ")}. Use ${selected} consistently.`
    );
  }
  if (!selected && commandManagers.size > 1) {
    throw new Error(
      `Package manager conflict: verification uses multiple package managers (${[...commandManagers].join(", ")}). Select one in packageManager metadata or a lockfile.`
    );
  }

  return {
    ...(selected ? { selected } : {}),
    ...(declared ? { declared } : {}),
    detectedLockfiles
  };
}

function readDeclaredPackageManager(repoRoot: string): PackageManagerName | undefined {
  const packageJsonPath = path.join(repoRoot, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return undefined;
  }
  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { packageManager?: unknown };
    if (typeof packageJson.packageManager !== "string") {
      return undefined;
    }
    const manager = packageJson.packageManager.split("@", 1)[0];
    return packageManagerNames.find((candidate) => candidate === manager);
  } catch {
    return undefined;
  }
}

function findCommandPackageManagers(command: string): PackageManagerName[] {
  const matches = command.matchAll(/(?:^|(?:&&|\|\||;)\s*)(npm|pnpm|yarn|bun)\b/g);
  return [...matches].map((match) => match[1] as PackageManagerName);
}
