// Browser stand-in for node:fs / node:os / node:path (vite resolve.alias).
// @agena/client's local-config.ts imports these at module scope; without this
// shim vite's externalized stub throws during module init and kills the whole
// renderer graph before main.tsx runs. Nothing in the renderer ever CALLS the
// local-config functions (profile/config IO lives in the Electron main
// process), so throw-on-call is safe.
// ponytail: throw-on-call shim; replace with a browser entry in @agena/client
// if the renderer ever needs local-config for real.
function unavailable(name: string): (...args: unknown[]) => never {
  return () => {
    throw new Error(`node builtin ${name} is not available in the renderer`);
  };
}

// node:fs
export const chmodSync = unavailable("fs.chmodSync");
export const mkdirSync = unavailable("fs.mkdirSync");
export const readFileSync = unavailable("fs.readFileSync");
export const writeFileSync = unavailable("fs.writeFileSync");

// node:os
export const homedir = unavailable("os.homedir");

// node:path
export const dirname = unavailable("path.dirname");
export const join = unavailable("path.join");

export default {};
