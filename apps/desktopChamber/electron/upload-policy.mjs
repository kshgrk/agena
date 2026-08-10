export function shouldSkipUploadName(name, includeGit, skippedNames) {
  return (
    (skippedNames.has(name) && !(includeGit && name === ".git")) ||
    name.startsWith("._")
  );
}

export function shouldSkipUploadPath(path) {
  return (
    path === ".git/refs/codex" ||
    path.startsWith(".git/refs/codex/") ||
    path === ".git/logs/refs/codex" ||
    path.startsWith(".git/logs/refs/codex/")
  );
}

export function assertNoCredentialedGitRemotes(config) {
  for (const match of config.matchAll(/^\s*url\s*=\s*(\S+)\s*$/gim)) {
    let url;
    try {
      url = new URL(match[1]);
    } catch {
      continue; // SCP-style SSH, relative, and local remotes carry no HTTP userinfo.
    }
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.username || url.password)
    ) {
      throw new Error(
        "Git remote contains embedded credentials; replace it with a credential-free URL before importing",
      );
    }
  }
}
