import { useEffect, useState } from "react";
import { Text, TextInput } from "react-native";
import { Button, Card, Label, Screen, useTheme } from "@/components/ui";
import { api, getApiToken, getApiUrl, setApiToken, setApiUrl } from "@/lib/api";
import { useData } from "@/lib/data";
import { backupHealth } from "@/lib/backup";
import type { BackupStatus } from "@et/shared";
import { format, formatDistanceToNow } from "date-fns";
import { hu } from "date-fns/locale";

export default function Settings() {
  const t = useTheme();
  const { refresh } = useData();
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [backup, setBackup] = useState<BackupStatus | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);

  useEffect(() => {
    getApiUrl().then(setUrl);
    getApiToken().then(setToken);
    // Without an API address there is no server and no backup to show.
    getApiUrl()
      .then((u) => (u ? api.backupStatus() : null))
      .then(setBackup, (e) => setBackupError((e as Error).message));
  }, []);

  async function saveAndTest() {
    setBusy(true);
    try {
      await setApiUrl(url);
      await setApiToken(token);
      const h = await api.health();
      if (!h.ai) throw new Error(token.trim() ? "Az API elutasította a tokent." : "Az API tokent kér. Add meg fent.");
      setStatus({ ok: true, text: `Kapcsolódva · AI: ${h.ai.provider} (${h.ai.model})` });
      // /health carries the same BackupStatus as /backup/status, so the check needs no second request.
      setBackup(h.backup ?? null);
      setBackupError(null);
      await refresh();
    } catch (e) {
      setStatus({ ok: false, text: (e as Error).message });
      // A card from the previous address or token would describe a server this one could not reach.
      setBackup(null);
      setBackupError(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen title="Beállítások" subtitle="A telefon a gépeden vagy szerveren futó moncsy API-hoz kapcsolódik.">
      <Card className="gap-3">
        <Label>API cím</Label>
        <TextInput
          value={url}
          onChangeText={setUrl}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder="http://192.168.1.20:8787"
          placeholderTextColor={t.muted}
          className="h-11 rounded-xl border border-line bg-bg px-3 text-fg dark:border-line-dark dark:bg-bg-dark dark:text-fg-dark"
        />
        <Text className="text-xs text-muted-fg dark:text-muted-fg-dark">
          Telefonról a „localhost” maga a telefon. Add meg a gép helyi IP címét, és az API-t indítsd HOST=0.0.0.0 beállítással.
        </Text>
        <Label>API token</Label>
        <TextInput
          value={token}
          onChangeText={setToken}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          textContentType="password"
          placeholder="A szerveren beállított token"
          placeholderTextColor={t.muted}
          className="h-11 rounded-xl border border-line bg-bg px-3 font-mono text-fg dark:border-line-dark dark:bg-bg-dark dark:text-fg-dark"
        />
        <Text className="text-xs text-muted-fg dark:text-muted-fg-dark">
          Minden kéréshez csatolva megy, a telefon biztonságos tárolójában (Keychain / Keystore) marad.
        </Text>
        <Button title="Mentés és kapcsolat ellenőrzése" onPress={saveAndTest} loading={busy} />
        {status ? (
          <Text className={`text-sm ${status.ok ? "text-positive dark:text-positive-dark" : "text-danger dark:text-danger-dark"}`}>{status.text}</Text>
        ) : null}
      </Card>
      {backup || backupError ? <BackupCard status={backup} error={backupError} /> : null}
    </Screen>
  );
}

function BackupCard({ status, error }: { status: BackupStatus | null; error: string | null }) {
  const h = status ? backupHealth(status) : { tone: "error" as const, title: "A mentés állapota nem kérdezhető le", detail: error ?? undefined };
  const tone = h.tone === "error" ? "text-danger dark:text-danger-dark" : h.tone === "warn" ? "text-amber-600 dark:text-amber-300" : h.tone === "ok" ? "text-positive dark:text-positive-dark" : "text-fg dark:text-fg-dark";
  const last = status?.enabled ? status.lastBackupAt : null;
  return (
    <Card className="gap-1">
      <Label>Mentés</Label>
      <Text className={`font-medium ${tone}`}>{h.title}</Text>
      {last ? (
        <Text className="text-sm text-muted-fg dark:text-muted-fg-dark">
          Utolsó sikeres mentés: {formatDistanceToNow(new Date(last), { locale: hu, addSuffix: true })} ({format(new Date(last), "yyyy. MM. dd. HH:mm")})
        </Text>
      ) : null}
      {h.detail ? <Text className="text-sm text-muted-fg dark:text-muted-fg-dark">{h.detail}</Text> : null}
    </Card>
  );
}
