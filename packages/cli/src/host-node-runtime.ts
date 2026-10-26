import path from "node:path";

/** Host children share AFK's Node installation, including its package-manager shims. */
export function hostNodeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...env,
    PATH: [path.dirname(process.execPath), env.PATH].filter(Boolean).join(path.delimiter)
  };
}

/** Login startup may rewrite PATH; restore the selected runtime after startup. */
export function hostNodeShellPrelude(): string {
  const directory = path.dirname(process.execPath).replace(/'/g, `'"'"'`);
  return `export PATH='${directory}'\${PATH:+${path.delimiter}$PATH}`;
}
