import type { BackupStatus } from "@et/shared";

/** Unsaved changes older than this make the backup state a warning. */
export const BACKUP_STALE_MS = 60 * 60 * 1000;

export type BackupHealth = { tone: "ok" | "pending" | "warn" | "error" | "off"; title: string; detail?: string };

/**
 * Turns the server's backup state into what the user should see. A backup only runs after a change, so an old
 * lastBackupAt with nothing pending is still current; the warning is for changes that have waited too long.
 */
export function backupHealth(s: BackupStatus, now = Date.now()): BackupHealth {
  if (!s.enabled) return { tone: "off", title: "A szerveren nincs bekapcsolva a mentés", detail: "Az adatok csak a szerver lemezén vannak." };
  // Stopped also sets lastError, so it is checked first. It does not retry, and what fixes it (a restart, or also
  // removing the local or the remote copy) depends on the reason, which the server writes into lastError.
  if (s.stopped) return { tone: "error", title: "A mentés leállt, magától nem indul újra", detail: s.lastError ?? undefined };
  if (s.lastError) return { tone: "error", title: "A legutóbbi mentés nem sikerült", detail: s.lastError };
  const age = s.lastBackupAt ? now - Date.parse(s.lastBackupAt) : null;
  if (s.pending && (age === null || age > BACKUP_STALE_MS)) {
    return { tone: "warn", title: "Vannak még nem mentett változások", detail: age === null ? "Még egyszer sem volt sikeres mentés." : undefined };
  }
  if (s.pending) return { tone: "pending", title: "Mentés folyamatban" };
  if (!s.lastBackupAt) return { tone: "ok", title: "Mentés bekapcsolva", detail: "Az első mentés az első változás után fut." };
  return { tone: "ok", title: "Az adatok mentve vannak" };
}
