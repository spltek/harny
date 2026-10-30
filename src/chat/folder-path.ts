/**
 * FOLDER PATHS, compared the way the host spells them.
 *
 * The same question — "is this the folder I am already working in?" — is asked on BOTH
 * sides of the process boundary: the panel decides what a session row's action must do
 * (`open` vs `pick`), and the host decides whether a remembered gesture belongs to the
 * workspace that has just loaded (`PendingOpens.take`). Pure on purpose — no DOM, no
 * `vscode`, no globals — so both can share it, and it is tested once.
 */

/**
 * True when two absolute folder paths refer to the same location.
 *
 * VS Code `fsPath` values use `\` on Windows and `/` on POSIX, so separators and a
 * trailing separator are normalized away. Windows drive paths are also compared
 * case-insensitively (that filesystem is); POSIX paths stay case-sensitive, so two
 * genuinely distinct Linux folders never collapse into one.
 */
export function sameFolder(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const norm = (p: string) => p.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return true;
  const windowsPath = /^[a-zA-Z]:\//;
  return windowsPath.test(na) && windowsPath.test(nb) && na.toLowerCase() === nb.toLowerCase();
}
