export function parseProviderEnv(
  text: string,
): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const at = line.indexOf("=");
    if (at < 1) throw new Error(`Expected NAME=value: ${line}`);
    env[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return Object.keys(env).length ? env : undefined;
}
